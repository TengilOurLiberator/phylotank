/**
 * Jet bells, gas bladders and rolling (02 §2.2.6, §2.3.6, §2.3.8; CONTRACT 8.2 ROLL). Updated
 * once per tick in `beginCreature`; the solver applies the resulting forces in every substep.
 *
 * Jets: a bell of volume `V_b` (up to `JET_FRAC` of its segment) contracts with drive `a` and
 * refills elastically. The jet force `c_j rho Q^2 / A_n` acts along the segment axis (water
 * leaves at the base, thrust towards the tip); refilling through a 4x wider aperture pulls back
 * a quarter as hard. `c_j = Re_j / (Re_j + 10)` with the jet Reynolds number `d_n |Q| / (A_n nu)`:
 * at low Re the momentum-flux picture fails (reciprocal Stokes flow), so jets fade out for
 * microbes, as added mass does.
 *
 * Bladders: `n` mol of gas whose volume follows Boyle's law at the segment's depth and the
 * water temperature; the drive in `cmd2` pumps gas in (costly) or vents it (free).
 *
 * State lives in `Work` (`jetVol`, `gasMol`, roll timers) until contract request PH2-4 gives
 * it columns.
 */
import { GRAVITY, LIFE, NU_WATER, ORGAN, PI, RHO_WATER, exp, type World } from '../core/index.js';
import { isPlate, segVolume } from './body.js';
import type { Work } from './work.js';

/** Bell volume as a fraction of its segment's volume (02 §2.2.6: up to 30%). */
export const JET_FRAC = 0.3;
/** Nozzle radius over segment radius. */
export const JET_NOZZLE = 0.5;
/** Full contraction time at drive 1 and elastic refill time constant, s. */
export const JET_T_CONTRACT = 0.3;
export const JET_T_REFILL = 0.6;
/** The bell stops contracting at this fraction of its full volume. */
export const JET_V_MIN = 0.2;
export const ETA_JET = 0.2;
/** Surface pressure (Pa) and the gas constant. */
export const P_ATM = 101325;
export const R_GAS = 8.314462618;
/** Bladder pumping rate at full drive: gas volume per second as a fraction of the segment volume. */
export const BLADDER_RATE = 0.02;
/** Largest bladder gas volume as a fraction of its segment volume. */
export const BLADDER_MAX = 0.5;
export const ETA_BLADDER = 0.1;
/** Holding cost of a bladder (leakage), W per m^3 of gas. */
export const C_HOLD = 80;
/** Roll hysteresis on the ROLL output, cooldown and limit-relaxation time, s. */
export const ROLL_ON = 0.5;
export const ROLL_OFF = 0.2;
export const ROLL_COOLDOWN_S = 1;
export const ROLL_RELAX_S = 0.5;
const OUT_ROLL = 7;
const OUT_LANES = 8;

/** Absolute pressure at depth y (y down from the surface), Pa. */
export function pressureAt(world: World, y: number): number {
  const d = y - world.g.ySurface;
  return P_ATM + RHO_WATER * GRAVITY * (d > 0 ? d : 0);
}

/** Moles of gas that occupy `V` m^3 at depth y and temperature tempC. */
export function molesFor(world: World, V: number, y: number, tempC: number): number {
  return pressureAt(world, y) * V / (R_GAS * (tempC + 273.15));
}

/** Gas volume of `mol` moles at depth y (Boyle and Charles). */
export function gasVolume(world: World, mol: number, y: number, tempC: number): number {
  return mol * R_GAS * (tempC + 273.15) / pressureAt(world, y);
}

/** Test and designer adapter: put `mol` moles into a bladder segment (PH2-4). */
export function setBladder(world: World, wk: Work, seg: number, mol: number): void {
  world.seg.c.organs[seg] = world.seg.c.organs[seg]! | ORGAN.BLADDER;
  wk.gasMol[seg] = mol;
}

/**
 * Once per tick for one creature: jet and bladder state, their forces along the axis and lift
 * (stored per segment in `wk.jetF` and `wk.gasV`), and their power. Returns the power in W.
 */
