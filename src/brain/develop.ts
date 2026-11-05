/**
 * Brain development: genome + layout -> a BrainSpec (per-neuron parameters and fixed-fan-in
 * synapse slots), ready to be written into a class pool (CONTRACT 5.3, 8.3).
 *
 * Slot order per neuron is fixed and canonical: innate reflexes and the innate gait first
 * (03 §3.8.2), then the CPPN's expressed links when ENCODING = 1 (LEO threshold, canonical source
 * order, never top-K by |w|: review R15), then DSYN genes sorted by (src, dst) as the codec
 * stores them. Unused slots are `src = own index, w = 0` (CONTRACT 8.2).
 */
import {
  BRAIN_CLASSES, DSYN_FLAG, KIND, exp, log, pow, q411ToFloat, type Draw, type Genome,
  type Phenotype,
} from '../core/index.js';
import { wireCppn } from './cppn.js';
import { DRIVE, IN, MOD, OUT, buildLayout, type FullLayout } from './layout.js';
import { decodeBrainTraits, type BrainTraitValues } from './traits.js';

export const W_MAX = 4;
/** Default time constants, seconds. */
export const TAU = { MOTOR: 0.02, EMIT: 0.5, TRIGGER: 0.1, MODULATOR: 0.2, HIDDEN: 0.1 } as const;

export interface BrainSpec {
  L: FullLayout;
  cls: number;
  K: number;
  theta: Float64Array;
  tau: Float64Array;
  phaseOff: Float64Array;
  /** Per neuron, slot lists (length <= K). Sources in the unified index space. */
  src: number[][];
  w: number[][];
  meta: number[][];
  /** Slots per neuron taken by reflexes and the innate gait. */
  nReflex: Uint8Array;
  /** nNeu x 4 x (srcNeuron, k, lag); srcNeuron -1 when unused. */
  osc: Float64Array;
  fLow: number;
  fHigh: number;
  /** Non-padding synapses and plastic synapses (CONTRACT 8.5). */
  nSyn: number;
  nPlastic: number;
  /** DSYN genes or CPPN links that found no free slot. */
  dropped: number;
  tv: BrainTraitValues;
}

export interface DevelopBrainOptions {
  /** DEVELOPMENT stream draw for individuality offsets (03 §3.7); none gives the genetic values. */
  draw?: Draw;
  /** Force an encoding (spike harness); default the genome's ENCODING. */
  encoding?: number;
}

function clamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }

/** Individuality: per-individual developmental noise on the personality genes (not inherited). */
function individualise(tv: BrainTraitValues, draw: Draw | undefined): BrainTraitValues {
  if (!draw || tv.individuality <= 0) return tv;
  const s = tv.individuality;
  const j = (v: number, lo: number, hi: number): number => clamp(v + draw.normal() * s * (hi - lo), lo, hi);
  return {
    ...tv,
    boldness: j(tv.boldness, -1, 1), activity: j(tv.activity, 0, 1), exploration: j(tv.exploration, 0, 0.3),
    sociality: j(tv.sociality, -1, 1), aggression: j(tv.aggression, -1, 1), appetite: j(tv.appetite, 0, 1),
    patience: j(tv.patience, 0, 1), chronotype: j(tv.chronotype, -1, 1), prefDepth: j(tv.prefDepth, 0, 1),
    riskAversion: j(tv.riskAversion, 0, 1), lightShow: j(tv.lightShow, 0, 1),
  };
}

/** Index lookups over a layout. */
export class LayoutIndex {
  private readonly inMap = new Map<string, number>();
  private readonly outMap = new Map<string, number>();
  constructor(readonly L: FullLayout) {
    L.inputs.forEach((c, i) => this.inMap.set(`${c.kind}:${c.part}:${c.slot}`, i));
    L.outputs.forEach((c, i) => this.outMap.set(`${c.kind}:${c.part}`, i));
  }
  input(kind: number, part = -1, slot = 0): number { return this.inMap.get(`${kind}:${part}:${slot}`) ?? -1; }
  /** First input of a kind (head-most part, since parts are in BFS order), or -1. */
  firstInput(kind: number, slot?: number): number {
    for (let i = 0; i < this.L.nIn; i++) {
      const c = this.L.inputs[i]!;
      if (c.kind === kind && (slot === undefined || c.slot === slot)) return i;
    }
    return -1;
  }
  /** Motor neuron of an output kind on a part (-1 for globals). */
  motor(kind: number, part = -1): number { return this.outMap.get(`${kind}:${part}`) ?? -1; }
  /** Unified source index of neuron n. */
  n(neuron: number): number { return this.L.nIn + neuron; }
}

