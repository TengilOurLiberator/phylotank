/**
 * Cross-creature contacts at tick rate (02 §2.4.1, §2.7.5, REVIEW R5, R6): a hierarchical
 * spatial hash ordered by (cell key, slot), capsule narrow phase, inelastic normal impulses with
 * Coulomb friction, Jacobi position corrections in fixed point, depenetration capped at
 * 0.5 body lengths per second, and no velocity from position corrections (so contacts can only
 * remove kinetic energy; the removed energy is logged as contact heat). Bites resolve on the
 * same contact list. Terrain uses the SDF grid.
 */
import {
  KIND, LIFE, MOUTH_SUBTYPE, ORGAN, PI, type StepContext, type World,
} from '../core/index.js';
import { SC, sincos } from './sincos.js';
import { isPlate, segVolume } from './body.js';

/** Ram damage threshold (J/m^3) and toughness (J/m^3), starting values. */
export const E_THR_RAM = 50;
export const TOUGHNESS = 2e3;
import { LINK, addLink, hasLink, linkState, ownsLink, tryGrab, tryLatch } from './links.js';

/** Jaw-lock break force: the bite force of the mouth (02 §2.4.4). */
function jawBreak(rm: number): number { return SIGMA_JAW * 0.3 * PI * rm * rm * 3; }
import {
  BITE_OFF, BITE_ON, CONTACT_FRICTION, C_BITE, DEPEN_BL_PER_S, FIX_POS, H_TISSUE, RHO_TISSUE, SIGMA_JAW,
} from './constants.js';
import type { PhysicsOptions } from './solver.js';
import type { Work } from './work.js';

export const HASH_LEVELS = 8;
const CELL0 = 1e-3;
const LEVEL_SIZE = [1, 4, 16, 64, 256, 1024, 4096, 16384].map((k) => k * CELL0);
/** Candidate cap per item. REVIEW R5: on CPU the work is bounded by cells visited (at most 8 levels x 9), not by objects found, so contacts are never dropped; the cap is only a safety net. */
export const MAX_CANDIDATES = 1 << 20;

export interface SpatialHash {
  n: number;
  /** Items sorted by (bucket, slot). */
  items: Int32Array;
  /** Per segment slot: level and integer cell coordinates (for exact cell checks). */
  level: Uint8Array;
  cx: Int32Array;
  cy: Int32Array;
  /** Bucket table (power of two): start offsets into items, length T + 1. */
  start: Int32Array;
  mask: number;
  levelMask: number;
  bucketOf: Int32Array;
}

/** Bounding radius including the speculative margin |v| dt (02 §2.4.1). */
function bound(sg: World['seg']['c'], i: number, dt: number): number {
  const v = Math.sqrt(sg.velX[i]! * sg.velX[i]! + sg.velY[i]! * sg.velY[i]!) + Math.abs(sg.angVel[i]!) * 0.5 * sg.len[i]!;
  return 0.5 * sg.len[i]! + sg.radius[i]! + 0.5 * v * dt;
}

export function levelFor(R: number): number {
  let l = 0;
  while (l < HASH_LEVELS - 1 && LEVEL_SIZE[l]! < 2 * R) l++;
  return l;
}

function bucket(l: number, ix: number, iy: number, mask: number): number {
  return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(l, 83492791)) & mask;
}

/**
 * Build the hash over the segments of live bodies by a counting sort over hashed cells.
 * Items are scattered in ascending slot order, so each bucket lists its items by slot: the
 * order is (bucket, slot), a deterministic function of the state (CONTRACT 4.2 rule 4).
 */
