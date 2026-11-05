/**
 * Conservative transport (CONTRACT 5.4, 04 §4.2): donor-cell upwind advection by face fluxes,
 * diffusion as two one-way donor exchanges per face, and sinking. Every flux leaves a donor
 * cell as an integer number of quanta (real flux plus a deterministic dither), capped by what
 * the donor holds, and is added to the receiver: mass moves without loss and no cell goes
 * negative. Substeps keep the outflow fraction of any cell under 0.8.
 *
 * `prepare` computes each cell's five outflow fractions (left, right, up, down, settle) once
 * per pass; every field moved on that grid with the same options reuses them. The same kernel
 * moves f32 signal fields (oxygen, sulphur, anomaly, turbidity, scent) without quantisation.
 */
import type { RngStreams } from '../core/index.js';
import { Dither } from './ledger.js';

export interface Grid {
  w: number; h: number; cs: number;
  /** 1 where the cell holds water. */
  wet: Uint8Array;
  /** Face fluxes in m^2/s: u on (w+1) x h vertical faces (+x), v on w x (h+1) horizontal faces (+y). */
  uFace: Float64Array; vFace: Float64Array;
}
export interface TransportOpts {
  dt: number;
  kh: number;
  /** Vertical diffusivity per horizontal face row (h + 1 entries; entry iy is the top face of row iy), m^2/s. */
  kz: Float64Array;
  /** Sinking speed, m/s (+y). Mass that would sink into rock or the bottom settles instead. */
  ws: number;
  /** Called with (cell, quanta) for mass settling onto a floor. */
  settle?: (cell: number, q: number) => void;
}
export interface Prepared { sub: number; fr: Float64Array }

/** Outflow fractions per cell for one substep of dt / sub, and the substep count. */
export function prepare(g: Grid, o: TransportOpts, subIn?: number, buf?: Float64Array): Prepared {
  const { w, h, cs, wet, uFace, vFace } = g;
  const n = w * h;
  const fr = buf && buf.length >= n * 5 ? buf : new Float64Array(n * 5);
  const pass = (sub: number): number => {
    const dt = o.dt / sub;
    const a = dt / (cs * cs);
    const dh = (o.kh * dt) / (cs * cs);
    const wsF = (o.ws * dt) / cs;
    let mx = 0;
    for (let iy = 0; iy < h; iy++) {
      const dzT = (o.kz[iy]! * dt) / (cs * cs), dzB = (o.kz[iy + 1]! * dt) / (cs * cs);
      for (let ix = 0; ix < w; ix++) {
        const i = iy * w + ix;
        const k = i * 5;
        if (!wet[i]) { fr[k] = fr[k + 1] = fr[k + 2] = fr[k + 3] = fr[k + 4] = 0; continue; }
        const uL = uFace[iy * (w + 1) + ix]!, uR = uFace[iy * (w + 1) + ix + 1]!;
        const vT = vFace[iy * w + ix]!, vB = vFace[(iy + 1) * w + ix]!;
        const lW = ix > 0 && wet[i - 1] === 1, rW = ix < w - 1 && wet[i + 1] === 1;
        const tW = iy > 0 && wet[i - w] === 1, bW = iy < h - 1 && wet[i + w] === 1;
        const f0 = lW ? (uL < 0 ? -uL * a : 0) + dh : 0;
        const f1 = rW ? (uR > 0 ? uR * a : 0) + dh : 0;
        const f2 = tW ? (vT < 0 ? -vT * a : 0) + dzT : 0;
        const f3 = bW ? (vB > 0 ? vB * a : 0) + dzB + wsF : 0;
        const f4 = bW ? 0 : wsF;
        fr[k] = f0; fr[k + 1] = f1; fr[k + 2] = f2; fr[k + 3] = f3; fr[k + 4] = f4;
        const t = f0 + f1 + f2 + f3 + f4;
        if (t > mx) mx = t;
      }
    }
    return mx;
  };
  if (subIn !== undefined) { pass(subIn); return { sub: subIn, fr }; }
  const mx = pass(1);
  const sub = Math.max(1, Math.ceil(mx / 0.8));
  if (sub > 1) pass(sub);
  return { sub, fr };
}

