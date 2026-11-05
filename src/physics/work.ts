/**
 * Per-world f64 working state of the integrator, indexed by segment slot. The authoritative
 * state lives in the SoA pools; these arrays are loaded at the start of each tick and stored
 * back at its end, so a restored snapshot behaves identically. Only `muscleFrac`, `restPrev`
 * and the diagnostics persist between ticks (see docs/contract-requests/physics.md).
 */
import type { World } from '../core/index.js';

export interface Work {
  readonly cap: number;
  th: Float64Array; vx: Float64Array; vy: Float64Array; w: Float64Array;
  xp: Float64Array; yp: Float64Array; thp: Float64Array;
  /** Inverse of the drag-augmented generalised mass, symmetric 3x3: a00 a01 a02 a11 a12 a22. */
  ai: Float64Array;
  /** The drag-augmented generalised mass itself (same packing), for the tree solve. */
  am: Float64Array;
  /** Translational mass matrix with added mass (m00 m01 m11) and effective inertia. */
  mm: Float64Array; ie: Float64Array;
  /** Right-hand side scratch (3 per segment). */
  rhs: Float64Array;
  /** Joint muscle torque this substep (on the child's joint). */
  tau: Float64Array;
  /** Linearised Hill damping of the joint muscle this substep, N m s/rad. */
  cm: Float64Array;
  /** Muscle torque actually delivered by the bend row this substep (for work). */
  tauReal: Float64Array;
  /** Accumulated bend multiplier within a substep (XPBD, for iterations > 1). */
  lam: Float64Array;
  /** Flow velocity at the segment centre this tick. */
  ux: Float64Array; uy: Float64Array;
  /** Fin feathering factor phi this tick. */
  phi: Float64Array;
  /** Rest angle at the end of the previous tick (substep interpolation of prescribed rests). */
  restPrev: Float64Array; restInit: Uint8Array;
  /** Per segment muscle fraction (not a pool column; contract request). */
  muscleFrac: Float32Array;
  /** Per segment Phenotype subtype (mouth kind; not a pool column; contract request P2). */
  subtype: Uint8Array;
  /** Diagnostics, per segment, accumulated over the last tick: net muscle work, drag work by the water. */
  netWork: Float64Array; dragWork: Float64Array;
  /** Phenotype part index of each segment (changes only when a part is severed; contract request PH2-3). */
  part: Uint16Array;
  /** Jet bell volume (m^3) and bladder gas (mol), persistent (contract request PH2-4). */
  jetVol: Float64Array; gasMol: Float64Array;
  /** This tick: jet force along the axis (N, + towards the tip) and bladder gas volume (m^3). */
  jetF: Float64Array; gasV: Float64Array;
  /** Largest tangential slip speed at a contact this tick (m/s), for scraping. */
  slip: Float64Array;
  /** Cosine and sine of each segment angle (scratch, 2 per segment). */
  cs: Float64Array; cs2: Float64Array;
  /** Per-tick joint constants (solver.ts JT layout, 8 f64 per segment). */
  jt: Float64Array;
  /** Per-tick segment constants, interleaved (solver.ts TC layout, 18 f64 per segment). */
  tc: Float64Array;
  /** Seconds until a scraped-off proboscis may latch again. */
  latchCool: Float32Array;
  /** Roll state per creature: armed (u8), cooldown and limit-relax timers (s). */
  rollArmed: Uint8Array; rollCool: Float32Array; rollRelax: Float32Array;
  /** 1 on leaf segments (free tips) this tick. */
  leaf: Uint8Array;
  /** Trailing-edge thrust (N) on each leaf this substep (diagnostics). */
  teF: Float64Array;
  /** Diagnostics per creature over the last tick: contact heat (J). */
  contactHeat: Float64Array;
}

const works = new WeakMap<World, Work>();

export function workFor(world: World): Work {
  let wk = works.get(world);
  const cap = world.seg.capacity;
  if (!wk) {
    const f = (n = 1): Float64Array => new Float64Array(cap * n);
    wk = {
      cap, th: f(), vx: f(), vy: f(), w: f(), xp: f(), yp: f(), thp: f(), ai: f(6), am: f(6), mm: f(3), ie: f(),
      rhs: f(3), tau: f(), cm: f(), tauReal: f(), lam: f(), ux: f(), uy: f(), phi: f(), restPrev: f(), restInit: new Uint8Array(cap),
      muscleFrac: new Float32Array(cap).fill(0.3), subtype: new Uint8Array(cap), netWork: f(), dragWork: f(),
      contactHeat: new Float64Array(world.cr.capacity), leaf: new Uint8Array(cap), teF: f(), part: new Uint16Array(cap),
      jetVol: f(), gasMol: f(), latchCool: new Float32Array(cap), tc: f(18), cs: f(2), cs2: f(2), jt: f(8), jetF: f(), gasV: f(), slip: f(),
      rollArmed: new Uint8Array(world.cr.capacity), rollCool: new Float32Array(world.cr.capacity), rollRelax: new Float32Array(world.cr.capacity),
    };
    works.set(world, wk);
  }
  return wk;
}
