/**
 * Reference formulas of CONTRACT 9.4 and 9.6, so the ecosystem engineer starts from the
 * contract's numbers and tests can pin them. Pure functions, deterministic math only.
 */
import { C_REP, exp, K_CAP, M_REF_1CM } from '../core/index.js';

/** Additive, absolute agent-cap fee per offspring in kg (CONTRACT 9.6, fixes review R11). */
export function agentCapFeeKg(nAgents: number, nCap: number): number {
  const s0 = (nAgents / nCap - 0.5) / 0.5;
  const s = s0 < 0 ? 0 : s0 > 1 ? 1 : s0;
  return K_CAP * M_REF_1CM * s * s;
}

/** Repair power of the disposable-soma rule (CONTRACT 9.4), W. */
export function repairPowerW(basalW: number, lifespanMult: number): number {
  return C_REP * basalW * (lifespanMult - 1);
}

/**
 * Gompertz ageing hazard per second, normalised so the cumulative hazard at t_life is 1
 * (CONTRACT 9.4, fixes review R10). `senescence` is the decoded trait in [0, 1].
 */
export function ageingHazard(ageS: number, lifeS: number, senescence: number): number {
  const G = 0.5 + 7.5 * senescence;
  return (G / lifeS) * exp((G * ageS) / lifeS) / (exp(G) - 1);
}
