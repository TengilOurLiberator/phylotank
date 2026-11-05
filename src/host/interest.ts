/**
 * Per-client interest management and the three LOD streams (05 §5.3.3 to 5.3.5, CONTRACT 12).
 *
 * Each client has an interest rect (its viewport grown by 25%, stretched along the camera's
 * predicted motion). Every live creature inside it is classified by projected size: at least
 * 4 px is a body (BODY_ENTER once, then BODY_FRAME records), 0.5 to 4 px is a dust point
 * (DUST_FRAME), smaller or over budget is splatted into the GLOW_FIELD. Slots are stable per
 * client and reused lowest-first (review R18).
 *
 * A client that has not sent a VIEWPORT yet (the phase-0 views) gets the whole tank as dust,
 * which is what those renderers draw.
 */
import {
  ByteWriter, DUST_EMPTY, encodeBodyEnter, encodeBodyFrame, encodeBodyLeave, encodeDust, FRAME, HEADER_BYTES, LIFE,
  quantRel, speedToByte, TAU, writeHeader, type BodyEnter, type BodyRecord, type DustFrame, type Rect, type Viewport,
  type World,
} from '../core/index.js';

export const LOD = { BODY: 0, DUST: 1, GLOW: 2 } as const;
export const BODY_MIN_PX = 4;
export const DUST_MIN_PX = 0.5;
export const INTEREST_GROW = 0.25;
export const MAX_LEAD_S = 1;
export const GLOW_W = 128;
export const GLOW_H = 72;
/** Slots of headroom before a sparse slot range is compacted. */
export const COMPACT_SLACK = 64;

export interface Caps { maxBytesPerSec: number; maxBodies: number; maxDust: number }
export const DEFAULT_CAPS: Caps = { maxBytesPerSec: 4_000_000, maxBodies: 2_000, maxDust: 150_000 };

/** Stable slot allocator: lowest free first; freed slots become reusable only after `settle()`. */
export class SlotMap {
  private readonly byId = new Map<number, number>();
  private readonly ids: number[] = [];
  private free: number[] = [];
  private cooling: number[] = [];
  constructor(readonly max: number) {}
  get size(): number { return this.byId.size; }
  /** One past the highest slot in use or cooling (the frame's nSlots). */
  get extent(): number { return this.ids.length; }
  slotOf(id: number): number | undefined { return this.byId.get(id); }
  idAt(slot: number): number { return this.ids[slot] ?? -1; }
  alloc(id: number): number {
    const have = this.byId.get(id);
    if (have !== undefined) return have;
    let slot: number;
    if (this.free.length > 0) slot = this.free.shift()!;
    else if (this.ids.length < this.max) slot = this.ids.length;
    else return -1;
    this.ids[slot] = id;
    this.byId.set(id, slot);
    return slot;
  }
  release(id: number): number {
    const slot = this.byId.get(id);
    if (slot === undefined) return -1;
    this.byId.delete(id);
    this.ids[slot] = -1;
    this.cooling.push(slot);
    return slot;
  }
  /** Called after a frame went out: cooled slots join the free list, sorted so reuse is lowest-first. */
  settle(): void {
    if (this.cooling.length === 0) return;
    this.free = [...this.free, ...this.cooling].sort((a, b) => a - b);
    this.cooling = [];
    // trim free slots at the top so nSlots shrinks with the population
    while (this.free.length > 0 && this.free[this.free.length - 1] === this.ids.length - 1) {
      this.free.pop();
      this.ids.pop();
    }
  }
  liveIds(): number[] { return [...this.byId.keys()]; }
  clear(): void { this.byId.clear(); this.ids.length = 0; this.free = []; this.cooling = []; }
}

export function entityId(world: World, slot: number): number {
  return world.cr.c.idHi[slot]! * 4294967296 + world.cr.c.idLo[slot]!;
}

