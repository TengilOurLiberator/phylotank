/**
 * Event suite on a world with the real genome module (bodies with many parts and organs), for
 * docs/spikes/events-1.md. Not a vitest file: bundle and run with
 *   npx esbuild tests/events-bench.ts --bundle --platform=node --format=esm --outfile=/tmp/events-bench.mjs && node /tmp/events-bench.mjs [simSeconds]
 */
import { createSim, drainEvents } from '../src/sim/index.js';
import { genome } from '../src/genome/index.js';
import { EventSuite } from '../src/sim/events/index.js';
import type { WorldConfig } from '../src/core/index.js';

const seconds = Number(process.argv[2] ?? 600);
const core = createSim({ genome });
const w = core.create({
  preset: 'small', seedLo: 11, seedHi: 3, backend: 'cpu',
  founders: [{ template: 'motefly', count: 200 }, { template: 'meadowlamp', count: 40 }, { template: 'hushmaw', count: 20 }, { template: 'sievebell', count: 40 }],
} as WorldConfig);
const suite = new EventSuite({ clock: () => performance.now() });
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
