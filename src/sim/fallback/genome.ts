/**
 * Local fallback GenomeModule (phase 1): just enough of CONTRACT 6 and 7 for budding
 * creatures to run end to end while src/genome is built. The integrator replaces it with
 * `genome` from src/genome through `createSim({ genome })`.
 *
 * - develop: a single capsule part whose length follows maturity linearly from the newborn
 *   length (BIRTH_FRACTION x adult) to the expressed adult length (ceiling clamp, 3.3).
 * - mutate: per-trait point mutation in x space at rate 10^MU_LOG, step N(0, SIGMA), stream
 *   MUTATION keyed by the child's entity id; then the ceiling clamp.
 * - crossover: per trait from the bearer or the donor (stream CROSSOVER); structure from the bearer.
 * - distance: mean absolute x-space difference over the "Dist" traits, scaled so that one
 *   trait moved across its whole range is 0.5.
 */
import {
  clamp, decodeQ, emptyGenome, encodeQ, GENOME_FLAG_LEVIATHAN, ORGAN, PI, RNG_STREAM, T, TRAIT_COUNT, TRAITS,
  type BirthEnv, type DevelopOptions, type Genome, type GenomeModule, type MutationContext, type Phenotype,
  type TemplateId, pow,
} from '../../core/index.js';
import { blankGenome } from '../../genome/index.js';

export function trait(g: Genome, idx: number): number {
  return decodeQ(g.traits[idx]!, TRAITS[idx]!);
}
export function setTrait(g: Genome, idx: number, v: number): void {
  g.traits[idx] = encodeQ(v, TRAITS[idx]!);
}

export function cloneGenome(g: Genome): Genome {
  return {
    ...g,
    traits: g.traits.slice(), brainTraits: g.brainTraits.slice(),
    modules: g.modules.map((m) => ({ ...m })), links: g.links.map((l) => ({ ...l })), regs: g.regs.map((r) => ({ ...r })),
    cppnNodes: g.cppnNodes.map((n) => ({ ...n })), cppnConns: g.cppnConns.map((c) => ({ ...c })),
    hiddenNeurons: g.hiddenNeurons.map((n) => ({ ...n })), directSynapses: g.directSynapses.map((s) => ({ ...s })),
    unknown: g.unknown.slice(),
  };
}

export function adultLength(g: Genome, lCeilingM: number): number {
  const L = trait(g, T.ADULT_LENGTH!);
  return (g.flags & GENOME_FLAG_LEVIATHAN) !== 0 ? L : Math.min(L, lCeilingM);
}

/** Body length at a maturity (0 newborn, 1 adult). */
export function lengthAt(g: Genome, maturity: number, lCeilingM: number): number {
  const La = adultLength(g, lCeilingM);
  const Lb = La * trait(g, T.BIRTH_FRACTION!);
  return Lb + (La - Lb) * clamp(maturity, 0, 1);
}

const RADIUS_REL = 0.12;
const SPAN_REL = 0.24;
const RHO_TISSUE = 1060;

/** Capsule mass of a body of length L (radius 0.12 L, out-of-plane span 0.24 L). */
export function capsuleMassKg(L: number): number {
  const r = RADIUS_REL * L;
  const l = L - 2 * r;
  return RHO_TISSUE * (PI * r * r * l + (4 / 3) * PI * r * r * r);
}