export function buildHash(world: World, hs?: SpatialHash, dt = 1 / 30): SpatialHash {
  const c = world.cr.c;
  const sg = world.seg.c;
  let n = 0;
  for (let s = 0; s < world.cr.highWater; s++) {
    const life = c.life[s];
    if ((life === LIFE.ALIVE || life === LIFE.CARCASS) && c.segCount[s]! > 0) n += c.segCount[s]!;
  }
  let T = 16;
  while (T < 2 * n) T *= 2;
  if (!hs || hs.items.length < n || hs.start.length < T + 1) {
    const cap = world.seg.capacity;
    hs = {
      n: 0, items: new Int32Array(Math.max(16, n * 2)), level: new Uint8Array(cap), cx: new Int32Array(cap), cy: new Int32Array(cap),
      start: new Int32Array(Math.max(T, 16) * 2 + 1), mask: 0, levelMask: 0, bucketOf: new Int32Array(cap),
    };
  }
  hs.mask = T - 1;
  hs.levelMask = 0;
  const start = hs.start;
  start.fill(0, 0, T + 1);
  let m = 0;
  for (let s = 0; s < world.cr.highWater; s++) {
    const life = c.life[s];
    if ((life !== LIFE.ALIVE && life !== LIFE.CARCASS) || c.segCount[s] === 0) continue;
    const s0 = c.segStart[s]!;
    for (let k = 0; k < c.segCount[s]!; k++) {
      const i = s0 + k;
      const l = levelFor(bound(sg, i, dt));
      const cs = LEVEL_SIZE[l]!;
      const ix = Math.floor(sg.posX[i]! / cs); const iy = Math.floor(sg.posY[i]! / cs);
      hs.level[i] = l; hs.cx[i] = ix; hs.cy[i] = iy;
      hs.levelMask |= 1 << l;
      const b = bucket(l, ix, iy, hs.mask);
      hs.bucketOf[i] = b;
      start[b + 1] = start[b + 1]! + 1;
      m++;
    }
  }
  for (let b = 0; b < T; b++) start[b + 1] = start[b + 1]! + start[b]!;
  // scatter in ascending slot order (fill cursors in a copy of start)
  const fill = hs.items; // reuse: two passes below
  void fill;
  const cursor = new Int32Array(start.subarray(0, T));
  for (let s = 0; s < world.cr.highWater; s++) {
    const life = c.life[s];
    if ((life !== LIFE.ALIVE && life !== LIFE.CARCASS) || c.segCount[s] === 0) continue;
    const s0 = c.segStart[s]!;
    for (let k = 0; k < c.segCount[s]!; k++) {
      const i = s0 + k;
      const b = hs.bucketOf[i]!;
      hs.items[cursor[b]!] = i;
      cursor[b] = cursor[b]! + 1;
    }
  }
  hs.n = m;
  return hs;
}

/**
 * Visit candidate pairs (i, j) for item i: its own level and every coarser occupied level,
 * 3x3 cells each. Each overlapping pair is reported once (by the finer item; equal levels by
 * the lower slot). Returns the number of cells visited.
 */
export function queryPairs(
  world: World, hs: SpatialHash, i: number, visit: (i: number, j: number) => void, maxCandidates = MAX_CANDIDATES,
): number {
  const sg = world.seg.c;
  const li = hs.level[i]!;
  const x = sg.posX[i]!; const y = sg.posY[i]!;
  let cells = 0; let found = 0;
  for (let l = li; l < HASH_LEVELS; l++) {
    if ((hs.levelMask & (1 << l)) === 0) continue;
    const cs = LEVEL_SIZE[l]!;
    const ix = Math.floor(x / cs); const iy = Math.floor(y / cs);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        cells++;
        const qx = ix + dx; const qy = iy + dy;
        const b = bucket(l, qx, qy, hs.mask);
        const en = hs.start[b + 1]!;
        for (let q = hs.start[b]!; q < en; q++) {
          const j = hs.items[q]!;
          if (hs.level[j] !== l || hs.cx[j] !== qx || hs.cy[j] !== qy) continue;
          if (l === li && j <= i) continue;
          visit(i, j);
          if (++found >= maxCandidates) return cells;
        }
      }
    }
  }
  return cells;
}

/**
 * Perception-style radius query (REVIEW R5): visit items within `R` of (x, y), skipping levels
 * whose items subtend less than `minAngle` at that distance, and stopping after `maxCells`
 * cell visits. Returns the number of cells visited.
 */
export function queryRadius(
  world: World, hs: SpatialHash, x: number, y: number, R: number, minAngle: number, maxCells: number,
  visit: (j: number) => void,
): number {
  const sg = world.seg.c;
  let cells = 0;
  for (let l = HASH_LEVELS - 1; l >= 0; l--) {
    if ((hs.levelMask & (1 << l)) === 0) continue;
    const cs = LEVEL_SIZE[l]!;
    // items at level l have size about cs / 2 or more; skip if they look smaller than minAngle at R
    if (l > 0 && (cs / 4) / R < minAngle) break;
    if (l === 0 && (cs / 4) / R < minAngle) break;
    const x0 = Math.floor((x - R) / cs); const x1 = Math.floor((x + R) / cs);
    const y0 = Math.floor((y - R) / cs); const y1 = Math.floor((y + R) / cs);
    for (let qy = y0; qy <= y1; qy++) {
      for (let qx = x0; qx <= x1; qx++) {
        if (++cells > maxCells) return cells;
        const b = bucket(l, qx, qy, hs.mask);
        const en = hs.start[b + 1]!;
        for (let q = hs.start[b]!; q < en; q++) {
          const j = hs.items[q]!;
          if (hs.level[j] !== l || hs.cx[j] !== qx || hs.cy[j] !== qy) continue;
          const ddx = sg.posX[j]! - x; const ddy = sg.posY[j]! - y;
          if (ddx * ddx + ddy * ddy <= R * R) visit(j);
        }
      }
    }
  }
  return cells;
}

