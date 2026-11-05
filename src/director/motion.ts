/**
 * Camera motion primitives (06 §6.2.6): the exactly integrated critically damped spring, smooth
 * saturation, and the van Wijk and Nuij optimal zoom-and-pan path. Deterministic maths only.
 */
import { exp, log, tanh } from '../core/index.js';

export interface SpringOut { x: number; v: number }

/**
 * Critically damped spring, exact integration (Lowe 2004; Holden's spring notes): frame-rate
 * independent and never overshoots a fixed target from rest.
 */
export function springCritical(x: number, v: number, target: number, omega: number, dt: number, out: SpringOut = { x: 0, v: 0 }): SpringOut {
  const e = x - target;
  const j = v + omega * e;
  const decay = exp(-omega * dt);
  out.x = target + (e + j * dt) * decay;
  out.v = (v - j * omega * dt) * decay;
  return out;
}

/** Smooth saturation `e' = eMax tanh(e / eMax)`: no jerk when a limit engages. */
export function saturate(e: number, eMax: number): number {
  return eMax > 0 ? eMax * tanh(e / eMax) : 0;
}

/** Soft cap of a magnitude: identity below 80% of the limit, then a tanh knee that never exceeds it. */
export function softCap(v: number, vMax: number): number {
  const a = v < 0 ? -v : v;
  const knee = 0.8 * vMax;
  if (a <= knee) return v;
  const c = knee + 0.2 * vMax * tanh((a - knee) / (0.2 * vMax));
  return v < 0 ? -c : c;
}

export function cosh(x: number): number { const e = exp(x); return 0.5 * (e + 1 / e); }
export function sinh(x: number): number { const e = exp(x); return 0.5 * (e - 1 / e); }
/** asinh(x) = ln(x + sqrt(x^2 + 1)), written for accuracy on both signs. */
export function asinh(x: number): number {
  const a = x < 0 ? -x : x;
  const r = log(a + Math.sqrt(a * a + 1));
  return x < 0 ? -r : r;
}

/**
 * The van Wijk and Nuij (2003) optimal path between two views, each given as a centre and a
 * visible width `w` (metres). The path is parametrised by its length `s` in [0, S] under the
 * metric `ds^2 = rho^2 du^2 / w^2 + dw^2 / (rho^2 w^2)`, so constant ds/dt is constant perceived
 * speed. `S` is in "screen widths" and is the travel cost `u` of 06 §6.2.4.
 */
export class ZoomPath {
  readonly S: number;
  private readonly ux: number;
  private readonly uy: number;
  private readonly u1: number;
  private readonly r0: number;
  private readonly kind: 'general' | 'zoom' | 'none';
  private readonly zk: number;

  constructor(
    readonly x0: number, readonly y0: number, readonly w0: number,
    readonly x1: number, readonly y1: number, readonly w1: number,
    readonly rho = 1.4,
  ) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const u1 = Math.sqrt(dx * dx + dy * dy);
    this.u1 = u1;
    this.ux = u1 > 0 ? dx / u1 : 0;
    this.uy = u1 > 0 ? dy / u1 : 0;
    const r2 = rho * rho;
    const r4 = r2 * r2;
    // Below about 1e-6 screen widths the general formula loses precision: treat as a pure zoom.
    if (u1 < 1e-6 * Math.min(w0, w1)) {
      const lr = log(w1 / w0);
      this.kind = Math.abs(lr) < 1e-12 ? 'none' : 'zoom';
      this.zk = lr < 0 ? -1 : 1;
      this.S = Math.abs(lr) / rho;
      this.r0 = 0;
      return;
    }
    this.kind = 'general';
    this.zk = 0;
    const b0 = (w1 * w1 - w0 * w0 + r4 * u1 * u1) / (2 * w0 * r2 * u1);
    const b1 = (w1 * w1 - w0 * w0 - r4 * u1 * u1) / (2 * w1 * r2 * u1);
    // r_i = ln(-b_i + sqrt(b_i^2 + 1)) = -asinh(b_i)
    const r0 = -asinh(b0);
    const r1 = -asinh(b1);
    this.r0 = r0;
    this.S = (r1 - r0) / rho;
  }

  /** The view at path length s: centre and visible width. */
  at(s: number, out: { x: number; y: number; w: number } = { x: 0, y: 0, w: 0 }): { x: number; y: number; w: number } {
    const S = this.S;
    if (s <= 0) { out.x = this.x0; out.y = this.y0; out.w = this.w0; return out; }
    if (s >= S) { out.x = this.x1; out.y = this.y1; out.w = this.w1; return out; }
    if (this.kind === 'none') { out.x = this.x1; out.y = this.y1; out.w = this.w1; return out; }
    if (this.kind === 'zoom') {
      const f = s / S;
      out.x = this.x0 + (this.x1 - this.x0) * f;
      out.y = this.y0 + (this.y1 - this.y0) * f;
      out.w = this.w0 * exp(this.zk * this.rho * s);
      return out;
    }
    const rho = this.rho;
    const r0 = this.r0;
    const c0 = cosh(r0);
    const a = rho * s + r0;
    const u = (this.w0 / (rho * rho)) * (c0 * tanh(a) - sinh(r0));
    out.x = this.x0 + this.ux * u;
    out.y = this.y0 + this.uy * u;
    out.w = (this.w0 * c0) / cosh(a);
    return out;
  }

  /**
   * Peak pan rate (screen widths per unit s) and peak zoom rate (natural-log units per unit s)
   * along the path. Pan rate = (du/ds)/w = 1/(rho cosh(rho s + r0)); zoom rate = rho |tanh(...)|.
   */
  peakRates(): { pan: number; zoom: number } {
    if (this.kind !== 'general') return { pan: this.kind === 'zoom' ? 0 : 0, zoom: this.kind === 'zoom' ? this.rho : 0 };
    const a0 = this.r0;
    const a1 = this.rho * this.S + this.r0;
    // cosh is minimal at 0: pan peaks at a = 0 if inside [a0, a1]; tanh magnitude peaks at an end.
    const aPan = a0 <= 0 && a1 >= 0 ? 0 : Math.min(Math.abs(a0), Math.abs(a1));
    return { pan: 1 / (this.rho * cosh(aPan)), zoom: this.rho * Math.max(Math.abs(tanh(a0)), Math.abs(tanh(a1))) };
  }
}

/**
 * Time warp for following a path: a trapezoidal speed profile with ramps of `ramp` of the
 * duration at each end and constant speed in the middle. Returns the fraction of the path done.
 */
export function trapezoid(t: number, T: number, ramp = 0.15): number {
  if (t <= 0) return 0;
  if (t >= T) return 1;
  const r = ramp * T;
  const vMax = 1 / (T - r); // area under the profile is 1
  if (t < r) return (0.5 * vMax * t * t) / r;
  if (t > T - r) { const q = T - t; return 1 - (0.5 * vMax * q * q) / r; }
  return 0.5 * vMax * r + vMax * (t - r);
}
/** Peak of d(trapezoid)/dt as a multiple of 1/T. */
export function trapezoidPeak(ramp = 0.15): number { return 1 / (1 - ramp); }