function develop(g: Genome, maturity: number, env: BirthEnv, opts: DevelopOptions): Phenotype {
  void env;
  const m = clamp(maturity, 0, 1);
  const L = lengthAt(g, m, opts.lCeilingM);
  const La = adultLength(g, opts.lCeilingM);
  const f32 = (v = 0): Float32Array => Float32Array.of(v);
  const massKg = capsuleMassKg(L);
  const ph: Phenotype = {
    nParts: 1,
    parent: Int16Array.of(-1), kind: Uint8Array.of(0), subtype: Uint8Array.of(1),
    moduleInnov: Uint32Array.of(g.rootModuleInnov), pathHash: Uint32Array.of(0), dv: Int8Array.of(0),
    organs: Uint16Array.of(ORGAN.HEAD | ORGAN.GUT | ORGAN.MOUTH | ORGAN.PHOTOPHORE),
    attachU: f32(), restAngle: f32(), limitLo: f32(), limitHi: f32(),
    length: f32(L), radius: f32(RADIUS_REL * L), span: f32(SPAN_REL * L), taper: f32(0.5),
    muscleFrac: f32(0.25), lipidFrac: f32(0.05), armour: f32(0), youngsE: f32(3e5), damping: f32(0.15),
    u: f32(0.5), v: f32(), d: f32(), cpgPhase: f32(), cpgAmp: f32(1),
    glow: f32(trait(g, T.GLOW_BASE!)), hue: f32(trait(g, T.GLOW_HUE!)), params: new Float32Array(5),
    lengthM: L, adultLengthM: La, maturity: m, massKg,
    gutVolume: 0.1 * massKg / RHO_TISSUE, gGut: 0.5,
    mouth: { filter: 0, scrape: 1, bite: 0, suction: 0, latch: 0, gape: 0.5, biteForce: 0, mesh: 0 },
    handlingSize: 2 * RADIUS_REL * L, buildCostKg: massKg * 1.4,
    organList: [{ kind: 'head', part: 0, u: 0.2, v: 0, d: 0, params: [] }],
  };
  return ph;
}

function mutate(g: Genome, ctx: MutationContext): Genome {
  const c = cloneGenome(g);
  const d = ctx.rng.draw(RNG_STREAM.MUTATION, ctx.tick, ctx.childId);
  const p = Math.min(1, pow(10, trait(g, T.MU_LOG!)) * ctx.mutagen);
  const sigma = trait(g, T.SIGMA!);
  for (let i = 0; i < TRAIT_COUNT; i++) {
    const spec = TRAITS[i];
    if (!spec || spec.immutable) continue;
    if (d.u01() >= p) continue;
    const x = c.traits[i]! / 65535 + sigma * d.normal();
    c.traits[i] = Math.round(clamp(x, 0, 1) * 65535);
  }
  if ((c.flags & GENOME_FLAG_LEVIATHAN) === 0) {
    const qMax = encodeQ(ctx.lCeilingM, TRAITS[T.ADULT_LENGTH!]!);
    if (c.traits[T.ADULT_LENGTH!]! > qMax) c.traits[T.ADULT_LENGTH!] = qMax;
  }
  return c;
}

function crossover(bearer: Genome, donor: Genome, ctx: MutationContext): Genome {
  const c = cloneGenome(bearer);
  const d = ctx.rng.draw(RNG_STREAM.CROSSOVER, ctx.tick, ctx.childId);
  for (let i = 0; i < TRAIT_COUNT; i++) {
    const a = bearer.traits[i]!;
    const b = donor.traits[i] ?? a;
    const u = d.u01();
    c.traits[i] = u < 0.2 ? Math.round(a + (b - a) * d.u01()) : u < 0.6 ? b : a;
  }
  return c;
}

const DIST_TRAITS: number[] = TRAITS.filter((s) => s?.dist).map((s) => s!.idx);

function distance(a: Genome, b: Genome): number {
  let s = 0;
  for (const i of DIST_TRAITS) s += Math.abs(a.traits[i]! - b.traits[i]!);
  return (s / 65535) * 0.5;
}

/** Fallback templates: Blank, and Motefly as a small, fast budding grazer. */
function template(id: TemplateId): Genome {
  const g = id === 'blank' ? blankGenome() : blankGenome();
  if (id !== 'blank') {
    setTrait(g, T.ADULT_LENGTH!, 0.003);
    setTrait(g, T.BIRTH_FRACTION!, 0.4);
    setTrait(g, T.MATURITY_FRACTION!, 0.75);
    setTrait(g, T.CLUTCH_SIZE!, 2);
    setTrait(g, T.SEX_PROB!, 0);
    setTrait(g, T.GLOW_BASE!, 0.5);
    setTrait(g, T.GLOW_HUE!, 0.48);
    setTrait(g, T.BODY_HUE!, 0.5);
  }
  return g;
}

export const fallbackGenome: GenomeModule = {
  develop, mutate, crossover, distance, template,
  repair(g) { return cloneGenome(g); },
};

export { emptyGenome };
