/**
 * Genetic and phenotypic distance (01 §1.9.1, DESIGN R3, review R14).
 *
 * Genetic: delta = C_S (1 - J) + C_P mean_matching |dx| + C_T mean_traits |dx|
 *   J: weighted Jaccard over expressed structural genes only (expressed modules and links,
 *      enabled regulatory genes; CPPN genes at weight 0.5). Silent genes and direct synapses
 *      are excluded (review R14).
 *   matching term: mean normalised field difference over matching expressed modules and links.
 *   trait term: traits and brain traits marked `dist` in the schema (look-only, mating and
 *      neutral markers such as ODOUR are excluded).
 *
 * Phenotypic (for budders, review R14): a body-plan descriptor from the developed adult (part
 * counts per kind, mouth weights, diet enzymes, log size, sessility); neutral genes and silent
 * structure cannot move it at all.
 */
import {
  BRAIN_TRAITS, KIND_COUNT, TRAITS, log, type BirthEnv, type Genome, type LinkGene, type ModuleGene,
} from '../core/index.js';
import { CPPN_JACCARD_WEIGHT, C_P, C_S, C_T } from './constants.js';
import { develop } from './develop.js';
import { TI, expressedSets, isEnabledReg, trait } from './genes.js';

export const DIST_TRAITS: readonly number[] = TRAITS.flatMap((s, i) => (s && s.dist ? [i] : []));
export const DIST_BRAIN_TRAITS: readonly number[] = BRAIN_TRAITS.flatMap((s, i) => (s && s.dist && !s.immutable ? [i] : []));

const MOD_NUM: (keyof ModuleGene)[] = ['length', 'width', 'span', 'taper', 'stiffness', 'lipidFraction', 'muscleFraction',
  'gutFraction', 'armourCoverage', 'glow', 'p1', 'p2', 'cpgAmp', 'jointRange', 'allometry', 'p3', 'p5', 'photoFraction'];
const MOD_MAX: Record<string, number> = { length: 65535, width: 65535 };
const LINK_NUM: (keyof LinkGene)[] = ['attachPos', 'attachAngle', 'childScale', 'repeatScale', 'repeat', 'symmetry'];
const LINK_MAX: Record<string, number> = { attachAngle: 255, repeat: 15, symmetry: 2 };

export interface DistanceParts { jaccard: number; matching: number; traits: number; total: number }

export function distanceParts(a: Genome, b: Genome): DistanceParts {
  const ea = expressedSets(a), eb = expressedSets(b);
  let shared = 0, union = 0;
  const jac = (sa: Set<number | bigint>, sb: Set<number | bigint>, w: number): void => {
    for (const x of sa) { union += w; if (sb.has(x)) shared += w; }
    for (const x of sb) if (!sa.has(x)) union += w;
  };
  jac(ea.modules, eb.modules, 1);
  jac(ea.links, eb.links, 1);
  jac(new Set(a.regs.filter(isEnabledReg).map((r) => r.innov)), new Set(b.regs.filter(isEnabledReg).map((r) => r.innov)), 1);
  jac(new Set(a.cppnNodes.filter((n) => n.flags & 1).map((n) => n.innov)), new Set(b.cppnNodes.filter((n) => n.flags & 1).map((n) => n.innov)), CPPN_JACCARD_WEIGHT);
  jac(new Set(a.cppnConns.filter((n) => n.flags & 1).map((n) => n.innov)), new Set(b.cppnConns.filter((n) => n.flags & 1).map((n) => n.innov)), CPPN_JACCARD_WEIGHT);
  const J = union > 0 ? shared / union : 1;
  // matching genes
  let sum = 0, cnt = 0;
  const bm = new Map(b.modules.map((m) => [m.innov, m]));
  for (const m of a.modules) {
    if (!ea.modules.has(m.innov) || !eb.modules.has(m.innov)) continue;
    const o = bm.get(m.innov)!;
    let s = 0;
    for (const f of MOD_NUM) s += Math.abs((m[f] as number) - (o[f] as number)) / (MOD_MAX[f] ?? 255);
    sum += s / MOD_NUM.length; cnt++;
  }
  const bl = new Map(b.links.map((l) => [l.innov, l]));
  for (const l of a.links) {
    if (!ea.links.has(l.innov) || !eb.links.has(l.innov)) continue;
    const o = bl.get(l.innov)!;
    let s = 0;
    for (const f of LINK_NUM) s += Math.min(1, Math.abs((l[f] as number) - (o[f] as number)) / (LINK_MAX[f] ?? 255));
    sum += s / LINK_NUM.length; cnt++;
  }
  const matching = cnt > 0 ? sum / cnt : 0;
  let ts = 0;
  for (const i of DIST_TRAITS) ts += Math.abs((a.traits[i] ?? 0) - (b.traits[i] ?? 0)) / 65535;
  for (const i of DIST_BRAIN_TRAITS) ts += Math.abs((a.brainTraits[i] ?? 0) - (b.brainTraits[i] ?? 0)) / 65535;
  const traits = ts / (DIST_TRAITS.length + DIST_BRAIN_TRAITS.length);
  const total = C_S * (1 - J) + C_P * matching + C_T * traits;
  return { jaccard: J, matching, traits, total };
}

