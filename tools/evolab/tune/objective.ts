/**
 * Scoring against stability and interest bands (04 §4.11): each metric gets a trapezoid score in
 * [0, 1] (1 inside the band, falling linearly to 0 at twice the band distance), the combination is a
 * weighted geometric mean (no metric can be traded to zero), hard gates zero the score, and the
 * robust score over seeds is mean - 0.5 sd.
 */
import type { Row } from '../record.js';

export interface Band {
  metric: string;
  /** Lower and upper bound of the target band; use -Infinity or Infinity for one-sided bands. */
  lo: number;
  hi: number;
  weight: number;
  /** A hard gate: outside the band, the whole score is 0. */
  gate?: boolean;
  describe: string;
}

/** Trapezoid score: 1 inside [lo, hi], 0 at a distance of one band width (or of |bound|) outside. */
export function trapezoid(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v >= lo && v <= hi) return 1;
  const width = Number.isFinite(lo) && Number.isFinite(hi) ? hi - lo : Math.abs(Number.isFinite(lo) ? lo : hi) || 1;
  const d = v < lo ? lo - v : v - hi;
  return Math.max(0, 1 - d / width);
}

/** Metrics derived from a run's rows, after burn-in. */
export function runMetrics(rows: Row[], burnInH: number): Record<string, number> {
  const w = rows.filter((r) => r.tH! >= burnInH);
  const mean = (k: string): number => {
    let s = 0, n = 0;
    for (const r of w) if (Number.isFinite(r[k]!)) { s += r[k]!; n++; }
    return n ? s / n : NaN;
  };
  const frac = (f: (r: Row) => boolean): number => (w.length ? w.filter(f).length / w.length : 0);
  const pops = w.map((r) => r.biomassKg!);
  const mu = pops.reduce((a, b) => a + b, 0) / Math.max(1, pops.length);
  const sd = Math.sqrt(pops.reduce((a, b) => a + (b - mu) * (b - mu), 0) / Math.max(1, pops.length));
  const totalH = (w[w.length - 1]?.tH ?? 0) - (w[0]?.tH ?? 0);
  const survived = rows.length > 0 && rows[rows.length - 1]!.pop! > 0 ? 1 : 0;
  const first = w[0], last = w[w.length - 1];
  return {
    survived,
    species: mean('species'),
    hill1: mean('hill1'),
    rolesOccupied: mean('rolesOccupied'),
    speciationPerHour: totalH > 0 ? w.reduce((s, r) => s + (r.speciations ?? 0), 0) / totalH : 0,
    biomassCv: mu > 0 ? sd / mu : NaN,
    capFillHighFrac: frac((r) => r.capFill! > 0.9),
    producerShare: mean('phytoKg') / Math.max(1e-30, mean('phytoKg') + mean('dissolvedKg') + mean('detritusKg') + mean('biomassKg')),
    vMaxGain: first && last && first.vMaxMean ? last.vMaxMean! / first.vMaxMean! : NaN,
    ledgerExact: rows.every((r) => r.ledgerOk === 1) ? 1 : 0,
  };
}

/** Bands for the toy (scaled from 04 §4.11 to a small tank and hours rather than days). */
export const TOY_BANDS: readonly Band[] = [
  { metric: 'survived', lo: 1, hi: 1, weight: 1, gate: true, describe: 'consumers survive the run' },
  { metric: 'ledgerExact', lo: 1, hi: 1, weight: 1, gate: true, describe: 'mass audit exact throughout' },
  { metric: 'species', lo: 3, hi: 40, weight: 1, describe: 'species richness S' },
  { metric: 'hill1', lo: 2, hi: Infinity, weight: 1, describe: 'Shannon effective species' },
  { metric: 'rolesOccupied', lo: 2, hi: Infinity, weight: 1, describe: 'diet roles with at least 5 members' },
  { metric: 'biomassCv', lo: 0.1, hi: 0.5, weight: 1, describe: 'some boom and bust, no crashes' },
  { metric: 'capFillHighFrac', lo: 0, hi: 0.05, weight: 0.5, describe: 'cap rarely full' },
  { metric: 'producerShare', lo: 0.15, hi: 0.6, weight: 0.5, describe: 'producers hold 15 to 60% of the mass' },
  { metric: 'vMaxGain', lo: 1.05, hi: Infinity, weight: 1, describe: 'swimming improves' },
];

export function score(metrics: Record<string, number>, bands: readonly Band[]): { score: number; parts: Record<string, number> } {
  const parts: Record<string, number> = {};
  let logSum = 0, wSum = 0, gated = false;
  for (const b of bands) {
    const s = trapezoid(metrics[b.metric]!, b.lo, b.hi);
    parts[b.metric] = s;
    if (b.gate) { if (s < 1) gated = true; continue; }
    wSum += b.weight;
    logSum += b.weight * Math.log(Math.max(s, 1e-6));
  }
  return { score: gated ? 0 : Math.exp(logSum / Math.max(wSum, 1e-12)), parts };
}

export function robust(scores: number[]): number {
  if (!scores.length) return 0;
  const m = scores.reduce((a, b) => a + b, 0) / scores.length;
  const sd = Math.sqrt(scores.reduce((a, b) => a + (b - m) * (b - m), 0) / scores.length);
  return m - 0.5 * sd;
}
