/**
 * Genome benchmarks (01 §1.4.6, B1). Not a vitest file: bundle and run with
 *   npx esbuild tests/genome-bench.ts --bundle --platform=node --format=esm --outfile=/tmp/genome-bench.mjs && node /tmp/genome-bench.mjs
 */
import { PRESETS, RngStreams, type Genome } from '../src/core/index.js';
import {
  InnovationRegistry, Restager, TEMPLATE_IDS, crossoverWith, develop, distance, mutateWith, templateGenome, unfold, finish,
} from '../src/genome/index.js';

const ENV = { depth01: 0.5, tempC: 14 };
const OPTS = { maxParts: 64, lCeilingM: PRESETS.default.lCeilingM };
const rng = new RngStreams(1, 2);

/** CPU time per call (process.cpuUsage, so other processes on a loaded machine count less), best of 3 runs. */
function time(label: string, n: number, fn: (i: number) => unknown): number {
  for (let i = 0; i < Math.min(2000, n); i++) fn(i); // warm-up
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const c0 = process.cpuUsage();
    for (let i = 0; i < n; i++) fn(i);
    const c = process.cpuUsage(c0);
    best = Math.min(best, (c.user + c.system) / n);
  }
  console.log(`${label.padEnd(34)} ${best.toFixed(2).padStart(8)} us`);
  return best;
}

console.log(`node ${process.version}, load average ${(await import('node:os')).loadavg().map((x) => x.toFixed(1)).join(' ')}`);
for (const id of TEMPLATE_IDS) {
  const g = templateGenome(id);
  const parts = develop(g, 1, ENV, OPTS).nParts;
  time(`develop ${id} (${parts} parts)`, 20000, (i) => develop(g, (i % 16) / 15, ENV, OPTS));
}
for (const id of ['blank', 'motefly', 'meadowlamp', 'deepcrown'] as const) {
  const g = templateGenome(id);
  const u = unfold(g, ENV, OPTS);
  time(`restage (finish) ${id}`, 20000, (i) => finish(u, (i % 16) / 15));
  const r = new Restager();
  time(`Restager.phenotype ${id}`, 20000, (i) => r.phenotype(g, (i % 16) / 15, ENV, OPTS));
}
// an evolved mid-size genome
const reg = new InnovationRegistry();
let evolved: Genome = templateGenome('meadowlamp');
for (let i = 0; i < 400; i++) evolved = mutateWith(evolved, { rng, tick: i, childId: i, lCeilingM: 0.2, mutagen: 4 }, reg);
console.log(`evolved: ${evolved.modules.length} modules, ${evolved.links.length} links, ${evolved.regs.length} regs, ${develop(evolved, 1, ENV, OPTS).nParts} parts`);
time('develop evolved', 20000, (i) => develop(evolved, (i % 16) / 15, ENV, OPTS));
const base = templateGenome('meadowlamp');
time('mutate meadowlamp (default rate)', 20000, (i) => mutateWith(base, { rng, tick: 1, childId: i, lCeilingM: 0.2, mutagen: 1 }, reg));
time('mutate evolved (default rate)', 20000, (i) => mutateWith(evolved, { rng, tick: 1, childId: i, lCeilingM: 0.2, mutagen: 1 }, reg));
time('crossover meadowlamp x evolved', 20000, (i) => crossoverWith(base, evolved, { rng, tick: 1, childId: i, lCeilingM: 0.2, mutagen: 1 }));
time('distance meadowlamp vs evolved', 50000, () => distance(base, evolved));
