/**
 * Severing and corpse fragments (02 §2.4.7; DESIGN §10 Q5: "fragments stay as food, fade their
 * glow over 30 s and sink").
 *
 * A segment at damage 1 detaches with its subtree. Physics finds these during `step` and queues
 * a request; the split itself needs a new creature slot, a segment range and an exact move of
 * tissue and reserve quanta, which belong to the sim and the ecosystem, so `commitSevers` takes
 * those three operations as hooks (contract request PH2-1 in docs/contract-requests/physics2.md).
 * `localSeverHooks` is the adapter tests use until the sim calls this from its commit.
 *
 * The fragment is a CARCASS creature with `CF.FRAGMENT`: the same segments with their world
 * poses and velocities, joints limp (muscles off, passive stiffness only), waterlogged so it
 * always sinks, its glow fading linearly to zero over `FRAGMENT_GLOW_S`. The survivor keeps the
 * remaining segments, compacted in parent-first order; `partOf` maps every segment back to its
 * Phenotype part so `restage` and the brain can address it after a loss.
 */
import {
  CF, CREATURE_COLUMNS, DT, KIND, LIFE, NONE_U32, Q_MASS, SEGMENT_COLUMNS, type AnyTypedArray, type World,
} from '../core/index.js';
import { boundaryRuns, dragCoeffs } from './body.js';
import { linkState } from './links.js';
import type { SegmentSpec } from './segment-spec.js';
import { workFor } from './work.js';

/** Glow fade time of a fragment, s (DESIGN Q5). */
export const FRAGMENT_GLOW_S = 30;
/** A fragment is at least this much denser than the water it displaces (waterlogged tissue). */
export const FRAGMENT_SINK_RATIO = 1.03;

export interface SeverRequest { slot: number; gen: number; seg: number; tick: number }

export interface SeverHooks {
  /** A free creature slot with a fresh entity id and `birthTick` set, or -1. */
  allocCreature(world: World): number;
  /** `n` contiguous free segment slots for `slot`; sets `segStart`, `segCount` and `owner`. */
  allocSegments(world: World, slot: number, n: number): boolean;
  /** Exact integer transfers of tissue and reserve quanta between two creature records. */
  moveQuanta(world: World, from: number, to: number, qTissue: number, qReserve: number): void;
}

export interface SeverResult {
  parent: number; fragment: number;
  /** Old local index to the survivor's new local index, -1 if it left with the fragment. */
  keep: Int16Array;
  /** Old local index to the fragment's local index, -1 if it stayed. */
  moved: Int16Array;
  qTissue: number; qReserve: number;
}

interface SeverState { queue: SeverRequest[] }
const states = new WeakMap<World, SeverState>();
function severState(world: World): SeverState {
  let s = states.get(world);
  if (!s) { s = { queue: [] }; states.set(world, s); }
  return s;
}

/** Pending requests (read-only view, for tests and the inspector). */
export function pendingSevers(world: World): readonly SeverRequest[] { return severState(world).queue; }

/**
 * Queue a sever for every segment that reached damage 1 and whose ancestors did not (the cut is
 * at the highest broken joint). Called at the end of `physics.step`; idempotent.
 */
export function findSevers(world: World): number {
  const c = world.cr.c; const sg = world.seg.c;
  const q = severState(world).queue;
  let added = 0;
  for (let s = 0; s < world.cr.highWater; s++) {
    const life = c.life[s];
    if (life !== LIFE.ALIVE && life !== LIFE.CARCASS) continue;
    const n = c.segCount[s]!;
    if (n < 2) continue;
    const s0 = c.segStart[s]!;
    for (let k = 1; k < n; k++) {
      if (sg.damage[s0 + k]! < 1) continue;
      let p = sg.parent[s0 + k]!; let top = true;
      while (p > 0) { if (sg.damage[s0 + p]! >= 1) { top = false; break; } p = sg.parent[s0 + p]!; }
      if (!top) continue;
      if (q.some((r) => r.slot === s && r.seg === k && r.gen === c.gen[s])) continue;
      q.push({ slot: s, gen: c.gen[s]!, seg: k, tick: world.g.tick });
      added++;
    }
  }
  return added;
}

