/**
 * Swimmer cards (02 §2.11, REVIEW R7) for the far level of detail: a table, per morphology, of
 * steady speed, muscle power and tail amplitude against a gait descriptor (amplitude,
 * frequency, inter-joint phase lag), measured by running the full physics in a still-water
 * lab. v0.x has no reduced physics tier (R7), so cards are not used to move creatures; views
 * and the designer's test tank use them to pose and label far creatures consistently with the
 * full physics. The key covers every quantity that changes drag, mass or muscle section at 5%
 * resolution, so a mutation that shrinks a part gets a new card.
 */
import { hash32, log, sin, type Phenotype } from '../core/index.js';
import { createPhysics } from './index.js';
import { makeWorld, nextTick, spawn, com } from './testkit.js';

export interface GaitAxis { amps: readonly number[]; freqs: readonly number[]; lag: number }

export interface SwimmerCard {
  key: number;
  gait: GaitAxis;
  /** [ia * nFreq + jf]: steady speed along the heading (m/s), muscle power (W), tail-tip half amplitude (m). */
  U: Float64Array;
  P: Float64Array;
  tipAmp: Float64Array;
  lengthM: number;
}

const Q5 = 1 / log(1.05);
function q(x: number): number { return x > 0 ? Math.round(log(x) * Q5) : -100000; }

/** Morphology key: topology plus every mass, drag and muscle quantity at 5% resolution. */
export function cardKey(ph: Phenotype): number {
  let h = hash32(ph.nParts, 0x5eed, 0);
  for (let i = 0; i < ph.nParts; i++) {
    h = hash32(h, ph.parent[i]! + 1, ph.kind[i]! | (ph.organs[i]! << 8));
    h = hash32(h, q(ph.length[i]!), q(ph.radius[i]!));
    h = hash32(h, q(ph.span[i]!), q(ph.muscleFrac[i]! + 1e-3));
    h = hash32(h, q(ph.lipidFrac[i]! + 1e-3), q(ph.armour[i]! + 1e-3));
    h = hash32(h, Math.round(ph.attachU[i]! * 20), Math.round(ph.restAngle[i]! * 20));
  }
  return h >>> 0;
}

/** Run the lab: one isolated body per gait cell, still water, gravity off, 4 substeps. */
export function measureCard(ph: Phenotype, gait: GaitAxis, seconds = 6): SwimmerCard {
  const nA = gait.amps.length; const nF = gait.freqs.length;
  const card: SwimmerCard = {
    key: cardKey(ph), gait, U: new Float64Array(nA * nF), P: new Float64Array(nA * nF), tipAmp: new Float64Array(nA * nF),
    lengthM: ph.lengthM,
  };
  for (let ia = 0; ia < nA; ia++) for (let jf = 0; jf < nF; jf++) {
    const r = runGait(ph, gait.amps[ia]!, gait.freqs[jf]!, gait.lag, seconds);
    card.U[ia * nF + jf] = r.U; card.P[ia * nF + jf] = r.P; card.tipAmp[ia * nF + jf] = r.tipAmp;
  }
  return card;
}

/** Full-physics steady swimming of one gait (the second half of the run). */
export function runGait(ph: Phenotype, amp: number, f: number, lag: number, seconds: number): { U: number; P: number; tipAmp: number } {
  const tw = makeWorld();
  const phys = createPhysics({ gravity: false, contacts: false, nSub: 4, watchdog: false });
  const slot = spawn(tw, phys.loadBody, ph, 16, 9, 0);
  const w = tw.world; const sg = w.seg.c; const c = w.cr.c; const s0 = c.segStart[slot]!; const n = c.segCount[slot]!;
  const dt = phys.opts.dt;
  const ticks = Math.round(seconds / dt); const half = ticks >> 1;
  let x0 = 0; let y0 = 0; let P = 0; let lo = Infinity; let hi = -Infinity;
  const TAU = 6.283185307179586;
  for (let k = 0; k < ticks; k++) {
    const t = k * dt;
    for (let j = 1; j < n; j++) {
      sg.cmd[s0 + j] = amp * sin(TAU * f * t - lag * j);
    }
    phys.step(w, tw.ctx); nextTick(tw);
    if (k === half) { [x0, y0] = com(w, slot); }
    if (k > half) {
      P += c.powerW[slot]! * dt;
      const i = s0 + n - 1;
      const tip = sg.posY[i]! - com(w, slot)[1];
      if (tip < lo) lo = tip; if (tip > hi) hi = tip;
    }
  }
  const T = (ticks - 1 - half) * dt;
  const [x1] = com(w, slot);
  void y0;
  return { U: (x1 - x0) / T, P: P / T, tipAmp: 0.5 * (hi - lo) };
}

/** Bilinear lookup in (amplitude, frequency), clamped to the measured range. */
export function cardLookup(card: SwimmerCard, amp: number, f: number): { U: number; P: number; tipAmp: number } {
  const { amps, freqs } = card.gait;
  const locate = (axis: readonly number[], x: number): [number, number] => {
    if (axis.length === 1 || x <= axis[0]!) return [0, 0];
    for (let i = 0; i < axis.length - 1; i++) if (x <= axis[i + 1]!) return [i, (x - axis[i]!) / (axis[i + 1]! - axis[i]!)];
    return [axis.length - 2, 1];
  };
  const [ia, ta] = locate(amps, amp); const [jf, tf] = locate(freqs, f);
  const nF = freqs.length;
  const ia1 = Math.min(ia + 1, amps.length - 1); const jf1 = Math.min(jf + 1, nF - 1);
  const pick = (a: Float64Array): number =>
    (a[ia * nF + jf]! * (1 - tf) + a[ia * nF + jf1]! * tf) * (1 - ta) + (a[ia1 * nF + jf]! * (1 - tf) + a[ia1 * nF + jf1]! * tf) * ta;
  return { U: pick(card.U), P: pick(card.P), tipAmp: pick(card.tipAmp) };
}