/** Develop a brain from a genome and a grown body. Pure given (ph, g, draw). */
export function developBrain(ph: Phenotype, g: Genome, opts: DevelopBrainOptions = {}): BrainSpec {
  const tv0 = decodeBrainTraits(g);
  const L = buildLayout(ph, g, tv0);
  const tv = individualise(tv0, opts.draw);
  const cls = L.sizeClass;
  const K = BRAIN_CLASSES[cls]!.k;
  const nN = L.nNeurons;
  const ix = new LayoutIndex(L);
  const theta = new Float64Array(nN);
  const tau = new Float64Array(nN).fill(TAU.HIDDEN * tv.tauScale);
  const phaseOff = new Float64Array(nN);
  const src: number[][] = [], w: number[][] = [], meta: number[][] = [];
  for (let i = 0; i < nN; i++) { src.push([]); w.push([]); meta.push([]); }
  const osc = new Float64Array(nN * 12);
  for (let i = 0; i < nN * 4; i++) osc[i * 3] = -1;
  let dropped = 0;

  const syn = (dst: number, s: number, weight: number, m = 0): boolean => {
    if (dst < 0 || s < 0 || weight === 0) return false;
    if (src[dst]!.length >= K) { dropped++; return false; }
    src[dst]!.push(s); w[dst]!.push(weight); meta[dst]!.push(m);
    return true;
  };
  const R = tv.reflex;
  const M = (k: number, part = -1): number => ix.motor(k, part);
  const D = (d: number): number => L.base.drive + d;
  const nD = (d: number): number => ix.n(D(d));
  const MODN = (m: number): number => L.base.mod + m;

  // ---------------- neuron parameters ----------------
  for (let j = 0; j < L.count.motor; j++) {
    const k = L.outputs[j]!.kind;
    tau[j] = (k === OUT.EMIT_INTENSITY || k === OUT.EMIT_HUE || k === OUT.PHOTO_INTENSITY) ? TAU.EMIT
      : (k === OUT.MATE || k === OUT.LAY_BUD || k === OUT.ROLL) ? TAU.TRIGGER : TAU.MOTOR * tv.tauScale;
  }
  theta[M(OUT.CPG_FREQ)] = tv.activity - 0.5;
  theta[M(OUT.MATE)] = -1;
  theta[M(OUT.LAY_BUD)] = -1.5;
  theta[M(OUT.EMIT_INTENSITY)] = tv.lightShow * 2 - 1;
  theta[M(OUT.ROLL)] = -2;
  for (let j = N_GLOBAL_OUT_LOCAL; j < L.count.motor; j++) {
    const k = L.outputs[j]!.kind;
    if (k === OUT.BITE) theta[j] = -1;
    else if (k === OUT.LATCH) theta[j] = -1.5;
    else if (k === OUT.PHOTO_INTENSITY) theta[j] = tv.lightShow * 2 - 1;
    else if (k === OUT.CILIA_DRIVE) theta[j] = 0.5;
    else if (k === OUT.BLADDER_DRIVE) theta[j] = -2 * tv.prefDepth;
    else if (k === OUT.GLAND_RELEASE) theta[j] = -1.5;
    else if (k === OUT.GRIP) theta[j] = -1;
  }
  const patienceMult = pow(4, 2 * tv.patience - 1);
  const dr = tv.drives;
  for (let d = 0; d < 6; d++) tau[D(d)] = dr[d]!.tau * patienceMult;
  theta[D(DRIVE.HUNGER)] = dr[0]!.bias + 1.5 + (tv.appetite - 0.5) * 2;
  theta[D(DRIVE.FEAR)] = dr[1]!.bias - 1 - tv.boldness;
  theta[D(DRIVE.LIBIDO)] = dr[2]!.bias - 2;
  theta[D(DRIVE.FATIGUE)] = dr[3]!.bias - 1;
  theta[D(DRIVE.AGGRESSION)] = dr[4]!.bias + tv.aggression - 0.5;
  theta[D(DRIVE.SOCIALITY)] = dr[5]!.bias + tv.sociality;
  for (let m = 0; m < 2; m++) { tau[MODN(m)] = TAU.MODULATOR; theta[MODN(m)] = -1; }
  for (let i = 0; i < L.count.osc; i++) {
    const n = L.base.osc + i;
    tau[n] = 1;
    phaseOff[n] = ph.cpgPhase[L.oscPart[i]!] ?? 0;
  }
  const dneu = new Map<number, { tau: number; bias: number }>();
  for (const h of g.hiddenNeurons) dneu.set(h.innov >>> 0, { tau: h.tau, bias: h.bias });
  for (let i = 0; i < L.count.direct; i++) {
    const h = dneu.get(L.directInnov[i]!)!;
    tau[L.base.direct + i] = 0.05 * exp((h.tau / 255) * log(2400));
    theta[L.base.direct + i] = q411ToFloat(h.bias);
  }

  // ---------------- innate reflexes (03 §3.8.2) ----------------
  const BIAS = IN.BIAS;
  const gLat = tv.gainLateral, gChem = tv.gainChemo, gVis = tv.gainVision;
  // swim
  syn(M(OUT.CPG_AMP), BIAS, R.swim * (0.5 + tv.activity));
  syn(M(OUT.CPG_FREQ), BIAS, R.swim * 0.25);
  // hunger seeks, fear flees
  syn(M(OUT.CPG_AMP), nD(DRIVE.HUNGER), R.hungerSeeks * 1);
  syn(M(OUT.CPG_AMP), nD(DRIVE.FEAR), R.fearFlees * 1);
  syn(M(OUT.CPG_FREQ), nD(DRIVE.FEAR), R.fearFlees * 1.5 * (0.5 + tv.riskAversion));
  // startle: head-most lateral line, both sides into frequency, contralateral turn
  const latD = ix.firstInput(IN.LATERAL, 0), latV = ix.firstInput(IN.LATERAL, 1);
  syn(M(OUT.CPG_FREQ), latD, R.startle * 1.5 * gLat);
  syn(M(OUT.CPG_FREQ), latV, R.startle * 1.5 * gLat);
  syn(M(OUT.CPG_TURN), latD, -R.startle * 1.5 * gLat);
  syn(M(OUT.CPG_TURN), latV, R.startle * 1.5 * gLat);
  // avoid wall: touch on one side turns away
  const tD = ix.firstInput(IN.TOUCH, 0), tV = ix.firstInput(IN.TOUCH, 1);
  syn(M(OUT.CPG_TURN), tD, -R.avoidWall * 2);
  syn(M(OUT.CPG_TURN), tV, R.avoidWall * 2);
  // graze / klinotaxis: plant smell rate (negative = getting worse) turns; level opens mouths
  const chem = L.chemos.find((c) => c.channels.includes(0));
  const plantLevel = chem ? ix.input(IN.CHEMO_LEVEL, chem.part, chemSlot(L, chem, 0)) : -1;
  const plantRate = chem ? ix.input(IN.CHEMO_RATE, chem.part, chemSlot(L, chem, 0)) : -1;
  // a linear rate -> turn reflex only orbits a source (fixed point at 90 degrees); a small turning bias
  // that the rate suppresses when the smell improves gives a biased walk that spirals in
  syn(M(OUT.CPG_TURN), plantRate, -R.graze * 4 * gChem);
  if (plantRate >= 0) syn(M(OUT.CPG_TURN), BIAS, R.graze * 0.4);
  const chemB = L.chemos.find((c) => c.channels.includes(1));
  const bloodLevel = chemB ? ix.input(IN.CHEMO_LEVEL, chemB.part, chemSlot(L, chemB, 1)) : -1;
  const chemP = L.chemos.find((c) => c.channels.includes(4));
  const pheroLevel = chemP ? ix.input(IN.CHEMO_LEVEL, chemP.part, chemSlot(L, chemP, 4)) : -1;
  // reproduce
  syn(M(OUT.MATE), nD(DRIVE.LIBIDO), R.reproduce * 2);
  syn(M(OUT.LAY_BUD), nD(DRIVE.LIBIDO), R.reproduce * 2);
  syn(M(OUT.LAY_BUD), IN.REPRO_LOAD, 2);
  syn(M(OUT.EMIT_INTENSITY), nD(DRIVE.LIBIDO), 0.5);

  // per-part motors
  for (let j = N_GLOBAL_OUT_LOCAL; j < L.count.motor; j++) {
    const ch = L.outputs[j]!;
    const p = ch.part;
    switch (ch.kind) {
      case OUT.MUSCLE: {
        const o = oscFor(ph, L, p);
        if (o >= 0) syn(j, ix.n(o), R.innateGait * 2 * (ph.cpgAmp[p] ?? 0));
        const dv = ph.dv[p] ?? 0;
        syn(j, ix.n(M(OUT.CPG_TURN)), (ph.kind[p] === KIND.FIN ? 0.3 : 0.6) * (dv !== 0 ? dv : 1));
        break;
      }
      case OUT.FIN_PITCH: {
        const o = oscFor(ph, L, p);
        if (o >= 0) syn(j, ix.n(o), R.innateGait * (ph.cpgAmp[p] ?? 0));
        syn(j, ix.n(M(OUT.CPG_TURN)), 0.5);
        break;
      }
      case OUT.MOUTH_OPEN:
        syn(j, plantLevel, R.graze * 1.5 * gChem);
        syn(j, nD(DRIVE.HUNGER), 1);
        break;
      case OUT.BITE:
        syn(j, ix.input(IN.TASTE_NUTRITION, p), R.biteOnTaste * 3);
        syn(j, nD(DRIVE.AGGRESSION), 1);
        break;
      case OUT.LATCH:
        syn(j, ix.input(IN.TASTE_NUTRITION, p), 2);
        break;
      case OUT.PHOTO_INTENSITY:
        syn(j, ix.n(M(OUT.EMIT_INTENSITY)), 1);
        break;
      case OUT.CILIA_DRIVE:
        syn(j, ix.n(M(OUT.CPG_AMP)), 1);
        break;
      case OUT.JET_DRIVE: {
        const o = oscFor(ph, L, p);
        if (o >= 0) syn(j, ix.n(o), R.innateGait * 1.5);
        syn(j, ix.n(M(OUT.CPG_AMP)), 0.5);
        break;
      }
      case OUT.BLADDER_DRIVE:
        syn(j, IN.DEPTH, 2);
        break;
      case OUT.GLAND_RELEASE:
        syn(j, nD(DRIVE.FEAR), 2);
        break;
      case OUT.GRIP:
        syn(j, ix.input(IN.TOUCH, p, 0), 1);
        syn(j, ix.input(IN.TOUCH, p, 1), 1);
        break;
    }
  }

  // drives: innate inputs (03 §3.7), scaled by the drive's gain
  const gain = (d: number): number => dr[d]!.gain;
  syn(D(DRIVE.HUNGER), IN.ENERGY, -2 * gain(0));
  syn(D(DRIVE.HUNGER), IN.GUT, -1 * gain(0));
  syn(D(DRIVE.FEAR), IN.PAIN, 3 * gain(1) * (1 - 0.5 * tv.boldness));
  const eye = L.eyes[0];
  if (eye) {
    const lanes = eye.bands.length + 1;
    const mid = eye.receptors >> 1;
    syn(D(DRIVE.FEAR), eye.base + mid * lanes + lanes - 1, 2 * gain(1) * gVis);
  }
  syn(D(DRIVE.FEAR), latD, 0.5 * gain(1) * gLat);
  syn(D(DRIVE.FEAR), bloodLevel, 1 * gain(1) * gChem);
  syn(D(DRIVE.LIBIDO), IN.MATURE, 2 * gain(2));
  syn(D(DRIVE.LIBIDO), IN.ENERGY, 1 * gain(2));
  syn(D(DRIVE.FATIGUE), IN.FATIGUE, 2 * gain(3));
  syn(D(DRIVE.FATIGUE), IN.DAY_SIN, -tv.chronotype * gain(3));
  syn(D(DRIVE.AGGRESSION), nD(DRIVE.HUNGER), 1 * gain(4));
  syn(D(DRIVE.AGGRESSION), IN.PAIN, 1 * gain(4));
  syn(D(DRIVE.AGGRESSION), bloodLevel, 0.5 * gain(4) * gChem);
  syn(D(DRIVE.SOCIALITY), pheroLevel, 1 * gain(5) * gChem);
  // modulators (03 §3.5.3)
  const taste = ix.firstInput(IN.TASTE_NUTRITION);
  const toxin = ix.firstInput(IN.TASTE_TOXIN);
  syn(MODN(MOD.PLEASURE), taste, 2);
  syn(MODN(MOD.PLEASURE), IN.ENERGY, 0.5);
  syn(MODN(MOD.PAIN), IN.PAIN, 3);
  syn(MODN(MOD.PAIN), toxin, 2);

  // oscillator couplings: each oscillator to its nearest ancestor's oscillator and back (k = 4/s, lag 0;
  // the innate-gait phase offsets are applied at the output, so equal phases make the designed wave)
  const oscCount = new Uint8Array(nN);
  const couple = (a: number, b: number, k: number, lag: number): void => {
    const c = oscCount[a]!;
    if (c >= 4) return;
    const o = (a * 4 + c) * 3;
    osc[o] = b; osc[o + 1] = k; osc[o + 2] = lag;
    oscCount[a] = c + 1;
  };
  for (let i = 0; i < L.count.osc; i++) {
    const n = L.base.osc + i;
    const p = L.oscPart[i]!;
    const a = ancestorOsc(ph, L, p);
    if (a >= 0) { couple(n, a, 4, 0); couple(a, n, 4, 0); }
  }

  const nReflex = new Uint8Array(nN);
  for (let i = 0; i < nN; i++) nReflex[i] = src[i]!.length;

  // ---------------- CPPN (ENCODING = 1) ----------------
  const encoding = opts.encoding ?? tv.encoding;
  if (encoding === 1) {
    const r = wireCppn(g, L, { src, w, meta, K, theta, tau, osc, oscCount, tv });
    dropped += r.dropped;
  }

  // ---------------- DSYN genes (direct encoding, and CPPN overrides) ----------------
  dropped += applyDirectSynapses(g, L, ph, { src, w, meta, K, tv, override: encoding === 1 });

  let nSyn = 0, nPlastic = 0;
  for (let i = 0; i < nN; i++) {
    nSyn += src[i]!.length;
    for (const m of meta[i]!) if (m & 4) nPlastic++;
  }
  return {
    L, cls, K, theta, tau, phaseOff, src, w, meta, nReflex, osc, fLow: tv.fLow, fHigh: tv.fHigh,
    nSyn, nPlastic, dropped, tv,
  };
}