function cols(pool: World['seg'] | World['cr'], spec: readonly { name: string; lanes?: number; init?: number }[]): { a: AnyTypedArray; lanes: number; init: number; name: string }[] {
  const c = pool.c as unknown as Record<string, AnyTypedArray>;
  return spec.map((s) => ({ a: c[s.name]!, lanes: s.lanes ?? 1, init: s.init ?? 0, name: s.name }));
}

function copyRow(col: { a: AnyTypedArray; lanes: number }, from: number, to: number): void {
  for (let l = 0; l < col.lanes; l++) col.a[to * col.lanes + l] = col.a[from * col.lanes + l]!;
}

/**
 * Apply the queued severs in (slot, segment) order. Requests whose creature changed (slot
 * reused, segment gone or healed) are dropped. Returns what was done, for the sim's remapping.
 */
export function commitSevers(world: World, hooks: SeverHooks): SeverResult[] {
  const st = severState(world);
  const reqs = st.queue.slice().sort((a, b) => a.slot - b.slot || b.seg - a.seg);
  st.queue = [];
  const out: SeverResult[] = [];
  // one cut per creature per commit: the cut compacts the survivor, so its other requests hold
  // stale indices; they are dropped and findSevers queues them again at the next step
  const done = new Set<number>();
  for (const r of reqs) {
    if (done.has(r.slot)) continue;
    const res = severOne(world, r, hooks);
    if (res) { out.push(res); done.add(r.slot); }
  }
  return out;
}