export function updateOrgans(world: World, wk: Work, slot: number, s0: number, n: number, dt: number, dead: boolean): number {
  const sg = world.seg.c; const c = world.cr.c;
  const tempC = c.tempC[slot]!;
  let P = 0;
  for (let k = 0; k < n; k++) {
    const i = s0 + k;
    const org = sg.organs[i]!;
    wk.jetF[i] = 0; wk.gasV[i] = 0;
    if ((org & (ORGAN.JET | ORGAN.BLADDER)) === 0) continue;
    const Vs = segVolume(isPlate(sg.kind[i]!), sg.len[i]!, sg.radius[i]!, sg.span[i]!);
    const drive = dead ? 0 : sg.cmd2[i]!;
    if ((org & ORGAN.JET) !== 0) {
      const Vmax = JET_FRAC * Vs;
      let V = wk.jetVol[i]!;
      if (!(V > 0) || V > Vmax) V = Vmax;
      const a = drive < 0 ? 0 : drive > 1 ? 1 : drive;
      let Vn: number;
      if (a > 0.05 && V > JET_V_MIN * Vmax) Vn = Math.max(JET_V_MIN * Vmax, V - a * Vmax * dt / JET_T_CONTRACT);
      else Vn = Vmax - (Vmax - V) * exp(-dt / JET_T_REFILL);
      const Q = (V - Vn) / dt; // > 0 expelling
      wk.jetVol[i] = Vn;
      const rn = JET_NOZZLE * sg.radius[i]!;
      const An = PI * rn * rn;
      const reJ = 2 * rn * Math.abs(Q) / An / NU_WATER;
      const cj = reJ / (reJ + 10);
      const F = cj * RHO_WATER * Q * Q / An;
      wk.jetF[i] = Q > 0 ? F : -0.25 * F;
      P += 0.5 * RHO_WATER * Math.abs(Q) ** 3 / (An * An) / ETA_JET;
    }
    if ((org & ORGAN.BLADDER) !== 0) {
      const y = sg.posY[i]!;
      const pr = pressureAt(world, y);
      const RT = R_GAS * (tempC + 273.15);
      let mol = wk.gasMol[i]!;
      const V0 = mol * RT / pr;
      const d = drive < -1 ? -1 : drive > 1 ? 1 : drive;
      let V1 = V0 + d * BLADDER_RATE * Vs * dt;
      const vMax = BLADDER_MAX * Vs;
      if (V1 > vMax) V1 = V1 > V0 ? Math.max(V0, vMax) : V1;
      if (V1 < 0) V1 = 0;
      mol = V1 * pr / RT;
      wk.gasMol[i] = mol;
      wk.gasV[i] = V1;
      const dV = V1 - V0;
      P += (dV > 0 ? pr * dV / dt / ETA_BLADDER : 0) + C_HOLD * V1;
    }
  }
  return P;
}

/** Initial bladder gas on load: neutral buoyancy for the whole creature at its depth, capped. */
export function initBladders(world: World, wk: Work, slot: number): void {
  const c = world.cr.c; const sg = world.seg.c;
  const s0 = c.segStart[slot]!; const n = c.segCount[slot]!;
  let m = 0; let V = 0; let vCap = 0; let nb = 0;
  for (let k = 0; k < n; k++) {
    const i = s0 + k;
    m += sg.mass[i]!;
    const Vs = segVolume(isPlate(sg.kind[i]!), sg.len[i]!, sg.radius[i]!, sg.span[i]!);
    V += Vs;
    wk.jetVol[i] = JET_FRAC * Vs;
    wk.gasMol[i] = 0;
    if ((sg.organs[i]! & ORGAN.BLADDER) !== 0) { vCap += BLADDER_MAX * Vs; nb++; }
  }
  if (nb === 0) return;
  const need = Math.max(0, Math.min(vCap, m / RHO_WATER - V));
  for (let k = 0; k < n; k++) {
    const i = s0 + k;
    if ((sg.organs[i]! & ORGAN.BLADDER) === 0) continue;
    const Vs = segVolume(isPlate(sg.kind[i]!), sg.len[i]!, sg.radius[i]!, sg.span[i]!);
    wk.gasMol[i] = molesFor(world, need * (BLADDER_MAX * Vs) / vCap, sg.posY[i]!, c.tempC[slot]!);
  }
}

/**
 * Roll (mirror flip) from the ROLL global output, with hysteresis and a cooldown; after a flip
 * the joint limits are relaxed for `ROLL_RELAX_S` so the pose swings over through the springs
 * instead of snapping. Returns true while the limits are relaxed.
 */
export function updateRoll(world: World, wk: Work, slot: number, dt: number): boolean {
  const c = world.cr.c;
  if (wk.rollCool[slot]! > 0) wk.rollCool[slot] = Math.max(0, wk.rollCool[slot]! - dt);
  if (wk.rollRelax[slot]! > 0) wk.rollRelax[slot] = Math.max(0, wk.rollRelax[slot]! - dt);
  if (c.life[slot] !== LIFE.ALIVE) return wk.rollRelax[slot]! > 0;
  const r = c.out[slot * OUT_LANES + OUT_ROLL]!;
  if (r < ROLL_OFF) wk.rollArmed[slot] = 1;
  else if (r >= ROLL_ON && wk.rollArmed[slot] === 1 && wk.rollCool[slot] === 0) {
    c.mirror[slot] = c.mirror[slot]! < 0 ? 1 : -1;
    wk.rollArmed[slot] = 0;
    wk.rollCool[slot] = ROLL_COOLDOWN_S;
    wk.rollRelax[slot] = ROLL_RELAX_S;
  }
  return wk.rollRelax[slot]! > 0;
}
