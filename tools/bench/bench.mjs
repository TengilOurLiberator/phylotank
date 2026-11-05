#!/usr/bin/env node
// Build and run the deterministic sim benchmark (tools/bench/harness.ts).
//   node tools/bench/bench.mjs [harness args]                 run it
//   node tools/bench/bench.mjs --node=--cpu-prof [args]       pass flags to the child node
//   node tools/bench/bench.mjs --phases [reps]                isolated sense, think and hash (phases.ts)
// Harness args: --scenario=<name> --ticks=N --warm=N --runs=N --json=<file> --expect=<file>
//   --alloc (also measure heap growth per phase) --hash=N (time N full state hashes)
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '.build');
mkdirSync(outDir, { recursive: true });
const entry = process.argv.includes('--phases') ? 'phases' : 'harness';
const outfile = join(outDir, `${entry}.mjs`);
await build({
  entryPoints: [join(here, `${entry}.ts`)], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile, logLevel: 'warning', sourcemap: 'linked',
});
const nodeFlags = [];
const args = [];
for (const a of process.argv.slice(2)) {
  if (a === '--phases') continue;
  if (a.startsWith('--node=')) nodeFlags.push(...a.slice(7).split(' ').filter(Boolean));
  else args.push(a);
}
const r = spawnSync(process.execPath, ['--expose-gc', ...nodeFlags, outfile, ...args], { stdio: 'inherit' });
process.exit(r.status ?? 1);
