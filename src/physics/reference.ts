/**
 * Independent reference for the low-Re benchmarks (B1, B3, T1): a quasi-static resistive-force
 * solver for a tree of rigid links with prescribed joint angles and no inertia. At every instant
 * the root velocity is the one that makes the total drag force and torque zero; the pose is
 * integrated with RK4. It shares only the drag law (coefficients and the two Gauss points)
 * with the XPBD integrator, so agreement checks the constraint solve, the implicit drag and the
 * substepping. Not used by the sim path.
 */
import { cos, sin } from '../core/index.js';
import { GAUSS_XI } from './constants.js';
import { dragCoeffs } from './body.js';

export interface RefLink { parent: number; attachU: number; length: number; radius: number; span: number; plate: boolean }
/** Rest angle of each link (index 0 ignored) and its rate at time t. */
export type Shape = (t: number, ang: Float64Array, rate: Float64Array) => void;

export class StokesReference {
  readonly n: number;
  private readonly k: Float32Array;
  private readonly ang: Float64Array;
  private readonly rate: Float64Array;
  constructor(readonly links: RefLink[], readonly shape: Shape, readonly linearOnly = false) {
    this.n = links.length;
    this.k = new Float32Array(this.n * 5);
    const hasChild = new Uint8Array(this.n);
    for (let i = 1; i < this.n; i++) hasChild[links[i]!.parent] = 1;
    links.forEach((L, i) => dragCoeffs(L.plate, L.length, L.radius, L.span, i === 0 || hasChild[i] === 0, this.k, i * 5));
    this.ang = new Float64Array(this.n);
    this.rate = new Float64Array(this.n);
  }

  /** Link centres, angles and velocities for root pose q and root velocity v; returns arrays. */
  private kin(t: number, q: readonly number[], v: readonly number[], withShape: boolean,
    cx: Float64Array, cy: Float64Array, th: Float64Array, vx: Float64Array, vy: Float64Array, w: Float64Array): void {
    this.shape(t, this.ang, this.rate);
    const L = this.links;
    cx[0] = q[0]!; cy[0] = q[1]!; th[0] = q[2]!; vx[0] = v[0]!; vy[0] = v[1]!; w[0] = v[2]!;
    for (let i = 1; i < this.n; i++) {
      const p = L[i]!.parent;
      th[i] = th[p]! + this.ang[i]!;
      const bx = cx[p]! + cos(th[p]!) * L[i]!.attachU * L[p]!.length;
      const by = cy[p]! + sin(th[p]!) * L[i]!.attachU * L[p]!.length;
      cx[i] = bx + cos(th[i]!) * 0.5 * L[i]!.length;
      cy[i] = by + sin(th[i]!) * 0.5 * L[i]!.length;
      w[i] = w[p]! + (withShape ? this.rate[i]! : 0);
      vx[i] = vx[p]! - w[p]! * (by - cy[p]!) - w[i]! * (cy[i]! - by);
      vy[i] = vy[p]! + w[p]! * (bx - cx[p]!) + w[i]! * (cx[i]! - bx);
    }
  }

  /** Total drag force and torque about the root centre for given link motions, with D fixed from dref. */
  private wrench(cx: Float64Array, cy: Float64Array, th: Float64Array, vx: Float64Array, vy: Float64Array, w: Float64Array,
    dref: Float64Array | null, out: Float64Array): void {
    out[0] = 0; out[1] = 0; out[2] = 0;
    for (let i = 0; i < this.n; i++) {
      const cs = cos(th[i]!); const sn = sin(th[i]!);
      const xi = GAUSS_XI * this.links[i]!.length;
      for (let g = 0; g < 2; g++) {
        const sgn = g === 0 ? -1 : 1;
        const rx = sgn * xi * cs; const ry = sgn * xi * sn;
        const pvx = vx[i]! - w[i]! * ry; const pvy = vy[i]! + w[i]! * rx;
        let ct: number; let cn: number;
        const k = this.k; const o = i * 5;
        if (dref) { ct = dref[(i * 2 + g) * 2]!; cn = dref[(i * 2 + g) * 2 + 1]!; } else {
          const vt = pvx * cs + pvy * sn; const vn = -pvx * sn + pvy * cs;
          ct = 0.5 * (k[o]! + (this.linearOnly ? 0 : k[o + 2]! * Math.sqrt(Math.abs(vt)) + k[o + 3]! * Math.abs(vt)));
          cn = 0.5 * (k[o + 1]! + (this.linearOnly ? 0 : k[o + 4]! * Math.abs(vn)));
        }
        const vt = pvx * cs + pvy * sn; const vn = -pvx * sn + pvy * cs;
        const fx = -(ct * vt * cs - cn * vn * sn); const fy = -(ct * vt * sn + cn * vn * cs);
        const px = cx[i]! + rx - cx[0]!; const py = cy[i]! + ry - cy[0]!;
        out[0] = out[0]! + fx; out[1] = out[1]! + fy; out[2] = out[2]! + px * fy - py * fx;
      }
    }
  }

