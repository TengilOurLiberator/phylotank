/**
 * Producers and nutrient cycling (04 §4.3, §4.4): the phytoplankton field, Lenia-style
 * mass-conserving benthic mats (photosynthetic on lit substrate, chemosynthetic at vents),
 * cysts, remineralisation, sediment, burial, the reservoir and the excess relaxation.
 *
 * Every change is an integer transfer between pools. Producer growth takes dissolved N through
 * a per-coarse-cell demand and resolve, so plankton and mats compete for the same nutrient
 * and no cell is overdrawn.
 */
import { exp, LN2, Q_MASS, type StepContext, type World } from '../core/index.js';
import { Dither, qRound, book } from './ledger.js';
import { P } from './params.js';
import { CH, scratch, type EcoState } from './state.js';
import { consumeO2, produceO2, tBase } from './env.js';

export function q10(T: number): number { return exp((LN2 * (T - P.tRefC)) / 10); }

/** Q10 factor per coarse cell: one exp per row unless a temperature anomaly is present. */
function cellQ10(world: World, s: EcoState): Float64Array {
  const f = world.fields;
  const [w, h] = f.coarse;
  const cs = world.preset.widthM / w;
  const out = scratch(s, 'q10c', w * h);
  for (let iy = 0; iy < h; iy++) {
    const tb = tBase(s, (iy + 0.5) * cs);
    const qr = q10(tb);
    for (let ix = 0; ix < w; ix++) {
      const i = iy * w + ix;
      const a = f.tAnom[i]!;
      out[i] = a === 0 ? qr : q10(tb + a);
    }
  }
  return out;
}
export function steele(I: number): number { const x = I / P.iK; return x * exp(1 - x); }

function inRegion(x: number, y: number, z: number[]): boolean {
  if (z[2]! < 0) return true;
  const dx = x - z[0]!, dy = y - z[1]!;
  return dx * dx + dy * dy <= z[2]! * z[2]!;
}

/** Build the Lenia ring kernel: K(r) = exp(4 - 1 / (r (1 - r))) on the ring 0 < r < 1, sum 1. */
export function ringKernel(R: number): { dx: Int32Array; dy: Int32Array; w: Float64Array } {
  const dx: number[] = [], dy: number[] = [], ww: number[] = [];
  let sum = 0;
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
    const r = Math.sqrt(x * x + y * y) / R;
    if (r <= 0 || r >= 1) continue;
    const k = exp(4 - 1 / (r * (1 - r)));
    if (k < 1e-6) continue;
    dx.push(x); dy.push(y); ww.push(k); sum += k;
  }
  return { dx: Int32Array.from(dx), dy: Int32Array.from(dy), w: Float64Array.from(ww.map((k) => k / sum)) };
}

/** Lenia growth mapping G(U) in [-1, 1]. */
export function leniaG(U: number): number {
  const d = U - P.mB;
  return 2 * exp(-(d * d) / (2 * P.sB * P.sB)) - 1;
}

/**
 * Producer reactions on the fine grid over dt (s): plankton growth and mortality, mats,
 * cyst germination. Called on slow ticks with dt = 0.5 s.
 */
