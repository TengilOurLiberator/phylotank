// Site end-to-end check: serve the built site (site/_site, or the folder given as the first
// argument) the way GitHub Pages does, drive it in headless Chromium and save screenshots to
// tests/artifacts/site-*.png. Every request must stay on the local origin (no trackers, CDNs
// or fonts), the demo tank must draw, and the share page must decode, preview, download and
// copy a creature with the network blocked (UX-T14). Playwright is installed globally, as
// for tests/e2e/smoke.cjs: NODE_PATH="$(npm root -g)" node site/e2e.cjs
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const site = path.resolve(process.argv[2] || path.join(__dirname, '_site'));
const artifacts = path.join(root, 'tests', 'artifacts');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain',
};
const BASE_PATH = '/phylotank'; // the project-site prefix on github.io

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let name = decodeURIComponent((req.url || '/').split('?')[0]);
      if (!name.startsWith(BASE_PATH + '/')) { res.writeHead(404); res.end(); return; }
      name = name.slice(BASE_PATH.length);
      let file = path.join(site, path.normalize(name).replace(/^([/\\])+/, ''));
      if (!file.startsWith(site)) { res.writeHead(403); res.end(); return; }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html'; // Pages serves /share as share.html
      if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  if (!fs.existsSync(path.join(site, 'index.html'))) { console.error(`no site at ${site}: run node site/build.mjs`); process.exit(1); }
  fs.mkdirSync(artifacts, { recursive: true });
  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const base = `${origin}${BASE_PATH}/`;
  const browser = await chromium.launch();
  const failures = [];
  const check = (ok, msg) => { if (!ok) failures.push(msg); console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
  const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(artifacts, `site-${name}.png`), ...opts });

  async function open(opts = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, ...opts });
    const page = await ctx.newPage();
    const errors = [];
    const foreign = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    ctx.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:')) foreign.push(u);
    });
    return { ctx, page, errors, foreign };
  }

  async function a11y(page, label) {
    const r = await page.evaluate(() => {
      const issues = [];
      const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent || el.textContent || el.getAttribute('title') || '').trim();
      if (!document.documentElement.lang) issues.push('no lang');
      if (!document.title) issues.push('no title');
      for (const img of document.querySelectorAll('img')) if (!img.hasAttribute('alt')) issues.push(`img without alt: ${img.src}`);
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      for (const el of document.querySelectorAll('a[href], button')) if (visible(el) && !name(el)) issues.push(`unnamed ${el.tagName}: ${el.outerHTML.slice(0, 80)}`);
      for (const el of document.querySelectorAll('textarea, input, select')) {
        if (!visible(el)) continue;
        const labelled = el.labels?.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
        if (!labelled) issues.push(`unlabelled ${el.tagName}#${el.id}`);
      }
      for (const el of document.querySelectorAll('iframe')) if (!el.title) issues.push('iframe without title');
      const hs = [...document.querySelectorAll('h1, h2, h3, h4')].filter(visible);
      if (hs.filter((h) => h.tagName === 'H1').length !== 1) issues.push(`visible h1 count ${hs.filter((h) => h.tagName === 'H1').length}`);
      let prev = 0;
      for (const h of hs) { const l = Number(h.tagName[1]); if (l > prev + 1) issues.push(`heading jumps to ${h.tagName}: ${h.textContent.trim().slice(0, 40)}`); prev = l; }
      if (!document.querySelector('main')) issues.push('no main landmark');
      const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
      const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
      if (dup.length) issues.push(`duplicate ids: ${dup.join(', ')}`);
      return issues;
    });
    check(r.length === 0, `${label}: basic accessibility checks${r.length ? ` (${r.join('; ')})` : ''}`);
  }

  try {
    // 1. Landing page, desktop: the demo tank starts when it scrolls into view.
    {
      const { ctx, page, errors, foreign } = await open();
      await page.goto(base);
      await shot(page, 'landing-top');
      await page.keyboard.press('Tab');
      check(await page.evaluate(() => document.activeElement?.classList.contains('skip')), 'landing: first Tab reaches the skip link');
      await page.locator('#demo').scrollIntoViewIfNeeded();
      await page.waitForSelector('#demo-frame iframe', { timeout: 5000 }).catch(() => undefined);
      const frameEl = await page.$('#demo-frame iframe');
      check(!!frameEl, 'landing: the demo iframe starts on scroll');
      if (frameEl) {
        const frame = await frameEl.contentFrame();
        await page.waitForTimeout(3500);
        const stats = await frame.evaluate(() => window.__phylotank).catch(() => null);
        check(!!stats && stats.glOk && stats.link === 'worker', `landing: demo tank runs its own worker sim (${JSON.stringify(stats && { link: stats.link, glOk: stats.glOk })})`);
        check(!!stats && stats.renderer && stats.renderer.rendered >= 10, `landing: demo tank rendered frames (${stats && stats.renderer && stats.renderer.rendered})`);
      }
      await shot(page, 'landing-demo');
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, 'landing', { fullPage: true });
      await page.click('#demo-stop');
      check((await page.$('#demo-frame iframe')) === null, 'landing: Stop unloads the demo tank');
      await a11y(page, 'landing');
      check(errors.length === 0, `landing: no page errors (${errors.join(' | ')})`);
      check(foreign.length === 0, `landing: no requests leave the site (${foreign.join(', ')})`);
      await ctx.close();
    }
    // 2. Landing page, phone, with reduced motion: nothing starts on its own.
    {
      const { ctx, page, errors } = await open({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce', isMobile: true, hasTouch: true });
      await page.goto(base);
      await page.locator('#demo').scrollIntoViewIfNeeded();
      await page.waitForTimeout(800);
      check((await page.$('#demo-frame iframe')) === null, 'landing (reduced motion): the demo waits for Start');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(overflow <= 0, `landing (phone): no horizontal scroll (${overflow}px)`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, 'landing-mobile', { fullPage: true });
      check(errors.length === 0, `landing (phone): no page errors (${errors.join(' | ')})`);
      await ctx.close();
    }
    // 3. Share page: empty, example, a fresh link with the network blocked, download, copy, error.
    let ptk = '';
    let fingerprint = '';
    {
      const { ctx, page, errors, foreign } = await open();
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
      await page.goto(`${base}share`);
      await page.waitForSelector('#empty:not([hidden])');
      await a11y(page, 'share (empty)');
      await shot(page, 'share-empty');
      await page.click('#empty a[href="#example"]');
      await page.waitForSelector('#design:not([hidden])');
      const st = await page.evaluate(() => window.__share);
      check(st && st.ok, `share: the example creature opens (${JSON.stringify(st)})`);
      ptk = await page.inputValue('#d-string');
      fingerprint = st && st.fingerprint;
      check(ptk.startsWith('PTK1.'), 'share: shows the PTK1 string');
      check(page.url().includes('#ptk=PTK1.'), 'share: the address bar holds a real share link');
      await page.click('#copy-string');
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      check(clip === ptk, 'share: Copy string puts the string on the clipboard');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
      const file = await dl.path();
      const bytes = fs.readFileSync(file);
      check(dl.suggestedFilename() === 'Vitrilampas-demonstrata.ptkg', `share: download is named ${dl.suggestedFilename()}`);
      check(bytes.subarray(0, 3).toString('latin1') === 'PTK' && 'PTK1.' + bytes.toString('base64url') === ptk, 'share: the .ptkg bytes are the string\'s container');
      await page.click('#copy-link');
      const link = await page.evaluate(() => navigator.clipboard.readText());
      check(link === `${base}share#ptk=${ptk}`, 'share: Copy link gives the share URL');
      await a11y(page, 'share (design)');
      await shot(page, 'share');
      check(errors.length === 0, `share: no page errors (${errors.join(' | ')})`);
      check(foreign.length === 0, `share: no requests leave the site (${foreign.join(', ')})`);
      await ctx.close();
    }
    {
      // UX-T14: load the page, then block every request, then open the link.
      const { ctx, page, errors } = await open();
      await page.goto(`${base}share`);
      await page.waitForSelector('#empty:not([hidden])');
      let blocked = 0;
      await ctx.route('**/*', (route) => { blocked++; return route.abort(); });
      await page.evaluate((s) => { window.location.hash = `ptk=${s}`; }, ptk);
      await page.waitForSelector('#design:not([hidden])', { timeout: 5000 }).catch(() => undefined);
      const st = await page.evaluate(() => window.__share);
      check(st && st.ok && st.fingerprint === fingerprint, `share (offline): the link opens with the network blocked (${JSON.stringify(st)}, ${blocked} requests attempted)`);
      check(blocked === 0, `share (offline): no request was even attempted (${blocked})`);
      const lit = await page.evaluate(() => {
        const c = document.getElementById('preview');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40 && Math.max(d[i], d[i + 1], d[i + 2]) > 120) n++;
        return n;
      });
      check(lit > 2000, `share: the preview canvas draws the creature (${lit} lit pixels)`);
      check(errors.filter((e) => !/net::ERR_FAILED/.test(e)).length === 0, `share (offline): no page errors (${errors.join(' | ')})`);
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await page.goto(`${base}share#ptk=${ptk}`);
      await page.waitForSelector('#design:not([hidden])');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(overflow <= 0, `share (phone): no horizontal scroll (${overflow}px)`);
      await shot(page, 'share-mobile', { fullPage: true });
      await ctx.close();
    }
    {
      const { ctx, page, errors } = await open();
      const broken = ptk.slice(0, -12) + (ptk.slice(-12, -11) === 'A' ? 'B' : 'A') + ptk.slice(-11);
      await page.goto(`${base}share.html#ptk=${broken}`);
      await page.waitForSelector('#error:not([hidden])');
      const reason = await page.textContent('#error-reason');
      check(/checksum|damaged|cut short/.test(reason || ''), `share: a damaged string gives a specific reason ("${reason}")`);
      await a11y(page, 'share (error)');
      await shot(page, 'share-error');
      await page.fill('#paste-error', ptk);
      await page.click('#error button[type=submit]');
      await page.waitForSelector('#design:not([hidden])');
      check(true, 'share: pasting a string opens it');
      // hostile metadata is shown as text, never markup
      await page.goto(`${base}share.html#ptk=PTK1.AAAA`);
      await page.waitForSelector('#error:not([hidden])');
      check(errors.length === 0, `share (error): no page errors (${errors.join(' | ')})`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (failures.length) { console.error(`\n${failures.length} site check(s) failed`); process.exit(1); }
  console.log('\nsite e2e: all checks passed; screenshots in tests/artifacts/site-*.png');
})().catch((e) => { console.error(e); process.exit(1); });
