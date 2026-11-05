/**
 * Deterministic benchmark of the integrated sim (src/sim `sim`, the real genome, physics, brain
 * and ecosystem modules as createSim wires them). Bundled and launched by tools/bench/bench.mjs.
 *
 * Per phase it reports main-thread CPU ms per tick (process.threadCpuUsage, so other processes
 * on a loaded machine and V8's helper threads do not count) and wall ms per tick, the median
 * over `--runs` fresh worlds. Phases are timed by wrapping the module methods the step calls
 * (the module objects keep their identity, so the sim takes the same code paths); `commit` is
 * the rest of an ecology tick (feedBites plus the sim's birth and death commit) after the
 * per-tick rest (journal, actuate) seen on other ticks is taken off.
 *
 * Every run must end on the same state hash; `--expect=<file>` also checks it against a
 * stored golden (tools/bench/goldens.json), so an optimisation that changes results fails here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PerformanceObserver } from 'node:perf_hooks';
import { ECO_EVERY, HASH_EVERY, hashWorld, LIFE, SLOW_EVERY, toHex64, type World, type WorldConfig } from '../../src/core/index.js';
import { drainEvents, sim, stateDigest, type SimConfig } from '../../src/sim/index.js';
import { DEFAULT_DREAM_CONFIG } from '../../src/sim/session.js';

// ---------------- arguments ----------------
const arg = (name: string, def?: string): string | undefined => {
  const a = process.argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return def;
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : 'true';
};
const SCENARIO = arg('scenario', 'small-2k')!;
const TICKS = Number(arg('ticks', '300'));
const WARM = Number(arg('warm', '60'));
const RUNS = Number(arg('runs', '3'));
const HASHES = Number(arg('hash', '3'));
const ALLOC = arg('alloc') === 'true';
const JSON_OUT = arg('json');
const EXPECT = arg('expect');
const RECORD = arg('record');
const QUIET = arg('quiet') === 'true';
/** `--physics=off` makes physics.step a no-op: not the product sim, but a fast deterministic loop for the other phases. */
const PHYSICS = arg('physics', 'on')!;

// ---------------- scenarios (fixed seeds and worlds) ----------------
const mixed = (scale: number): SimConfig['founders'] => [
  { template: 'motefly', count: Math.round(1300 * scale), zone: 'surface' },
  { template: 'meadowlamp', count: Math.round(330 * scale), zone: 'shelf' },
  { template: 'ashpicker', count: Math.round(200 * scale), zone: 'floor' },
  { template: 'sievebell', count: Math.round(100 * scale), zone: 'surface' },
  { template: 'tetherling', count: Math.round(40 * scale) },
  { template: 'hushmaw', count: Math.round(30 * scale) },
];
const SCENARIOS: Record<string, SimConfig> = {
  /** The v0.1 acceptance floor: about 2,000 agents in the Small tank. */
  'small-2k': { preset: 'small', seedLo: 0x0be4c401, seedHi: 0x00000001, backend: 'cpu', agentCap: 4096, founders: mixed(1) },
  /** The v0.1 upper figure: about 4,000 agents (the Small CPU cap is 4,096). */
  'small-4k': { preset: 'small', seedLo: 0x0be4c402, seedHi: 0x00000001, backend: 'cpu', agentCap: 4096, founders: mixed(2) },
  /** The shipped dream tank (session.ts). */
  dream: DEFAULT_DREAM_CONFIG,
};
const CFG = SCENARIOS[SCENARIO];
if (!CFG) throw new Error(`unknown scenario ${SCENARIO}; one of ${Object.keys(SCENARIOS).join(', ')}`);

// ---------------- phase timers ----------------
const PHASES = ['sense', 'think', 'physics', 'ecology', 'commit', 'flow', 'rest'] as const;
type Phase = typeof PHASES[number];
const NP = PHASES.length;
const cpuAcc = new Float64Array(NP); // µs
const wallAcc = new Float64Array(NP); // ms
const allocAcc = new Float64Array(NP); // bytes
const allocN = new Float64Array(NP);
const heapNow = (): number => process.memoryUsage().heapUsed;
const cpuNow = (): number => { const u = process.threadCpuUsage(); return u.user + u.system; };

