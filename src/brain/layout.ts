/**
 * The canonical I/O channel layout and neuron list (CONTRACT 8.1, 8.2). Pure and deterministic:
 * the same Phenotype and Genome always give the same channels, keys, coordinates and class.
 *
 * Besides the contract's BrainLayout this builds the substrate data development needs: body
 * coordinates (u, v, d) and a substrate type for every input and neuron (03 §3.3.1, used by the
 * CPPN), module and instance keys (CONTRACT 6.7, used by DSYN genes), and sense descriptors.
 */
import {
  BRAIN_CLASSES, KIND, NEURON_KIND, ORGAN, PART_KIND_BASE, hash32,
  type BrainLayout, type Genome, type IOChannel, type OrganSpec, type Phenotype,
} from '../core/index.js';
import { decodeBrainTraits, type BrainTraitValues } from './traits.js';

// ---------------- channel kind codes ----------------
export const IN = {
  BIAS: 0, ENERGY: 1, GUT: 2, HEALTH: 3, PAIN: 4, AGE: 5, MATURE: 6, REPRO_LOAD: 7, TEMPERATURE: 8,
  DEPTH: 9, LIGHT: 10, SPEED: 11, DAY_SIN: 12, DAY_COS: 13, SEASON_SIN: 14, SEASON_COS: 15, FATIGUE: 16,
  ITCH: 17,
  EYE: PART_KIND_BASE + 0, LATERAL: PART_KIND_BASE + 1, TOUCH: PART_KIND_BASE + 2,
  CHEMO_LEVEL: PART_KIND_BASE + 3, CHEMO_RATE: PART_KIND_BASE + 4, TASTE_NUTRITION: PART_KIND_BASE + 5,
  TASTE_TOXIN: PART_KIND_BASE + 6, HOLDING: PART_KIND_BASE + 7, PROPRIO: PART_KIND_BASE + 8,
  GLAND_FULL: PART_KIND_BASE + 9,
} as const;
export const N_GLOBAL_IN = 18;
export const OUT = {
  CPG_FREQ: 0, CPG_AMP: 1, CPG_TURN: 2, MATE: 3, LAY_BUD: 4, EMIT_INTENSITY: 5, EMIT_HUE: 6, ROLL: 7,
  MUSCLE: PART_KIND_BASE + 0, FIN_PITCH: PART_KIND_BASE + 1, MOUTH_OPEN: PART_KIND_BASE + 2,
  BITE: PART_KIND_BASE + 3, LATCH: PART_KIND_BASE + 4, PHOTO_INTENSITY: PART_KIND_BASE + 5,
  CILIA_DRIVE: PART_KIND_BASE + 6, JET_DRIVE: PART_KIND_BASE + 7, BLADDER_DRIVE: PART_KIND_BASE + 8,
  GLAND_RELEASE: PART_KIND_BASE + 9, GRIP: PART_KIND_BASE + 10,
} as const;
export const N_GLOBAL_OUT = 8;

/** Substrate types for the CPPN (03 §3.3.1), one-hot encoded in queries. */
export const STYPE = {
  EYE: 0, LATERAL: 1, CHEMO: 2, TOUCH_TASTE: 3, INTERNAL: 4, CLOCK: 5, DRIVE: 6, OSCILLATOR: 7,
  GANGLION: 8, HEAD_HIDDEN: 9, MUSCLE_MOTOR: 10, ACTION_MOTOR: 11,
} as const;
export const N_STYPE = 12;

/** Drive order (CONTRACT 8.1). */
export const DRIVE = { HUNGER: 0, FEAR: 1, LIBIDO: 2, FATIGUE: 3, AGGRESSION: 4, SOCIALITY: 5 } as const;
export const MOD = { PLEASURE: 0, PAIN: 1 } as const;

// Key slot namespaces (the third word of hash32). Inputs, outputs and other neurons never collide.
const KEY_IN = 0x00000;
const KEY_OUT = 0x10000;
const KEY_DRIVE = 0x20000;
const KEY_MOD = 0x20100;
const KEY_HEAD = 0x20200;
const KEY_OSC = 0x30000;
const KEY_GANG = 0x30100;
/** The contract's key for a DNEU hidden neuron: hash32(innov, 0, 0xFF). */
export function hiddenGeneKey(innov: number): number { return hash32(innov, 0, 0xff); }
export function inputSlotCode(kind: number, slot: number): number { return KEY_IN | (kind << 10) | slot; }
export function outputSlotCode(kind: number, slot: number): number { return KEY_OUT | (kind << 8) | slot; }
export const NEURON_SLOT = { DRIVE: KEY_DRIVE, MOD: KEY_MOD, HEAD: KEY_HEAD, OSC: KEY_OSC, GANG: KEY_GANG } as const;