/** Expand a rect by `grow` of its size on every side, then towards the predicted centre offset. */
export function interestRect(v: Rect, grow: number, lead: [number, number]): Rect {
  const w = v[2] - v[0];
  const h = v[3] - v[1];
  const r: Rect = [v[0] - grow * w, v[1] - grow * h, v[2] + grow * w, v[3] + grow * h];
  if (lead[0] < 0) r[0] += lead[0]; else r[2] += lead[0];
  if (lead[1] < 0) r[1] += lead[1]; else r[3] += lead[1];
  return r;
}

export interface Classified { body: number[]; dust: number[]; glow: number[] }

/**
 * Classify live creatures (by world slot) into LOD tiers for one interest rect. Ranking within
 * budget: log2(px) + 2 * salience + hero (05 §5.3.3); ties by world slot, so it is stable.
 */
export function classify(world: World, rect: Rect, pxPerM: number | null, caps: { maxBodies: number; maxDust: number },
  salience: (id: number) => number = () => 0): Classified {
  const c = world.cr.c;
  const body: { s: number; score: number }[] = [];
  const dust: { s: number; score: number }[] = [];
  const glow: number[] = [];
  for (let s = 0; s < world.cr.highWater; s++) {
    if (c.life[s] === LIFE.FREE) continue;
    const x = c.posX[s]!; const y = c.posY[s]!;
    if (x < rect[0] || x > rect[2] || y < rect[1] || y > rect[3]) continue;
    if (pxPerM === null) { dust.push({ s, score: 0 }); continue; }
    const px = Math.max(c.length[s]!, 1e-6) * pxPerM;
    const score = Math.log2(px) + 2 * salience(entityId(world, s));
    if (px >= BODY_MIN_PX || score >= Math.log2(BODY_MIN_PX)) body.push({ s, score });
    else if (px >= DUST_MIN_PX) dust.push({ s, score });
    else glow.push(s);
  }
  const byScore = (a: { s: number; score: number }, b: { s: number; score: number }): number => b.score - a.score || a.s - b.s;
  body.sort(byScore);
  const keptBodies = body.slice(0, Math.max(0, caps.maxBodies));
  const dustAll = [...body.slice(keptBodies.length), ...dust].sort(byScore);
  const keptDust = dustAll.slice(0, Math.max(0, caps.maxDust));
  for (const d of dustAll.slice(keptDust.length)) glow.push(d.s);
  return {
    body: keptBodies.map((b) => b.s).sort((a, b) => a - b),
    dust: keptDust.map((d) => d.s).sort((a, b) => a - b),
    glow: glow.sort((a, b) => a - b),
  };
}

/** GLOW_FIELD (0x15): `f32 rect[4], u16 w, u16 h`, RGBA8 x w x h, additive splats. */
export function encodeGlowField(world: World, tick: number, rect: Rect, slots: readonly number[], w = GLOW_W, h = GLOW_H): Uint8Array {
  const acc = new Float32Array(w * h * 4);
  const c = world.cr.c;
  const sx = w / (rect[2] - rect[0]);
  const sy = h / (rect[3] - rect[1]);
  for (const s of slots) {
    const ix = Math.floor((c.posX[s]! - rect[0]) * sx);
    const iy = Math.floor((c.posY[s]! - rect[1]) * sy);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
    const col = c.colour[s]!;
    const g = Math.max(0.05, c.glow[s]!);
    const k = (iy * w + ix) * 4;
    acc[k]! += ((col >>> 24) & 255) * g * 0.25;
    acc[k + 1]! += ((col >>> 16) & 255) * g * 0.25;
    acc[k + 2]! += ((col >>> 8) & 255) * g * 0.25;
    acc[k + 3]! += 32 * g;
  }
  const out = new ByteWriter(HEADER_BYTES + 20 + w * h * 4);
  writeHeader(out, FRAME.GLOW_FIELD, tick, 2);
  for (const v of rect) out.f32(v);
  out.u16(w).u16(h);
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i++) px[i] = Math.min(255, Math.round(acc[i]!));
  out.bytes(px);
  return out.finish();
}

