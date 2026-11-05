/**
 * The full-tier integrator (02 §2.7.1 to §2.7.3, as changed by REVIEW R6): per creature, all
 * substeps in f64 working arrays; per substep implicit drag with added mass, explicit muscle
 * pairs (Hill curve, velocity-capped motor), cilia and buoyancy, then one Gauss-Seidel XPBD
 * pass over the joints in BFS order.
 *
 * Low-Re correctness: every XPBD projection uses the inverse of the drag-augmented generalised
 * mass `A = M3 + h C` (3x3 per segment) instead of the bare mass. This is the linearly implicit
 * treatment of drag inside the constraint solve, so in the Stokes limit a shape change moves
 * the body by force balance (resistive force theory), not by inertia.
 */
import {
  DT, GRAVITY, KIND, NU_WATER, log, ORGAN, RHO_WATER, exp, wrapAngle, B0_KLEIBER, E_A_EV,
  K_BOLTZMANN_EV, T_REF_K, KLEIBER_EXP, pow, type World,
} from '../core/index.js';
import { CILIA_SLIP, ETA_CILIA, ETA_MUSCLE, GAUSS_XI, KAPPA_CILIA, KAPPA_ISO, MU_WATER, Q10_MUSCLE } from './constants.js';
import { addedMass, isPlate, segVolume } from './body.js';
import { SC, sincos } from './sincos.js';
import { solveTree } from './tree.js';
import type { Work } from './work.js';

export interface PhysicsOptions {
  /** Drag against the water (off: vacuum, test C1/C2). */
  fluid: boolean;
  /** Buoyancy and gravity. */
  gravity: boolean;
  /** Added mass blended by c_a(Re). */
  addedMass: boolean;
  /** Fixed substep count (tests); otherwise the 2.7.4 rule with the floor below. */
  nSub: number;
  /** Substep floor (REVIEW R6: 4). */
  minSub: number;
  /** Tick length; the sim uses DT. Tests use it for T2 (30 vs 60 Hz). */
  dt: number;
  /** Treat joint rests as prescribed kinematics (zero compliance, muscles off). Benchmarks only. */
  prescribed: boolean;
  /** Tank walls and surface as hard limits. */
  walls: boolean;
  /** Cross-creature contacts, bites (tick rate). */
  contacts: boolean;
  /** Joint Gauss-Seidel passes per substep (small steps: 1). */
  iterations: number;
  /** Drop the |v|^1.5 and |v|^2 drag terms (benchmarks against linear resistive-force theory). */
  linearDrag: boolean;
  /** Accumulate the drag-work diagnostic (R9 watchdog input, energy-budget tests). */
  diagnostics: boolean;
  /** Joint solver: exact tree solve per substep (default) or Gauss-Seidel passes. */
  solver: 'tree' | 'gs';
}

export const DEFAULT_OPTIONS: PhysicsOptions = {
  fluid: true, gravity: true, addedMass: true, nSub: 0, minSub: 4, dt: DT, prescribed: false, walls: true,
  contacts: true, iterations: 1, linearDrag: false, diagnostics: false, solver: 'tree',
};

const LN2_Q10 = log(Q10_MUSCLE);
const SQRT_ABS = (x: number): number => Math.sqrt(x < 0 ? -x : x);

/** Activation time constant (02 §2.2.5). */
export function tauAct(lengthM: number): number {
  const t = 0.05 * pow(Math.max(lengthM, 1e-6) / 0.1, 0.2);
  return t < 0.03 ? 0.03 : t > 0.12 ? 0.12 : t;
}

/** Hill force-velocity factor; w > 0 is shortening (moving with the activation). */
export function hill(w: number, wMax: number): number {
  if (w >= 0) return (1 - w / wMax) / (1 + 4 * w / wMax);
  const e = -w / (0.3 * wMax);
  return 1 + 0.5 * (e < 1 ? e : 1);
}