export interface EyeDesc {
  part: number;
  /** First input index of this eye. */
  base: number;
  receptors: number;
  /** Colour bands sensed, in order blue, green, red: band index per lane. */
  bands: number[];
  /** Sensitivity per band (0..1). */
  sens: number[];
  fovRad: number;
  /** Mount angle relative to the body axis, rad (from the eye's v). */
  mount: number;
  /** Range in body lengths. */
  rangeBL: number;
}
export interface ChemoDesc { part: number; base: number; channels: number[] }

/** The contract layout plus substrate data for development and sensing. */
export interface FullLayout extends BrainLayout {
  nIn: number;
  /** Per input: coordinates and substrate type, module key (pathHash 0) and instance key. */
  inU: Float32Array; inV: Float32Array; inD: Float32Array; inType: Uint8Array;
  inModKey: Uint32Array;
  /** Per neuron: part (-1 global), coordinates, substrate type, module key. neuronKey is the instance key. */
  neuPart: Int16Array;
  neuU: Float32Array; neuV: Float32Array; neuD: Float32Array; neuType: Uint8Array;
  neuModKey: Uint32Array;
  /** First neuron index of each group. */
  base: { motor: number; drive: number; mod: number; osc: number; head: number; gang: number; direct: number };
  count: { motor: number; osc: number; head: number; gang: number; direct: number };
  /** Oscillator neuron -> part. */
  oscPart: Int16Array;
  /** Part -> its oscillator neuron, or -1. */
  partOsc: Int16Array;
  /** Direct hidden neuron gene innovs in neuron order. */
  directInnov: number[];
  eyes: EyeDesc[];
  chemos: ChemoDesc[];
  /** What trimming did, for the inspector (empty when nothing was trimmed). */
  trims: string[];
  /** Whether any input needs the neighbour list (eyes or lateral line). */
  needsNeighbours: boolean;
  traits: BrainTraitValues;
}

interface TrimState { headHidden: number; gangKeep: number; eyeShift: number; oscKeep: number; partInKeep: number; partOutKeep: number }

function clampInt(x: number, lo: number, hi: number): number {
  const r = Math.round(x);
  return r < lo ? lo : r > hi ? hi : r;
}

function organsOn(ph: Phenotype, part: number, kind: OrganSpec['kind']): OrganSpec[] {
  const r: OrganSpec[] = [];
  for (const o of ph.organList) if (o.part === part && o.kind === kind) r.push(o);
  return r;
}

function eyeShape(o: OrganSpec, eyeShift: number): { receptors: number; bands: number[]; sens: number[]; fovRad: number; rangeBL: number } {
  const p = o.params;
  const fovDeg = Math.max(10, Math.min(360, p[1] ?? 120));
  let receptors = clampInt(p[2] ?? 4, 1, 16);
  for (let i = 0; i < eyeShift; i++) receptors = Math.max(1, (receptors + 1) >> 1);
  const spec = clampInt(p[3] ?? 0, 0, 255);
  const blue = spec & 7, green = (spec >> 3) & 7, red = (spec >> 6) & 3;
  const bands: number[] = [];
  const sens: number[] = [];
  if (blue > 0) { bands.push(0); sens.push(blue / 7); }
  if (green > 0) { bands.push(1); sens.push(green / 7); }
  if (red > 0) { bands.push(2); sens.push(red / 3); }
  if (bands.length === 0) { bands.push(0); sens.push(1); }
  const ac = p[4] ?? 0.5;
  const acuity = ac > 1 ? ac / 255 : ac;
  return { receptors, bands, sens, fovRad: (fovDeg * Math.PI) / 180, rangeBL: 2 + 38 * acuity };
}

function chemoChannels(o: OrganSpec): number[] {
  const mask = clampInt(o.params[1] ?? 1, 0, 255) || 1;
  const r: number[] = [];
  for (let c = 0; c < 8; c++) if (mask & (1 << c)) r.push(c);
  return r;
}