export function stepProducers(world: World, s: EcoState, ctx: StepContext, dt: number): void {
  const f = world.fields;
  const [w, h] = f.coarse;
  const [fw, fh] = f.fine;
  const r = fw / w;
  const cs = world.preset.widthM / w;
  const fcs = world.preset.widthM / fw;
  const areaC = cs * cs, areaF = fcs * fcs;
  const nF = fw * fh;
  const demandP = scratch(s, 'demP', nF), demandBp = scratch(s, 'demBp', nF), demandBc = scratch(s, 'demBc', nF);
  const dsum = scratch(s, 'dsum', w * h);
  const dith = new Dither(ctx.rng, ctx.tick, 1);
  const muBoostGlobal = s.mods.muBoost;
  const blooms = s.mods.blooms;
  // cell-level environment cache per coarse cell
  const fN = scratch(s, 'fN', w * h), fT = scratch(s, 'fT', w * h), fL = scratch(s, 'fL', w * h), fS = scratch(s, 'fS', w * h);
  const qc = cellQ10(world, s);
  for (let iy = 0; iy < h; iy++) for (let ix = 0; ix < w; ix++) {
    const i = iy * w + ix;
    if (!s.wetC[i]) continue;
    const n = (f.qN[i]! * Q_MASS) / areaC;
    fN[i] = n / (n + P.kN);
    fT[i] = qc[i]!;
    fL[i] = steele(f.light[i]!);
    fS[i] = f.sulphur[i]! / (f.sulphur[i]! + P.kS);
  }
  // 1. plankton demand and mortality
  for (let jy = 0; jy < fh; jy++) {
    const iy = (jy / r) | 0;
    for (let jx = 0; jx < fw; jx++) {
      const j = jy * fw + jx;
      const p = f.qP[j]!;
      if (p <= 0 || !s.wetF[j]) continue;
      const i = iy * w + ((jx / r) | 0);
      let boost = muBoostGlobal;
      for (const b of blooms) if (inRegion((jx + 0.5) * fcs, (jy + 0.5) * fcs, b)) boost *= b[3]!;
      const mu = P.muMax * boost * fL[i]! * fN[i]! * fT[i]!;
      const d = qRound(mu * p * dt, dith.at(j * 2));
      demandP[j] = d;
      dsum[i] = dsum[i]! + d;
      const pd = (p * Q_MASS) / areaF;
      let loss = qRound((P.mP + P.mP2 * pd) * p * dt, dith.at(j * 2 + 1));
      if (loss > p) loss = p;
      if (loss > 0) { f.qP[j] = p - loss; f.qD[i] = f.qD[i]! + loss; book(world, CH.decay, loss); }
    }
  }
  // 2. mats on substrate (Lenia ring kernel on normalised density)
  const K = s.kernel;
  const sub = s.substrate;
  const dith2 = new Dither(ctx.rng, ctx.tick, 2);
  const bMaxQ = (P.bMax * areaF) / Q_MASS;
  for (let k = 0; k < sub.length; k++) {
    const j = sub[k]!;
    const jx = j % fw, jy = (j - jx) / fw;
    const i = ((jy / r) | 0) * w + ((jx / r) | 0);
    const m = s.subMask[k]!;
    for (let pass = 0; pass < 2; pass++) {
      const B = pass === 0 ? f.qBphoto : f.qBchemo;
      let U = 0;
      for (let t = 0; t < K.w.length; t++) {
        const x = jx + K.dx[t]!, y = jy + K.dy[t]!;
        if (x < 0 || y < 0 || x >= fw || y >= fh) continue;
        U += K.w[t]! * B[y * fw + x]!;
      }
      U /= bMaxQ;
      const G = leniaG(U);
      const b = B[j]!;
      const fE = pass === 0 ? fL[i]! : fS[i]!;
      if (G > 0) {
        const seedOk = b > 0 || U > 1e-4 || (pass === 0 ? f.qCyst[(jx / r) | 0]! > 0 : f.sulphur[i]! > 0.05);
        if (!seedOk || fE <= 0) continue;
        const grow = P.muB * fE * fN[i]! * fT[i]! * G * m * (b + (P.eSeed * areaF) / Q_MASS) * (1 - b / bMaxQ) * dt;
        const d = qRound(grow, dith2.at(k * 2 + pass));
        if (d > 0) {
          if (pass === 0) demandBp[j] = d; else demandBc[j] = d;
          dsum[i] = dsum[i]! + d;
        }
      } else if (b > 0) {
        let dec = qRound(P.dB * -G * b * dt, dith2.at(k * 2 + pass));
        if (dec > b) dec = b;
        if (dec > 0) { B[j] = b - dec; f.qD[i] = f.qD[i]! + dec; book(world, CH.decay, dec); }
      }
    }
  }
  // 3. resolve N per coarse cell and collect (pro rata, never overdrawn)
  const rho = scratch(s, 'rho', w * h);
  for (let i = 0; i < w * h; i++) { const D = dsum[i]!; rho[i] = D <= 0 ? 0 : Math.min(1, f.qN[i]! / D); }
  const take = (j: number, i: number, d: number, to: Float64Array, ch: number, o2: boolean): void => {
    let q = Math.floor(d * rho[i]!);
    if (q > f.qN[i]!) q = f.qN[i]!;
    if (q <= 0) return;
    f.qN[i] = f.qN[i]! - q;
    to[j] = to[j]! + q;
    if (o2) produceO2(world, i, q);
    book(world, ch, q);
  };
  for (let jy = 0; jy < fh; jy++) {
    const row = ((jy / r) | 0) * w;
    for (let jx = 0; jx < fw; jx++) {
      const j = jy * fw + jx;
      const d = demandP[j]!;
      if (d > 0) take(j, row + ((jx / r) | 0), d, f.qP, CH.photosynthesis, true);
    }
  }
  for (let k = 0; k < sub.length; k++) {
    const j = sub[k]!;
    const dp = demandBp[j]!, dc = demandBc[j]!;
    if (dp <= 0 && dc <= 0) continue;
    const jx = j % fw, jy = (j - jx) / fw;
    const i = ((jy / r) | 0) * w + ((jx / r) | 0);
    if (dp > 0) take(j, i, dp, f.qBphoto, CH.photosynthesis, true);
    if (dc > 0) take(j, i, dc, f.qBchemo, CH.chemosynthesis, false);
  }
  // coarse producer sums for the light scan (self-shading), cached until the next phase B
  let prodC = s.scratch.get('prodC');
  if (!prodC || prodC.length < w * h) { prodC = new Float64Array(w * h); s.scratch.set('prodC', prodC); }
  prodC.fill(0);
  for (let jy = 0; jy < fh; jy++) {
    const row = ((jy / r) | 0) * w;
    for (let jx = 0; jx < fw; jx++) {
      const j = jy * fw + jx;
      const q = f.qP[j]! + f.qBphoto[j]!;
      if (q > 0) { const k = row + ((jx / r) | 0); prodC[k] = prodC[k]! + q; }
    }
  }
  // 4. cysts: germinate under light and nutrient, or resuspend in fast water over the floor
  for (let ix = 0; ix < w; ix++) {
    const c = f.qCyst[ix]!;
    if (c <= 0) continue;
    const iy = s.floorRowC[ix]!;
    if (iy < 0) continue;
    const i = iy * w + ix;
    const n = (f.qN[i]! * Q_MASS) / areaC;
    const fast = Math.abs(f.flowU[i]!) + Math.abs(f.flowV[i]!) > P.cystResusp;
    if (!(fast || (f.light[i]! > P.cystLight && n > P.kN))) continue;
    const g = Math.min(c, qRound(P.cystGerm * c * dt, dith.at(nF * 2 + ix)));
    if (g <= 0) continue;
    const j = (iy * r + r - 1) * fw + ix * r + (r >> 1);
    f.qCyst[ix] = c - g;
    f.qP[j] = f.qP[j]! + g;
    book(world, CH.photosynthesis, 0);
  }
}

