/** Little-endian byte writer and reader shared by every binary codec in core. */

export class FormatError extends Error {
  constructor(message: string) { super(message); this.name = 'FormatError'; }
}

export class ByteWriter {
  private buf: Uint8Array;
  private dv: DataView;
  pos = 0;
  constructor(initial = 1024) {
    this.buf = new Uint8Array(initial);
    this.dv = new DataView(this.buf.buffer);
  }
  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
    this.dv = new DataView(nb.buffer);
  }
  u8(v: number): this { this.ensure(1); this.dv.setUint8(this.pos, v); this.pos += 1; return this; }
  i8(v: number): this { this.ensure(1); this.dv.setInt8(this.pos, v); this.pos += 1; return this; }
  u16(v: number): this { this.ensure(2); this.dv.setUint16(this.pos, v, true); this.pos += 2; return this; }
  i16(v: number): this { this.ensure(2); this.dv.setInt16(this.pos, v, true); this.pos += 2; return this; }
  u32(v: number): this { this.ensure(4); this.dv.setUint32(this.pos, v >>> 0, true); this.pos += 4; return this; }
  i32(v: number): this { this.ensure(4); this.dv.setInt32(this.pos, v, true); this.pos += 4; return this; }
  f32(v: number): this { this.ensure(4); this.dv.setFloat32(this.pos, v, true); this.pos += 4; return this; }
  f64(v: number): this { this.ensure(8); this.dv.setFloat64(this.pos, v, true); this.pos += 8; return this; }
  u64(v: bigint): this { this.ensure(8); this.dv.setBigUint64(this.pos, BigInt.asUintN(64, v), true); this.pos += 8; return this; }
  /** u64 from a safe integer. */
  u64n(v: number): this { this.u32(v % 4294967296); this.u32(Math.floor(v / 4294967296)); return this; }
  bytes(b: Uint8Array): this { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; return this; }
  zeros(n: number): this { this.ensure(n); this.buf.fill(0, this.pos, this.pos + n); this.pos += n; return this; }
  align(n: number): this { const pad = (n - (this.pos % n)) % n; return this.zeros(pad); }
  patchU32(at: number, v: number): void { this.dv.setUint32(at, v >>> 0, true); }
  patchU16(at: number, v: number): void { this.dv.setUint16(at, v, true); }
  finish(): Uint8Array { return this.buf.slice(0, this.pos); }
  view(): Uint8Array { return this.buf.subarray(0, this.pos); }
}

export class ByteReader {
  readonly dv: DataView;
  pos: number;
  readonly end: number;
  constructor(readonly buf: Uint8Array, start = 0, end = buf.length) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = start;
    this.end = end;
  }
  need(n: number): void {
    if (n < 0 || this.pos + n > this.end) throw new FormatError(`truncated: need ${n} bytes at ${this.pos}`);
  }
  remaining(): number { return this.end - this.pos; }
  u8(): number { this.need(1); return this.dv.getUint8(this.pos++); }
  i8(): number { this.need(1); return this.dv.getInt8(this.pos++); }
  u16(): number { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i16(): number { this.need(2); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32(): number { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  i32(): number { this.need(4); const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  f32(): number { this.need(4); const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64(): number { this.need(8); const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }
  u64(): bigint { this.need(8); const v = this.dv.getBigUint64(this.pos, true); this.pos += 8; return v; }
  /** u64 as a number; throws above 2^53. */
  u64n(): number {
    const lo = this.u32(); const hi = this.u32();
    if (hi > 0x1fffff) throw new FormatError('u64 exceeds 2^53');
    return hi * 4294967296 + lo;
  }
  bytes(n: number): Uint8Array { this.need(n); const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  skip(n: number): void { this.need(n); this.pos += n; }
  align(n: number): void { const pad = (n - ((this.pos) % n)) % n; this.pos = Math.min(this.end, this.pos + pad); }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** base64url without padding. */
export function toBase64Url(b: Uint8Array): string {
  let s = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
    s += B64[(n >>> 18) & 63]! + B64[(n >>> 12) & 63]! + B64[(n >>> 6) & 63]! + B64[n & 63]!;
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = b[i]! << 16;
    s += B64[(n >>> 18) & 63]! + B64[(n >>> 12) & 63]!;
  } else if (rest === 2) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8);
    s += B64[(n >>> 18) & 63]! + B64[(n >>> 12) & 63]! + B64[(n >>> 6) & 63]!;
  }
  return s;
}
export function fromBase64Url(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  if (!/^[A-Za-z0-9_-]*$/.test(clean)) throw new FormatError('invalid base64url');
  if (clean.length % 4 === 1) throw new FormatError('invalid base64url length');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c = [0, 1, 2, 3].map((j) => (i + j < clean.length ? B64.indexOf(clean[i + j]!) : 0));
    const n = (c[0]! << 18) | (c[1]! << 12) | (c[2]! << 6) | c[3]!;
    const left = Math.min(3, out.length - o);
    if (left > 0) out[o++] = (n >>> 16) & 255;
    if (left > 1) out[o++] = (n >>> 8) & 255;
    if (left > 2) out[o++] = n & 255;
  }
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
export function utf8Encode(s: string): Uint8Array { return textEncoder.encode(s); }
export function utf8Decode(b: Uint8Array): string {
  try { return textDecoder.decode(b); } catch { throw new FormatError('invalid UTF-8'); }
}
