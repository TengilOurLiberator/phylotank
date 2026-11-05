/** Run an engine for N simulated hours, record, detect, and write CSV, JSON and PNG output. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DETECTOR_OPTIONS, runDetectors, type DetectorOptions, type Verdict } from './detectors.js';
import type { EvoEngine } from './engine.js';
import { renderChart, type Series } from './plot/chart.js';
import { Recorder, SIZE_CLASSES, type Row, type SpeciesRow } from './record.js';

export interface RunOptions {
  hours: number;
  /** Simulated seconds between samples. */
  sampleS: number;
  detector?: Partial<DetectorOptions>;
  /** Called after every sample (progress). */
  onSample?: (r: Row) => void;
  /** Stop early when the population is extinct. */
  stopOnExtinction?: boolean;
}

export interface RunResult {
  rows: Row[];
  speciesRows: SpeciesRow[];
  verdicts: Verdict[];
  summary: Record<string, unknown>;
}

function first(rows: Row[], key: string, fromH = 0): number {
  for (const r of rows) if (r.tH! >= fromH && Number.isFinite(r[key]!)) return r[key]!;
  return NaN;
}
function last(rows: Row[], key: string): number {
  for (let i = rows.length - 1; i >= 0; i--) if (Number.isFinite(rows[i]![key]!)) return rows[i]![key]!;
  return NaN;
}
function meanOver(rows: Row[], key: string, fromH: number): number {
  let s = 0, n = 0;
  for (const r of rows) if (r.tH! >= fromH && Number.isFinite(r[key]!)) { s += r[key]!; n++; }
  return n ? s / n : NaN;
}

