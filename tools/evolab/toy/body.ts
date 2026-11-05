/**
 * The toy body: an ellipse of length L and width w = aspect * L in the 2.5D model (out-of-plane
 * span equal to the width), with fins and muscle. Swimming is a power balance:
 *
 *   thrust power  = eta(fins, Re) * P_muscle * effort
 *   drag          = 0.5 * rho * v^2 * A * Cd(Re),  Cd = 24 / Re + c_shape,  Re = v L / nu
 *
 * so a badly built body swims badly (small fins waste power, blunt bodies pay pressure drag, fins
 * add drag and mass) and microbes live in the viscous regime where drag is linear in speed.
 * Constants are SI and use the contract's water (CONTRACT 10.3) and metabolism (9.4).
 */
import { B0_KLEIBER, M_REF_1M, NU_WATER, RHO_WATER } from '../../../src/core/constants.js';

/**
 * Mechanical muscle power at full effort is MUSCLE_SCOPE x basal x muscle fraction, so that at the
 * reference muscle fraction 0.15 the burnt power at full effort is 6x basal (an aerobic scope of 6
 * at every size, as in real animals).
 */
export const MUSCLE_SCOPE = 10;
/** Metabolic efficiency of muscle: burnt power = mechanical power / MUSCLE_EFF. */
export const MUSCLE_EFF = 0.25;
/** Peak propulsive efficiency of an ideal fin. */
export const ETA_MAX = 0.7;

export interface BodyParams {
  lengthM: number;
  aspect: number;
  finArea: number;
  muscle: number;
}

/** Body mass (kg): the reference isometric body at aspect 0.3, scaled by width squared, plus fins. */
export function bodyMass(b: BodyParams): number {
  const s = b.aspect / 0.3;
  return M_REF_1M * b.lengthM * b.lengthM * b.lengthM * s * s * (1 + 0.1 * b.finArea);
}

/** Frontal area (m^2) including fin drag. */
export function frontalArea(b: BodyParams): number {
  const w = b.aspect * b.lengthM;
  return w * w + 0.08 * b.finArea * b.lengthM * b.lengthM;
}

/** Pressure-drag coefficient: slender bodies are cheaper. */
export function shapeCd(aspect: number): number {
  return 0.15 + 0.9 * aspect;
}

/** Drag force (N) at water-frame speed v (m/s). */
export function dragForce(b: BodyParams, v: number, area: number, cShape: number): number {
  if (v <= 0) return 0;
  const re = (v * b.lengthM) / NU_WATER;
  const cd = 24 / Math.max(re, 1e-9) + cShape;
  return 0.5 * RHO_WATER * v * v * area * cd;
}

/** Drag coefficient c such that F = c v (the secant), used by the semi-implicit integrator. */
export function dragSecant(b: BodyParams, v: number, area: number, cShape: number): number {
  // F / v = 0.5 rho area (24 nu / L + cShape v)
  return 0.5 * RHO_WATER * area * ((24 * NU_WATER) / b.lengthM + cShape * Math.max(v, 0));
}

/** Propulsive efficiency: fins help, viscous swimming is inefficient. */
export function propulsiveEfficiency(b: BodyParams, v: number): number {
  const re = (Math.max(v, 1e-6) * b.lengthM) / NU_WATER;
  const fin = b.finArea / (b.finArea + 0.2);
  const viscous = 0.08 + 0.92 * (re / (re + 30));
  return ETA_MAX * fin * viscous + 0.02;
}

/** Mechanical muscle power (W) at full effort. */
export function musclePowerW(b: BodyParams, massKg: number): number {
  return MUSCLE_SCOPE * b.muscle * basalW(massKg);
}

/** Basal metabolic rate at 15 C (CONTRACT 9.4), W. */
export function basalW(massKg: number): number {
  const r = Math.sqrt(massKg);
  return B0_KLEIBER * r * Math.sqrt(r); // m^0.75 with exactly specified operations only
}

/**
 * Steady swimming speed (m/s) at a given effort: solves eta(v) P = F(v) v by bisection.
 * This is the "potential" swim speed of a body, independent of behaviour.
 */
export function steadySpeed(b: BodyParams, effort: number): number {
  const m = bodyMass(b);
  const p = musclePowerW(b, m) * effort;
  if (p <= 0) return 0;
  const area = frontalArea(b);
  const cs = shapeCd(b.aspect);
  let lo = 0;
  let hi = 50 * b.lengthM + 1;
  for (let k = 0; k < 60; k++) {
    const v = 0.5 * (lo + hi);
    const net = propulsiveEfficiency(b, v) * p - dragForce(b, v, area, cs) * v;
    if (net > 0) lo = v; else hi = v;
  }
  return lo;
}
