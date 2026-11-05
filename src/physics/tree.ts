/**
 * Exact joint solve for a segment tree (Baraff 1996, "Linear-time dynamics using Lagrange
 * multipliers"): one linearised XPBD step for all joints of a creature at once, in O(n) with
 * 3x3 blocks and no fill-in. Each joint has three rows (attachment x, y and the bend); the bend
 * row is compliant (spring, damping, muscle offset) or hard (prescribed kinematics).
 *
 * The system, with W = A^-1 the drag-augmented generalised inverse mass of each segment, is
 *   [ A   -J^T ] [dq]   [0]
 *   [-J  -alpha] [ l] = [C]
 * on the body-joint tree. Bodies and joints are eliminated leaves first (BFS order reversed),
 * then substituted back from the root. Spike 1 found that one Gauss-Seidel pass per substep
 * does not converge on long drag-dominated chains (a 24-segment flagellum swam at 8% of the
 * reference speed); this solve is exact per substep.
 */
import { wrapAngle, type World } from '../core/index.js';
import { SC, sincos } from './sincos.js';
import type { Work } from './work.js';

// scratch per segment slot, allocated lazily per capacity
let cap = 0;
let DB = new Float64Array(0); // body D blocks (9), then inverted
let DJ = new Float64Array(0); // joint D blocks (9), then inverted
let JP = new Float64Array(0); // joint Jacobian w.r.t. parent (9)
let JC = new Float64Array(0); // joint Jacobian w.r.t. child (9)
let YB = new Float64Array(0); let YJ = new Float64Array(0); // forward-substituted rhs (3)
let XB = new Float64Array(0); let XJ = new Float64Array(0); // solution (3)
let CJ = new Float64Array(0); // joint rhs C (3)
let DCB = new Float64Array(0); // bend rate term dC per joint

function ensure(n: number): void {
  if (n <= cap) return;
  cap = n;
  DB = new Float64Array(n * 9); DJ = new Float64Array(n * 9); JP = new Float64Array(n * 9); JC = new Float64Array(n * 9);
  YB = new Float64Array(n * 3); YJ = new Float64Array(n * 3); XB = new Float64Array(n * 3); XJ = new Float64Array(n * 3);
  CJ = new Float64Array(n * 3); DCB = new Float64Array(n);
}

/** In-place inverse of the 3x3 block at o (general). */
function inv3(M: Float64Array, o: number): void {
  const a = M[o]!; const b = M[o + 1]!; const c = M[o + 2]!;
  const d = M[o + 3]!; const e = M[o + 4]!; const f = M[o + 5]!;
  const g = M[o + 6]!; const h = M[o + 7]!; const i = M[o + 8]!;
  const A = e * i - f * h; const B = -(d * i - f * g); const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const r = 1 / det;
  M[o] = A * r; M[o + 1] = -(b * i - c * h) * r; M[o + 2] = (b * f - c * e) * r;
  M[o + 3] = B * r; M[o + 4] = (a * i - c * g) * r; M[o + 5] = -(a * f - c * d) * r;
  M[o + 6] = C * r; M[o + 7] = -(a * h - b * g) * r; M[o + 8] = (a * e - b * d) * r;
}

/**
 * Solve all joints of the creature with segments [s0, s0 + n) for one substep.
 * Applies the position and angle corrections and records the muscle torque delivered.
 */
