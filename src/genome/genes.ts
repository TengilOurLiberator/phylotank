/**
 * Gene-level helpers shared by development, mutation, crossover, repair and distance:
 * decoded ranges of the quantised record fields (CONTRACT 6.4 to 6.6), trait access in value and
 * x space, cloning, reachability (silent genes) and the deterministic integer helpers.
 *
 * Every function here is pure and uses only core/dmath for transcendentals (CONTRACT 4.2).
 */
import {
  BRAIN_TRAITS, BT, KIND, LINK_FLAG, MODULE_FLAG, T, TRAITS, decodeQ, encodeQ, exp, log,
  type Genome, type LinkGene, type ModuleGene, type RegGene, type Scale, type TraitSpec,
} from '../core/index.js';

export interface Range { readonly min: number; readonly max: number; readonly scale: Scale }
const R = (min: number, max: number, scale: Scale = 'lin'): Range => ({ min, max, scale });

/** Decoded ranges of module fields (CONTRACT 6.4). */
export const MOD_RANGE = {
  length: R(0.05, 4, 'log'), width: R(0.05, 2, 'log'), span: R(0.5, 8, 'log'), taper: R(0, 1),
  stiffness: R(0.1, 10, 'log'), lipidFraction: R(0, 0.6), muscleFraction: R(0, 0.8), gutFraction: R(0, 0.7),
  armourCoverage: R(0, 1), glow: R(0, 1), photoFraction: R(0, 1),
} as const;
/** Decoded ranges of link fields (CONTRACT 6.5). */
export const LINK_RANGE = { childScale: R(0.25, 2, 'log'), repeatScale: R(0.7, 1.3, 'log') } as const;

/** Number of subtypes per kind (CONTRACT 6.4 table). */
export const SUBTYPE_COUNT: readonly number[] = [3, 3, 3, 5, 2, 3, 2, 3, 1, 1, 1, 2];

export const DEG = 0.017453292519943295;
export const TAU_ = 6.283185307179586;

// ---------------- field decoding ----------------
export const u8 = (q: number, r: Range): number => decodeQ(q, r, 255);
export const u16 = (q: number, r: Range): number => decodeQ(q, r, 65535);
export const enc8 = (v: number, r: Range): number => encodeQ(v, r, 255);
export const enc16 = (v: number, r: Range): number => encodeQ(v, r, 65535);
/** Allometry exponent: 0.5 + q / 256, so 128 is 1.0 (CONTRACT 6.4). */
export const allometryOf = (q: number): number => 0.5 + q / 256;
/** hueOffset i8 to -0.5..0.5. */
export const hueOffsetOf = (q: number): number => q / 256;
/** jointRange u8 to radians (0 to 170 degrees). */
export const jointRangeOf = (q: number): number => (q / 255) * 170 * DEG;
/** jointRest i8 to radians (-90 to 90 degrees). */
export const jointRestOf = (q: number): number => (Math.max(-127, q) / 127) * 90 * DEG;
/** attachAngle i8 to radians (-180 to 180 degrees in 1.41 degree steps). */
export const attachAngleOf = (q: number): number => (q / 128) * 180 * DEG;
/** u8 phase to radians. */
export const phaseOf = (q: number): number => (q / 255) * TAU_;

// ---------------- traits ----------------
export function traitSpec(idx: number): TraitSpec {
  const s = TRAITS[idx];
  if (!s) throw new Error(`no trait at index ${idx}`);
  return s;
}
/** Decoded trait value. */
export function trait(g: Genome, idx: number): number {
  return decodeQ(g.traits[idx] ?? 0, traitSpec(idx));
}
export function setTrait(g: Genome, idx: number, v: number): void {
  g.traits[idx] = encodeQ(v, traitSpec(idx));
}
export function brainTrait(g: Genome, idx: number): number {
  const s = BRAIN_TRAITS[idx];
  if (!s) throw new Error(`no brain trait at index ${idx}`);
  return decodeQ(g.brainTraits[idx] ?? 0, s);
}
export function setBrainTrait(g: Genome, idx: number, v: number): void {
  const s = BRAIN_TRAITS[idx];
  if (!s) throw new Error(`no brain trait at index ${idx}`);
  g.brainTraits[idx] = encodeQ(v, s);
}
export function pow10(x: number): number { return exp(x * 2.302585092994046); }
export function powr(x: number, y: number): number { return x === 1 || y === 0 ? 1 : exp(y * log(x)); }