function severOne(world: World, r: SeverRequest, hooks: SeverHooks): SeverResult | null {
  const c = world.cr.c; const sg = world.seg.c;
  const slot = r.slot;
  const life = c.life[slot];
  if ((life !== LIFE.ALIVE && life !== LIFE.CARCASS) || c.gen[slot] !== r.gen) return null;
  const n = c.segCount[slot]!;
  if (r.seg <= 0 || r.seg >= n) return null;
  if (sg.damage[c.segStart[slot]! + r.seg]! < 1) return null;
  // subtree of r.seg (parent-first order, so one pass suffices)
  let s0 = c.segStart[slot]!;
  const inSub = new Uint8Array(n);
  inSub[r.seg] = 1;
  let m = 1;
  for (let k = r.seg + 1; k < n; k++) {
    const p = sg.parent[s0 + k]!;
    if (p >= 0 && inSub[p] === 1) { inSub[k] = 1; m++; }
  }
  const frag = hooks.allocCreature(world);
  if (frag < 0) return null;
  if (!hooks.allocSegments(world, frag, m)) {
    c.life[frag] = LIFE.FREE; // nothing was moved into it; the hook's slot is returned
    return null;
  }
  s0 = c.segStart[slot]!; // allocation may have compacted the pool
  const f0 = c.segStart[frag]!;
  const segCols = cols(world.seg, SEGMENT_COLUMNS);
  const wk = workFor(world);
  const wkCols: { a: AnyTypedArray; lanes: number }[] = [
    { a: wk.muscleFrac, lanes: 1 }, { a: wk.subtype, lanes: 1 }, { a: wk.restPrev, lanes: 1 }, { a: wk.restInit, lanes: 1 },
    { a: wk.part, lanes: 1 }, { a: wk.jetVol, lanes: 1 }, { a: wk.gasMol, lanes: 1 },
  ];
  const keep = new Int16Array(n).fill(-1);
  const moved = new Int16Array(n).fill(-1);
  let nk = 0; let nm = 0;
  for (let k = 0; k < n; k++) if (inSub[k] === 1) moved[k] = nm++; else keep[k] = nk++;
  // 1. fragment rows (before the survivor is compacted over them)
  let mSub = 0; let mAll = 0;
  for (let k = 0; k < n; k++) {
    mAll += sg.mass[s0 + k]!;
    if (moved[k]! < 0) continue;
    const to = f0 + moved[k]!;
    for (const col of segCols) copyRow(col, s0 + k, to);
    for (const col of wkCols) copyRow(col, s0 + k, to);
    const p = sg.parent[s0 + k]!;
    sg.parent[to] = k === r.seg ? -1 : moved[p]!;
    sg.owner[to] = frag;
    sg.cmd[to] = 0; sg.cmd2[to] = 0; sg.act[to] = 0; sg.work[to] = 0; sg.touch[to] = 0;
    wk.gasMol[to] = 0; // a torn bladder vents
    mSub += sg.mass[to]!;
  }
  sg.damage[f0] = 0; // the cut itself; the fragment root has no joint left to break
  sg.compliance[f0] = 0; sg.damping[f0] = 0; sg.tauMax[f0] = 0; sg.omegaMax[f0] = 0;
  // 2. survivor: compact kept rows in place (new index <= old index, so forward copies are safe)
  for (let k = 0; k < n; k++) {
    const to = keep[k]!;
    if (to < 0 || to === k) continue;
    for (const col of segCols) copyRow(col, s0 + k, s0 + to);
    for (const col of wkCols) copyRow(col, s0 + k, s0 + to);
  }
  for (let k = 0; k < nk; k++) {
    const p = sg.parent[s0 + k]!;
    if (k > 0) sg.parent[s0 + k] = keep[p]!;
  }
  for (let k = nk; k < n; k++) {
    for (const col of segCols) for (let l = 0; l < col.lanes; l++) col.a[(s0 + k) * col.lanes + l] = col.init;
  }
  c.segCount[slot] = nk;
  // 3. links follow their segments
  for (const l of linkState(world).links) {
    const ka = l.a - s0; const kb = l.b - s0;
    if (ka >= 0 && ka < n) l.a = moved[ka]! >= 0 ? f0 + moved[ka]! : s0 + keep[ka]!;
    if (kb >= 0 && kb < n) l.b = moved[kb]! >= 0 ? f0 + moved[kb]! : s0 + keep[kb]!;
  }
  // 4. fragment record: a copy of the survivor's with its own pose, no brain, no ledger pools
  const crCols = cols(world.cr, CREATURE_COLUMNS);
  const own = new Set(['idLo', 'idHi', 'gen', 'birthTick', 'segStart', 'segCount']);
  const zero = new Set(['qTissue', 'qReserve', 'qRepro', 'qGut', 'carry', 'powerW', 'brainW', 'out', 'infLoad', 'reproTimer', 'diet']);
  for (const col of crCols) {
    if (own.has(col.name)) continue;
    if (zero.has(col.name)) { for (let l = 0; l < col.lanes; l++) col.a[frag * col.lanes + l] = 0; continue; }
    copyRow(col, slot, frag);
  }
  c.life[frag] = LIFE.CARCASS;
  c.flags[frag] = (c.flags[slot]! & CF.LEVIATHAN) | CF.FRAGMENT;
  c.brainClass[frag] = 255; c.brainSlot[frag] = NONE_U32;
  c.infStrain[frag * 2] = NONE_U32; c.infStrain[frag * 2 + 1] = NONE_U32;
  c.health[frag] = 0;
  c.birthTick[frag] = world.g.tick;
  c.posX[frag] = sg.posX[f0]!; c.posY[frag] = sg.posY[f0]!;
  c.heading[frag] = sg.angle[f0]!; c.angVel[frag] = sg.angVel[f0]!;
  let px = 0; let py = 0; let len = 0;
  for (let k = 0; k < m; k++) { px += sg.mass[f0 + k]! * sg.velX[f0 + k]!; py += sg.mass[f0 + k]! * sg.velY[f0 + k]!; len += sg.len[f0 + k]!; }
  c.velX[frag] = px / mSub; c.velY[frag] = py / mSub;
  c.length[frag] = len;
  c.length[slot] = Math.max(0, c.length[slot]! - len);
  // 5. new free ends get their end-cap drag
  refreshDrag(world, slot); refreshDrag(world, frag);
  // 6. exact mass: the fragment takes its share of tissue and reserve, rounded down
  const f = mAll > 0 ? mSub / mAll : 0;
  const qT = Math.floor(c.qTissue[slot]! * f);
  const qR = Math.floor(c.qReserve[slot]! * f);
  hooks.moveQuanta(world, slot, frag, qT, qR);
  return { parent: slot, fragment: frag, keep, moved, qTissue: qT, qReserve: qR };
}

