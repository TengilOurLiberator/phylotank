/**
 * God powers (04 §4.8, CONTRACT 13, DESIGN R7, R26) and nature mode (William's Q7).
 *
 * `planCast` turns a cast into the scheduled form with its lead time (3 s wall for major
 * powers, 1 s for minor, converted to ticks at the achieved speed) and its envelope.
 * `applyGodEvent` runs at the fire tick: instant effects (craters, kills, injections, strains)
 * happen at once; lasting effects are envelopes on the modifier stack, evaluated on every slow
 * tick by `evalModifiers` (temperature adds, rates multiply, everything clamps).
 * `natureEvent` is a pure function of (seed, tick): the host may call it on governor ticks
 * and journal the result, and replay gives the same tank.
 */
import {
  clamp, DAY_S, DT, GOVERNOR_EVERY, isMajorPower, K_ENDOW, LEAD_MAJOR_S, LEAD_MINOR_S, LIFE, MATERIAL,
  MAX_WORLD_MASS_KG, NATURE_MAX_MAGNITUDE, NATURE_POWERS, NONE_U32, Q_MASS, RNG_STREAM, TICK_HZ, CF,
  type GodCommand, type GodEventScheduled, type PowerId, type StepContext, type Target, type World,
} from '../core/index.js';
import { inject, transfer, book } from './ledger.js';
import { newMods, CH, ER, ER_LANES, type EcoState } from './state.js';
import { carveCircle, paintCircle, rebuildSdf, surfaceRow } from './terrain.js';
import { coarseIndex } from './env.js';
import { newStrain, wakeReservoirStrain } from './disease.js';

const DAY = DAY_S;
type Env3 = { attack: number; sustain: number; release: number };

/** Default envelope (sim seconds) per power, from 04 §4.8's durations. */
export function envelopeFor(power: PowerId, intensity: number, duration?: number): Env3 {
  const i = clamp(intensity, 0, 1);
  const d = (x: number): number => (duration !== undefined && duration > 0 ? duration : x);
  switch (power) {
    case 'bloom': return { attack: 0, sustain: d(2 * DAY), release: DAY };
    case 'coldSnap': case 'heatwave': return { attack: 0.5 * DAY, sustain: d((1 + 4 * i) * DAY), release: 2 * DAY };
    case 'meteor': return { attack: 0, sustain: d((i < 0.33 ? 1 : i < 0.85 ? 5 : 30) * DAY), release: DAY };
    case 'currentShift': return { attack: 0.5 * DAY, sustain: d(5 * DAY), release: 0.5 * DAY };
    case 'longNight': return { attack: 60, sustain: d((0.05 + 3 * i) * DAY), release: 0.1 * DAY };
    case 'mutagen': return { attack: 0, sustain: d((1 + 4 * i) * DAY), release: 0 };
    case 'toxinLeak': return { attack: 0, sustain: d(DAY), release: DAY };
    case 'iceAge': return { attack: 5 * DAY, sustain: d((10 + 30 * i) * DAY), release: 10 * DAY };
    case 'storm': return { attack: 0.1 * DAY, sustain: d((0.5 + 1.5 * i) * DAY), release: 0.2 * DAY };
    case 'deadZone': return { attack: 0, sustain: d((1 + 9 * i) * DAY), release: 0.5 * DAY };
    case 'vent': return { attack: 0, sustain: d(0.5 * DAY), release: 0.1 * DAY };
    case 'earthquake': return { attack: 0, sustain: d((1 + 2 * i) * DAY), release: DAY };
    case 'riftBarrier': return { attack: 0, sustain: duration ?? 0, release: 0 };
    default: return { attack: 0, sustain: 0, release: 0 };
  }
}

/** Lead time in ticks at the achieved sim speed (DESIGN R7). */
export function leadTicks(power: PowerId, intensity: number, achievedSpeed: number): number {
  const lead = isMajorPower(power, intensity) ? LEAD_MAJOR_S : LEAD_MINOR_S;
  return Math.max(1, Math.ceil(lead * Math.max(achievedSpeed, 1e-3) * TICK_HZ));
}

