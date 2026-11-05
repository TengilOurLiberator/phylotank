/**
 * Sim-to-view protocol v1 (CONTRACT 12). The same frames travel over a Worker postMessage and
 * over the host WebSocket. All binary payloads are little-endian.
 */
import { ByteReader, ByteWriter, FormatError } from './bytes.js';
import { cborDecode, cborEncode, type CborValue } from './cbor.js';
import { PROTOCOL_MAJOR, PROTOCOL_VERSION } from './constants.js';
import { cos as dcos, exp as dexp, LN2, sin as dsin, TAU } from './dmath.js';

export const FRAME = {
  HELLO: 0x01, WELCOME: 0x02, VIEWPORT: 0x03, ACK: 0x04, BYE: 0x05, ERROR: 0x06,
  BODY_ENTER: 0x10, BODY_LEAVE: 0x11, BODY_FRAME: 0x12, NEAR_POSE: 0x13, DUST_FRAME: 0x14,
  GLOW_FIELD: 0x15, FIELDS: 0x16, ENV: 0x17, CENSUS: 0x18,
  EVENT: 0x20, STATS: 0x21, INSPECT: 0x22,
  COMMAND: 0x30, COMMAND_RESULT: 0x31,
  GENOME_REQ: 0x40, GENOME: 0x41,
} as const;
export type FrameType = (typeof FRAME)[keyof typeof FRAME];

export const FRAME_FLAG = { DEFLATE: 1, KEYFRAME: 2 } as const;
export const HEADER_BYTES = 8;

export interface FrameHeader { type: number; flags: number; version: number; tick: number }

export function writeHeader(w: ByteWriter, type: number, tick: number, flags = 0): void {
  w.u8(type).u8(flags).u16(PROTOCOL_VERSION).u32(tick >>> 0);
}

export function readHeader(bytes: Uint8Array): FrameHeader {
  if (bytes.length < HEADER_BYTES) throw new FormatError('frame shorter than its header');
  const r = new ByteReader(bytes);
  const type = r.u8();
  const flags = r.u8();
  const version = r.u16();
  const tick = r.u32();
  if (version >> 8 !== PROTOCOL_MAJOR) throw new FormatError(`protocol major ${version >> 8} not supported`);
  return { type, flags, version, tick };
}

/** Rect in world metres: [x0, y0, x1, y1]. */
export type Rect = [number, number, number, number];

// ---------- DUST_FRAME (0x14): stable slots, 6 B per slot ----------
export const DUST_EMPTY = 255;
export interface DustFrame {
  tick: number;
  rect: Rect;
  n: number;
  /** n x u16, rect-relative 0..65535 */
  x: Uint16Array;
  y: Uint16Array;
  colour: Uint8Array;
  glow: Uint8Array;
}

export function encodeDust(f: DustFrame, keyframe = true): Uint8Array {
  const w = new ByteWriter(HEADER_BYTES + 20 + f.n * 6);
  writeHeader(w, FRAME.DUST_FRAME, f.tick, keyframe ? FRAME_FLAG.KEYFRAME : 0);
  for (const v of f.rect) w.f32(v);
  w.u32(f.n);
  for (let i = 0; i < f.n; i++) w.u16(f.x[i]!).u16(f.y[i]!).u8(f.colour[i]!).u8(f.glow[i]!);
  return w.finish();
}

export function decodeDust(bytes: Uint8Array, into?: DustFrame): DustFrame {
  const h = readHeader(bytes);
  if (h.type !== FRAME.DUST_FRAME) throw new FormatError('not a DUST_FRAME');
  const r = new ByteReader(bytes, HEADER_BYTES);
  const rect: Rect = [r.f32(), r.f32(), r.f32(), r.f32()];
  const n = r.u32();
  r.need(n * 6);
  const f = into && into.x.length >= n ? into : {
    tick: 0, rect, n, x: new Uint16Array(n), y: new Uint16Array(n), colour: new Uint8Array(n), glow: new Uint8Array(n),
  };
  f.tick = h.tick; f.rect = rect; f.n = n;
  for (let i = 0; i < n; i++) {
    f.x[i] = r.u16(); f.y[i] = r.u16(); f.colour[i] = r.u8(); f.glow[i] = r.u8();
  }
  return f;
}