/** GenomeModule.distance (symmetric, d(a, a) = 0, d >= 0). */
export function distance(a: Genome, b: Genome): number { return distanceParts(a, b).total; }

// ---------------- phenotypic descriptor ----------------
export const DESC_LEN = KIND_COUNT + 5 + 3 + 2;
const ENV0: BirthEnv = { depth01: 0.5, tempC: 14 };

/** Body-plan descriptor of the developed adult (review R14). */
export function bodyPlanDescriptor(g: Genome, lCeilingM: number): Float64Array {
  const ph = develop(g, 1, ENV0, { maxParts: 64, lCeilingM });
  const d = new Float64Array(DESC_LEN);
  const counts = new Float64Array(KIND_COUNT);
  for (let i = 0; i < ph.nParts; i++) counts[ph.kind[i]!]!++;
  for (const o of ph.organList) {
    if (o.kind === 'eye') counts[4]!++;
    else if (o.kind === 'chemo') counts[5]!++;
    else if (o.kind === 'photophore') counts[7]!++;
  }
  for (let k = 0; k < KIND_COUNT; k++) d[k] = log(1 + counts[k]!) / 2.772588722239781; // log2(1+n)/4
  const m = ph.mouth;
  d[KIND_COUNT] = m.filter; d[KIND_COUNT + 1] = m.scrape; d[KIND_COUNT + 2] = m.bite; d[KIND_COUNT + 3] = m.suction; d[KIND_COUNT + 4] = m.latch;
  const x1 = trait(g, TI.DIET_PLANT), x2 = trait(g, TI.DIET_DETRITUS);
  d[KIND_COUNT + 5] = x1 * (1 - x2); d[KIND_COUNT + 6] = (1 - x1) * (1 - x2); d[KIND_COUNT + 7] = x2;
  d[KIND_COUNT + 8] = log(ph.adultLengthM / 0.0005) / 7.6009024595420822; // 0..1 over the schema range
  d[KIND_COUNT + 9] = trait(g, TI.SESSILE) > 0.5 ? 1 : 0;
  return d;
}

/** Distance between two body-plan descriptors; the same theta as the genetic distance applies. */
export function descriptorDistance(a: Float64Array, b: Float64Array): number {
  let plan = 0, mouth = 0, diet = 0;
  for (let k = 0; k < KIND_COUNT; k++) plan += Math.abs(a[k]! - b[k]!);
  for (let k = KIND_COUNT; k < KIND_COUNT + 5; k++) mouth += Math.abs(a[k]! - b[k]!);
  for (let k = KIND_COUNT + 5; k < KIND_COUNT + 8; k++) diet += Math.abs(a[k]! - b[k]!);
  const size = Math.abs(a[KIND_COUNT + 8]! - b[KIND_COUNT + 8]!);
  const sess = Math.abs(a[KIND_COUNT + 9]! - b[KIND_COUNT + 9]!);
  return plan / 3 + mouth / 2 + diet / 2 + 2 * size + 0.5 * sess;
}