function wrap(obj: Record<string, unknown>, key: string, phase: Phase): void {
  const f = obj[key] as (...a: unknown[]) => unknown;
  if (typeof f !== 'function') throw new Error(`no ${key} to wrap`);
  if ((f as { __bench?: boolean }).__bench) return;
  const i = PHASES.indexOf(phase);
  const w = function (this: unknown, ...a: unknown[]): unknown {
    const h0 = ALLOC ? heapNow() : 0;
    const c0 = cpuNow();
    const t0 = performance.now();
    const r = f.apply(this, a);
    wallAcc[i] += performance.now() - t0;
    cpuAcc[i] += cpuNow() - c0;
    if (ALLOC) { const d = heapNow() - h0; if (d >= 0) { allocAcc[i] += d; allocN[i]++; } }
    return r;
  };
  (w as { __bench?: boolean }).__bench = true;
  obj[key] = w;
}
const mods = sim.modules as unknown as Record<string, Record<string, unknown>>;
if (PHYSICS === 'off') (mods.physics as Record<string, unknown>).step = (): void => {};
wrap(mods.brain!, 'sense', 'sense');
wrap(mods.brain!, 'think', 'think');
wrap(mods.physics!, 'step', 'physics');
wrap(mods.ecosystem!, 'stepEcology', 'ecology');
wrap(mods.ecosystem!, 'stepSlow', 'flow');

// GC entries arrive asynchronously: keep them and count those inside the measured window
const gcEntries: { t: number; d: number }[] = [];
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) gcEntries.push({ t: e.startTime, d: e.duration });
}).observe({ entryTypes: ['gc'] });

// ---------------- one run ----------------
interface RunResult {
  createMs: number; createCpuMs: number; live0: number; live1: number; segs1: number;
  cpu: Record<Phase | 'total', number>; wall: Record<Phase | 'total', number>; alloc?: Record<Phase | 'total', number>;
  ticksPerCpuS: number; ticksPerWallS: number; gcMsPerTick: number; gcPerTick: number;
  hashMs: number; hashCpuMs: number; hashBytes: number; hash: string; digest: string;
}

function liveCount(w: World): number {
  let n = 0;
  for (let s = 0; s < w.cr.highWater; s++) if (w.cr.c.life[s] === LIFE.ALIVE) n++;
  return n;
}

