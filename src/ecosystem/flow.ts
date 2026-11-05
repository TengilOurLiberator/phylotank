/**
 * The streamfunction current field (04 §4.2): seeded Ornstein-Uhlenbeck mode amplitudes, vent
 * plume vortex pairs and the SDF ramp, which drives the normal velocity to zero at rock.
 *
 * psi_b = psi * R(sdf / d0), R(r) = 15/8 r - 10/8 r^3 + 3/8 r^5 on [0, 1].
 * `flowAt` differentiates psi_b analytically (the bilinear SDF has a symmetric mixed
 * derivative, so the point field is divergence-free inside every SDF cell). Transport uses face
 * fluxes taken as differences of psi_b at cell corners, which are discretely divergence-free
 * by telescoping, so tracers never pile up.
 */
import { cos, DT, exp, PI, RNG_STREAM, sin, SLOW_EVERY, type StepContext, type World } from '../core/index.js';
import { P } from './params.js';
import type { EcoState } from './state.js';
import { sampleSdf } from './terrain.js';

/** Flow modes (04 §4.2): each mode m is (kx index, ky index, mean amplitude m/s). */
export const FLOW_MODES: readonly (readonly [number, number, number])[] = [
  [1, 1, 0.03], [2, 1, 0.015], [1, 2, 0.015], [3, 2, 0.008], [4, 3, 0.005],
];
/** OU time constant of the mode amplitudes, sim seconds (3 days in 04; shorter keeps phase 0 lively). */
export const FLOW_TAU_S = 600;
const FLOW_SIGMA = 0.6; // relative OU noise

export function initFlowModes(world: World, ctx: StepContext): void {
  const d = ctx.rng.draw(RNG_STREAM.WORLDGEN, 0, 1);
  FLOW_MODES.forEach(([, , a], m) => {
    world.g.flowModes[m] = a * (d.u01() < 0.5 ? -1 : 1) * (0.5 + d.u01());
  });
}

/** One OU step of the mode amplitudes on a slow tick. `mult` and `flip` come from god powers. */
export function stepFlowModes(world: World, ctx: StepContext, mult: Float64Array, flip: boolean): void {
  const dt = SLOW_EVERY * DT;
  const d = ctx.rng.draw(RNG_STREAM.ECOLOGY, ctx.tick, 0);
  const k = dt / FLOW_TAU_S;
  FLOW_MODES.forEach(([, , mean], m) => {
    const a = world.g.flowModes[m]!;
    const sign = (a >= 0 ? 1 : -1) * (flip ? -1 : 1);
    const target = sign * mean * mult[m]!;
    world.g.flowModes[m] = a + (target - a) * k + FLOW_SIGMA * mean * Math.sqrt(2 * k) * d.normal();
  });
}

function ramp(r: number): number {
  if (r <= 0) return 0;
  if (r >= 1) return 1;
  const r2 = r * r;
  return r * (15 / 8 - (10 / 8) * r2 + (3 / 8) * r2 * r2);
}
function rampD(r: number): number {
  if (r <= 0 || r >= 1) return 0;
  const q = 1 - r * r;
  return (15 / 8) * q * q;
}

const sd = new Float64Array(3);
const ps = new Float64Array(3);

/** Raw streamfunction and its gradient at (x, y): out = [psi, psi_x, psi_y]. */
/**
 * Smoothed local floor depth per coarse column (first solid coarse row below the surface,
 * box-smoothed over +-1 m, at least 1 m). The modes follow the terrain: psi_m vanishes at
 * the local floor, so the SDF ramp never has to cancel a tank-scale psi and no boundary jets
 * form; only caves and overhangs rely on the ramp.
 */
