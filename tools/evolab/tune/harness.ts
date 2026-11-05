/**
 * The auto-tuning harness skeleton (04 §4.11, review R13): Morris screening over the balancing
 * parameters, keep the top K by mu*, then CMA-ES over those K (the rest stay at their defaults),
 * each candidate scored against the bands on several seeds with the robust score mean - 0.5 sd.
 * Runs on the toy today; an engine factory makes it drive the SimCore adapter later.
 */
import { RngStreams } from '../../../src/core/rng.js';
import type { EvoEngine } from '../engine.js';
import { runLab } from '../lab.js';
import { ToyEngine } from '../toy/engine.js';
import { CmaEs } from './cmaes.js';
import { morris, type MorrisResult } from './morris.js';
import { robust, runMetrics, score, TOY_BANDS, type Band } from './objective.js';
import { decode, toUnit, TOY_SPACE, type ParamSpec } from './space.js';

/** Tool-only RNG stream (not a sim stream). */
const TUNE_STREAM = 200;

export interface TuneOptions {
  preset: string;
  hours: number;
  seeds: number;
  morrisR: number;
  top: number;
  cmaGenerations: number;
  cmaPopulation: number;
  seed: number;
  space?: readonly ParamSpec[];
  bands?: readonly Band[];
  /** Build an engine for a parameter set and seed (default: the toy). */
  engine?: (params: Record<string, number>, seed: number) => EvoEngine;
  sampleS?: number;
  log?: (m: string) => void;
}

export interface Evaluation { params: Record<string, number>; score: number; perSeed: number[]; metrics: Record<string, number>[] }
export interface TuneResult {
  screening: MorrisResult[];
  selected: string[];
  cma: { generation: number; best: number; sigma: number }[];
  best: Evaluation;
  evaluations: number;
  bands: readonly Band[];
}

export function evaluate(params: Record<string, number>, o: TuneOptions): Evaluation {
  const bands = o.bands ?? TOY_BANDS;
  const make = o.engine ?? ((p, seed) => new ToyEngine({ seed, preset: o.preset, params: p }));
  const perSeed: number[] = [];
  const metrics: Record<string, number>[] = [];
  for (let k = 0; k < o.seeds; k++) {
    const e = make(params, o.seed * 1000 + k + 1);
    const res = runLab(e, { hours: o.hours, sampleS: o.sampleS ?? 120, stopOnExtinction: true });
    const m = runMetrics(res.rows, Math.min(1, o.hours * 0.25));
    metrics.push(m);
    perSeed.push(score(m, bands).score);
  }
  return { params, score: robust(perSeed), perSeed, metrics };
}

export function runTuning(o: TuneOptions): TuneResult {
  const space = o.space ?? TOY_SPACE;
  const log = o.log ?? ((): void => {});
  const d = new RngStreams(o.seed >>> 0, 0).draw(TUNE_STREAM, 0, 0);
  const rand = (): number => d.u01x53();
  const normal = (): number => d.normal();
  let evals = 0;
  const defaults = Object.fromEntries(space.map((p) => [p.name, p.default]));
  // 1. Morris screening on the full space
  log(`morris: ${space.length} parameters, r=${o.morrisR}, ${o.morrisR * (space.length + 1)} evaluations`);
  const screening = morris(space.map((p) => p.name), (u) => {
    evals++;
    const s = evaluate(decode(space, u), o).score;
    return s;
  }, o.morrisR, 4, rand);
  const ranked = screening.slice().sort((a, b) => b.muStar - a.muStar || a.name.localeCompare(b.name));
  const selected = ranked.slice(0, o.top).map((r) => r.name);
  log(`morris top ${o.top}: ${ranked.slice(0, o.top).map((r) => `${r.name} (mu* ${r.muStar.toFixed(3)})`).join(', ')}`);
  // 2. CMA-ES over the selected parameters, others at defaults
  const sub = selected.map((n) => space.find((p) => p.name === n)!);
  const cma = new CmaEs({ mean: sub.map((p) => toUnit(p, p.default)), sigma: 0.25, lambda: o.cmaPopulation }, normal);
  const hist: TuneResult['cma'] = [];
  let best: Evaluation = evaluate(defaults, o);
  evals++;
  for (let g = 0; g < o.cmaGenerations; g++) {
    const xs = cma.ask();
    const fs = xs.map((x) => {
      evals++;
      const p = { ...defaults, ...decode(sub, x) };
      const ev = evaluate(p, o);
      if (ev.score > best.score) best = ev;
      return -ev.score;
    });
    cma.tell(xs, fs);
    hist.push({ generation: g + 1, best: best.score, sigma: cma.sigma });
    log(`cma gen ${g + 1}: best ${best.score.toFixed(3)} sigma ${cma.sigma.toFixed(3)}`);
  }
  return { screening, selected, cma: hist, best, evaluations: evals, bands: o.bands ?? TOY_BANDS };
}
