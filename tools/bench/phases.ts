/**
 * Isolated phase timings on one warmed world: the minimum CPU time of N repeated calls of
 * brain.sense, brain.think and hashWorld (main thread, process.threadCpuUsage). On a shared,
 * loaded machine the minimum is the least disturbed figure, so this is the A/B tool for the
 * brain and hash work; tools/bench/harness.ts gives the whole pipeline.
 *   node tools/bench/bench.mjs is the pipeline; this one: node tools/bench/phases.mjs [reps]
 */
import { hashWorld, type WorldConfig } from '../../src/core/index.js';
import { contextFor, sim } from '../../src/sim/index.js';

const reps = Number(process.argv[2] ?? 30);
const founders = [
  { template: 'motefly', count: 1300, zone: 'surface' }, { template: 'meadowlamp', count: 330, zone: 'shelf' },
  { template: 'ashpicker', count: 200, zone: 'floor' }, { template: 'sievebell', count: 100, zone: 'surface' },
  { template: 'tetherling', count: 40 }, { template: 'hushmaw', count: 30 },
];
const mods = sim.modules as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>;
const physicsStep = mods.physics!.step!;
mods.physics!.step = (): void => {}; // warm-up without physics: fast, and the brains see a fixed scene
const w = sim.create({ preset: 'small', seedLo: 0x0be4c401, seedHi: 1, backend: 'cpu', agentCap: 4096, founders } as unknown as WorldConfig);
for (let i = 0; i < 30; i++) sim.step(w);
mods.physics!.step = physicsStep;
const ctx = contextFor(w);
const cpu = (): number => { const u = process.threadCpuUsage(); return u.user + u.system; };
const minOf = (n: number, f: () => void): number => {
  let best = Infinity;
  for (let r = 0; r < n; r++) { const t = cpu(); f(); best = Math.min(best, cpu() - t); }
  return best / 1000;
};
const out = {
  live: w.g.liveCount,
  senseMs: minOf(reps, () => mods.brain!.sense!(w, ctx)),
  thinkMs: minOf(reps, () => mods.brain!.think!(w, ctx)),
  hashMs: minOf(Math.max(3, reps >> 3), () => { hashWorld(w); }),
};
console.log(JSON.stringify(out));
