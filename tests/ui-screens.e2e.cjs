// UI screenshots and browser checks for src/ui (run after `node scripts/build.mjs`):
//   node tests/ui-screens.e2e.cjs
// Serves dist/, drives the god window against the in-page mock sim, and writes
// tests/artifacts/ui-*.png. Also checks: the wallpaper DOM has no text (UX-T30), every page
// boots without errors, captions appear in the screensaver and TV, a release reaches the tank.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'tests', 'artifacts');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' };
const only = process.argv[2] || '';

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
  fs.mkdirSync(out, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const failures = [];
  const shot = async (page, name) => { await page.screenshot({ path: path.join(out, `ui-${name}.png`) }); console.log('wrote', `ui-${name}.png`); };
  const want = (n) => !only || only.split(',').includes(n);
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${base}/god.html?lang=en`);
    await page.waitForTimeout(2500);
    if (want('god')) await shot(page, 'god');
    // select a creature: click near the densest spot by asking the app for a creature position
    const pos = await page.evaluate(() => {
      const g = window.__phylotankGod; const d = g.client.dust; if (!d) return null;
      for (const [slot, info] of g.client.slots) { if (slot < d.n && d.colour[slot] !== 255) { const p = g.client.positionOf(info.id); if (p) return g.worldToScreen(p[0], p[1]); } }
      return null;
    });
    if (pos) { await page.mouse.click(pos[0], pos[1]); await page.waitForTimeout(1500); }
    if (want('inspector')) {
      await page.getByRole('tab', { name: 'Brain' }).waitFor({ timeout: 8000 }).catch(() => failures.push('inspector did not open for the clicked creature'));
      await page.getByRole('tab', { name: 'Brain' }).click().catch(() => {});
      await page.waitForTimeout(800);
      await shot(page, 'inspector-brain');
      await page.getByRole('tab', { name: 'Kin' }).click().catch(() => {});
      await page.waitForTimeout(300);
      await shot(page, 'inspector-kin');
    }
    // powers: meteor with hold-to-confirm
    await page.keyboard.press('Escape');
    await page.keyboard.press('p');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /Meteor impact/ }).click();
    await page.mouse.move(1000, 420);
    await page.mouse.click(1000, 420);
    await page.waitForTimeout(700);
    if (want('powers')) await shot(page, 'powers');
    const hold = page.getByRole('button', { name: 'Hold to confirm' });
    const box = await hold.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(700);
      if (want('powers')) await shot(page, 'powers-hold');
      await page.waitForTimeout(700);
      await page.mouse.up();
      await page.waitForTimeout(250);
      if (want('powers')) await shot(page, 'powers-countdown');
      let snaps = [];
      for (let i = 0; i < 10 && !snaps.includes('beforePower'); i++) { await page.waitForTimeout(400); snaps = await page.evaluate(() => window.__phylotankGod.client.snapshots.map((s) => s.kind)); }
      if (!snaps.includes('beforePower')) failures.push(`major power did not create a beforePower snapshot: ${snaps}`);
      await page.waitForTimeout(3000);
    } else failures.push('no hold button for a major power');
    // stats
    await page.keyboard.press('s');
    await page.waitForTimeout(900);
    if (want('stats')) await shot(page, 'stats-population');
    await page.getByRole('tab', { name: 'Family tree of species' }).click();
    await page.waitForTimeout(900);
    if (want('stats')) await shot(page, 'stats-phylogeny');
    await page.getByRole('tab', { name: 'Genes' }).click();
    await page.waitForTimeout(900);
    if (want('stats')) await shot(page, 'stats-genes');
    await page.getByRole('tab', { name: 'Diversity index' }).click();
    await page.waitForTimeout(900);
    if (want('stats')) await shot(page, 'stats-diversity');
    // bookmarks
    await page.keyboard.press('b');
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+b');
    await page.waitForTimeout(800);
    if (want('bookmarks')) await shot(page, 'bookmarks');
    // map
    await page.keyboard.press('m');
    await page.waitForTimeout(700);
    if (want('map')) await shot(page, 'map');
    // designer
    await page.keyboard.press('d');
    await page.waitForTimeout(900);
    if (want('designer')) await shot(page, 'designer-genes');
    await page.getByRole('button', { name: 'Diet', exact: true }).click();
    await page.waitForTimeout(400);
    const tri = await page.locator('canvas[aria-label^="Diet triangle"]').boundingBox();
    if (tri) { await page.mouse.move(tri.x + tri.width * 0.35, tri.y + tri.height * 0.6); await page.mouse.down(); await page.mouse.move(tri.x + tri.width * 0.3, tri.y + tri.height * 0.7, { steps: 4 }); await page.mouse.up(); await page.waitForTimeout(500); }
    else failures.push('no diet triangle');
    if (want('designer')) await shot(page, 'designer-diet');
    await page.getByRole('tab', { name: 'Parts' }).click();
    await page.waitForTimeout(600);
    const sk = await page.locator('canvas[aria-label="Skeleton editor"]').boundingBox();
    if (sk) { await page.mouse.click(sk.x + sk.width * 0.55, sk.y + sk.height * 0.5); await page.waitForTimeout(500); }
    if (want('designer')) await shot(page, 'designer-parts');
    // template switch and release
    await page.getByRole('combobox', { name: 'Template' }).selectOption('deepcrown');
    await page.waitForTimeout(500);
    await page.getByRole('tab', { name: 'Genes' }).click();
    await page.waitForTimeout(500);
    if (want('designer')) await shot(page, 'designer-deepcrown');
    const before = await page.evaluate(() => window.__phylotankGod.client.species.length);
    await page.getByRole('button', { name: 'Release as leviathan' }).click();
    await page.waitForTimeout(300);
    if (want('release')) await shot(page, 'release-leviathan');
    await page.getByRole('button', { name: 'Confirm without holding' }).click();
    let after = 0;
    for (let i = 0; i < 15 && after === 0; i++) { await page.waitForTimeout(400); after = await page.evaluate(() => window.__phylotankGod.client.species.filter((s) => s.leviathan).length); }
    if (!(after >= 1)) failures.push(`leviathan release did not reach the world (species ${before} -> leviathans ${after}; toast: ${await page.locator('.pt-toast').first().innerText().catch(() => '-')})`);
    // share dialog with QR
    await page.getByRole('combobox', { name: 'Template' }).selectOption('meadowlamp');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await page.waitForTimeout(500);
    if (want('share')) await shot(page, 'share');
    const ptk = await page.locator('.pt-dialog textarea').inputValue();
    if (!ptk.startsWith('PTK1.')) failures.push('share dialog has no PTK1 string');
    await page.keyboard.press('Escape');
    // library and import round trip
    await page.keyboard.press('l');
    await page.waitForTimeout(600);
    if (want('library')) await shot(page, 'library');
    await page.getByRole('textbox', { name: 'Paste a PTK1 string' }).fill(ptk);
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.waitForTimeout(600);
    const opened = await page.evaluate(() => window.__phylotankGod.designer.genome.length);
    if (!(opened > 100)) failures.push('import did not open the designer');
    if (errors.length) failures.push(`god errors: ${errors.join(' | ')}`);
    await page.close();

    // Swedish, small window
    if (want('sv')) {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const errs = [];
      p.on('pageerror', (e) => errs.push(String(e)));
      await p.goto(`${base}/god.html?lang=sv`);
      await p.waitForTimeout(2000);
      await p.keyboard.press('p');
      await p.waitForTimeout(300);
      await shot(p, 'god-sv');
      await p.keyboard.press('d');
      await p.waitForTimeout(600);
      await shot(p, 'designer-sv');
      if (errs.length) failures.push(`sv errors: ${errs.join(' | ')}`);
      await p.close();
    }

    // captions in screensaver and TV (mock sim gives events)
    for (const mode of ['screensaver', 'tv']) {
      if (!want(mode) && only) continue;
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const errs = [];
      p.on('pageerror', (e) => errs.push(String(e)));
      await p.goto(`${base}/${mode}.html?sim=mock&lang=en`);
      let n = 0;
      for (let i = 0; i < 20 && n === 0; i++) { await p.waitForTimeout(500); n = await p.evaluate(() => (window.__phylotank.captions || []).length); }
      await p.waitForTimeout(1600);
      await shot(p, mode);
      if (n === 0) failures.push(`${mode}: no caption within 10 s`);
      if (errs.length) failures.push(`${mode} errors: ${errs.join(' | ')}`);
      await p.close();
    }
    // the Lively wallpaper page tries the host, then dreams after 2 s (no host is running here)
    {
      const p = await browser.newPage({ viewport: { width: 640, height: 360 } });
      await p.goto(`${base}/wallpaper.html`);
      let s = null;
      for (let i = 0; i < 20; i++) { await p.waitForTimeout(500); s = await p.evaluate(() => ({ link: window.__phylotank.link, dust: window.__phylotank.renderer.dustFrames })); if (s.link === 'worker' && s.dust > 0) break; }
      if (!s || s.link !== 'worker' || !(s.dust > 0)) failures.push(`wallpaper did not fall back to the dream tank: ${JSON.stringify(s)}`);
      await p.close();
    }
    // wallpaper has no text, even with the mock sim
    {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await p.goto(`${base}/wallpaper.html?sim=mock`);
      await p.waitForTimeout(1500);
      const text = await p.evaluate(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let s = ''; while (w.nextNode()) s += w.currentNode.textContent; return s.trim(); });
      if (text.length) failures.push(`wallpaper has text: ${JSON.stringify(text.slice(0, 80))}`);
      if (want('wallpaper')) await shot(p, 'wallpaper');
      await p.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (failures.length) { console.error('UI E2E FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
  console.log('UI E2E OK');
})().catch((e) => { console.error(e); process.exit(1); });