export function computeHFloor(world: World, s: EcoState): void {
  const [w, h] = world.fields.coarse;
  const cs = world.preset.widthM / w;
  const raw = new Float64Array(w);
  for (let ix = 0; ix < w; ix++) {
    let iy = 0;
    while (iy < h && s.wetC[iy * w + ix]) iy++;
    raw[ix] = Math.max(1, iy * cs);
  }
  const k = Math.max(1, Math.round(1 / cs));
  for (let ix = 0; ix < w; ix++) {
    let t = 0, n = 0;
    for (let d = -k; d <= k; d++) { const j = ix + d; if (j >= 0 && j < w) { t += raw[j]!; n++; } }
    s.hFloor[ix] = t / n;
  }
}

const hh = new Float64Array(2);
/** Local floor depth and its x-derivative (linear between coarse column centres). */
function hAt(world: World, s: EcoState, x: number, out: Float64Array): void {
  const w = s.hFloor.length;
  const cs = world.preset.widthM / w;
  let g = x / cs - 0.5;
  g = g < 0 ? 0 : g > w - 1.000001 ? w - 1.000001 : g;
  const i = Math.floor(g), t = g - i;
  const a = s.hFloor[i]!, b = s.hFloor[i + 1]!;
  out[0] = a + (b - a) * t;
  out[1] = (x / cs - 0.5 < 0 || x / cs - 0.5 > w - 1.000001) ? 0 : (b - a) / cs;
}

/** Raw streamfunction and its gradient at (x, y): out = [psi, psi_x, psi_y]. */
function psiRaw(world: World, s: EcoState, x: number, y: number, out: Float64Array): void {
  const vents = s.terrain.vents;
  const W = world.preset.widthM, H = world.preset.heightM;
  hAt(world, s, x, hh);
  const hf = hh[0]!, hx = hh[1]!;
  const g = hf / H, gx = hx / H;
  let p = 0, px = 0, py = 0;
  for (let m = 0; m < FLOW_MODES.length; m++) {
    const [i, j] = FLOW_MODES[m]!;
    const a = world.g.flowModes[m]!;
    const kx = (i * PI) / W, k = (j * PI) / H;
    const th = (j * PI * y) / hf, thx = (-j * PI * y * hx) / (hf * hf);
    const sx = sin(kx * x), cx = cos(kx * x), st = sin(th), ct = cos(th);
    const A = a / k;
    p += A * g * sx * st;
    px += A * (gx * sx * st + g * kx * cx * st + g * sx * ct * thx);
    py += a * sx * ct;
  }
  const s2 = P.ventPlumeR * P.ventPlumeR;
  for (const v of vents) {
    const dx = x - v.x, dy = y - v.y;
    const r2 = (dx * dx + dy * dy) / s2;
    if (r2 > 25) continue;
    const e = exp(-r2);
    const A = P.ventPlume * v.output * P.ventPlumeR;
    // psi = A (dx / R) exp(-r^2): rising water above the vent (v < 0 on the axis)
    p += (A * dx / P.ventPlumeR) * e;
    px += (A / P.ventPlumeR) * e * (1 - (2 * dx * dx) / s2);
    py += (A * dx / P.ventPlumeR) * e * ((-2 * dy) / s2);
  }
  out[0] = p; out[1] = px; out[2] = py;
}

/** psi_b at (x, y). */
export function psiAt(world: World, s: EcoState, x: number, y: number): number {
  psiRaw(world, s, x, y, ps);
  sampleSdf(world, x, y, sd);
  return ps[0]! * ramp(sd[0]! / P.d0);
}

/** Analytic water velocity at (x, y), m/s. */
export function flowAtPoint(world: World, s: EcoState, x: number, y: number, out: Float64Array): void {
  psiRaw(world, s, x, y, ps);
  sampleSdf(world, x, y, sd);
  const r = sd[0]! / P.d0;
  const R = ramp(r), Rd = rampD(r) / P.d0;
  out[0] = ps[2]! * R + ps[0]! * Rd * sd[2]!;
  out[1] = -(ps[1]! * R + ps[0]! * Rd * sd[1]!);
}