// ---------- BODY_FRAME (0x12), keyframe form ----------
export interface BodyRecord { x: number; y: number; heading: number; speed: number; phase: number; bend: number; glow: number; flags: number }
export interface BodyFrame { tick: number; rect: Rect; nSlots: number; present: Uint8Array; records: BodyRecord[] }

export function encodeBodyFrame(f: BodyFrame): Uint8Array {
  const w = new ByteWriter();
  writeHeader(w, FRAME.BODY_FRAME, f.tick, FRAME_FLAG.KEYFRAME);
  for (const v of f.rect) w.f32(v);
  w.u16(f.nSlots);
  const maskLen = Math.ceil(f.nSlots / 8);
  w.bytes(f.present.subarray(0, maskLen));
  for (const rec of f.records) {
    w.u16(rec.x).u16(rec.y).u8(rec.heading).u8(rec.speed).u8(rec.phase).i8(rec.bend).u8(rec.glow).u8(rec.flags);
  }
  return w.finish();
}

export function decodeBodyFrame(bytes: Uint8Array): BodyFrame {
  const h = readHeader(bytes);
  if (h.type !== FRAME.BODY_FRAME) throw new FormatError('not a BODY_FRAME');
  if ((h.flags & FRAME_FLAG.KEYFRAME) === 0) throw new FormatError('delta BODY_FRAME needs protocol 1.1');
  const r = new ByteReader(bytes, HEADER_BYTES);
  const rect: Rect = [r.f32(), r.f32(), r.f32(), r.f32()];
  const nSlots = r.u16();
  const present = r.bytes(Math.ceil(nSlots / 8)).slice();
  const records: BodyRecord[] = [];
  for (let s = 0; s < nSlots; s++) {
    if ((present[s >> 3]! & (1 << (s & 7))) === 0) continue;
    records.push({ x: r.u16(), y: r.u16(), heading: r.u8(), speed: r.u8(), phase: r.u8(), bend: r.i8(), glow: r.u8(), flags: r.u8() });
  }
  return { tick: h.tick, rect, nSlots, present, records };
}

// ---------- BODY_ENTER (0x10) and BODY_LEAVE (0x11) ----------
export interface BodyEnter {
  slot: number; id: number; genomeKey: bigint; species: number; log2Length: number;
  maturity: number; energy: number; lod: number; flags: number;
}
export function encodeBodyEnter(tick: number, list: BodyEnter[]): Uint8Array {
  const w = new ByteWriter(HEADER_BYTES + 2 + list.length * 32);
  writeHeader(w, FRAME.BODY_ENTER, tick);
  w.u16(list.length);
  for (const e of list) {
    w.u16(e.slot).u16(0).u64n(e.id).u64(e.genomeKey).u32(e.species).f32(e.log2Length)
      .u8(e.maturity).u8(e.energy).u8(e.lod).u8(e.flags);
  }
  return w.finish();
}
export function decodeBodyEnter(bytes: Uint8Array): BodyEnter[] {
  const h = readHeader(bytes);
  if (h.type !== FRAME.BODY_ENTER) throw new FormatError('not a BODY_ENTER');
  const r = new ByteReader(bytes, HEADER_BYTES);
  const n = r.u16();
  const out: BodyEnter[] = [];
  for (let i = 0; i < n; i++) {
    const slot = r.u16(); r.u16();
    out.push({ slot, id: r.u64n(), genomeKey: r.u64(), species: r.u32(), log2Length: r.f32(), maturity: r.u8(), energy: r.u8(), lod: r.u8(), flags: r.u8() });
  }
  return out;
}
export function encodeBodyLeave(tick: number, slots: number[]): Uint8Array {
  const w = new ByteWriter(HEADER_BYTES + 2 + slots.length * 2);
  writeHeader(w, FRAME.BODY_LEAVE, tick);
  w.u16(slots.length);
  for (const s of slots) w.u16(s);
  return w.finish();
}

