// Spike 2 (REVIEW §9, CONTRACT 17): Dawn on Node. Measures what the host design leans on:
// mapAsync latency per tick, sustained ticks with a per-tick readback (serial and with a fixed
// 2-tick lag), timestamp-query resolution, integer-kernel exactness against the CPU, device-loss
// recovery and memory over a soak. Not part of the build or the test suite: `webgpu` is not a
// dependency of the repo; install it in a scratch directory and point --webgpu at it.
//
//   node src/host/spikes/dawn-node.mjs --webgpu bench/local/dawn [--backend vulkan|null]
//        [--agents 16384] [--ticks 2000] [--soak-s 600] [--losses 30] [--json out.json]
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const webgpuDir = resolve(arg('webgpu', 'bench/local/dawn'));
const backend = arg('backend', '');
const AGENTS = Number(arg('agents', 16384));
const TICKS = Number(arg('ticks', 2000));
const SOAK_S = Number(arg('soak-s', 60));
const LOSSES = Number(arg('losses', 20));
const jsonOut = arg('json', '');
const report = { node: process.version, platform: `${process.platform}-${process.arch}`, agents: AGENTS, ticks: TICKS };

const req = createRequire(join(webgpuDir, 'package.json'));
const entry = req.resolve('webgpu');
const t0 = performance.now();
const { create, globals } = await import(pathToFileURL(entry).href);
report.loadMs = +(performance.now() - t0).toFixed(1);
report.webgpuVersion = req('webgpu/package.json').version;
Object.assign(globalThis, globals);

function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
}
function stats(xs) {
  return { n: xs.length, p50: +pct(xs, 50).toFixed(3), p90: +pct(xs, 90).toFixed(3), p99: +pct(xs, 99).toFixed(3), max: +Math.max(...xs).toFixed(3) };
}
const mb = (b) => +(b / 1048576).toFixed(1);

const flags = backend ? [`backend=${backend}`] : [];
const flagsUnquantised = [...flags, 'disable-dawn-features=timestamp_quantization'];
const gpu = create(flags);
const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) {
  report.adapter = null;
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
report.adapter = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description };
report.features = [...adapter.features].sort();
report.limits = { maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension };
const hasTs = adapter.features.has('timestamp-query');

// A toy tick: integrate AGENTS motes with hashed noise forces and append rare "births" to a
// list through an atomic counter, like the GPU birth list of 05 §5.5.1.
const WGSL = /* wgsl */ `
struct P { tick: u32, n: u32, cap: u32, pad: u32 }
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read_write> pos: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> births: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> hashes: array<u32>;
fn h(a: u32, b: u32) -> u32 {
  var x = (a * 0x9e3779b1u) ^ (b + 0x7f4a7c15u);
  x = (x ^ (x >> 16u)) * 0x85ebca6bu;
  x = (x ^ (x >> 13u)) * 0xc2b2ae35u;
  return x ^ (x >> 16u);
}
@compute @workgroup_size(64) fn step(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= prm.n) { return; }
  let r = h(prm.tick, i);
  hashes[i] = r;
  let f = vec2f(f32(r & 0xffffu), f32(r >> 16u)) / 65535.0 - vec2f(0.5);
  var v = vel[i] * 0.98 + f * 0.01;
  var p = pos[i] + v * (1.0 / 30.0);
  p = fract(p / vec2f(32.0, 18.0)) * vec2f(32.0, 18.0);
  vel[i] = v; pos[i] = p;
  if ((r & 4095u) == 0u) {
    let k = atomicAdd(&births[0], 1u);
    if (k < prm.cap) { atomicStore(&births[1u + k], i); }
  }
}`;
const BIRTH_CAP = 1023;

