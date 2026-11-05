/**
 * Development: genome to Phenotype (CONTRACT 7, 01 §1.4, DESIGN R4, R8, R10, R11, R12).
 *
 * Two stages, so a growth restage is cheap:
 *   unfold(g, env, opts)   body-graph expansion (BFS), positional signals (AP, DV), every
 *                          regulatory gene that does not read MATURITY. Independent of maturity.
 *   finish(u, maturity)    MATURITY regulation, gating, global modifiers, allometry, absolute size,
 *                          small-organ absorption, the part cap, solver clamps, derived quantities.
 * develop() = finish(unfold(...), m). A restage reuses the unfolded body (restage()).
 *
 * Conventions (recorded in docs/modules/genome.md, contract request 1):
 *   - Every part's axis points from its free end (tip) to its joint end (base, "front"); for the
 *     root the base is the snout, so the root axis is the forward direction. attachPos 0 is the
 *     parent's base and 255 its tip, so attachU = 0.5 - attachPos / 255 (+0.5 = parent's front).
 *     The child's joint is its own +0.5 end.
 *   - restAngle is in the world angle sense for heading 0 and mirror +1: a positive angle lifts a
 *     trailing child's free end dorsally. The ventral copy of a mirror link gets the negated angle.
 *   - u is 0 at the snout and 1 at the tail end of the root chain (parts beyond either end are
 *     clamped), v = dorsal offset / (L / 4) clamped to [-1, 1], d runs 0 to 1 along an appendage
 *     (0 on the root chain). L is the root-chain length, so a flagellum does not count towards it.
 */
import {
  C_G, C_G_ARMOUR, C_G_NEURAL, GENOME_FLAG_LEVIATHAN, KIND, LINK_FLAG, MAX_PARTS, MODULE_FLAG, ORGAN, REG_AXIS, REG_PARAM_GATE,
  SEGMENT_SUBTYPE, SYMMETRY, cos, exp, hash32, sin, wrapAngle,
  type BirthEnv, type DevelopOptions, type Genome, type ModuleGene, type MouthDescriptor, type OrganKind,
  type OrganSpec, type Phenotype, type RegGene,
} from '../core/index.js';
import {
  DEG, LINK_RANGE, MOD_RANGE, TAU_, TI, allometryOf, attachAngleOf, fastLog16, hueOffsetOf, isEnabledLink, isEnabledModule,
  isEnabledReg, jointRangeOf, jointRestOf, phaseOf, powr, table8, trait,
} from './genes.js';

/** Raw parts unfolded before gating and the cap (bounds work for adversarial genomes). */
export const MAX_RAW_PARTS = 256;
/** EYE, CHEMO and PHOTOPHORE parts shorter than this fraction of body length become organ flags (CONTRACT 7.2). */
export const ABSORB_FRACTION = 0.02;
/** Solver clamps (01 §1.11.2). */
export const MIN_LENGTH_FRACTION = 0.02;
export const MIN_RADIUS_FRACTION = 0.004;
export const MAX_MASS_RATIO = 200;
/** Young's modulus base (DESIGN R10). */
export const E_BASE_PA = 3e5;

// Scalar parameter slots (index into the per-part param vector).
const P_LEN = 0, P_WID = 1, P_SPAN = 2, P_TAPER = 3, P_STIFF = 4, P_LIPID = 5, P_MUSCLE = 6, P_GUT = 7,
  P_ARMOUR = 8, P_GLOW = 9, P_P1 = 10, P_P2 = 11, P_PHASE = 12, P_AMP = 13, P_RANGE = 14, P_REST = 15,
  P_ALPHA = 16, P_P3 = 17, P_P4 = 18, P_P5 = 19, P_PHOTO = 20;
const NP = 21;
/** ModuleGene byte offset to param slot, for RegGene.param (CONTRACT 6.6). */
const OFFSET_TO_PARAM: Readonly<Record<number, number>> = {
  8: P_LEN, 10: P_WID, 12: P_SPAN, 13: P_TAPER, 14: P_STIFF, 15: P_LIPID, 16: P_MUSCLE, 17: P_GUT, 18: P_ARMOUR,
  20: P_GLOW, 21: P_P1, 22: P_P2, 23: P_PHASE, 24: P_AMP, 25: P_RANGE, 26: P_REST, 27: P_ALPHA, 28: P_P3,
  29: P_P4, 30: P_P5, 31: P_PHOTO,
};
/** Upper clamps after regulation (lower clamp is 0 except where noted). */
const PARAM_MAX: readonly number[] = [
  1e9, 1e9, 1e9, 1, 1e9, 0.6, 0.8, 0.7, 1, 1, 1, 1, 1e9, 1, 170 * DEG, 90 * DEG, 1.5, 1, 1, 1, 1,
];

const TAB_SPAN = table8(MOD_RANGE.span), TAB_STIFF = table8(MOD_RANGE.stiffness);
const TAB_CHILD_SCALE = table8(LINK_RANGE.childScale), TAB_REPEAT_SCALE = table8(LINK_RANGE.repeatScale);
const decLength = fastLog16(MOD_RANGE.length), decWidth = fastLog16(MOD_RANGE.width);