// ---------- VIEWPORT (0x03), ACK (0x04) ----------
export interface Viewport { rect: Rect; pxPerM: number; paused: boolean; resync: boolean; leadS: number }
export function encodeViewport(tick: number, v: Viewport): Uint8Array {
  const w = new ByteWriter(HEADER_BYTES + 28);
  writeHeader(w, FRAME.VIEWPORT, tick);
  for (const x of v.rect) w.f32(x);
  w.f32(v.pxPerM).u32((v.paused ? 1 : 0) | (v.resync ? 2 : 0)).f32(v.leadS);
  return w.finish();
}
export function decodeViewport(bytes: Uint8Array): Viewport {
  readHeader(bytes);
  const r = new ByteReader(bytes, HEADER_BYTES);
  const rect: Rect = [r.f32(), r.f32(), r.f32(), r.f32()];
  const pxPerM = r.f32();
  const flags = r.u32();
  const leadS = r.f32();
  return { rect, pxPerM, paused: (flags & 1) !== 0, resync: (flags & 2) !== 0, leadS };
}
export function encodeAck(tick: number): Uint8Array {
  const w = new ByteWriter(HEADER_BYTES + 4);
  writeHeader(w, FRAME.ACK, tick);
  w.u32(tick);
  return w.finish();
}

// ---------- ENV (0x17) ----------
export interface EnvFrame {
  tick: number; dayPhase: number; yearPhase: number; surfaceLight: number; surfaceTempC: number;
  turbidity: number; ySurface: number; modes: number[];
}
export function encodeEnv(e: EnvFrame): Uint8Array {
  const w = new ByteWriter(HEADER_BYTES + 32 + e.modes.length * 4);
  writeHeader(w, FRAME.ENV, e.tick);
  w.f32(e.dayPhase).f32(e.yearPhase).f32(e.surfaceLight).f32(e.surfaceTempC).f32(e.turbidity).f32(e.ySurface);
  w.u8(e.modes.length);
  for (const m of e.modes) w.f32(m);
  return w.finish();
}
export function decodeEnv(bytes: Uint8Array): EnvFrame {
  const h = readHeader(bytes);
  if (h.type !== FRAME.ENV) throw new FormatError('not an ENV frame');
  const r = new ByteReader(bytes, HEADER_BYTES);
  const e: EnvFrame = {
    tick: h.tick, dayPhase: r.f32(), yearPhase: r.f32(), surfaceLight: r.f32(), surfaceTempC: r.f32(),
    turbidity: r.f32(), ySurface: r.f32(), modes: [],
  };
  const n = r.u8();
  for (let i = 0; i < n; i++) e.modes.push(r.f32());
  return e;
}

// ---------- CBOR-payload frames ----------
const CBOR_FRAMES = new Set<number>([
  FRAME.HELLO, FRAME.WELCOME, FRAME.ERROR, FRAME.CENSUS, FRAME.EVENT, FRAME.STATS, FRAME.COMMAND, FRAME.COMMAND_RESULT,
]);
export function encodeCborFrame(type: number, tick: number, payload: CborValue): Uint8Array {
  if (!CBOR_FRAMES.has(type)) throw new FormatError(`frame 0x${type.toString(16)} is not CBOR`);
  const body = cborEncode(payload);
  const w = new ByteWriter(HEADER_BYTES + body.length);
  writeHeader(w, type, tick);
  w.bytes(body);
  return w.finish();
}
export function decodeCborFrame(bytes: Uint8Array): { header: FrameHeader; payload: CborValue } {
  const header = readHeader(bytes);
  if (!CBOR_FRAMES.has(header.type)) throw new FormatError(`frame 0x${header.type.toString(16)} is not CBOR`);
  return { header, payload: cborDecode(bytes.subarray(HEADER_BYTES)) };
}

// ---------- Quantisation helpers shared by encoder and decoder ----------
export function quantRel(v: number, lo: number, hi: number): number {
  const x = (v - lo) / (hi - lo);
  return x <= 0 ? 0 : x >= 1 ? 65535 : Math.round(x * 65535);
}
export function dequantRel(q: number, lo: number, hi: number): number { return lo + (q / 65535) * (hi - lo); }
/** Body-record speed byte: v = 2^(s/16 - 10) m/s. */
export function speedToByte(v: number, log2: (x: number) => number): number {
  if (v <= 0) return 0;
  return Math.max(0, Math.min(255, Math.round((log2(v) + 10) * 16)));
}

