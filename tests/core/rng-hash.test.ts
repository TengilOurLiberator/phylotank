import { describe, expect, it } from 'vitest';
import { crc32, hash32, philox4x32, RngStreams, toHex64, xxh64 } from '../../src/core/index.js';

/** BigInt reference xxh64, straight from the specification, to cross-check the 32-bit version. */
function xxh64Ref(input: Uint8Array, seed = 0n): bigint {
  const M = (1n << 64n) - 1n;
  const P1 = 11400714785074694791n, P2 = 14029467366897019727n, P3 = 1609587929392839161n;
  const P4 = 9650029242287828579n, P5 = 2870177450012600261n;
  const rotl = (x: bigint, r: bigint) => ((x << r) | (x >> (64n - r))) & M;
  const rd64 = (i: number) => { let v = 0n; for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(input[i + k]!); return v; };
  const rd32 = (i: number) => { let v = 0n; for (let k = 3; k >= 0; k--) v = (v << 8n) | BigInt(input[i + k]!); return v; };
  const round = (acc: bigint, x: bigint) => (rotl((acc + x * P2) & M, 31n) * P1) & M;
  const merge = (acc: bigint, v: bigint) => (((acc ^ round(0n, v)) * P1) + P4) & M;
  const len = input.length;
  let i = 0;
  let h: bigint;
  if (len >= 32) {
    let v1 = (seed + P1 + P2) & M, v2 = (seed + P2) & M, v3 = seed, v4 = (seed - P1) & M;
    while (i + 32 <= len) { v1 = round(v1, rd64(i)); v2 = round(v2, rd64(i + 8)); v3 = round(v3, rd64(i + 16)); v4 = round(v4, rd64(i + 24)); i += 32; }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & M;
    h = merge(h, v1); h = merge(h, v2); h = merge(h, v3); h = merge(h, v4);
  } else h = (seed + P5) & M;
  h = (h + BigInt(len)) & M;
  while (i + 8 <= len) { h ^= round(0n, rd64(i)); h = (rotl(h, 27n) * P1 + P4) & M; i += 8; }
  if (i + 4 <= len) { h ^= (rd32(i) * P1) & M; h = (rotl(h, 23n) * P2 + P3) & M; i += 4; }
  while (i < len) { h ^= (BigInt(input[i]!) * P5) & M; h = (rotl(h, 11n) * P1) & M; i++; }
  h ^= h >> 33n; h = (h * P2) & M; h ^= h >> 29n; h = (h * P3) & M; h ^= h >> 32n;
  return h;
}

const enc = (s: string) => new TextEncoder().encode(s);

describe('philox4x32-10', () => {
  it('matches the Random123 known-answer vectors', () => {
    const out = new Uint32Array(4);
    philox4x32(0, 0, 0, 0, 0, 0, out);
    expect(Array.from(out, (x) => x.toString(16).padStart(8, '0'))).toEqual(['6627e8d5', 'e169c58d', 'bc57ac4c', '9b00dbd8']);
    philox4x32(0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, out);
    expect(Array.from(out, (x) => x.toString(16).padStart(8, '0'))).toEqual(['408f276d', '41c83b0e', 'a20bc7c6', '6d5451fd']);
    philox4x32(0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344, 0xa4093822, 0x299f31d0, out);
    expect(Array.from(out, (x) => x.toString(16).padStart(8, '0'))).toEqual(['d16cfe09', '94fdcceb', '5001e420', '24126ea1']);
  });
  it('is a pure function of (seed, stream, tick, subject, draw)', () => {
    const a = new RngStreams(123, 456).draw(4, 10, 77);
    const b = new RngStreams(123, 456).draw(4, 10, 77);
    const xs = Array.from({ length: 10 }, () => a.u01());
    const ys = Array.from({ length: 10 }, () => b.u01());
    expect(xs).toEqual(ys);
    const c = new RngStreams(123, 456).draw(4, 11, 77);
    expect(c.u01()).not.toEqual(xs[0]);
  });
  it('gives sane uniform and normal statistics', () => {
    const d = new RngStreams(1, 2).draw(9, 0, 0);
    let s = 0, s2 = 0, n = 0, u = 0;
    for (let i = 0; i < 20000; i++) { const x = d.normal(); s += x; s2 += x * x; n++; u += d.u01(); }
    expect(Math.abs(s / n)).toBeLessThan(0.03);
    expect(Math.abs(s2 / n - 1)).toBeLessThan(0.05);
    expect(Math.abs(u / n - 0.5)).toBeLessThan(0.01);
  });
});

describe('hashes', () => {
  it('crc32 check value', () => { expect(crc32(enc('123456789'))).toBe(0xcbf43926); });
  it('xxh64 known values', () => {
    expect(toHex64(xxh64(new Uint8Array(0)))).toBe('ef46db3751d8e999');
    expect(toHex64(xxh64(enc('a')))).toBe('d24ec4f1a98c6e5b');
    expect(toHex64(xxh64(enc('abc')))).toBe('44bc2cf5ad770999');
  });
  it('xxh64 agrees with the BigInt reference on random inputs and seeds', () => {
    const d = new RngStreams(7, 7).draw(0, 0, 0);
    for (let len = 0; len < 200; len += 7) {
      const b = new Uint8Array(len);
      for (let i = 0; i < len; i++) b[i] = d.u32() & 0xff;
      const seed = (BigInt(d.u32()) << 32n) | BigInt(d.u32());
      expect(xxh64(b, seed)).toBe(xxh64Ref(b, seed));
    }
  });
  it('hash32 is stable', () => {
    expect(hash32(1, 2, 3)).toBe(hash32(1, 2, 3));
    expect(hash32(1, 2, 3)).not.toBe(hash32(1, 2, 4));
  });
});