/** Scratch buffers for unfold and finish (development is synchronous and not re-entrant). */
const SU = {
  modOf: new Int16Array(MAX_RAW_PARTS), parent: new Int16Array(MAX_RAW_PARTS), attachPos: new Float64Array(MAX_RAW_PARTS),
  angle: new Float64Array(MAX_RAW_PARTS), mirror: new Int8Array(MAX_RAW_PARTS), dv: new Int8Array(MAX_RAW_PARTS),
  phase: new Float64Array(MAX_RAW_PARTS), refLen: new Float64Array(MAX_RAW_PARTS), pathHash: new Uint32Array(MAX_RAW_PARTS),
  chainMid: new Uint8Array(MAX_RAW_PARTS), stepLink: new Uint32Array(MAX_RAW_PARTS), stepCode: new Uint16Array(MAX_RAW_PARTS), recur: new Uint8Array(MAX_RAW_PARTS * 48),
};
const SF = {
  params: new Float64Array(MAX_RAW_PARTS * NP), expressed: new Uint8Array(MAX_RAW_PARTS), keep: new Uint8Array(MAX_RAW_PARTS),
  len: new Float64Array(MAX_RAW_PARTS), wid: new Float64Array(MAX_RAW_PARTS), absorbed: new Uint8Array(MAX_RAW_PARTS),
  host: new Int16Array(MAX_RAW_PARTS), newIdx: new Int16Array(MAX_RAW_PARTS), mass: new Float64Array(MAX_RAW_PARTS),
  px: new Float64Array(MAX_RAW_PARTS), py: new Float64Array(MAX_RAW_PARTS), phi: new Float64Array(MAX_RAW_PARTS),
  cumBase: new Float64Array(MAX_RAW_PARTS), appRoot: new Int16Array(MAX_RAW_PARTS), tipMax: new Float64Array(MAX_RAW_PARTS),
  uu: new Float64Array(MAX_RAW_PARTS), vv: new Float64Array(MAX_RAW_PARTS), dd: new Float64Array(MAX_RAW_PARTS),
  cphi: new Float64Array(MAX_RAW_PARTS), sphi: new Float64Array(MAX_RAW_PARTS), kp: new Float64Array(MAX_RAW_PARTS * 5),
  relLen: new Float64Array(MAX_RAW_PARTS), cumStart: new Float64Array(MAX_RAW_PARTS), hasAxialChild: new Uint8Array(MAX_RAW_PARTS),
};

function decodeModuleParams(m: ModuleGene, out: Float64Array, o: number): void {
  out[o + P_LEN] = decLength(m.length);
  out[o + P_WID] = decWidth(m.width);
  out[o + P_SPAN] = TAB_SPAN[m.span & 255]!;
  out[o + P_TAPER] = m.taper / 255;
  out[o + P_STIFF] = TAB_STIFF[m.stiffness & 255]!;
  out[o + P_LIPID] = (m.lipidFraction / 255) * 0.6;
  out[o + P_MUSCLE] = (m.muscleFraction / 255) * 0.8;
  out[o + P_GUT] = m.kind === KIND.SEGMENT ? (m.gutFraction / 255) * 0.7 : 0;
  out[o + P_ARMOUR] = m.armourCoverage / 255;
  out[o + P_GLOW] = m.glow / 255;
  out[o + P_P1] = m.p1 / 255; out[o + P_P2] = m.p2 / 255;
  out[o + P_P3] = m.p3 / 255; out[o + P_P4] = m.p4 / 255; out[o + P_P5] = m.p5 / 255;
  out[o + P_PHASE] = phaseOf(m.cpgPhase);
  out[o + P_AMP] = m.cpgAmp / 255;
  out[o + P_RANGE] = jointRangeOf(m.jointRange);
  out[o + P_REST] = jointRestOf(m.jointRest);
  out[o + P_ALPHA] = allometryOf(m.allometry);
  out[o + P_PHOTO] = m.photoFraction / 255;
}

/** Shape function of a regulatory gene, in [0, 1] (CONTRACT 6.6). */
export function regShape(shape: number, t: number, centre: number, width: number): number {
  const d = t - centre;
  switch (shape) {
    case 0: { const z = d / width; return exp(-0.5 * z * z); }
    case 1: return 1 / (1 + exp(-4 * d / width));
    case 2: return 1 - 1 / (1 + exp(-4 * d / width));
    default: return d <= 0.5 * width && d >= -0.5 * width ? 1 : 0;
  }
}
const regCentre = (r: RegGene): number => r.centre / 255;
const regWidth = (r: RegGene): number => 0.01 + (r.width / 255) * 0.99;
const regAmount = (r: RegGene): number => Math.max(-1, Math.min(1, r.amount / 127));

/** An unfolded body: topology plus maturity-independent regulation. Reusable across restages. */
export interface Unfolded {
  readonly g: Genome;
  readonly n: number;
  readonly mods: ModuleGene[];
  readonly parent: Int16Array;
  readonly attachPos: Float64Array;   // 0 base .. 1 tip of the parent
  readonly angle: Float64Array;       // link angle (mirrored), rad
  readonly mirror: Int8Array;
  readonly dv: Int8Array;
  readonly phase: Float64Array;       // accumulated link phase
  readonly refLen: Float64Array;      // relative reference length
  readonly pathHash: Uint32Array;
  /** The link and (copy | side << 8) code of the step that created each raw part (editor paths). */
  readonly stepLink: Uint32Array; readonly stepCode: Uint16Array;
  readonly axial: Uint8Array;
  readonly ap: Float64Array;
  readonly params: Float64Array;      // n x NP, after non-maturity regulation
  readonly expressed: Uint8Array;     // after non-maturity gates
  readonly maturityRegs: RegGene[];
  readonly traitValues: TraitValues;
  /** Mutable trig cache of each part's rest angle (filled by finish). */
  readonly trigKey: Float64Array; readonly trigCos: Float64Array; readonly trigSin: Float64Array;
  readonly env: BirthEnv;
  readonly opts: DevelopOptions;
}

