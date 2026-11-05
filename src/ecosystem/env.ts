/**
 * Light with depth, temperature with the seasonal thermocline, oxygen, vent sulphur and
 * turbidity (04 §4.2). Runs on slow ticks (2 Hz); creatures read the grids.
 */
import {
  clamp, cos, DAY_S, DT, exp, FINE_CELL_M, MATERIAL, PI, Q_MASS, sigmoid, sin, smoothstep, TAU, YEAR_DAYS,
  type World,
} from '../core/index.js';
import { P } from './params.js';
import type { EcoState } from './state.js';

export function dayLength(world: World): number { return world.config.dayS ?? DAY_S; }
export function yearLength(world: World): number { return dayLength(world) * (world.config.yearDays ?? YEAR_DAYS); }

/** Recompute the environment scalars for the current tick (clocks, surface light, thermocline). */
export function updateEnv(world: World, s: EcoState): void {
  const t = world.g.tick * DT;
  const D = dayLength(world), Y = yearLength(world);
  const dayPhase = (t % D) / D;
  let yearPhase = (t % Y) / Y + s.yearOffset;
  yearPhase -= Math.floor(yearPhase);
  const th = TAU * dayPhase;
  const season = sin(TAU * yearPhase);
  const e = -cos(th) + 0.3 * season;
  const a = smoothstep(-0.05, 0.35, e);
  const surfLight = clamp((0.74 * (1 + P.aI * season) * a) * s.mods.lightMult + P.iMoon, 0, 1);
  const scale = world.preset.heightM / 36;
  const tSurf = P.tMean + s.terrain.tOffset + P.aSeason * sin(TAU * yearPhase - PI / 2) + P.aDay * sin(th - PI / 2) + s.mods.tempOffset;
  const winterness = 0.5 * (1 - sin(TAU * yearPhase - PI / 2));
  const yTh = (P.yThSummer36 + (P.yThWinter36 - P.yThSummer36) * winterness) * scale;
  const strat = clamp((tSurf - P.tDeep) / 10, 0, 1);
  s.env = { t, dayPhase, yearPhase, surfLight, tSurf, yTh, wTh: P.wTh36 * scale, strat, ySurface: world.g.ySurface };
}

/** Baseline temperature at depth y (no anomaly), C. */
export function tBase(s: EcoState, y: number): number {
  const e = s.env;
  return P.tDeep + (e.tSurf - P.tDeep) * sigmoid((e.yTh - y) / e.wTh);
}

/** Water temperature at (x, y), C. */
export function temperatureAt(world: World, s: EcoState, x: number, y: number): number {
  return tBase(s, y) + world.fields.tAnom[coarseIndex(world, x, y)]!;
}

export function coarseIndex(world: World, x: number, y: number): number {
  const [w, h] = world.fields.coarse;
  const cs = world.preset.widthM / w;
  const ix = clamp(Math.floor(x / cs), 0, w - 1), iy = clamp(Math.floor(y / cs), 0, h - 1);
  return iy * w + ix;
}
export function fineIndex(world: World, x: number, y: number): number {
  const [w, h] = world.fields.fine;
  const ix = clamp(Math.floor(x / FINE_CELL_M), 0, w - 1), iy = clamp(Math.floor(y / FINE_CELL_M), 0, h - 1);
  return iy * w + ix;
}

/**
 * Vertical diffusivity per horizontal face row (rows + 1 entries): winter turnover above the
 * winter mixed layer (Sverdrup), storms in the top 10 m. On a grid finer than the coarse one
 * (`sub` > 1 rows per coarse row) the turbulent part acts only across coarse-row faces with the
 * coarse-spacing gradient (K / sub on the fine spacing), which is the coarse discretisation of
 * the same diffusion and keeps the fine plankton pass free of extra substeps.
 */
export function kzRows(world: World, s: EcoState, rows: number, cellM: number, sub = 1): Float64Array {
  const kz = new Float64Array(rows + 1);
  const scale = world.preset.heightM / 36;
  const mixedDepth = P.yThWinter36 * scale;
  for (let iy = 0; iy <= rows; iy++) {
    const y = iy * cellM;
    let k = P.kz0 + (y < mixedDepth ? P.kMix * (1 - s.env.strat) : 0);
    if (y < 10 * scale) k *= s.mods.kzMult;
    kz[iy] = sub === 1 ? k : iy % sub === 0 ? Math.max(P.kh, k / sub) : P.kh;
  }
  return kz;
}

