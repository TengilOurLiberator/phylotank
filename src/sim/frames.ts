/**
 * View frames from world state (CONTRACT 12). The worker and the host both use these, so a
 * view cannot tell which transport it has.
 *
 * Stable slots (review R18): the stream slot of a creature is its creature slot, in both
 * DUST_FRAME and BODY_FRAME. A `ViewStream` per client keeps the set of slots in its body
 * stream and sends the deltas of that set as BODY_LEAVE (first) and BODY_ENTER, so a slot
 * changes entity only after a BODY_LEAVE. Records are keyframes (protocol 1.0); predictive
 * deltas are protocol 1.1 (CONTRACT 12 rules). A creature in a client's body stream is marked
 * empty in that client's DUST_FRAME, so nothing is drawn twice.
 */
import {
  ByteWriter, CF, CENSUS_EVERY, clamp, DUST_EMPTY, encodeBodyEnter, encodeBodyFrame, encodeBodyLeave, encodeCborFrame,
  encodeDust, encodeEnv, FRAME, HEADER_BYTES, LIFE, log2, quantRel, speedToByte, TAU, writeHeader, wrapAngle,
  type BodyEnter, type BodyRecord, type CborValue, type DustFrame, type EnvFrame, type Rect, type World,
} from '../core/index.js';
import { dayPhase, yearPhase } from './clocks.js';
import { entityId } from './requests.js';
import { stateOf } from './state.js';

/**
 * DUST_FRAME palette (WELCOME `palette`): a 6 x 7 x 6 RGB cube, 252 entries, so any body
 * colour maps to an index without a per-species table. Index 255 is the empty slot.
 */
export function paletteBytes(): Uint8Array {
  const b = new Uint8Array(252 * 3);
  for (let r = 0; r < 6; r++) for (let g = 0; g < 7; g++) for (let bl = 0; bl < 6; bl++) {
    const i = (r * 7 + g) * 6 + bl;
    b[i * 3] = r * 51; b[i * 3 + 1] = Math.round((g * 255) / 6); b[i * 3 + 2] = bl * 51;
  }
  return b;
}
/** Palette index of a packed RGBA8 colour. */
export function paletteIndex(rgba: number): number {
  const r = rgba & 255, g = (rgba >>> 8) & 255, b = (rgba >>> 16) & 255;
  return (Math.round(r / 51) * 7 + Math.round((g * 6) / 255)) * 6 + Math.round(b / 51);
}

/** Record flags in BODY_FRAME and BODY_ENTER (sim-defined, documented in docs/modules/sim.md). */
export const BODY_FLAG = { JUVENILE: 1, EATING: 2, HURT: 4, MATING: 8, CARCASS: 16, LEVIATHAN: 32, BUDDING: 64, FOUNDER: 128 } as const;

function bodyFlags(world: World, s: number): number {
  const f = world.cr.c.flags[s]!;
  return ((f & CF.JUVENILE) ? BODY_FLAG.JUVENILE : 0) | ((f & CF.EATING) ? BODY_FLAG.EATING : 0)
    | ((f & CF.HURT) ? BODY_FLAG.HURT : 0) | ((f & CF.MATING) ? BODY_FLAG.MATING : 0)
    | (world.cr.c.life[s] === LIFE.CARCASS ? BODY_FLAG.CARCASS : 0) | ((f & CF.LEVIATHAN) ? BODY_FLAG.LEVIATHAN : 0)
    | ((f & CF.BUDDING) ? BODY_FLAG.BUDDING : 0) | ((f & CF.FOUNDER) ? BODY_FLAG.FOUNDER : 0);
}

function glowByte(world: World, s: number): number {
  const c = world.cr.c;
  if (c.life[s] === LIFE.CARCASS) return 1;
  return Math.max(1, Math.min(255, Math.round(c.glow[s]! * (0.6 + 0.4 * c.out[s * 8 + 5]!) * 255)));
}

function inRect(x: number, y: number, r: Rect): boolean { return x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]; }

let scratch: DustFrame | null = null;
function dustScratch(n: number, r: Rect): DustFrame {
  if (!scratch || scratch.x.length < n) {
    const cap = Math.max(16, n);
    scratch = { tick: 0, rect: r, n: 0, x: new Uint16Array(cap), y: new Uint16Array(cap), colour: new Uint8Array(cap), glow: new Uint8Array(cap) };
  }
  return scratch;
}