export function runLab(engine: EvoEngine, o: RunOptions): RunResult {
  const rec = new Recorder(engine);
  const steps = Math.max(1, Math.round(o.sampleS / engine.dtS));
  const total = Math.ceil((o.hours * 3600) / (steps * engine.dtS));
  const t0 = process.hrtime.bigint();
  rec.sample();
  o.onSample?.(rec.rows[0]!);
  for (let k = 0; k < total; k++) {
    engine.step(steps);
    const r = rec.sample();
    o.onSample?.(r);
    if (o.stopOnExtinction && r.pop === 0) break;
  }
  const wallS = Number(process.hrtime.bigint() - t0) / 1e9;
  const det = { ...DEFAULT_DETECTOR_OPTIONS, ...(o.detector ?? {}) };
  const verdicts = runDetectors(rec.rows, rec.last, det);
  const rows = rec.rows;
  const simH = last(rows, 'tH');
  const gens: Record<string, number> = {};
  for (const c of SIZE_CLASSES) {
    const g = last(rows, `gen_${c.name}`);
    gens[c.name] = Number.isFinite(g) ? g / simH : NaN;
  }
  const v0 = first(rows, 'vMaxMean');
  const v1 = meanOver(rows, 'vMaxMean', simH * 0.8);
  const bl0 = first(rows, 'vMaxBlMean');
  const bl1 = meanOver(rows, 'vMaxBlMean', simH * 0.8);
  const genEnd = last(rows, 'genMean');
  const summary: Record<string, unknown> = {
    engine: engine.describe(),
    simHours: simH,
    wallSeconds: wallS,
    speedup: (simH * 3600) / wallS,
    samples: rows.length,
    popFinal: last(rows, 'pop'),
    popMeanLast20pct: meanOver(rows, 'pop', simH * 0.8),
    extinct: last(rows, 'pop') === 0,
    births: rows.reduce((s, r) => s + r.births!, 0),
    deaths: rows.reduce((s, r) => s + r.deaths!, 0),
    deathsByCause: Object.fromEntries(['starvation', 'predation', 'age'].map((c) => [c, rows.reduce((s, r) => s + (r[`deaths_${c}`] ?? 0), 0)])),
    generationsMeanFinal: genEnd,
    generationsMaxFinal: last(rows, 'genMax'),
    generationsPerSimHourBySizeClass: gens,
    swim: {
      vMaxStartMps: v0, vMaxEndMps: v1, vMaxRatio: v1 / v0,
      vMaxBlStart: bl0, vMaxBlEnd: bl1, vMaxBlRatio: bl1 / bl0,
      realisedSpeedStartMps: first(rows, 'speedMean'), realisedSpeedEndMps: meanOver(rows, 'speedMean', simH * 0.8),
      swimIndexStart: first(rows, 'swimIndexMean'), swimIndexEnd: meanOver(rows, 'swimIndexMean', simH * 0.8),
      swimIndexRatio: meanOver(rows, 'swimIndexMean', simH * 0.8) / first(rows, 'swimIndexMean'),
      /** Size-free improvement per generation, from the swim index. */
      percentPerGeneration: Number.isFinite(genEnd) && genEnd > 0 ? (Math.pow(meanOver(rows, 'swimIndexMean', simH * 0.8) / first(rows, 'swimIndexMean'), 1 / genEnd) - 1) * 100 : NaN,
    },
    size: {
      lengthMedianStartMm: first(rows, 'lengthMedianMm'), lengthMedianEndMm: meanOver(rows, 'lengthMedianMm', simH * 0.8),
      lengthMaxEverMm: Math.max(0, ...rows.map((r) => (Number.isFinite(r.lengthMaxMm!) ? r.lengthMaxMm! : 0))),
      massMaxEverKg: Math.max(0, ...rows.map((r) => r.massMaxKg ?? 0)),
    },
    diversity: {
      speciesMeanLast20pct: meanOver(rows, 'species', simH * 0.8),
      speciesMax: Math.max(0, ...rows.map((r) => r.species!)),
      speciationsTotal: rows.reduce((s, r) => s + r.speciations!, 0),
      hill1MeanLast20pct: meanOver(rows, 'hill1', simH * 0.8),
      speciesGenotypeMeanLast20pct: meanOver(rows, 'speciesGenotype', simH * 0.8),
      rolesOccupiedMax: Math.max(0, ...rows.map((r) => r.rolesOccupied!)),
      roleMeansLast20pct: Object.fromEntries(Object.keys(rows[0] ?? {}).filter((k) => k.startsWith('role_')).map((k) => [k.slice(5), meanOver(rows, k, simH * 0.8)])),
    },
    traitsStartEnd: Object.fromEntries(Object.keys(rows[0] ?? {}).filter((k) => k.startsWith('trait_')).map((k) => [k.slice(6), [first(rows, k), last(rows, k)]])),
    ledger: {
      allExact: rows.every((r) => r.ledgerOk === 1),
      worstEnergyResidual: Math.max(0, ...rows.map((r) => (Number.isFinite(r.energyResidual!) ? Math.abs(r.energyResidual!) : 0))),
    },
    detectors: Object.fromEntries(verdicts.map((v) => [v.name, { available: v.available, fired: v.fired, firstH: v.firstH, fraction: v.fraction, evidence: v.evidence }])),
  };
  return { rows, speciesRows: rec.speciesRows, verdicts, summary };
}

// ---------------------------------------------------------------- output
export function toCsv(rows: Record<string, number | string>[]): string {
  if (!rows.length) return '';
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  const cell = (v: unknown): string => (v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? '' : String(v));
  return [keys.join(','), ...rows.map((r) => keys.map((k) => cell(r[k])).join(','))].join('\n') + '\n';
}

function seriesOf(rows: Row[], key: string, name = key): Series {
  return { name, x: rows.map((r) => r.tH!), y: rows.map((r) => r[key] ?? NaN) };
}