function isMusclePart(ph: Phenotype, p: number): boolean {
  return ph.parent[p]! >= 0 && (ph.muscleFrac[p]! > 0 || ph.kind[p] === KIND.FIN);
}
function hasJoint(ph: Phenotype, p: number): boolean {
  return ph.parent[p]! >= 0 && ph.limitHi[p]! > ph.limitLo[p]!;
}

/** The single organ-drive output a part carries, or -1 (CONTRACT 8.1: exactly one, in this order). */
export function organOutput(ph: Phenotype, p: number): number {
  const o = ph.organs[p]!;
  const k = ph.kind[p]!;
  if ((o & ORGAN.PHOTOPHORE) || k === KIND.PHOTOPHORE) return OUT.PHOTO_INTENSITY;
  if ((o & ORGAN.CILIA) || k === KIND.CILIA) return OUT.CILIA_DRIVE;
  if ((o & ORGAN.JET) || k === KIND.JET) return OUT.JET_DRIVE;
  if ((o & ORGAN.BLADDER) || k === KIND.BLADDER) return OUT.BLADDER_DRIVE;
  if ((o & ORGAN.GLAND) || k === KIND.GLAND) return OUT.GLAND_RELEASE;
  if (o & ORGAN.CLAW) return OUT.GRIP;
  return -1;
}

