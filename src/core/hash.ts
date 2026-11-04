/**
 * Hashes used by the contract: CRC-32 (IEEE) for file and genome integrity, xxh64 for content
 * keys and state hashes, hash32 (murmur3_x86_32 over three u32 words) for stable neuron ids.
 * Pure integer arithmetic: identical on every engine.
 */
import { mulhi32 } from './rng.js';

// ---------- CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- murmur3-based hash32 ----------
function rotl32(x: number, r: number): number { return ((x << r) | (x >>> (32 - r))) >>> 0; }
function mix32(h: number, k: number): number {
  let kk = Math.imul(k >>> 0, 0xcc9e2d51);
  kk = rotl32(kk, 15);
  kk = Math.imul(kk, 0x1b873593);
  let hh = (h ^ kk) >>> 0;
  hh = rotl32(hh, 13);
  return (Math.imul(hh, 5) + 0xe6546b64) >>> 0;
}
export function fmix32(h0: number): number {
  let h = h0 >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
/** murmur3_x86_32 of the 12 LE bytes (a, b, c) with seed 0x9747b28c (CONTRACT 6.7). */
export function hash32(a: number, b: number, c: number): number {
  let h = 0x9747b28c;
  h = mix32(h, a); h = mix32(h, b); h = mix32(h, c);
  return fmix32((h ^ 12) >>> 0);
}

// ---------- xxh64, in 32-bit halves (no BigInt in the hot path) ----------
// A u64 is held as (hi, lo) in module-level registers to avoid allocation.
const P1H = 0x9e3779b1, P1L = 0x85ebca87;
const P2H = 0xc2b2ae3d, P2L = 0x27d4eb4f;
const P3H = 0x165667b1, P3L = 0x9e3779f9;
const P4H = 0x85ebca77, P4L = 0xc2b2ae63;
const P5H = 0x27d4eb2f, P5L = 0x165667c5;

let rH = 0, rL = 0; // result register

function add(aH: number, aL: number, bH: number, bL: number): void {
  const lo = aL + bL;
  rL = lo >>> 0;
  rH = (aH + bH + (lo > 0xffffffff ? 1 : 0)) >>> 0;
}
function mul(aH: number, aL: number, bH: number, bL: number): void {
  const lo = Math.imul(aL, bL) >>> 0;
  const hi = (mulhi32(aL, bL) + Math.imul(aH, bL) + Math.imul(aL, bH)) >>> 0;
  rH = hi; rL = lo;
}
function rotl(aH: number, aL: number, r: number): void {
  if (r === 0) { rH = aH; rL = aL; return; }
  if (r >= 32) { const t = aH; aH = aL; aL = t; r -= 32; if (r === 0) { rH = aH; rL = aL; return; } }
  rH = ((aH << r) | (aL >>> (32 - r))) >>> 0;
  rL = ((aL << r) | (aH >>> (32 - r))) >>> 0;
}
/** round(acc, input) = rotl(acc + input * P2, 31) * P1 */
function round(accH: number, accL: number, inH: number, inL: number): void {
  mul(inH, inL, P2H, P2L);
  add(accH, accL, rH, rL);
  rotl(rH, rL, 31);
  mul(rH, rL, P1H, P1L);
}
function rd32(b: Uint8Array, i: number): number {
  return (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
}

function sub(aH: number, aL: number, bH: number, bL: number): void {
  const lo = aL - bL;
  rL = lo >>> 0;
  rH = (aH - bH - (lo < 0 ? 1 : 0)) >>> 0;
}

/** xxh64 as [hi, lo] u32 words. */
export function xxh64Parts(bytes: Uint8Array, seedHi = 0, seedLo = 0): [number, number] {
  const len = bytes.length;
  let i = 0;
  let hH: number, hL: number;
  if (len >= 32) {
    add(seedHi, seedLo, P1H, P1L); add(rH, rL, P2H, P2L);
    let v1H = rH, v1L = rL;
    add(seedHi, seedLo, P2H, P2L);
    let v2H = rH, v2L = rL;
    let v3H = seedHi >>> 0, v3L = seedLo >>> 0;
    sub(seedHi, seedLo, P1H, P1L);
    let v4H = rH, v4L = rL;
    while (i + 32 <= len) {
      round(v1H, v1L, rd32(bytes, i + 4), rd32(bytes, i)); v1H = rH; v1L = rL;
      round(v2H, v2L, rd32(bytes, i + 12), rd32(bytes, i + 8)); v2H = rH; v2L = rL;
      round(v3H, v3L, rd32(bytes, i + 20), rd32(bytes, i + 16)); v3H = rH; v3L = rL;
      round(v4H, v4L, rd32(bytes, i + 28), rd32(bytes, i + 24)); v4H = rH; v4L = rL;
      i += 32;
    }
    rotl(v1H, v1L, 1); let aH = rH, aL = rL;
    rotl(v2H, v2L, 7); add(aH, aL, rH, rL); aH = rH; aL = rL;
    rotl(v3H, v3L, 12); add(aH, aL, rH, rL); aH = rH; aL = rL;
    rotl(v4H, v4L, 18); add(aH, aL, rH, rL); hH = rH; hL = rL;
    const vs = [v1H, v1L, v2H, v2L, v3H, v3L, v4H, v4L];
    for (let k = 0; k < 8; k += 2) {
      round(0, 0, vs[k]!, vs[k + 1]!);
      hH = (hH ^ rH) >>> 0; hL = (hL ^ rL) >>> 0;
      mul(hH, hL, P1H, P1L); add(rH, rL, P4H, P4L); hH = rH; hL = rL;
    }
  } else {
    add(seedHi, seedLo, P5H, P5L); hH = rH; hL = rL;
  }
  add(hH, hL, Math.floor(len / 4294967296) >>> 0, len >>> 0); hH = rH; hL = rL;
  while (i + 8 <= len) {
    round(0, 0, rd32(bytes, i + 4), rd32(bytes, i));
    hH = (hH ^ rH) >>> 0; hL = (hL ^ rL) >>> 0;
    rotl(hH, hL, 27); mul(rH, rL, P1H, P1L); add(rH, rL, P4H, P4L); hH = rH; hL = rL;
    i += 8;
  }
  if (i + 4 <= len) {
    mul(0, rd32(bytes, i), P1H, P1L);
    hH = (hH ^ rH) >>> 0; hL = (hL ^ rL) >>> 0;
    rotl(hH, hL, 23); mul(rH, rL, P2H, P2L); add(rH, rL, P3H, P3L); hH = rH; hL = rL;
    i += 4;
  }
  while (i < len) {
    mul(0, bytes[i]!, P5H, P5L);
    hH = (hH ^ rH) >>> 0; hL = (hL ^ rL) >>> 0;
    rotl(hH, hL, 11); mul(rH, rL, P1H, P1L); hH = rH; hL = rL;
    i += 1;
  }
  // avalanche: h ^= h >> 33; h *= P2; h ^= h >> 29; h *= P3; h ^= h >> 32
  hL = (hL ^ (hH >>> 1)) >>> 0;
  mul(hH, hL, P2H, P2L); hH = rH; hL = rL;
  const oldH = hH;
  hH = (hH ^ (hH >>> 29)) >>> 0;
  hL = (hL ^ ((hL >>> 29) | (oldH << 3))) >>> 0;
  mul(hH, hL, P3H, P3L); hH = rH; hL = rL;
  hL = (hL ^ hH) >>> 0;
  return [hH, hL];
}

export function xxh64(bytes: Uint8Array, seed: bigint = 0n): bigint {
  const sH = Number((seed >> 32n) & 0xffffffffn);
  const sL = Number(seed & 0xffffffffn);
  const [h, l] = xxh64Parts(bytes, sH, sL);
  return (BigInt(h) << 32n) | BigInt(l);
}

export function toHex64(v: bigint): string { return v.toString(16).padStart(16, '0'); }
