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
 * does not converge on long drag-dominated chains (a 24-segment flagellum swam at 10% of the
 * reference speed at 16 substeps); this solve is exact per substep.
 */
import { PI, TAU, type World } from '../core/index.js';
import { sincosRange } from './sincos.js';
import type { Work } from './work.js';

// scratch per segment slot, allocated lazily per capacity
let cap = 0;
let DBs = new Float64Array(0); // body D blocks (9), then inverted
let DJs = new Float64Array(0); // joint D blocks (9), then inverted
// Joint Jacobians: Jp = [[1, 0, a], [0, 1, b], [0, 0, -1]] w.r.t. the parent and
// Jc = [[-1, 0, c], [0, -1, d], [0, 0, 1]] w.r.t. the child; only (a, b, c, d) are stored.
let JAs = new Float64Array(0); // a, b, c, d per joint (4)
let YBs = new Float64Array(0); let YJs = new Float64Array(0); // forward-substituted rhs (3)
let XBs = new Float64Array(0); let XJs = new Float64Array(0); // solution (3)
let CJs = new Float64Array(0); // joint rhs C (3)
let DCBs = new Float64Array(0); // bend rate term dC per joint
let CSs = new Float64Array(0); // cos, sin of each segment's predicted angle (2)
let RSTs = new Float64Array(0); // the bend row's rest angle this substep (limits reuse it)

function ensure(n: number): void {
  if (n <= cap) return;
  cap = n;
  DBs = new Float64Array(n * 9); DJs = new Float64Array(n * 9); JAs = new Float64Array(n * 4);
  YBs = new Float64Array(n * 3); YJs = new Float64Array(n * 3); XBs = new Float64Array(n * 3); XJs = new Float64Array(n * 3);
  CJs = new Float64Array(n * 3); DCBs = new Float64Array(n); CSs = new Float64Array(n * 2); RSTs = new Float64Array(n);
}

/**
 * In-place inverse of the symmetric 3x3 block at o. Every block the tree solve inverts (the
 * drag-augmented masses and their Schur complements) is symmetric by construction, so six
 * cofactors suffice; the results are the same bits as the general cofactor inverse.
 */
function inv3(M: Float64Array, o: number): void {
  const a = M[o]!; const b = M[o + 1]!; const c = M[o + 2]!;
  const e = M[o + 4]!; const f = M[o + 5]!; const i = M[o + 8]!;
  const A = e * i - f * f; const B = -(b * i - f * c); const C = b * f - e * c;
  const r = 1 / (a * A + b * B + c * C);
  const x00 = A * r; const x01 = B * r; const x02 = C * r;
  const x11 = (a * i - c * c) * r; const x12 = -(a * f - c * b) * r; const x22 = (a * e - b * b) * r;
  M[o] = x00; M[o + 1] = x01; M[o + 2] = x02;
  M[o + 3] = x01; M[o + 4] = x11; M[o + 5] = x12;
  M[o + 6] = x02; M[o + 7] = x12; M[o + 8] = x22;
}

/**
 * Solve all joints of the creature with segments [s0, s0 + n) for one substep.
 * Applies the position and angle corrections and records the muscle torque delivered.
 */
