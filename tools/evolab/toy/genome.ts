/**
 * The toy's own genome: a flat vector of real genes, each stored normalised in [0, 1] and decoded
 * through a linear or log range. Deliberately crude (review spike 3): a length gene, a body shape,
 * fins and muscle for swimming, a mouth and diet, a few behaviour weights, the life-history genes
 * the review asks to watch (SENESCENCE, LIFESPAN_MULT, SESSILE, CLUTCH_SIZE) and neutral markers.
 *
 * Mutation is a pure function of (seed, MUTATION stream, tick, child id), so a run replays bit for
 * bit. It uses src/core/rng and src/core/dmath only.
 */
import { exp, log } from '../../../src/core/dmath.js';
import type { Draw } from '../../../src/core/rng.js';

export interface GeneSpec {
  readonly name: string;
  readonly lo: number;
  readonly hi: number;
  readonly log: boolean;
  /** Part of the expressed phenotype used for species (review R14: body plan and diet only). */
  readonly pheno: boolean;
  /** Neutral marker: no effect on anything (drift only). */
  readonly neutral?: boolean;
}

export const GENES: readonly GeneSpec[] = [
  { name: 'length', lo: 0.0005, hi: 1.0, log: true, pheno: true },          // adult length, m (clamped to the ceiling)
  { name: 'aspect', lo: 0.08, hi: 0.6, log: false, pheno: true },           // width / length
  { name: 'finArea', lo: 0, hi: 1, log: false, pheno: true },               // fin area / L^2
  { name: 'muscle', lo: 0.05, hi: 0.6, log: false, pheno: true },           // muscle mass fraction
  { name: 'cruise', lo: 0, hi: 1, log: false, pheno: false },               // cruising effort
  { name: 'sprint', lo: 0, hi: 1, log: false, pheno: false },               // effort when chasing or fleeing
  { name: 'wFood', lo: -2, hi: 2, log: false, pheno: false },               // steer up the food gradient
  { name: 'wFlee', lo: -2, hi: 2, log: false, pheno: false },               // steer away from threats
  { name: 'wHunt', lo: -2, hi: 2, log: false, pheno: false },               // steer towards prey
  { name: 'wWander', lo: 0, hi: 1, log: false, pheno: false },              // random turning
  { name: 'filter', lo: 0, hi: 1, log: false, pheno: true },                // 1 filter mouth, 0 biting or scraping
  { name: 'dietPlant', lo: 0, hi: 1, log: false, pheno: true },             // x1 of the enzyme simplex (CONTRACT 9.3)
  { name: 'dietDetritus', lo: 0, hi: 1, log: false, pheno: true },          // x2 of the enzyme simplex
  { name: 'senescence', lo: 0, hi: 1, log: false, pheno: false },           // SENESCENCE
  { name: 'lifespanMult', lo: 1, hi: 20, log: true, pheno: false },         // LIFESPAN_MULT
  { name: 'sessile', lo: 0, hi: 1, log: false, pheno: true },               // SESSILE (> 0.5 attaches)
  { name: 'clutch', lo: 1, hi: 64, log: true, pheno: false },               // CLUTCH_SIZE
  { name: 'birthFraction', lo: 0.04, hi: 0.5, log: true, pheno: false },    // BIRTH_FRACTION of adult mass
  { name: 'mutRate', lo: 0.005, hi: 0.2, log: true, pheno: false },         // sd of a point mutation, normalised units
  { name: 'odourA', lo: 0, hi: 1, log: false, pheno: false, neutral: true },
  { name: 'odourB', lo: 0, hi: 1, log: false, pheno: false, neutral: true },
  { name: 'odourC', lo: 0, hi: 1, log: false, pheno: false, neutral: true },
];

export const NG = GENES.length;
export const G = Object.fromEntries(GENES.map((g, i) => [g.name, i])) as Record<string, number>;
export const GI = {
  length: 0, aspect: 1, finArea: 2, muscle: 3, cruise: 4, sprint: 5, wFood: 6, wFlee: 7, wHunt: 8, wWander: 9,
  filter: 10, dietPlant: 11, dietDetritus: 12, senescence: 13, lifespanMult: 14, sessile: 15, clutch: 16,
  birthFraction: 17, mutRate: 18, odourA: 19, odourB: 20, odourC: 21,
} as const;

const LOG_LO = GENES.map((g) => (g.log ? log(g.lo) : g.lo));
const LOG_HI = GENES.map((g) => (g.log ? log(g.hi) : g.hi));

/** Decode a normalised gene value (0..1) to its trait value. */
export function decodeGene(i: number, x: number): number {
  const a = LOG_LO[i]!;
  const b = LOG_HI[i]!;
  const v = a + (b - a) * x;
  return GENES[i]!.log ? exp(v) : v;
}
/** Encode a trait value to its normalised gene value (clamped to 0..1). */
export function encodeGene(i: number, v: number): number {
  const a = LOG_LO[i]!;
  const b = LOG_HI[i]!;
  const t = GENES[i]!.log ? log(Math.max(v, 1e-300)) : v;
  return Math.min(1, Math.max(0, (t - a) / (b - a)));
}

/** Build a normalised genome from trait values (missing names keep 0.5). */
export function genomeFrom(traits: Partial<Record<keyof typeof GI, number>>): Float64Array {
  const g = new Float64Array(NG).fill(0.5);
  for (const [k, v] of Object.entries(traits)) {
    const i = GI[k as keyof typeof GI];
    if (i === undefined || v === undefined) throw new Error(`unknown toy gene ${k}`);
    g[i] = encodeGene(i, v);
  }
  return g;
}

export interface MutationOptions {
  /** Probability that a gene is perturbed in one birth. */
  readonly perGeneP: number;
  /** Upper bound on the normalised length gene (the size ceiling, CONTRACT 3.3). */
  readonly lengthGeneMax: number;
  /** Multiplier on all mutation (a mutagen god power, or a tuning knob). */
  readonly mutagen: number;
}

/** Mutate `src` into `dst` (both normalised). Reflecting bounds keep genes in [0, 1]. */
export function mutate(src: Float64Array, srcOff: number, dst: Float64Array, dstOff: number, d: Draw, o: MutationOptions): void {
  const sigma = decodeGene(GI.mutRate, src[srcOff + GI.mutRate]!) * o.mutagen;
  for (let i = 0; i < NG; i++) {
    let x = src[srcOff + i]!;
    if (d.u01() < o.perGeneP * o.mutagen) {
      x += d.normal() * sigma;
      // reflect into [0, 1]
      if (x < 0) x = -x;
      if (x > 1) x = 2 - x;
      x = Math.min(1, Math.max(0, x));
    }
    dst[dstOff + i] = x;
  }
  if (dst[dstOff + GI.length]! > o.lengthGeneMax) dst[dstOff + GI.length] = o.lengthGeneMax;
}

/** Root-mean-square distance over a gene subset (normalised units). */
export function rmsDistance(a: Float64Array, aOff: number, b: Float64Array, bOff: number, idx: readonly number[]): number {
  let s = 0;
  for (const i of idx) { const d = a[aOff + i]! - b[bOff + i]!; s += d * d; }
  return Math.sqrt(s / idx.length);
}

export const PHENO_GENES: readonly number[] = GENES.flatMap((g, i) => (g.pheno ? [i] : []));
export const ALL_GENES: readonly number[] = GENES.map((_, i) => i);