/** Closest points between two segments (capsule axes); writes [pax, pay, pbx, pby]. */
export function closestSegSeg(
  ax0: number, ay0: number, ax1: number, ay1: number, bx0: number, by0: number, bx1: number, by1: number,
  out: Float64Array,
): void {
  const d1x = ax1 - ax0; const d1y = ay1 - ay0; const d2x = bx1 - bx0; const d2y = by1 - by0;
  const rx = ax0 - bx0; const ry = ay0 - by0;
  const a = d1x * d1x + d1y * d1y; const e = d2x * d2x + d2y * d2y; const f = d2x * rx + d2y * ry;
  let s: number; let t: number;
  if (a <= 1e-30 && e <= 1e-30) { s = 0; t = 0; } else if (a <= 1e-30) { s = 0; t = clamp01(f / e); } else {
    const cc = d1x * rx + d1y * ry;
    if (e <= 1e-30) { t = 0; s = clamp01(-cc / a); } else {
      const b = d1x * d2x + d1y * d2y;
      const den = a * e - b * b;
      s = den > 1e-30 ? clamp01((b * f - cc * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-cc / a); } else if (t > 1) { t = 1; s = clamp01((b - cc) / a); }
    }
  }
  out[0] = ax0 + d1x * s; out[1] = ay0 + d1y * s; out[2] = bx0 + d2x * t; out[3] = by0 + d2y * t;
}
function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }

interface ContactState {
  hs?: SpatialHash;
  acc: Float64Array; // per segment: dx, dy, dvx, dvy, dw, count (fixed point / exact integers)
  biteArmed: Uint8Array;
  biteCooldown: Float32Array;
  bites: BiteRecord[];
  terrainCheckedTick: number;
  terrain: boolean;
}
export interface BiteRecord { attacker: number; target: number; targetSeg: number; dmKg: number; tick: number }
const states = new WeakMap<World, ContactState>();

export function contactState(world: World): ContactState {
  let s = states.get(world);
  if (!s) {
    s = {
      acc: new Float64Array(world.seg.capacity * 6), biteArmed: new Uint8Array(world.seg.capacity),
      biteCooldown: new Float32Array(world.cr.capacity), bites: [], terrainCheckedTick: -1, terrain: false,
    };
    states.set(world, s);
  }
  return s;
}

/** Bites resolved since the last drain (for the ecosystem's conserving mass exchange). */
export function drainBites(world: World): BiteRecord[] {
  const s = contactState(world);
  return s.bites.splice(0, s.bites.length);
}

const cp = new Float64Array(4);
const FIX_V = 65536;

