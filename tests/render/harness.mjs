// Render test harness: bundles src/render/testpage.ts with web/render-test.html into
// tests/artifacts/render-page/, serves it, and drives headless Chromium (SwiftShader WebGL2).
//   node tests/render/harness.mjs                 screenshots of every scene into tests/artifacts/render-*.png
//   node tests/render/harness.mjs lineup-deep     one scene
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const artifacts = path.join(root, 'tests', 'artifacts');
const pageDir = path.join(artifacts, 'render-page');

export function loadPlaywright() {
  const req = createRequire(import.meta.url);
  for (const p of ['playwright', '/opt/node-tools/node_modules/playwright', ...(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'playwright'))]) {
    try { return req(p); } catch { /* try the next */ }
  }
  return null;
}

export async function buildPage() {
  fs.mkdirSync(pageDir, { recursive: true });
  fs.copyFileSync(path.join(root, 'web', 'render-test.html'), path.join(pageDir, 'render-test.html'));
  await build({
    entryPoints: [path.join(root, 'src', 'render', 'testpage.ts')], outfile: path.join(pageDir, 'render-test.js'),
    bundle: true, platform: 'browser', format: 'iife', target: ['es2022'], logLevel: 'warning', sourcemap: false,
  });
}

export function serve(dir = pageDir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const name = (req.url || '/').split('?')[0];
      const file = path.join(dir, path.normalize(name).replace(/^([/\\])+/, ''));
      if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Open the page; returns { browser, page, close }. */
export async function openPage(width = 1280, height = 720) {
  const pw = loadPlaywright();
  if (!pw) throw new Error('playwright not found');
  await buildPage();
  const server = await serve();
  const browser = await pw.chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/render-test.html`);
  await page.waitForFunction(() => window.__renderTestReady === true);
  return { browser, page, errors, close: async () => { await browser.close(); server.close(); } };
}

export async function shoot(page, scene, opts = {}) {
  const stats = await page.evaluate(([s, o]) => window.renderScene(s, o), [scene, opts]);
  const canvas = await page.$('canvas');
  const png = await canvas.screenshot();
  return { stats, png };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const only = process.argv.slice(2);
  const { page, errors, close } = await openPage();
  try {
    const scenes = only.length ? only : await page.evaluate(() => window.SCENES);
    for (const s of scenes) {
      const t0 = Date.now();
      const { stats, png } = await shoot(page, s, { t: 3, w: 960, h: 540 });
      fs.writeFileSync(path.join(artifacts, `render-${s}.png`), png);
      console.log(s, `${Date.now() - t0} ms`, JSON.stringify({ tiers: stats.tiers, inst: stats.instances, caps: stats.capsules, sprites: stats.sprites, exp: stats.exposure.toFixed(3), lum: stats.meanLum.toFixed(4), err: stats.error }));
    }
    if (errors.length) console.log('page errors:', errors.join('\n'));
  } finally { await close(); }
}
