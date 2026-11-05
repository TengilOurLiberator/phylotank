/**
 * Perception (CONTRACT 8.1 inputs, 8.3 step 1; 03 §3.4). Writes every due brain's `inputs` from
 * the world as it is at the start of the tick, then adds sensor noise N(0, SENSOR_NOISE) from
 * stream SENSOR_NOISE (subject = entity id, drawIndex = input index / 4). BIAS stays exactly 1.
 *
 * Neighbours come from a uniform grid rebuilt per call, ordered by (cell, slot) (review R16), with
 * the search capped by cells visited (review R5); objects that subtend less than MIN_ANGLE are
 * left to the density fields.
 */
import {
  BRAIN_CLASSES, CF, COARSE_CELL_M, DAY_S, DT, FINE_CELL_M, LIFE, NONE_U32, PI, Q_MASS, RNG_STREAM,
  SDF_CELL_M, TAU, TICK_HZ, YEAR_DAYS, atan, atan2, cos, exp, log, sin, tanh, wrapAngle,
  type StepContext, type World,
} from '../core/index.js';
import { IN } from './layout.js';
import { brainState, type BrainStatic } from './pool.js';
import { gaussianBlock } from './think.js';

export const GRID_CELL_M = 0.5;
export const MAX_CELL_VISITS = 49;
export const MIN_ANGLE = 0.004;
export const MAX_EYE_RANGE_M = 4;
const TAU_SMELL = 5;
const PLANT_KGM2_REF = 1e-3;
const I0 = 0.05;
const LOG_NORM = 1 / log(1 + 1 / I0);

interface Grid { w: number; h: number; start: Int32Array; items: Int32Array; stamp: number }
const grids = new WeakMap<World, Grid>();

/** Rebuild the neighbour grid: live creatures and carcasses, ascending slot within each cell. */
export function buildGrid(world: World, stamp: number): Grid {
  let g = grids.get(world);
  const w = Math.max(1, Math.ceil(world.preset.widthM / GRID_CELL_M));
  const h = Math.max(1, Math.ceil(world.preset.heightM / GRID_CELL_M));
  if (!g || g.w !== w || g.h !== h || g.items.length < world.cr.capacity) {
    g = { w, h, start: new Int32Array(w * h + 1), items: new Int32Array(world.cr.capacity), stamp: -1 };
    grids.set(world, g);
  }
  if (g.stamp === stamp) return g;
  const c = world.cr.c;
  const hw = world.cr.highWater;
  const count = g.start;
  count.fill(0);
  const cellOf = (s: number): number => {
    const ix = Math.min(w - 1, Math.max(0, Math.floor(c.posX[s]! / GRID_CELL_M)));
    const iy = Math.min(h - 1, Math.max(0, Math.floor(c.posY[s]! / GRID_CELL_M)));
    return iy * w + ix;
  };
  for (let s = 0; s < hw; s++) if (c.life[s] === LIFE.ALIVE || c.life[s] === LIFE.CARCASS) count[cellOf(s) + 1]!++;
  for (let i = 0; i < w * h; i++) count[i + 1]! += count[i]!;
  const fill = new Int32Array(w * h);
  for (let s = 0; s < hw; s++) {
    if (c.life[s] !== LIFE.ALIVE && c.life[s] !== LIFE.CARCASS) continue;
    const cell = cellOf(s);
    g.items[count[cell]! + fill[cell]!++] = s;
  }
  g.stamp = stamp;
  return g;
}


function coarseIndex(world: World, x: number, y: number): number {
  const [w, h] = world.fields.coarse;
  const ix = Math.min(w - 1, Math.max(0, Math.floor(x / COARSE_CELL_M)));
  const iy = Math.min(h - 1, Math.max(0, Math.floor(y / COARSE_CELL_M)));
  return iy * w + ix;
}
function fineIndex(world: World, x: number, y: number): number {
  const [w, h] = world.fields.fine;
  const ix = Math.min(w - 1, Math.max(0, Math.floor(x / FINE_CELL_M)));
  const iy = Math.min(h - 1, Math.max(0, Math.floor(y / FINE_CELL_M)));
  return iy * w + ix;
}
function sdfAt(world: World, x: number, y: number): number {
  const [w, h] = world.fields.sdfGrid;
  const ix = Math.min(w - 1, Math.max(0, Math.floor(x / SDF_CELL_M)));
  const iy = Math.min(h - 1, Math.max(0, Math.floor(y / SDF_CELL_M)));
  return world.fields.sdf[iy * w + ix]!;
}
/** Plant smell (scent channel 0 plus the phytoplankton density), level units. */
function scentLevel(world: World, x: number, y: number, ch: number): number {
  let c = world.fields.scent[coarseIndex(world, x, y) * 8 + ch]!;
  if (ch === 0) c += (world.fields.qP[fineIndex(world, x, y)]! * Q_MASS) / (FINE_CELL_M * FINE_CELL_M) / PLANT_KGM2_REF;
  return c > 0 ? log(1 + c) : 0;
}
function band(colour: number, b: number): number {
  // bands 0 blue, 1 green, 2 red; colour is RGBA8 with r in the low byte
  const shift = b === 0 ? 16 : b === 1 ? 8 : 0;
  return ((colour >>> shift) & 255) / 255;
}
function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }

