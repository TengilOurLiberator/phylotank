/**
 * Exploit detectors (review R6, R9, R10, R11). Each reads the recorded rows and the latest
 * observation and returns a verdict with evidence. They work on any engine: the toy supplies every
 * column; the real SimCore supplies what its world exposes, and a detector without its inputs
 * reports `available: false` rather than guessing.
 */
import type { Observation } from './engine.js';
import type { Row } from './record.js';

export interface Verdict {
  name: 'immortalBlobs' | 'energyLeaks' | 'microbeFlood' | 'degenerateSwimmers';
  available: boolean;
  fired: boolean;
  /** First sample time (h) at which the condition held, if any. */
  firstH: number | null;
  /** Fraction of samples (after burn-in) in which the condition held. */
  fraction: number;
  evidence: Record<string, number | string>;
}

export interface DetectorOptions {
  /** Ignore samples before this simulated hour. */
  burnInH: number;
  /** A condition must hold in at least this fraction of samples to fire (energy leaks: any sample). */
  sustain: number;
}

export const DEFAULT_DETECTOR_OPTIONS: DetectorOptions = { burnInH: 1, sustain: 0.25 };

function windowRows(rows: Row[], o: DetectorOptions): Row[] {
  return rows.filter((r) => r.tH! >= o.burnInH);
}

function verdict(name: Verdict['name'], rows: Row[], hold: (r: Row) => boolean, need: number, evidence: Verdict['evidence']): Verdict {
  let first: number | null = null;
  let k = 0;
  for (const r of rows) if (hold(r)) { k++; if (first === null) first = r.tH!; }
  const fraction = rows.length ? k / rows.length : 0;
  return { name, available: true, fired: rows.length > 0 && fraction >= need && k > 0, firstH: first, fraction, evidence };
}

