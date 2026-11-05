/**
 * The brain tick (CONTRACT 8.3), the canonical CPU reference. Batched per size class: one loop
 * over the live slots of each class pool with that class's fixed (N, I, K), so the inner loops
 * have constant strides (the shape a GPU kernel will have).
 *
 * Synchronous (Jacobi) update: every neuron reads `inputs` and `oPrev` only; oscillators read
 * the phases from before this tick. Then plasticity (gene-gated ABCD rule), the NaN guard,
 * `oPrev := o`, and the act step writing `out`, `cmd`, `cmd2`.
 */
import {
  BRAIN_CLASSES, BRAIN_STATE_CLAMP, DT, LIFE, NEURON_KIND, NONE_U32, PI, RNG_STREAM, TAU, sin, sigmoid,
  boxMullerParts, tanh, philox4x32, type World,
} from '../core/index.js';
import { W_MAX, etaOf } from './develop.js';
import { DEST, brainState, recomputeAlphas, type BrainStatic } from './pool.js';
import type { StepContext } from '../core/index.js';

const OSC = NEURON_KIND.OSCILLATOR;
const NOISY_LO = NEURON_KIND.DRIVE;
const MOTOR_TRIGGER_MATE = 3, MOTOR_TRIGGER_LAY = 4, MOTOR_ROLL = 7;
export const ROLL_COOLDOWN_S = 2;

const blk = new Uint32Array(4);
const phasePrev = new Float64Array(256);
const tanhArg = new Float64Array(256);
/** o[bN + i] = tanh(arg[i]) for every non-oscillator neuron i < n. */
function tanhInto(o: Float32Array, bN: number, nKind: Uint8Array, arg: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) if (nKind[bN + i] !== OSC) o[bN + i] = tanh(arg[i]!);
}
const noiseBuf = new Float64Array(256);

/** Fill noiseBuf[0..n) with N(0, sigma): Box-Muller on 24-bit uniforms, drawIndex = index / 4. */
export function gaussianBlock(k0: number, k1: number, tick: number, entityId: number, n: number, sigma: number, out: Float64Array): void {
  // splitU64 without the tuple: entityId is a non-negative safe integer
  const lo = entityId % 4294967296 >>> 0, hi = Math.floor(entityId / 4294967296) >>> 0;
  const t0 = tick >>> 0;
  const bm = bmBuf;
  for (let b = 0, i = 0; i < n; b++, i += 4) {
    philox4x32(t0, lo, hi, b, k0, k1, blk);
    // pair 0 -> out[i], out[i + 1]; pair 1 -> out[i + 2], out[i + 3]; r = sqrt(-2 log u1) * sigma
    boxMullerParts(blk, 0, bm); // u1 = 1 - (blk[0] >>> 8) 2^-24, u2 = (blk[1] >>> 8) 2^-24
    const r0 = bm[0]! * sigma;
    out[i] = r0 * bm[1]!;
    if (i + 1 < n) out[i + 1] = r0 * bm[2]!;
    if (i + 2 < n) {
      boxMullerParts(blk, 2, bm);
      const r1 = bm[0]! * sigma;
      out[i + 2] = r1 * bm[1]!;
      if (i + 3 < n) out[i + 3] = r1 * bm[2]!;
    }
  }
}
const bmBuf = new Float64Array(3);

/** Neurons that read exploration noise: not motors, modulators or oscillators (see tickBrain). */
function noisy(kind: number): boolean { return kind >= NOISY_LO && kind !== NEURON_KIND.MODULATOR && kind !== OSC; }

/**
 * gaussianBlock for the exploration noise: the same values at the same indices, but only the
 * draws some neuron reads. A Philox block (4 values) runs only when one of its neurons is noisy,
 * and a Box-Muller pair only when one of its two is; the values left out are never read, so the
 * brain is bit-identical. Motors are over half the neurons, so this skips about 60% of the work.
 */
function explorationNoise(
  k0: number, k1: number, tick: number, entityId: number, n: number, sigma: number, out: Float64Array, nKind: Uint8Array, bN: number,
): void {
  const lo = entityId % 4294967296 >>> 0, hi = Math.floor(entityId / 4294967296) >>> 0;
  const t0 = tick >>> 0;
  const bm = bmBuf;
  for (let b = 0, i = 0; i < n; b++, i += 4) {
    const a0 = noisy(nKind[bN + i]!) || (i + 1 < n && noisy(nKind[bN + i + 1]!));
    const a1 = i + 2 < n && (noisy(nKind[bN + i + 2]!) || (i + 3 < n && noisy(nKind[bN + i + 3]!)));
    if (!a0 && !a1) continue;
    philox4x32(t0, lo, hi, b, k0, k1, blk);
    if (a0) {
      boxMullerParts(blk, 0, bm);
      const r0 = bm[0]! * sigma;
      out[i] = r0 * bm[1]!;
      if (i + 1 < n) out[i + 1] = r0 * bm[2]!;
    }
    if (a1) {
      boxMullerParts(blk, 2, bm);
      const r1 = bm[0]! * sigma;
      out[i + 2] = r1 * bm[1]!;
      if (i + 3 < n) out[i + 3] = r1 * bm[2]!;
    }
  }
}

