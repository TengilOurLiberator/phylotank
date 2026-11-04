/**
 * Minimal strict CBOR (RFC 8949) for low-rate messages and file metadata (CONTRACT 12.2).
 * Supported: unsigned and negative integers (up to 2^53, or bigint up to 64 bits), f64 floats,
 * byte strings (Uint8Array), text strings, arrays, maps with text keys, true, false, null,
 * undefined. Rejected on decode: tags, indefinite lengths, non-text map keys, excessive depth.
 */
import { ByteReader, ByteWriter, FormatError, utf8Decode, utf8Encode } from './bytes.js';

export type CborValue =
  | number | bigint | string | boolean | null | undefined | Uint8Array
  | CborValue[] | { [key: string]: CborValue };

function head(w: ByteWriter, major: number, n: number | bigint): void {
  const m = major << 5;
  if (typeof n === 'bigint') {
    if (n < 0n || n > 0xffffffffffffffffn) throw new FormatError('CBOR integer out of range');
    if (n <= 0xffffffffn) { head(w, major, Number(n)); return; }
    w.u8(m | 27);
    // big-endian
    w.u32(Number((n >> 32n) & 0xffffffffn) >>> 0);
    swapLast(w, 4);
    w.u32(Number(n & 0xffffffffn) >>> 0);
    swapLast(w, 4);
    return;
  }
  if (n < 24) w.u8(m | n);
  else if (n < 0x100) { w.u8(m | 24); w.u8(n); }
  else if (n < 0x10000) { w.u8(m | 25); w.u8(n >>> 8); w.u8(n & 0xff); }
  else if (n < 0x100000000) { w.u8(m | 26); w.u8(n >>> 24); w.u8((n >>> 16) & 0xff); w.u8((n >>> 8) & 0xff); w.u8(n & 0xff); }
  else {
    w.u8(m | 27);
    const hi = Math.floor(n / 4294967296);
    const lo = n % 4294967296;
    w.u8(hi >>> 24); w.u8((hi >>> 16) & 0xff); w.u8((hi >>> 8) & 0xff); w.u8(hi & 0xff);
    w.u8(lo >>> 24); w.u8((lo >>> 16) & 0xff); w.u8((lo >>> 8) & 0xff); w.u8(lo & 0xff);
  }
}
function swapLast(w: ByteWriter, n: number): void {
  const v = w.view();
  const s = w.pos - n;
  for (let i = 0; i < n / 2; i++) { const t = v[s + i]!; v[s + i] = v[s + n - 1 - i]!; v[s + n - 1 - i] = t; }
}

function enc(w: ByteWriter, v: CborValue, depth: number): void {
  if (depth > 64) throw new FormatError('CBOR nesting too deep');
  if (v === null) { w.u8(0xf6); return; }
  if (v === undefined) { w.u8(0xf7); return; }
  if (v === false) { w.u8(0xf4); return; }
  if (v === true) { w.u8(0xf5); return; }
  if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER && !Object.is(v, -0)) {
      if (v >= 0) head(w, 0, v); else head(w, 1, -1 - v);
    } else {
      w.u8(0xfb);
      w.f64(v);
      swapLast(w, 8);
    }
    return;
  }
  if (typeof v === 'bigint') { if (v >= 0n) head(w, 0, v); else head(w, 1, -1n - v); return; }
  if (typeof v === 'string') { const b = utf8Encode(v); head(w, 3, b.length); w.bytes(b); return; }
  if (v instanceof Uint8Array) { head(w, 2, v.length); w.bytes(v); return; }
  if (Array.isArray(v)) { head(w, 4, v.length); for (const x of v) enc(w, x, depth + 1); return; }
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => (v as Record<string, CborValue>)[k] !== undefined);
    head(w, 5, keys.length);
    for (const k of keys) { enc(w, k, depth + 1); enc(w, (v as Record<string, CborValue>)[k]!, depth + 1); }
    return;
  }
  throw new FormatError(`cannot CBOR-encode ${typeof v}`);
}

export function cborEncode(v: CborValue): Uint8Array {
  const w = new ByteWriter(256);
  enc(w, v, 0);
  return w.finish();
}

export interface CborDecodeOptions { maxDepth?: number; maxItems?: number }

export function cborDecode(bytes: Uint8Array, opts: CborDecodeOptions = {}): CborValue {
  const r = new ByteReader(bytes);
  const maxDepth = opts.maxDepth ?? 16;
  let items = 0;
  const maxItems = opts.maxItems ?? 1_000_000;
  const readLen = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return r.u8();
    if (info === 25) { const b = r.bytes(2); return (b[0]! << 8) | b[1]!; }
    if (info === 26) { const b = r.bytes(4); return ((b[0]! << 24) >>> 0) + (b[1]! << 16) + (b[2]! << 8) + b[3]!; }
    if (info === 27) {
      const b = r.bytes(8);
      const hi = ((b[0]! << 24) >>> 0) + (b[1]! << 16) + (b[2]! << 8) + b[3]!;
      const lo = ((b[4]! << 24) >>> 0) + (b[5]! << 16) + (b[6]! << 8) + b[7]!;
      if (hi > 0x1fffff) throw new FormatError('CBOR length or integer above 2^53');
      return hi * 4294967296 + lo;
    }
    throw new FormatError('CBOR indefinite or reserved length');
  };
  const dec = (depth: number): CborValue => {
    if (depth > maxDepth) throw new FormatError('CBOR nesting too deep');
    if (++items > maxItems) throw new FormatError('CBOR has too many items');
    const ib = r.u8();
    const major = ib >> 5;
    const info = ib & 31;
    switch (major) {
      case 0: return readLen(info);
      case 1: return -1 - readLen(info);
      case 2: { const n = readLen(info); return r.bytes(n).slice(); }
      case 3: { const n = readLen(info); return utf8Decode(r.bytes(n)); }
      case 4: {
        const n = readLen(info);
        if (n > r.remaining()) throw new FormatError('CBOR array longer than input');
        const a: CborValue[] = [];
        for (let i = 0; i < n; i++) a.push(dec(depth + 1));
        return a;
      }
      case 5: {
        const n = readLen(info);
        if (n > r.remaining()) throw new FormatError('CBOR map longer than input');
        const o: Record<string, CborValue> = Object.create(null);
        for (let i = 0; i < n; i++) {
          const k = dec(depth + 1);
          if (typeof k !== 'string') throw new FormatError('CBOR map key must be text');
          if (k === '__proto__') throw new FormatError('CBOR forbidden key');
          o[k] = dec(depth + 1);
        }
        return o;
      }
      case 6: throw new FormatError('CBOR tags are not allowed');
      default: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 27) {
          const b = r.bytes(8).slice().reverse();
          return new DataView(b.buffer).getFloat64(0, true);
        }
        if (info === 26) {
          const b = r.bytes(4).slice().reverse();
          return new DataView(b.buffer).getFloat32(0, true);
        }
        throw new FormatError('CBOR simple value not supported');
      }
    }
  };
  const v = dec(0);
  if (r.remaining() !== 0) throw new FormatError('trailing bytes after CBOR value');
  return v;
}