/** Normalised position of a trait mean within its bounds (log bounds for positive ranges spanning a decade). */
function relPos(v: number, lo: number, hi: number): number {
  if (lo > 0 && hi / lo >= 10) return (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
  return (v - lo) / (hi - lo);
}

/**
 * Immortal blobs (R10's degenerate attractors): LIFESPAN_MULT walking to its bound while SENESCENCE
 * walks to 0, creatures outliving their own t_life many times over (the hazard is broken or free),
 * or sessile filter feeders taking over more than 80% of the population (the jet-parked blob).
 */
export function immortalBlobs(rows: Row[], obs: Observation | null, o = DEFAULT_DETECTOR_OPTIONS): Verdict {
  const w = windowRows(rows, o);
  const lb = obs?.traitBounds.lifespanMult;
  const sb = obs?.traitBounds.senescence;
  const has = w.length > 0 && w[0]!.maxAgeOverLifespan !== undefined;
  if (!has) return { name: 'immortalBlobs', available: false, fired: false, firstH: null, fraction: 0, evidence: {} };
  const hold = (r: Row): boolean => {
    const outlived = r.maxAgeOverLifespan! > 3;
    // the jet-parked filter blob of R10: sessile filter feeders take over the population
    if (r.sessileFrac! > 0.8) return true;
    let walked = false;
    if (lb && sb && r.trait_lifespanMult !== undefined && r.trait_senescence !== undefined) {
      walked = relPos(r.trait_lifespanMult, lb[0], lb[1]) > 0.8 && relPos(r.trait_senescence, sb[0], sb[1]) < 0.2;
    }
    return outlived || walked;
  };
  const first = w[0], last = w[w.length - 1];
  return verdict('immortalBlobs', w, hold, o.sustain, {
    lifespanMultStart: first?.trait_lifespanMult ?? NaN, lifespanMultEnd: last?.trait_lifespanMult ?? NaN,
    senescenceStart: first?.trait_senescence ?? NaN, senescenceEnd: last?.trait_senescence ?? NaN,
    maxAgeOverLifespan: Math.max(...w.map((r) => r.maxAgeOverLifespan ?? 0)),
    sessileFracEnd: last?.sessileFrac ?? NaN,
    sessileFracMax: Math.max(0, ...w.map((r) => r.sessileFrac ?? 0)),
    outlivedMax: Math.max(0, ...w.map((r) => r.maxAgeOverLifespan ?? 0)),
    ageDeathShare: (() => {
      const d = w.reduce((s, r) => s + (r.deaths ?? 0), 0);
      return d ? w.reduce((s, r) => s + (r.deaths_age ?? 0), 0) / d : NaN;
    })(),
  });
}

/** Energy leaks (R6, CONTRACT 9.1): the exact mass audit fails, or energy does not close. */
export function energyLeaks(rows: Row[], _obs: Observation | null, o = DEFAULT_DETECTOR_OPTIONS, energyTol = 1e-6): Verdict {
  void o;
  const hold = (r: Row): boolean => r.ledgerOk === 0 || (Number.isFinite(r.energyResidual!) && Math.abs(r.energyResidual!) > energyTol);
  const v = verdict('energyLeaks', rows, hold, 0, {
    worstMassDiffQ: rows.reduce((m, r) => (Math.abs(r.ledgerDiffQ!) > Math.abs(m) ? r.ledgerDiffQ! : m), 0),
    worstEnergyResidual: rows.reduce((m, r) => (Number.isFinite(r.energyResidual!) && Math.abs(r.energyResidual!) > Math.abs(m) ? r.energyResidual! : m), 0),
    energyTol,
  });
  return v;
}

/**
 * Microbe flood (R11): the agent cap is nearly full and the smallest size class holds most of the
 * agents but little of the biomass.
 */
export function microbeFlood(rows: Row[], _obs: Observation | null, o = DEFAULT_DETECTOR_OPTIONS): Verdict {
  const w = windowRows(rows, o);
  const hold = (r: Row): boolean => {
    const small = (r.n_lt2mm ?? 0) + (r['n_2to5mm'] ?? 0);
    return r.capFill! > 0.9 && r.pop! > 0 && small / r.pop! > 0.8;
  };
  const last = w[w.length - 1];
  return verdict('microbeFlood', w, hold, o.sustain, {
    capFillMax: Math.max(0, ...w.map((r) => r.capFill!)),
    capFillMean: w.length ? w.reduce((s, r) => s + r.capFill!, 0) / w.length : NaN,
    smallShareEnd: last && last.pop ? ((last.n_lt2mm ?? 0) + (last['n_2to5mm'] ?? 0)) / last.pop : NaN,
    clutchEnd: last?.trait_clutch ?? NaN,
    lengthMedianMmEnd: last?.lengthMedianMm ?? NaN,
  });
}

/**
 * Degenerate swimmers (R6, R9): a creature whose mechanical energy out (drag dissipation plus
 * kinetic energy in the water frame) exceeds the work its muscles put in is swimming on numerical
 * error. Evaluated per creature on the latest observation and summarised per sample.
 */
export function swimmerAudit(obs: Observation, tol = 0.05): { n: number; flagged: number; worstRatio: number } {
  if (!obs.workInJ || !obs.workOutJ) return { n: 0, flagged: -1, worstRatio: NaN };
  let flagged = 0, worst = 0, n = 0;
  for (let i = 0; i < obs.n; i++) {
    const win = obs.workInJ[i]!, wout = obs.workOutJ[i]!;
    if (win <= 0 && wout <= 0) continue;
    n++;
    const ratio = wout / Math.max(win, 1e-30);
    if (ratio > worst) worst = ratio;
    if (wout > win * (1 + tol) + 1e-18) flagged++;
  }
  return { n, flagged, worstRatio: worst };
}

export function degenerateSwimmers(rows: Row[], _obs: Observation | null, o = DEFAULT_DETECTOR_OPTIONS): Verdict {
  const w = windowRows(rows, o);
  if (!w.length || w[0]!.swimFlagged === undefined || w[0]!.swimFlagged! < 0) {
    return { name: 'degenerateSwimmers', available: false, fired: false, firstH: null, fraction: 0, evidence: {} };
  }
  const hold = (r: Row): boolean => r.swimFlagged! > Math.max(1, 0.01 * r.pop!);
  return verdict('degenerateSwimmers', w, hold, o.sustain, {
    worstRatio: Math.max(0, ...w.map((r) => r.swimWorstRatio ?? 0)),
    flaggedMax: Math.max(0, ...w.map((r) => r.swimFlagged!)),
  });
}

export function runDetectors(rows: Row[], obs: Observation | null, o = DEFAULT_DETECTOR_OPTIONS): Verdict[] {
  return [immortalBlobs(rows, obs, o), energyLeaks(rows, obs, o), microbeFlood(rows, obs, o), degenerateSwimmers(rows, obs, o)];
}
