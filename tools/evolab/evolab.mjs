#!/usr/bin/env node
// Launcher: bundle tools/evolab/cli.ts with esbuild (already a dev dependency) and run it.
// Usage: node tools/evolab/evolab.mjs <run|tune|help> [flags]
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '.build');
mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, `cli-${process.pid}.mjs`); // per process: runs may start in parallel
await build({
  entryPoints: [join(here, 'entry.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile, logLevel: 'warning', sourcemap: 'inline',
});
const { main } = await import(pathToFileURL(outfile).href);
rmSync(outfile, { force: true });
process.exitCode = main(process.argv.slice(2));
