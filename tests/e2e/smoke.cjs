// E2E smoke test: serve dist/, load the dream-tank page in headless Chromium (WebGL2 through
// SwiftShader), wait 3 s, save tests/artifacts/smoke.png and check that frames arrived and
// were drawn. Playwright is installed globally; run with `npm run test:e2e`.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const dist = path.join(root, 'dist');
const artifacts = path.join(root, 'tests', 'artifacts');
const { spawn } = require('node:child_process');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' };

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const name = (req.url || '/').split('?')[0];
      const file = path.join(dist, name === '/' ? 'index.html' : path.normalize(name).replace(/^([/\\])+/, ''));
      if (!file.startsWith(dist) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const failures = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${base}/index.html`);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(artifacts, 'smoke.png') });
    const stats = await page.evaluate(() => window.__phylotank);
    console.log('stats', JSON.stringify(stats));
    if (!stats) failures.push('no window.__phylotank');
    else {
      if (!stats.glOk) failures.push('WebGL2 renderer did not start');
      if (stats.link !== 'worker') failures.push(`expected the worker link, got ${stats.link}`);
      if (!(stats.renderer.dustFrames >= 20)) failures.push(`too few DUST_FRAMEs: ${stats.renderer.dustFrames}`);
      if (!(stats.renderer.rendered >= 30)) failures.push(`too few rendered frames: ${stats.renderer.rendered}`);
      if (!(stats.renderer.live >= 1000)) failures.push(`too few live motes: ${stats.renderer.live}`);
    }
    // the picture must not be black: sample the canvas
    const lit = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      const gl = c.getContext('webgl2');
      const px = new Uint8Array(c.width * c.height * 4);
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let bright = 0;
      for (let i = 0; i < px.length; i += 4) if (Math.max(px[i], px[i + 1], px[i + 2]) > 150) bright++;
      return bright;
    });
    console.log('bright pixels', lit);
    if (lit < 200) failures.push(`too few bright pixels: ${lit}`);
    if (errors.length) failures.push(`page errors: ${errors.join(' | ')}`);
    // every mode page boots without errors
    for (const mode of ['wallpaper', 'screensaver', 'tv', 'god']) {
      const p = await browser.newPage({ viewport: { width: 640, height: 360 } });
      const errs = [];
      p.on('pageerror', (e) => errs.push(String(e)));
      await p.goto(`${base}/${mode}.html`);
      await p.waitForTimeout(800);
      const s = await p.evaluate(() => window.__phylotank);
      if (!s || s.mode !== mode || !s.glOk) failures.push(`${mode}.html did not boot: ${JSON.stringify(s)}`);
      if (errs.length) failures.push(`${mode}.html errors: ${errs.join(' | ')}`);
      await p.close();
    }
    // the same page served by the Node host streams over the WebSocket instead of a worker
    const host = spawn(process.execPath, [path.join(dist, 'host.mjs'), '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      const port = await new Promise((resolve, reject) => {
        host.stdout.on('data', (d) => { const m = /127\.0\.0\.1:(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
        host.on('exit', () => reject(new Error('host exited')));
        setTimeout(() => reject(new Error('host did not start')), 5000);
      });
      const p = await browser.newPage({ viewport: { width: 640, height: 360 } });
      const errs = [];
      p.on('pageerror', (e) => errs.push(String(e)));
      await p.goto(`http://127.0.0.1:${port}/wallpaper.html?host=ws://127.0.0.1:${port}/ws/v1`);
      await p.waitForTimeout(1500);
      const s = await p.evaluate(() => window.__phylotank);
      console.log('host stats', JSON.stringify(s));
      if (!s || s.link !== 'socket' || !(s.renderer.dustFrames >= 5)) failures.push(`host stream did not arrive: ${JSON.stringify(s)}`);
      if (errs.length) failures.push(`host page errors: ${errs.join(' | ')}`);
    } finally {
      host.kill();
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (failures.length) { console.error('E2E FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
  console.log('E2E OK: tests/artifacts/smoke.png');
})().catch((e) => { console.error(e); process.exit(1); });
