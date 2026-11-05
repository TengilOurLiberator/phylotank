/**
 * Spike 3, genome half (REVIEW R14): species count under pure asexual drift.
 *
 * Wright-Fisher, non-overlapping generations, N budders founded from Motefly clones. Each child
 * picks a parent uniformly (neutral) or with a stabilising viability weight on the developed
 * body (selection), is mutated with the real operators at the template's rates, and is assigned
 * online by SpeciesRegistry. Parents die at the end of their generation.
 *
 *   npx esbuild tests/genome-spike3.ts --bundle --platform=node --format=esm --outfile=/tmp/s3.mjs
 *   node /tmp/s3.mjs N G mode(genetic|phenotype) selection(neutral|stabilising) [seed] [join(lineage|medoid)]
 */
import { PRESETS, RngStreams, TICK_HZ, type Genome } from '../src/core/index.js';
import {
  InnovationRegistry, SpeciesRegistry, develop, lifeHistory, mutateWith, templateGenome, trait,
} from '../src/genome/index.js';
import { TI } from '../src/genome/genes.js';

const [N = 2000, G = 1000] = process.argv.slice(2, 4).map(Number);
const mode = (process.argv[4] ?? 'phenotype') as 'genetic' | 'phenotype';
const selection = process.argv[5] ?? 'neutral';
const seed = Number(process.argv[6] ?? 1);
const L_CEIL = PRESETS.small.lCeilingM;
const rng = new RngStreams(seed, 0x5eed);
const reg = new InnovationRegistry();
const joinRule = (process.argv[7] ?? 'lineage') as 'lineage' | 'medoid';
const sr = new SpeciesRegistry({ lCeilingM: L_CEIL, rng, mode, seed, joinRule });
const ENV = { depth01: 0.5, tempC: 14 };
const OPTS = { maxParts: 64, lCeilingM: L_CEIL };

const founder = templateGenome('motefly');
const lh = lifeHistory(founder, L_CEIL);
const adultKg = develop(founder, 1, ENV, OPTS).massKg;
const genTicks = Math.max(1, Math.round(lh.tMatureS * TICK_HZ));
const root = sr.found(founder, 0, { adultMassKg: adultKg, tMatureS: lh.tMatureS, name: { genus: 'Flagellux', epithet: 'minima' } });

interface Ind { g: Genome; sp: number; id: number; w: number }
const L0 = Math.log(trait(founder, TI.ADULT_LENGTH));
function viability(g: Genome): number {
  if (selection === 'neutral') return 1;
  const ph = develop(g, 1, ENV, OPTS);
  if (selection === 'disruptive') {
    // positive control: two size optima, half and twice the founder length
    const dl = Math.log(ph.adultLengthM) - L0;
    const z = Math.min((dl - 0.69) ** 2, (dl + 0.69) ** 2) / (0.25 * 0.25);
    return Math.exp(-0.5 * z) + 0.02;
  }
  const dl = (Math.log(ph.adultLengthM) - L0) / 0.5;
  const dp = (ph.nParts - 9) / 6;
  return Math.exp(-0.5 * (dl * dl + dp * dp)) * (ph.mouth.filter > 0 ? 1 : 0.2);
}
let nextId = 1;
let pop: Ind[] = [];
for (let i = 0; i < N; i++) { const id = nextId++; sr.assign({ genome: founder, parentSpecies: root, tick: 0, entityId: id, massKg: adultKg, adultMassKg: adultKg, tMatureS: lh.tMatureS }); pop.push({ g: founder, sp: root, id, w: 1 }); }
// fix: the founders above joined `root` through assign; that is the same species
let promotions = 0, incipientFounded = 0;
const t0 = Date.now();
const report: string[] = [];
for (let gen = 1; gen <= G; gen++) {
  const tick = gen * genTicks;
  const draw = rng.draw(100, tick, 0); // the spike's own selection stream (not a sim stream)
  // cumulative weights
  const cum = new Float64Array(pop.length);
  let s = 0;
  for (let i = 0; i < pop.length; i++) { s += pop[i]!.w; cum[i] = s; }
  const next: Ind[] = [];
  for (let k = 0; k < N; k++) {
    const x = draw.u01x53() * s;
    let lo = 0, hi = pop.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid]! > x) hi = mid; else lo = mid + 1; }
    const p = pop[lo]!;
    const id = nextId++;
    const g = mutateWith(p.g, { rng, tick, childId: id, lCeilingM: L_CEIL, mutagen: 1 }, reg);
    const before = sr.records.length;
    const r = sr.assign({ genome: g, parentSpecies: p.sp, tick, entityId: id, massKg: adultKg, adultMassKg: adultKg, tMatureS: lh.tMatureS, parentGenome: p.g });
    if (sr.records.length > before) incipientFounded++;
    promotions += r.events.filter((e) => e.k === 'speciation').length;
    next.push({ g, sp: r.species, id, w: viability(g) });
  }
  for (const p of pop) sr.death(p.sp, adultKg, p.id, tick);
  promotions += sr.tick(tick).filter((e) => e.k === 'speciation').length;
  pop = next;
  if (gen % Math.max(1, Math.floor(G / 10)) === 0 || gen === G) {
    const live = sr.living(true);
    const promoted = live.filter((r) => r.status === 'species');
    const big = promoted.filter((r) => r.pop >= 0.01 * N);
    const line = `gen ${gen}: births ${gen * N}, living species ${promoted.length} (>=1% of N: ${big.length}), living incipient ${live.length - promoted.length}, promotions so far ${promotions}, incipient founded ${incipientFounded}, largest share ${(Math.max(...promoted.map((r) => r.pop)) / N).toFixed(3)}, ${((Date.now() - t0) / 1000).toFixed(0)} s`;
    console.log(line);
    report.push(line);
  }
}
const muLog = pop.reduce((a, p) => a + trait(p.g, TI.MU_LOG), 0) / pop.length;
const mods = pop.reduce((a, p) => a + p.g.modules.length, 0) / pop.length;
console.log(`summary N=${N} G=${G} mode=${mode} selection=${selection} seed=${seed} join=${joinRule}: promotions per 1e5 births ${(promotions / (N * G) * 1e5).toFixed(2)}, mean MU_LOG ${muLog.toFixed(2)}, mean modules ${mods.toFixed(1)}, distance calls ${sr.distanceCalls}`);
