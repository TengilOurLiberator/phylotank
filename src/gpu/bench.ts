/**
 * Benchmarks for docs/spikes/gpu-1.md: agents per tick for each kernel on whatever adapter is
 * present (lavapipe in the container, the RTX 5090 on William's PC), the CPU backend on the
 * same scene, and two device microbenchmarks (copy bandwidth, FMA throughput) that the
 * extrapolation in the spike report divides by. Not part of the sim; wall-clock reads live
 * only here. Run: `node bench/local/gpu-bench.mjs` after bundling `src/gpu/bench-cli.ts`.
 */
import { allocWorld, RngStreams, RNG_STREAM, SEG_PER_AGENT, LIFE, type EventSink, type StepContext, type World } from '../core/index.js';
import { createPhysics } from '../physics/index.js';
import { prepare, transportQ, type Grid, type TransportOpts } from '../ecosystem/transport.js';
import { BU, bindAll, computePipeline, dispatch, type GpuContext } from './device.js';
import { GpuPhysicsEngine, createGpuPhysics } from './physics.js';
import { GpuHash } from './hash.js';
import { GpuBrain } from './brain.js';
import { GpuTransport } from './transport.js';

const now = (): number => performance.now();

/** A tank of n swimming fish (8 segments, 20 cm) on a grid, commands set once (a held gait). */
export function fishTank(n: number): { world: World; ctx: StepContext } {
  const world = allocWorld({ preset: 'large', seedLo: 1, seedHi: 2, backend: 'cpu', agentCap: n + 8 });
  const rng = new RngStreams(1, 2);
  const events: EventSink = { emit() {} };
  const ctx = { tick: 0, config: world.config, rng, events } as StepContext;
  const phys = createPhysics();
  const c = world.cr.c; const sg = world.seg.c;
  const W = world.preset.widthM; const H = world.preset.heightM;
  const cols = Math.ceil(Math.sqrt(n * W / H));
  const ph = fishPhenotype();
  for (let s = 0; s < n; s++) {
    c.life[s] = LIFE.ALIVE; c.idLo[s] = s + 1; c.tempC[s] = 15;
    c.posX[s] = 0.5 + (s % cols) * ((W - 1) / cols); c.posY[s] = 0.5 + Math.floor(s / cols) * ((H - 1) / Math.ceil(n / cols));
    c.heading[s] = (s * 0.618) % 6.28;
    c.segStart[s] = s * SEG_PER_AGENT;
    world.cr.highWater = s + 1;
    phys.loadBody(world, s, ph);
    for (let k = 1; k < c.segCount[s]!; k++) sg.cmd[c.segStart[s]! + k] = Math.sin(s + k * 0.8);
  }
  return { world, ctx };
}

function fishPhenotype(): import('../core/index.js').Phenotype {
  const n = 8; const len = 0.2; const seg = len / n;
  const f32 = (fn: (k: number) => number): Float32Array => Float32Array.from({ length: n }, (_, k) => fn(k));
  return {
    nParts: n, parent: Int16Array.from({ length: n }, (_, k) => k - 1), kind: new Uint8Array(n), subtype: new Uint8Array(n),
    moduleInnov: new Uint32Array(n), pathHash: new Uint32Array(n), dv: new Int8Array(n), organs: new Uint16Array(n),
    attachU: f32((k) => (k === 1 ? -0.5 : 0.5)), restAngle: f32((k) => (k === 1 ? Math.PI : 0)),
    limitLo: f32((k) => (k === 1 ? Math.PI : 0) - 1.4), limitHi: f32((k) => (k === 1 ? Math.PI : 0) + 1.4),
    length: f32(() => seg), radius: f32((k) => 0.012 * (1 - 0.6 * k / n)), span: f32((k) => 0.024 * (1 - 0.6 * k / n)),
    taper: f32(() => 1), muscleFrac: f32(() => 0.5), lipidFrac: f32(() => 0), armour: f32(() => 0), youngsE: f32(() => 3e5),
    damping: f32(() => 0.2), u: f32(() => 0), v: f32(() => 0), d: f32(() => 0), cpgPhase: f32(() => 0), cpgAmp: f32(() => 0),
    glow: f32(() => 0), hue: f32(() => 0), params: new Float32Array(n * 5), lengthM: len, adultLengthM: len, maturity: 1,
    massKg: 0, gutVolume: 0, gGut: 0, mouth: { filter: 0, scrape: 0, bite: 0, suction: 0, latch: 0, gape: 0, biteForce: 0, mesh: 0 },
    handlingSize: 0, buildCostKg: 0, organList: [],
  };
}

export interface BenchRow { [k: string]: number | string }

async function timeIt(fn: () => Promise<void> | void, minMs = 300, maxReps = 200): Promise<number> {
  await fn();
  let reps = 0; const t0 = now();
  while (reps < maxReps && (reps < 2 || now() - t0 < minMs)) { await fn(); reps++; }
  return (now() - t0) / reps;
}