/** Number of substeps needed so no cell sends more than 80% of its content in one step. */
export function substepsFor(g: Grid, o: TransportOpts): number { return prepare(g, o).sub; }

/** Integer, exactly conserving transport of a quanta field. */
export function transportQ(
  g: Grid, q: Float64Array, o: TransportOpts, rng: RngStreams, tick: number, tag: number, prep?: Prepared | number,
  deltaBuf?: Float64Array,
): void {
  const p = typeof prep === 'object' ? prep : prepare(g, o, prep);
  const n = g.w * g.h;
  const w = g.w;
  const fr = p.fr;
  const delta = deltaBuf && deltaBuf.length >= n ? deltaBuf : new Float64Array(n);
  delta.fill(0, 0, n);
  for (let k = 0; k < p.sub; k++) {
    const dith = new Dither(rng, tick, tag * 64 + k);
    if (k > 0) delta.fill(0);
    for (let i = 0; i < n; i++) {
      const qi = q[i]!;
      if (qi <= 0) continue;
      const b = i * 5;
      let rem = qi;
      // one hash per donor cell; the five outflows take golden-ratio rotations of it
      let dd = dith.at(i);
      for (let f = 0; f < 5; f++) {
        const x = fr[b + f]!;
        dd += 0.6180339887498949;
        if (dd >= 1) dd -= 1;
        if (x <= 0) continue;
        let m = Math.floor(qi * x + dd);
        if (m > rem) m = rem;
        if (m <= 0) continue;
        rem -= m;
        if (f === 0) delta[i - 1] = delta[i - 1]! + m;
        else if (f === 1) delta[i + 1] = delta[i + 1]! + m;
        else if (f === 2) delta[i - w] = delta[i - w]! + m;
        else if (f === 3) delta[i + w] = delta[i + w]! + m;
        else if (o.settle) o.settle(i, m);
        else { rem += m; continue; }
        if (rem <= 0) break;
      }
      if (rem !== qi) delta[i] = delta[i]! - (qi - rem);
    }
    for (let i = 0; i < n; i++) if (delta[i] !== 0) q[i] = q[i]! + delta[i]!;
  }
}

/** Float transport of a signal field (same fluxes, no quantisation, no settling). */
export function transportF(
  g: Grid, q: Float32Array, o: TransportOpts, prep?: Prepared | number, lane = 0, lanes = 1, deltaBuf?: Float64Array,
): void {
  const p = typeof prep === 'object' ? prep : prepare(g, o, prep);
  const n = g.w * g.h;
  const w = g.w;
  const fr = p.fr;
  const delta = deltaBuf && deltaBuf.length >= n ? deltaBuf : new Float64Array(n);
  delta.fill(0, 0, n);
  for (let k = 0; k < p.sub; k++) {
    if (k > 0) delta.fill(0);
    for (let i = 0; i < n; i++) {
      const qi = q[i * lanes + lane]!;
      if (qi === 0) continue;
      const b = i * 5;
      const a = qi * fr[b]!, bb = qi * fr[b + 1]!, c = qi * fr[b + 2]!, d = qi * fr[b + 3]!;
      delta[i] = delta[i]! - a - bb - c - d;
      if (a) delta[i - 1] = delta[i - 1]! + a;
      if (bb) delta[i + 1] = delta[i + 1]! + bb;
      if (c) delta[i - w] = delta[i - w]! + c;
      if (d) delta[i + w] = delta[i + w]! + d;
    }
    for (let i = 0; i < n; i++) if (delta[i] !== 0) q[i * lanes + lane] = q[i * lanes + lane]! + delta[i]!;
  }
}