const N_GLOBAL_OUT_LOCAL = 8;

function chemSlot(L: FullLayout, c: { part: number; base: number }, channel: number): number {
  // slot = chemoOrdinal * 8 + channel; the ordinal is the organ's rank among chemos on its part
  let ord = 0;
  for (const x of L.chemos) { if (x === c) break; if (x.part === c.part) ord++; }
  return ord * 8 + channel;
}

/** Oscillator neuron that drives a part: its own, else the nearest ancestor's, else -1. */
export function oscFor(ph: Phenotype, L: FullLayout, p: number): number {
  let q = p;
  while (q >= 0) {
    const o = L.partOsc[q]!;
    if (o >= 0) return o;
    q = ph.parent[q]!;
  }
  return -1;
}
function ancestorOsc(ph: Phenotype, L: FullLayout, p: number): number {
  const par = ph.parent[p]!;
  return par >= 0 ? oscFor(ph, L, par) : -1;
}

/** synMeta bits: 0-1 rule, 2 plastic, 3-6 eta code (CONTRACT 5.3). */
export function plasticMeta(rule: number, etaCode: number): number {
  return (rule & 3) | 4 | ((etaCode & 15) << 3);
}
/** Learning rate of an eta code: 4-bit log scale in [1e-4, 1e-1] (03 §3.5.3). */
export function etaOf(code: number): number { return 1e-4 * exp((code / 15) * 3 * log(10)); }