export function solveTree(
  wk: Work, sg: World['seg']['c'], s0: number, n: number, h: number, mir: number, frac: number, prescribed: boolean,
  fixAngular = true,
): void {
  ensure(wk.cap);
  // module scratch into locals: the engine then keeps the array bases in registers
  const DB = DBs; const DJ = DJs; const JA = JAs; const YB = YBs; const YJ = YJs; const XB = XBs; const XJ = XJs;
  const CJ = CJs; const DCB = DCBs; const CS = CSs; const RST = RSTs;
  const { th, thp, am, jt } = wk;
  const posX = sg.posX; const posY = sg.posY;
  // one sine and cosine per segment (each joint needs its parent's and its own)
  sincosRange(th, s0, n, CS);
  // assemble joint rows
  for (let k = 1; k < n; k++) {
    const i = s0 + k; const p = s0 + sg.parent[i]!;
    const cp = CS[p * 2]!; const sp = CS[p * 2 + 1]!;
    const cc = CS[i * 2]!; const sc = CS[i * 2 + 1]!;
    const lp = sg.attachU[i]! * sg.len[p]!; const lc = -0.5 * sg.len[i]!;
    const rpx = lp * cp; const rpy = lp * sp; const rcx = lc * cc; const rcy = lc * sc;
    const o = i * 9;
    const gx = posX[p]! + rpx - posX[i]! - rcx; const gy = posY[p]! + rpy - posY[i]! - rcy;
    // rows: d_x, d_y (gap P_p - P_c), bend
    const ja = i * 4;
    JA[ja] = -rpy; JA[ja + 1] = rpx; JA[ja + 2] = rcy; JA[ja + 3] = -rcx;
    CJ[i * 3] = gx;
    CJ[i * 3 + 1] = gy;
    const oj = i * 8; // solver.ts JT layout
    const rest = mir * (jt[oj + 4]! + jt[oj + 5]! * frac);
    RST[i] = rest;
    const cb0 = th[i]! - th[p]! - rest;
    let Cb = cb0 - TAU * Math.floor((cb0 + PI) / TAU);
    if (Cb === -PI) Cb = PI;
    let alpha = 0;
    const dC = (th[i]! - thp[i]!) - (th[p]! - thp[p]!);
    DCB[i] = dC;
    if (!prescribed) {
      // XPBD with damping, divided by (1 + gamma): J dq + alpha' l = -(C + gamma dC) / (1 + gamma);
      // gamma, alpha' and the muscle's rest offset are per-tick constants (solver.ts jointConstants)
      Cb -= jt[oj]!;
      Cb = (Cb + jt[oj + 1]! * dC) / jt[oj + 3]!;
      alpha = jt[oj + 2]!;
    }
    CJ[i * 3 + 2] = Cb;
    // joint D block starts as -alpha on the diagonal (the factor loop subtracts from it)
    DJ[o] = 0; DJ[o + 1] = 0; DJ[o + 2] = 0; DJ[o + 3] = 0; DJ[o + 4] = 0; DJ[o + 5] = 0; DJ[o + 6] = 0; DJ[o + 7] = 0;
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
      const c = JA[i * 4 + 2]!; const d = JA[i * 4 + 3]!;
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
      YJ[b] = (CJ[b]! - t0) + JA[i * 4 + 2]! * t2;
      YJ[b + 1] = (CJ[b + 1]! - t1) + JA[i * 4 + 3]! * t2;
      YJ[b + 2] = CJ[b + 2]! + t2;
    }
    inv3(DJ, i * 9);
    // parent body: D_B -= -(Jp^T DJinv Jp) i.e. D_B = A - Jp^T DJinv Jp ; y_B += Jp^T DJinv y_J
    // parent body: D_B -= Jp^T DJinv Jp, with Jp = [[1, 0, a], [0, 1, b], [0, 0, -1]]
    {
      const o = i * 9; const op = p * 9;
      const a = JA[i * 4]!; const b = JA[i * 4 + 1]!;
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
      const q = p * 3;
      YB[q] = YB[q]! + t0;
      YB[q + 1] = YB[q + 1]! + t1;
      YB[q + 2] = ((YB[q + 2]! + JA[i * 4]! * t0) + JA[i * 4 + 1]! * t1) - t2;
    }
  }
  inv3(DB, s0 * 9);
  // back substitution, root first
  {
    const o = s0 * 9; const b = s0 * 3;
    const y0 = YB[b]!; const y1 = YB[b + 1]!; const y2 = YB[b + 2]!;
    XB[b] = DB[o]! * y0 + DB[o + 1]! * y1 + DB[o + 2]! * y2;
    XB[b + 1] = DB[o + 3]! * y0 + DB[o + 4]! * y1 + DB[o + 5]! * y2;
    XB[b + 2] = DB[o + 6]! * y0 + DB[o + 7]! * y1 + DB[o + 8]! * y2;
  }
  for (let k = 1; k < n; k++) {
    const i = s0 + k; const p = s0 + sg.parent[i]!;
    const o = i * 9; const b = i * 3;
    // x_J = DJinv (y_J + Jp x_Bp)
    const xp0 = XB[p * 3]!; const xp1 = XB[p * 3 + 1]!; const xp2 = XB[p * 3 + 2]!;
    const ja = i * 4;
    const v0 = (YJ[b]! + xp0) + JA[ja]! * xp2;
    const v1 = (YJ[b + 1]! + xp1) + JA[ja + 1]! * xp2;
    const v2 = YJ[b + 2]! - xp2;
    const l0 = DJ[o]! * v0 + DJ[o + 1]! * v1 + DJ[o + 2]! * v2;
    const l1 = DJ[o + 3]! * v0 + DJ[o + 4]! * v1 + DJ[o + 5]! * v2;
    const l2 = DJ[o + 6]! * v0 + DJ[o + 7]! * v1 + DJ[o + 8]! * v2;
    XJ[b] = l0; XJ[b + 1] = l1; XJ[b + 2] = l2;
    // x_B = DBinv (y_B + Jc^T x_J)
    const u0 = YB[b]! - l0;
    const u1 = YB[b + 1]! - l1;
    const u2 = ((YB[b + 2]! + JA[ja + 2]! * l0) + JA[ja + 3]! * l1) + l2;
    XB[b] = DB[o]! * u0 + DB[o + 1]! * u1 + DB[o + 2]! * u2;
    XB[b + 1] = DB[o + 3]! * u0 + DB[o + 4]! * u1 + DB[o + 5]! * u2;
    XB[b + 2] = DB[o + 6]! * u0 + DB[o + 7]! * u1 + DB[o + 8]! * u2;
  }
  // apply corrections, record the muscle torque delivered by each bend row
  for (let k = 0; k < n; k++) {
    const i = s0 + k;
    posX[i] = posX[i]! + XB[i * 3]!; posY[i] = posY[i]! + XB[i * 3 + 1]!; th[i] = th[i]! + XB[i * 3 + 2]!;
  }
  if (fixAngular && n > 1) angularFix(wk, sg, s0, n);
  if (!prescribed) {
    for (let k = 1; k < n; k++) {
      const i = s0 + k; const p = s0 + sg.parent[i]!;
      const dCafter = DCB[i]! + XB[i * 3 + 2]! - XB[p * 3 + 2]!;
      wk.tauReal[i] = wk.tau[i]! - wk.cm[i]! * dCafter / h;
    }
  }
}