/** Rebuild psi at coarse corners, coarse and fine face fluxes, and the flowU/flowV grids. */
export function rebuildFlow(world: World, s: EcoState): void {
  const f = world.fields;
  const [w, h] = f.coarse;
  const cs = world.preset.widthM / w;
  const W1 = w + 1, H1 = h + 1;
  const psi = s.psiC;
  for (let iy = 0; iy < H1; iy++) {
    for (let ix = 0; ix < W1; ix++) {
      const onEdge = ix === 0 || iy === 0 || ix === w || iy === h;
      psi[iy * W1 + ix] = onEdge ? 0 : psiAt(world, s, ix * cs, iy * cs);
    }
  }
  // no flux into solid cells: psi is constant (zero) on every corner a solid cell touches
  for (let iy = 0; iy < h; iy++) for (let ix = 0; ix < w; ix++) {
    if (s.wetC[iy * w + ix]) continue;
    psi[iy * W1 + ix] = 0; psi[iy * W1 + ix + 1] = 0; psi[(iy + 1) * W1 + ix] = 0; psi[(iy + 1) * W1 + ix + 1] = 0;
  }
  const uF = s.uFace, vF = s.vFace;
  for (let iy = 0; iy < h; iy++) for (let ix = 0; ix < W1; ix++) uF[iy * W1 + ix] = psi[(iy + 1) * W1 + ix]! - psi[iy * W1 + ix]!;
  for (let iy = 0; iy < H1; iy++) for (let ix = 0; ix < w; ix++) vF[iy * w + ix] = -(psi[iy * W1 + ix + 1]! - psi[iy * W1 + ix]!);
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      const i = iy * w + ix;
      f.flowU[i] = (0.5 * (uF[iy * W1 + ix]! + uF[iy * W1 + ix + 1]!)) / cs;
      f.flowV[i] = (0.5 * (vF[iy * w + ix]! + vF[(iy + 1) * w + ix]!)) / cs;
    }
  }
}

/** Fine-grid face fluxes from the coarse corner psi (bilinear, still telescoping). */
export function rebuildFineFlux(world: World, s: EcoState): void {
  const f = world.fields;
  const [w, h] = f.coarse;
  const W1 = w + 1;
  const psi = s.psiC;
  // Fine faces: psi bilinear from the coarse corners (still telescoping, still divergence-free).
  const [fw, fh] = f.fine;
  const r = fw / w;
  const FW1 = fw + 1;
  const psiF = s.scratch.get('psiF') ?? new Float64Array(FW1 * (fh + 1));
  s.scratch.set('psiF', psiF);
  for (let jy = 0; jy <= fh; jy++) {
    const gy = jy / r, iy = Math.min(Math.floor(gy), h - 1), ty = gy - iy;
    for (let jx = 0; jx <= fw; jx++) {
      const gx = jx / r, ix = Math.min(Math.floor(gx), w - 1), tx = gx - ix;
      const a = psi[iy * W1 + ix]!, b = psi[iy * W1 + ix + 1]!, c = psi[(iy + 1) * W1 + ix]!, d = psi[(iy + 1) * W1 + ix + 1]!;
      psiF[jy * FW1 + jx] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  for (let jy = 0; jy < fh; jy++) for (let jx = 0; jx < fw; jx++) {
    if (s.wetF[jy * fw + jx]) continue;
    psiF[jy * FW1 + jx] = 0; psiF[jy * FW1 + jx + 1] = 0; psiF[(jy + 1) * FW1 + jx] = 0; psiF[(jy + 1) * FW1 + jx + 1] = 0;
  }
  const uFF = s.uFaceF, vFF = s.vFaceF;
  for (let jy = 0; jy < fh; jy++) for (let jx = 0; jx < FW1; jx++) uFF[jy * FW1 + jx] = psiF[(jy + 1) * FW1 + jx]! - psiF[jy * FW1 + jx]!;
  for (let jy = 0; jy <= fh; jy++) for (let jx = 0; jx < fw; jx++) vFF[jy * fw + jx] = -(psiF[jy * FW1 + jx + 1]! - psiF[jy * FW1 + jx]!);
}