function build(ph: Phenotype, g: Genome, tv: BrainTraitValues, ts: TrimState): FullLayout {
  const root = g.rootModuleInnov >>> 0;
  const nP = ph.nParts;
  let rootPart = 0;
  for (let p = 0; p < nP; p++) if (ph.parent[p]! < 0) { rootPart = p; break; }
  const ru = ph.u[rootPart] ?? 0, rv = ph.v[rootPart] ?? 0, rd = ph.d[rootPart] ?? 0;

  // ---- inputs ----
  const inputs: IOChannel[] = [];
  const iu: number[] = [], iv: number[] = [], id: number[] = [], it: number[] = [], imk: number[] = [];
  const addIn = (kind: number, part: number, slot: number, u: number, v: number, d: number, st: number): void => {
    const mod = part < 0 ? root : ph.moduleInnov[part]! >>> 0;
    const path = part < 0 ? 0 : ph.pathHash[part]! >>> 0;
    const code = inputSlotCode(kind, slot);
    inputs.push({ kind, part, slot, key: hash32(mod, path, code) });
    iu.push(u); iv.push(v); id.push(d); it.push(st); imk.push(hash32(mod, 0, code));
  };
  for (let k = 0; k < N_GLOBAL_IN; k++) {
    const st = k === IN.BIAS || (k >= IN.DAY_SIN && k <= IN.SEASON_COS) ? STYPE.CLOCK : STYPE.INTERNAL;
    addIn(k, -1, 0, ru, rv, rd, st);
  }
  const eyes: EyeDesc[] = [];
  const chemos: ChemoDesc[] = [];
  // Parts beyond partInKeep (from the tail) lose their inputs in the last trimming stage.
  for (let p = 0; p < nP; p++) {
    const keepIn = p < ts.partInKeep;
    const pu = ph.u[p]!, pv = ph.v[p]!, pd = ph.d[p]!;
    const organs = ph.organs[p]!;
    if (keepIn) {
      let eyeSlot = 0;
      for (const o of organsOn(ph, p, 'eye')) {
        const sh = eyeShape(o, ts.eyeShift);
        const lanes = sh.bands.length + 1;
        const desc: EyeDesc = {
          part: p, base: inputs.length, receptors: sh.receptors, bands: sh.bands, sens: sh.sens, fovRad: sh.fovRad,
          mount: o.v * (Math.PI / 2), rangeBL: sh.rangeBL,
        };
        for (let r = 0; r < sh.receptors; r++) {
          // receptor r looks at bearing -fov/2 + (r + 0.5) fov / R; its d carries the bearing for the CPPN
          const bear = sh.receptors > 1 ? (r + 0.5) / sh.receptors - 0.5 : 0;
          for (let c = 0; c < lanes; c++) addIn(IN.EYE, p, eyeSlot++, o.u, o.v, bear, STYPE.EYE);
        }
        eyes.push(desc);
      }
      if (organs & ORGAN.LATERAL_LINE) {
        addIn(IN.LATERAL, p, 0, pu, Math.min(1, pv + 0.5), pd, STYPE.LATERAL);
        addIn(IN.LATERAL, p, 1, pu, Math.max(-1, pv - 0.5), pd, STYPE.LATERAL);
      }
      if (organs & ORGAN.TOUCH) {
        addIn(IN.TOUCH, p, 0, pu, Math.min(1, pv + 0.5), pd, STYPE.TOUCH_TASTE);
        addIn(IN.TOUCH, p, 1, pu, Math.max(-1, pv - 0.5), pd, STYPE.TOUCH_TASTE);
      }
      let chemoOrdinal = 0;
      for (const o of organsOn(ph, p, 'chemo')) {
        const chans = chemoChannels(o);
        const desc: ChemoDesc = { part: p, base: inputs.length, channels: chans };
        for (const c of chans) {
          addIn(IN.CHEMO_LEVEL, p, chemoOrdinal * 8 + c, o.u, o.v, o.d, STYPE.CHEMO);
          addIn(IN.CHEMO_RATE, p, chemoOrdinal * 8 + c, o.u, o.v, o.d, STYPE.CHEMO);
        }
        chemos.push(desc);
        chemoOrdinal++;
      }
      if (ph.kind[p] === KIND.MOUTH || (organs & ORGAN.MOUTH)) {
        addIn(IN.TASTE_NUTRITION, p, 0, pu, pv, pd, STYPE.TOUCH_TASTE);
        addIn(IN.TASTE_TOXIN, p, 0, pu, pv, pd, STYPE.TOUCH_TASTE);
        addIn(IN.HOLDING, p, 0, pu, pv, pd, STYPE.TOUCH_TASTE);
      }
      if (hasJoint(ph, p)) addIn(IN.PROPRIO, p, 0, pu, pv, pd, STYPE.INTERNAL);
      if ((organs & ORGAN.GLAND) || ph.kind[p] === KIND.GLAND) addIn(IN.GLAND_FULL, p, 0, pu, pv, pd, STYPE.INTERNAL);
    }
  }

  // ---- outputs (and motor neurons) ----
  const outputs: IOChannel[] = [];
  const nu: number[] = [], nv: number[] = [], nd: number[] = [], nt: number[] = [], npart: number[] = [];
  const nkind: number[] = [], nkey: number[] = [], nmk: number[] = [];
  const addNeuron = (kind: number, part: number, code: number, u: number, v: number, d: number, st: number, keyMod?: number): void => {
    const mod = keyMod ?? (part < 0 ? root : ph.moduleInnov[part]! >>> 0);
    const path = keyMod !== undefined || part < 0 ? 0 : ph.pathHash[part]! >>> 0;
    nkind.push(kind); npart.push(part); nu.push(u); nv.push(v); nd.push(d); nt.push(st);
    nkey.push(keyMod !== undefined ? hiddenGeneKey(keyMod) : hash32(mod, path, code));
    nmk.push(keyMod !== undefined ? hiddenGeneKey(keyMod) : hash32(mod, 0, code));
  };
  const addOut = (kind: number, part: number, slot: number): void => {
    const mod = part < 0 ? root : ph.moduleInnov[part]! >>> 0;
    const path = part < 0 ? 0 : ph.pathHash[part]! >>> 0;
    const code = outputSlotCode(kind, slot);
    outputs.push({ kind, part, slot, key: hash32(mod, path, code) });
    const st = kind === OUT.MUSCLE || kind === OUT.FIN_PITCH ? STYPE.MUSCLE_MOTOR : STYPE.ACTION_MOTOR;
    const pu = part < 0 ? ru : ph.u[part]!, pv = part < 0 ? rv : ph.v[part]!, pd = part < 0 ? rd : ph.d[part]!;
    addNeuron(NEURON_KIND.MOTOR, part, code, pu, pv, pd, st);
  };
  for (let k = 0; k < N_GLOBAL_OUT; k++) addOut(k, -1, 0);
  for (let p = 0; p < nP && p < ts.partOutKeep; p++) {
    if (isMusclePart(ph, p)) addOut(OUT.MUSCLE, p, 0);
    if (ph.kind[p] === KIND.FIN) addOut(OUT.FIN_PITCH, p, 0);
    if (ph.kind[p] === KIND.MOUTH) { addOut(OUT.MOUTH_OPEN, p, 0); addOut(OUT.BITE, p, 0); addOut(OUT.LATCH, p, 0); }
    const org = organOutput(ph, p);
    if (org >= 0) addOut(org, p, 0);
  }
  const nMotor = outputs.length;

  // ---- other neurons ----
  const driveBase = nkind.length;
  for (let j = 0; j < 6; j++) addNeuron(NEURON_KIND.DRIVE, -1, KEY_DRIVE + j, ru, rv, rd, STYPE.DRIVE);
  const modBase = nkind.length;
  for (let j = 0; j < 2; j++) addNeuron(NEURON_KIND.MODULATOR, -1, KEY_MOD + j, ru, rv, rd, STYPE.DRIVE);
  const oscBase = nkind.length;
  const oscPart: number[] = [];
  const partOsc = new Int16Array(nP).fill(-1);
  for (let p = 0; p < nP; p++) {
    const k = ph.kind[p];
    const want = (k === KIND.SEGMENT && tv.oscPerSegment) || (k === KIND.FIN && tv.oscPerFin);
    if (!want || oscPart.length >= ts.oscKeep) continue;
    partOsc[p] = nkind.length;
    oscPart.push(p);
    addNeuron(NEURON_KIND.OSCILLATOR, p, KEY_OSC, ph.u[p]!, ph.v[p]!, ph.d[p]!, STYPE.OSCILLATOR);
  }
  const headBase = nkind.length;
  for (let j = 0; j < ts.headHidden; j++) {
    // spread head hidden neurons over a small disc around the root so the CPPN can tell them apart
    const a = (j + 0.5) / Math.max(1, ts.headHidden);
    addNeuron(NEURON_KIND.HIDDEN_HEAD, -1, KEY_HEAD + j, ru, rv + (a - 0.5) * 0.5, a, STYPE.HEAD_HIDDEN);
  }
  const gangBase = nkind.length;
  let segOrdinal = 0;
  for (let p = 0; p < nP; p++) {
    if (ph.kind[p] !== KIND.SEGMENT) continue;
    if (segOrdinal++ >= ts.gangKeep) continue;
    for (let j = 0; j < tv.hiddenPerSegment; j++) {
      const a = (j + 0.5) / tv.hiddenPerSegment;
      addNeuron(NEURON_KIND.HIDDEN_GANGLION, p, KEY_GANG + j, ph.u[p]!, ph.v[p]!, a, STYPE.GANGLION);
    }
  }
  const directBase = nkind.length;
  const directInnov: number[] = [];
  const dneu = g.hiddenNeurons.filter((h) => (h.flags & 1) !== 0).sort((a, b) => a.innov - b.innov);
  for (const h of dneu) {
    directInnov.push(h.innov >>> 0);
    addNeuron(NEURON_KIND.HIDDEN_DIRECT, -1, 0, ru, rv, 0.5, STYPE.HEAD_HIDDEN, h.innov >>> 0);
  }
  const nNeurons = nkind.length;
  const nIn = inputs.length;
  const sc = sizeClassOf(nNeurons, nIn);
  return {
    inputs, outputs, nNeurons,
    neuronKind: Uint8Array.from(nkind), neuronKey: Uint32Array.from(nkey),
    sizeClass: (sc < 0 ? 4 : sc) as BrainLayout['sizeClass'],
    nIn,
    inU: Float32Array.from(iu), inV: Float32Array.from(iv), inD: Float32Array.from(id), inType: Uint8Array.from(it),
    inModKey: Uint32Array.from(imk),
    neuPart: Int16Array.from(npart), neuU: Float32Array.from(nu), neuV: Float32Array.from(nv), neuD: Float32Array.from(nd),
    neuType: Uint8Array.from(nt), neuModKey: Uint32Array.from(nmk),
    base: { motor: 0, drive: driveBase, mod: modBase, osc: oscBase, head: headBase, gang: gangBase, direct: directBase },
    count: { motor: nMotor, osc: oscPart.length, head: ts.headHidden, gang: directBase - gangBase, direct: directInnov.length },
    oscPart: Int16Array.from(oscPart), partOsc, directInnov, eyes, chemos, trims: [], traits: tv,
    needsNeighbours: eyes.length > 0 || inputs.some((c) => c.kind === IN.LATERAL),
  };
}

