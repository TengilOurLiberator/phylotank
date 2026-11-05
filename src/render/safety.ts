/**
 * Flash safety by construction (06 §6.1.7, CONTRACT 15, review R18 and R25).
 *
 * Layer 1, slow by construction: every on-screen pulse period is clamped per profile, pulses are
 * duty-shaped raised cosines with a capped depth, and emission follows its target through a
 * first-order slew with the profile's time constant.
 * Layer 2, red is special: saturated red gets a longer period and a shallower pulse.
 * Layer 3, the runtime net: a coarse luminance grid is watched for opposing transitions, and a
 * per-tile gain ramps emission down in a region that flashes; a whole-screen limiter keeps the
 * mean luminance change per second under the profile cap.
 *
 * Pure and deterministic given its inputs; the renderer feeds it wall time.
 */
import type { ViewProfile } from '../core/index.js';

/** The shortest on-screen period a pulse may have, in seconds. */
export function minPeriodS(profile: ViewProfile, red: boolean): number {
  const tMin = profile.mode === 'wallpaper' ? 1.0 : 0.5; // 06 §6.1.5 T_min(profile)
  let t = Math.max(tMin, 1 / profile.maxPulseHz);
  if (red) t = Math.max(t, 1 / profile.maxRedPulseHz, 2.0);
  return t;
}

/** Clamp a gene period to [minPeriod, 12 s] (06 §6.1.5). */
export function clampPeriodS(geneS: number, profile: ViewProfile, red: boolean): number {
  const lo = minPeriodS(profile, red);
  if (!(geneS > 0)) return 12;
  return Math.min(12, Math.max(lo, geneS));
}

/** How deep a pulse may modulate brightness (1 = fully off at the trough). */
export function maxPulseDepth(profile: ViewProfile, red: boolean): number {
  const base = profile.mode === 'wallpaper' ? 0.55 : 0.8;
  return red ? base * 0.6 : base;
}

/**
 * Duty-shaped raised cosine in [0, 1]: the bright part of the cycle widens with duty, but the
 * shape stays C1-smooth, so even the steepest edge is a quarter of a period long.
 */
export function pulseShape(tS: number, periodS: number, phase01: number, duty: number): number {
  const f = (((tS / periodS + phase01) % 1) + 1) % 1;
  const d = Math.min(0.8, Math.max(0.2, duty));
  // warp the cycle so the 'on' half takes a fraction d of the period
  const w = f < d ? 0.5 * (f / d) : 0.5 + 0.5 * ((f - d) / (1 - d));
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * w);
}

/** Intensity multiplier of a light organ at time t (06 §6.1.5 with the profile limits). */
export function organIntensity(
  tS: number, genePeriodS: number, phase01: number, duty: number, depth: number, profile: ViewProfile, red: boolean,
): number {
  const T = clampPeriodS(genePeriodS, profile, red);
  const dep = Math.min(depth, maxPulseDepth(profile, red));
  return 1 - dep + dep * pulseShape(tS, T, phase01, duty);
}

/** First-order slew toward a target with time constant tau (frame-rate independent). */
export function slew(current: number, target: number, dtS: number, tauS: number): number {
  if (tauS <= 0) return target;
  const a = 1 - Math.exp(-Math.max(0, dtS) / tauS);
  return current + (target - current) * a;
}

/** The free, dim, non-heritable baseline glow (William's Q5), in HDR units. */
export const BASELINE_GLOW = 0.16;

/**
 * Whole-screen luminance limiter: picks an exposure multiplier so that the displayed mean
 * luminance changes by at most `profile.maxLumaChangePerS` (relative) per second, and relaxes
 * towards 1 with a 4 s time constant at no more than 0.5 stops per second (06 §6.1.7 layer 1).
 */
export class LumaLimiter {
  exposure = 1;
  private shown = -1;
  private age = 0;
  /** `graceS`: the first seconds after start-up track freely (the page appearing is one transition, not a flash). */
  constructor(private readonly maxRelPerS: number, private readonly graceS = 1.5) {}
  /** `measured` is the mean scene luminance before exposure. Returns the new exposure. */
  update(measured: number, dtS: number): number {
    const dt = Math.min(0.25, Math.max(0, dtS));
    this.age += dt;
    if (this.age <= this.graceS) { this.shown = measured * this.exposure; return this.exposure; }
    // relax towards 1, limited to 0.5 stops per second
    const relaxed = slew(this.exposure, 1, dt, 4);
    const maxStep = 0.5 * dt;
    let e = Math.min(this.exposure * 2 ** maxStep, Math.max(this.exposure * 2 ** -maxStep, relaxed));
    if (measured > 1e-6) {
      if (this.shown < 0) this.shown = measured * e;
      const lo = this.shown * (1 - this.maxRelPerS * dt);
      const hi = this.shown * (1 + this.maxRelPerS * dt);
      const d = measured * e;
      if (d > hi) e = hi / measured; else if (d < lo) e = lo / measured;
      e = Math.min(4, Math.max(0.05, e));
      this.shown = measured * e;
    }
    this.exposure = e;
    return e;
  }
}

