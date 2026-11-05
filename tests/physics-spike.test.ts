/**
 * Physics spike 1 (REVIEW spike 1, docs/spikes/physics-1.md): swimmers, energy leaks,
 * timestep convergence, the exploit-transfer ratio and CPU throughput. The fast checks always
 * run; the long measurements run with PT_SPIKE=1 and print JSON lines tagged "SPIKE".
 */
import { describe, expect, it } from 'vitest';
import { RngStreams, type World } from '../src/core/index.js';
import { createPhysics, workFor, type PhysicsOptions } from '../src/physics/index.js';
import { StokesReference, type RefLink } from '../src/physics/reference.js';
import {
  angularMomentum, com, elastic, fish, kinetic, kineticEff, makePhenotype, makeWorld, nextTick, purcell, setCmds, spawn,
} from '../src/physics/testkit.js';

const LONG = !!process.env.PT_SPIKE;
const log = (tag: string, data: unknown): void => { if (LONG) console.log(`SPIKE ${tag} ${JSON.stringify(data)}`); };

// ---------------------------------------------------------------- Purcell (B3) at low Re
const PL = 5e-4; // link length, m
const PR = 3e-5; // link radius, m
const PA = 1.0; // stroke amplitude, rad
const PT = 2; // period, s (60 ticks; quarters of 15 ticks)

