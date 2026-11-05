/**
 * perf: the allocation-free argument reduction, the bitmask quadrant, the unrolled atan series,
 * the scalbn fast path and sinCos give the same bits as the phase-1 formulations (copied here
 * as references).
 */
import { describe, expect, it } from 'vitest';
import { atan, atan2, cos, exp, scalbn, sin, sinCos } from '../src/core/dmath.js';

const PIO2_1 = 1.57079632673412561417, PIO2_2 = 6.07710050630396597660e-11, PIO2_3 = 2.02226624871116645580e-21;
const TWO_OVER_PI = 0.63661977236758134308;
function sinPoly(r: number): number {
  const z = r * r;
  let p = -1 / 355687428096000;
  p = p * z + 1 / 1307674368000; p = p * z - 1 / 6227020800; p = p * z + 1 / 39916800; p = p * z - 1 / 362880;
  p = p * z + 1 / 5040; p = p * z - 1 / 120; p = p * z + 1 / 6;
  return r - r * z * p;
}
function cosPoly(r: number): number {
  const z = r * r;
  let p = 1 / 6402373705728000;
  p = p * z - 1 / 20922789888000; p = p * z + 1 / 87178291200; p = p * z - 1 / 479001600; p = p * z + 1 / 3628800;
  p = p * z - 1 / 40320; p = p * z + 1 / 720; p = p * z - 1 / 24; p = p * z + 0.5;
  return 1 - z * p;
}
function reduceRef(x: number): { r: number; q: number } {
  const k = Math.round(x * TWO_OVER_PI);
  return { r: ((x - k * PIO2_1) - k * PIO2_2) - k * PIO2_3, q: ((k % 4) + 4) % 4 };
}
function sinRef(x: number): number {
  if (x !== x || x === Infinity || x === -Infinity) return NaN;
  const { r, q } = reduceRef(x);
  return q === 0 ? sinPoly(r) : q === 1 ? cosPoly(r) : q === 2 ? -sinPoly(r) : -cosPoly(r);
}
function cosRef(x: number): number {
  if (x !== x || x === Infinity || x === -Infinity) return NaN;
  const { r, q } = reduceRef(x);
  return q === 0 ? cosPoly(r) : q === 1 ? -sinPoly(r) : q === 2 ? -cosPoly(r) : sinPoly(r);
}
function atanSeriesRef(t: number): number {
  const z = t * t;
  let p = -1 / 47;
  for (let n = 22; n >= 0; n--) p = p * z + ((n & 1) === 1 ? -1 : 1) / (2 * n + 1);
  return t * p;
}
function atanRef(x: number): number {
  if (x !== x) return NaN;
  const neg = x < 0;
  let a = neg ? -x : x;
  let r: number;
  if (a === Infinity) r = 1.5707963267948966;
  else {
    let base = 0, invert = false;
    if (a > 1) { a = 1 / a; invert = true; }
    if (a > 0.41421356237309503) { base = 0.7853981633974483; a = (a - 1) / (a + 1); }
    r = base + atanSeriesRef(a);
    if (invert) r = 1.5707963267948966 - r;
  }
  return neg ? -r : r;
}
function pow2Ref(k: number): number { const f = new Float64Array(1); const u = new Uint32Array(f.buffer); u[1] = ((k + 1023) << 20) >>> 0; u[0] = 0; return f[0]!; }
function scalbnRef(x: number, k: number): number {
  let y = x, n = k;
  while (n > 1023) { y *= pow2Ref(1023); n -= 1023; }
  while (n < -1022) { y *= pow2Ref(-1022); n += 1022; }
  return y * pow2Ref(n);
}

const same = (a: number, b: number): boolean => Object.is(a, b) || (a !== a && b !== b);
function inputs(): number[] {
  const xs: number[] = [0, -0, 1e-300, -1e-300, 5e-324, NaN, Infinity, -Infinity, 2 ** 31, -(2 ** 31), 2 ** 53, 1e15, -1e15, 3e9, -3e9, 1e300];
  for (let k = -40; k <= 40; k++) for (const e of [0, 1e-12, -1e-12, 1e-7]) xs.push(k * (Math.PI / 4) + e);
  let s = 12345;
  for (let i = 0; i < 200_000; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const u = s / 4294967296;
    xs.push((u - 0.5) * (i % 3 === 0 ? 20 : i % 3 === 1 ? 2000 : 2e10));
  }
  return xs;
}

describe('perf: dmath fast paths', () => {
  const xs = inputs();
  it('sin, cos and sinCos equal the reference bit for bit', () => {
    const out = new Float64Array(2);
    let bad = 0;
    for (const x of xs) {
      sinCos(x, out);
      const s = sinRef(x), c = cosRef(x);
      if (!same(sin(x), s) || !same(cos(x), c) || !same(out[0]!, s) || !same(out[1]!, c)) bad++;
    }
    expect(bad).toBe(0);
  });
  it('atan and atan2 equal the reference bit for bit', () => {
    let bad = 0;
    for (const x of xs) {
      if (!same(atan(x), atanRef(x))) bad++;
      if (!same(atan2(x, 0.37), x !== x ? NaN : atanRef(x / 0.37))) bad++;
    }
    expect(bad).toBe(0);
  });
  it('scalbn and exp keep the reference scaling across the whole exponent range', () => {
    let bad = 0;
    for (let k = -1100; k <= 1100; k++) for (const x of [1, 1.5, 0.75, -3.25, 1e-10]) if (!same(scalbn(x, k), scalbnRef(x, k))) bad++;
    expect(bad).toBe(0);
    expect(exp(0)).toBe(1);
    expect(exp(-745.2)).toBe(0);
    expect(exp(709.8)).toBe(Infinity);
  });
});