function hCpu(a, b) {
  let x = (Math.imul(a, 0x9e3779b1) ^ ((b + 0x7f4a7c15) >>> 0)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

async function makeRig(device, n, withTs) {
  const module = device.createShaderModule({ code: WGSL });
  const info = await module.getCompilationInfo();
  const errs = info.messages.filter((m) => m.type === 'error');
  if (errs.length) throw new Error(errs.map((m) => m.message).join('\n'));
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'step' } });
  const S = GPUBufferUsage;
  const prm = device.createBuffer({ size: 16, usage: S.UNIFORM | S.COPY_DST });
  const pos = device.createBuffer({ size: n * 8, usage: S.STORAGE | S.COPY_DST });
  const vel = device.createBuffer({ size: n * 8, usage: S.STORAGE });
  const births = device.createBuffer({ size: (BIRTH_CAP + 1) * 4, usage: S.STORAGE | S.COPY_SRC | S.COPY_DST });
  const hashes = device.createBuffer({ size: n * 4, usage: S.STORAGE | S.COPY_SRC });
  const init = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { init[2 * i] = (i % 181) * 0.17; init[2 * i + 1] = (i % 97) * 0.18; }
  device.queue.writeBuffer(pos, 0, init);
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [prm, pos, vel, births, hashes].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  const staging = [0, 1, 2].map(() => device.createBuffer({ size: (BIRTH_CAP + 1) * 4, usage: S.MAP_READ | S.COPY_DST }));
  let qs = null; let qResolve = null; let qRead = null;
  if (withTs) {
    qs = device.createQuerySet({ type: 'timestamp', count: 2 });
    qResolve = device.createBuffer({ size: 16, usage: S.QUERY_RESOLVE | S.COPY_SRC });
    qRead = device.createBuffer({ size: 16, usage: S.MAP_READ | S.COPY_DST });
  }
  const zero = new Uint32Array(1);
  const prmData = new Uint32Array([0, n, BIRTH_CAP, 0]);
  function encodeTick(tick, stagingBuf) {
    prmData[0] = tick;
    device.queue.writeBuffer(prm, 0, prmData);
    device.queue.writeBuffer(births, 0, zero);
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass(qs ? { timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {});
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    if (stagingBuf) enc.copyBufferToBuffer(births, 0, stagingBuf, 0, (BIRTH_CAP + 1) * 4);
    if (qs) { enc.resolveQuerySet(qs, 0, 2, qResolve, 0); enc.copyBufferToBuffer(qResolve, 0, qRead, 0, 16); }
    device.queue.submit([enc.finish()]);
  }
  return { pipeline, staging, encodeTick, hashes, qRead, buffers: [prm, pos, vel, births, hashes, ...staging, ...(qRead ? [qResolve, qRead] : [])], qs };
}

async function readU32(device, src, bytes) {
  const rb = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(src, 0, rb, 0, bytes);
  device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ);
  const out = new Uint32Array(rb.getMappedRange().slice(0));
  rb.unmap(); rb.destroy();
  return out;
}

const device = await adapter.requestDevice({ requiredFeatures: hasTs ? ['timestamp-query'] : [] });
device.addEventListener('uncapturederror', (e) => { report.uncaptured = (report.uncaptured ?? 0) + 1; console.error('uncaptured', e.error?.message); });
const rig = await makeRig(device, AGENTS, false);

// 1. Integer kernel exactness: GPU hash of (tick, i) against the CPU.
{
  rig.encodeTick(12345, null);
  const got = await readU32(device, rig.hashes, AGENTS * 4);
  let bad = 0;
  for (let i = 0; i < AGENTS; i++) if (got[i] !== hCpu(12345, i)) bad++;
  report.integerKernelMismatches = bad;
}

// 2. Serial: every tick waits for its own readback (the worst case of R12).
{
  const lat = []; const tick = [];
  let births = 0;
  for (let t = 0; t < 50; t++) { rig.encodeTick(t, rig.staging[0]); await rig.staging[0].mapAsync(GPUMapMode.READ); rig.staging[0].unmap(); }
  const tAll = performance.now();
  for (let t = 0; t < TICKS; t++) {
    const a = performance.now();
    rig.encodeTick(t, rig.staging[0]);
    const b = performance.now();
    await rig.staging[0].mapAsync(GPUMapMode.READ);
    const c = performance.now();
    births += new Uint32Array(rig.staging[0].getMappedRange())[0];
    rig.staging[0].unmap();
    lat.push(c - b); tick.push(performance.now() - a);
  }
  const wall = performance.now() - tAll;
  report.serial = { mapAsyncMs: stats(lat), tickMs: stats(tick), ticksPerSec: Math.round((TICKS * 1000) / wall), birthsSeen: births };
}

// 3. Fixed 2-tick lag: tick t's birth list is consumed at tick t + 2 (05 §5.5.1), three staging buffers.
{
  const pending = [];
  const wait = [];
  let births = 0;
  const tAll = performance.now();
  for (let t = 0; t < TICKS; t++) {
    const sb = rig.staging[t % 3];
    rig.encodeTick(t, sb);
    pending.push({ t, sb, p: sb.mapAsync(GPUMapMode.READ) });
    if (pending.length > 2) {
      const e = pending.shift();
      const a = performance.now();
      await e.p;
      wait.push(performance.now() - a);
      births += new Uint32Array(e.sb.getMappedRange())[0];
      e.sb.unmap();
    }
  }
  for (const e of pending) { await e.p; e.sb.unmap(); }
  const wall = performance.now() - tAll;
  report.lag2 = { waitMs: stats(wait), ticksPerSec: Math.round((TICKS * 1000) / wall), birthsSeen: births };
}

