/**
 * Idle drift (06 §6.2.7, William's Q10): the wallpaper camera and the director's quiet-time
 * composition. Waypoints are drawn from the census heat map, weighted towards lit, lively places
 * the camera has not looked at lately, joined by a centripetal Catmull-Rom spline, with a slow
 * zoom breath and an Ornstein-Uhlenbeck wobble. Deterministic: one seeded RNG stream.
 */
import { clamp, exp, log, log2, pow, sin, TAU, type Draw, type RngStream } from '../core/index.js';

export interface HeatMap { w: number; h: number; ch: number; data: Uint8Array }

/** Heat-map channels (contract request docs/contract-requests/director.md): 0 biomass, 1 emissive, 2 activity. */
export const HEAT_BIOMASS = 0;
export const HEAT_EMISSIVE = 1;

export interface Waypoint { x: number; y: number; visH: number; t: number }

export interface DriftView { tankW: number; tankH: number; viewWpx: number; viewHpx: number }

function catmull(p0: number, p1: number, p2: number, p3: number, t0: number, t1: number, t2: number, t3: number, t: number): number {
  // Barry and Goldman's pyramidal formulation of the Catmull-Rom spline with knots t0..t3.
  const a1 = ((t1 - t) / (t1 - t0)) * p0 + ((t - t0) / (t1 - t0)) * p1;
  const a2 = ((t2 - t) / (t2 - t1)) * p1 + ((t - t1) / (t2 - t1)) * p2;
  const a3 = ((t3 - t) / (t3 - t2)) * p2 + ((t - t2) / (t3 - t2)) * p3;
  const b1 = ((t2 - t) / (t2 - t0)) * a1 + ((t - t0) / (t2 - t0)) * a2;
  const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
  return ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
}

export class DriftPlanner {
  private readonly wps: Waypoint[] = [];
  private zBaseVisH: number;
  private draws = 0;
  private ouX = 0;
  private ouY = 0;
  heat: HeatMap | null = null;

  constructor(private readonly rng: RngStream, private readonly view: DriftView, private readonly wobble: boolean) {
    this.zBaseVisH = view.tankH * 0.6;
  }

  private draw(): Draw { return this.rng.draw(this.draws++, 7); }

  /** Weight of a heat-map cell (before exposure). */
  private cellWeight(i: number): number {
    const h = this.heat!;
    const b = h.data[i * h.ch + HEAT_BIOMASS]! / 255;
    const e = h.ch > 1 ? h.data[i * h.ch + HEAT_EMISSIVE]! / 255 : 0;
    const v = e + 0.3 * b;
    return v > 0 ? pow(v, 0.7) : 0;
  }

