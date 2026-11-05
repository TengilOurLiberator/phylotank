/**
 * Exploit watchdog (02 §2.14, REVIEW R9): a creature whose mechanical energy, measured in the
 * frame of the local water, rises by more than its muscle and buoyancy work over a 2 s window
 * is flagged and its speed relative to the water is clamped. Measuring in the water frame and
 * ignoring drag (which in that frame only removes energy) means a passive drifter carried by a
 * strong current never triggers it.
 */
import { GRAVITY, LIFE, RHO_WATER, type World } from '../core/index.js';
import { segVolume, isPlate } from './body.js';
import type { Work } from './work.js';

export const WATCH_TICKS = 60;
/** Allowed slack: 5% of the window's input plus an absolute floor in J per kg. */
export const WATCH_REL = 0.05;
export const WATCH_ABS_J_PER_KG = 1e-6;

export interface WatchState { e0: Float64Array; input: Float64Array; ticks: Uint16Array; flagged: number[] }
const states = new WeakMap<World, WatchState>();

export function watchState(world: World): WatchState {
  let s = states.get(world);
  if (!s) {
    const n = world.cr.capacity;
    s = { e0: new Float64Array(n).fill(-1), input: new Float64Array(n), ticks: new Uint16Array(n), flagged: [] };
    states.set(world, s);
  }
  return s;
}

/** Kinetic energy in the local water frame plus elastic energy of the joints. */
export function waterFrameEnergy(world: World, slot: number, wk: Work): number {
  const c = world.cr.c; const sg = world.seg.c;
  const s0 = c.segStart[slot]!; const n = c.segCount[slot]!;
  let E = 0;
  for (let k = 0; k < n; k++) {
    const i = s0 + k;
    const vx = sg.velX[i]! - wk.ux[i]!; const vy = sg.velY[i]! - wk.uy[i]!;
    E += 0.5 * sg.mass[i]! * (vx * vx + vy * vy) + 0.5 * sg.inertia[i]! * sg.angVel[i]! * sg.angVel[i]!;
  }
  return E;
}

/** Run after the integrator each tick. Returns true when the creature was flagged this tick. */
export function watch(world: World, slot: number, wk: Work, dt: number, gravity: boolean): boolean {
  const st = watchState(world);
  const c = world.cr.c; const sg = world.seg.c;
  const s0 = c.segStart[slot]!; const n = c.segCount[slot]!;
  let input = 0; let m = 0;
  for (let k = 0; k < n; k++) {
    const i = s0 + k;
    input += sg.work[i]!;
    m += sg.mass[i]!;
    if (gravity) {
      const Fy = (sg.mass[i]! - RHO_WATER * segVolume(isPlate(sg.kind[i]!), sg.len[i]!, sg.radius[i]!, sg.span[i]!)) * GRAVITY;
      const vy = sg.velY[i]! - wk.uy[i]!;
      input += Math.abs(Fy * vy) * dt;
    }
  }
  st.input[slot] = st.input[slot]! + input;
  if (st.e0[slot]! < 0) { st.e0[slot] = waterFrameEnergy(world, slot, wk); st.input[slot] = 0; st.ticks[slot] = 0; return false; }
  st.ticks[slot] = st.ticks[slot]! + 1;
  if (st.ticks[slot]! < WATCH_TICKS) return false;
  const E = waterFrameEnergy(world, slot, wk);
  const gain = E - st.e0[slot]!;
  const allowed = st.input[slot]! * (1 + WATCH_REL) + WATCH_ABS_J_PER_KG * m;
  let flagged = false;
  if (gain > allowed && c.life[slot] === LIFE.ALIVE) {
    flagged = true;
    st.flagged.push(slot);
    // clamp: scale velocities relative to the water so the window's gain is removed
    const keep = Math.sqrt(Math.max(0, (st.e0[slot]! + allowed) / E));
    for (let k = 0; k < n; k++) {
      const i = s0 + k;
      sg.velX[i] = wk.ux[i]! + (sg.velX[i]! - wk.ux[i]!) * keep;
      sg.velY[i] = wk.uy[i]! + (sg.velY[i]! - wk.uy[i]!) * keep;
      sg.angVel[i] = sg.angVel[i]! * keep;
    }
  }
  st.e0[slot] = waterFrameEnergy(world, slot, wk); st.input[slot] = 0; st.ticks[slot] = 0;
  return flagged;
}

/** Slots flagged since the last drain (the host logs their genomes as regression cases). */
export function drainFlags(world: World): number[] {
  const st = watchState(world);
  return st.flagged.splice(0, st.flagged.length);
}