/**
 * Per-tile flash guard (06 §6.1.7 layer 3). Feed it the displayed relative luminance (0..1)
 * of each tile of a coarse grid, a few times a second or more. It counts opposing transitions
 * of at least 10% where the darker state is below 0.8 over the last second, and when the
 * flashing area exceeds 10% of the screen it ramps those tiles' gain down (up to 70% over
 * 300 ms) and recovers over 3 s.
 */
export class FlashGuard {
  readonly gain: Float32Array;
  /** Times the net engaged (should essentially never happen). */
  triggers = 0;
  private lo: Float32Array;
  private hi: Float32Array;
  private dir: Int8Array;
  private transitions: Float32Array[]; // ring of transition times per tile
  private head: Uint8Array;
  private flagged: Uint8Array;
  private started = false;
  constructor(readonly w: number, readonly h: number, private readonly maxTransitions = 2) {
    const n = w * h;
    this.gain = new Float32Array(n).fill(1);
    this.lo = new Float32Array(n);
    this.hi = new Float32Array(n);
    this.dir = new Int8Array(n);
    this.transitions = Array.from({ length: n }, () => new Float32Array(8).fill(-1e9));
    this.head = new Uint8Array(n);
    this.flagged = new Uint8Array(n);
  }
  /** Returns true if the guard is engaged this update. */
  update(lum: ArrayLike<number>, tS: number, dtS: number): boolean {
    const n = this.w * this.h;
    if (!this.started) {
      for (let i = 0; i < n; i++) { this.lo[i] = lum[i]!; this.hi[i] = lum[i]!; }
      this.started = true;
    }
    let flashing = 0;
    for (let i = 0; i < n; i++) {
      const v = lum[i]!;
      const t = step(v, i, this.lo, this.hi, this.dir);
      if (t) {
        const ring = this.transitions[i]!;
        ring[this.head[i]!] = tS;
        this.head[i] = (this.head[i]! + 1) % ring.length;
      }
      const ring = this.transitions[i]!;
      let c = 0;
      for (let k = 0; k < ring.length; k++) if (tS - ring[k]! <= 1) c++;
      this.flagged[i] = c >= this.maxTransitions ? 1 : 0;
      flashing += this.flagged[i]!;
    }
    const engaged = flashing > 0.1 * n;
    if (engaged) this.triggers++;
    const down = (0.7 * dtS) / 0.3, up = (0.7 * dtS) / 3;
    for (let i = 0; i < n; i++) {
      const g = this.gain[i]!;
      this.gain[i] = engaged && this.flagged[i] ? Math.max(0.3, g - down) : Math.min(1, g + up);
    }
    return engaged;
  }
}

/**
 * One step of the WCAG transition detector for sample `v` of series `i`: a transition is a change
 * of at least 0.1 relative luminance against the extreme since the last transition, opposite in
 * direction to the last one, where the darker state is below 0.8. Returns true on a transition.
 */
function step(v: number, i: number, lo: Float32Array, hi: Float32Array, dir: Int8Array): boolean {
  let hit = false;
  if (dir[i] !== 1 && v - lo[i]! >= 0.1 && lo[i]! < 0.8) { dir[i] = 1; hi[i] = v; hit = true; }
  else if (dir[i] !== -1 && hi[i]! - v >= 0.1 && v < 0.8) { dir[i] = -1; lo[i] = v; hit = true; }
  if (dir[i] === 1) hi[i] = Math.max(hi[i]!, v);
  else if (dir[i] === -1) lo[i] = Math.min(lo[i]!, v);
  else { hi[i] = Math.max(hi[i]!, v); lo[i] = Math.min(lo[i]!, v); }
  return hit;
}

/**
 * Offline flash analyser for tests and spike 6, after WCAG 2.3.1: a "general flash" is a
 * pair of opposing changes of at least 10% relative luminance where the darker state is below
 * 0.8; more than 3 flashes in any 1 s window fails. Input: one luminance sample per frame for
 * one region (for example the mean over a ninth of the screen). Returns the worst count of
 * flashes in any one-second window.
 */
export function worstFlashesPerSecond(lum: ArrayLike<number>, fps: number): number {
  const times: number[] = [];
  const lo = new Float32Array([lum[0] ?? 0]), hi = new Float32Array([lum[0] ?? 0]), dir = new Int8Array(1);
  for (let i = 1; i < lum.length; i++) if (step(lum[i]!, 0, lo, hi, dir)) times.push(i / fps);
  let worst = 0;
  for (let a = 0, b = 0; b < times.length; b++) {
    while (times[b]! - times[a]! > 1) a++;
    worst = Math.max(worst, Math.floor((b - a + 1) / 2));
  }
  return worst;
}

/** sRGB-encoded 0..1 value to WCAG relative luminance contribution. */
export function srgbToLinear(v: number): number { return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