function sizeClassOf(n: number, i: number): number {
  for (let c = 0; c < BRAIN_CLASSES.length; c++) {
    const k = BRAIN_CLASSES[c]!;
    if (n <= k.n && i <= k.i) return c;
  }
  return -1;
}

/**
 * Build the layout, trimming deterministically when no class fits (CONTRACT 8.2): head hidden
 * beyond 64, ganglion hidden from the tail forward, then merging eye receptors pairwise. Three
 * further stages (not in the contract, needed only for pathological 64-part bodies) follow:
 * oscillators from the tail, then part inputs from the tail, then part outputs from the tail.
 */
export function buildLayout(ph: Phenotype, g: Genome, tvIn?: BrainTraitValues): FullLayout {
  const tv = tvIn ?? decodeBrainTraits(g);
  const nSeg = countKind(ph, KIND.SEGMENT);
  const ts: TrimState = {
    headHidden: Math.min(64, tv.headHidden), gangKeep: nSeg, eyeShift: 0, oscKeep: ph.nParts,
    partInKeep: ph.nParts, partOutKeep: ph.nParts,
  };
  const trims: string[] = [];
  if (tv.headHidden > 64) trims.push(`head hidden ${tv.headHidden} -> 64`);
  let L = build(ph, g, tv, ts);
  const maxN = BRAIN_CLASSES[BRAIN_CLASSES.length - 1]!.n, maxI = BRAIN_CLASSES[BRAIN_CLASSES.length - 1]!.i;
  const fitsN = (): boolean => L.nNeurons <= maxN;
  const fitsI = (): boolean => L.nIn <= maxI;
  // Neuron stages run only while N overflows and input stages only while I overflows, so an
  // input-heavy body keeps its ganglia. Each stage keeps the largest count that fits, by bisection.
  const shrink = (ok: () => boolean, get: () => number, set: (v: number) => void): void => {
    if (ok()) return;
    let best = 0;
    let a = 0, b = get() - 1;
    while (a <= b) {
      const mid = (a + b) >> 1;
      set(mid); L = build(ph, g, tv, ts);
      if (ok()) { best = mid; a = mid + 1; } else b = mid - 1;
    }
    set(best); L = build(ph, g, tv, ts);
  };
  if (tv.hiddenPerSegment > 0) shrink(fitsN, () => ts.gangKeep, (v) => { ts.gangKeep = v; });
  if (ts.gangKeep < nSeg) trims.push(`ganglia kept on ${ts.gangKeep} of ${nSeg} segments`);
  while (!fitsI() && ts.eyeShift < 4 && L.eyes.some((e) => e.receptors > 1)) { ts.eyeShift++; L = build(ph, g, tv, ts); }
  if (ts.eyeShift > 0) trims.push(`eye receptors merged pairwise ${ts.eyeShift}x`);
  if (!fitsN()) { ts.oscKeep = L.count.osc; shrink(fitsN, () => ts.oscKeep, (v) => { ts.oscKeep = v; }); }
  if (ts.oscKeep < ph.nParts) trims.push(`oscillators kept ${ts.oscKeep}`);
  shrink(fitsI, () => ts.partInKeep, (v) => { ts.partInKeep = v; });
  if (ts.partInKeep < ph.nParts) trims.push(`part inputs kept on ${ts.partInKeep} parts`);
  shrink(fitsN, () => ts.partOutKeep, (v) => { ts.partOutKeep = v; });
  if (ts.partOutKeep < ph.nParts) trims.push(`part outputs kept on ${ts.partOutKeep} parts`);
  L.trims = trims;
  return L;
}

function countKind(ph: Phenotype, kind: number): number {
  let n = 0;
  for (let p = 0; p < ph.nParts; p++) if (ph.kind[p] === kind) n++;
  return n;
}

/** Public contract shape. */
export function layout(ph: Phenotype, g: Genome): BrainLayout {
  const L = buildLayout(ph, g);
  return { inputs: L.inputs, outputs: L.outputs, nNeurons: L.nNeurons, neuronKind: L.neuronKind, neuronKey: L.neuronKey, sizeClass: L.sizeClass };
}

/** Module key of a neuron or input (pathHash 0): what a module-keyed DSYN gene names. */
export function moduleKey(moduleInnov: number, slotCode: number): number { return hash32(moduleInnov >>> 0, 0, slotCode); }