  /** Root velocity (vx, vy, omega) at time t and pose q, by force balance with Picard iterations. */
  velocity(t: number, q: readonly number[]): number[] {
    const n = this.n;
    const cx = new Float64Array(n); const cy = new Float64Array(n); const th = new Float64Array(n);
    const vx = new Float64Array(n); const vy = new Float64Array(n); const w = new Float64Array(n);
    const dref = new Float64Array(n * 4);
    let v = [0, 0, 0];
    const f = new Float64Array(3);
    for (let it = 0; it < (this.linearOnly ? 1 : 8); it++) {
      // linearise D at the current guess
      this.kin(t, q, v, true, cx, cy, th, vx, vy, w);
      for (let i = 0; i < n; i++) {
        const cs = cos(th[i]!); const sn = sin(th[i]!); const xi = GAUSS_XI * this.links[i]!.length; const o = i * 5;
        for (let g = 0; g < 2; g++) {
          const sgn = g === 0 ? -1 : 1;
          const pvx = vx[i]! - w[i]! * sgn * xi * sn; const pvy = vy[i]! + w[i]! * sgn * xi * cs;
          const vt = pvx * cs + pvy * sn; const vn = -pvx * sn + pvy * cs;
          dref[(i * 2 + g) * 2] = 0.5 * (this.k[o]! + (this.linearOnly ? 0 : this.k[o + 2]! * Math.sqrt(Math.abs(vt)) + this.k[o + 3]! * Math.abs(vt)));
          dref[(i * 2 + g) * 2 + 1] = 0.5 * (this.k[o + 1]! + (this.linearOnly ? 0 : this.k[o + 4]! * Math.abs(vn)));
        }
      }
      // affine map: wrench = K v + b
      const K: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      this.kin(t, q, [0, 0, 0], true, cx, cy, th, vx, vy, w);
      this.wrench(cx, cy, th, vx, vy, w, dref, f);
      const b = [f[0]!, f[1]!, f[2]!];
      for (let j = 0; j < 3; j++) {
        const e = [0, 0, 0]; e[j] = 1;
        this.kin(t, q, e, false, cx, cy, th, vx, vy, w);
        this.wrench(cx, cy, th, vx, vy, w, dref, f);
        K[0]![j] = f[0]!; K[1]![j] = f[1]!; K[2]![j] = f[2]!;
      }
      v = solve3(K, [-b[0]!, -b[1]!, -b[2]!]);
    }
    return v;
  }

  /** Integrate the root pose from q0 over [t0, t1] with RK4 steps of dt. */
  run(q0: number[], t0: number, t1: number, dt: number): number[] {
    let q = q0.slice();
    const steps = Math.round((t1 - t0) / dt);
    for (let s = 0; s < steps; s++) {
      const t = t0 + s * dt;
      const k1 = this.velocity(t, q);
      const k2 = this.velocity(t + dt / 2, q.map((x, i) => x + dt / 2 * k1[i]!));
      const k3 = this.velocity(t + dt / 2, q.map((x, i) => x + dt / 2 * k2[i]!));
      const k4 = this.velocity(t + dt, q.map((x, i) => x + dt * k3[i]!));
      q = q.map((x, i) => x + dt / 6 * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!));
    }
    return q;
  }

  /** Centre of mass (equal density links: weight by volume) of the body at pose q, time t. */
  centroid(t: number, q: readonly number[], weights: readonly number[]): [number, number] {
    const n = this.n;
    const cx = new Float64Array(n); const cy = new Float64Array(n); const th = new Float64Array(n);
    const z = new Float64Array(n);
    this.kin(t, q, [0, 0, 0], false, cx, cy, th, z, new Float64Array(n), new Float64Array(n));
    let m = 0; let x = 0; let y = 0;
    for (let i = 0; i < n; i++) { m += weights[i]!; x += weights[i]! * cx[i]!; y += weights[i]! * cy[i]!; }
    return [x / m, y / m];
  }
}

function solve3(A: number[][], b: number[]): number[] {
  const [a, bb, c] = A[0]!; const [d, e, f] = A[1]!; const [g, h, i] = A[2]!;
  const det = a! * (e! * i! - f! * h!) - bb! * (d! * i! - f! * g!) + c! * (d! * h! - e! * g!);
  const x = (b[0]! * (e! * i! - f! * h!) - bb! * (b[1]! * i! - f! * b[2]!) + c! * (b[1]! * h! - e! * b[2]!)) / det;
  const y = (a! * (b[1]! * i! - f! * b[2]!) - b[0]! * (d! * i! - f! * g!) + c! * (d! * b[2]! - b[1]! * g!)) / det;
  const z = (a! * (e! * b[2]! - b[1]! * h!) - bb! * (d! * b[2]! - b[1]! * g!) + b[0]! * (d! * h! - e! * g!)) / det;
  return [x, y, z];
}