/** DUST_FRAME of every creature in the rect, in creature-slot order; `skip` slots are empty. */
export function encodeViewFrames(world: World, rect?: Rect, skip?: ReadonlySet<number>): Uint8Array {
  const r: Rect = rect ?? [0, 0, world.preset.widthM, world.preset.heightM];
  const n = world.cr.highWater;
  const f = dustScratch(n, r);
  f.tick = world.g.tick; f.rect = r; f.n = n;
  const c = world.cr.c;
  for (let s = 0; s < n; s++) {
    const x = c.posX[s]!;
    const y = c.posY[s]!;
    if (c.life[s] === LIFE.FREE || !inRect(x, y, r) || skip?.has(s)) {
      f.colour[s] = DUST_EMPTY; f.x[s] = 0; f.y[s] = 0; f.glow[s] = 0;
      continue;
    }
    f.x[s] = quantRel(x, r[0], r[2]);
    f.y[s] = quantRel(y, r[1], r[3]);
    f.colour[s] = paletteIndex(c.colour[s]!);
    f.glow[s] = glowByte(world, s);
  }
  return encodeDust(f);
}

export interface EnvExtra { surfaceLight?: number; surfaceTempC?: number }
export function envFrameFor(world: World, extra: EnvExtra = {}): Uint8Array {
  const e: EnvFrame = {
    tick: world.g.tick, dayPhase: dayPhase(world), yearPhase: yearPhase(world), surfaceLight: extra.surfaceLight ?? 1,
    surfaceTempC: extra.surfaceTempC ?? 14, turbidity: 0, ySurface: world.g.ySurface,
    modes: Array.from(world.g.flowModes.subarray(0, 5)),
  };
  return encodeEnv(e);
}

/** GENOME (0x41): `u32 lo, u32 hi, u32 len`, genome bytes. */
export function encodeGenomeFrame(tick: number, key: bigint, bytes: Uint8Array): Uint8Array {
  const w = new ByteWriter(HEADER_BYTES + 12 + bytes.length);
  writeHeader(w, FRAME.GENOME, tick);
  w.u32(Number(key & 0xffffffffn)).u32(Number(key >> 32n)).u32(bytes.length).bytes(bytes);
  return w.finish();
}

/** CENSUS (0x18) payload: species table, a 64 x 36 x 4 heat map, and the environment with the speed. */
export function censusPayload(world: World, env: Record<string, CborValue> = {}): CborValue {
  const st = stateOf(world);
  const c = world.cr.c;
  const by = new Map<number, { count: number; biomassKg: number }>();
  const HW = 64, HH = 36;
  const count = new Uint16Array(HW * HH), carc = new Uint16Array(HW * HH);
  const mass = new Float64Array(HW * HH), glow = new Float64Array(HW * HH);
  for (let s = 0; s < world.cr.highWater; s++) {
    const life = c.life[s]!;
    if (life === LIFE.FREE) continue;
    const hx = clamp(Math.floor((c.posX[s]! / world.preset.widthM) * HW), 0, HW - 1);
    const hy = clamp(Math.floor((c.posY[s]! / world.preset.heightM) * HH), 0, HH - 1);
    const i = hy * HW + hx;
    if (life === LIFE.CARCASS) { carc[i]!++; continue; }
    if (life !== LIFE.ALIVE) continue;
    count[i]!++; mass[i]! += c.massKg[s]!; glow[i]! += c.glow[s]!;
    const r = by.get(c.species[s]!) ?? { count: 0, biomassKg: 0 };
    r.count++; r.biomassKg += c.massKg[s]!;
    by.set(c.species[s]!, r);
  }
  const heat = new Uint8Array(HW * HH * 4);
  for (let i = 0; i < HW * HH; i++) {
    const n = count[i]!;
    heat[i * 4] = Math.min(255, n * 8);
    heat[i * 4 + 1] = mass[i]! > 0 ? clamp(Math.round((log2(mass[i]!) + 30) * 10), 0, 255) : 0;
    heat[i * 4 + 2] = n > 0 ? Math.round((glow[i]! / n) * 255) : 0;
    heat[i * 4 + 3] = Math.min(255, carc[i]! * 16);
  }
  const species = [...by.entries()].sort((a, b) => a[0] - b[0]).map(([id, r]) => ({
    id, count: r.count, biomassKg: r.biomassKg, colour: st.species.get(id)?.colour ?? 0,
  }));
  return { species, heat, env: { dayPhase: dayPhase(world), yearPhase: yearPhase(world), ...env } };
}

export interface ViewStreamOptions {
  /** Bodies are streamed for creatures at least this many pixels long on the client's screen. */
  bodyMinPx?: number;
  maxBodies?: number;
}

/**
 * Per-client stream state: the client's viewport, its body set and the frame cadence. One per
 * connected view; it never writes sim state.
 */