function targets(r: RegGene, m: ModuleGene): boolean {
  if (r.targetInnov !== 0) return r.targetInnov === m.innov;
  return r.targetKind === 255 || r.targetKind === m.kind;
}

function applyReg(r: RegGene, t: number, params: Float64Array, o: number, expressed: Uint8Array, i: number): void {
  const f = regShape(r.shape, t, regCentre(r), regWidth(r));
  const a = regAmount(r);
  if (r.param === REG_PARAM_GATE) {
    // positive amount: express only where f > 0.5; negative: suppress where f > 0.5
    const on = a >= 0 ? f > 0.5 : f <= 0.5;
    if (!on) expressed[i] = 0;
    return;
  }
  const slot = OFFSET_TO_PARAM[r.param];
  if (slot === undefined) return;
  const v = params[o + slot]! * exp(a * f);
  params[o + slot] = v > PARAM_MAX[slot]! ? PARAM_MAX[slot]! : v;
}

/** Stage 1: unfold the body graph and apply every regulatory gene that does not read maturity. */
export function unfold(g: Genome, env: BirthEnv, opts: DevelopOptions): Unfolded {
  const mods = g.modules;
  const nMod = mods.length;
  const modIndex = new Map<number, number>();
  for (let k = 0; k < nMod; k++) modIndex.set(mods[k]!.innov, k);
  // out-links per module, enabled, into enabled modules, in innov order (links are sorted)
  const out: number[][] = Array.from({ length: nMod }, () => []);
  const links = g.links;
  for (let k = 0; k < links.length; k++) {
    const l = links[k]!;
    if (!isEnabledLink(l)) continue;
    const a = modIndex.get(l.fromInnov), b = modIndex.get(l.toInnov);
    if (a === undefined || b === undefined || !isEnabledModule(mods[b]!)) continue;
    out[a]!.push(k);
  }
  let rootIdx = modIndex.get(g.rootModuleInnov);
  if (rootIdx === undefined) rootIdx = 0;
  const CAP = MAX_RAW_PARTS;
  const { modOf, parent, attachPos, angle, mirror, dv, phase, refLen, pathHash, chainMid, stepLink, stepCode } = SU;
  if (SU.recur.length < CAP * nMod) SU.recur = new Uint8Array(CAP * nMod);
  const recur = SU.recur;
  chainMid.fill(0);
  recur.fill(0, 0, Math.max(1, nMod));
  let n = 0;
  const push = (mod: number, par: number, pos: number, ang: number, mir: number, side: number, ph: number,
    ref: number, hash: number, bumpRecur: boolean, link = 0, code = 0): number => {
    if (n >= CAP) return -1;
    const i = n++;
    stepLink[i] = link; stepCode[i] = code;
    modOf[i] = mod; parent[i] = par; attachPos[i] = pos; angle[i] = ang; mirror[i] = mir; dv[i] = side;
    phase[i] = ph; refLen[i] = ref; pathHash[i] = hash;
    if (par >= 0) recur.copyWithin(i * nMod, par * nMod, par * nMod + nMod);
    if (bumpRecur && recur[i * nMod + mod]! < 255) recur[i * nMod + mod]!++;
    return i;
  };
  if (nMod > 0) push(rootIdx, -1, 0, 0, 1, 0, 0, 1, hash32(mods[rootIdx]!.innov, 0, 0), true);
  for (let head = 0; head < n; head++) {
    const mi = modOf[head]!;
    const m = mods[mi]!;
    const selfCount = recur[head * nMod + mi]!;
    const terminal = selfCount > m.recursionLimit && !chainMid[head];
    for (const lk of out[mi]!) {
      const L = links[lk]!;
      const ti = modIndex.get(L.toInnov)!;
      const tm = mods[ti]!;
      if (recur[head * nMod + ti]! > tm.recursionLimit) continue;          // recursion exhausted
      if ((L.flags & LINK_FLAG.TERMINAL_ONLY) !== 0 && !terminal) continue;
      const reps = Math.max(1, Math.min(16, L.repeat));
      const cs = TAB_CHILD_SCALE[L.childScale & 255]!;
      const rs = TAB_REPEAT_SCALE[L.repeatScale & 255]!;
      const baseAng = attachAngleOf(L.attachAngle);
      const pos = L.attachPos / 255;
      const wave = (L.flags & LINK_FLAG.PHASE_WAVE) !== 0 ? phaseOf(L.phaseStep) : 0;
      const pm = mirror[head]!;
      const pdv = dv[head]!;
      const ph0 = phase[head]! + (L.fromInnov === L.toInnov ? wave : 0);
      const ref0 = refLen[head]! * cs;
      const chain = tm.kind === KIND.SEGMENT || tm.kind === KIND.LIMB;
      if (L.symmetry === SYMMETRY.RADIAL) {
        for (let r = 0; r < reps; r++) {
          const ang = pm * (baseAng + (TAU_ * r) / reps);
          push(ti, head, pos, ang, pm, pdv, ph0 + r * wave, ref0, hash32(pathHash[head]!, L.innov, r | (3 << 8)), true, L.innov, r | (3 << 8));
        }
        continue;
      }
      const sides = L.symmetry === SYMMETRY.MIRROR ? 2 : 1;
      for (let sIdx = 0; sIdx < sides; sIdx++) {
        const s = sides === 2 ? (sIdx === 0 ? 1 : -1) : 1;
        const mir = pm * s;
        const side = pdv !== 0 ? pdv : sides === 2 ? s : 0;
        const sideCode = sides === 2 ? sIdx + 1 : 0;
        if (chain) {
          let prev = push(ti, head, pos, mir === pm ? pm * baseAng : -pm * baseAng, mir, side, ph0, ref0,
            hash32(pathHash[head]!, L.innov, sideCode << 8), true, L.innov, sideCode << 8);
          let ref = ref0;
          for (let r = 1; r < reps && prev >= 0; r++) {
            ref *= rs;
            chainMid[prev] = 1;
            prev = push(ti, prev, 1, 0, mir, side, ph0 + r * wave, ref, hash32(pathHash[head]!, L.innov, r | (sideCode << 8)), false, L.innov, r | (sideCode << 8));
          }
        } else {
          let ref = ref0;
          for (let r = 0; r < reps; r++) {
            const p = reps === 1 ? pos : Math.max(0, Math.min(1, pos + (r - (reps - 1) / 2) * (0.8 / reps)));
            push(ti, head, p, s * pm * baseAng, mir, side, ph0 + r * wave, ref, hash32(pathHash[head]!, L.innov, r | (sideCode << 8)), true, L.innov, r | (sideCode << 8));
            ref *= rs;
          }
        }
      }
    }
  }
  // per-part params
  const params = new Float64Array(n * NP);
  const partMods: ModuleGene[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const m = mods[modOf[i]!]!;
    partMods[i] = m;
    decodeModuleParams(m, params, i * NP);
  }
  // root chain (axial segments) and AP from adult relative lengths
  const axial = new Uint8Array(n);
  const hasAxialChild = SF.hasAxialChild; hasAxialChild.fill(0, 0, n);
  if (n > 0) axial[0] = 1;
  const relLen = SF.relLen;
  for (let i = 0; i < n; i++) relLen[i] = params[i * NP + P_LEN]! * refLen[i]!;
  for (let i = 1; i < n; i++) {
    const p = parent[i]!;
    if (axial[p] && !hasAxialChild[p] && partMods[i]!.kind === KIND.SEGMENT && dv[i] === 0 && attachPos[i]! >= 0.75
      && Math.abs(angle[i]!) <= 45 * DEG) { axial[i] = 1; hasAxialChild[p] = 1; }
  }
  const cumStart = SF.cumStart;
  let total = 0;
  for (let i = 0; i < n; i++) if (axial[i]) { cumStart[i] = total; total += relLen[i]!; }
  if (total <= 0) total = 1;
  const ap = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (axial[i]) ap[i] = (cumStart[i]! + 0.5 * relLen[i]!) / total;
    else {
      const p = parent[i]!;
      ap[i] = axial[p] ? (cumStart[p]! + attachPos[i]! * relLen[p]!) / total : ap[p]!;
    }
  }
  // regulation on AP, DV and DEPTH_AT_BIRTH now; MATURITY later
  const expressed = new Uint8Array(n).fill(1);
  const maturityRegs: RegGene[] = [];
  for (const r of g.regs) {
    if (!isEnabledReg(r)) continue;
    if (r.axis === REG_AXIS.MATURITY) { maturityRegs.push(r); continue; }
    for (let i = 0; i < n; i++) {
      if (!targets(r, partMods[i]!)) continue;
      const t = r.axis === REG_AXIS.AP ? ap[i]! : r.axis === REG_AXIS.DV ? (dv[i]! + 1) / 2 : env.depth01;
      applyReg(r, t, params, i * NP, expressed, i);
    }
  }
  return {
    g, n, mods: partMods, parent: parent.slice(0, n), attachPos: attachPos.slice(0, n), angle: angle.slice(0, n),
    mirror: mirror.slice(0, n), dv: dv.slice(0, n), phase: phase.slice(0, n), refLen: refLen.slice(0, n),
    pathHash: pathHash.slice(0, n), stepLink: stepLink.slice(0, n), stepCode: stepCode.slice(0, n), axial, ap, params, expressed, maturityRegs, env, opts, traitValues: traitValues(g, opts.lCeilingM),
    trigKey: new Float64Array(n).fill(NaN), trigCos: new Float64Array(n), trigSin: new Float64Array(n),
  };
}