export function stepContacts(world: World, ctx: StepContext, wk: Work, opts: PhysicsOptions): { pairs: number; contacts: number; cells: number } {
  const st = contactState(world);
  const c = world.cr.c;
  const sg = world.seg.c;
  const dt = opts.dt;
  const hs = buildHash(world, st.hs, dt);
  st.hs = hs;
  const acc = st.acc;
  for (let q = 0; q < hs.n; q++) { const i = hs.items[q]!; acc.fill(0, i * 6, i * 6 + 6); sg.touch[i] = 0; }
  wk.contactHeat.fill(0, 0, world.cr.highWater);
  let pairs = 0; let contacts = 0; let cells = 0;
  const anyLinks = linkState(world).links.length > 0;
  const lenOf = (slot: number): number => (c.length[slot]! > 0 ? c.length[slot]! : 0.01);
  const visit = (i: number, j: number): void => {
    const oa = sg.owner[i]!; const ob = sg.owner[j]!;
    if (oa === ob) return; // self-collision off (02 §2.4.1)
    if (anyLinks && hasLink(world, i, j)) return; // a held pair is solved by its link
    pairs++;
    const ra = sg.radius[i]!; const rb = sg.radius[j]!;
    const ha = 0.5 * sg.len[i]!; const hb = 0.5 * sg.len[j]!;
    sincos(sg.angle[i]!); const ca = SC.c; const sa = SC.s; sincos(sg.angle[j]!); const cb = SC.c; const sb = SC.s;
    const axc = sg.posX[i]!; const ayc = sg.posY[i]!; const bxc = sg.posX[j]!; const byc = sg.posY[j]!;
    closestSegSeg(axc - ca * ha, ayc - sa * ha, axc + ca * ha, ayc + sa * ha,
      bxc - cb * hb, byc - sb * hb, bxc + cb * hb, byc + sb * hb, cp);
    let nx = cp[0]! - cp[2]!; let ny = cp[1]! - cp[3]!;
    const dist = Math.sqrt(nx * nx + ny * ny);
    const depth = ra + rb - dist;
    // speculative contact: not touching yet, but closing faster than the gap allows in one tick
    if (depth <= 0) {
      const vrel = Math.sqrt((sg.velX[i]! - sg.velX[j]!) ** 2 + (sg.velY[i]! - sg.velY[j]!) ** 2)
        + Math.abs(sg.angVel[i]!) * ha + Math.abs(sg.angVel[j]!) * hb;
      if (-depth > vrel * dt) return;
    }
    contacts++;
    if (dist > 1e-15) { nx /= dist; ny /= dist; } else { nx = 0; ny = -1; }
    // contact point arms from the centres
    const pax = cp[0]! - nx * ra - axc; const pay = cp[1]! - ny * ra - ayc;
    const pbx = cp[2]! + nx * rb - bxc; const pby = cp[3]! + ny * rb - byc;
    const ma = sg.mass[i]!; const mb = sg.mass[j]!; const Ia = sg.inertia[i]!; const Ib = sg.inertia[j]!;
    const rna = pax * ny - pay * nx; const rnb = pbx * ny - pby * nx;
    const wa = 1 / ma + rna * rna / Ia; const wb = 1 / mb + rnb * rnb / Ib;
    // relative velocity at the contact point (a relative to b), normal points from b to a
    const vax = sg.velX[i]! - sg.angVel[i]! * pay; const vay = sg.velY[i]! + sg.angVel[i]! * pax;
    const vbx = sg.velX[j]! - sg.angVel[j]! * pby; const vby = sg.velY[j]! + sg.angVel[j]! * pbx;
    const rvx = vax - vbx; const rvy = vay - vby;
    const vn = rvx * nx + rvy * ny;
    let Jn = 0; let Jt = 0; let tx = -ny; let ty = nx;
    const gap = depth < 0 ? -depth : 0;
    if (vn < -gap / dt) {
      Jn = -(vn + gap / dt) / (wa + wb);
      const vt = rvx * tx + rvy * ty;
      const rta = pax * ty - pay * tx; const rtb = pbx * ty - pby * tx;
      const wta = 1 / ma + rta * rta / Ia; const wtb = 1 / mb + rtb * rtb / Ib;
      Jt = -vt / (wta + wtb);
      const lim = CONTACT_FRICTION * Jn;
      if (Jt > lim) Jt = lim; else if (Jt < -lim) Jt = -lim;
      const E = 0.5 * Jn * Jn * (wa + wb);
      wk.contactHeat[oa] = wk.contactHeat[oa]! + 0.5 * E;
      wk.contactHeat[ob] = wk.contactHeat[ob]! + 0.5 * E;
      ram(sg, i, j, E); ram(sg, j, i, E);
    } else { tx = 0; ty = 0; }
    const Px = Jn * nx + Jt * tx; const Py = Jn * ny + Jt * ty;
    // depenetration, capped per tick
    const vcap = DEPEN_BL_PER_S * Math.min(lenOf(oa), lenOf(ob));
    const corr = depth > 0 ? Math.min(depth, vcap * dt) : 0;
    const wsum = 1 / ma + 1 / mb;
    accum(acc, i, nx * corr * (1 / ma) / wsum, ny * corr * (1 / ma) / wsum, Px / ma, Py / ma, (pax * Py - pay * Px) / Ia);
    accum(acc, j, -nx * corr * (1 / mb) / wsum, -ny * corr * (1 / mb) / wsum, -Px / mb, -Py / mb, -(pbx * Py - pby * Px) / Ib);
    const F = Jn / dt;
    sg.touch[i] = sg.touch[i]! + F; sg.touch[j] = sg.touch[j]! + F;
    const mx = 0.5 * (cp[0]! + cp[2]!); const my = 0.5 * (cp[1]! + cp[3]!);
    const probI = wk.subtype[i] === MOUTH_SUBTYPE.PROBOSCIS; const probJ = wk.subtype[j] === MOUTH_SUBTYPE.PROBOSCIS;
    if (!probI && tryBite(world, ctx, st, i, j, depth) && !ownsLink(world, i)) addLink(world, LINK.JAW, i, j, mx, my, jawBreak(sg.radius[i]!));
    if (!probJ && tryBite(world, ctx, st, j, i, depth) && !ownsLink(world, j)) addLink(world, LINK.JAW, j, i, mx, my, jawBreak(sg.radius[j]!));
    if (depth > 0) {
      tryGrab(world, i, j, mx, my); tryGrab(world, j, i, mx, my);
      tryLatch(world, wk, i, j, mx, my); tryLatch(world, wk, j, i, mx, my);
    }
  };
  for (let q = 0; q < hs.n; q++) cells += queryPairs(world, hs, hs.items[q]!, visit);
  // apply averaged corrections
  for (let q = 0; q < hs.n; q++) {
    const i = hs.items[q]!;
    const o = i * 6;
    const cnt = acc[o + 5]!;
    if (cnt === 0) continue;
    sg.posX[i] = sg.posX[i]! + acc[o]! / FIX_POS / cnt;
    sg.posY[i] = sg.posY[i]! + acc[o + 1]! / FIX_POS / cnt;
    sg.velX[i] = sg.velX[i]! + acc[o + 2]! / FIX_V / cnt;
    sg.velY[i] = sg.velY[i]! + acc[o + 3]! / FIX_V / cnt;
    sg.angVel[i] = sg.angVel[i]! + acc[o + 4]! / FIX_V / cnt;
  }
  terrainContacts(world, st, wk, dt);
  // bite cooldowns
  for (let s = 0; s < world.cr.highWater; s++) if (st.biteCooldown[s]! > 0) st.biteCooldown[s] = Math.max(0, st.biteCooldown[s]! - dt);
  return { pairs, contacts, cells };
}

