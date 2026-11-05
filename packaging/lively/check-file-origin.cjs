// Spike 4 (desk part): what a page loaded from file:// can do in headless Chromium, as a proxy
// for a Lively web wallpaper. Lively's own WebView2 may behave differently (it may map the
// folder to a virtual host, or set --allow-file-access-from-files); this only tells us what
// plain Chromium does, so the loader can be written to survive both.
//
//   npm run build && NODE_PATH=$(npm root -g) node packaging/lively/check-file-origin.cjs
//
// Prints one JSON line per case. Needs Playwright (installed globally) and dist/.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const dist = path.join(root, 'dist');
const PORT = Number(process.env.PT_PORT || 47615);

async function stats(frame) {
  return frame.evaluate(() => {
    const s = window.__phylotank;
    return s ? { link: s.link, glOk: s.glOk, dustFrames: s.renderer.dustFrames, rendered: s.renderer.rendered } : null;
  });
}

async function run(browser, name, url, inspect) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  const t0 = Date.now();
  await page.goto(url);
  const result = await inspect(page);
  console.log(JSON.stringify({ case: name, ms: Date.now() - t0, ...result, errors: errors.slice(0, 3) }));
  await page.close();
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-lively-'));
  // a copy of the views plus the blob-worker shim, as the Lively zip ships it
  const tank = path.join(tmp, 'tank');
  fs.cpSync(dist, tank, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'worker-shim.js'), path.join(tank, 'worker-shim.js'));
  const src = fs.readFileSync(path.join(dist, 'sim-worker.js'), 'utf8');
  fs.writeFileSync(path.join(tank, 'sim-worker-inline.js'), `window.__ptWorkerSource=${JSON.stringify(src)};\n`);
  const shimmed = fs.readFileSync(path.join(dist, 'wallpaper.html'), 'utf8')
    .replace("worker-src 'self'", "worker-src 'self' blob:")
    .replace('<script src="app.js"></script>', '<script src="sim-worker-inline.js"></script>\n<script src="worker-shim.js"></script>\n<script src="app.js"></script>');
  fs.writeFileSync(path.join(tank, 'wallpaper-shim.html'), shimmed);
  const probe = `<!doctype html><script>
    window.probe = async (u) => { const t = Date.now(); try { const c = new AbortController(); setTimeout(() => c.abort(), 1500);
      await fetch(u, { mode: 'no-cors', cache: 'no-store', signal: c.signal }); return { ok: true, ms: Date.now() - t }; }
      catch (e) { return { ok: false, ms: Date.now() - t, err: String(e).slice(0, 80) }; } };
  </script><iframe id="f" style="width:900px;height:500px;border:0"></iframe>`;
  fs.writeFileSync(path.join(tmp, 'loader.html'), probe);
  const file = (p) => 'file://' + p.split(path.sep).join('/');

  const browser = await chromium.launch();
  const wait = (page) => page.waitForTimeout(3000);
  try {
    await run(browser, 'file: wallpaper.html, plain worker', file(path.join(tank, 'wallpaper.html')), async (p) => { await wait(p); return { stats: await stats(p) }; });
    await run(browser, 'file: wallpaper.html, blob-worker shim', file(path.join(tank, 'wallpaper-shim.html')), async (p) => { await wait(p); return { stats: await stats(p) }; });
    await run(browser, 'file: probe host while down', file(path.join(tmp, 'loader.html')), async (p) => ({ probe: await p.evaluate((u) => window.probe(u), `http://127.0.0.1:${PORT}/health`) }));

    const host = spawn(process.execPath, [path.join(dist, 'host.mjs'), '--port', String(PORT)], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1200));
    try {
      await run(browser, 'file: probe host while up', file(path.join(tmp, 'loader.html')), async (p) => ({ probe: await p.evaluate((u) => window.probe(u), `http://127.0.0.1:${PORT}/health`) }));
      await run(browser, 'file: iframe of host wallpaper.html', file(path.join(tmp, 'loader.html')), async (p) => {
        await p.evaluate((u) => { document.getElementById('f').src = u; }, `http://127.0.0.1:${PORT}/wallpaper.html?lively=1`);
        await wait(p);
        const child = p.frames().find((f) => f.url().startsWith('http://'));
        return { stats: child ? await stats(child) : 'no frame' };
      });
      await run(browser, 'file: iframe of local tank (shim)', file(path.join(tmp, 'loader.html')), async (p) => {
        await p.evaluate((u) => { document.getElementById('f').src = u; }, file(path.join(tank, 'wallpaper-shim.html')));
        await wait(p);
        const child = p.frames().find((f) => f.url().includes('wallpaper-shim'));
        return { stats: child ? await stats(child).catch((e) => String(e).slice(0, 80)) : 'no frame' };
      });
    } finally { host.kill(); }
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