/** Schedule a cast command (CONTRACT 13 scheduled form). `achievedSpeed` > 0 (the host resumes paused countdowns). */
export function planCast(
  cmd: Extract<GodCommand, { t: 'cast' }>, issuedTick: number, achievedSpeed: number, author: 'god' | 'nature' = 'god',
): GodEventScheduled {
  return {
    cmdId: cmd.id, power: cmd.power, target: cmd.target, intensity: clamp(cmd.intensity, 0, 1),
    duration: cmd.duration ?? 0, seed: cmd.seed >>> 0, issuedTick,
    fireTick: issuedTick + leadTicks(cmd.power, cmd.intensity, achievedSpeed), author,
    envelope: envelopeFor(cmd.power, cmd.intensity, cmd.duration),
  };
}

/** Envelope value at a tick: 0 before, ramps 0..1, holds, releases; -1 once expired. */
export function envelopeValue(ev: GodEventScheduled, tick: number): number {
  const t = (tick - ev.fireTick) * DT;
  const { attack: a, sustain: s, release: r } = ev.envelope;
  if (t < 0) return 0;
  if (a + s + r <= 0) return -1;
  if (t < a) return t / a;
  if (t < a + s) return 1;
  if (t < a + s + r) return r > 0 ? 1 - (t - a - s) / r : 0;
  return -1;
}

/** Centre and radius of a target; radius < 0 means the whole tank. */
export function targetRegion(world: World, tg: Target): [number, number, number] {
  switch (tg.kind) {
    case 'point': return [tg.pos[0], tg.pos[1], 2];
    case 'circle': return [tg.pos[0], tg.pos[1], tg.radius];
    case 'depthBand': return [world.preset.widthM / 2, (tg.y0 + tg.y1) / 2, -1];
    case 'stroke': {
      const p = tg.points[0] ?? [world.preset.widthM / 2, world.preset.heightM / 2];
      return [p[0], p[1], 3];
    }
    case 'creature': {
      for (let s = 0; s < world.cr.highWater; s++) {
        if (world.cr.c.life[s] === LIFE.FREE) continue;
        const id = world.cr.c.idLo[s]! + world.cr.c.idHi[s]! * 4294967296;
        if (id === tg.entity) return [world.cr.c.posX[s]!, world.cr.c.posY[s]!, 1];
      }
      return [world.preset.widthM / 2, world.preset.heightM / 2, -1];
    }
    default: return [world.preset.widthM / 2, world.preset.heightM / 2, -1];
  }
}