// ---------- Protocol 1.1: predictive BODY_FRAME deltas (CONTRACT 12.2, 05 §5.3.4) ----------
//
// A delta BODY_FRAME has the KEYFRAME flag clear and version 0x0101. Payload:
//   f32 rect[4], u16 nSlots, u32 baseTick (the tick of the frame it predicts from),
//   classes: ceil(nSlots / 4) bytes, 2 bits per slot (slot s at bits 2 (s & 3) of byte s >> 2),
//   then per slot in slot order, by class:
//     0 PREDICTED  nothing: the record is the prediction
//     1 RESIDUAL   u8 mask, then the residuals against the prediction: bit 0 clear: one byte of
//                  two i4 (dx low nibble, dy high), set: i8 dx, i8 dy; then bit 1 i8 dHeading,
//                  bit 2 i8 dPhase, bit 3 i8 dSpeed, bit 4 i8 bend, bit 5 u8 glow, bit 6 u8 flags
//                  (only the fields that differ from the prediction)
//     2 FULL       the 10 B keyframe record (and the slot's turn and phase rates reset to 0)
//     3 ABSENT     no record
// Prediction (both sides, IEEE f64 with + - * / and Math.round only, tables from core dmath, so
// every engine agrees): the previous record's world position plus speed x heading x dt, mapped
// into the new rect; heading and phase advance by the slot's last step; speed, bend, glow and
// flags carry over. A keyframe resets every rate to 0. Lossless: a decoder holds exactly the
// records a keyframe would have sent. Sent only to clients that said `caps.proto >= 0x0101` in
// HELLO, so a 1.0 view only ever sees keyframes.

export const PROTOCOL_VERSION_1_1 = 0x0101;
export const BODY_CLASS = { PREDICTED: 0, RESIDUAL: 1, FULL: 2, ABSENT: 3 } as const;

const HEADING_COS = new Float64Array(256);
const HEADING_SIN = new Float64Array(256);
const SPEED_MPS = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  HEADING_COS[i] = dcos((i * TAU) / 256);
  HEADING_SIN[i] = dsin((i * TAU) / 256);
  SPEED_MPS[i] = i === 0 ? 0 : dexp((i / 16 - 10) * LN2);
}

/** Per-slot predictor state shared by the encoder and the decoder. */
interface SlotState { rec: BodyRecord; dHeading: number; dPhase: number }

function wrap8(d: number): number { return ((d + 128) & 255) - 128; }

/** The predicted record for a slot `dt` seconds after its last record. Exported for tests. */
export function predictBody(prev: BodyRecord, dHeading: number, dPhase: number, prevRect: Rect, rect: Rect, dt: number): BodyRecord {
  const xw = dequantRel(prev.x, prevRect[0], prevRect[2]);
  const yw = dequantRel(prev.y, prevRect[1], prevRect[3]);
  const v = SPEED_MPS[prev.speed]! * dt;
  return {
    x: quantRel(xw + v * HEADING_COS[prev.heading]!, rect[0], rect[2]),
    y: quantRel(yw + v * HEADING_SIN[prev.heading]!, rect[1], rect[3]),
    heading: (prev.heading + dHeading) & 255, speed: prev.speed, phase: (prev.phase + dPhase) & 255,
    bend: prev.bend, glow: prev.glow, flags: prev.flags,
  };
}

function f32Rect(r: Rect): Rect { return [Math.fround(r[0]), Math.fround(r[1]), Math.fround(r[2]), Math.fround(r[3])]; }

function writeRecord(w: ByteWriter, r: BodyRecord): void {
  w.u16(r.x).u16(r.y).u8(r.heading).u8(r.speed).u8(r.phase).i8(r.bend).u8(r.glow).u8(r.flags);
}

/** Server side: turns a client's sequence of body frames into keyframes and 1.1 deltas. */
export class BodyDeltaEncoder {
  private slots: (SlotState | undefined)[] = [];
  private ids: number[] = [];
  private rect: Rect = [0, 0, 1, 1];
  private baseTick = -1;
  private lastKey = -Infinity;
  /** Bytes sent as keyframes and as deltas (for bandwidth accounting). */
  keyBytes = 0;
  deltaBytes = 0;
  /** Slots sent per class in delta frames (PREDICTED, RESIDUAL, FULL, ABSENT). */
  readonly classCounts = [0, 0, 0, 0];

  /** `keyEveryTicks`: a keyframe at least this often (2 s at 30 Hz, CONTRACT 12.2). */
  constructor(readonly keyEveryTicks = 60, readonly deltas = true) {}

  /** Force the next frame to be a keyframe (new client, resync, after a dropped frame). */
  reset(): void { this.baseTick = -1; this.slots = []; this.ids = []; }

