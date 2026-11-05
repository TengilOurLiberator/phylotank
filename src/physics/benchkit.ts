/**
 * Benchmark scenes shared by the spike tests (docs/spikes/physics-1.md). Not used by the sim.
 */
import { createPhysics, type PhysicsOptions } from './index.js';
import { StokesReference, type RefLink } from './reference.js';
import { com, makePhenotype, makeWorld, nextTick, purcell, spawn } from './testkit.js';

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

export function runPurcellSim(nSub: number, cycles: number, reciprocal = false, scale = 1, opts: Partial<PhysicsOptions> = {}): { dx: number; dy: number; L: number } {
  const tw = makeWorld();
  const phys = createPhysics({ nSub, gravity: false, prescribed: true, contacts: false, ...opts });
  const ang = new Float64Array(3); const rate = new Float64Array(3);
  purcellShape(0, ang, rate, reciprocal);
  const slot = spawn(tw, phys.loadBody, makePhenotype(purcell(PL * scale, PR * scale, ang[1]!, ang[2]! - Math.PI)), 16, 9);
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