const NB_CAP = 512;
const nbBuf = new Int32Array(NB_CAP);
let nbCount = 0;
const nearBuf = new Int32Array(NB_CAP);
let nearCount = 0;
/** Gather the neighbours of one creature once; every eye and lateral organ filters this list. */
function gather(g: Grid, x: number, y: number, r: number, self: number): void {
  nbCount = 0;
  const cx = Math.floor(x / GRID_CELL_M), cy = Math.floor(y / GRID_CELL_M);
  let ext = Math.ceil(r / GRID_CELL_M);
  while ((2 * ext + 1) * (2 * ext + 1) > MAX_CELL_VISITS && ext > 0) ext--;
  const x0 = Math.max(0, cx - ext), x1 = Math.min(g.w - 1, cx + ext);
  const y0 = Math.max(0, cy - ext), y1 = Math.min(g.h - 1, cy + ext);
  for (let iy = y0; iy <= y1; iy++) {
    for (let ix = x0; ix <= x1; ix++) {
      const cell = iy * g.w + ix;
      for (let k = g.start[cell]!; k < g.start[cell + 1]!; k++) {
        const j = g.items[k]!;
        if (j !== self && nbCount < NB_CAP) nbBuf[nbCount++] = j;
      }
    }
  }
}
const depthBuf = new Float64Array(16);
const objBuf = new Int32Array(16);
const radBuf = new Float64Array(16);
const noise = new Float64Array(192);

/** Sense for every due brain. */
export function sense(world: World, ctx: StepContext): void {
  const bs = brainState(world);
  const div = world.g.brainDiv;
  const tick = ctx.tick;
  const life = world.cr.c.life;
  let grid: Grid | null = null;
  const sn = ctx.rng.stream(RNG_STREAM.SENSOR_NOISE);
  for (let c = 0; c < world.brains.length; c++) {
    const pool = world.brains[c]!;
    const statics = bs.statics[c]!;
    for (let s = 0; s < pool.highWater; s++) {
      const cr = pool.c.owner[s]!;
      if (cr === NONE_U32 || (cr + tick) % div !== 0 || life[cr] !== LIFE.ALIVE) continue;
      const st = statics[s];
      if (!st) continue;
      if (!grid && st.L.needsNeighbours) grid = buildGrid(world, tick);
      senseOne(world, c, s, st, tick, div * DT, grid);
      if (st.sensorNoise > 0) {
        const I = BRAIN_CLASSES[c]!.i;
        const nIn = pool.c.nIn[s]!;
        gaussianBlock(sn.k0, sn.k1, tick, st.entityId, nIn, st.sensorNoise, noise);
        for (let i = 1; i < nIn; i++) pool.c.inputs[s * I + i]! += noise[i]!;
      }
    }
  }
}