  /**
   * Encode one body frame. `records` are in slot order for the present slots (as for
   * `encodeBodyFrame`); `ids` optionally gives each present slot's entity id in the same order,
   * so a slot that changed entity is sent FULL.
   */
  encode(f: BodyFrame, ids?: readonly number[]): Uint8Array {
    const rect = f32Rect(f.rect);
    const key = !this.deltas || this.baseTick < 0 || f.tick - this.lastKey >= this.keyEveryTicks || f.tick <= this.baseTick;
    const recs: (BodyRecord | undefined)[] = new Array(f.nSlots);
    const newIds: number[] = new Array(f.nSlots);
    let j = 0;
    for (let s = 0; s < f.nSlots; s++) {
      if ((f.present[s >> 3]! & (1 << (s & 7))) === 0) continue;
      recs[s] = f.records[j]; newIds[s] = ids ? ids[j]! : -1; j++;
    }
    let bytes: Uint8Array;
    if (key) {
      bytes = encodeBodyFrame({ ...f, rect });
      this.slots = recs.map((r) => (r ? { rec: { ...r }, dHeading: 0, dPhase: 0 } : undefined));
      this.lastKey = f.tick;
      this.keyBytes += bytes.length;
    } else {
      const dt = (f.tick - this.baseTick) / 30;
      const w = new ByteWriter(HEADER_BYTES + 26 + f.nSlots * 3);
      w.u8(FRAME.BODY_FRAME).u8(0).u16(PROTOCOL_VERSION_1_1).u32(f.tick >>> 0);
      for (const v of rect) w.f32(v);
      w.u16(f.nSlots).u32(this.baseTick >>> 0);
      const classAt = w.pos;
      w.zeros(Math.ceil(f.nSlots / 4));
      const cls = new Uint8Array(Math.ceil(f.nSlots / 4));
      const next: (SlotState | undefined)[] = new Array(f.nSlots);
      for (let s = 0; s < f.nSlots; s++) {
        const r = recs[s];
        const st = this.slots[s];
        let c: number;
        if (!r) { c = BODY_CLASS.ABSENT; }
        else if (!st || (ids && this.ids[s] !== newIds[s])) {
          c = BODY_CLASS.FULL; writeRecord(w, r); next[s] = { rec: { ...r }, dHeading: 0, dPhase: 0 };
        } else {
          const p = predictBody(st.rec, st.dHeading, st.dPhase, this.rect, rect, dt);
          const dx = r.x - p.x; const dy = r.y - p.y;
          const dh = wrap8(r.heading - p.heading); const dp = wrap8(r.phase - p.phase); const ds = r.speed - p.speed;
          const nextState = { rec: { ...r }, dHeading: wrap8(r.heading - st.rec.heading), dPhase: wrap8(r.phase - st.rec.phase) };
          if (dx === 0 && dy === 0 && dh === 0 && dp === 0 && ds === 0 && r.bend === p.bend && r.glow === p.glow && r.flags === p.flags) {
            c = BODY_CLASS.PREDICTED; next[s] = { rec: p, dHeading: st.dHeading, dPhase: st.dPhase };
          } else if (dx >= -128 && dx <= 127 && dy >= -128 && dy <= 127 && ds >= -128 && ds <= 127) {
            c = BODY_CLASS.RESIDUAL;
            const wide = dx < -8 || dx > 7 || dy < -8 || dy > 7;
            const mask = (wide ? 1 : 0) | (dh !== 0 ? 2 : 0) | (dp !== 0 ? 4 : 0) | (ds !== 0 ? 8 : 0)
              | (r.bend !== p.bend ? 16 : 0) | (r.glow !== p.glow ? 32 : 0) | (r.flags !== p.flags ? 64 : 0);
            w.u8(mask);
            if (wide) w.i8(dx).i8(dy); else w.u8((dx & 15) | ((dy & 15) << 4));
            if (mask & 2) w.i8(dh);
            if (mask & 4) w.i8(dp);
            if (mask & 8) w.i8(ds);
            if (mask & 16) w.i8(r.bend);
            if (mask & 32) w.u8(r.glow);
            if (mask & 64) w.u8(r.flags);
            next[s] = nextState;
          } else {
            c = BODY_CLASS.FULL; writeRecord(w, r); next[s] = { rec: { ...r }, dHeading: 0, dPhase: 0 };
          }
        }
        cls[s >> 2]! |= c << (2 * (s & 3));
        this.classCounts[c]!++;
      }
      bytes = w.finish();
      bytes.set(cls, classAt);
      this.slots = next;
      this.deltaBytes += bytes.length;
    }
    this.ids = newIds;
    this.rect = rect;
    this.baseTick = f.tick;
    return bytes;
  }
}