/**
 * Remove the net angular impulse that the linearised joint solve leaves behind. The joint
 * impulses g_i = A_i dq_i are internal (they sum to zero), but their lever arms are evaluated at
 * the predicted pose while the discrete angular momentum sum m x_old x v_new is taken about the
 * start-of-substep positions, so each substep leaves an angular impulse of order h^2 v x F
 * (spike physics-2: the whole C1 error of spike 1). A rigid rotation of the creature about its
 * centre of mass, which closes no joint and opens none, cancels it exactly.
 */
function angularFix(wk: Work, sg: World['seg']['c'], s0: number, n: number): void {
  const { am, xp, yp, th } = wk;
  const XB = XBs;
  const posX = sg.posX; const posY = sg.posY;
  // centre of mass of the corrected pose (body mass: a rotation about it moves no momentum)
  let m = 0; let cx = 0; let cy = 0;
  const ox = posX[s0]!; const oy = posY[s0]!;
  for (let k = 0; k < n; k++) {
    const i = s0 + k; const mi = sg.mass[i]!;
    m += mi; cx += mi * (posX[i]! - ox); cy += mi * (posY[i]! - oy);
  }
  cx /= m; cy /= m;
  let S = 0; let K = 0;
  for (let k = 0; k < n; k++) {
    const i = s0 + k; const a = i * 6; const b = i * 3;
    const d0 = XB[b]!; const d1 = XB[b + 1]!; const d2 = XB[b + 2]!;
    const g0 = am[a]! * d0 + am[a + 1]! * d1 + am[a + 2]! * d2;
    const g1 = am[a + 1]! * d0 + am[a + 3]! * d1 + am[a + 4]! * d2;
    const g2 = am[a + 2]! * d0 + am[a + 4]! * d1 + am[a + 5]! * d2;
    const qx = xp[i]! - ox - cx; const qy = yp[i]! - oy - cy;
    S += qx * g1 - qy * g0 + g2;
    // the same sum for a unit rigid rotation e_i = (-(y_i - c_y), x_i - c_x, 1)
    const ex = -(posY[i]! - oy - cy); const ey = posX[i]! - ox - cx;
    const h0 = am[a]! * ex + am[a + 1]! * ey + am[a + 2]!;
    const h1 = am[a + 1]! * ex + am[a + 3]! * ey + am[a + 4]!;
    const h2 = am[a + 2]! * ex + am[a + 4]! * ey + am[a + 5]!;
    K += qx * h1 - qy * h0 + h2;
  }
  if (!(K > 0)) return;
  const dth = -S / K;
  for (let k = 0; k < n; k++) {
    const i = s0 + k;
    const ex = -(posY[i]! - oy - cy); const ey = posX[i]! - ox - cx;
    posX[i] = posX[i]! + dth * ex; posY[i] = posY[i]! + dth * ey; th[i] = th[i]! + dth;
  }
}

/**
 * Hard joint limits after the tree solve, about this substep's rest angle (from the bend rows).
 * `lo`, `hi` are the limits relative to the rest, already mirrored, per joint.
 */
export function solveLimits(wk: Work, sg: World['seg']['c'], s0: number, n: number, mir: number): void {
  const { th, ai } = wk;
  const RST = RSTs;
  const posX = sg.posX; const posY = sg.posY;
  for (let k = 1; k < n; k++) {
    const i = s0 + k; const p = s0 + sg.parent[i]!;
    const lo = wk.jt[i * 8 + 6]!; const hi = wk.jt[i * 8 + 7]!;
    if (!(lo < hi)) continue;
    const d0 = th[i]! - th[p]! - RST[i]!;
    let d = d0 - TAU * Math.floor((d0 + PI) / TAU);
    if (d === -PI) d = PI;
    let Cl = 0;
    if (d < lo) Cl = d - lo; else if (d > hi) Cl = d - hi;
    if (Cl === 0) continue;
    const op = p * 6; const oc = i * 6;
    const dl = -Cl / (ai[op + 5]! + ai[oc + 5]!);
    posX[p] = posX[p]! - ai[op + 2]! * dl; posY[p] = posY[p]! - ai[op + 4]! * dl; th[p] = th[p]! - ai[op + 5]! * dl;
    posX[i] = posX[i]! + ai[oc + 2]! * dl; posY[i] = posY[i]! + ai[oc + 4]! * dl; th[i] = th[i]! + ai[oc + 5]! * dl;
  }
}