function senseOne(world: World, c: number, s: number, st: BrainStatic, tick: number, dtb: number, grid: Grid | null): void {
  const pool = world.brains[c]!;
  const { n: N, i: I } = BRAIN_CLASSES[c]!;
  const inp = pool.c.inputs;
  const bI = s * I;
  const cr = world.cr.c;
  const k = st.creature;
  const L = st.L;
  const x = cr.posX[k]!, y = cr.posY[k]!;
  const len = Math.max(1e-4, cr.length[k]!);
  const vx = cr.velX[k]!, vy = cr.velY[k]!;
  const heading = cr.heading[k]!, mirror = cr.mirror[k]! < 0 ? -1 : 1;
  const segStart = cr.segStart[k]!, segCount = cr.segCount[k]!;
  const seg = world.seg.c;
  const ci = coarseIndex(world, x, y);
  const fu = world.fields.flowU[ci]!, fv = world.fields.flowV[ci]!;
  const dayS = world.config.dayS ?? DAY_S;
  const dayTicks = Math.max(1, Math.round(dayS * TICK_HZ));
  const yearTicks = dayTicks * (world.config.yearDays ?? YEAR_DAYS);
  const dayA = TAU * ((tick % dayTicks) / dayTicks);
  const yearA = TAU * ((tick % yearTicks) / yearTicks);
  const health = cr.health[k]!;
  const painLane = s * N + L.base.mod + 1;
  const hPrev = pool.c.phase[painLane]!;
  const qGut = cr.qGut[k * 3]! + cr.qGut[k * 3 + 1]! + cr.qGut[k * 3 + 2]!;
  const massQ = Math.max(1, cr.massKg[k]! / Q_MASS);

  // global block
  inp[bI + IN.BIAS] = 1;
  inp[bI + IN.ENERGY] = clamp01(cr.qReserve[k]! / Math.max(1, st.fatCapacity * massQ));
  inp[bI + IN.GUT] = clamp01((qGut * Q_MASS) / st.gutCapKg);
  inp[bI + IN.HEALTH] = health;
  inp[bI + IN.PAIN] = hPrev > 0 ? clamp01(-((health - hPrev) / dtb) * 1) : 0;
  pool.c.phase[painLane] = health;
  const lifespan = cr.lifespan[k]!;
  inp[bI + IN.AGE] = lifespan > 0 ? clamp01(((tick - cr.birthTick[k]!) * DT) / lifespan) : 0;
  inp[bI + IN.MATURE] = cr.maturity[k]! >= 0.999 ? 1 : 0;
  inp[bI + IN.REPRO_LOAD] = clamp01(cr.qRepro[k]! / Math.max(1, st.clutchCostQ));
  const tt = (cr.tempC[k]! - st.tempOpt) / st.tempTol;
  inp[bI + IN.TEMPERATURE] = tt < -1 ? -1 : tt > 1 ? 1 : tt;
  inp[bI + IN.DEPTH] = (y - world.g.ySurface) / world.preset.heightM;
  inp[bI + IN.LIGHT] = world.fields.light[ci]!;
  const rvx = vx - fu, rvy = vy - fv;
  inp[bI + IN.SPEED] = tanh(Math.sqrt(rvx * rvx + rvy * rvy) / len);
  inp[bI + IN.DAY_SIN] = sin(dayA);
  inp[bI + IN.DAY_COS] = cos(dayA);
  inp[bI + IN.SEASON_SIN] = sin(yearA);
  inp[bI + IN.SEASON_COS] = cos(yearA);
  inp[bI + IN.FATIGUE] = clamp01(1 - cr.anaerobic[k]!);
  inp[bI + IN.ITCH] = 0; // parasite latching arrives with disease (v0.4)

  let PX = 0, PY = 0, PA = 0;
  const partPos = (p: number): void => {
    if (segStart !== NONE_U32 && p >= 0 && p < segCount) {
      const sg = segStart + p;
      PX = seg.posX[sg]!; PY = seg.posY[sg]!; PA = seg.angle[sg]!; return;
    }
    PX = x; PY = y; PA = heading;
  };

  nbCount = 0;
  if (grid) {
    let r = 4 * len + len;
    for (const e of L.eyes) r = Math.max(r, Math.min(MAX_EYE_RANGE_M, e.rangeBL * len) + len);
    if (L.needsNeighbours) gather(grid, x, y, r, k);
  }
  // the lateral line only feels the near list (4 body lengths of an organ, so 5 of the centre)
  nearCount = 0;
  const near2 = 25 * len * len;
  for (let q = 0; q < nbCount; q++) {
    const j = nbBuf[q]!;
    const dx = cr.posX[j]! - x, dy = cr.posY[j]! - y;
    if (dx * dx + dy * dy <= near2 && nearCount < NB_CAP) nearBuf[nearCount++] = j;
  }
  // organs on parts not grown yet (segCount < nParts at an early stage) read 0 (03 §3.3.2)
  const grown = (p: number): boolean => segStart === NONE_U32 || p < segCount;
  // eyes
  for (const e of L.eyes) {
    if (!grown(e.part)) { inp.fill(0, bI + e.base, bI + e.base + e.receptors * (e.bands.length + 1)); continue; }
    partPos(e.part);
    const ex = PX, ey = PY;
    const R = e.receptors;
    const lanes = e.bands.length + 1;
    const axis = heading - mirror * e.mount;
    const range = Math.min(MAX_EYE_RANGE_M, e.rangeBL * len);
    const binW = e.fovRad / R;
    const ax = cos(axis), ay = sin(axis);
    for (let r = 0; r < R; r++) { depthBuf[r] = Infinity; objBuf[r] = -1; }
    for (let q = 0; q < nbCount; q++) {
      {
        const j = nbBuf[q]!;
        const dx = cr.posX[j]! - ex, dy = cr.posY[j]! - ey;
        const d2 = dx * dx + dy * dy;
        const rad = 0.5 * cr.length[j]!;
        if (d2 > (range + rad) * (range + rad) || d2 <= 0) continue;
        const dist = Math.sqrt(d2);
        const ratio = rad / dist;
        // atan(x) = x (1 - x^2/3) within 2e-3 relative for x < 0.1
        const a = dist <= rad ? PI / 2 : ratio < 0.1 ? ratio * (1 - (ratio * ratio) / 3) : atan(ratio);
        if (a < MIN_ANGLE) continue;
        const half = e.fovRad / 2;
        // cone pre-check with dot products before the atan2
        if (half + a < PI && dx * ax + dy * ay < dist * cos(half + a)) continue;
        const rel = wrapAngle(atan2(dy, dx) - axis);
        if (rel - a > half || rel + a < -half) continue;
        let b0 = Math.floor((rel - a + half) / binW), b1 = Math.floor((rel + a + half) / binW);
        if (b0 < 0) b0 = 0;
        if (b1 > R - 1) b1 = R - 1;
        for (let b = b0; b <= b1; b++) {
          if (dist < depthBuf[b]! || (dist === depthBuf[b]! && j < objBuf[b]!)) { depthBuf[b] = dist; objBuf[b] = j; radBuf[b] = rad; }
        }
      }
    }
    const kappa = 0.1 + world.fields.turb[ci]!;
    const r0 = Math.max(0.05, range / 2);
    const aOwn = world.fields.light[ci]!;
    for (let r = 0; r < R; r++) {
      const at = bI + e.base + r * lanes;
      const j = objBuf[r]!;
      if (j >= 0) {
        const dist = depthBuf[r]!;
        const atten = exp(-kappa * dist) / (1 + (dist / r0) * (dist / r0));
        const aj = world.fields.light[coarseIndex(world, cr.posX[j]!, cr.posY[j]!)]!;
        const col = cr.colour[j]!;
        const gl = cr.glow[j]!;
        for (let b = 0; b < e.bands.length; b++) {
          const bc = band(col, e.bands[b]!);
          const I = (gl * bc + aj * 0.5 * bc) * e.sens[b]! * atten;
          inp[at + b] = clamp01(log(1 + I / I0) * LOG_NORM);
        }
        inp[at + lanes - 1] = clamp01(radBuf[r]! / dist);
      } else {
        const dirY = sin(axis - e.fovRad / 2 + (r + 0.5) * binW);
        for (let b = 0; b < e.bands.length; b++) {
          const I = dirY < 0 ? aOwn * -dirY * e.sens[b]! : 0;
          inp[at + b] = clamp01(log(1 + I / I0) * LOG_NORM);
        }
        inp[at + lanes - 1] = 0;
      }
    }
  }

  // chemo organs: level and rate per channel (rate = tauSmell * d(level)/dt along own motion)
  for (const ch of L.chemos) {
    if (!grown(ch.part)) { inp.fill(0, bI + ch.base, bI + ch.base + 2 * ch.channels.length); continue; }
    partPos(ch.part);
    const cx = PX, cy = PY;
    let at = bI + ch.base;
    for (const chan of ch.channels) {
      const lv = scentLevel(world, cx, cy, chan);
      const h = COARSE_CELL_M;
      const gx = (scentLevel(world, cx + h, cy, chan) - scentLevel(world, cx - h, cy, chan)) / (2 * h);
      const gy = (scentLevel(world, cx, cy + h, chan) - scentLevel(world, cx, cy - h, chan)) / (2 * h);
      const rate = TAU_SMELL * (gx * vx + gy * vy);
      inp[at++] = lv;
      inp[at++] = rate < -1 ? -1 : rate > 1 ? 1 : rate;
    }
  }

  // per-part inputs other than eyes and chemo, in layout order
  const nIn = L.nIn;
  for (let i = 0; i < nIn; i++) {
    const chn = L.inputs[i]!;
    const kind = chn.kind;
    if (kind < IN.LATERAL || kind === IN.CHEMO_LEVEL || kind === IN.CHEMO_RATE) continue;
    const p = chn.part;
    if (!grown(p)) { inp[bI + i] = 0; continue; }
    partPos(p);
    const px = PX, py = PY, pa = PA;
    const sg = segStart !== NONE_U32 && p < segCount ? segStart + p : -1;
    switch (kind) {
      case IN.LATERAL: {
        if (chn.slot !== 0) break; // both sides written together
        const nxD = mirror * sin(pa), nyD = -mirror * cos(pa);
        let pD = 0, pV = 0;
        const rng = 4 * len;
        for (let q = 0; q < nearCount; q++) {
          {
            const j = nearBuf[q]!;
            const dx = cr.posX[j]! - px, dy = cr.posY[j]! - py;
            const d2 = dx * dx + dy * dy;
            if (d2 > rng * rng || d2 <= 0) continue;
            const dvx = cr.velX[j]! - vx, dvy = cr.velY[j]! - vy;
            const m = cr.massKg[j]! * Math.sqrt(dvx * dvx + dvy * dvy);
            const dist = Math.sqrt(d2);
            const cosn = (nxD * dx + nyD * dy) / dist;
            const e2 = d2 + 1e-6 * len * len;
            if (cosn > 0) pD += (m * Math.sqrt(cosn)) / e2; else pV += (m * Math.sqrt(-cosn)) / e2;
          }
        }
        const p0 = Math.max(1e-15, cr.massKg[k]! / len);
        const selfNoise = 0.1 * (Math.sqrt(vx * vx + vy * vy) / len);
        inp[bI + i] = clamp01(log(1 + pD / p0) / log(11) - selfNoise);
        if (i + 1 < nIn) inp[bI + i + 1] = clamp01(log(1 + pV / p0) / log(11) - selfNoise);
        break;
      }
      case IN.TOUCH: {
        if (chn.slot !== 0) break;
        const r = sg >= 0 ? Math.max(1e-4, seg.radius[sg]!) : len * 0.1;
        const nxD = mirror * sin(pa), nyD = -mirror * cos(pa);
        const sD = sdfAt(world, px + nxD * 2 * r, py + nyD * 2 * r);
        const sV = sdfAt(world, px - nxD * 2 * r, py - nyD * 2 * r);
        const f0 = Math.max(1e-12, cr.massKg[k]! * 1);
        const tv = sg >= 0 ? tanh(seg.touch[sg]! / f0) : 0;
        const wallD = clamp01(1 - sD / (2 * r)), wallV = clamp01(1 - sV / (2 * r));
        inp[bI + i] = Math.max(wallD, tv * (sD <= sV ? 1 : 0.3));
        if (i + 1 < nIn) inp[bI + i + 1] = Math.max(wallV, tv * (sV < sD ? 1 : 0.3));
        break;
      }
      case IN.TASTE_NUTRITION: {
        const plant = (world.fields.qP[fineIndex(world, px, py)]! * Q_MASS) / (FINE_CELL_M * FINE_CELL_M) / PLANT_KGM2_REF;
        inp[bI + i] = (cr.flags[k]! & CF.EATING) !== 0 ? 1 : 0.5 * (1 - exp(-plant));
        break;
      }
      case IN.TASTE_TOXIN:
        inp[bI + i] = 1 - exp(-Math.max(0, world.fields.scent[coarseIndex(world, px, py) * 8 + 2]!));
        break;
      case IN.HOLDING:
        inp[bI + i] = (cr.flags[k]! & CF.LATCHED) !== 0 ? 1 : 0;
        break;
      case IN.PROPRIO: {
        if (sg < 0) { inp[bI + i] = 0; break; }
        const par = seg.parent[sg]!;
        const pAng = par >= 0 ? seg.angle[segStart + par]! : heading;
        const half = Math.max(1e-3, 0.5 * (seg.limitHi[sg]! - seg.limitLo[sg]!));
        const rel = wrapAngle(seg.angle[sg]! - pAng - seg.restAngle[sg]!) / half;
        inp[bI + i] = rel < -1 ? -1 : rel > 1 ? 1 : rel;
        break;
      }
      case IN.GLAND_FULL:
        inp[bI + i] = 1; // gland contents are not modelled in v0.1
        break;
      default:
        break;
    }
  }
}