/** Recompute the drag coefficients of a creature from its pool geometry (after a topology change). */
export function refreshDrag(world: World, slot: number): void {
  const c = world.cr.c; const sg = world.seg.c;
  const s0 = c.segStart[slot]!; const n = c.segCount[slot]!;
  const specs: SegmentSpec[] = [];
  const hasChild = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const i = s0 + k;
    if (k > 0) hasChild[sg.parent[i]!] = 1;
    specs.push({
      parent: sg.parent[i]!, attachU: sg.attachU[i]!, restAngle: sg.restAngle[i]!, length: sg.len[i]!, radius: sg.radius[i]!,
      span: sg.span[i]!, kind: sg.kind[i]!, organs: sg.organs[i]!, muscleFrac: 0, lipidFrac: 0, armour: 0, youngsE: 0,
      limitLo: 0, limitHi: 0, damping: 0, plate: sg.kind[i] === KIND.FIN,
    });
  }
  const run = boundaryRuns(specs);
  for (let k = 0; k < n; k++) {
    const s = specs[k]!;
    dragCoeffs(s.plate, s.length, s.radius, s.span, k === 0 || hasChild[k] === 0, sg.drag, (s0 + k) * 5, run[k]!);
  }
}

/** Glow multiplier of a fragment `ageS` seconds after the cut: linear to zero at 30 s. */
export function fragmentGlow(ageS: number): number {
  const f = 1 - ageS / FRAGMENT_GLOW_S;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/**
 * Fade the glow of every fragment by one tick (adapter, PH2-2: the ecosystem's glow pass owns
 * the column and should apply `fragmentGlow`). Stateless: g(t + dt) = g(t) (T - t - dt) / (T - t).
 */
export function fadeFragments(world: World, dt = DT): void {
  const c = world.cr.c; const sg = world.seg.c;
  for (let s = 0; s < world.cr.highWater; s++) {
    if (c.life[s] !== LIFE.CARCASS || (c.flags[s]! & CF.FRAGMENT) === 0) continue;
    const age = (world.g.tick - c.birthTick[s]!) * dt;
    const rem = FRAGMENT_GLOW_S - age;
    const k = rem <= dt ? 0 : (rem - dt) / rem;
    c.glow[s] = c.glow[s]! * k;
    const s0 = c.segStart[s]!;
    for (let j = 0; j < c.segCount[s]!; j++) sg.glow[s0 + j] = sg.glow[s0 + j]! * k;
  }
}

/**
 * Local adapter for the three hooks (tests; the sim's own allocators replace it). Creature
 * slot lowest free first; segments first fit above every used row; quanta moved exactly and the
 * cached `massKg` of both records updated from the moved quanta.
 */
export const localSeverHooks: SeverHooks = {
  allocCreature(world) {
    const c = world.cr.c;
    let slot = -1;
    for (let s = 0; s < world.cr.highWater; s++) if (c.life[s] === LIFE.FREE) { slot = s; break; }
    if (slot < 0) {
      if (world.cr.highWater >= world.cr.capacity) return -1;
      slot = world.cr.highWater++;
    }
    const id = world.g.nextEntityId++;
    c.idLo[slot] = id % 4294967296 >>> 0;
    c.idHi[slot] = Math.floor(id / 4294967296) >>> 0;
    c.gen[slot] = (c.gen[slot]! + 1) & 0xffff;
    c.birthTick[slot] = world.g.tick;
    c.life[slot] = LIFE.CARCASS;
    return slot;
  },
  allocSegments(world, slot, n) {
    const owner = world.seg.c.owner;
    let run = 0; let start = -1;
    for (let k = 0; k < world.seg.capacity; k++) {
      if (owner[k] === NONE_U32) { if (++run === n) { start = k - n + 1; break; } } else run = 0;
    }
    if (start < 0) return false;
    for (let k = start; k < start + n; k++) owner[k] = slot;
    if (start + n > world.seg.highWater) world.seg.highWater = start + n;
    world.cr.c.segStart[slot] = start; world.cr.c.segCount[slot] = n;
    return true;
  },
  moveQuanta(world, from, to, qT, qR) {
    const c = world.cr.c;
    const t = Math.min(qT, c.qTissue[from]!); const r = Math.min(qR, c.qReserve[from]!);
    c.qTissue[from] = c.qTissue[from]! - t; c.qTissue[to] = c.qTissue[to]! + t;
    c.qReserve[from] = c.qReserve[from]! - r; c.qReserve[to] = c.qReserve[to]! + r;
    const kg = (t + r) * Q_MASS;
    c.massKg[to] = kg;
    c.massKg[from] = Math.max(0, c.massKg[from]! - kg);
  },
};