/**
 * Ram damage (02 §2.4.6): half the impact energy above the threshold `E_THR_RAM * V` damages
 * segment i, times 6 when the other part is a spike. Armour is not in the segment pool yet.
 */
function ram(sg: World['seg']['c'], i: number, j: number, E: number): void {
  const V = segVolume(isPlate(sg.kind[i]!), sg.len[i]!, sg.radius[i]!, sg.span[i]!);
  const ex = 0.5 * E - E_THR_RAM * V;
  if (ex <= 0) return;
  const spike = sg.kind[j] === KIND.SPIKE ? 6 : 1;
  const d = sg.damage[i]! + spike * ex / (TOUGHNESS * V);
  sg.damage[i] = d > 1 ? 1 : d;
}

function accum(acc: Float64Array, i: number, dx: number, dy: number, dvx: number, dvy: number, dw: number): void {
  const o = i * 6;
  acc[o] = acc[o]! + Math.round(dx * FIX_POS);
  acc[o + 1] = acc[o + 1]! + Math.round(dy * FIX_POS);
  acc[o + 2] = acc[o + 2]! + Math.round(dvx * FIX_V);
  acc[o + 3] = acc[o + 3]! + Math.round(dvy * FIX_V);
  acc[o + 4] = acc[o + 4]! + Math.round(dw * FIX_V);
  acc[o + 5] = acc[o + 5]! + 1;
}

/**
 * A mouth segment whose bite drive (cmd2, adapter until a BITE column exists) crosses 0.5
 * with hysteresis bites the touched segment of another creature (02 §2.4.3).
 */