/**
 * View side: decodes keyframe and 1.1 delta BODY_FRAMEs into full records. Throws a FormatError
 * for a delta whose base is not the last frame it decoded; the view should then send VIEWPORT
 * with the resync bit, and the server answers with a keyframe.
 */
export class BodyDeltaDecoder {
  private slots: (SlotState | undefined)[] = [];
  private rect: Rect = [0, 0, 1, 1];
  private lastTick = -1;

  decode(bytes: Uint8Array): BodyFrame {
    const h = readHeader(bytes);
    if (h.type !== FRAME.BODY_FRAME) throw new FormatError('not a BODY_FRAME');
    if ((h.flags & FRAME_FLAG.KEYFRAME) !== 0) {
      const f = decodeBodyFrame(bytes);
      const st: (SlotState | undefined)[] = new Array(f.nSlots);
      let j = 0;
      for (let s = 0; s < f.nSlots; s++) if ((f.present[s >> 3]! & (1 << (s & 7))) !== 0) st[s] = { rec: { ...f.records[j++]! }, dHeading: 0, dPhase: 0 };
      this.slots = st; this.rect = f.rect; this.lastTick = h.tick;
      return f;
    }
    if (h.version < PROTOCOL_VERSION_1_1) throw new FormatError('delta BODY_FRAME needs protocol 1.1');
    const r = new ByteReader(bytes, HEADER_BYTES);
    const rect: Rect = [r.f32(), r.f32(), r.f32(), r.f32()];
    const nSlots = r.u16();
    const base = r.u32();
    if (this.lastTick < 0 || base !== this.lastTick >>> 0) throw new FormatError(`delta base ${base} is not the last frame ${this.lastTick}`);
    const cls = r.bytes(Math.ceil(nSlots / 4)).slice();
    const dt = (((h.tick - base) >>> 0) / 30);
    const present = new Uint8Array(Math.ceil(nSlots / 8));
    const records: BodyRecord[] = [];
    const next: (SlotState | undefined)[] = new Array(nSlots);
    for (let s = 0; s < nSlots; s++) {
      const c = (cls[s >> 2]! >> (2 * (s & 3))) & 3;
      if (c === BODY_CLASS.ABSENT) continue;
      const st = this.slots[s];
      let rec: BodyRecord;
      if (c === BODY_CLASS.FULL) {
        rec = { x: r.u16(), y: r.u16(), heading: r.u8(), speed: r.u8(), phase: r.u8(), bend: r.i8(), glow: r.u8(), flags: r.u8() };
        next[s] = { rec, dHeading: 0, dPhase: 0 };
      } else {
        if (!st) throw new FormatError(`slot ${s} has no baseline`);
        const p = predictBody(st.rec, st.dHeading, st.dPhase, this.rect, rect, dt);
        if (c === BODY_CLASS.PREDICTED) { rec = p; next[s] = { rec, dHeading: st.dHeading, dPhase: st.dPhase }; }
        else {
          const mask = r.u8();
          let dx: number; let dy: number;
          if (mask & 1) { dx = r.i8(); dy = r.i8(); } else { const b = r.u8(); dx = ((b & 15) ^ 8) - 8; dy = (((b >> 4) & 15) ^ 8) - 8; }
          const dh = mask & 2 ? r.i8() : 0; const dp = mask & 4 ? r.i8() : 0; const ds = mask & 8 ? r.i8() : 0;
          rec = {
            x: p.x + dx, y: p.y + dy, heading: (p.heading + dh) & 255, speed: p.speed + ds, phase: (p.phase + dp) & 255,
            bend: mask & 16 ? r.i8() : p.bend, glow: mask & 32 ? r.u8() : p.glow, flags: mask & 64 ? r.u8() : p.flags,
          };
          next[s] = { rec, dHeading: wrap8(rec.heading - st.rec.heading), dPhase: wrap8(rec.phase - st.rec.phase) };
        }
      }
      present[s >> 3]! |= 1 << (s & 7);
      records.push(rec);
    }
    this.slots = next; this.rect = rect; this.lastTick = h.tick;
    return { tick: h.tick, rect, nSlots, present, records };
  }
}
