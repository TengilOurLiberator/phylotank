// Spike 6 (wallpaper calm recording): renders scenes in headless Chromium and scores
// luminance change per second, the fraction of the screen changing more than 5% per second,
// mean emissive brightness, and WCAG-style flashes. Usage: node tests/render/calm.mjs [seconds]
import { build } from 'esbuild';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifacts, openPage } from './harness.mjs';

const seconds = Number(process.argv[2] || 30);
const { page, close } = await openPage(256, 144);
const safetyOut = path.join(artifacts, 'render-page', 'safety.mjs');
await build({ entryPoints: [path.join(artifacts, '..', '..', 'src', 'render', 'safety.ts')], bundle: true, format: 'esm', platform: 'node', outfile: safetyOut, logLevel: 'warning' });
const { worstFlashesPerSecond } = await import(pathToFileURL(safetyOut).href);
const runs = [
  { name: 'tank-mid', mode: 'wallpaper', noisyGlow: false, unsafe: false },
  { name: 'tank-mid', mode: 'wallpaper', noisyGlow: true, unsafe: false },
  { name: 'tank-mid', mode: 'wallpaper', noisyGlow: true, unsafe: true },
  { name: 'lineup-deep', mode: 'wallpaper', noisyGlow: true, unsafe: false },
  { name: 'lineup-deep', mode: 'wallpaper', noisyGlow: true, unsafe: true },
  { name: 'lineup-deep', mode: 'screensaver', noisyGlow: true, unsafe: false },
];
try {
  for (const r of runs) {
    const t0 = Date.now();
    const rec = await page.evaluate((o) => window.recordCalm(o.name, { ...o, seconds: o.seconds }), { ...r, seconds });
    const perSec = Math.round(1 / rec.step);
    const sec = rec.mean.filter((_, i) => i % perSec === 0);
    const dl = [];
    for (let i = 1; i < sec.length; i++) dl.push(Math.abs(sec[i] - sec[i - 1]) / Math.max(1e-6, sec[i - 1]));
    let changing = 0, cells = 0;
    for (let i = 1; i < rec.grids.length; i++) for (let k = 0; k < rec.grids[i].length; k++) {
      const a = rec.grids[i - 1][k], b = rec.grids[i][k];
      cells++;
      if (Math.abs(b - a) / Math.max(1e-4, a) > 0.05) changing++;
    }
    // frame-to-frame relative change of the whole screen, as luminance change per second
    let maxFrameRate = 0;
    for (let i = 1; i < rec.mean.length; i++) maxFrameRate = Math.max(maxFrameRate, Math.abs(rec.mean[i] - rec.mean[i - 1]) / Math.max(1e-6, rec.mean[i - 1]) / rec.step);
    const meanL = rec.mean.reduce((a, b) => a + b, 0) / rec.mean.length;
    const flashes = worstFlashesPerSecond(rec.mean.map((v) => v * 20), perSec); // scaled: the screen-mean in a 1/20 region equivalent
    console.log(JSON.stringify({
      ...r, seconds, step: rec.step,
      lumChangePerS_mean: +(dl.reduce((a, b) => a + b, 0) / dl.length).toFixed(4), lumChangePerS_max: +Math.max(...dl).toFixed(4),
      frameRelChangePerS_max: +maxFrameRate.toFixed(3),
      fracTilesChangingOver5pctPerS: +(changing / cells).toFixed(4), meanDisplayedLum: +meanL.toFixed(5),
      flashesScaledWorst: flashes, safetyTriggers: rec.safetyTriggers, wallMs: Date.now() - t0,
    }));
  }
} finally { await close(); }