function tryBite(world: World, ctx: StepContext, st: ContactState, i: number, j: number, depth: number): boolean {
  const sg = world.seg.c;
  const c = world.cr.c;
  if (sg.kind[i] !== KIND.MOUTH && (sg.organs[i]! & ORGAN.MOUTH) === 0) return false;
  if (depth <= 0) return false;
  const drive = sg.cmd2[i]!;
  if (st.biteArmed[i] === 0) { if (drive >= BITE_ON) st.biteArmed[i] = 1; else return false; }
  if (drive < BITE_OFF) { st.biteArmed[i] = 0; return false; }
  const a = sg.owner[i]!; const b = sg.owner[j]!;
  if (st.biteCooldown[a]! > 0 || c.life[b] === LIFE.FREE) return false;
  const rm = sg.radius[i]!;
  const sharp = 0.5;
  const fJaw = 0.3;
  const F = SIGMA_JAW * fJaw * PI * rm * rm;
  const Ac = 0.1 * (1 - 0.8 * sharp) * PI * rm * rm;
  const p = F * (0.5 + sharp) - H_TISSUE * Ac;
  if (p <= 0) return false;
  const gape = 0.5;
  const vGape = 0.5 * PI * gape * rm * rm * rm;
  const dm = Math.min(RHO_TISSUE * vGape, 0.5 * sg.mass[j]!, p * C_BITE);
  sg.damage[j] = Math.min(1, sg.damage[j]! + dm / sg.mass[j]!);
  st.biteCooldown[a] = 0.5;
  st.biteArmed[i] = 0;
  st.bites.push({ attacker: a, target: b, targetSeg: j, dmKg: dm, tick: ctx.tick });
  const idOf = (s: number): number => c.idLo[s]! + c.idHi[s]! * 4294967296;
  ctx.events.emit({ k: 'bite', attacker: idOf(a), target: idOf(b), pos: [sg.posX[j]!, sg.posY[j]!], dmg: dm } as Parameters<StepContext['events']['emit']>[0]);
  return true;
}

/** Terrain: push segment centres out of rock along the SDF gradient; remove inward velocity. */
function terrainContacts(world: World, st: ContactState, wk: Work, dt: number): void {
  const f = world.fields;
  if (st.terrainCheckedTick < 0 || world.g.tick - st.terrainCheckedTick >= 15) {
    st.terrain = false;
    for (let q = 0; q < f.sdf.length; q++) if (f.sdf[q] !== 0) { st.terrain = true; break; }
    st.terrainCheckedTick = world.g.tick;
  }
  if (!st.terrain) return;
  const [gw, gh] = f.sdfGrid;
  const cs = world.preset.widthM / gw;
  const sdfAt = (x: number, y: number): number => {
    let gx = x / cs - 0.5; let gy = y / cs - 0.5;
    gx = gx < 0 ? 0 : gx > gw - 1.001 ? gw - 1.001 : gx;
    gy = gy < 0 ? 0 : gy > gh - 1.001 ? gh - 1.001 : gy;
    const ix = Math.floor(gx); const iy = Math.floor(gy); const fx = gx - ix; const fy = gy - iy;
    const i0 = iy * gw + ix;
    return (f.sdf[i0]! * (1 - fx) + f.sdf[i0 + 1]! * fx) * (1 - fy) + (f.sdf[i0 + gw]! * (1 - fx) + f.sdf[i0 + gw + 1]! * fx) * fy;
  };
  const c = world.cr.c;
  const sg = world.seg.c;
  void dt;
  for (let s = 0; s < world.cr.highWater; s++) {
    const life = c.life[s];
    if ((life !== LIFE.ALIVE && life !== LIFE.CARCASS) || c.segCount[s] === 0) continue;
    const s0 = c.segStart[s]!;
    for (let k = 0; k < c.segCount[s]!; k++) {
      const i = s0 + k;
      const x = sg.posX[i]!; const y = sg.posY[i]!; const r = sg.radius[i]!;
      const d = sdfAt(x, y);
      if (d >= r) continue;
      const e = cs * 0.5;
      let gx = sdfAt(x + e, y) - sdfAt(x - e, y); let gy = sdfAt(x, y + e) - sdfAt(x, y - e);
      const gl = Math.sqrt(gx * gx + gy * gy);
      if (gl < 1e-12) continue;
      gx /= gl; gy /= gl;
      const push = r - d;
      sg.posX[i] = x + gx * push; sg.posY[i] = y + gy * push;
      const vn = sg.velX[i]! * gx + sg.velY[i]! * gy;
      if (vn < 0) {
        const m = sg.mass[i]!;
        wk.contactHeat[s] = wk.contactHeat[s]! + 0.5 * m * vn * vn;
        sg.velX[i] = sg.velX[i]! - vn * gx; sg.velY[i] = sg.velY[i]! - vn * gy;
      }
    }
  }
}