/** Trait values used by finish(), decoded once per unfold. */
export interface TraitValues {
  gSlender: number; gFin: number; gEye: number; gMouth: number; gSpike: number; gArm: number; gTaper: number;
  gStiff: number; gPhoto: number; gGut: number; gLimb: number; adultLength: number; birthLength: number;
  damping: number; bodyHue: number; shell: number; sigmaMus: number;
}
function traitValues(g: Genome, lCeilingM: number): TraitValues {
  const La = adultLength(g, lCeilingM);
  return {
    gSlender: trait(g, TI.G_SLENDERNESS), gFin: trait(g, TI.G_FIN), gEye: trait(g, TI.G_EYE), gMouth: trait(g, TI.G_MOUTH),
    gSpike: trait(g, TI.G_SPIKE), gArm: trait(g, TI.G_ARMOUR), gTaper: trait(g, TI.G_TAPER), gStiff: trait(g, TI.G_STIFFNESS),
    gPhoto: trait(g, TI.G_PHOTOPHORE), gGut: trait(g, TI.G_GUT), gLimb: trait(g, TI.G_LIMB_LENGTH), adultLength: La,
    birthLength: trait(g, TI.BIRTH_FRACTION) * La, damping: trait(g, TI.JOINT_DAMPING), bodyHue: trait(g, TI.BODY_HUE),
    shell: trait(g, TI.SHELL), sigmaMus: trait(g, TI.MUSCLE_STRENGTH),
  };
}

