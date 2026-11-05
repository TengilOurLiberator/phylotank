/**
 * perf: the fast xxh64 (whole words, inlined 64-bit steps) equals the portable byte-by-byte
 * reference bit for bit, for every length class, alignment and seed.
 */
import { describe, expect, it } from 'vitest';
import { xxh64Parts, xxh64PartsPortable } from '../src/core/hash.js';

function bytes(n: number, seed: number): Uint8Array {
  const b = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 255; }
  return b;
}

describe('perf: fast xxh64', () => {
  it('matches the portable reference for lengths 0 to 300 at every alignment and several seeds', () => {
    const big = bytes(400, 7);
    for (let len = 0; len <= 300; len++) {
      for (let off = 0; off < 4; off++) {
        const v = big.subarray(off, off + len);
        for (const [sh, sl] of [[0, 0], [0xffffffff, 0xffffffff], [0x12345678, 0x9abcdef0], [1, 0x80000000]] as const) {
          expect(xxh64Parts(v, sh, sl)).toEqual(xxh64PartsPortable(v, sh, sl));
        }
      }
    }
  });
  it('matches on large buffers and on all-ones bytes (carry paths)', () => {
    for (const n of [4096, 65_536 + 13, 1 << 20]) {
      const b = bytes(n, n);
      expect(xxh64Parts(b, 3, 4)).toEqual(xxh64PartsPortable(b, 3, 4));
      const ff = new Uint8Array(n).fill(255);
      expect(xxh64Parts(ff)).toEqual(xxh64PartsPortable(ff));
    }
  });
  it('chains like the state hash does (seed = previous digest)', () => {
    let a: [number, number] = [0, 0], b: [number, number] = [0, 0];
    for (let k = 0; k < 50; k++) {
      const v = bytes(17 + k * 37, k + 1);
      a = xxh64Parts(v, a[0], a[1]);
      b = xxh64PartsPortable(v, b[0], b[1]);
    }
    expect(a).toEqual(b);
  });
});