/** Square stroke in joint-angle space, piecewise linear (rates piecewise constant). */
function purcellShape(t: number, ang: Float64Array, rate: Float64Array, reciprocal = false): void {
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

export function runPurcellSim(nSub: number, cycles: number, reciprocal = false, scale = 1, opts: Partial<PhysicsOptions> = {}): { dx: number; dy: number; L: number; secs: number } {
  const tw = makeWorld();
  const phys = createPhysics({ nSub, gravity: false, prescribed: true, contacts: false, ...opts });
  const ang = new Float64Array(3); const rate = new Float64Array(3);
  purcellShape(0, ang, rate, reciprocal);
  const slot = spawn(tw, phys.loadBody, makePhenotype(purcell(PL * scale, PR * scale, ang[1]!, ang[2]! - Math.PI)), 16, 9);
  const sg = tw.world.seg.c;
  const [x0, y0] = com(tw.world, slot);
  const ticks = Math.round(cycles * PT / phys.opts.dt);
  const t0 = performance.now();
  for (let k = 0; k < ticks; k++) {
    purcellShape((k + 1) * phys.opts.dt, ang, rate, reciprocal);
    sg.restAngle[1] = ang[1]!; sg.restAngle[2] = ang[2]!;
    phys.step(tw.world, tw.ctx); nextTick(tw);
  }
  const secs = (performance.now() - t0) / 1000;
  const [x1, y1] = com(tw.world, slot);
  return { dx: (x1 - x0) / cycles, dy: (y1 - y0) / cycles, L: 3 * PL * scale, secs };
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

describe('physics spike: low Re (Purcell, scallop)', () => {
  it('B3: Purcell three-link swims and matches the independent Stokes reference', () => {
    const ref = runPurcellRef(2);
    const sim = runPurcellSim(16, 2);
    const refD = Math.hypot(ref.dx, ref.dy);
    const err = Math.hypot(sim.dx - ref.dx, sim.dy - ref.dy) / refD;
    log('purcell', { ref, sim, perCycleBL: refD / sim.L, relErr: err });
    expect(refD / sim.L).toBeGreaterThan(0.01); // it swims
    expect(err).toBeLessThan(0.03);
  });

  it('B1: a reciprocal stroke gives (almost) no net displacement at low Re', () => {
    const sim = runPurcellSim(16, 2, true);
    const per = Math.hypot(sim.dx, sim.dy) / sim.L;
    log('scallop', { perCycleBL: per });
    expect(per).toBeLessThan(0.005);
  });
});

// ---------------------------------------------------------------- energy (R6)
describe('physics spike: energy and momentum', () => {
  it('C1: in vacuum, random muscles cannot move the centre of mass or spin the body', () => {
    const res: Record<string, number>[] = [];
    for (const nSub of [4, 16, 64]) {
      const tw = makeWorld();
      const phys = createPhysics({ fluid: false, gravity: false, contacts: false, nSub });
      const slot = spawn(tw, phys.loadBody, makePhenotype(fish()), 16, 9);
      const [x0, y0] = com(tw.world, slot);
      const rng = new RngStreams(7, 7);
      let maxL = 0; let scaleL = 0; let mass = 0;
      for (let k = 0; k < 300; k++) {
        const d = rng.draw(8, k, 1);
        setCmds(tw.world, slot, () => d.u01() * 2 - 1);
        phys.step(tw.world, tw.ctx); nextTick(tw);
        maxL = Math.max(maxL, Math.abs(angularMomentum(tw.world, slot)));
        scaleL = Math.max(scaleL, internalL(tw.world, slot));
      }
      const s0 = tw.world.cr.c.segStart[slot]!;
      for (let k = 0; k < 8; k++) mass += tw.world.seg.c.mass[s0 + k]!;
      const [x1, y1] = com(tw.world, slot);
      const drift = Math.hypot(x1 - x0, y1 - y0) / 0.2;
      // contract C1 unit: m L^2 / s
      res.push({ nSub, comDriftBL: drift, maxAngMom: maxL, relToInternal: maxL / scaleL, relToMLL: maxL / (mass * 0.04) });
      expect(drift).toBeLessThan(1e-5);
    }
    log('vacuum', res);
    // measured (spike 1): one Gauss-Seidel pass leaves an angular-momentum error of order 1e-3
    // m L^2/s under maximal random muscles, falling with more passes, not with more substeps
    for (const r of res) expect(r.relToMLL!).toBeLessThan(1e-2);
  });

  it('passive bodies in water never gain kinetic plus elastic energy', () => {
    for (const [nSub, am] of [[1, false], [4, false], [16, false], [1, true], [4, true], [16, true]] as const) {
      const tw = makeWorld();
      const phys = createPhysics({ gravity: false, contacts: false, nSub, addedMass: am });
      const slot = spawn(tw, phys.loadBody, makePhenotype(fish()), 16, 9);
      const sg = tw.world.seg.c; const s0 = tw.world.cr.c.segStart[slot]!;
      for (let k = 0; k < 8; k++) { sg.velX[s0 + k] = 0.3 * Math.sin(k); sg.velY[s0 + k] = 0.3 * Math.cos(3 * k); sg.angVel[s0 + k] = 5 * Math.sin(2 * k); }
      const wk = workFor(tw.world);
      const energy = (): number => (am ? kineticEff(tw.world, slot, wk.mm, wk.ie) : kinetic(tw.world, slot)) + elastic(tw.world, slot);
      phys.step(tw.world, tw.ctx); nextTick(tw);
      const E0 = energy();
      let maxRatio = 0; let maxStepRise = 0; let prev = E0;
      for (let k = 0; k < 90; k++) {
        phys.step(tw.world, tw.ctx); nextTick(tw);
        const E = energy();
        maxRatio = Math.max(maxRatio, E / E0);
        maxStepRise = Math.max(maxStepRise, (E - prev) / E0);
        prev = E;
      }
      log('passive', { nSub, addedMass: am, maxRatio, maxStepRise, final: prev / E0 });
      expect(maxRatio).toBeLessThan(1);
      expect(prev / E0).toBeLessThan(0.5);
    }
  });
});

/** Sum of |I w| over segments: the scale of internal angular momentum. */
function internalL(w: World, slot: number): number {
  const c = w.cr.c; const sg = w.seg.c; const s0 = c.segStart[slot]!;
  let L = 0;
  for (let k = 0; k < c.segCount[slot]!; k++) L += Math.abs(sg.inertia[s0 + k]! * sg.angVel[s0 + k]!);
  return L;
}