// 4. Timestamp-query resolution (with Dawn's default quantisation and with it disabled).
async function tsProbe(flagSet, label) {
  const g = create(flagSet);
  const ad = await g.requestAdapter();
  if (!ad?.features.has('timestamp-query')) return { label, supported: false };
  const dev = await ad.requestDevice({ requiredFeatures: ['timestamp-query'] });
  const r = await makeRig(dev, AGENTS, true);
  const deltas = []; const raw = [];
  for (let t = 0; t < 300; t++) {
    r.encodeTick(t, null);
    await r.qRead.mapAsync(GPUMapMode.READ);
    const q = new BigUint64Array(r.qRead.getMappedRange().slice(0));
    r.qRead.unmap();
    raw.push(q[0], q[1]);
    deltas.push(Number(q[1] - q[0]));
  }
  // resolution: the gcd of all raw values' differences from the first
  const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
  let gq = 0n;
  for (const v of raw) gq = gcd(gq, v > raw[0] ? v - raw[0] : raw[0] - v);
  dev.destroy();
  const ns = deltas.filter((d) => d >= 0);
  return { label, supported: true, passNs: stats(ns), distinctDeltas: new Set(ns).size, rawGcdNs: Number(gq), zeroDeltas: ns.filter((d) => d === 0).length };
}
report.timestamps = hasTs ? [await tsProbe(flags, 'default'), await tsProbe(flagsUnquantised, 'quantisation disabled')] : [{ supported: false }];

// 5. Device-loss recovery: destroy, observe `lost`, recreate and run again, LOSSES times.
{
  const rss0 = process.memoryUsage().rss;
  const lostMs = []; const recoverMs = []; const reasons = new Set();
  let ok = 0;
  for (let k = 0; k < LOSSES; k++) {
    const d = await (await gpu.requestAdapter()).requestDevice();
    const r = await makeRig(d, AGENTS, false);
    r.encodeTick(k, r.staging[0]);
    await r.staging[0].mapAsync(GPUMapMode.READ); r.staging[0].unmap();
    const a = performance.now();
    d.destroy();
    const info = await d.lost;
    reasons.add(info.reason);
    lostMs.push(performance.now() - a);
    const b = performance.now();
    // A GPUAdapter is "consumed" by its first requestDevice, so recovery must request a new adapter.
    const d2 = await (await gpu.requestAdapter()).requestDevice();
    const r2 = await makeRig(d2, AGENTS, false);
    r2.encodeTick(k, r2.staging[0]);
    await r2.staging[0].mapAsync(GPUMapMode.READ);
    const n = new Uint32Array(r2.staging[0].getMappedRange())[0];
    r2.staging[0].unmap();
    recoverMs.push(performance.now() - b);
    if (n >= 0) ok++;
    d2.destroy();
    await d2.lost;
  }
  if (global.gc) global.gc();
  report.deviceLoss = { cycles: LOSSES, recovered: ok, reasons: [...reasons], lostResolveMs: stats(lostMs), recreateAndFirstTickMs: stats(recoverMs), rssDeltaMb: mb(process.memoryUsage().rss - rss0) };
}

// 6. Soak: lag-2 ticks at the full rate for SOAK_S seconds, sampling memory every 5 s.
{
  const samples = [];
  const tEnd = performance.now() + SOAK_S * 1000;
  let t = 0; const pending = [];
  let nextSample = performance.now();
  while (performance.now() < tEnd) {
    const sb = rig.staging[t % 3];
    rig.encodeTick(t, sb);
    pending.push({ sb, p: sb.mapAsync(GPUMapMode.READ) });
    if (pending.length > 2) { const e = pending.shift(); await e.p; e.sb.unmap(); }
    t++;
    if (performance.now() >= nextSample) {
      const m = process.memoryUsage();
      samples.push({ s: Math.round((performance.now() - (tEnd - SOAK_S * 1000)) / 1000), ticks: t, rssMb: mb(m.rss), heapMb: mb(m.heapUsed), extMb: mb(m.external) });
      nextSample += 5000;
    }
  }
  for (const e of pending) { await e.p; e.sb.unmap(); }
  const first = samples[Math.min(2, samples.length - 1)]; const last = samples[samples.length - 1];
  report.soak = { seconds: SOAK_S, ticks: t, ticksPerSec: Math.round(t / SOAK_S), rssStartMb: first.rssMb, rssEndMb: last.rssMb, rssSlopeMbPerHour: +(((last.rssMb - first.rssMb) / Math.max(1, last.s - first.s)) * 3600).toFixed(1), samples: samples.length };
  report.soakSamples = samples;
}

// 7. Timer granularity for pacing (R17): setTimeout(1) and setImmediate on this OS.
{
  const st = [];
  for (let i = 0; i < 200; i++) { const a = performance.now(); await new Promise((r) => setTimeout(r, 1)); st.push(performance.now() - a); }
  const si = [];
  for (let i = 0; i < 200; i++) { const a = performance.now(); await new Promise((r) => setImmediate(r)); si.push(performance.now() - a); }
  report.timers = { setTimeout1Ms: stats(st), setImmediateMs: stats(si) };
}

device.destroy();
const { soakSamples, ...summary } = report;
console.log(JSON.stringify(summary, null, 2));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
process.exit(0);