/** Whether a living creature in this slot is selected by the target. */
export function inTarget(world: World, tg: Target, slot: number): boolean {
  const c = world.cr.c;
  const x = c.posX[slot]!, y = c.posY[slot]!;
  switch (tg.kind) {
    case 'global': return true;
    case 'species': return tg.species.includes(c.species[slot]!);
    case 'creature': return c.idLo[slot]! + c.idHi[slot]! * 4294967296 === tg.entity;
    case 'depthBand': return y >= tg.y0 && y <= tg.y1;
    case 'stroke': return tg.points.some((p) => (p[0] - x) ** 2 + (p[1] - y) ** 2 <= 1);
    default: {
      const [cx, cy, r] = targetRegion(world, tg);
      return r < 0 || (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    }
  }
}

/** Living slots selected by the target, in ascending slot order. */
function selected(world: World, tg: Target): number[] {
  const out: number[] = [];
  for (let s = 0; s < world.cr.highWater; s++) if (world.cr.c.life[s] === LIFE.ALIVE && inTarget(world, tg, s)) out.push(s);
  return out;
}

/** Leviathan endowment (CONTRACT 3.3): K_ENDOW x n x m_adult of N from outside, and M_target rises. */
export function leviathanEndowment(world: World, n: number, adultMassKg: number, pos: [number, number]): { ok: boolean; reason?: string; q: number } {
  const q = Math.floor((K_ENDOW * n * adultMassKg) / Q_MASS);
  if ((world.g.mTotalQ + q) * Q_MASS > 0.8 * MAX_WORLD_MASS_KG) return { ok: false, reason: 'endowment would exceed the world mass limit', q: 0 };
  injectSpread(world, pos[0], pos[1], 4, q);
  world.g.mTargetQ += q;
  return { ok: true, q };
}

/** Inject q quanta of dissolved N over the wet coarse cells within r of (x, y). */
function injectSpread(world: World, x: number, y: number, r: number, q: number): number {
  const [w, h] = world.fields.coarse;
  const cs = world.preset.widthM / w;
  const cells: number[] = [];
  for (let iy = 0; iy < h; iy++) for (let ix = 0; ix < w; ix++) {
    const dx = (ix + 0.5) * cs - x, dy = (iy + 0.5) * cs - y;
    if (dx * dx + dy * dy <= r * r) cells.push(iy * w + ix);
  }
  if (cells.length === 0) cells.push(coarseIndex(world, x, y));
  const each = Math.floor(q / cells.length);
  let rem = q - each * cells.length;
  let total = 0;
  for (const i of cells) { const a = each + (rem > 0 ? 1 : 0); if (rem > 0) rem--; total += inject(world, world.fields.qN, i, a); }
  return total;
}

function floorPoint(world: World, x: number): [number, number] {
  const [sw] = world.fields.sdfGrid;
  const cs = world.preset.widthM / sw;
  const ix = clamp(Math.floor(x / cs), 0, sw - 1);
  const iy = surfaceRow(world, ix);
  return [x, iy < 0 ? world.preset.heightM - 1 : iy * cs];
}

/** Hook set by the ecosystem index so terrain edits refresh masks. */
export type TerrainChanged = (world: World, s: EcoState) => void;

/** Apply a scheduled god event at its fire tick. */
export function applyGod(world: World, s: EcoState, ev: GodEventScheduled, ctx: StepContext, terrainChanged: TerrainChanged): void {
  const c = world.cr.c;
  const f = world.fields;
  const W = world.preset.widthM, H = world.preset.heightM;
  const scale = H / 36;
  const d = ctx.rng.draw(RNG_STREAM.GOD, ctx.tick, ev.seed);
  const i = ev.intensity;
  const [tx, ty, tr] = targetRegion(world, ev.target);
  const px = tr < 0 ? W * (0.2 + 0.6 * d.u01()) : tx;
  const kill = (slots: number[]): void => { for (const sl of slots) s.pending.deaths.push({ slot: sl, id: c.idLo[sl]! + c.idHi[sl]! * 4294967296, cause: 'disaster' }); };
  const within = (x: number, y: number, r: number): number[] => {
    const out: number[] = [];
    for (let sl = 0; sl < world.cr.highWater; sl++) if (c.life[sl] === LIFE.ALIVE && (c.posX[sl]! - x) ** 2 + (c.posY[sl]! - y) ** 2 <= r * r) out.push(sl);
    return out;
  };
  switch (ev.power) {
    case 'bloom': { // 20% of local N to plankton at once, then x3 growth on the envelope
      const [cw, chh] = f.coarse;
      const [fw] = f.fine;
      const rr = fw / cw;
      for (let iy = 0; iy < chh; iy++) for (let ix = 0; ix < cw; ix++) {
        const ci = iy * cw + ix;
        if (!s.wetC[ci]) continue;
        const cs = W / cw, x = (ix + 0.5) * cs, y = (iy + 0.5) * cs;
        if (tr >= 0 ? (x - tx) ** 2 + (y - ty) ** 2 > tr * tr : y > 0.3 * H) continue;
        const take = Math.floor(0.2 * f.qN[ci]!);
        const j = (iy * rr + (rr >> 1)) * fw + ix * rr + (rr >> 1);
        transfer(f.qN, ci, f.qP, j, take, world, CH.photosynthesis);
      }
      break;
    }
    case 'marineSnow': { // a pulse of surface plankton turns to sinking detritus
      const [fw, fh] = f.fine;
      const [cw] = f.coarse;
      const rr = fw / cw;
      for (let jy = 0; jy < Math.floor(fh * 0.3); jy++) for (let jx = 0; jx < fw; jx++) {
        const j = jy * fw + jx;
        transfer(f.qP, j, f.qD, ((jy / rr) | 0) * cw + ((jx / rr) | 0), Math.floor(f.qP[j]! * (0.2 + 0.6 * i)), world, CH.decay);
      }
      break;
    }
    case 'vent': {
      const [x, y] = floorPoint(world, px);
      const r = (1 + 2 * i) * scale;
      paintCircle(world, x, y, r, MATERIAL.ROCK, false, true);
      const [sw] = f.sdfGrid;
      const cs = W / sw;
      const ix = clamp(Math.floor(x / cs), 0, sw - 1);
      const iy = surfaceRow(world, ix);
      if (iy >= 0) { f.material[iy * sw + ix] = MATERIAL.VENT; s.terrain.vents.push({ x: (ix + 0.5) * cs, y: iy * cs, bornTick: ctx.tick, output: 1 + i, permanent: false }); }
      kill(within(x, y - r, r + 0.5));
      for (let k = 0; k < 4; k++) f.turb[coarseIndex(world, x, y - r - k * 0.5)] = f.turb[coarseIndex(world, x, y - r - k * 0.5)]! + 2 * i;
      wakeReservoirStrain(world, s, x, y - r - 0.3, d.u32());
      terrainChanged(world, s);
      break;
    }
    case 'meteor': {
      const rk = (i < 0.33 ? 0.5 : i < 0.85 ? 2 : 6) * scale;
      const [x, y] = ev.target.kind === 'point' || ev.target.kind === 'circle' ? [tx, ty] : floorPoint(world, px);
      kill(within(x, y, rk));
      paintCircle(world, x, y, rk * 0.8, MATERIAL.CRATER_GLASS, true);
      carveCircle(world, x, y, rk * 0.6);
      // dust and resuspended sediment
      const [cw, chh] = f.coarse;
      for (let k = 0; k < cw * chh; k++) f.turb[k] = f.turb[k]! + (0.5 + 2.5 * i);
      const cs = W / cw;
      for (let ix = 0; ix < cw; ix++) {
        if (Math.abs((ix + 0.5) * cs - x) > 2 * rk) continue;
        const iyF = s.floorRowC[ix]!;
        if (iyF >= 0) transfer(f.qSed, ix, f.qD, iyF * cw + ix, Math.floor(0.5 * f.qSed[ix]!), world, CH.decay);
      }
      injectSpread(world, x, Math.max(0.5, y - rk), Math.max(2, rk * 2), Math.floor((0.01 + 0.09 * i) * world.g.mTargetQ));
      wakeReservoirStrain(world, s, x, Math.max(0.2, y - rk), d.u32());
      terrainChanged(world, s);
      break;
    }
    case 'nutrientFlood': {
      const q = Math.floor((0.05 + 0.45 * i) * world.g.mTargetQ);
      if ((world.g.mTotalQ + q) * Q_MASS > 0.8 * MAX_WORLD_MASS_KG) { s.diag.refusedEndowments++; break; }
      if (tr < 0) injectSpread(world, 0.05 * W, 0.5, 0.12 * W, q); else injectSpread(world, tx, ty, Math.max(2, tr), q);
      break;
    }
    case 'plague': {
      let members = selected(world, ev.target);
      if (members.length === 0) members = selected(world, { kind: 'global' });
      if (members.length === 0) break;
      const host = members[Math.floor(d.u01() * members.length)]!;
      const sp = c.species[host]!;
      const kStrain = newStrain(s, ctx.tick, {
        antigen: d.u32(), adhesin: c.surfaceSig[host]!, beta: 0.5 + 2.5 * i, virulence: 0.2 + 1.8 * i, growth: 3 + 3 * i, envHalfLife: 300 + 900 * i,
      });
      if (kStrain < 0) break;
      const same = members.filter((sl) => c.species[sl] === sp);
      const hx = c.posX[host]!, hy = c.posY[host]!;
      same.sort((a, b) => ((c.posX[a]! - hx) ** 2 + (c.posY[a]! - hy) ** 2) - ((c.posX[b]! - hx) ** 2 + (c.posY[b]! - hy) ** 2) || a - b);
      const k = Math.min(same.length, Math.round(5 + 45 * i));
      for (let n = 0; n < k; n++) {
        const sl = same[n]!;
        const lane = c.infStrain[sl * 2] === NONE_U32 ? 0 : 1;
        c.infStrain[sl * 2 + lane] = kStrain; c.infLoad[sl * 2 + lane] = 0.1;
        c.flags[sl] = c.flags[sl]! | CF.INFECTED;
      }
      break;
    }
    case 'cull': {
      const members = selected(world, ev.target);
      const k = Math.round((0.1 + 0.9 * i) * members.length);
      for (let n = 0; n < k; n++) { // partial Fisher-Yates from stream GOD
        const j = n + Math.floor(d.u01() * (members.length - n));
        const t = members[n]!; members[n] = members[j]!; members[j] = t;
      }
      kill(members.slice(0, k).sort((a, b) => a - b));
      break;
    }
    case 'bless': { // energy top-up drawn from the reservoir, then dissolved N
      for (const sl of selected(world, ev.target)) {
        const o = sl * ER_LANES;
        const cap = sl < s.erCap ? s.er[o + ER.FAT_CAP]! : 0.3;
        const want = Math.floor(i * (cap * (c.qTissue[sl]! + c.qReserve[sl]!) - c.qReserve[sl]!));
        if (want <= 0) continue;
        let got = Math.min(want, world.g.qReservoir);
        world.g.qReservoir -= got;
        const ci = coarseIndex(world, c.posX[sl]!, c.posY[sl]!);
        const more = Math.min(want - got, f.qN[ci]!);
        f.qN[ci] = f.qN[ci]! - more; got += more;
        c.qReserve[sl] = c.qReserve[sl]! + got;
        book(world, CH.godInjection, 0);
      }
      break;
    }
    case 'whaleFall':
      s.pending.spawns.push({ kind: 'carcass', cmdId: ev.cmdId, pos: [tx, tr < 0 ? 0.5 : ty], massQ: Math.floor((0.001 + 0.01 * i) * world.g.mTargetQ), count: 1 });
      break;
    case 'predatorFlood':
      s.pending.spawns.push({ kind: 'predatorFlood', cmdId: ev.cmdId, pos: [tx, ty], massQ: 0, count: Math.round(5 + 45 * i) });
      break;
    case 'earthquake': {
      const cave = s.terrain.caves.length > 0 ? s.terrain.caves[Math.floor(d.u01() * s.terrain.caves.length)]! : null;
      if (cave && i > 0.5) paintCircle(world, cave.x, cave.y, cave.r * 0.8, MATERIAL.ROCK, false, true);
      else if (cave) carveCircle(world, cave.x + cave.r, cave.y, cave.r * (0.5 + i));
      const [cw] = f.coarse;
      const cs = W / cw;
      for (let ix = 0; ix < cw; ix++) {
        if (tr >= 0 && Math.abs((ix + 0.5) * cs - tx) > 4 * scale) continue;
        const iyF = s.floorRowC[ix]!;
        if (iyF >= 0) { transfer(f.qSed, ix, f.qD, iyF * cw + ix, Math.floor((0.1 + 0.3 * i) * f.qSed[ix]!), world, CH.decay); f.turb[iyF * cw + ix] = f.turb[iyF * cw + ix]! + 1 + 2 * i; }
      }
      wakeReservoirStrain(world, s, cave?.x ?? px, cave?.y ?? H * 0.8, d.u32());
      terrainChanged(world, s);
      break;
    }
    case 'riftBarrier': {
      const x = tr < 0 ? W / 2 : tx;
      const [sw, sh] = f.sdfGrid;
      const cs = W / sw;
      const ix0 = clamp(Math.floor((x - 0.25 * scale - 0.125) / cs), 1, sw - 2), ix1 = clamp(Math.floor((x + 0.25 * scale + 0.125) / cs), 1, sw - 2);
      const saved: number[] = [];
      for (let ix = ix0; ix <= ix1; ix++) {
        const floor = surfaceRow(world, ix);
        const top = i > 0.5 ? 0 : Math.floor((floor < 0 ? sh : floor) * 0.5);
        for (let iy = top; iy < (floor < 0 ? sh : floor); iy++) {
          const k = iy * sw + ix;
          if (f.material[k] === MATERIAL.WATER) { f.material[k] = MATERIAL.ROCK; saved.push(k); }
        }
      }
      s.barriers.set(ev.cmdId, saved);
      terrainChanged(world, s);
      break;
    }
    case 'seasons':
      s.yearOffset = (i - (world.g.tick * DT) / ((world.config.dayS ?? DAY_S) * (world.config.yearDays ?? 20))) % 1;
      break;
    default: break; // envelope-only powers
  }
  const e = ev.envelope;
  if (e.attack + e.sustain + e.release > 0) world.g.modifiers.push(ev);
  ctx.events.emit({ k: 'god', cmdId: ev.cmdId, power: ev.power, author: ev.author, tFire: ev.fireTick, pos: [tx, ty], radius: tr, strength: i, major: isMajorPower(ev.power, i) } as never);
}

/** Rebuild the aggregated modifiers from the active envelopes; expired ones leave the stack. */
export function evalModifiers(world: World, s: EcoState, tick: number, terrainChanged: TerrainChanged): void {
  const m = newMods();
  const keep: GodEventScheduled[] = [];
  let terrain = false;
  for (const ev of world.g.modifiers) {
    const v = envelopeValue(ev, tick);
    if (v < 0) {
      const saved = s.barriers.get(ev.cmdId);
      if (saved) { for (const k of saved) if (world.fields.material[k] === MATERIAL.ROCK) world.fields.material[k] = MATERIAL.WATER; s.barriers.delete(ev.cmdId); terrain = true; }
      continue;
    }
    if (ev.power === 'riftBarrier' && ev.envelope.sustain === 0) { keep.push(ev); continue; }
    keep.push(ev);
    const i = ev.intensity;
    const [x, y, r] = targetRegion(world, ev.target);
    switch (ev.power) {
      case 'coldSnap': m.tempOffset -= 10 * i * v; break;
      case 'heatwave': m.tempOffset += 10 * i * v; break;
      case 'bloom': if (r < 0) m.muBoost *= 1 + 2 * v; else m.blooms.push([x, y, r, 1 + 2 * v]); break;
      case 'meteor': m.turbAdd += (0.5 + 2 * i) * v / DAY_S; if (i > 0.5) m.tempOffset -= (2 + 4 * (i - 0.5) * 2) * v; m.lightMult *= 1 - 0.7 * v * i; break;
      case 'currentShift': {
        for (let k = 0; k < 8; k++) m.flowMult[k] = m.flowMult[k]! * (1 + v * ((((ev.seed >>> (k * 3)) & 7) / 7) * 2.2 - 0.7));
        if (ev.seed & 1) m.flowFlip = v > 0.5 ? !m.flowFlip : m.flowFlip;
        break;
      }
      case 'longNight': m.lightMult *= 1 - 0.9 * i * v; break;
      case 'mutagen': if (r < 0) m.mutagen *= 1 + (1 + 18 * i) * v; else m.mutagens.push([x, y, r, 1 + (1 + 18 * i) * v]); break;
      case 'toxinLeak': m.toxins.push([x, y, r, i * v]); break;
      case 'iceAge': m.tempOffset -= 8 * v; m.iceDrop = Math.max(m.iceDrop, (1 + 2 * i) * (world.preset.heightM / 36) * v); m.lightMult *= 1 - 0.7 * v; break;
      case 'storm': m.kzMult *= 1 + 9 * v; m.flowMult[0] = m.flowMult[0]! * (1 + 2 * i * v); m.flowMult[2] = m.flowMult[2]! * (1 + 2 * i * v); break;
      case 'deadZone': m.deadZones.push([x, y, r < 0 ? 4 : r, 0.1 + 0.9 * (1 - v)]); break;
      case 'vent': m.turbAdd += 0.5 * i * v / DAY_S; break;
      default: break;
    }
  }
  world.g.modifiers = keep;
  s.mods = m;
  // vents installed by the vent power halve their output every 20 days
  for (const v of s.terrain.vents) if (!v.permanent) v.output = Math.max(0.05, v.output * 0.5 ** ((15 * DT) / (20 * DAY_S)));
  // sea level and ice (CONTRACT 2: ySurface > 0 during an ice age)
  const target = m.iceDrop;
  if (Math.abs(target - world.g.ySurface) >= world.preset.widthM / world.fields.sdfGrid[0]) {
    world.g.ySurface = target;
    applyIce(world);
    terrain = true;
  }
  if (terrain) terrainChanged(world, s);
}

function applyIce(world: World): void {
  const [sw, sh] = world.fields.sdfGrid;
  const cs = world.preset.widthM / sw;
  const mat = world.fields.material;
  for (let iy = 0; iy < sh; iy++) {
    const above = (iy + 0.5) * cs < world.g.ySurface;
    for (let ix = 0; ix < sw; ix++) {
      const k = iy * sw + ix;
      if (above && mat[k] === MATERIAL.WATER) mat[k] = MATERIAL.ICE;
      else if (!above && mat[k] === MATERIAL.ICE) mat[k] = MATERIAL.WATER;
    }
  }
  rebuildSdf(world);
}

/** Mutation-rate multiplier at a point (for the sim's MutationContext.mutagen). */
export function mutagenAt(s: EcoState, x: number, y: number): number {
  let k = s.mods.mutagen;
  for (const z of s.mods.mutagens) if ((x - z[0]!) ** 2 + (y - z[1]!) ** 2 <= z[2]! * z[2]!) k *= z[3]!;
  return k;
}

/**
 * Nature mode (William's Q7): on governor ticks, a Poisson process at 0.1 per sim day issues a
 * mild event (coldSnap, heatwave, currentShift, storm or bloom) at magnitude at most 0.4.
 * Pure function of (seed, tick); returns null on most ticks.
 */
export function natureEvent(world: World, ctx: StepContext, enabled: boolean, ratePerS = 0.1 / DAY_S): GodEventScheduled | null {
  if (!enabled || ctx.tick % GOVERNOR_EVERY !== 0) return null;
  const d = ctx.rng.draw(RNG_STREAM.NATURE, ctx.tick, 0);
  if (d.u01() >= ratePerS * GOVERNOR_EVERY * DT) return null;
  const power = NATURE_POWERS[Math.floor(d.u01() * NATURE_POWERS.length)]!;
  const intensity = Math.round((0.1 + 0.3 * d.u01()) * 1000) / 1000;
  const target: Target = power === 'bloom'
    ? { kind: 'circle', pos: [world.preset.widthM * (0.1 + 0.8 * d.u01()), world.preset.heightM * 0.1], radius: 3 }
    : { kind: 'global' };
  const seed = d.u32();
  const ev = planCast({ t: 'cast', id: `nature-${ctx.tick}`, epoch: world.g.epoch, power, target, intensity: Math.min(intensity, NATURE_MAX_MAGNITUDE), seed }, ctx.tick, 1, 'nature');
  return ev;
}