/** Basal power B = B0 m^0.75 Arrhenius(T) (02 §2.6.2), used here only for the isometric term. */
export function basalW(massKg: number, tempC: number): number {
  const T = tempC + 273.15;
  return B0_KLEIBER * pow(Math.max(massKg, 1e-15), KLEIBER_EXP) * exp((E_A_EV / K_BOLTZMANN_EV) * (1 / T_REF_K - 1 / T));
}

export interface FlowSampler { (x: number, y: number, out: Float64Array): void }

const fl = new Float64Array(2);

/**
 * Step one creature through one tick of `nSub` substeps. Returns the substep count used.
 * Reads cmd, cmd2; writes pose, velocities, act, work, powerW and the creature summary.
 */
export function stepCreature(
  world: World, slot: number, wk: Work, opts: PhysicsOptions, flowAt: FlowSampler,
): number {
  const c = world.cr.c;
  const sg = world.seg.c;
  const s0 = c.segStart[slot]!;
  const n = c.segCount[slot]!;
  const dt = opts.dt;
  const mir = c.mirror[slot]! < 0 ? -1 : 1;
  const { th, vx, vy, w } = wk;
  // ---- once per tick: load, flow, Re, activation, buoyancy
  let mTot = 0; let lenTot = 0; let rMin = Infinity; let vMax = 0; let active = false;
  for (let k = 0; k < n; k++) {
    const i = s0 + k;
    th[i] = sg.angle[i]!; vx[i] = sg.velX[i]!; vy[i] = sg.velY[i]!; w[i] = sg.angVel[i]!;
    if (wk.restInit[i] === 0) { wk.restPrev[i] = sg.restAngle[i]!; wk.restInit[i] = 1; }
    if (opts.fluid) {
      flowAt(sg.posX[i]!, sg.posY[i]!, fl);
      wk.ux[i] = fl[0]!; wk.uy[i] = fl[1]!;
    } else { wk.ux[i] = 0; wk.uy[i] = 0; }
    wk.phi[i] = sg.kind[i] === KIND.FIN ? 1 - 0.8 * Math.min(1, Math.abs(sg.cmd2[i]!)) : 1;
    mTot += sg.mass[i]!;
    if (k === 0 || sg.parent[i]! >= 0) lenTot += sg.len[i]!;
    if (sg.radius[i]! < rMin) rMin = sg.radius[i]!;
    const sp = Math.sqrt((vx[i]! - wk.ux[i]!) ** 2 + (vy[i]! - wk.uy[i]!) ** 2) + Math.abs(w[i]!) * 0.5 * sg.len[i]!;
    if (sp > vMax) vMax = sp;
    if (sg.cmd[i] !== 0 || sg.act[i] !== 0) active = true;
    wk.netWork[i] = 0; wk.dragWork[i] = 0; sg.work[i] = 0;
  }
  const L = c.length[slot]! > 0 ? c.length[slot]! : lenTot;
  // c_a(Re) from the rms segment speed relative to the water
  let ca = 0;
  if (opts.addedMass && opts.fluid) {
    const re = L * vMax / NU_WATER;
    ca = re / (re + 10);
  }
  // activation lag, once per tick
  const kAct = 1 - exp(-dt / tauAct(L));
  const tempC = c.tempC[slot]!;
  const q10 = exp(LN2_Q10 * (tempC - 15) / 10);
  for (let k = 1; k < n; k++) {
    const i = s0 + k;
    let u = sg.cmd[i]!;
    u = u > 1 ? 1 : u < -1 ? -1 : u;
    sg.act[i] = sg.act[i]! + (u - sg.act[i]!) * kAct;
  }
  // substep count (2.7.4 with the R6 floor)
  let nSub = opts.nSub;
  if (nSub <= 0) {
    const need = Math.max(1, vMax * dt / (0.5 * rMin));
    nSub = 1;
    while (nSub < need && nSub < 16) nSub *= 2;
    const floor = active ? Math.max(4, opts.minSub) : opts.minSub;
    if (nSub < floor) nSub = floor;
    if (nSub > 16) nSub = 16;
  }
  const h = dt / nSub;
  const rhoW = RHO_WATER;
  const W = world.preset.widthM;
  const H = world.preset.heightM;
  const top = world.g.ySurface;
  let ciliaP = 0;
  const { ai, mm, ie, rhs, tau, xp, yp, thp } = wk;
  const posX = sg.posX; const posY = sg.posY;
  for (let s = 0; s < nSub; s++) {
    // ---- 1. drag-augmented mass, explicit forces
    for (let k = 0; k < n; k++) {
      const i = s0 + k;
      sincos(th[i]!);
      const cs = SC.c; const sn = SC.s;
      const m = sg.mass[i]!;
      const l = sg.len[i]!; const r = sg.radius[i]!; const span = sg.span[i]!;
      const plate = isPlate(sg.kind[i]!);
      let M00 = m; let M01 = 0; let M11 = m; let Ie = sg.inertia[i]!;
      if (ca > 0) {
        const [mat, man, ia] = addedMass(plate, l, r, span);
        const at = ca * mat; const an = ca * man * wk.phi[i]!;
        M00 += at * cs * cs + an * sn * sn;
        M01 += (at - an) * cs * sn;
        M11 += at * sn * sn + an * cs * cs;
        Ie += ca * ia * wk.phi[i]!;
      }
      mm[i * 3] = M00; mm[i * 3 + 1] = M01; mm[i * 3 + 2] = M11; ie[i] = Ie;
      const v0 = vx[i]!; const v1 = vy[i]!; const om = w[i]!;
      let a00 = M00; let a01 = M01; let a02 = 0; let a11 = M11; let a12 = 0; let a22 = Ie;
      let r0 = M00 * v0 + M01 * v1; let r1 = M01 * v0 + M11 * v1; let r2 = Ie * om;
      if (opts.fluid) {
        const dr = sg.drag;
        const lin = opts.linearDrag ? 0 : 1;
        const kt1 = dr[i * 5]!; const kn1 = dr[i * 5 + 1]!; const kt15 = dr[i * 5 + 2]! * lin;
        const kt2 = dr[i * 5 + 3]! * lin; const kn2 = dr[i * 5 + 4]! * wk.phi[i]! * lin;
        const ux = wk.ux[i]!; const uy = wk.uy[i]!;
        const xi = GAUSS_XI * l;
        for (let g = -1; g <= 1; g += 2) {
          const rx = g * xi * cs; const ry = g * xi * sn;
          const relx = v0 - om * ry - ux; const rely = v1 + om * rx - uy;
          const vt = relx * cs + rely * sn; const vn = -relx * sn + rely * cs;
          const avt = vt < 0 ? -vt : vt; const avn = vn < 0 ? -vn : vn;
          const ct = 0.5 * (kt1 + kt15 * SQRT_ABS(vt) + kt2 * avt);
          const cn = 0.5 * (kn1 + kn2 * avn);
          const D00 = ct * cs * cs + cn * sn * sn; const D01 = (ct - cn) * cs * sn; const D11 = ct * sn * sn + cn * cs * cs;
          const d3x = -D00 * ry + D01 * rx; const d3y = -D01 * ry + D11 * rx;
          a00 += h * D00; a01 += h * D01; a11 += h * D11; a02 += h * d3x; a12 += h * d3y;
          a22 += h * (-ry * d3x + rx * d3y);
          const fux = D00 * ux + D01 * uy; const fuy = D01 * ux + D11 * uy;
          r0 += h * fux; r1 += h * fuy; r2 += h * (-ry * fux + rx * fuy);
        }
      }
      // explicit forces: buoyancy (constant over the tick) and cilia
      let fx = 0; let fy = 0;
      if (opts.gravity) {
        const V = segVolume(plate, l, r, span);
        fy += (m - rhoW * V) * GRAVITY;
      }
      if ((sg.organs[i]! & ORGAN.CILIA) !== 0) {
        let ac = sg.cmd2[i]!;
        ac = ac < 0 ? 0 : ac > 1 ? 1 : ac;
        const F = ac * MU_WATER * KAPPA_CILIA * l * CILIA_SLIP;
        fx += F * cs; fy += F * sn;
        if (s === 0) ciliaP += F * CILIA_SLIP / ETA_CILIA;
      }
      r0 += h * fx; r1 += h * fy;
      // invert the symmetric 3x3
      const c00 = a11 * a22 - a12 * a12; const c01 = a02 * a12 - a01 * a22; const c02 = a01 * a12 - a02 * a11;
      const c11 = a00 * a22 - a02 * a02; const c12 = a01 * a02 - a00 * a12; const c22 = a00 * a11 - a01 * a01;
      const id = 1 / (a00 * c00 + a01 * c01 + a02 * c02);
      const o = i * 6;
      const am = wk.am;
      am[o] = a00; am[o + 1] = a01; am[o + 2] = a02; am[o + 3] = a11; am[o + 4] = a12; am[o + 5] = a22;
      ai[o] = c00 * id; ai[o + 1] = c01 * id; ai[o + 2] = c02 * id;
      ai[o + 3] = c11 * id; ai[o + 4] = c12 * id; ai[o + 5] = c22 * id;
      rhs[i * 3] = r0; rhs[i * 3 + 1] = r1; rhs[i * 3 + 2] = r2;
    }
    // ---- 2. muscles: velocity-capped motor pairs on each joint
    if (!opts.prescribed) {
      for (let k = 1; k < n; k++) {
        const i = s0 + k;
        const p = s0 + sg.parent[i]!;
        const a = sg.act[i]!;
        tau[i] = 0; wk.cm[i] = 0; wk.tauReal[i] = 0;
        if (a === 0 || sg.tauMax[i]! <= 0) continue;
        const dir = a * mir > 0 ? 1 : -1;
        const wMax = sg.omegaMax[i]! * q10;
        const wRel = dir * (w[i]! - w[p]!);
        // Force-velocity: tau = amax (1 - w_rel'/w_max), the straight line through Hill's two end
        // points, applied implicitly: amax enters the bend row as a rest offset amax * compliance
        // and amax / w_max as extra XPBD damping. Explicit motors (with the 1/h velocity cap of
        // 02 §2.2.5, or with the curved Hill law fed back from the start-of-substep velocity)
        // made gaits depend on the substep count or chatter on long chains (spike 1).
        void wRel; void hill;
        const amax = (a < 0 ? -a : a) * sg.tauMax[i]! * (1 - sg.damage[i]!);
        tau[i] = dir * amax;
        wk.cm[i] = amax / wMax;
      }
    }
    // ---- 3. implicit velocity solve and predict
    for (let k = 0; k < n; k++) {
      const i = s0 + k;
      const o = i * 6;
      const r0 = rhs[i * 3]!; const r1 = rhs[i * 3 + 1]!; const r2 = rhs[i * 3 + 2]!;
      const nvx = ai[o]! * r0 + ai[o + 1]! * r1 + ai[o + 2]! * r2;
      const nvy = ai[o + 1]! * r0 + ai[o + 3]! * r1 + ai[o + 4]! * r2;
      const nw = ai[o + 2]! * r0 + ai[o + 4]! * r1 + ai[o + 5]! * r2;
      vx[i] = nvx; vy[i] = nvy; w[i] = nw;
      xp[i] = posX[i]!; yp[i] = posY[i]!; thp[i] = th[i]!;
      posX[i] = posX[i]! + h * nvx; posY[i] = posY[i]! + h * nvy; th[i] = th[i]! + h * nw;
    }
    // ---- 4. joints, one Gauss-Seidel pass in BFS order
    const frac = (s + 1) / nSub;
    // Gauss-Seidel over the joints; with more than one pass, alternate the direction
    // (symmetric GS), which carries corrections from the tips back to the root.
    if (opts.solver === 'tree') {
      solveTree(wk, sg, s0, n, h, mir, frac, opts.prescribed);
      for (let k = 1; k < n; k++) solveLimit(wk, sg, s0 + k, s0 + sg.parent[s0 + k]!, mir, frac);
    } else for (let it = 0; it < opts.iterations; it++) {
      const fwd = (it & 1) === 0;
      for (let q = 1; q < n; q++) {
        const k = fwd ? q : n - q;
        const i = s0 + k;
        const p = s0 + sg.parent[i]!;
        solveJoint(wk, sg, i, p, h, mir, frac, opts.prescribed, it === 0);
      }
    }
    // ---- 5. walls, velocities, work
    for (let k = 0; k < n; k++) {
      const i = s0 + k;
      if (opts.walls) {
        const r = sg.radius[i]!;
        const x = posX[i]!; const y = posY[i]!;
        if (x < r) posX[i] = r; else if (x > W - r) posX[i] = W - r;
        if (y < top + r) posY[i] = top + r; else if (y > H - r) posY[i] = H - r;
      }
      vx[i] = (posX[i]! - xp[i]!) / h; vy[i] = (posY[i]! - yp[i]!) / h; w[i] = (th[i]! - thp[i]!) / h;
    }
    if (!opts.prescribed) {
      for (let k = 1; k < n; k++) {
        const i = s0 + k;
        const p = s0 + sg.parent[i]!;
        const dRel = (th[i]! - thp[i]!) - (th[p]! - thp[p]!);
        const dW = wk.tauReal[i]! * dRel;
        wk.netWork[i] = wk.netWork[i]! + dW;
        if (dW > 0) sg.work[i] = sg.work[i]! + dW;
      }
    }
    // drag power by the water on each segment (diagnostic, R9): F_drag . v
    if (opts.fluid && opts.diagnostics) {
      for (let k = 0; k < n; k++) {
        const i = s0 + k;
        const l = sg.len[i]!; sincos(th[i]!); const cs = SC.c; const sn = SC.s;
        const dr = sg.drag;
        let P = 0;
        const xi = GAUSS_XI * l;
        for (let g = -1; g <= 1; g += 2) {
          const rx = g * xi * cs; const ry = g * xi * sn;
          const pvx = vx[i]! - w[i]! * ry; const pvy = vy[i]! + w[i]! * rx;
          const relx = pvx - wk.ux[i]!; const rely = pvy - wk.uy[i]!;
          const vt = relx * cs + rely * sn; const vn = -relx * sn + rely * cs;
          const lin = opts.linearDrag ? 0 : 1;
          const ct = 0.5 * (dr[i * 5]! + lin * (dr[i * 5 + 2]! * SQRT_ABS(vt) + dr[i * 5 + 3]! * Math.abs(vt)));
          const cn = 0.5 * (dr[i * 5 + 1]! + lin * dr[i * 5 + 4]! * wk.phi[i]! * Math.abs(vn));
          const fx = -(ct * vt * cs - cn * vn * sn); const fy = -(ct * vt * sn + cn * vn * cs);
          P += fx * pvx + fy * pvy;
        }
        wk.dragWork[i] = wk.dragWork[i]! + P * h;
      }
    }
  }
  // ---- store, summary, power
  // Storing the angle as f32 rotates each segment by a rounding error; shift the children so
  // every joint gap is exactly what it was in f64. Otherwise the next tick's first substep would
  // turn the rounding into velocity (an energy source that grows like 1/h).
  let px = 0; let py = 0; let wPos = 0; let iso = 0;
  const { rhs: sh } = wk;
  for (let k = 0; k < n; k++) {
    const i = s0 + k;
    const t64 = th[i]!;
    const t = Math.fround(wrapAngle(t64));
    sg.angle[i] = t; sg.velX[i] = vx[i]!; sg.velY[i] = vy[i]!; sg.angVel[i] = w[i]!;
    let sx = 0; let sy = 0;
    if (k > 0) {
      const p = s0 + sg.parent[i]!;
      const tp64 = th[p]!; const tp = sg.angle[p]!;
      const lp = sg.attachU[i]! * sg.len[p]!; const lc = -0.5 * sg.len[i]!;
      sincos(tp); const c1 = SC.c; const s1 = SC.s; sincos(tp64); const c2 = SC.c; const s2 = SC.s;
      sincos(t); const c3 = SC.c; const s3 = SC.s; sincos(t64); const c4 = SC.c; const s4 = SC.s;
      sx = sh[p * 3]! + lp * (c1 - c2) - lc * (c3 - c4);
      sy = sh[p * 3 + 1]! + lp * (s1 - s2) - lc * (s3 - s4);
      posX[i] = posX[i]! + sx; posY[i] = posY[i]! + sy;
    }
    sh[i * 3] = sx; sh[i * 3 + 1] = sy;
    wk.restPrev[i] = sg.restAngle[i]!;
    px += sg.mass[i]! * vx[i]!; py += sg.mass[i]! * vy[i]!;
    if (k > 0) {
      wPos += sg.work[i]!;
      iso += Math.abs(sg.act[i]!) * wk.muscleFrac[i]! * sg.mass[i]!;
    }
  }
  c.posX[slot] = posX[s0]!; c.posY[slot] = posY[s0]!;
  c.velX[slot] = px / mTot; c.velY[slot] = py / mTot;
  c.heading[slot] = sg.angle[s0]!; c.angVel[slot] = sg.angVel[s0]!;
  c.nSub[slot] = nSub;
  const mBody = c.massKg[slot]! > 0 ? c.massKg[slot]! : mTot;
  const pIso = iso > 0 ? KAPPA_ISO * basalW(mBody, tempC) * iso / mTot : 0;
  c.powerW[slot] = wPos / ETA_MUSCLE / dt + pIso + ciliaP;
  return nSub;
}

