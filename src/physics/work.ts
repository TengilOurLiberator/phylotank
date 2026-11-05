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
  /** Translational mass matrix with added mass (m00 m01 m11) and effective inertia. */
  mm: Float64Array; ie: Float64Array;
  /** Right-hand side scratch (3 per segment). */
  rhs: Float64Array;
  /** Joint muscle torque this substep (on the child's joint). */
  tau: Float64Array;
  /** Flow velocity at the segment centre this tick. */
  ux: Float64Array; uy: Float64Array;
  /** Fin feathering factor phi this tick. */
  phi: Float64Array;
  /** Rest angle at the end of the previous tick (substep interpolation of prescribed rests). */
  restPrev: Float64Array; restInit: Uint8Array;
  /** Per segment muscle fraction (not a pool column; contract request). */
  muscleFrac: Float32Array;
  /** Diagnostics, per segment, accumulated over the last tick: net muscle work, drag work by the water. */
  netWork: Float64Array; dragWork: Float64Array;
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
      cap, th: f(), vx: f(), vy: f(), w: f(), xp: f(), yp: f(), thp: f(), ai: f(6), mm: f(3), ie: f(),
      rhs: f(3), tau: f(), ux: f(), uy: f(), phi: f(), restPrev: f(), restInit: new Uint8Array(cap),
      muscleFrac: new Float32Array(cap).fill(0.3), netWork: f(), dragWork: f(),
      contactHeat: new Float64Array(world.cr.capacity),
    };
    works.set(world, wk);
  }
  return wk;
}
