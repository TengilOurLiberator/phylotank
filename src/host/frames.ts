/**
 * Encoders for the CONTRACT 12.2 frames core has no codec for yet: FIELDS (0x16, 0.5 Hz) and
 * INSPECT (0x22, 10 Hz). Decoders sit beside them so views and tests can read them; both belong
 * in src/core/protocol.ts (contract request H4).
 */
import {
  ByteReader, ByteWriter, FRAME, HEADER_BYTES, LIFE, readHeader, splitU64, writeHeader, type AnyTypedArray, type World,
} from '../core/index.js';

/** FIELDS channel ids (CONTRACT 12.2). */
export const FIELD_CH = { light: 0, temperature: 1, nutrient: 2, plankton: 3, flowU: 4, flowV: 5, oxygen: 6, turbidity: 7 } as const;

/** Sum a fine grid down to the coarse one (plankton lives on the fine grid). */
function toCoarse(src: AnyTypedArray, fw: number, fh: number, cw: number, ch: number): Float64Array {
  const out = new Float64Array(cw * ch);
  const rx = fw / cw; const ry = fh / ch;
  for (let y = 0; y < fh; y++) {
    const cy = Math.floor(y / ry) * cw;
    for (let x = 0; x < fw; x++) out[cy + Math.floor(x / rx)]! += src[y * fw + x]!;
  }
  return out;
}

export function encodeFieldsFrame(world: World): Uint8Array {
  const f = world.fields;
  const [cw, chh] = f.coarse;
  const [fw, fh] = f.fine;
  const chans: [number, ArrayLike<number>][] = [
    [FIELD_CH.light, f.light], [FIELD_CH.temperature, f.tAnom], [FIELD_CH.nutrient, f.qN],
    [FIELD_CH.plankton, toCoarse(f.qP, fw, fh, cw, chh)], [FIELD_CH.flowU, f.flowU], [FIELD_CH.flowV, f.flowV],
    [FIELD_CH.oxygen, f.o2], [FIELD_CH.turbidity, f.turb],
  ];
  const n = cw * chh;
  const w = new ByteWriter(HEADER_BYTES + 5 + chans.length * (9 + n));
  writeHeader(w, FRAME.FIELDS, world.g.tick, 2); // keyframe
  w.u8(chans.length).u16(cw).u16(chh);
  const q = new Uint8Array(n);
  for (const [id, a] of chans) {
    let lo = Infinity; let hi = -Infinity;
    for (let i = 0; i < n; i++) { const v = a[i]!; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!Number.isFinite(lo)) { lo = 0; hi = 0; }
    const span = hi - lo;
    for (let i = 0; i < n; i++) q[i] = span > 0 ? Math.round(((a[i]! - lo) / span) * 255) : 0;
    w.u8(id).f32(lo).f32(hi).bytes(q);
  }
  return w.finish();
}

export interface FieldsFrame { tick: number; w: number; h: number; channels: { id: number; min: number; max: number; data: Uint8Array }[] }
export function decodeFieldsFrame(bytes: Uint8Array): FieldsFrame {
  const hd = readHeader(bytes);
  const r = new ByteReader(bytes, HEADER_BYTES);
  const nCh = r.u8(); const w = r.u16(); const h = r.u16();
  const channels = [];
  for (let i = 0; i < nCh; i++) channels.push({ id: r.u8(), min: r.f32(), max: r.f32(), data: r.bytes(w * h).slice() });
  return { tick: hd.tick, w, h, channels };
}

/** Slot of a live entity, or -1. */
export function slotOfEntity(world: World, id: number): number {
  const [lo, hi] = splitU64(id);
  const c = world.cr.c;
  for (let s = 0; s < world.cr.highWater; s++) if (c.idLo[s] === lo && c.idHi[s] === hi && c.life[s] !== LIFE.FREE) return s;
  return -1;
}

/** INSPECT: `u32 idLo, idHi, u16 nNeu, i8 activations[nNeu]`, then up to 8 f32 scope neurons (the first ones). */
export function encodeInspect(world: World, id: number): Uint8Array | null {
  const s = slotOfEntity(world, id);
  if (s < 0) return null;
  const c = world.cr.c;
  const cls = c.brainClass[s]!;
  const pool = cls < world.brains.length ? world.brains[cls] : undefined;
  const bslot = c.brainSlot[s]!;
  const lanes = pool ? (pool.spec.find((x) => x.name === 'o')!.lanes ?? 1) : 0;
  const nNeu = pool && bslot < pool.capacity ? Math.min(pool.c.nNeu[bslot]!, lanes) : 0;
  const o = pool ? pool.c.o : null;
  const [lo, hi] = splitU64(id);
  const scope = Math.min(8, nNeu);
  const w = new ByteWriter(HEADER_BYTES + 10 + nNeu + scope * 4);
  writeHeader(w, FRAME.INSPECT, world.g.tick);
  w.u32(lo).u32(hi).u16(nNeu);
  for (let i = 0; i < nNeu; i++) w.i8(Math.round(Math.max(-1, Math.min(1, o![bslot * lanes + i]!)) * 127));
  for (let i = 0; i < scope; i++) w.f32(o![bslot * lanes + i]!);
  return w.finish();
}

export function decodeInspect(bytes: Uint8Array): { tick: number; id: number; activations: Int8Array; scope: Float32Array } {
  const hd = readHeader(bytes);
  const r = new ByteReader(bytes, HEADER_BYTES);
  const lo = r.u32(); const hi = r.u32(); const n = r.u16();
  const activations = new Int8Array(n);
  for (let i = 0; i < n; i++) activations[i] = r.i8();
  const k = Math.min(8, Math.floor(r.remaining() / 4));
  const scope = new Float32Array(k);
  for (let i = 0; i < k; i++) scope[i] = r.f32();
  return { tick: hd.tick, id: hi * 4294967296 + lo, activations, scope };
}
