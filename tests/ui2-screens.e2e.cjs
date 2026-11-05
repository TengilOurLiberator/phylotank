// Second-pass UI checks for src/ui (run after `node scripts/build.mjs`):
//   node tests/ui2-screens.e2e.cjs [names,comma,separated]
// Needs Playwright (global install is fine: NODE_PATH=$(npm root -g)) and axe-core (devDependency).
// Serves dist/, drives the god window and the TV view against the in-page MockSimLink, writes
// tests/artifacts/ui2-*.png and tests/artifacts/ui2-report.json, and checks:
//  - onboarding: a living tank (>= 50 creatures) and the welcome card, at 1x and with 4x CPU throttle (UX-T33);
//    the tour completes and can be skipped with the keyboard only;
//  - rename: the inspector rename reaches the stats table and the timeline, and survives a reload;
//  - knobs: a live knob applies, a preset applies, reset works;
//  - food web and gene drift render (and their tables);
//  - TV overlay: remote keys and a virtual gamepad reach every control, Back hides it (UX-T36);
//  - axe-core: no serious or critical violations in every god panel, normal and high contrast, 100% and 200% (UX-T34).
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'tests', 'artifacts');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' };
const only = process.argv[2] || '';
const want = (n) => !only || only.split(',').includes(n);
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

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