export function decodeGlowField(bytes: Uint8Array): { rect: Rect; w: number; h: number; rgba: Uint8Array } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rect: Rect = [dv.getFloat32(8, true), dv.getFloat32(12, true), dv.getFloat32(16, true), dv.getFloat32(20, true)];
  const w = dv.getUint16(24, true); const h = dv.getUint16(26, true);
  return { rect, w, h, rgba: bytes.subarray(28, 28 + w * h * 4) };
}

/** Everything one client needs to keep its slots stable between frames. */
export class InterestStream {
  viewport: Viewport | null = null;
  caps: Caps;
  readonly bodies = new SlotMap(65535);
  readonly dust = new SlotMap(1 << 24);
  private lastCentre: { x: number; y: number; t: number } | null = null;
  private velocity: [number, number] = [0, 0];
  salience: (id: number) => number = () => 0;
  /** Multipliers set by flow control (0 < m <= 1). */
  bodyCapMul = 1;
  private dustFrame: DustFrame | null = null;
  last: Classified = { body: [], dust: [], glow: [] };

  constructor(caps: Partial<Caps> = {}) { this.caps = { ...DEFAULT_CAPS, ...caps }; }

  setViewport(v: Viewport, nowMs: number): void {
    const cx = (v.rect[0] + v.rect[2]) / 2; const cy = (v.rect[1] + v.rect[3]) / 2;
    if (this.lastCentre && nowMs > this.lastCentre.t) {
      const dt = (nowMs - this.lastCentre.t) / 1000;
      this.velocity = [(cx - this.lastCentre.x) / dt, (cy - this.lastCentre.y) / dt];
    }
    this.lastCentre = { x: cx, y: cy, t: nowMs };
    const valid = v.rect[2] > v.rect[0] && v.rect[3] > v.rect[1] && Number.isFinite(v.pxPerM) && v.pxPerM > 0;
    this.viewport = valid ? v : null;
    if (v.resync) this.reset();
  }

  /** Forget every slot (client resync, or after a freeze): the next frames re-enter everything. */
  reset(): void { this.bodies.clear(); this.dust.clear(); this.dustFrame = null; }

  rect(world: World): Rect {
    if (!this.viewport) return [0, 0, world.preset.widthM, world.preset.heightM];
    const lead = Math.min(MAX_LEAD_S, Math.max(0, this.viewport.leadS || 0));
    return interestRect(this.viewport.rect, INTEREST_GROW, [this.velocity[0] * lead, this.velocity[1] * lead]);
  }

  /** Re-classify and produce BODY_LEAVE / BODY_ENTER for tier changes. Call before the frame encoders. */
  update(world: World): Uint8Array[] {
    const rect = this.rect(world);
    const cls = classify(world, rect, this.viewport ? this.viewport.pxPerM : null,
      { maxBodies: Math.floor(this.caps.maxBodies * this.bodyCapMul), maxDust: this.caps.maxDust }, this.salience);
    this.last = cls;
    const out: Uint8Array[] = [];
    const tick = world.g.tick;
    const want = new Set(cls.body.map((s) => entityId(world, s)));
    const leave: number[] = [];
    for (const id of this.bodies.liveIds()) if (!want.has(id)) leave.push(this.bodies.release(id));
    // compaction: if most slots are holes, move the top bodies down (BODY_LEAVE now, BODY_ENTER below)
    const keep = this.bodies.size - leave.length;
    if (this.bodies.extent > 2 * keep + COMPACT_SLACK) {
      for (const id of this.bodies.liveIds()) if (this.bodies.slotOf(id)! >= keep) leave.push(this.bodies.release(id));
    }
    if (leave.length) out.push(encodeBodyLeave(tick, leave.sort((a, b) => a - b)));
    this.bodies.settle();
    const enter: BodyEnter[] = [];
    const c = world.cr.c;
    for (const s of cls.body) {
      const id = entityId(world, s);
      if (this.bodies.slotOf(id) !== undefined) continue;
      const slot = this.bodies.alloc(id);
      if (slot < 0) continue;
      const tissue = Math.max(1, c.qTissue[s]!);
      enter.push({
        slot, id, genomeKey: BigInt(c.genome[s]!), species: c.species[s]!, log2Length: Math.log2(Math.max(1e-6, c.length[s]!)),
        maturity: Math.round(Math.min(1, Math.max(0, c.maturity[s]!)) * 255), energy: Math.min(255, Math.round((c.qReserve[s]! / tissue) * 255)),
        lod: LOD.BODY, flags: c.flags[s]! & 0xff,
      });
    }
    for (let i = 0; i < enter.length; i += 2000) out.push(encodeBodyEnter(tick, enter.slice(i, i + 2000)));
    // dust slots: release creatures that left the dust tier
    const wantDust = new Set(cls.dust.map((s) => entityId(world, s)));
    for (const id of this.dust.liveIds()) if (!wantDust.has(id)) this.dust.release(id);
    // compaction (a zoom-in leaves holes up to the old extent): the top points are sent empty in
    // this frame and take the lowest free slots in the next, so nSlots shrinks within two frames
    const moved = new Set<number>();
    if (this.dust.extent > 2 * this.dust.size + COMPACT_SLACK) {
      for (const id of this.dust.liveIds()) if (this.dust.slotOf(id)! >= this.dust.size) { this.dust.release(id); moved.add(id); }
    }
    for (const s of cls.dust) { const id = entityId(world, s); if (!moved.has(id)) this.dust.alloc(id); }
    return out;
  }

