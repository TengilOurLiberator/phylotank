#!/usr/bin/env node
// Bundle and run a TypeScript integration script: node tools/integration/run.mjs <script.ts> [args]
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '.build'); mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, `run-${process.pid}.mjs`);
await build({ entryPoints: [resolve(process.argv[2])], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile, logLevel: 'warning', sourcemap: 'inline' });
process.argv.splice(2, 1);
try { await import(pathToFileURL(outfile).href); } finally { rmSync(outfile, { force: true }); }
