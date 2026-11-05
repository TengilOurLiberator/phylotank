/**
 * Parameter spaces for tuning. Every parameter is searched in a unit cube coordinate u in [0, 1],
 * mapped linearly or logarithmically onto its range (04 §4.11: "CMA-ES in log-parameter space").
 */
export interface ParamSpec { name: string; lo: number; hi: number; log: boolean; default: number }

export function fromUnit(p: ParamSpec, u: number): number {
  const c = Math.min(1, Math.max(0, u));
  return p.log ? Math.exp(Math.log(p.lo) + c * (Math.log(p.hi) - Math.log(p.lo))) : p.lo + c * (p.hi - p.lo);
}
export function toUnit(p: ParamSpec, v: number): number {
  return p.log ? (Math.log(v) - Math.log(p.lo)) / (Math.log(p.hi) - Math.log(p.lo)) : (v - p.lo) / (p.hi - p.lo);
}
export function decode(space: readonly ParamSpec[], u: ArrayLike<number>): Record<string, number> {
  return Object.fromEntries(space.map((p, i) => [p.name, fromUnit(p, u[i]!)]));
}

/** The toy's balancing parameters (names follow 04 §4.10 where one exists), ranges from that table. */
export const TOY_SPACE: readonly ParamSpec[] = [
  { name: 'muMaxPerDay', lo: 0.5, hi: 3, log: true, default: 1.5 },
  { name: 'kNkgPerM2', lo: 0.004, hi: 0.08, log: true, default: 0.02 },
  { name: 'mPPerDay', lo: 0.01, hi: 0.2, log: true, default: 0.05 },
  { name: 'mP2', lo: 0.05, hi: 2, log: true, default: 0.5 },
  { name: 'iK', lo: 0.1, hi: 0.6, log: false, default: 0.3 },
  { name: 'rDPerDay', lo: 0.04, hi: 0.6, log: true, default: 0.15 },
  { name: 'carcassHalfDays', lo: 0.4, hi: 6, log: true, default: 1.5 },
  { name: 'aMaxPlant', lo: 0.3, hi: 0.6, log: false, default: 0.45 },
  { name: 'theta', lo: 1, hi: 2, log: false, default: 1.3 },
  { name: 'b0Mult', lo: 0.3, hi: 3, log: true, default: 1 },
  { name: 'cRep', lo: 0.01, hi: 0.2, log: true, default: 0.05 },
  { name: 'kCap', lo: 0.25, hi: 4, log: true, default: 1 },
  { name: 'jMaxBasal', lo: 4, hi: 16, log: true, default: 8 },
  { name: 'catchRate', lo: 0.25, hi: 4, log: true, default: 1 },
  { name: 'handlingS', lo: 5, hi: 120, log: true, default: 30 },
  { name: 'jetMps', lo: 0, hi: 0.25, log: false, default: 0.12 },
];

/**
 * The real sim's tuning set (04 §4.10 "Tuned" column). The SimCore adapter can pass only what
 * WorldConfig accepts today (mTargetKg); the rest needs the contract request in
 * docs/spikes/evolab-1.md (a `params` override map on WorldConfig).
 */
export const SIM_SPACE: readonly ParamSpec[] = [
  { name: 'mTargetKg', lo: 25, hi: 400, log: true, default: 100 },
  { name: 'iK', lo: 0.1, hi: 0.6, log: false, default: 0.3 },
  { name: 'kMix', lo: 5e-4, hi: 5e-2, log: true, default: 5e-3 },
  { name: 'aE', lo: 0, hi: 0.1, log: false, default: 0.03 },
  { name: 'muMax', lo: 0.5, hi: 3, log: true, default: 1.5 },
  { name: 'kN', lo: 10, hi: 200, log: true, default: 50 },
  { name: 'mP', lo: 0.01, hi: 0.2, log: true, default: 0.05 },
  { name: 'mP2', lo: 1e-5, hi: 1e-3, log: true, default: 2e-4 },
  { name: 'muB', lo: 0.2, hi: 1.5, log: true, default: 0.6 },
  { name: 'rD', lo: 0.0375, hi: 0.6, log: true, default: 0.15 },
  { name: 'wD', lo: 2, hi: 32, log: true, default: 8 },
  { name: 'carcassHalfDays', lo: 0.375, hi: 6, log: true, default: 1.5 },
  { name: 'aMaxPlant', lo: 0.3, hi: 0.6, log: false, default: 0.45 },
  { name: 'theta', lo: 1, hi: 2, log: false, default: 1.3 },
  { name: 'b0', lo: 0.3, hi: 3, log: true, default: 1 },
  { name: 'betaScale', lo: 0.1, hi: 10, log: true, default: 1 },
];
