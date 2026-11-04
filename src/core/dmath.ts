/**
 * Deterministic math (CONTRACT 4.3). Built only from IEEE-754 + - * /, Math.sqrt and exactly
 * specified helpers (floor, round, abs, min, max, trunc, sign), so every conforming JS engine
 * returns the same bits. Sim code must use these instead of Math.sin, Math.exp and friends.
 *
 * Accuracy: relative error below about 1e-14 on the reduced ranges. These are not required to
 * equal Math.*; they are required to be identical everywhere, which they are by construction.
 */

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;
export const LN2 = 0.6931471805599453;
export const LN10 = 2.302585092994046;

const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700;
const SQRT2 = 1.4142135623730951;

// Bit access for exact powers of two and exponent extraction. All shipping targets are
// little-endian; detect anyway so the code is correct on either.
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
f64[0] = 1;
const HI = u32[1] === 0x3ff00000 ? 1 : 0;
const LO = 1 - HI;

/** 2^k for integer k in [-1022, 1023], exact. */
function pow2(k: number): number {
  u32[HI] = ((k + 1023) << 20) >>> 0;
  u32[LO] = 0;
  return f64[0]!;
}

/** x * 2^k with exact power-of-two scaling, handling the extreme exponent ranges. */
export function scalbn(x: number, k: number): number {
  let y = x;
  let n = k;
  while (n > 1023) { y *= pow2(1023); n -= 1023; }
  while (n < -1022) { y *= pow2(-1022); n += 1022; }
  return y * pow2(n);
}

export function exp(x: number): number {
  if (x !== x) return NaN;
  if (x > 709.782712893384) return Infinity;
  if (x < -745.1332191019412) return 0;
  const k = Math.round(x * INV_LN2);
  const r = (x - k * LN2_HI) - k * LN2_LO;
  // Taylor series to r^14 on |r| <= 0.347 (Horner)
  let p = 1 / 87178291200;
  p = p * r + 1 / 6227020800;
  p = p * r + 1 / 479001600;
  p = p * r + 1 / 39916800;
  p = p * r + 1 / 3628800;
  p = p * r + 1 / 362880;
  p = p * r + 1 / 40320;
  p = p * r + 1 / 5040;
  p = p * r + 1 / 720;
  p = p * r + 1 / 120;
  p = p * r + 1 / 24;
  p = p * r + 1 / 6;
  p = p * r + 0.5;
  p = p * r + 1;
  p = p * r + 1;
  return scalbn(p, k);
}

