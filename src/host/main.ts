/**
 * Host CLI (bundled to dist/host.mjs).
 *   node dist/host.mjs [--port 47615] [--preset small|default|large] [--seed N] [--motes N]
 *   node dist/host.mjs --headless --ticks 3000      run without a server and print the state hash
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_PORT, toHex64, type PresetName, type WorldConfig } from '../core/index.js';
import { sim } from '../sim/index.js';
import { DEFAULT_DREAM_CONFIG } from '../sim/session.js';
import { startHost } from './index.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const seed = Number(arg('seed') ?? DEFAULT_DREAM_CONFIG.seedLo);
const config: WorldConfig = {
  ...DEFAULT_DREAM_CONFIG,
  preset: (arg('preset') ?? 'small') as PresetName,
  seedLo: seed >>> 0,
  skeletonMotes: Number(arg('motes') ?? DEFAULT_DREAM_CONFIG.skeletonMotes),
};

if (process.argv.includes('--headless')) {
  const ticks = Number(arg('ticks') ?? 3000);
  const world = sim.create(config);
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) sim.step(world);
  const ms = performance.now() - t0;
  console.log(JSON.stringify({ ticks, ms: Math.round(ms), ticksPerSec: Math.round((ticks * 1000) / ms), hash: toHex64(sim.hash(world)) }));
} else {
  const staticDir = arg('static') ?? dirname(fileURLToPath(import.meta.url));
  const port = Number(arg('port') ?? HOST_PORT);
  const host = await startHost({ port, staticDir, config });
  console.log(`Phylotank host on http://127.0.0.1:${host.port}/  (wallpaper.html, screensaver.html, tv.html, god.html)`);
  const shutdown = (): void => { void host.stop().then(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