  bodyFrame(world: World): Uint8Array {
    const rect = this.rect(world);
    const n = this.bodies.extent;
    const present = new Uint8Array(Math.ceil(n / 8));
    const recs: BodyRecord[] = new Array(n);
    const c = world.cr.c;
    for (const s of this.last.body) {
      const slot = this.bodies.slotOf(entityId(world, s));
      if (slot === undefined) continue;
      present[slot >> 3]! |= 1 << (slot & 7);
      const v = Math.hypot(c.velX[s]!, c.velY[s]!);
      let hd = c.heading[s]! % TAU; if (hd < 0) hd += TAU;
      recs[slot] = {
        x: quantRel(c.posX[s]!, rect[0], rect[2]), y: quantRel(c.posY[s]!, rect[1], rect[3]),
        heading: Math.round((hd / TAU) * 256) & 255, speed: speedToByte(v, Math.log2), phase: 0, bend: 0,
        glow: Math.max(1, Math.min(255, Math.round(c.glow[s]! * 255))), flags: c.flags[s]! & 0xff,
      };
    }
    return encodeBodyFrame({ tick: world.g.tick, rect, nSlots: n, present, records: recs.filter((r) => r !== undefined) });
  }

  dustFrameBytes(world: World): Uint8Array {
    const rect = this.rect(world);
    const n = this.dust.extent;
    if (!this.dustFrame || this.dustFrame.x.length < n) {
      const cap = Math.max(64, n * 2);
      this.dustFrame = { tick: 0, rect, n: 0, x: new Uint16Array(cap), y: new Uint16Array(cap), colour: new Uint8Array(cap), glow: new Uint8Array(cap) };
    }
    const f = this.dustFrame;
    f.tick = world.g.tick; f.rect = rect; f.n = n;
    f.colour.fill(DUST_EMPTY, 0, n); f.x.fill(0, 0, n); f.y.fill(0, 0, n); f.glow.fill(0, 0, n);
    const c = world.cr.c;
    for (const s of this.last.dust) {
      const slot = this.dust.slotOf(entityId(world, s));
      if (slot === undefined) continue;
      f.x[slot] = quantRel(c.posX[s]!, rect[0], rect[2]);
      f.y[slot] = quantRel(c.posY[s]!, rect[1], rect[3]);
      f.colour[slot] = (c.species[s]! % 255) & 0xff;
      f.glow[slot] = Math.max(1, Math.min(255, Math.round(c.glow[s]! * 255)));
    }
    const bytes = encodeDust(f);
    this.dust.settle();
    return bytes;
  }

  glowFrame(world: World): Uint8Array { return encodeGlowField(world, world.g.tick, this.rect(world), this.last.glow); }
}
