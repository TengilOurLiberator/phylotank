/**
 * 06 §6.8.1 visual snapshot tests: render synthetic scenes of every archetype in headless
 * Chromium (SwiftShader WebGL2) and compare against goldens in tests/render-goldens/ with SSIM
 * >= 0.98. A missing golden (or UPDATE_GOLDENS=1) writes a new one. Also runs the flash
 * analyser on a rendered wallpaper sequence (v0.1 acceptance 6, in miniature). Skipped when
 * Playwright is not installed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { worstFlashesPerSecond } from '../src/render/safety.js';

const root = path.join(__dirname, '..');
const goldens = path.join(root, 'tests', 'render-goldens');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let harness: Any = null;
try {
  harness = await import('./render/harness.mjs' as string);
  if (!harness.loadPlaywright()) harness = null;
} catch { harness = null; }

const SCENES = [
  { name: 'lineup-deep', t: 2, mode: 'screensaver' },
  { name: 'lineup-shallow', t: 2, mode: 'screensaver' },
  { name: 'tank-whole', t: 2, mode: 'wallpaper' },
  { name: 'tank-close', t: 2, mode: 'god' },
];
const W = 384, H = 216;

/** SSIM over luminance in 8 x 8 windows, computed in the page from two PNG data URLs. */
const SSIM_SRC = `async (a, b) => {
  const load = (src) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = src; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const px = (im) => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, im.width, im.height); };
  const A = px(ia), B = px(ib);
  if (A.width !== B.width || A.height !== B.height) return 0;
  const w = A.width, h = A.height, L = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let sum = 0, n = 0;
  for (let y = 0; y + 8 <= h; y += 4) for (let x = 0; x + 8 <= w; x += 4) {
    let ma = 0, mb = 0, va = 0, vb = 0, cov = 0;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const k = ((y + j) * w + x + i) * 4; ma += L(A.data, k); mb += L(B.data, k); }
    ma /= 64; mb /= 64;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const k = ((y + j) * w + x + i) * 4; const da = L(A.data, k) - ma, db = L(B.data, k) - mb; va += da * da; vb += db * db; cov += da * db; }
    va /= 63; vb /= 63; cov /= 63;
    sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2)); n++;
  }
  return sum / n;
}`;

describe.skipIf(!harness)('render pixel snapshots (headless Chromium, SwiftShader)', () => {
  let ctx: Any;
  beforeAll(async () => { ctx = await harness.openPage(W, H); }, 120_000);
  afterAll(async () => { await ctx?.close(); });

  for (const sc of SCENES) {
    it(`${sc.name} matches its golden (SSIM >= 0.98)`, async () => {
      const { stats, png } = await harness.shoot(ctx.page, sc.name, { t: sc.t, w: W, h: H, mode: sc.mode, warm: 0.6 });
      expect(stats.error).toBe('');
      expect(stats.rendered).toBeGreaterThan(5);
      fs.mkdirSync(path.join(root, 'tests', 'artifacts'), { recursive: true });
      fs.writeFileSync(path.join(root, 'tests', 'artifacts', `render-snap-${sc.name}.png`), png);
      const gold = path.join(goldens, `${sc.name}.png`);
      if (process.env.UPDATE_GOLDENS === '1' || !fs.existsSync(gold)) {
        fs.mkdirSync(goldens, { recursive: true });
        fs.writeFileSync(gold, png);
        console.warn(`wrote golden ${gold}`);
        return;
      }
      const url = (b: Buffer): string => `data:image/png;base64,${b.toString('base64')}`;
      const ssim = await ctx.page.evaluate(`(${SSIM_SRC})(${JSON.stringify(url(png))}, ${JSON.stringify(url(fs.readFileSync(gold)))})`);
      expect(ssim).toBeGreaterThanOrEqual(0.98);
    }, 240_000);
  }

  it('the picture is never black and never clipped flat (OLED-safe floor, dither present)', async () => {
    const r = await ctx.page.evaluate(() => {
      window.renderScene('tank-whole', { t: 1, w: 384, h: 216, mode: 'wallpaper', warm: 0.3 } as never);
      const c = document.querySelector('canvas')!;
      const gl = c.getContext('webgl2')!;
      const px = new Uint8Array(c.width * c.height * 4);
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let black = 0; const levels = new Set<number>();
      for (let i = 0; i < px.length; i += 4) { if (px[i]! + px[i + 1]! + px[i + 2]! === 0) black++; levels.add(px[i + 2]!); }
      return { black, levels: levels.size, n: px.length / 4 };
    });
    expect(r.black / r.n).toBeLessThan(0.01);
    expect(r.levels).toBeGreaterThan(4);
  }, 240_000);

  it('the wallpaper is capped at 30 fps and the screensaver at 60 on a 144 Hz display', async () => {
    const w = await ctx.page.evaluate(() => window.capTest('wallpaper', 144, 2));
    expect(w.rendered).toBeGreaterThanOrEqual(56);
    expect(w.rendered).toBeLessThanOrEqual(62);
    const s = await ctx.page.evaluate(() => window.capTest('screensaver', 144, 2));
    expect(s.rendered).toBeGreaterThanOrEqual(110);
    expect(s.rendered).toBeLessThanOrEqual(122);
  }, 240_000);

  it('wallpaper: a rendered sequence with a red lure has no flashes above the profile rate', async () => {
    const rec = await ctx.page.evaluate(() => window.recordLuma('lineup-deep', { mode: 'wallpaper', seconds: 6, w: 128, h: 72 } as never));
    let worst = 0;
    for (const reg of rec.regions) worst = Math.max(worst, worstFlashesPerSecond(reg, rec.fps));
    expect(worst).toBeLessThanOrEqual(1);
  }, 240_000);
});
