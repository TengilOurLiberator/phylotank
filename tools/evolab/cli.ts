/**
 * evolab: the headless evolution laboratory.
 *
 *   node tools/evolab/evolab.mjs run   [--engine toy|sim] [--preset P] [--seed N] [--hours H] [--sample S]
 *                                      [--out DIR] [--param k=v ...] [--params file.json] [--no-png]
 *                                      [--cap-tax additive|multiplicative] [--free-immortality]
 *                                      [--thrust-bug X] [--leak Q] [--m-target-kg KG] [--dt S] [--quiet]
 *   node tools/evolab/evolab.mjs tune  [--engine toy] [--preset P] [--hours H] [--seeds 2] [--out DIR]
 *                                      [--morris-r 4] [--top 4] [--cma-gens 6] [--cma-pop 8]
 *   node tools/evolab/evolab.mjs help
 *
 * Output: series.csv, species.csv, summary.json and PNG charts in --out (default runs/<engine>-<seed>).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SimCoreEngine } from './adapters/simcore.js';
import type { EvoEngine } from './engine.js';
import { runLab, writeOutputs } from './lab.js';
import { ToyEngine } from './toy/engine.js';
import type { ToyParams } from './toy/world.js';
import { runTuning } from './tune/harness.js';

export interface CliArgs { cmd: string; flags: Record<string, string | true>; params: Record<string, number> }

export function parseArgs(argv: string[]): CliArgs {
  const [cmd = 'help', ...rest] = argv;
  const flags: Record<string, string | true> = {};
  const params: Record<string, number> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    const next = rest[i + 1];
    const val: string | true = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
    if (key === 'param') {
      if (val === true) throw new Error('--param needs k=v');
      const [k, v] = val.split('=');
      if (!k || v === undefined || !Number.isFinite(Number(v))) throw new Error(`bad --param ${val}`);
      params[k] = Number(v);
    } else flags[key] = val;
  }
  return { cmd, flags, params };
}

function num(f: Record<string, string | true>, k: string, d: number): number {
  const v = f[k];
  if (v === undefined) return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${k} needs a number`);
  return n;
}

export function makeEngine(a: CliArgs): EvoEngine {
  const f = a.flags;
  const engine = (f.engine as string) ?? 'toy';
  const seed = num(f, 'seed', 1);
  let params: Record<string, number> = { ...a.params };
  if (typeof f.params === 'string') params = { ...JSON.parse(readFileSync(f.params, 'utf8')), ...params };
  if (engine === 'toy') {
    return new ToyEngine({
      seed, preset: (f.preset as string) ?? 'small',
      ...(f.dt !== undefined ? { dtS: num(f, 'dt', 0.5) } : {}),
      params: params as Partial<ToyParams>,
      capTax: f['cap-tax'] === 'multiplicative' ? 'multiplicative' : 'additive',
      freeImmortality: f['free-immortality'] === true,
      thrustBug: num(f, 'thrust-bug', 0),
      leakQPerStep: num(f, 'leak', 0),
      ...(f['species-theta'] !== undefined ? { speciesTheta: num(f, 'species-theta', 0.12) } : {}),
      ...(f['m-target-kg'] !== undefined ? { presetOverride: { mTargetKg: num(f, 'm-target-kg', 1) } } : {}),
    });
  }
  if (engine === 'sim') {
    const config: Record<string, number> = { ...params };
    if (f['m-target-kg'] !== undefined) config.mTargetKg = num(f, 'm-target-kg', 0);
    if (f['agent-cap'] !== undefined) config.agentCap = num(f, 'agent-cap', 0);
    if (f.motes !== undefined) config.skeletonMotes = num(f, 'motes', 0);
    return new SimCoreEngine({ seed, preset: ((f.preset as string) ?? 'small') as 'small', config });
  }
  throw new Error(`unknown engine ${engine} (toy or sim)`);
}

export function main(argv: string[]): number {
  const a = parseArgs(argv);
  const f = a.flags;
  if (a.cmd === 'help' || f.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (a.cmd === 'run') {
    const e = makeEngine(a);
    const hours = num(f, 'hours', 1);
    const sampleS = num(f, 'sample', 60);
    const out = (f.out as string) ?? join('tools', 'evolab', 'runs', `${e.name}-${num(f, 'seed', 1)}`);
    const quiet = f.quiet === true;
    let lastPrint = -1;
    const res = runLab(e, {
      hours, sampleS, stopOnExtinction: f['keep-going'] !== true,
      onSample: (r) => {
        if (quiet) return;
        const h = Math.floor(r.tH!);
        if (h !== lastPrint) {
          lastPrint = h;
          process.stdout.write(`t=${r.tH!.toFixed(2)}h pop=${r.pop} species=${r.species} vmax=${(r.vMaxMean ?? NaN).toFixed(4)} len=${r.lengthMedianMm!.toFixed(2)}mm gen=${(r.genMean ?? NaN).toFixed(1)} ledger=${r.ledgerOk ? 'exact' : 'FAIL'}\n`);
        }
      },
    });
    const files = writeOutputs(out, res, f['no-png'] !== true);
    const s = res.summary as { wallSeconds: number; speedup: number; detectors: Record<string, { fired: boolean; available: boolean }> };
    process.stdout.write(`done: ${files.length} files in ${out}; wall ${s.wallSeconds.toFixed(1)} s (${s.speedup.toFixed(0)}x)\n`);
    for (const [k, v] of Object.entries(s.detectors)) process.stdout.write(`  ${k}: ${v.available ? (v.fired ? 'FIRED' : 'clear') : 'n/a'}\n`);
    return 0;
  }
  if (a.cmd === 'tune') {
    const out = (f.out as string) ?? join('tools', 'evolab', 'runs', 'tune');
    mkdirSync(out, { recursive: true });
    const res = runTuning({
      preset: (f.preset as string) ?? 'tiny',
      hours: num(f, 'hours', 2),
      seeds: num(f, 'seeds', 2),
      morrisR: num(f, 'morris-r', 4),
      top: num(f, 'top', 4),
      cmaGenerations: num(f, 'cma-gens', 6),
      cmaPopulation: num(f, 'cma-pop', 8),
      seed: num(f, 'seed', 1),
      log: (m) => process.stdout.write(m + '\n'),
    });
    writeFileSync(join(out, 'tuning.json'), JSON.stringify(res, null, 2) + '\n');
    process.stdout.write(`best score ${res.best.score.toFixed(3)}; wrote ${join(out, 'tuning.json')}\n`);
    return 0;
  }
  throw new Error(`unknown command ${a.cmd}\n${USAGE}`);
}

const USAGE = `evolab: headless evolution laboratory
  run   run a world fast-forward and write series.csv, species.csv, summary.json and PNG charts
        --engine toy|sim  --preset tiny|small|medium (toy) or small|default|large (sim)
        --seed N  --hours H  --sample S (sim seconds between samples)  --out DIR  --no-png
        --param name=value (repeatable)  --params file.json
        toy only: --cap-tax additive|multiplicative  --free-immortality  --thrust-bug X  --leak Q
                  --m-target-kg KG  --dt S  --species-theta T
        sim only: --agent-cap N  --motes N (phase-0 skeleton)  --m-target-kg KG
  tune  Morris screening, then CMA-ES on the most influential parameters, scored against bands
        --preset P  --hours H  --seeds N  --morris-r R  --top K  --cma-gens G  --cma-pop P
`;