export function solveTree(
  wk: Work, sg: World['seg']['c'], s0: number, n: number, h: number, mir: number, frac: number, prescribed: boolean,
): void {
  ensure(wk.cap);
  const { th, thp, am } = wk;
  const posX = sg.posX; const posY = sg.posY;
  // assemble joint rows
  for (let k = 1; k < n; k++) {
    const i = s0 + k; const p = s0 + sg.parent[i]!;
    sincos(th[p]!); const cp = SC.c; const sp = SC.s;
    sincos(th[i]!); const cc = SC.c; const sc = SC.s;
    const lp = sg.attachU[i]! * sg.len[p]!; const lc = -0.5 * sg.len[i]!;
    const rpx = lp * cp; const rpy = lp * sp; const rcx = lc * cc; const rcy = lc * sc;
    const o = i * 9;
    // rows: d_x, d_y (gap P_p - P_c), bend
    JP[o] = 1; JP[o + 1] = 0; JP[o + 2] = -rpy; JP[o + 3] = 0; JP[o + 4] = 1; JP[o + 5] = rpx; JP[o + 6] = 0; JP[o + 7] = 0; JP[o + 8] = -1;
    JC[o] = -1; JC[o + 1] = 0; JC[o + 2] = rcy; JC[o + 3] = 0; JC[o + 4] = -1; JC[o + 5] = -rcx; JC[o + 6] = 0; JC[o + 7] = 0; JC[o + 8] = 1;
    CJ[i * 3] = posX[p]! + rpx - posX[i]! - rcx;
    CJ[i * 3 + 1] = posY[p]! + rpy - posY[i]! - rcy;
    const restA = sg.restAngle[i]!; const restB = wk.restPrev[i]!;
    const rest = mir * (restB + wrapAngle(restA - restB) * frac);
    let Cb = wrapAngle(th[i]! - th[p]! - rest);
    let alpha = 0;
    const dC = (th[i]! - thp[i]!) - (th[p]! - thp[p]!);
    DCB[i] = dC;
    if (!prescribed) {
      const comp = sg.compliance[i]!;
      Cb -= wk.tau[i]! * comp;
      const at = comp / (h * h);
      const kk = 1 / comp;
      const ie = wk.ie[i]! * wk.ie[p]! / (wk.ie[i]! + wk.ie[p]!);
      const beta = sg.damping[i]! * 2 * Math.sqrt(kk * ie);
      const gamma = comp * (beta + wk.cm[i]!) / h;
      // XPBD with damping, divided by (1 + gamma): J dq + alpha' l = -(C + gamma dC) / (1 + gamma)
      Cb = (Cb + gamma * dC) / (1 + gamma);
      alpha = at / (1 + gamma);
    }
    CJ[i * 3 + 2] = Cb;
    // joint D block starts as -alpha on the diagonal
    DJ.fill(0, o, o + 9);
    DJ[o + 8] = -alpha;
  }
  // body D blocks start as A
  for (let k = 0; k < n; k++) {
    const i = s0 + k; const o = i * 9; const a = i * 6;
    DB[o] = am[a]!; DB[o + 1] = am[a + 1]!; DB[o + 2] = am[a + 2]!;
    DB[o + 3] = am[a + 1]!; DB[o + 4] = am[a + 3]!; DB[o + 5] = am[a + 4]!;
    DB[o + 6] = am[a + 2]!; DB[o + 7] = am[a + 4]!; DB[o + 8] = am[a + 5]!;
    YB[i * 3] = 0; YB[i * 3 + 1] = 0; YB[i * 3 + 2] = 0;
  }
  // factor and forward substitution, leaves first: body k then joint k, k = n-1 .. 1; root last
  for (let k = n - 1; k >= 1; k--) {
    const i = s0 + k; const p = s0 + sg.parent[i]!;
    // body i is complete (its child joints were processed): invert
    inv3(DB, i * 9);
    // joint i: D_J = -alpha - Jc DBinv Jc^T, with Jc = [[-1, 0, c], [0, -1, d], [0, 0, 1]]
    {
      const o = i * 9;
      const c = JC[o + 2]!; const d = JC[o + 5]!;
      const B00 = DB[o]!; const B01 = DB[o + 1]!; const B02 = DB[o + 2]!; const B11 = DB[o + 4]!; const B12 = DB[o + 5]!; const B22 = DB[o + 8]!;
      const q00 = B00 - 2 * c * B02 + c * c * B22;
      const q01 = B01 - d * B02 - c * B12 + c * d * B22;
      const q02 = -B02 + c * B22;
      const q11 = B11 - 2 * d * B12 + d * d * B22;
      const q12 = -B12 + d * B22;
      DJ[o] = DJ[o]! - q00; DJ[o + 1] = DJ[o + 1]! - q01; DJ[o + 2] = DJ[o + 2]! - q02;
      DJ[o + 3] = DJ[o + 3]! - q01; DJ[o + 4] = DJ[o + 4]! - q11; DJ[o + 5] = DJ[o + 5]! - q12;
      DJ[o + 6] = DJ[o + 6]! - q02; DJ[o + 7] = DJ[o + 7]! - q12; DJ[o + 8] = DJ[o + 8]! - B22;
    }
    // y_J = C + Jc DBinv y_B
    {
      const o = i * 9; const b = i * 3;
      const t0 = DB[o]! * YB[b]! + DB[o + 1]! * YB[b + 1]! + DB[o + 2]! * YB[b + 2]!;
      const t1 = DB[o + 3]! * YB[b]! + DB[o + 4]! * YB[b + 1]! + DB[o + 5]! * YB[b + 2]!;
      const t2 = DB[o + 6]! * YB[b]! + DB[o + 7]! * YB[b + 1]! + DB[o + 8]! * YB[b + 2]!;
      for (let r = 0; r < 3; r++) YJ[b + r] = CJ[b + r]! + JC[o + r * 3]! * t0 + JC[o + r * 3 + 1]! * t1 + JC[o + r * 3 + 2]! * t2;
    }
    inv3(DJ, i * 9);
    // parent body: D_B -= -(Jp^T DJinv Jp) i.e. D_B = A - Jp^T DJinv Jp ; y_B += Jp^T DJinv y_J
    // parent body: D_B -= Jp^T DJinv Jp, with Jp = [[1, 0, a], [0, 1, b], [0, 0, -1]]
    {
      const o = i * 9; const op = p * 9;
      const a = JP[o + 2]!; const b = JP[o + 5]!;
      const G00 = DJ[o]!; const G01 = DJ[o + 1]!; const G02 = DJ[o + 2]!; const G11 = DJ[o + 4]!; const G12 = DJ[o + 5]!; const G22 = DJ[o + 8]!;
      const e02 = a * G00 + b * G01 - G02;
      const e12 = a * G01 + b * G11 - G12;
      const e22 = a * a * G00 + 2 * a * b * G01 - 2 * a * G02 + b * b * G11 - 2 * b * G12 + G22;
      DB[op] = DB[op]! - G00; DB[op + 1] = DB[op + 1]! - G01; DB[op + 2] = DB[op + 2]! - e02;
      DB[op + 3] = DB[op + 3]! - G01; DB[op + 4] = DB[op + 4]! - G11; DB[op + 5] = DB[op + 5]! - e12;
      DB[op + 6] = DB[op + 6]! - e02; DB[op + 7] = DB[op + 7]! - e12; DB[op + 8] = DB[op + 8]! - e22;
    }
    {
      const o = i * 9; const b = i * 3;
      const t0 = DJ[o]! * YJ[b]! + DJ[o + 1]! * YJ[b + 1]! + DJ[o + 2]! * YJ[b + 2]!;
      const t1 = DJ[o + 3]! * YJ[b]! + DJ[o + 4]! * YJ[b + 1]! + DJ[o + 5]! * YJ[b + 2]!;
      const t2 = DJ[o + 6]! * YJ[b]! + DJ[o + 7]! * YJ[b + 1]! + DJ[o + 8]! * YJ[b + 2]!;
      for (let r = 0; r < 3; r++) YB[p * 3 + r] = YB[p * 3 + r]! + JP[o + r]! * t0 + JP[o + 3 + r]! * t1 + JP[o + 6 + r]! * t2;
    }
  }
  inv3(DB, s0 * 9);
  // back substitution, root first
  const mulTo = (M: Float64Array, om: number, v0: number, v1: number, v2: number, out: Float64Array, oo: number): void => {
    out[oo] = M[om]! * v0 + M[om + 1]! * v1 + M[om + 2]! * v2;
    out[oo + 1] = M[om + 3]! * v0 + M[om + 4]! * v1 + M[om + 5]! * v2;
    out[oo + 2] = M[om + 6]! * v0 + M[om + 7]! * v1 + M[om + 8]! * v2;
  };
  mulTo(DB, s0 * 9, YB[s0 * 3]!, YB[s0 * 3 + 1]!, YB[s0 * 3 + 2]!, XB, s0 * 3);
  for (let k = 1; k < n; k++) {
    const i = s0 + k; const p = s0 + sg.parent[i]!;
    const o = i * 9; const b = i * 3;
    // x_J = DJinv (y_J + Jp x_Bp)
    const xp0 = XB[p * 3]!; const xp1 = XB[p * 3 + 1]!; const xp2 = XB[p * 3 + 2]!;
    const v0 = YJ[b]! + JP[o]! * xp0 + JP[o + 1]! * xp1 + JP[o + 2]! * xp2;
    const v1 = YJ[b + 1]! + JP[o + 3]! * xp0 + JP[o + 4]! * xp1 + JP[o + 5]! * xp2;
    const v2 = YJ[b + 2]! + JP[o + 6]! * xp0 + JP[o + 7]! * xp1 + JP[o + 8]! * xp2;
    mulTo(DJ, o, v0, v1, v2, XJ, b);
    // x_B = DBinv (y_B + Jc^T x_J)
    const l0 = XJ[b]!; const l1 = XJ[b + 1]!; const l2 = XJ[b + 2]!;
    const u0 = YB[b]! + JC[o]! * l0 + JC[o + 3]! * l1 + JC[o + 6]! * l2;
    const u1 = YB[b + 1]! + JC[o + 1]! * l0 + JC[o + 4]! * l1 + JC[o + 7]! * l2;
    const u2 = YB[b + 2]! + JC[o + 2]! * l0 + JC[o + 5]! * l1 + JC[o + 8]! * l2;
    mulTo(DB, o, u0, u1, u2, XB, b);
  }
  // apply corrections, record the muscle torque delivered by each bend row
  for (let k = 0; k < n; k++) {
    const i = s0 + k;
    posX[i] = posX[i]! + XB[i * 3]!; posY[i] = posY[i]! + XB[i * 3 + 1]!; th[i] = th[i]! + XB[i * 3 + 2]!;
  }
  if (!prescribed) {
    for (let k = 1; k < n; k++) {
      const i = s0 + k; const p = s0 + sg.parent[i]!;
      const dCafter = DCB[i]! + XB[i * 3 + 2]! - XB[p * 3 + 2]!;
      wk.tauReal[i] = wk.tau[i]! - wk.cm[i]! * dCafter / h;
    }
  }
}
