/**
 * Allocation-free sine and cosine from one range reduction, built only from + - * / and
 * Math.round, so they are bit-identical on every engine (CONTRACT 4.2 rule 3). Same
 * polynomials as core/dmath; results are written to SC.s and SC.c.
 */
const PIO2_1 = 1.57079632673412561417;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_3 = 2.02226624871116645580e-21;
const TWO_OVER_PI = 0.63661977236758134308;

export const SC = { s: 0, c: 1 };

export function sincos(x: number): void {
  const k = Math.round(x * TWO_OVER_PI);
  const r = ((x - k * PIO2_1) - k * PIO2_2) - k * PIO2_3;
  const z = r * r;
  let p = -1 / 355687428096000;
  p = p * z + 1 / 1307674368000;
  p = p * z - 1 / 6227020800;
  p = p * z + 1 / 39916800;
  p = p * z - 1 / 362880;
  p = p * z + 1 / 5040;
  p = p * z - 1 / 120;
  p = p * z + 1 / 6;
  const sn = r - r * z * p;
  let q = 1 / 6402373705728000;
  q = q * z - 1 / 20922789888000;
  q = q * z + 1 / 87178291200;
  q = q * z - 1 / 479001600;
  q = q * z + 1 / 3628800;
  q = q * z - 1 / 40320;
  q = q * z + 1 / 720;
  q = q * z - 1 / 24;
  q = q * z + 0.5;
  const cs = 1 - z * q;
  const m = k & 3;
  if (m === 0) { SC.s = sn; SC.c = cs; } else if (m === 1) { SC.s = cs; SC.c = -sn; } else if (m === 2) { SC.s = -sn; SC.c = -cs; } else { SC.s = -cs; SC.c = sn; }
}