/** Run the brain tick for every due brain. */
export function think(world: World, ctx: StepContext): void {
  const bs = brainState(world);
  const div = world.g.brainDiv;
  if (div !== bs.lastDiv) recomputeAlphas(world);
  const tick = ctx.tick;
  const dtb = div * DT;
  const life = world.cr.c.life;
  const ns = ctx.rng.stream(RNG_STREAM.BRAIN_NOISE);
  for (let c = 0; c < world.brains.length; c++) {
    const pool = world.brains[c]!;
    const statics = bs.statics[c]!;
    const owner = pool.c.owner;
    for (let s = 0; s < pool.highWater; s++) {
      const cr = owner[s]!;
      if (cr === NONE_U32) continue;
      if ((cr + tick) % div !== 0) continue;
      if (life[cr] !== LIFE.ALIVE) continue;
      const st = statics[s];
      if (!st) continue;
      tickBrain(world, c, s, st, tick, dtb, ns.k0, ns.k1);
      actBrain(world, c, s, st, dtb);
    }
  }
}

/** One brain, one tick. Exported for the spike harness and tests. */
export function tickBrain(world: World, c: number, s: number, st: BrainStatic, tick: number, dtb: number, k0: number, k1: number): void {
  const pool = world.brains[c]!;
  const { n: N, i: I, k: K } = BRAIN_CLASSES[c]!;
  const p = pool.c;
  const inputs = p.inputs, y = p.y, o = p.o, oPrev = p.oPrev, theta = p.theta, alpha = p.alpha;
  const phase = p.phase, phaseOff = p.phaseOff, nKind = p.nKind, synSrc = p.synSrc, synW = p.synW;
  const synDw = p.synDw, synMeta = p.synMeta, osc = p.osc;
  const nIn = p.nIn[s]!, nNeu = p.nNeu[s]!;
  const bI = s * I, bN = s * N, bS = s * K * N;
  const rowLen = st.rowLen;
  const plastic = st.plastic && synDw.length > 1;
  const fLow = p.fBand[s * 2]!, fHigh = p.fBand[s * 2 + 1]!;
  const F = fLow + (fHigh - fLow) * sigmoid(4 * oPrev[bN]!);
  const amp = sigmoid(4 * oPrev[bN + 1]!);
  if (st.exploration > 0) explorationNoise(k0, k1, tick, st.entityId, nNeu, st.exploration, noiseBuf, nKind, bN);
  for (let i = 0; i < nNeu; i++) phasePrev[i] = phase[bN + i]!;
  for (let i = 0; i < nNeu; i++) {
    let sum = 0;
    // padding slots (w = 0) after the packed row are skipped; they add exactly zero
    const kn = rowLen[i]!;
    for (let k = 0; k < kn; k++) {
      const at = bS + k * N + i;
      const j = synSrc[at]!;
      let wv = synW[at]!;
      if (plastic && (synMeta[at]! & 4) !== 0) {
        wv += synDw[at]!;
        if (wv > W_MAX) wv = W_MAX; else if (wv < -W_MAX) wv = -W_MAX;
      }
      sum += wv * (j < nIn ? inputs[bI + j]! : oPrev[bN + j - nIn]!);
    }
    const kind = nKind[bN + i]!;
    if (kind === OSC) {
      const ph = phasePrev[i]!;
      let dphi = TAU * F + sum;
      const ob = (bN + i) * 12;
      for (let q = 0; q < 4; q++) {
        const src = osc[ob + q * 3]!;
        if (src < 0) continue;
        dphi += osc[ob + q * 3 + 1]! * sin(phasePrev[src]! - ph - osc[ob + q * 3 + 2]!);
      }
      let np = ph + dtb * dphi;
      if (np > PI || np <= -PI) np -= TAU * Math.floor((np + PI) / TAU);
      phase[bN + i] = np;
      o[bN + i] = amp * sin(np + phaseOff[bN + i]!);
    } else {
      const noise = kind >= NOISY_LO && kind !== NEURON_KIND.MODULATOR && st.exploration > 0 ? noiseBuf[i]! : 0;
      let yi = y[bN + i]! + alpha[bN + i]! * (sum + noise - y[bN + i]!);
      if (yi > BRAIN_STATE_CLAMP) yi = BRAIN_STATE_CLAMP; else if (yi < -BRAIN_STATE_CLAMP) yi = -BRAIN_STATE_CLAMP;
      y[bN + i] = yi;
      tanhArg[i] = yi + theta[bN + i]!;
    }
  }
  // o = tanh(y + theta) in a second, tight pass (Jacobi: nothing above reads o), where tanh
  // inlines and boxes nothing
  tanhInto(o, bN, nKind, tanhArg, nNeu);
  if (plastic) plasticity(world, c, s, st, dtb);
  // NaN guard
  let bad = false;
  for (let i = 0; i < nNeu; i++) {
    const v = o[bN + i]!;
    if (v !== v || phase[bN + i] !== phase[bN + i] || y[bN + i] !== y[bN + i]) { bad = true; break; }
  }
  if (bad) {
    y.fill(0, bN, bN + N); o.fill(0, bN, bN + N); oPrev.fill(0, bN, bN + N); phase.fill(0, bN, bN + N);
    brainState(world).nanResets++;
    return;
  }
  for (let i = 0; i < nNeu; i++) oPrev[bN + i] = o[bN + i]!;
}