/** Expressed adult length after the ceiling clamp (CONTRACT 3.3). */
export function adultLength(g: Genome, lCeilingM: number): number {
  const L = trait(g, TI.ADULT_LENGTH);
  return (g.flags & GENOME_FLAG_LEVIATHAN) !== 0 ? L : Math.min(L, lCeilingM);
}

/** Current body length at maturity m: L0 + m (L_adult - L0), L0 = BIRTH_FRACTION x L_adult. */
export function lengthAtMaturity(g: Genome, m: number, lCeilingM: number): number {
  const La = adultLength(g, lCeilingM);
  const L0 = trait(g, TI.BIRTH_FRACTION) * La;
  const mm = m < 0 ? 0 : m > 1 ? 1 : m;
  return L0 + mm * (La - L0);
}

const ORGAN_OF_KIND: readonly (OrganKind | null)[] = [
  null, null, null, 'mouth', 'eye', 'chemo', null, 'photophore', 'cilia', 'jet', 'bladder', 'gland',
];
const ORGAN_FLAG_OF_KIND: readonly number[] = [
  0, 0, 0, ORGAN.MOUTH, ORGAN.EYE, ORGAN.CHEMO, 0, ORGAN.PHOTOPHORE, ORGAN.CILIA, ORGAN.JET, ORGAN.BLADDER, ORGAN.GLAND,
];

/** Decoded p1..p5 per kind (CONTRACT 6.4 table). x values in 0..1; bit fields as integers. */
export function decodeKindParams(kind: number, x: ArrayLike<number>, out: Float32Array | Float64Array | number[], o: number): void {
  const b = (v: number): number => Math.round(v * 255);
  const p1 = x[0]!, p2 = x[1]!, p3 = x[2]!, p4 = x[3]!, p5 = x[4]!;
  let a = p1, c = p2, d = p3, e = p4, f = p5;
  switch (kind) {
    case KIND.MOUTH: a = p1 * 2; c = p2; d = 0.1 * exp(p3 * 3.912023005428146); e = p4; f = p5; break; // gape x head width; cooldown 0.1..5 s
    case KIND.EYE: a = p1; c = 10 + p2 * 350; d = 1 + Math.round(p3 * 15); e = b(p4); f = p5; break;
    case KIND.CHEMO: a = p1; c = b(p2); d = b(p3); break;
    case KIND.PHOTOPHORE: a = p1; c = 0.25 * exp(p2 * 2.772588722239781); break; // pulse multiplier 0.25..4
    case KIND.JET: a = p1 * 0.3; break;
    default: break;
  }
  out[o] = a; out[o + 1] = c; out[o + 2] = d; out[o + 3] = e; out[o + 4] = f;
}

function capsuleVolume(r: number, l: number): number { return 3.141592653589793 * r * r * l + 4.1887902047863905 * r * r * r; }
function density(lip: number, arm: number): number { return (1 - lip - arm) * 1060 + lip * 920 + arm * 2000; }