  /** Choose the next waypoint. `regionLoad(x, y)` in [0, 1) is the exposure of that place. */
  private pick(tStart: number, regionLoad: (x: number, y: number) => number, prev: Waypoint | undefined): Waypoint {
    const d = this.draw();
    const { tankW, tankH } = this.view;
    let x = tankW * (0.2 + 0.6 * d.u01());
    let y = tankH * (0.25 + 0.5 * d.u01());
    const h = this.heat;
    if (h) {
      let total = 0;
      const n = h.w * h.h;
      const wts = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const cx = ((i % h.w) + 0.5) * (tankW / h.w);
        const cy = (Math.floor(i / h.w) + 0.5) * (tankH / h.h);
        const w = this.cellWeight(i) * (1 - regionLoad(cx, cy));
        wts[i] = w;
        total += w;
      }
      if (total > 0) {
        let r = d.u01x53() * total;
        let k = 0;
        for (; k < n - 1; k++) { r -= wts[k]!; if (r < 0) break; }
        x = ((k % h.w) + d.u01()) * (tankW / h.w);
        y = (Math.floor(k / h.w) + d.u01()) * (tankH / h.h);
      }
    }
    // zeta_base random-walks between "whole region" (the tank height) and "a single school" (3 m).
    const lo = log(3);
    const hi = log(tankH);
    let lz = log(this.zBaseVisH) + (d.u01() - 0.5) * 0.8;
    lz = clamp(lz, lo, hi);
    this.zBaseVisH = exp(lz);
    let visH = this.zBaseVisH;
    if (d.u01() < 0.1) visH = 0.25 + 0.5 * d.u01(); // a tight detail now and then (10%)
    // Segment duration 20 to 40 s, longer when the hop is far, so the drift speed stays slow.
    let dur = 20 + 20 * d.u01();
    if (prev) {
      const sw = Math.max(prev.visH, visH) * (this.view.viewWpx / this.view.viewHpx);
      const dist = Math.sqrt((x - prev.x) * (x - prev.x) + (y - prev.y) * (y - prev.y)) / sw;
      dur = Math.max(dur, dist / 0.03);
    }
    return { x, y, visH, t: tStart + dur };
  }

  /** The drift target at wall time t: centre and zeta (log2 px per metre). */
  target(t: number, dt: number, regionLoad: (x: number, y: number) => number, out: { x: number; y: number; zeta: number }): { x: number; y: number; zeta: number } {
    const wps = this.wps;
    if (wps.length === 0) {
      const { tankW, tankH } = this.view;
      wps.push({ x: tankW / 2, y: tankH / 2, visH: tankH * 0.8, t: t - 30 });
      wps.push({ x: tankW / 2, y: tankH / 2, visH: tankH * 0.8, t });
    }
    while (wps.length < 4) wps.push(this.pick(wps[wps.length - 1]!.t, regionLoad, wps[wps.length - 1]));
    while (t >= wps[2]!.t) { wps.shift(); wps.push(this.pick(wps[wps.length - 1]!.t, regionLoad, wps[wps.length - 1])); }
    const [p0, p1, p2, p3] = wps as [Waypoint, Waypoint, Waypoint, Waypoint];
    // Centripetal knots (alpha = 0.5) over (x, y, log visH), then the time maps onto [k1, k2] eased.
    const k = (a: Waypoint, b: Waypoint): number => {
      const dx = a.x - b.x; const dy = a.y - b.y; const dz = log(a.visH / b.visH) * 4;
      return Math.max(1e-3, pow(dx * dx + dy * dy + dz * dz, 0.25));
    };
    const k0 = 0;
    const k1 = k0 + k(p0, p1);
    const k2 = k1 + k(p1, p2);
    const k3 = k2 + k(p2, p3);
    const f = clamp((t - p1.t) / (p2.t - p1.t), 0, 1);
    const e = f * f * (3 - 2 * f);
    const kk = k1 + (k2 - k1) * e;
    const x = catmull(p0.x, p1.x, p2.x, p3.x, k0, k1, k2, k3, kk);
    const y = catmull(p0.y, p1.y, p2.y, p3.y, k0, k1, k2, k3, kk);
    const lv = catmull(log(p0.visH), log(p1.visH), log(p2.visH), log(p3.visH), k0, k1, k2, k3, kk);
    const visH = exp(lv);
    const sw = visH * (this.view.viewWpx / this.view.viewHpx);
    if (this.wobble && dt > 0) {
      // Ornstein-Uhlenbeck wobble: sigma 0.01 screen widths, mean reversion 0.05 /s.
      const d = this.draw();
      const th = 0.05;
      const s = 0.01 * Math.sqrt(2 * th * dt);
      this.ouX += -th * this.ouX * dt + s * d.normal();
      this.ouY += -th * this.ouY * dt + s * d.normal();
    }
    out.x = x + this.ouX * sw;
    out.y = y + this.ouY * sw;
    const breathe = this.wobble ? 0.3 * sin((TAU * t) / 90) : 0;
    out.zeta = log2(this.view.viewHpx / visH) + breathe;
    return out;
  }
}