/** Neuromodulated ABCD rule (03 §3.5.3), before oPrev := o so pre-synaptic values are last tick's. */
function plasticity(world: World, c: number, s: number, st: BrainStatic, dtb: number): void {
  const pool = world.brains[c]!;
  const { n: N, i: I, k: K } = BRAIN_CLASSES[c]!;
  const p = pool.c;
  const nIn = p.nIn[s]!, nNeu = p.nNeu[s]!;
  const bI = s * I, bN = s * N, bS = s * K * N;
  const modBase = st.L.base.mod;
  const mPlus = p.oPrev[bN + modBase]!, mMinus = p.oPrev[bN + modBase + 1]!;
  const decay = dtb / st.tauForget;
  const R = st.rules;
  for (let i = 0; i < nNeu; i++) {
    const post = p.o[bN + i]!;
    for (let k = 0; k < st.rowLen[i]!; k++) {
      const at = bS + k * N + i;
      const meta = p.synMeta[at]!;
      if ((meta & 4) === 0) continue;
      const r = meta & 3;
      const ch = st.ruleCh[r]!;
      const m = ch === 0 ? mPlus : ch === 1 ? mMinus : 1;
      const j = p.synSrc[at]!;
      const pre = j < nIn ? p.inputs[bI + j]! : p.oPrev[bN + j - nIn]!;
      const eta = etaOf((meta >> 3) & 15) * st.etaScale;
      let dw = p.synDw[at]! + eta * m * (R[r * 4]! * post * pre + R[r * 4 + 1]! * post + R[r * 4 + 2]! * pre + R[r * 4 + 3]!) - decay * p.synDw[at]!;
      const w0 = p.synW[at]!;
      if (w0 + dw > W_MAX) dw = W_MAX - w0; else if (w0 + dw < -W_MAX) dw = -W_MAX - w0;
      p.synDw[at] = dw;
    }
  }
}

/** Act: motor j -> its output channel (CONTRACT 8.3 step 3), with trigger hysteresis and cooldown. */
export function actBrain(world: World, c: number, s: number, st: BrainStatic, dtb: number): void {
  const pool = world.brains[c]!;
  const N = BRAIN_CLASSES[c]!.n;
  const p = pool.c;
  const bN = s * N;
  const cr = st.creature;
  const out = world.cr.c.out;
  const segStart = world.cr.c.segStart[cr]!;
  const segCount = world.cr.c.segCount[cr]!;
  const seg = world.seg.c;
  const nMotor = st.outDest.length;
  for (let j = 0; j < nMotor; j++) {
    const v = p.o[bN + j]!;
    const dest = st.outDest[j]!;
    if (dest === DEST.GLOBAL) {
      const lane = cr * 8 + j;
      if (j === MOTOR_TRIGGER_MATE || j === MOTOR_TRIGGER_LAY) {
        const on = out[lane]! > 0.5 ? v > 0.2 : v > 0.5; // hysteresis: on above 0.5, off below 0.2
        out[lane] = on ? 1 : 0;
      } else if (j === MOTOR_ROLL) {
        // the cooldown lives in the ROLL motor's phase lane (motors never use their phase)
        let cd = p.phase[bN + j]! - dtb;
        if (v > 0.5 && cd <= 0) { out[lane] = 1; cd = ROLL_COOLDOWN_S; } else out[lane] = 0;
        p.phase[bN + j] = cd > 0 ? cd : 0;
      } else out[lane] = v;
      continue;
    }
    const part = st.outPart[j]!;
    if (segStart === NONE_U32 || part >= segCount) continue; // organ not grown yet: output ignored
    const sg = segStart + part;
    if (dest === DEST.CMD) seg.cmd[sg] = v;
    else if (dest === DEST.CMD2) seg.cmd2[sg] = v;
    else if (dest === DEST.BITE) seg.cmd3[sg * 2] = v;
    else seg.cmd3[sg * 2 + 1] = v;
  }
}