/** Stage 2: maturity regulation, gating, size, absorption, cap and the derived quantities. */
export function finish(u: Unfolded, maturity: number): Phenotype {
  const { g, n, mods, parent, opts } = u;
  const m = maturity < 0 ? 0 : maturity > 1 ? 1 : maturity;
  const maxParts = Math.max(1, Math.min(MAX_PARTS, opts.maxParts || MAX_PARTS));
  const params = SF.params; params.set(u.params);
  const expressed = SF.expressed; expressed.set(u.expressed);
  for (const r of u.maturityRegs) for (let i = 0; i < n; i++) if (targets(r, mods[i]!)) applyReg(r, m, params, i * NP, expressed, i);
  // gating: a part survives if expressed and its parent survives; the root always survives
  const keep = SF.keep;
  for (let i = 0; i < n; i++) keep[i] = i === 0 ? 1 : expressed[i]! && keep[parent[i]!]! ? 1 : 0;
  // global modifiers
  const tv = u.traitValues;
  const gSlender = tv.gSlender, gFin = tv.gFin, gEye = tv.gEye, gMouth = tv.gMouth, gSpike = tv.gSpike, gArm = tv.gArm;
  const gTaper = tv.gTaper, gStiff = tv.gStiff, gPhoto = tv.gPhoto, gGutT = tv.gGut, gLimb = tv.gLimb;
  const La = tv.adultLength;
  const L = tv.birthLength + m * (La - tv.birthLength);
  const ratio = La > 0 ? L / La : 1;
  const len = SF.len, wid = SF.wid;
  let chain = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const o = i * NP;
    const k = mods[i]!.kind;
    let l = params[o + P_LEN]! * u.refLen[i]!;
    let w = params[o + P_WID]! / gSlender;
    if (k === KIND.FIN) { l *= gFin; }
    else if (k === KIND.EYE) { l *= gEye; params[o + P_P1] = Math.min(1, params[o + P_P1]! * gEye); }
    else if (k === KIND.MOUTH) { l *= gMouth; params[o + P_P1] = Math.min(1, params[o + P_P1]! * gMouth); }
    else if (k === KIND.SPIKE) { l *= gSpike; }
    else if (k === KIND.PHOTOPHORE) { l *= gPhoto; params[o + P_P1] = Math.min(1, params[o + P_P1]! * gPhoto); }
    else if (k === KIND.LIMB) { l *= gLimb; }
    if (u.axial[i] && gTaper !== 1) w *= powr(gTaper, -u.ap[i]!);
    params[o + P_ARMOUR] = Math.min(1, params[o + P_ARMOUR]! * gArm);
    params[o + P_GUT] = Math.min(0.7, params[o + P_GUT]! * gGutT);
    // relative allometry: l_i = l_i,adult (L / L_adult)^alpha_i, so relative to L the factor is ^(alpha - 1)
    const alpha = params[o + P_ALPHA]!;
    if (alpha !== 1 && ratio !== 1) l *= powr(ratio, alpha - 1);
    len[i] = l;
    wid[i] = w * l;
    if (u.axial[i]) chain += l;
  }
  const K = chain > 0 ? L / chain : L;
  for (let i = 0; i < n; i++) { len[i]! *= K; wid[i]! *= K; }
  // absorption of small sensory organs; children of an absorbed part are dropped
  const absorbed = SF.absorbed; absorbed.fill(0, 0, n);
  const host = SF.host; host.fill(-1, 0, n);
  for (let i = 1; i < n; i++) {
    if (!keep[i]) continue;
    const p = parent[i]!;
    if (absorbed[p]) { keep[i] = 0; continue; }
    const k = mods[i]!.kind;
    if ((k === KIND.EYE || k === KIND.CHEMO || k === KIND.PHOTOPHORE) && len[i]! < ABSORB_FRACTION * L) {
      absorbed[i] = 1; host[i] = p;
    }
  }
  // part cap in BFS order (absorbed organs do not occupy a part)
  const newIdx = SF.newIdx; newIdx.fill(-1, 0, n);
  let np = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    if (i > 0 && !keep[parent[i]!]) { keep[i] = 0; continue; }
    if (absorbed[i]) { if (newIdx[host[i]!]! < 0) keep[i] = 0; continue; }
    if (np >= maxParts) { keep[i] = 0; continue; }
    newIdx[i] = np++;
  }
  // allocate the phenotype
  // one buffer for every per-part array: 25 f32, 2 u32, 2 x 16-bit and 3 x 8-bit lanes per part
  const buf = new ArrayBuffer(np * 115);
  let off = 0;
  const f32 = (k = 1): Float32Array => { const a = new Float32Array(buf, off, np * k); off += 4 * np * k; return a; };
  const ph: Phenotype = {
    nParts: np,
    attachU: f32(), restAngle: f32(), limitLo: f32(), limitHi: f32(), length: f32(), radius: f32(), span: f32(), taper: f32(),
    muscleFrac: f32(), lipidFrac: f32(), armour: f32(), youngsE: f32(), damping: f32(), u: f32(), v: f32(), d: f32(),
    cpgPhase: f32(), cpgAmp: f32(), glow: f32(), hue: f32(), params: f32(5),
    moduleInnov: new Uint32Array(buf, 100 * np, np), pathHash: new Uint32Array(buf, 104 * np, np),
    parent: new Int16Array(buf, 108 * np, np), organs: new Uint16Array(buf, 110 * np, np),
    kind: new Uint8Array(buf, 112 * np, np), subtype: new Uint8Array(buf, 113 * np, np), dv: new Int8Array(buf, 114 * np, np),
    lengthM: L, adultLengthM: La, maturity: m, massKg: 0, gutVolume: 0, gGut: 0,
    mouth: { filter: 0, scrape: 0, bite: 0, suction: 0, latch: 0, gape: 0, biteForce: 0, mesh: 0 },
    handlingSize: 0, buildCostKg: 0, organList: [],
  };
  const damping = tv.damping, bodyHue = tv.bodyHue, shell = tv.shell, sigmaMus = tv.sigmaMus;
  const minLen = MIN_LENGTH_FRACTION * L, minR = MIN_RADIUS_FRACTION * L;
  const mass = SF.mass;
  // rest-pose layout (heading 0, mirror +1): x forward, y down; dorsal is -y
  const { px, py, phi, cumBase, cphi, sphi, kp } = SF;
  const appRoot = SF.appRoot; appRoot.fill(-1, 0, n);
  const xp = new Float64Array(5);
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const o = i * NP;
    const mod = mods[i]!;
    const p = i === 0 ? -1 : parent[i]!;
    let l = len[i]!;
    let r = 0.5 * wid[i]!;
    if (!absorbed[i]) { if (l < minLen) l = minLen; if (r < minR) r = minR; }
    const rest = i === 0 ? 0 : wrapAngle(u.angle[i]! + u.mirror[i]! * params[o + P_REST]!);
    // layout
    if (p < 0) { phi[i] = 0; px[i] = 0; py[i] = 0; cphi[i] = 1; sphi[i] = 0; }
    else {
      phi[i] = phi[p]! + rest;
      // trig of the rest angle is cached on the unfolded body, so a restage computes none
      if (u.trigKey[i] !== rest) { u.trigKey[i] = rest; u.trigCos[i] = cos(rest); u.trigSin[i] = sin(rest); }
      const cr = u.trigCos[i]!, sr = u.trigSin[i]!;
      cphi[i] = cphi[p]! * cr - sphi[p]! * sr; sphi[i] = sphi[p]! * cr + cphi[p]! * sr;
      const au = 0.5 - u.attachPos[i]!;
      const jx = px[p]! + au * len[p]! * cphi[p]!, jy = py[p]! + au * len[p]! * sphi[p]!;
      px[i] = jx - 0.5 * l * cphi[i]!; py[i] = jy - 0.5 * l * sphi[i]!;
      if (!u.axial[i]) {
        if (u.axial[p]) { appRoot[i] = i; cumBase[i] = 0; }
        else { appRoot[i] = appRoot[p]!; cumBase[i] = cumBase[p]! + len[p]!; }
      }
    }
    len[i] = l;
    for (let q = 0; q < 5; q++) xp[q] = params[o + (q === 0 ? P_P1 : q === 1 ? P_P2 : q === 2 ? P_P3 : q === 3 ? P_P4 : P_P5)]!;
    decodeKindParams(mod.kind, xp, kp, i * 5);
    if (absorbed[i]) continue;
    const j = newIdx[i]!;
    const lip = params[o + P_LIPID]!, arm = params[o + P_ARMOUR]!;
    let span = params[o + P_SPAN]! * 2 * r;
    if ((mod.flags & MODULE_FLAG.PAIRED) !== 0) span *= 2;
    const isFin = mod.kind === KIND.FIN;
    let mk = density(lip, arm) * (isFin ? l * span * 2 * r : capsuleVolume(r, l));
    // mass-ratio clamp against the parent (01 §1.11.2): thicken a too-light child
    if (p >= 0) {
      const mp = mass[newIdx[p]!]!;
      if (mk > 0 && mk * MAX_MASS_RATIO < mp) {
        const f = mp / (MAX_MASS_RATIO * mk);
        if (isFin) r *= f; else r *= Math.sqrt(f);
        mk = density(lip, arm) * (isFin ? l * span * 2 * r : capsuleVolume(r, l));
        if (!isFin) span = params[o + P_SPAN]! * 2 * r * ((mod.flags & MODULE_FLAG.PAIRED) !== 0 ? 2 : 1);
      }
    }
    mass[j] = mk;
    ph.parent[j] = p < 0 ? -1 : newIdx[p]!;
    ph.kind[j] = mod.kind; ph.subtype[j] = mod.subtype; ph.moduleInnov[j] = mod.innov; ph.pathHash[j] = u.pathHash[i]!;
    ph.dv[j] = u.dv[i]!;
    ph.attachU[j] = p < 0 ? 0 : 0.5 - u.attachPos[i]!;
    ph.restAngle[j] = rest;
    const half = 0.5 * params[o + P_RANGE]!;
    ph.limitLo[j] = rest - half; ph.limitHi[j] = rest + half;
    ph.length[j] = l; ph.radius[j] = r; ph.span[j] = span; ph.taper[j] = params[o + P_TAPER]!;
    ph.muscleFrac[j] = params[o + P_MUSCLE]!; ph.lipidFrac[j] = lip; ph.armour[j] = arm;
    ph.youngsE[j] = E_BASE_PA * params[o + P_STIFF]! * gStiff;
    ph.damping[j] = damping;
    let cp = (params[o + P_PHASE]! + u.phase[i]!) % TAU_; if (cp < 0) cp += TAU_;
    ph.cpgPhase[j] = cp; ph.cpgAmp[j] = params[o + P_AMP]!;
    ph.glow[j] = params[o + P_GLOW]!;
    let hue = (bodyHue + hueOffsetOf(mod.hueOffset)) % 1; if (hue < 0) hue += 1;
    ph.hue[j] = hue;
    for (let q = 0; q < 5; q++) ph.params[j * 5 + q] = kp[i * 5 + q]!;
  }
  // body-frame coordinates and appendage extents
  const snoutX = n > 0 ? 0.5 * len[0]! : 0;
  const tipMax = SF.tipMax; tipMax.fill(0, 0, n);
  for (let i = 0; i < n; i++) if (keep[i] && appRoot[i]! >= 0) {
    const a = appRoot[i]!; const t = cumBase[i]! + len[i]!; if (t > tipMax[a]!) tipMax[a] = t;
  }
  const { uu, vv, dd } = SF;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const uRaw = L > 0 ? (snoutX - px[i]!) / L : 0;
    uu[i] = uRaw < 0 ? 0 : uRaw > 1 ? 1 : uRaw;
    const v = L > 0 ? -py[i]! / (0.25 * L) : 0;
    vv[i] = v < -1 ? -1 : v > 1 ? 1 : v;
    const a = appRoot[i]!;
    dd[i] = a >= 0 && tipMax[a]! > 0 ? (cumBase[i]! + 0.5 * len[i]!) / tipMax[a]! : 0;
    if (!absorbed[i]) { const j = newIdx[i]!; ph.u[j] = uu[i]!; ph.v[j] = vv[i]!; ph.d[j] = dd[i]!; }
  }
  // organs and derived quantities
  const organList: { s: OrganSpec; seq: number }[] = [];
  let seq = 0;
  const addOrgan = (kind: OrganKind, part: number, i: number, prm: number[]): void => {
    organList.push({ s: { kind, part, u: uu[i]!, v: vv[i]!, d: dd[i]!, params: prm }, seq: seq++ });
  };
  let massKg = 0, gutVol = 0, gutLen = 0, build = 0, bodyW = 0, spikeL = 0;
  const mouth: MouthDescriptor = ph.mouth;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const mod = mods[i]!;
    const o = i * NP;
    const prm = [kp[i * 5]!, kp[i * 5 + 1]!, kp[i * 5 + 2]!, kp[i * 5 + 3]!, kp[i * 5 + 4]!];
    xp[0] = params[o + P_P1]!; xp[1] = params[o + P_P2]!;
    const j = absorbed[i] ? newIdx[host[i]!]! : newIdx[i]!;
    let flags = ORGAN_FLAG_OF_KIND[mod.kind] ?? 0;
    const ok = ORGAN_OF_KIND[mod.kind];
    if (ok) addOrgan(ok, j, i, prm);
    if (absorbed[i]) { ph.organs[j]! |= flags; continue; }
    if ((mod.flags & MODULE_FLAG.PAIRED) !== 0) flags |= ORGAN.PAIRED;
    if (params[o + P_PHOTO]! > 0) flags |= ORGAN.PHOTOSYNTH;
    if (mod.kind === KIND.LIMB && (mod.flags & MODULE_FLAG.CLAW) !== 0) { flags |= ORGAN.CLAW; addOrgan('claw', j, i, prm); }
    if (mod.kind === KIND.SEGMENT) {
      if (i === 0 || mod.subtype === SEGMENT_SUBTYPE.HEAD) { flags |= ORGAN.HEAD; addOrgan('head', j, i, prm); }
      if (params[o + P_GUT]! > 0) { flags |= ORGAN.GUT; addOrgan('gut', j, i, prm); }
      if (xp[0]! > 0) { flags |= ORGAN.LATERAL_LINE; addOrgan('lateral', j, i, prm); }
      if (xp[1]! > 0) { flags |= ORGAN.TOUCH; addOrgan('touch', j, i, prm); }
      if (u.axial[i] && shell > 0) flags |= ORGAN.SHELL;
    }
    ph.organs[j]! |= flags;
    const mk = mass[j]!;
    massKg += mk;
    const r = ph.radius[j]!, l = ph.length[j]!, arm = ph.armour[j]!;
    build += mk * ((1 - arm) * (mod.kind === KIND.EYE ? C_G_NEURAL : C_G) + arm * C_G_ARMOUR);
    if (mod.kind === KIND.SEGMENT) {
      const gf = params[o + P_GUT]!;
      gutVol += gf * capsuleVolume(r, l);
      if (u.axial[i] && gf > 0) gutLen += l * (gf / 0.7);
    }
    if (u.axial[i] && 2 * r > bodyW) bodyW = 2 * r;
    if (mod.kind === KIND.SPIKE && l > spikeL) spikeL = l;
    if (mod.kind === KIND.MOUTH) {
      const hp = ph.parent[j]! >= 0 ? ph.parent[j]! : j;
      const headW = 2 * ph.radius[hp]!;
      const gape = prm[0]! * headW;
      if (gape > mouth.gape) mouth.gape = gape;
      switch (mod.subtype) {
        case 0: mouth.filter = 1; { const mesh = gape * 0.001 * exp((1 - prm[1]!) * 4.605170185988092); if (mouth.mesh === 0 || mesh < mouth.mesh) mouth.mesh = mesh; } break;
        case 1: {
          mouth.bite = 1;
          const bf = sigmaMus * ph.muscleFrac[hp]! * 3.141592653589793 * ph.radius[hp]! * ph.radius[hp]!;
          if (bf > mouth.biteForce) mouth.biteForce = bf;
          break;
        }
        case 2: mouth.scrape = 1; break;
        case 3: mouth.latch = Math.max(mouth.latch, 0.5 + 0.5 * prm[3]!); mouth.scrape = Math.max(mouth.scrape, 0.3); break;
        default: mouth.suction = 1; mouth.latch = Math.max(mouth.latch, 0.5 * prm[3]!); break;
      }
    }
  }
  organList.sort((a, b) => a.s.part - b.s.part || a.seq - b.seq);
  ph.organList = organList.map((e) => e.s);
  ph.massKg = massKg;
  ph.gutVolume = gutVol;
  ph.gGut = L > 0 ? Math.min(1, gutLen / L) : 0;
  ph.handlingSize = bodyW + 2 * spikeL;
  ph.buildCostKg = build;
  if (opts.editorPaths) {
    // instance paths for the part editor (01 §1.10.2): root-to-part list of (link, copy, side)
    const paths: EditorStep[][] = new Array(np);
    for (let i = 0; i < n; i++) {
      if (!keep[i] || absorbed[i]) continue;
      const steps: EditorStep[] = [];
      for (let k = i; k > 0; k = parent[k]!) {
        const c = u.stepCode[k]!;
        steps.push({ link: u.stepLink[k]!, copy: c & 0xff, side: (c >> 8) === 1 ? 1 : (c >> 8) === 2 ? -1 : 0, radial: (c >> 8) === 3 });
      }
      paths[newIdx[i]!] = steps.reverse();
    }
    (ph as PhenotypeWithPaths).paths = paths;
  }
  return ph;
}