interface DsynCtx { src: number[][]; w: number[][]; meta: number[][]; K: number; tv: BrainTraitValues; override: boolean }

/**
 * Resolve DSYN genes onto the layout. A module key names every instance of the module, so a
 * duplicated part arrives wired; an instance key (flag bit 2) names one instance. A module-keyed
 * source resolves, for each destination instance, to the source instance on the same part, else
 * the one nearest along u (ties to the lower index).
 */
function applyDirectSynapses(g: Genome, L: FullLayout, ph: Phenotype, c: DsynCtx): number {
  void ph;
  if (g.directSynapses.length === 0) return 0;
  const nIn = L.nIn;
  const modSrc = new Map<number, number[]>();
  const instSrc = new Map<number, number>();
  const modDst = new Map<number, number[]>();
  const instDst = new Map<number, number>();
  const push = (m: Map<number, number[]>, k: number, v: number): void => {
    const a = m.get(k);
    if (a) a.push(v); else m.set(k, [v]);
  };
  for (let i = 0; i < nIn; i++) {
    push(modSrc, L.inModKey[i]!, i);
    if (!instSrc.has(L.inputs[i]!.key)) instSrc.set(L.inputs[i]!.key, i);
  }
  for (let n = 0; n < L.nNeurons; n++) {
    push(modSrc, L.neuModKey[n]!, nIn + n);
    push(modDst, L.neuModKey[n]!, n);
    if (!instSrc.has(L.neuronKey[n]!)) instSrc.set(L.neuronKey[n]!, nIn + n);
    if (!instDst.has(L.neuronKey[n]!)) instDst.set(L.neuronKey[n]!, n);
  }
  const partOf = (s: number): number => (s < nIn ? L.inputs[s]!.part : L.neuPart[s - nIn]!);
  const uOf = (s: number): number => (s < nIn ? L.inU[s]! : L.neuU[s - nIn]!);
  const genes = g.directSynapses.filter((d) => (d.flags & DSYN_FLAG.ENABLED) !== 0)
    .slice().sort((a, b) => (a.src >>> 0) - (b.src >>> 0) || (a.dst >>> 0) - (b.dst >>> 0));
  let dropped = 0;
  for (const gene of genes) {
    const perInst = (gene.flags & DSYN_FLAG.PER_INSTANCE) !== 0;
    const dsts = perInst ? (instDst.has(gene.dst >>> 0) ? [instDst.get(gene.dst >>> 0)!] : []) : modDst.get(gene.dst >>> 0) ?? [];
    if (dsts.length === 0) continue;
    const wt = q411ToFloat(gene.w);
    const m = c.tv.plasticityOn && gene.plasticity !== 0
      ? plasticMeta(Math.abs(gene.plasticity) & 3, (Math.abs(gene.plasticity) >> 2) & 15) : 0;
    for (const d of dsts) {
      let s = -1;
      if (perInst) s = instSrc.get(gene.src >>> 0) ?? -1;
      else {
        const cands = modSrc.get(gene.src >>> 0) ?? [];
        const dp = L.neuPart[d]!;
        const du = L.neuU[d]!;
        let best = Infinity;
        for (const cs of cands) {
          const sp = partOf(cs);
          const score = sp === dp && dp >= 0 ? -1 : Math.abs(uOf(cs) - du);
          if (score < best) { best = score; s = cs; }
        }
      }
      if (s < 0) continue;
      const row = c.src[d]!;
      if (c.override) {
        // HybrID override: add to an existing slot from the same source, else take a free slot,
        // else replace the weakest non-reflex slot (03 §3.6.3 step 5).
        const at = row.indexOf(s);
        if (at >= 0) { c.w[d]![at] = clampW(c.w[d]![at]! + wt); continue; }
      }
      if (row.length < c.K) { row.push(s); c.w[d]!.push(wt); c.meta[d]!.push(m); continue; }
      dropped++;
    }
  }
  return dropped;
}

function clampW(x: number): number { return x > W_MAX ? W_MAX : x < -W_MAX ? -W_MAX : x; }