/** Remineralisation, sediment regeneration, burial, carcass-free cycling and excess relaxation. */
export function stepCycling(world: World, s: EcoState, ctx: StepContext, dt: number): void {
  const f = world.fields;
  const [w, h] = f.coarse;
  const cs = world.preset.widthM / w;
  const dith = new Dither(ctx.rng, ctx.tick, 3);
  const qc = cellQ10(world, s);
  for (let iy = 0; iy < h; iy++) for (let ix = 0; ix < w; ix++) {
    const i = iy * w + ix;
    const d = f.qD[i]!;
    if (d <= 0) continue;
    let m = qRound(P.rD * qc[i]! * d * dt, dith.at(i));
    if (m > d) m = d;
    if (m <= 0) continue;
    f.qD[i] = d - m; f.qN[i] = f.qN[i]! + m;
    consumeO2(world, i, m);
    book(world, CH.decay, m);
  }
  const nC = w * h;
  for (let ix = 0; ix < w; ix++) {
    const iy = s.floorRowC[ix]!;
    if (iy < 0) continue;
    const i = iy * w + ix;
    const sed = f.qSed[ix]!;
    if (sed > 0) {
      let reg = qRound(P.rSed * qc[i]! * sed * dt, dith.at(nC + ix * 3));
      if (reg > sed) reg = sed;
      f.qSed[ix] = sed - reg; f.qN[i] = f.qN[i]! + reg;
      consumeO2(world, i, reg);
      let bur = qRound(P.burial * f.qSed[ix]! * dt, dith.at(nC + ix * 3 + 1));
      if (bur > f.qSed[ix]!) bur = f.qSed[ix]!;
      f.qSed[ix] = f.qSed[ix]! - bur; world.g.qReservoir += bur;
    }
    const cy = f.qCyst[ix]!;
    if (cy > 0) { // old cysts slowly become sediment
      let old = qRound((0.01 / 1200) * cy * dt, dith.at(nC + ix * 3 + 2));
      if (old > cy) old = cy;
      f.qCyst[ix] = cy - old; f.qSed[ix] = f.qSed[ix]! + old;
    }
  }
  relaxExcess(world, s, dith, nC + 3 * w, dt);
}