export class ViewStream {
  rect: Rect;
  pxPerM: number;
  paused = false;
  private readonly bodies = new Map<number, number>(); // slot -> entity id
  private readonly bodyMinPx: number;
  private readonly maxBodies: number;
  private needKey = true;

  constructor(world: World, opts: ViewStreamOptions = {}) {
    this.rect = [0, 0, world.preset.widthM, world.preset.heightM];
    this.pxPerM = 1920 / world.preset.widthM;
    this.bodyMinPx = opts.bodyMinPx ?? 6;
    this.maxBodies = Math.min(65535, opts.maxBodies ?? 512);
  }

  setViewport(rect: Rect, pxPerM: number, paused: boolean, resync: boolean): void {
    this.rect = rect; this.pxPerM = pxPerM; this.paused = paused;
    if (resync) this.resync();
  }

  /** Force a keyframe: every body leaves and re-enters on the next frame. */
  resync(): void { this.needKey = true; }

  get bodySlots(): ReadonlySet<number> { return new Set(this.bodies.keys()); }

  /** Frames for this tick: BODY_LEAVE, BODY_ENTER, BODY_FRAME (when bodies are present), DUST_FRAME. */
  frames(world: World): Uint8Array[] {
    const c = world.cr.c;
    const st = stateOf(world);
    const tick = world.g.tick;
    const r = this.rect;
    const out: Uint8Array[] = [];
    const leave: number[] = [];
    if (this.needKey && this.bodies.size > 0) { leave.push(...this.bodies.keys()); this.bodies.clear(); }
    this.needKey = false;
    // who qualifies now
    const want = new Map<number, number>();
    for (let s = 0; s < world.cr.highWater && want.size < this.maxBodies; s++) {
      const life = c.life[s]!;
      if (life !== LIFE.ALIVE && life !== LIFE.CARCASS) continue;
      if (!inRect(c.posX[s]!, c.posY[s]!, r)) continue;
      if (c.length[s]! * this.pxPerM < this.bodyMinPx) continue;
      want.set(s, entityId(world, s));
    }
    for (const [s, id] of this.bodies) if (want.get(s) !== id) leave.push(s);
    for (const s of leave) this.bodies.delete(s);
    if (leave.length > 0) out.push(encodeBodyLeave(tick, leave.sort((a, b) => a - b)));
    const enter: BodyEnter[] = [];
    for (const [s, id] of want) {
      if (this.bodies.has(s)) continue;
      this.bodies.set(s, id);
      const h = c.genome[s]!;
      const tissue = c.qTissue[s]!;
      enter.push({
        slot: s, id, genomeKey: h !== 0xffffffff ? st.store.key(h) : 0n, species: c.species[s]!,
        log2Length: log2(Math.max(1e-6, c.length[s]!)), maturity: Math.round(clamp(c.maturity[s]!, 0, 1) * 255),
        energy: Math.round(clamp(tissue > 0 ? c.qReserve[s]! / (0.3 * tissue) : 0, 0, 1) * 255), lod: 1,
        flags: bodyFlags(world, s),
      });
    }
    if (enter.length > 0) out.push(encodeBodyEnter(tick, enter));
    if (this.bodies.size > 0) {
      const nSlots = Math.max(...this.bodies.keys()) + 1;
      const present = new Uint8Array(Math.ceil(nSlots / 8));
      const records: BodyRecord[] = [];
      for (let s = 0; s < nSlots; s++) {
        if (!this.bodies.has(s)) continue;
        present[s >> 3] = present[s >> 3]! | (1 << (s & 7));
        const v = Math.sqrt(c.velX[s]! ** 2 + c.velY[s]! ** 2);
        records.push({
          x: quantRel(c.posX[s]!, r[0], r[2]), y: quantRel(c.posY[s]!, r[1], r[3]),
          heading: Math.round(((wrapAngle(c.heading[s]!) + TAU) % TAU) / TAU * 256) & 255,
          speed: speedToByte(v, log2), phase: (tick * 8 + s * 37) & 255,
          bend: clamp(Math.round(c.angVel[s]! * 16), -127, 127), glow: glowByte(world, s), flags: bodyFlags(world, s),
        });
      }
      out.push(encodeBodyFrame({ tick, rect: r, nSlots, present, records }));
    }
    out.push(encodeViewFrames(world, r, this.bodies.size > 0 ? new Set(this.bodies.keys()) : undefined));
    return out;
  }
}

export function eventFrame(tick: number, events: readonly object[]): Uint8Array {
  return encodeCborFrame(FRAME.EVENT, tick, events as unknown as CborValue);
}

export { CENSUS_EVERY };