/** Device microbenchmarks: buffer copy bandwidth (GB/s) and multiply-add throughput (GFLOP/s). */
export async function deviceMicro(gpu: GpuContext): Promise<BenchRow> {
  const d = gpu.device;
  const bytes = 128 * 1024 * 1024;
  const a = d.createBuffer({ size: bytes, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST });
  const b = d.createBuffer({ size: bytes, usage: BU.STORAGE | BU.COPY_SRC | BU.COPY_DST });
  const copyMs = await timeIt(async () => {
    const e = d.createCommandEncoder(); e.copyBufferToBuffer(a, 0, b, 0, bytes); d.queue.submit([e.finish()]); await d.queue.onSubmittedWorkDone();
  }, 500, 20);
  // multiply-add chains: each thread runs 4 independent chains of ITER mul-adds (2 flops each)
  const ITER = 4096;
  const code = `@group(0) @binding(0) var<storage, read_write> o: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
  var x0 = f32(g.x) * 1e-6; var x1 = x0 + 0.1; var x2 = x0 + 0.2; var x3 = x0 + 0.3;
  for (var i = 0u; i < ${ITER}u; i++) { x0 = x0 * 0.999 + 0.001; x1 = x1 * 0.999 + 0.001; x2 = x2 * 0.999 + 0.001; x3 = x3 * 0.999 + 0.001; }
  o[g.x] = x0 + x1 + x2 + x3;
}`;
  const pipe = await computePipeline(d, code, 'main', 'fma');
  const threads = 65536;
  const ob = d.createBuffer({ size: threads * 4, usage: BU.STORAGE });
  const bg = bindAll(d, pipe, [ob]);
  const fmaMs = await timeIt(async () => { dispatch(d, pipe, bg, threads / 64); await d.queue.onSubmittedWorkDone(); }, 500, 20);
  for (const x of [a, b, ob]) x.destroy();
  return { copyGBs: (2 * bytes) / (copyMs * 1e6), maddGflops: (threads * ITER * 4 * 2) / (fmaMs * 1e6) };
}

/** Physics kernel, GPU-resident: ms per tick for n fish; CPU backend on the same scene. */
export async function benchPhysics(gpu: GpuContext, n: number, ticks: number, cpu: boolean, globalScratch = false): Promise<BenchRow> {
  const { world, ctx } = fishTank(n);
  const eng = await new GpuPhysicsEngine(gpu, { ...createPhysics().opts, contacts: false }).init();
  eng.globalScratch = globalScratch;
  const slots = Array.from({ length: n }, (_, s) => s);
  eng.upload(world, slots);
  eng.run(2); await eng.idle();
  const t0 = now(); eng.run(ticks); await eng.idle(); const ms = (now() - t0) / ticks;
  await eng.download(world);
  let nSub = 0; for (let s = 0; s < n; s++) nSub += world.cr.c.nSub[s]!;
  nSub /= n;
  const segs = n * 8;
  // hash build on the same segments
  const hash = await new GpuHash(gpu, eng).init();
  hash.build(); await eng.idle();
  const hashMs = await timeIt(async () => { hash.build(); await eng.idle(); }, 300, 50);
  const row: BenchRow = { scratch: globalScratch ? 'global' : 'private', agents: n, segments: segs, nSub: +nSub.toFixed(2), gpuMsPerTick: +ms.toFixed(3), agentsPerMs: +(n / ms).toFixed(1), segSubstepsPerS: +((segs * nSub) / (ms / 1000)).toExponential(3), hashMs: +hashMs.toFixed(3) };
  eng.destroy();
  if (cpu) {
    const cw = fishTank(n);
    const cp = createPhysics({ contacts: false });
    const cms = await timeIt(() => { cp.step(cw.world, cw.ctx); }, 500, 30);
    row.cpuMsPerTick = +cms.toFixed(3);
    row.speedup = +(cms / ms).toFixed(2);
  }
  // the full interface (upload, kernel, readback, CPU watchdogs) on the same scene
  if (n <= 16384 && !globalScratch) {
    const rw = fishTank(n);
    const gp = await createGpuPhysics(gpu, { contacts: false });
    const rms = await timeIt(() => gp.step(rw.world, rw.ctx), 500, 20);
    row.roundTripMsPerTick = +rms.toFixed(3);
    gp.engine.destroy();
  }
  void ctx;
  return row;
}

export async function benchBrain(gpu: GpuContext, c: number, n: number): Promise<BenchRow> {
  const gb = await new GpuBrain(gpu).init();
  const r = await gb.benchSynthetic(c, n, 20, now);
  return { cls: c, brains: n, msPerTick: +r.msPerTick.toFixed(3), brainsPerMs: +(n / r.msPerTick).toFixed(1), synapsesPerS: +(r.synapsesPerTick / (r.msPerTick / 1000)).toExponential(3) };
}

export async function benchTransport(gpu: GpuContext, w: number, h: number): Promise<BenchRow> {
  const wet = new Uint8Array(w * h).fill(1);
  const uFace = new Float64Array((w + 1) * h).map((_, i) => 0.01 * Math.sin(i * 0.37));
  const vFace = new Float64Array(w * (h + 1)).map((_, i) => 0.01 * Math.cos(i * 0.21));
  const g: Grid = { w, h, cs: 0.25, wet, uFace, vFace };
  const o: TransportOpts = { dt: 0.5, kh: 2e-3, kz: new Float64Array(h + 1).fill(1e-4), ws: 1e-3, settle: () => {} };
  const q0 = new Float64Array(w * h).map((_, i) => (i * 2654435761) % 1000003 * 1000);
  const rng = new RngStreams(1, 2);
  void RNG_STREAM;
  const gt = await new GpuTransport(gpu).init();
  const p1 = prepare(g, o, 1); const p9 = prepare(g, o, 9);
  const q = new Float64Array(q0);
  const t1 = await timeIt(() => gt.transportQ(g, q, rng, 1, 12, p1, () => {}), 300, 20);
  const t9 = await timeIt(() => gt.transportQ(g, q, rng, 1, 12, p9, () => {}), 300, 20);
  const qc = new Float64Array(q0);
  const tc = await timeIt(() => { transportQ(g, qc, o, rng, 1, 12, p1); }, 300, 20);
  const perSub = (t9 - t1) / 8;
  return { cells: w * h, gpuMsPerSubstep: +perSub.toFixed(3), gpuCallMs1Sub: +t1.toFixed(3), cpuMsPerSubstep: +tc.toFixed(3), cellsPerMs: +((w * h) / perSub).toFixed(0) };
}
