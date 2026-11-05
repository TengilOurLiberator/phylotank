/**
 * Physics spike 1 (REVIEW spike 1, docs/spikes/physics-1.md): swimmers, energy leaks,
 * timestep convergence, the exploit-transfer ratio and CPU throughput. The fast checks always
 * run; the long measurements run with PT_SPIKE=1 and print JSON lines tagged "SPIKE".
 */
import { describe, expect, it } from 'vitest';
import { RngStreams, type World } from '../src/core/index.js';
import { createPhysics, workFor } from '../src/physics/index.js';
import { runPurcellRef, runPurcellSim } from '../src/physics/benchkit.js';
import {
  angularMomentum, com, elastic, fish, kinetic, kineticEff, makePhenotype, makeWorld, nextTick, setCmds, spawn,
} from '../src/physics/testkit.js';

const LONG = !!process.env.PT_SPIKE;
const log = (tag: string, data: unknown): void => { if (LONG) console.log(`SPIKE ${tag} ${JSON.stringify(data)}`); };

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

  it('T6: a microbe in the far corner swims the same distance per cycle as near the origin', () => {
    const near = runPurcellSim(4, 1, false, 1, {}, [0.5, 0.5]);
    const far = runPurcellSim(4, 1, false, 1, {}, [31.5, 17.5]);
    const rel = Math.hypot(far.dx - near.dx, far.dy - near.dy) / Math.hypot(near.dx, near.dy);
    log('precision', { rel });
    expect(rel).toBeLessThan(1e-3);
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
    for (const [nSub, iterations] of [[4, 1], [16, 1], [64, 1]] as const) {
      const tw = makeWorld();
      const phys = createPhysics({ fluid: false, gravity: false, contacts: false, nSub, iterations });
      const slot = spawn(tw, phys.loadBody, makePhenotype(fish()), 16, 9);
      const [x0, y0] = com(tw.world, slot);
      const rng = new RngStreams(7, 7);
      let maxL = 0; let scaleL = 0; let mass = 0;
      for (let k = 0; k < (LONG ? 300 : 120); k++) {
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
      res.push({ nSub, iterations, comDriftBL: drift, maxAngMom: maxL, relToInternal: maxL / scaleL, relToMLL: maxL / (mass * 0.04) });
      expect(drift).toBeLessThan(1e-5);
    }
    log('vacuum', res);
    // spike 1 measured 5e-2 m L^2/s at 4 substeps: the linearised joint solve's lever arms
    // left a net angular impulse every substep. Spike 2 cancels it with a rigid rotation about
    // the centre of mass (tree.ts, angularFix); what remains is f32 storage (docs/spikes/physics-2.md)
    for (const r of res) expect(r.relToMLL!).toBeLessThan(1e-6);
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

