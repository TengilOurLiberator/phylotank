/**
 * Event suite on a world with the real genome module (bodies with many parts and organs), for
 * docs/spikes/events-1.md. Not a vitest file: bundle and run with
 *   npx esbuild tests/events-bench.ts --bundle --platform=node --format=esm --outfile=/tmp/events-bench.mjs
 *   node /tmp/events-bench.mjs [simSeconds]   (a real-genome world: events and cost)
 *   node /tmp/events-bench.mjs staged         (full Small, Default and Large tanks: cost per detector)
 */
import { createSim, drainEvents, sim } from '../src/sim/index.js';
import { genome } from '../src/genome/index.js';
import { EventSuite } from '../src/sim/events/index.js';
import { LIFE, type PresetName, type WorldConfig } from '../src/core/index.js';

/** CPU time of this process in ms (other jobs on a shared machine count less than wall time). */
const cpuMs = (): number => process.cpuUsage().user / 1000 + process.cpuUsage().system / 1000;

if (process.argv[2] === 'staged') {
  // full tanks with something for every detector to do (as tests/events.test.ts 'cost')
  for (const [preset, n] of [['small', 4000], ['default', 8000], ['large', 8000]] as [PresetName, number][]) {
    const w = sim.create({ preset, seedLo: 7, seedHi: 1, backend: 'cpu', skeletonMotes: n });
    for (let i = 0; i < 6; i++) sim.step(w);
    const c = w.cr.c;
    const alive: number[] = [];
    for (let s = 0; s < w.cr.highWater; s++) if (c.life[s] === LIFE.ALIVE) alive.push(s);
    alive.slice(0, 200).forEach((s) => { c.life[s] = LIFE.CARCASS; c.length[s] = 0.05; });
    alive.slice(200, 800).forEach((s) => { c.infStrain[2 * s] = 3; });
    alive.forEach((s, i) => { c.diet[7 * s + (i % 6)] = 1; c.maturity[s] = 1; });
    const suite = new EventSuite({ clock: cpuMs });
    for (let i = 0; i < 120; i++) {
      w.g.tick += 30;
      if (i === 20) suite.resetCosts();
      if (i === 60) for (let k = 0; k < w.fields.qP.length; k += 7) w.fields.qP[k] = w.fields.qP[k]! * 3 + 1000;
      suite.run(w);
    }
    const costs = suite.costs();
    console.log(`${preset} ${alive.length} creatures, total ${(costs.reduce((a, x) => a + x.perTickMs, 0) * 1000).toFixed(1)} us/tick`);
    for (const x of costs) console.log(`  ${x.name.padEnd(10)} mean ${x.meanMs.toFixed(3)} ms/run, max ${x.maxMs.toFixed(2)} ms, ${(x.perTickMs * 1000).toFixed(1)} us/tick`);
  }
  process.exit(0);
}

const seconds = Number(process.argv[2] ?? 600);
const core = createSim({ genome });
const w = core.create({
  preset: 'small', seedLo: 11, seedHi: 3, backend: 'cpu',
  founders: [{ template: 'motefly', count: 200 }, { template: 'meadowlamp', count: 40 }, { template: 'hushmaw', count: 20 }, { template: 'sievebell', count: 40 }],
} as WorldConfig);
const suite = new EventSuite({ clock: cpuMs });
const kinds: Record<string, number> = {};
const t0 = performance.now();
let stepMs = 0;
for (let i = 0; i < 30 * seconds; i++) {
  const s0 = performance.now();
  core.step(w);
  stepMs += performance.now() - s0;
  const ev = drainEvents(w);
  for (const e of [...suite.observe(w, ev), ...suite.run(w)]) {
    const x = e as { story?: string; phase?: string };
    const k = e.k + (x.story ? `:${x.story}` : '') + (x.phase ? `:${x.phase}` : '');
    kinds[k] = (kinds[k] ?? 0) + 1;
    if (e.k === 'novelty' || e.k === 'record' || e.k === 'newRole') console.log(JSON.stringify(e));
  }
}
console.log(`sim ${seconds} s (${((performance.now() - t0) / 1000).toFixed(1)} s wall, step ${(stepMs / (30 * seconds)).toFixed(2)} ms/tick), live ${w.g.liveCount}`);
console.log(`events ${JSON.stringify(kinds)}`);
for (const c of suite.costs()) console.log(`${c.name.padEnd(10)} mean ${c.meanMs.toFixed(3)} ms/run, max ${c.maxMs.toFixed(2)} ms, ${(c.perTickMs * 1000).toFixed(1)} us/tick`);
