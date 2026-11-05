/**
 * Benchmark scenes shared by the spike tests (docs/spikes/physics-1.md). Not used by the sim.
 */
import { createPhysics, type PhysicsOptions } from './index.js';
import { StokesReference, type RefLink } from './reference.js';
import { PI, sin } from '../core/index.js';
import { workFor } from './work.js';
import { bodyMass, com, elastic, fish, kinetic, makePhenotype, makeWorld, nextTick, purcell, spawn, type PartDef } from './testkit.js';

// ---------------------------------------------------------------- anguilliform at high Re (B4)
export interface Gait { f: number; amp: number[]; lag: number }
export interface SwimResult {
  U: number; Re: number; St: number; P: number; cot: number; wNet: number; dragW: number; dE: number; tipAmp: number;
  /** Metabolic economy U / P, m/J. */
  econ: number;
  /**
   * Froude efficiency proxy: the drag of the straight body gliding at U (from its own drag
   * coefficients) times U, over the net mechanical muscle power. The standard self-propelled
   * estimate; it ignores the extra drag of the bent body, so it errs low.
   */
  eta: number;
  /** Glide drag of the straight body at U, N. */
  dGlide: number;
}

/**
 * Self-propelled swimming of a body driven by its own muscles with `cmd_j = A_j sin(2 pi f t - lag j)`.
 * Speed is the centre-of-mass speed over the second half of the run; St = f * (peak-to-peak tail
 * excursion) / U.
 */
export function swim(gait: Gait, over: Partial<PhysicsOptions> = {}, seconds = 8, body: PartDef[] = fish(), L = 0.2): SwimResult {
  const tw = makeWorld();
  const phys = createPhysics({ gravity: false, contacts: false, diagnostics: true, ...over });
  const slot = spawn(tw, phys.loadBody, makePhenotype(body), 16, 9);
  const w = tw.world; const sg = w.seg.c; const c = w.cr.c; const s0 = c.segStart[slot]!; const n = c.segCount[slot]!;
  const wk = workFor(w);
  const dt = phys.opts.dt;
  const ticks = Math.round(seconds / dt);
  const half = Math.round(ticks / 2);
  // the tail tip is the last leaf of the main chain: the last segment that is not a side fin
  let tail = n - 1;
  while (tail > 0 && body[tail]!.kind !== undefined && body[tail]!.kind !== 0 && body[tail]!.restAngle !== 0) tail--;
  let xA = 0; let tA = 0; let P = 0; let wNet = 0; let dragW = 0; let E0 = 0;
  let tipMin = Infinity; let tipMax = -Infinity;
  for (let k = 0; k < ticks; k++) {
    const t = k * dt;
    for (let j = 1; j < n; j++) sg.cmd[s0 + j] = (gait.amp[j - 1] ?? gait.amp[0]!) * sin(2 * PI * gait.f * t - gait.lag * j);
    phys.step(w, tw.ctx); nextTick(tw);
    if (k === half) { xA = com(w, slot)[0]; tA = t; E0 = kinetic(w, slot) + elastic(w, slot); }
    if (k > half) {
      P += c.powerW[slot]! * dt;
      for (let q = 0; q < n; q++) { wNet += wk.netWork[s0 + q]!; dragW += wk.dragWork[s0 + q]!; }
      // lateral tail-tip excursion (y, since the fish swims along +x)
      const i = s0 + tail;
      const tipY = sg.posY[i]! + sin(sg.angle[i]!) * 0.5 * sg.len[i]! - com(w, slot)[1];
      tipMin = Math.min(tipMin, tipY); tipMax = Math.max(tipMax, tipY);
    }
  }
  const T = (ticks - 1) * dt - tA;
  const dx = com(w, slot)[0] - xA;
  const U = dx / T;
  const m = bodyMass(w, slot);
  const tipAmp = 0.5 * (tipMax - tipMin);
  const dE = kinetic(w, slot) + elastic(w, slot) - E0;
  const Ua = Math.abs(U);
  let dGlide = 0;
  for (let q = 0; q < n; q++) {
    const d = sg.drag; const o = (s0 + q) * 5;
    dGlide += d[o]! * Ua + d[o + 2]! * Ua * Math.sqrt(Ua) + d[o + 3]! * Ua * Ua;
  }
  return {
    U, Re: Math.abs(U) * L / 2e-5, St: gait.f * 2 * tipAmp / Math.abs(U), P: P / T, cot: P / T / (m * 9.81 * Math.abs(U)),
    wNet, dragW, dE, tipAmp, econ: U / (P / T), eta: dGlide * U / (wNet / T), dGlide,
  };
}