/** Trait indices used by the genome module (resolved once; tests/contract.test.ts checks the names). */
export const TI = {
  ADULT_LENGTH: T.ADULT_LENGTH!, BIRTH_FRACTION: T.BIRTH_FRACTION!, GROWTH_RATE: T.GROWTH_RATE!,
  MATURITY_FRACTION: T.MATURITY_FRACTION!, LIFESPAN_MULT: T.LIFESPAN_MULT!, CLUTCH_SIZE: T.CLUTCH_SIZE!,
  SEX_PROB: T.SEX_PROB!, MU_LOG: T.MU_LOG!, MU_STRUCT_RATIO: T.MU_STRUCT_RATIO!, SIGMA: T.SIGMA!,
  MUSCLE_STRENGTH: T.MUSCLE_STRENGTH!, DIET_PLANT: T.DIET_PLANT!, DIET_DETRITUS: T.DIET_DETRITUS!,
  JOINT_DAMPING: T.JOINT_DAMPING!, BODY_HUE: T.BODY_HUE!, SHELL: T.SHELL!, SESSILE: T.SESSILE!, TEMP_OPTIMUM: T.TEMP_OPTIMUM!,
  GLOW_HUE: T.GLOW_HUE!, GLOW_BASE: T.GLOW_BASE!, PULSE_FREQ: T.PULSE_FREQ!,
  G_SLENDERNESS: T.G_SLENDERNESS!, G_FIN: T.G_FIN!, G_EYE: T.G_EYE!, G_MOUTH: T.G_MOUTH!,
  G_SPIKE: T.G_SPIKE!, G_ARMOUR: T.G_ARMOUR!, G_TAPER: T.G_TAPER!, G_STIFFNESS: T.G_STIFFNESS!,
  G_PHOTOPHORE: T.G_PHOTOPHORE!, G_GUT: T.G_GUT!, G_LIMB_LENGTH: T.G_LIMB_LENGTH!,
} as const;
export const BTI = { ENCODING: BT.ENCODING! } as const;

// ---------------- cloning ----------------
export function cloneGenome(g: Genome): Genome {
  return {
    formatVersion: g.formatVersion, flags: g.flags, rootModuleInnov: g.rootModuleInnov,
    traits: g.traits.slice(), immuneKey: g.immuneKey, surfaceSig: g.surfaceSig,
    modules: g.modules.map((m) => ({ ...m })), links: g.links.map((l) => ({ ...l })),
    regs: g.regs.map((r) => ({ ...r })), brainTraits: g.brainTraits.slice(),
    cppnNodes: g.cppnNodes.map((n) => ({ ...n })), cppnConns: g.cppnConns.map((c) => ({ ...c })),
    hiddenNeurons: g.hiddenNeurons.map((n) => ({ ...n })), directSynapses: g.directSynapses.map((s) => ({ ...s })),
    unknown: g.unknown.map((s) => ({ ...s, bytes: s.bytes.slice() })),
  };
}

// ---------------- structure ----------------
export const isEnabledModule = (m: ModuleGene): boolean => (m.flags & MODULE_FLAG.ENABLED) !== 0;
export const isEnabledLink = (l: LinkGene): boolean => (l.flags & LINK_FLAG.ENABLED) !== 0;
export const isEnabledReg = (r: RegGene): boolean => (r.flags & 1) !== 0;

export function findModule(g: Genome, innov: number): ModuleGene | undefined {
  // modules are sorted by innov after repair; a linear scan is fine at 48 records
  for (const m of g.modules) if (m.innov === innov) return m;
  return undefined;
}

/**
 * Expressed structure: modules reachable from the root through enabled links into enabled
 * modules, and the enabled links between them. Everything else is silent (01 §1.7.4 rule 4).
 */
export function expressedSets(g: Genome): { modules: Set<number>; links: Set<number> } {
  const mods = new Set<number>();
  const links = new Set<number>();
  const byInnov = new Map<number, ModuleGene>();
  for (const m of g.modules) byInnov.set(m.innov, m);
  const root = byInnov.get(g.rootModuleInnov);
  if (!root || !isEnabledModule(root)) return { modules: mods, links };
  mods.add(root.innov);
  let changed = true;
  while (changed) {
    changed = false;
    for (const l of g.links) {
      if (!isEnabledLink(l) || !mods.has(l.fromInnov)) continue;
      const to = byInnov.get(l.toInnov);
      if (!to || !isEnabledModule(to)) continue;
      if (!links.has(l.innov)) { links.add(l.innov); changed = true; }
      if (!mods.has(to.innov)) { mods.add(to.innov); changed = true; }
    }
  }
  return { modules: mods, links };
}

/** Reflect into [0, 1] (01 §1.6.1): a gene never sticks at a bound. */
export function reflect01(x: number): number {
  let y = x;
  for (let i = 0; i < 4 && (y < 0 || y > 1); i++) y = y < 0 ? -y : 2 - y;
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

export { KIND };
