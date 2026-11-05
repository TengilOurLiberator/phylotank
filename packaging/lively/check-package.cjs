// End-to-end check of the built Lively package in headless Chromium, loaded from file:// as
// Lively loads a local wallpaper (assumed; spike 4 confirms on William's machine).
//   1. host down: the loader falls back to the built-in dream tank within about 2 s, and the
//      tank renders from its blob: worker;
//   2. host started: the loader finds it on its retry schedule and swaps to the host's page,
//      which streams over the WebSocket.
//
//   npm run build && node packaging/lively/build-zip.mjs
//   NODE_PATH=$(npm root -g) node packaging/lively/check-package.cjs
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const folder = path.join(root, 'packaging', 'out', 'lively');
const PORT = Number(process.env.PT_PORT || 47615);
const fileUrl = (p) => 'file://' + p.split(path.sep).join('/');

async function frameStats(page, match) {
  const f = page.frames().find((fr) => match(fr.url()));
  if (!f) return null;
  return f.evaluate(() => {
    const s = window.__phylotank;
    return s ? { link: s.link, glOk: s.glOk, rendered: s.renderer.rendered, dustFrames: s.renderer.dustFrames } : null;
  }).catch(() => null);
}

async function until(page, fn, ms) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { v, ms: Date.now() - t0 };
    if (Date.now() - t0 > ms) return { v: null, ms: Date.now() - t0 };
    await page.waitForTimeout(250);
  }
}

(async () => {
  if (!fs.existsSync(path.join(folder, 'index.html'))) {
    console.error('packaging/out/lively is missing: run node packaging/lively/build-zip.mjs first');
    process.exit(2);
  }
  const failures = [];
  const browser = await chromium.launch();
  let host = null;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(fileUrl(path.join(folder, 'index.html')));

    const local = await until(page, async () => {
      const st = await frameStats(page, (u) => u.includes('/tank/wallpaper.html'));
      return st && st.rendered >= 20 ? st : null;
    }, 8000);
    const loader1 = await page.evaluate(() => window.__phylotankLoader);
    console.log(JSON.stringify({ step: 'host down', loader: loader1, tank: local.v, ms: local.ms }));
    if (!local.v) failures.push('the built-in tank did not render from file://');
    else if (local.v.link !== 'worker') failures.push(`built-in tank link: ${local.v.link}`);
    if (loader1.mounted !== 'local') failures.push(`expected mounted=local, got ${loader1.mounted}`);

    host = spawn(process.execPath, [path.join(root, 'dist', 'host.mjs'), '--port', String(PORT)], { stdio: 'ignore' });
    const swap = await until(page, async () => {
      const l = await page.evaluate(() => window.__phylotankLoader);
      if (l.mounted !== 'host') return null;
      const st = await frameStats(page, (u) => u.startsWith(`http://127.0.0.1:${PORT}/wallpaper.html`));
      return st && st.rendered >= 20 ? st : null;
    }, 20000);
    const loader2 = await page.evaluate(() => window.__phylotankLoader);
    console.log(JSON.stringify({ step: 'host up', loader: loader2, tank: swap.v, ms: swap.ms }));
    if (!swap.v) failures.push('the loader did not swap to the host page');
    else if (swap.v.link !== 'socket') failures.push(`host page link: ${swap.v.link}`);
    if (errors.length) failures.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);
    fs.mkdirSync(path.join(root, 'tests', 'artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'tests', 'artifacts', 'lively.png') });
  } finally {
    if (host) host.kill();
    await browser.close();
  }
  if (failures.length) { console.error('FAIL\n- ' + failures.join('\n- ')); process.exit(1); }
  console.log('Lively package check passed');
})();