/** Beer-Lambert column scan with self-shading, turbidity, ice and opaque rock, plus a 3-tap blur. */
export function scanLight(world: World, s: EcoState): void {
  const f = world.fields;
  const [w, h] = f.coarse;
  const [fw] = f.fine;
  const [sw] = f.sdfGrid;
  const cs = world.preset.widthM / w;
  const r = fw / w, rs = sw / w;
  const cellArea = cs * cs;
  const raw = new Float64Array(w * h);
  for (let ix = 0; ix < w; ix++) {
    let I = s.env.surfLight;
    for (let iy = 0; iy < h; iy++) {
      const i = iy * w + ix;
      // producers in this coarse cell (kg/m^2)
      let q = 0;
      for (let jy = iy * r; jy < (iy + 1) * r; jy++) for (let jx = ix * r; jx < (ix + 1) * r; jx++) {
        const j = jy * fw + jx; q += f.qP[j]! + f.qBphoto[j]!;
      }
      const dens = (q * Q_MASS) / cellArea;
      let solid = 0, ice = 0;
      for (let ky = iy * rs; ky < (iy + 1) * rs; ky++) for (let kx = ix * rs; kx < (ix + 1) * rs; kx++) {
        const m = f.material[ky * sw + kx]!;
        if (m === MATERIAL.ICE) ice++; else if (m !== MATERIAL.WATER) solid++;
      }
      const n = rs * rs;
      const k = P.kW + P.kChl * dens + P.kTurb * f.turb[i]! + (P.kIce * ice) / n + (40 * solid) / n;
      const att = exp(-k * cs);
      raw[i] = s.wetC[i] ? I * exp(-0.5 * k * cs) : 0;
      I *= att;
    }
  }
  for (let iy = 0; iy < h; iy++) for (let ix = 0; ix < w; ix++) {
    const i = iy * w + ix;
    if (!s.wetC[i]) { f.light[i] = 0; continue; }
    const l = ix > 0 ? raw[i - 1]! : 0, rr = ix < w - 1 ? raw[i + 1]! : 0;
    f.light[i] = Math.min(1, raw[i]! + P.blur * 0.5 * (l + rr));
  }
}

/** Oxygen saturation at temperature T (04 §4.2). */
export function oSat(T: number): number { return Math.max(0.2, 1 - 0.02 * (T - 15)); }

/** Use up oxygen for q quanta of matter burnt or remineralised in coarse cell i. */
export function consumeO2(world: World, i: number, q: number): void {
  const [w] = world.fields.coarse;
  const cs = world.preset.widthM / w;
  const o = world.fields.o2;
  const v = o[i]! - (q * Q_MASS) / (cs * cs * P.oxCap);
  o[i] = v < 0 ? 0 : v;
}
export function produceO2(world: World, i: number, q: number): void {
  const [w] = world.fields.coarse;
  const cs = world.preset.widthM / w;
  const o = world.fields.o2;
  o[i] = Math.min(2, o[i]! + (q * Q_MASS) / (cs * cs * P.oxCap));
}

function inRegion(x: number, y: number, z: number[]): boolean {
  if (z[2]! < 0) return true;
  const dx = x - z[0]!, dy = y - z[1]!;
  return dx * dx + dy * dy <= z[2]! * z[2]!;
}

/** Surface exchange, temperature anomaly relaxation and vents, sulphur, turbidity settling. */
export function stepChemistry(world: World, s: EcoState, dt: number): void {
  const f = world.fields;
  const [w, h] = f.coarse;
  const cs = world.preset.widthM / w;
  const relaxT = exp(-dt / P.tauT), decS = exp(-dt / P.sulphurTau), settle = exp(-P.turbSettle * dt);
  for (let iy = 0; iy < h; iy++) {
    const y = (iy + 0.5) * cs;
    for (let ix = 0; ix < w; ix++) {
      const i = iy * w + ix;
      f.tAnom[i] = f.tAnom[i]! * relaxT;
      f.sulphur[i] = f.sulphur[i]! * decS;
      f.turb[i] = f.turb[i]! * settle + s.mods.turbAdd * dt;
      if (!s.wetC[i]) continue;
      const x = (ix + 0.5) * cs;
      let dz = false;
      for (const z of s.mods.deadZones) if (inRegion(x, y, z)) { dz = true; f.o2[i] = Math.min(f.o2[i]!, z[3]!); }
      const top = iy === 0 || !s.wetC[i - w];
      if (top && !dz && y < s.env.ySurface + cs * 1.5) {
        const T = tBase(s, y) + f.tAnom[i]!;
        const iced = s.mods.iceDrop > 0 ? 0.3 : 1;
        f.o2[i] = f.o2[i]! + P.kAir * iced * dt * (oSat(T) - f.o2[i]!) * 60;
      }
    }
  }
  // vents: heat and sulphur, never mass (vent nutrient comes from the reservoir in cycling)
  for (const v of s.terrain.vents) {
    const i = coarseIndex(world, v.x, v.y - 0.5 * cs);
    const T0 = tBase(s, v.y);
    f.tAnom[i] = f.tAnom[i]! + (P.ventT * v.output + T0 * 0 - T0 - f.tAnom[i]!) * Math.min(1, dt / 30);
    f.sulphur[i] = f.sulphur[i]! + P.sulphurRate * v.output * dt;
  }
}
