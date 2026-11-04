/**
 * Sim-to-view protocol v1 (CONTRACT 12). The same frames travel over a Worker postMessage and
 * over the host WebSocket. All binary payloads are little-endian.
 */
import { ByteReader, ByteWriter, FormatError } from './bytes.js';
import { cborDecode, cborEncode, type CborValue } from './cbor.js';
import { PROTOCOL_MAJOR, PROTOCOL_VERSION } from './constants.js';

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