export function writeOutputs(dir: string, res: RunResult, png = true): string[] {
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const put = (name: string, data: string | Uint8Array): void => { writeFileSync(join(dir, name), data); files.push(join(dir, name)); };
  put('series.csv', toCsv(res.rows));
  put('species.csv', toCsv(res.speciesRows as unknown as Record<string, number>[]));
  put('summary.json', JSON.stringify(res.summary, null, 2) + '\n');
  if (!png) return files;
  const R = res.rows;
  const x = 'SIM HOURS';
  // population per species: the 7 largest by peak count, the rest as "other"
  const peak = new Map<number, number>();
  for (const s of res.speciesRows) peak.set(s.species, Math.max(peak.get(s.species) ?? 0, s.count));
  const top = [...peak.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 7).map(([k]) => k);
  const times = R.map((r) => r.tH!);
  const bySp = new Map<number, Map<number, number>>();
  for (const s of res.speciesRows) {
    let m = bySp.get(s.species);
    if (!m) { m = new Map(); bySp.set(s.species, m); }
    m.set(s.tH, s.count);
  }
  const spSeries: Series[] = top.map((sp) => ({ name: `SP ${sp}`, x: times, y: times.map((t) => bySp.get(sp)?.get(t) ?? 0) }));
  spSeries.push({ name: 'OTHER', x: times, y: R.map((r, i) => r.pop! - spSeries.reduce((s, ss) => s + ss.y[i]!, 0)) });
  put('population.png', renderChart({ title: 'POPULATION BY SPECIES', xLabel: x, yLabel: 'CREATURES', series: spSeries, yMin: 0 }));
  put('species.png', renderChart({ title: 'SPECIES COUNT (>= 5 MEMBERS)', xLabel: x, yLabel: 'SPECIES', series: [seriesOf(R, 'species', 'PHENOTYPE'), ...(R[0]?.speciesGenotype !== undefined ? [seriesOf(R, 'speciesGenotype', 'GENOTYPE')] : [])], yMin: 0 }));
  put('speed.png', renderChart({ title: 'SWIM SPEED', xLabel: x, yLabel: 'M/S', series: [seriesOf(R, 'speedMean', 'REALISED MEAN'), ...(R[0]?.vMaxMean !== undefined ? [seriesOf(R, 'vMaxMean', 'POTENTIAL MEAN'), seriesOf(R, 'vMaxP90', 'POTENTIAL P90')] : [])], yMin: 0 }));
  if (R[0]?.swimIndexMean !== undefined) put('swim-index.png', renderChart({ title: 'SWIM INDEX (SIZE-FREE)', xLabel: x, yLabel: 'SPEED / REFERENCE DESIGN', series: [seriesOf(R, 'swimIndexMean', 'MEAN')], yMin: 0 }));
  if (R[0]?.vMaxBlMean !== undefined) put('speed-bl.png', renderChart({ title: 'POTENTIAL SWIM SPEED', xLabel: x, yLabel: 'BODY LENGTHS / S', series: [seriesOf(R, 'vMaxBlMean', 'MEAN')], yMin: 0 }));
  put('size.png', renderChart({ title: 'BODY LENGTH', xLabel: x, yLabel: 'MM', series: [seriesOf(R, 'lengthMedianMm', 'MEDIAN'), seriesOf(R, 'lengthMeanMm', 'MEAN'), seriesOf(R, 'lengthMaxMm', 'MAX')], logY: true }));
  const roleKeys = Object.keys(R[0] ?? {}).filter((k) => k.startsWith('role_') && R.some((r) => r[k]! > 0));
  put('diet.png', renderChart({ title: 'DIET ROLES', xLabel: x, yLabel: 'CREATURES', series: roleKeys.map((k) => seriesOf(R, k, k.slice(5).toUpperCase())), yMin: 0 }));
  put('births-deaths.png', renderChart({ title: 'BIRTHS AND DEATHS PER SAMPLE', xLabel: x, yLabel: 'EVENTS', series: [seriesOf(R, 'births', 'BIRTHS'), seriesOf(R, 'deaths_starvation', 'STARVATION'), seriesOf(R, 'deaths_predation', 'PREDATION'), seriesOf(R, 'deaths_age', 'AGE')], yMin: 0 }));
  put('ledger.png', renderChart({ title: 'LEDGER AUDIT', xLabel: x, yLabel: 'MASS ERROR (QUANTA)', series: [seriesOf(R, 'ledgerDiffQ', 'MASS DIFF')], yMin: 0 }));
  if (R[0]?.genMean !== undefined) put('generations.png', renderChart({ title: 'MEAN GENERATION', xLabel: x, yLabel: 'GENERATION', series: [seriesOf(R, 'genMean', 'ALL'), ...['lt2mm', '2to5mm', '5to20mm', '20to50mm'].map((c) => seriesOf(R, `gen_${c}`, c.toUpperCase()))], yMin: 0 }));
  const watch = ['trait_lifespanMult', 'trait_senescence', 'trait_sessile', 'trait_clutch'].filter((k) => R[0]?.[k] !== undefined);
  if (watch.length) put('life-history.png', renderChart({ title: 'LIFE-HISTORY TRAITS (R10)', xLabel: x, yLabel: 'TRAIT MEAN', series: watch.map((k) => seriesOf(R, k, k.slice(6).toUpperCase())), logY: true }));
  return files;
}