async function oneRun(): Promise<RunResult> {
  (globalThis as { gc?: () => void }).gc?.();
  const c0 = cpuNow(), t0 = performance.now();
  const w = sim.create(CFG as WorldConfig);
  const createMs = performance.now() - t0, createCpuMs = (cpuNow() - c0) / 1000;
  const live0 = liveCount(w);
  for (let i = 0; i < WARM; i++) { sim.step(w); drainEvents(w); }
  cpuAcc.fill(0); wallAcc.fill(0); allocAcc.fill(0); allocN.fill(0);
  let ecoRestCpu = 0, ecoRestWall = 0, ecoTicks = 0, ecoAlloc = 0, ecoAllocN = 0;
  let otherRestCpu = 0, otherRestWall = 0, otherTicks = 0, otherAlloc = 0, otherAllocN = 0;
  let totCpu = 0, totWall = 0, totAlloc = 0, totAllocN = 0;
  const before = new Float64Array(NP), beforeW = new Float64Array(NP), beforeA = new Float64Array(NP);
  const win0 = performance.now();
  for (let i = 0; i < TICKS; i++) {
    before.set(cpuAcc); beforeW.set(wallAcc); beforeA.set(allocAcc);
    const isEco = w.g.tick % ECO_EVERY === 0;
    const h0 = ALLOC ? heapNow() : 0;
    const s0 = cpuNow(), q0 = performance.now();
    sim.step(w);
    const dw = performance.now() - q0, dc = cpuNow() - s0;
    const da = ALLOC ? heapNow() - h0 : 0;
    drainEvents(w);
    let inC = 0, inW = 0, inA = 0;
    for (let p = 0; p < NP; p++) { inC += cpuAcc[p]! - before[p]!; inW += wallAcc[p]! - beforeW[p]!; inA += allocAcc[p]! - beforeA[p]!; }
    totCpu += dc; totWall += dw;
    if (da >= 0) { totAlloc += da; totAllocN++; }
    if (isEco) {
      ecoRestCpu += dc - inC; ecoRestWall += dw - inW; ecoTicks++;
      if (da >= 0) { ecoAlloc += da - inA; ecoAllocN++; }
    } else {
      otherRestCpu += dc - inC; otherRestWall += dw - inW; otherTicks++;
      if (da >= 0) { otherAlloc += da - inA; otherAllocN++; }
    }
  }
  const win1 = performance.now();
  await new Promise((r) => setTimeout(r, 20));
  let gcMs = 0, gcCount = 0;
  for (const e of gcEntries) if (e.t >= win0 && e.t <= win1) { gcMs += e.d; gcCount++; }
  gcEntries.length = 0;
  const restC = otherTicks ? otherRestCpu / otherTicks : 0, restW = otherTicks ? otherRestWall / otherTicks : 0;
  const restA = otherAllocN ? otherAlloc / otherAllocN : 0;
  const per = (acc: Float64Array, scale: number, commitTotal: number, rest: number, total: number, n: number[] | null): Record<Phase | 'total', number> => {
    const r = {} as Record<Phase | 'total', number>;
    PHASES.forEach((p, i) => { r[p] = n ? (n[i]! > 0 ? acc[i]! / n[i]! * (p === 'ecology' ? 1 / ECO_EVERY : p === 'flow' ? 1 / SLOW_EVERY : 1) : 0) : acc[i]! * scale / TICKS; });
    r.commit = commitTotal; r.rest = rest; r.total = total;
    return r;
  };
  const cpu = per(cpuAcc, 1 / 1000, Math.max(0, (ecoRestCpu - restC * ecoTicks)) / 1000 / TICKS, restC / 1000, totCpu / 1000 / TICKS, null);
  const wall = per(wallAcc, 1, Math.max(0, (ecoRestWall - restW * ecoTicks)) / TICKS, restW, totWall / TICKS, null);
  let alloc: RunResult['alloc'];
  if (ALLOC) {
    // bytes per tick: mean over calls with no GC in between, scaled to per tick
    alloc = {} as Record<Phase | 'total', number>;
    PHASES.forEach((p, i) => {
      const perCall = allocN[i]! > 0 ? allocAcc[i]! / allocN[i]! : 0;
      alloc![p] = p === 'ecology' ? perCall / ECO_EVERY : p === 'flow' ? perCall / SLOW_EVERY : perCall;
    });
    alloc.commit = ecoAllocN ? Math.max(0, ecoAlloc / ecoAllocN - restA) / ECO_EVERY : 0;
    alloc.rest = restA;
    alloc.total = totAllocN ? totAlloc / totAllocN : 0;
  }
  const live1 = liveCount(w);
  // full state hash, timed
  let hashMs = 0, hashCpu = 0, hash = 0n;
  for (let k = 0; k < HASHES; k++) {
    const hc = cpuNow(), ht = performance.now();
    hash = hashWorld(w);
    hashMs += performance.now() - ht; hashCpu += cpuNow() - hc;
  }
  if (HASHES === 0) hash = hashWorld(w); // untimed, for the golden check
  let hashBytes = 0;
  for (const p of [w.cr, w.seg, ...w.brains]) for (const col of p.spec) hashBytes += (p.c as Record<string, ArrayBufferView>)[col.name]!.byteLength / p.capacity * p.highWater;
  for (const v of Object.values(w.fields as unknown as Record<string, ArrayBufferView>)) if (ArrayBuffer.isView(v)) hashBytes += v.byteLength;
  return {
    createMs, createCpuMs, live0, live1, segs1: w.seg.highWater, cpu, wall, alloc,
    ticksPerCpuS: 1000 / cpu.total, ticksPerWallS: 1000 / wall.total, gcMsPerTick: gcMs / TICKS, gcPerTick: gcCount / TICKS,
    hashMs: HASHES ? hashMs / HASHES : 0, hashCpuMs: HASHES ? hashCpu / 1000 / HASHES : 0, hashBytes,
    hash: toHex64(hash), digest: toHex64(stateDigest(w)),
  };
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

const runs: RunResult[] = [];
for (let r = 0; r < RUNS; r++) {
  const res = await oneRun();
  runs.push(res);
  if (!QUIET) console.error(`run ${r + 1}/${RUNS}: cpu ${res.cpu.total.toFixed(2)} ms/tick, live ${res.live1}, hash ${res.hash}`);
}
const hashes = new Set(runs.map((r) => `${r.hash}/${r.digest}`));
if (hashes.size !== 1) { console.error('NONDETERMINISTIC: runs disagree', [...hashes]); process.exit(2); }

const med = (f: (r: RunResult) => number): number => median(runs.map(f));
const table = (key: 'cpu' | 'wall' | 'alloc'): Record<string, number> => {
  const o: Record<string, number> = {};
  for (const p of [...PHASES, 'total'] as const) o[p] = med((r) => (r[key] as Record<string, number>)[p]!);
  return o;
};
const cpuT = table('cpu');
const hashCpuMs = med((r) => r.hashCpuMs);
const out = {
  scenario: SCENARIO, physics: PHYSICS, ticks: TICKS, warm: WARM, runs: RUNS, node: process.version,
  loadavg: (await import('node:os')).loadavg().map((x) => +x.toFixed(2)),
  live: { start: runs[0]!.live0, end: runs[0]!.live1, segments: runs[0]!.segs1 },
  createMs: med((r) => r.createMs), createCpuMs: med((r) => r.createCpuMs),
  cpuMsPerTick: cpuT, wallMsPerTick: table('wall'), allocBytesPerTick: ALLOC ? table('alloc') : undefined,
  ticksPerCpuS: med((r) => r.ticksPerCpuS), ticksPerWallS: med((r) => r.ticksPerWallS),
  gcMsPerTick: med((r) => r.gcMsPerTick), gcPerTick: med((r) => r.gcPerTick),
  hash: { ms: med((r) => r.hashMs), cpuMs: hashCpuMs, bytes: runs[0]!.hashBytes, msPerTickAtHashEvery: hashCpuMs / HASH_EVERY },
  coresAt30Hz: (cpuT.total! * 30 + hashCpuMs * 30 / HASH_EVERY) / 1000,
  stateHash: runs[0]!.hash, stateDigest: runs[0]!.digest,
};

// ---------------- report ----------------
const f = (x: number | undefined, d = 3): string => (x === undefined ? '-' : x.toFixed(d));
console.log(`\nscenario ${SCENARIO}${PHYSICS === 'off' ? ' (physics off)' : ''}: ${TICKS} ticks after ${WARM} warm-up, median of ${RUNS} runs, load ${out.loadavg.join(' ')}`);
console.log(`live ${out.live.start} -> ${out.live.end}, segments ${out.live.segments}; create ${f(out.createCpuMs, 0)} ms CPU`);
console.log('| phase | CPU ms/tick | wall ms/tick |' + (ALLOC ? ' KB/tick |' : ''));
console.log('|---|---|---|' + (ALLOC ? '---|' : ''));
for (const p of [...PHASES, 'total']) {
  console.log(`| ${p} | ${f(cpuT[p])} | ${f(out.wallMsPerTick[p])} |` + (ALLOC ? ` ${f(out.allocBytesPerTick![p]! / 1024, 1)} |` : ''));
}
console.log(`| hash (one, ${(out.hash.bytes / 1e6).toFixed(1)} MB) | ${f(out.hash.cpuMs, 1)} | ${f(out.hash.ms, 1)} |`);
console.log(`ticks/s: ${f(out.ticksPerCpuS, 1)} per CPU second, ${f(out.ticksPerWallS, 1)} wall; GC ${f(out.gcMsPerTick)} ms/tick (${f(out.gcPerTick, 2)} per tick)`);
console.log(`cores needed at 30 ticks/s (hash every ${HASH_EVERY}): ${f(out.coresAt30Hz, 3)}`);
console.log(`state hash ${out.stateHash}, digest ${out.stateDigest}`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2) + '\n');

// ---------------- goldens ----------------
const key = `${SCENARIO}@${WARM + TICKS}${PHYSICS === 'off' ? '/nophys' : ''}`;
if (RECORD) {
  let g: Record<string, unknown> = {};
  try { g = JSON.parse(readFileSync(RECORD, 'utf8')); } catch { /* new file */ }
  g[key] = { hash: out.stateHash, digest: out.stateDigest };
  writeFileSync(RECORD, JSON.stringify(g, null, 2) + '\n');
  console.log(`recorded ${key} in ${RECORD}`);
}
if (EXPECT) {
  const g = JSON.parse(readFileSync(EXPECT, 'utf8')) as Record<string, { hash: string; digest: string }>;
  const e = g[key];
  if (!e) { console.error(`no golden for ${key} in ${EXPECT}`); process.exit(3); }
  if (e.hash !== out.stateHash || e.digest !== out.stateDigest) {
    console.error(`GOLDEN MISMATCH for ${key}: expected ${e.hash}/${e.digest}, got ${out.stateHash}/${out.stateDigest}`);
    process.exit(4);
  }
  console.log(`golden ${key} matches`);
}