const report = { onboarding: {}, axe: [], tv: {}, failures: [] };

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const failures = report.failures;
  const shot = async (page, name) => { await page.screenshot({ path: path.join(out, `ui2-${name}.png`) }); console.log('wrote', `ui2-${name}.png`); };
  const newPage = async (url, vp = { width: 1600, height: 900 }) => {
    const ctx = await browser.newContext({ viewport: vp, bypassCSP: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(url.startsWith('http') ? url : `${base}${url}`);
    return { page, ctx, errors };
  };
  const god = (page, fn, arg) => page.evaluate(fn, arg);
  try {
    // ---------------- onboarding timing (UX-T33) ----------------
    if (want('onboarding')) {
      for (const throttle of [1, 4]) {
        const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        if (throttle > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle }); }
        const t0 = Date.now();
        await page.goto(`${base}/god.html?lang=en&onboarding=on`);
        await page.waitForFunction(() => { const g = window.__phylotankGod; return g && g.onb && g.onb.timing.livingAt !== null; }, null, { timeout: 60_000 }).catch(() => failures.push(`onboarding x${throttle}: no living tank within 60 s`));
        const living = Date.now() - t0;
        await page.getByRole('button', { name: 'Show me around' }).waitFor({ timeout: 60_000 }).catch(() => failures.push(`onboarding x${throttle}: no welcome card`));
        const welcome = Date.now() - t0;
        report.onboarding[`cpu${throttle}x`] = { livingMs: living, welcomeMs: welcome };
        console.log(`onboarding cpu ${throttle}x: living tank ${living} ms, welcome card ${welcome} ms`);
        if (throttle === 1) {
          if (living > 10_000) failures.push(`onboarding: living tank took ${living} ms (> 10 s)`);
          await page.waitForTimeout(600);
          await shot(page, 'onboarding-welcome');
          // keyboard-only tour: Enter on the focused "Show me around", C to inspect, the bloom, then D for the designer
          await page.keyboard.press('Enter');
          await page.waitForTimeout(300);
          await shot(page, 'onboarding-step1');
          await page.keyboard.press('c');
          await page.waitForTimeout(1200);
          await shot(page, 'onboarding-step2');
          // the power step opened Powers with Algae bloom picked: target the view centre, then cast (Tab to the buttons)
          await page.getByRole('button', { name: 'Target the view centre' }).focus();
          await page.keyboard.press('Enter');
          await page.getByRole('button', { name: 'Cast', exact: true }).focus();
          await page.keyboard.press('Enter');
          await page.waitForTimeout(1200);
          await shot(page, 'onboarding-step3');
          await page.keyboard.press('Escape');
          await page.keyboard.press('d');
          await page.waitForTimeout(1200);
          await shot(page, 'onboarding-setup');
          const st = await god(page, () => window.__phylotankGod.onb.state.s);
          if (st !== 'setup') failures.push(`onboarding: keyboard tour ended in ${st}, not setup`);
          await page.keyboard.press('Enter');
          const done = await god(page, () => window.__phylotankGod.onb.state.s);
          if (done !== 'done') failures.push(`onboarding: Done left the state at ${done}`);
          // skip path with keyboard: reopen, tour, skip
          await god(page, () => window.__phylotankGod.onb.send({ e: 'reopen' }));
          await page.keyboard.press('Enter');
          await page.getByRole('button', { name: 'Skip tour' }).focus();
          await page.keyboard.press('Enter');
          const skipped = await god(page, () => window.__phylotankGod.onb.state.s);
          if (skipped !== 'done') failures.push(`onboarding: skip left the state at ${skipped}`);
        }
        if (errors.length) failures.push(`onboarding x${throttle} errors: ${errors.join(' | ')}`);
        await ctx.close();
      }
    }

    // ---------------- god window panels, rename, knobs, food web, drift ----------------
    const { page, ctx, errors } = await newPage('/god.html?lang=en');
    await page.waitForFunction(() => window.__phylotankGod && window.__phylotankGod.client.species.length > 0);
    await page.waitForTimeout(1500);
    const selectFirst = () => god(page, () => {
      const g = window.__phylotankGod; const d = g.client.dust;
      for (const [slot, info] of g.client.slots) if (slot < d.n && d.colour[slot] !== 255 && g.client.species.find((s) => s.id === info.species)) { g.client.select(info.id); g.inspector.render(); return info.species; }
      return -1;
    });
    if (want('rename')) {
      const sp = await selectFirst();
      await page.waitForTimeout(1500);
      await page.getByRole('button', { name: /Rename/ }).first().click();
      await page.locator('#rn-genus').fill('Willia');
      await page.locator('#rn-epithet').fill('nocturna');
      await page.locator('#rn-common').fill('William\'s lantern');
      await shot(page, 'rename-dialog');
      await page.getByRole('button', { name: 'Save name' }).click();
      await page.waitForTimeout(1600);
      const name = await god(page, (id) => window.__phylotankGod.client.speciesName(id), sp);
      if (name !== 'Willia nocturna') failures.push(`rename: species ${sp} shows "${name}"`);
      const ev = await god(page, () => window.__phylotankGod.client.events.some((e) => e.k === 'rename' && e.to === 'Willia nocturna'));
      if (!ev) failures.push('rename: no rename event on the timeline');
      await shot(page, 'rename-inspector');
      // bad names are refused with a reason
      await page.getByRole('button', { name: /Rename/ }).first().click();
      await page.locator('#rn-genus').fill('X1');
      const disabled = await page.getByRole('button', { name: 'Save name' }).isDisabled();
      if (!disabled) failures.push('rename: an invalid genus was accepted');
      await shot(page, 'rename-invalid');
      await page.keyboard.press('Escape');
    }
    const openPanel = async (p) => { await god(page, (x) => window.__phylotankGod.openPanel(x), p); await page.waitForTimeout(700); };
    const statsTab = async (name) => { await openPanel('stats'); await page.getByRole('tab', { name }).click(); await page.waitForTimeout(1300); };
    if (want('foodweb')) {
      await statsTab('Food web');
      await shot(page, 'foodweb');
      await page.getByRole('button', { name: 'Show as table' }).click();
      await page.waitForTimeout(300);
      await shot(page, 'foodweb-table');
      await page.getByRole('button', { name: 'Show as chart' }).click();
    }
    if (want('drift')) {
      await god(page, () => { const m = window.__phylotankGod.client.link; for (let i = 0; i < 40; i++) m.pump(5000); });
      await statsTab('Genes');
      await page.getByRole('button', { name: 'Drift over time' }).click();
      await page.waitForTimeout(1300);
      await shot(page, 'drift');
      await page.getByRole('button', { name: 'Now', exact: true }).click();
      await page.waitForTimeout(800);
      await shot(page, 'genes-histogram');
    }
    if (want('knobs')) {
      await openPanel('settings');
      await shot(page, 'settings');
      await page.locator('select[aria-label="Preset"]').selectOption('harsh');
      await page.waitForTimeout(1500);
      const harsh = await god(page, () => window.__phylotankGod.client.settings['life.metabolic']);
      if (harsh !== 1.5) failures.push(`knobs: Harsh preset left metabolic cost at ${harsh}`);
      await page.locator('.pt-panel .body').evaluate((el) => { el.scrollTop = 420; });
      await page.waitForTimeout(300);
      await shot(page, 'settings-knobs');
      await page.getByRole('button', { name: 'Reset all to preset' }).click();
      await page.locator('select[aria-label="Preset"]').selectOption('gentle');
      await page.waitForTimeout(1500);
      const gentle = await god(page, () => window.__phylotankGod.client.settings['life.metabolic']);
      if (gentle !== 1) failures.push(`knobs: Gentle preset left metabolic cost at ${gentle}`);
    }
    if (want('sv')) {
      await god(page, () => window.__phylotankGod.designer && document.querySelector('select[aria-label="Language"]'));
      await page.evaluate(() => { const s = document.querySelector('.pt-top select'); s.value = 'sv'; s.dispatchEvent(new Event('change')); });
      await openPanel('designer');
      await page.waitForTimeout(800);
      await shot(page, 'designer-sv');
      const lbl = await page.locator('.slider label').first().textContent();
      if (!/[a-zåäö]/i.test(lbl || '') || /_/.test(lbl || '')) failures.push(`sv: slider label "${lbl}"`);
      report.svFirstSlider = lbl;
      await openPanel('settings');
      await shot(page, 'settings-sv');
      await page.evaluate(() => { const s = document.querySelector('.pt-top select'); s.value = 'en'; s.dispatchEvent(new Event('change')); });
      await page.waitForTimeout(500);
    }
    if (want('rename')) {
      await page.reload();
      await page.waitForFunction(() => window.__phylotankGod && window.__phylotankGod.client.species.length > 0);
      await page.waitForTimeout(1500);
      const kept = await god(page, () => window.__phylotankGod.client.species.some((s) => s.name === 'Willia nocturna'));
      if (!kept) failures.push('rename: the user name did not survive a reload');
    }
    if (errors.length) failures.push(`god errors: ${errors.join(' | ')}`);
    await ctx.close();

    // ---------------- axe-core (UX-T34) ----------------
    if (want('axe')) {
      const panels = [null, 'map', 'powers', 'designer', 'library', 'stats', 'bookmarks', 'settings'];
      for (const [label, q] of [['normal', ''], ['contrast', '&contrast=high'], ['scale200', '&scale=2'], ['contrast200', '&contrast=high&scale=2']]) {
        const vp = label.includes('200') ? { width: 2560, height: 1440 } : { width: 1600, height: 900 };
        const { page: p, ctx: c } = await newPage(`/god.html?lang=en${q}`, vp);
        await p.waitForFunction(() => window.__phylotankGod && window.__phylotankGod.client.species.length > 0);
        await p.waitForTimeout(1200);
        await p.addScriptTag({ content: AXE });
        await p.evaluate(() => { const g = window.__phylotankGod; const d = g.client.dust; for (const [slot, info] of g.client.slots) if (slot < d.n && d.colour[slot] !== 255) { g.client.select(info.id); break; } });
        await p.waitForTimeout(1200);
        for (const panel of panels) {
          await p.evaluate((x) => window.__phylotankGod.openPanel(x), panel);
          await p.waitForTimeout(500);
          const res = await p.evaluate(async () => {
            const r = await window.axe.run(document, { resultTypes: ['violations'] });
            return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n').slice(1, 2).join('')) , count: v.nodes.length }));
          });
          const bad = res.filter((v) => v.impact === 'serious' || v.impact === 'critical');
          report.axe.push({ theme: label, panel: panel ?? 'none', violations: res });
          console.log(`axe ${label} ${panel ?? 'none'}: ${res.length} violations, ${bad.length} serious or critical`);
          for (const v of bad) failures.push(`axe ${label}/${panel ?? 'none'}: ${v.id} (${v.impact}, ${v.count}) ${v.nodes.join(' ; ')}`);
        }
        if (label === 'contrast') await shot(p, 'contrast');
        if (label === 'scale200') { await p.evaluate(() => window.__phylotankGod.openPanel('settings')); await p.waitForTimeout(400); await shot(p, 'scale200'); }
        await c.close();
      }
    }

    // ---------------- TV overlay, remote and gamepad (UX-T36) ----------------
    if (want('tv')) {
      const { page: p, ctx: c, errors: tvErr } = await newPage('/tv.html?sim=mock&lang=en', { width: 1920, height: 1080 });
      await p.addInitScript(() => {
        const pad = { id: 'Virtual pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
          axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
        window.__pad = pad;
        navigator.getGamepads = () => [pad];
        window.__press = async (i) => { pad.buttons[i] = { pressed: true, touched: true, value: 1 }; pad.timestamp++; await new Promise((r) => setTimeout(r, 120)); pad.buttons[i] = { pressed: false, touched: false, value: 0 }; pad.timestamp++; await new Promise((r) => setTimeout(r, 120)); };
      });
      await p.reload();
      await p.waitForTimeout(2500);
      await shot(p, 'tv');
      // remote: OK opens the overlay; D-pad moves focus over every control; Back (all three keys) hides it
      await p.keyboard.press('Enter');
      await p.waitForTimeout(400);
      await shot(p, 'tv-overlay');
      const controls = await p.evaluate(() => [...document.querySelectorAll('.tv-card button')].map((b) => b.textContent));
      const seen = new Set();
      for (let i = 0; i < controls.length + 2; i++) { seen.add(await p.evaluate(() => document.activeElement && document.activeElement.textContent)); await p.keyboard.press('ArrowRight'); }
      report.tv.controls = controls; report.tv.remoteReached = [...seen];
      if (controls.some((x) => !seen.has(x))) failures.push(`tv remote: unreachable ${controls.filter((x) => !seen.has(x)).join(', ')}`);
      for (const back of ['Escape', 'Backspace', 'GoBack']) {
        const shownNow = await p.evaluate(() => window.__phylotankTv.shown);
        if (!shownNow) { await p.keyboard.press('ArrowUp'); await p.waitForTimeout(150); }
        if (!(await p.evaluate(() => window.__phylotankTv.shown))) failures.push('tv remote: an arrow key did not summon the overlay');
        // Playwright has no GoBack key: dispatch it as the TV browser would
        if (back === 'GoBack') await p.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'GoBack', bubbles: true })));
        else await p.keyboard.press(back);
        await p.waitForTimeout(250);
        const vis = await p.evaluate(() => getComputedStyle(document.querySelector('.tv-overlay')).display !== 'none');
        if (vis) failures.push(`tv remote: ${back} did not hide the overlay`);
      }
      // gamepad: A opens, D-pad right walks every control, A on Captions toggles, B hides
      await p.evaluate(() => window.__press(0)); await p.waitForTimeout(300);
      const padSeen = new Set();
      for (let i = 0; i < controls.length + 2; i++) { padSeen.add(await p.evaluate(() => document.activeElement && document.activeElement.textContent)); await p.evaluate(() => window.__press(15)); }
      report.tv.padReached = [...padSeen];
      if (controls.some((x) => !padSeen.has(x))) failures.push(`tv gamepad: unreachable ${controls.filter((x) => !padSeen.has(x)).join(', ')}`);
      const capBefore = await p.evaluate(() => window.__phylotankTv.captionsOn);
      await p.evaluate(() => window.__press(2)); // X toggles captions
      const capAfter = await p.evaluate(() => window.__phylotankTv.captionsOn);
      if (capBefore === capAfter) failures.push('tv gamepad: X did not toggle captions');
      await p.evaluate(() => window.__press(1)); await p.waitForTimeout(200);
      const visB = await p.evaluate(() => getComputedStyle(document.querySelector('.tv-overlay')).display !== 'none');
      if (visB) failures.push('tv gamepad: B did not hide the overlay');
      // stick pans the camera away from the director; Y returns to the director
      await p.evaluate(() => { window.__pad.axes[0] = 0.9; });
      await p.waitForTimeout(500);
      await p.evaluate(() => { window.__pad.axes[0] = 0; });
      const mode = await p.evaluate(() => window.__phylotankTv.mode);
      if (mode !== 'manual') failures.push(`tv gamepad: left stick left the camera in ${mode}`);
      await p.evaluate(() => window.__press(3));
      const mode2 = await p.evaluate(() => window.__phylotankTv.mode);
      if (mode2 === 'manual') failures.push('tv gamepad: Y did not hand the camera back');
      report.tv.modes = [mode, mode2];
      // auto-hide after 8 s without input
      await p.keyboard.press('Enter');
      await p.waitForTimeout(8600);
      const visT = await p.evaluate(() => getComputedStyle(document.querySelector('.tv-overlay')).display !== 'none');
      if (visT) failures.push('tv: overlay did not hide after 8 s idle');
      await p.keyboard.press('Enter');
      await p.waitForTimeout(300);
      await p.addScriptTag({ content: AXE });
      const tvAxe = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length })));
      report.axe.push({ theme: 'tv', panel: 'overlay', violations: tvAxe });
      for (const v of tvAxe) if (v.impact === 'serious' || v.impact === 'critical') failures.push(`axe tv: ${v.id} (${v.impact})`);
      if (tvErr.length) failures.push(`tv errors: ${tvErr.join(' | ')}`);
      await c.close();
    }
    // ---------------- the real host link (dist/host.mjs on this branch) ----------------
    if (want('host')) {
      const host = spawn(process.execPath, [path.join(dist, 'host.mjs'), '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
      try {
        const port = await new Promise((resolve, reject) => {
          host.stdout.on('data', (d) => { const m = /127\.0\.0\.1:(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
          host.on('exit', () => reject(new Error('host exited')));
          setTimeout(() => reject(new Error('host did not start')), 5000);
        });
        // pages are served by the host itself: it refuses WebSocket upgrades from other origins
        const hb = `http://127.0.0.1:${port}`;
        const { page: p, ctx: c, errors: he } = await newPage(`${hb}/god.html?lang=en&host=${encodeURIComponent(`ws://127.0.0.1:${port}/ws/v1`)}`);
        await p.waitForTimeout(3500);
        const st = await p.evaluate(() => { const g = window.__phylotankGod; return { link: g.client.link.kind, mock: g.client.isMock, welcome: !!g.client.welcome, species: g.client.species.length, dust: !!g.client.dust }; });
        report.host = { god: st };
        if (st.link !== 'socket' || st.mock || !st.welcome) failures.push(`host: god window did not attach: ${JSON.stringify(st)}`);
        // a knob the host does not know is reported per knob, not pretended
        await p.evaluate(() => window.__phylotankGod.openPanel('settings'));
        await p.waitForTimeout(400);
        report.host.knob = await p.evaluate(() => window.__phylotankGod.client.send({ t: 'setting', key: 'eco.plankton', value: 2 }));
        report.host.autosave = await p.evaluate(() => window.__phylotankGod.client.send({ t: 'setting', key: 'autosaveMin', value: 10 }));
        report.host.rename = await p.evaluate(() => window.__phylotankGod.client.rename(0, { genus: 'Willia', epithet: 'hospes' }));
        report.host.renamedLocally = await p.evaluate(() => window.__phylotankGod.client.names.get(0)?.genus === 'Willia');
        if (!report.host.renamedLocally) failures.push('host: the rename was not kept on this viewer');
        await shot(p, 'host-god');
        for (const v of ['stats']) { await p.evaluate((x) => window.__phylotankGod.openPanel(x), v); await p.waitForTimeout(500); }
        await shot(p, 'host-stats');
        if (he.length) failures.push(`host god errors: ${he.join(' | ')}`);
        await c.close();
        const { page: tp, ctx: tc, errors: te } = await newPage(`${hb}/tv.html?lang=en&host=${encodeURIComponent(`ws://127.0.0.1:${port}/ws/v1`)}`, { width: 1920, height: 1080 });
        await tp.waitForTimeout(2500);
        await tp.keyboard.press('Enter');
        await tp.waitForTimeout(400);
        await shot(tp, 'host-tv');
        if (te.length) failures.push(`host tv errors: ${te.join(' | ')}`);
        await tc.close();
      } finally { host.kill(); }
    }
  } catch (e) {
    failures.push(`exception: ${e && e.stack || e}`);
  } finally {
    await browser.close();
    server.close();
  }
  fs.writeFileSync(path.join(out, 'ui2-report.json'), JSON.stringify(report, null, 1));
  if (failures.length) { console.error('UI2 E2E FAILED:\n - ' + failures.join('\n - ')); process.exit(1); }
  console.log('UI2 E2E OK');
})();