/** One step of an instance path: the link gene, the copy index and the mirror side (+1 dorsal, -1 ventral). */
export interface EditorStep { link: number; copy: number; side: number; radial: boolean }
/** develop() with `editorPaths` adds the instance path of every part (designer only, not in the sim). */
export type PhenotypeWithPaths = Phenotype & { paths?: EditorStep[][] };

/** develop(genome, maturity, env, opts) (CONTRACT 7). Pure and deterministic. */
export function develop(g: Genome, maturity: number, env: BirthEnv, opts: DevelopOptions): Phenotype {
  return finish(unfold(g, env, opts), maturity);
}

/**
 * A growth restage (01 §1.4.1): reuses the unfolded body when the genome, env and options are
 * the same, so only the scale pass runs. MATURITY-axis genes are still applied exactly, so the
 * result always equals a full develop at the same maturity.
 */
export class Restager {
  private cache: Unfolded | null = null;
  phenotype(g: Genome, maturity: number, env: BirthEnv, opts: DevelopOptions): Phenotype {
    const c = this.cache;
    if (!c || c.g !== g || c.env.depth01 !== env.depth01 || c.env.tempC !== env.tempC
      || c.opts.maxParts !== opts.maxParts || c.opts.lCeilingM !== opts.lCeilingM) this.cache = unfold(g, env, opts);
    return finish(this.cache!, maturity);
  }
}