export function log(x: number): number {
  if (x !== x || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  let e = 0;
  let m = x;
  if (m < 2.2250738585072014e-308) { m *= 18014398509481984; e = -54; } // subnormal: * 2^54
  f64[0] = m;
  const hi = u32[HI]!;
  e += ((hi >>> 20) & 0x7ff) - 1023;
  u32[HI] = (hi & 0x000fffff) | 0x3ff00000;
  m = f64[0]!; // in [1, 2)
  if (m > SQRT2) { m *= 0.5; e += 1; }
  const f = m - 1;
  const s = f / (2 + f);
  const z = s * s;
  // atanh series: log(m) = 2 s (1 + z/3 + z^2/5 + ...), |s| <= 0.1716
  let p = 1 / 23;
  p = p * z + 1 / 21;
  p = p * z + 1 / 19;
  p = p * z + 1 / 17;
  p = p * z + 1 / 15;
  p = p * z + 1 / 13;
  p = p * z + 1 / 11;
  p = p * z + 1 / 9;
  p = p * z + 1 / 7;
  p = p * z + 1 / 5;
  p = p * z + 1 / 3;
  p = p * z + 1;
  return e * LN2_HI + (e * LN2_LO + 2 * s * p);
}

export function log2(x: number): number { return log(x) / LN2; }
export function log10(x: number): number { return log(x) / LN10; }

const PIO2_1 = 1.57079632673412561417;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_3 = 2.02226624871116645580e-21;
const TWO_OVER_PI = 0.63661977236758134308;

function sinPoly(r: number): number {
  const z = r * r;
  let p = -1 / 355687428096000;
  p = p * z + 1 / 1307674368000;
  p = p * z - 1 / 6227020800;
  p = p * z + 1 / 39916800;
  p = p * z - 1 / 362880;
  p = p * z + 1 / 5040;
  p = p * z - 1 / 120;
  p = p * z + 1 / 6;
  return r - r * z * p;
}

function cosPoly(r: number): number {
  const z = r * r;
  let p = 1 / 6402373705728000;
  p = p * z - 1 / 20922789888000;
  p = p * z + 1 / 87178291200;
  p = p * z - 1 / 479001600;
  p = p * z + 1 / 3628800;
  p = p * z - 1 / 40320;
  p = p * z + 1 / 720;
  p = p * z - 1 / 24;
  p = p * z + 0.5;
  return 1 - z * p;
}

function reduce(x: number): { r: number; q: number } {
  const k = Math.round(x * TWO_OVER_PI);
  const r = ((x - k * PIO2_1) - k * PIO2_2) - k * PIO2_3;
  const q = ((k % 4) + 4) % 4;
  return { r, q };
}

export function sin(x: number): number {
  if (x !== x || x === Infinity || x === -Infinity) return NaN;
  const { r, q } = reduce(x);
  switch (q) {
    case 0: return sinPoly(r);
    case 1: return cosPoly(r);
    case 2: return -sinPoly(r);
    default: return -cosPoly(r);
  }
}

export function cos(x: number): number {
  if (x !== x || x === Infinity || x === -Infinity) return NaN;
  const { r, q } = reduce(x);
  switch (q) {
    case 0: return cosPoly(r);
    case 1: return -sinPoly(r);
    case 2: return -cosPoly(r);
    default: return sinPoly(r);
  }
}

export function tan(x: number): number { return sin(x) / cos(x); }

const TAN_PI_8 = 0.41421356237309503;
const QUARTER_PI = 0.7853981633974483;

function atanSeries(t: number): number {
  const z = t * t;
  let p = -1 / 47;
  for (let n = 22; n >= 0; n--) p = p * z + ((n & 1) === 1 ? -1 : 1) / (2 * n + 1);
  return t * p;
}

export function atan(x: number): number {
  if (x !== x) return NaN;
  const neg = x < 0;
  let a = neg ? -x : x;
  let r: number;
  if (a === Infinity) r = HALF_PI;
  else {
    let base = 0;
    let invert = false;
    if (a > 1) { a = 1 / a; invert = true; }
    if (a > TAN_PI_8) { base = QUARTER_PI; a = (a - 1) / (a + 1); }
    r = base + atanSeries(a);
    if (invert) r = HALF_PI - r;
  }
  return neg ? -r : r;
}

export function atan2(y: number, x: number): number {
  if (x !== x || y !== y) return NaN;
  if (x > 0) return atan(y / x);
  if (x < 0) return y > 0 || (y === 0 && 1 / y > 0) ? atan(y / x) + PI : atan(y / x) - PI;
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  return 0;
}

export function tanh(x: number): number {
  if (x !== x) return NaN;
  if (x > 22) return 1;
  if (x < -22) return -1;
  const a = x < 0 ? -x : x;
  if (a < 3.7252902984e-9) return x;
  const e = exp(2 * a);
  const t = 1 - 2 / (e + 1);
  return x < 0 ? -t : t;
}

export function sigmoid(x: number): number { return 1 / (1 + exp(-x)); }

export function pow(x: number, y: number): number {
  if (y === 0) return 1;
  if (x === 1) return 1;
  if (x !== x || y !== y) return NaN;
  if (x > 0) return exp(y * log(x));
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (y !== Math.floor(y)) return NaN;
  const v = exp(y * log(-x));
  return Math.abs(y) % 2 === 1 ? -v : v;
}

export function cbrt(x: number): number {
  if (x === 0 || x !== x || x === Infinity || x === -Infinity) return x;
  const a = Math.abs(x);
  let y = exp(log(a) / 3);
  y = y - (y * y * y - a) / (3 * y * y);
  return x < 0 ? -y : y;
}

/** Wrap an angle into (-pi, pi]. */
export function wrapAngle(a: number): number {
  let r = a - TAU * Math.floor((a + PI) / TAU);
  if (r === -PI) r = PI;
  return r;
}

/** Square of the Euclidean length (no hypot: Math.hypot is not exactly specified). */
export function hypot2(x: number, y: number): number { return x * x + y * y; }

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