/** Attachment, bend (compliant, damped) and limit rows of one joint. */
function solveJoint(
  wk: Work, sg: World['seg']['c'], i: number, p: number, h: number, mir: number, frac: number, prescribed: boolean,
  first: boolean,
): void {
  const { ai, th, thp } = wk;
  const posX = sg.posX; const posY = sg.posY;
  // attachment (2 rows as one along the gap)
  sincos(th[p]!); const cpp = SC.c; const spp = SC.s;
  sincos(th[i]!); const ccc = SC.c; const scc = SC.s;
  const lp = sg.attachU[i]! * sg.len[p]!; const lc = -0.5 * sg.len[i]!;
  const rpx = lp * cpp; const rpy = lp * spp; const rcx = lc * ccc; const rcy = lc * scc;
  const dx = posX[p]! + rpx - posX[i]! - rcx; const dy = posY[p]! + rpy - posY[i]! - rcy;
  const C = Math.sqrt(dx * dx + dy * dy);
  if (C > 1e-14) {
    const nx = dx / C; const ny = dy / C;
    const gp0 = nx; const gp1 = ny; const gp2 = rpx * ny - rpy * nx;
    const gc0 = -nx; const gc1 = -ny; const gc2 = -(rcx * ny - rcy * nx);
    const op = p * 6; const oc = i * 6;
    const ap0 = ai[op]! * gp0 + ai[op + 1]! * gp1 + ai[op + 2]! * gp2;
    const ap1 = ai[op + 1]! * gp0 + ai[op + 3]! * gp1 + ai[op + 4]! * gp2;
    const ap2 = ai[op + 2]! * gp0 + ai[op + 4]! * gp1 + ai[op + 5]! * gp2;
    const ac0 = ai[oc]! * gc0 + ai[oc + 1]! * gc1 + ai[oc + 2]! * gc2;
    const ac1 = ai[oc + 1]! * gc0 + ai[oc + 3]! * gc1 + ai[oc + 4]! * gc2;
    const ac2 = ai[oc + 2]! * gc0 + ai[oc + 4]! * gc1 + ai[oc + 5]! * gc2;
    const wsum = gp0 * ap0 + gp1 * ap1 + gp2 * ap2 + gc0 * ac0 + gc1 * ac1 + gc2 * ac2;
    const dl = -C / wsum;
    posX[p] = posX[p]! + ap0 * dl; posY[p] = posY[p]! + ap1 * dl; th[p] = th[p]! + ap2 * dl;
    posX[i] = posX[i]! + ac0 * dl; posY[i] = posY[i]! + ac1 * dl; th[i] = th[i]! + ac2 * dl;
  }
  // bend: C = wrap(theta_c - theta_p - rest), rest interpolated across the tick's substeps
  const restA = sg.restAngle[i]!; const restB = wk.restPrev[i]!;
  const rest = mir * (restB + wrapAngle(restA - restB) * frac);
  const op = p * 6; const oc = i * 6;
  // column 3 of each inverse (response to a unit torque)
  const wB = ai[op + 5]! + ai[oc + 5]!;
  const Cb = wrapAngle(th[i]! - th[p]! - rest) - (prescribed ? 0 : wk.tau[i]! * sg.compliance[i]!);
  const alpha = prescribed ? 0 : sg.compliance[i]! / (h * h);
  if (prescribed || alpha > 0) {
    let dl: number;
    if (prescribed) dl = -Cb / wB;
    else {
      // XPBD damping: beta = zeta 2 sqrt(k I_red), gamma = alpha_raw beta / h
      const k = 1 / sg.compliance[i]!;
      const ie = wk.ie[i]! * wk.ie[p]! / (wk.ie[i]! + wk.ie[p]!);
      const beta = sg.damping[i]! * 2 * Math.sqrt(k * ie);
      const gamma = sg.compliance[i]! * (beta + wk.cm[i]!) / h;
      const dC = (th[i]! - thp[i]!) - (th[p]! - thp[p]!);
      if (first) wk.lam[i] = 0;
      dl = -(Cb + alpha * wk.lam[i]! + gamma * dC) / ((1 + gamma) * wB + alpha);
      wk.lam[i] = wk.lam[i]! + dl;
      // the muscle's share of this row's generalised force: T0 - c_mus dC'/h (dC' after the update)
      wk.tauReal[i] = wk.tau[i]! - wk.cm[i]! * (dC + wB * dl) / h;
    }
    applyTorqueCorrection(wk, sg, p, i, dl);
  }
  // limits (hard), about the rest angle
  let lo = sg.limitLo[i]! - restA; let hi = sg.limitHi[i]! - restA;
  if (mir < 0) { const t = lo; lo = -hi; hi = -t; }
  if (lo < hi) {
    const d = wrapAngle(th[i]! - th[p]! - rest);
    let Cl = 0;
    if (d < lo) Cl = d - lo; else if (d > hi) Cl = d - hi;
    if (Cl !== 0) applyTorqueCorrection(wk, sg, p, i, -Cl / wB);
  }
}