// Purcell (B3) at low Re
const PL = 5e-4; // link length, m
const PR = 3e-5; // link radius, m
const PA = 1.0; // stroke amplitude, rad
const PT = 2; // period, s (60 ticks; quarters of 15 ticks)

/** Square stroke in joint-angle space, piecewise linear (rates piecewise constant). */
export function purcellShape(t: number, ang: Float64Array, rate: Float64Array, reciprocal = false): void {
  const ph = ((t % PT) + PT) % PT / PT;
  const q = Math.floor(ph * 4);
  const f = ph * 4 - q;
  const r = 2 * PA * 4 / PT;
  let a1 = 0; let a2 = 0; let r1 = 0; let r2 = 0;
  if (reciprocal) {
    // both joints together: a time-reversible flap
    const s = q < 2 ? (ph * 2) : (2 - ph * 2);
    a1 = PA - 2 * PA * s; a2 = a1; r1 = (q < 2 ? -1 : 1) * 2 * PA * 2 / PT; r2 = r1;
  } else if (q === 0) { a1 = PA - 2 * PA * f; a2 = PA; r1 = -r; } else if (q === 1) { a1 = -PA; a2 = PA - 2 * PA * f; r2 = -r; } else if (q === 2) { a1 = -PA + 2 * PA * f; a2 = -PA; r1 = r; } else { a1 = PA; a2 = -PA + 2 * PA * f; r2 = r; }
  ang[1] = a1; ang[2] = Math.PI + a2; rate[1] = r1; rate[2] = r2;
}

export function runPurcellSim(nSub: number, cycles: number, reciprocal = false, scale = 1, opts: Partial<PhysicsOptions> = {}, at: [number, number] = [16, 9]): { dx: number; dy: number; L: number } {
  const tw = makeWorld();
  const phys = createPhysics({ nSub, gravity: false, prescribed: true, contacts: false, ...opts });
  const ang = new Float64Array(3); const rate = new Float64Array(3);
  purcellShape(0, ang, rate, reciprocal);
  const slot = spawn(tw, phys.loadBody, makePhenotype(purcell(PL * scale, PR * scale, ang[1]!, ang[2]! - Math.PI)), at[0], at[1]);
  const sg = tw.world.seg.c;
  const [x0, y0] = com(tw.world, slot);
  const ticks = Math.round(cycles * PT / phys.opts.dt);
  for (let k = 0; k < ticks; k++) {
    purcellShape((k + 1) * phys.opts.dt, ang, rate, reciprocal);
    sg.restAngle[1] = ang[1]!; sg.restAngle[2] = ang[2]!;
    phys.step(tw.world, tw.ctx); nextTick(tw);
  }
  const [x1, y1] = com(tw.world, slot);
  return { dx: (x1 - x0) / cycles, dy: (y1 - y0) / cycles, L: 3 * PL * scale };
}

export function runPurcellRef(cycles: number, reciprocal = false, scale = 1): { dx: number; dy: number } {
  const links: RefLink[] = [
    { parent: -1, attachU: 0, length: PL * scale, radius: PR * scale, span: 2 * PR * scale, plate: false },
    { parent: 0, attachU: 0.5, length: PL * scale, radius: PR * scale, span: 2 * PR * scale, plate: false },
    { parent: 0, attachU: -0.5, length: PL * scale, radius: PR * scale, span: 2 * PR * scale, plate: false },
  ];
  const ref = new StokesReference(links, (t, a, r) => purcellShape(t, a, r, reciprocal));
  const q0 = [16, 9, 0];
  const c0 = ref.centroid(0, q0, [1, 1, 1]);
  const q1 = ref.run(q0, 0, cycles * PT, PT / 400);
  const c1 = ref.centroid(cycles * PT, q1, [1, 1, 1]);
  return { dx: (c1[0] - c0[0]) / cycles, dy: (c1[1] - c0[1]) / cycles };
}