/**
 * God-added mass relaxes (04 §4.4): the active mass (everything but the reservoir) drifts back
 * to its target with a 40-day half-life, by burial of dissolved N into the reservoir when in
 * excess, and by vents (or the deepest floor) returning reservoir mass when short.
 */
function relaxExcess(world: World, s: EcoState, dith: Dither, base: number, dt: number): void {
  const f = world.fields;
  const [w] = f.coarse;
  const active = world.g.mTotalQ - world.g.qReservoir;
  const target = world.g.mTargetQ - s.rActiveTargetQ;
  const ex = active - target;
  if (ex === 0) return;
  const amt = qRound((Math.abs(ex) * LN2 * dt) / P.excessHalfLife, dith.at(base));
  if (amt <= 0) return;
  if (ex > 0) {
    let sumN = 0;
    for (let i = 0; i < f.qN.length; i++) sumN += f.qN[i]!;
    if (sumN <= 0) return;
    const frac = Math.min(1, amt / sumN);
    let left = amt;
    for (let i = 0; i < f.qN.length && left > 0; i++) {
      const n = f.qN[i]!;
      if (n <= 0) continue;
      let m = Math.floor(n * frac + dith.at(base + 1 + (i & 4095)));
      if (m > n) m = n;
      if (m > left) m = left;
      f.qN[i] = n - m; world.g.qReservoir += m; left -= m;
    }
  } else {
    const m = Math.min(amt, world.g.qReservoir);
    if (m <= 0) return;
    const targets: number[] = [];
    const cs = world.preset.widthM / w;
    for (const v of s.terrain.vents) {
      const ix = Math.min(w - 1, Math.floor(v.x / cs));
      const iy = Math.max(0, Math.floor(v.y / cs) - 1);
      let i = iy * w + ix;
      if (!s.wetC[i]) i = Math.max(0, s.floorRowC[ix]!) * w + ix;
      targets.push(i);
    }
    if (targets.length === 0) for (let ix = 0; ix < w; ix += 8) if (s.floorRowC[ix]! >= 0) targets.push(s.floorRowC[ix]! * w + ix);
    if (targets.length === 0) return;
    const each = Math.floor(m / targets.length);
    let rem = m - each * targets.length;
    world.g.qReservoir -= m;
    for (const i of targets) { const add = each + (rem > 0 ? 1 : 0); if (rem > 0) rem--; f.qN[i] = f.qN[i]! + add; }
  }
}