/** Apply dl along the bend gradient (child +1, parent -1) through the generalised inverses. */
function applyTorqueCorrection(wk: Work, sg: World['seg']['c'], p: number, i: number, dl: number): void {
  const { ai, th } = wk;
  const op = p * 6; const oc = i * 6;
  sg.posX[p] = sg.posX[p]! - ai[op + 2]! * dl; sg.posY[p] = sg.posY[p]! - ai[op + 4]! * dl; th[p] = th[p]! - ai[op + 5]! * dl;
  sg.posX[i] = sg.posX[i]! + ai[oc + 2]! * dl; sg.posY[i] = sg.posY[i]! + ai[oc + 4]! * dl; th[i] = th[i]! + ai[oc + 5]! * dl;
}

/** Hard joint limits only (after the tree solve). */
function solveLimit(wk: Work, sg: World['seg']['c'], i: number, p: number, mir: number, frac: number): void {
  const restA = sg.restAngle[i]!; const restB = wk.restPrev[i]!;
  const rest = mir * (restB + wrapAngle(restA - restB) * frac);
  let lo = sg.limitLo[i]! - restA; let hi = sg.limitHi[i]! - restA;
  if (mir < 0) { const t = lo; lo = -hi; hi = -t; }
  if (!(lo < hi)) return;
  const d = wrapAngle(wk.th[i]! - wk.th[p]! - rest);
  let Cl = 0;
  if (d < lo) Cl = d - lo; else if (d > hi) Cl = d - hi;
  if (Cl === 0) return;
  const wB = wk.ai[p * 6 + 5]! + wk.ai[i * 6 + 5]!;
  applyTorqueCorrection(wk, sg, p, i, -Cl / wB);
}
