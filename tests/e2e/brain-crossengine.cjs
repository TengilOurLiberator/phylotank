// Cross-engine check for src/brain: the same brain probe must give the same state hash in Node
// and in headless Chromium (CONTRACT 4.2 rule 3; src/brain README acceptance). Run with
// `node tests/e2e/brain-crossengine.cjs`. Needs Playwright (installed globally).
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');
const path = require('node:path');

(async () => {
  const entry = path.join(__dirname, '..', '..', 'src', 'brain', 'xengine.ts');
  const out = buildSync({ entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: 'BrainProbe', platform: 'neutral', target: 'es2022' });
  const code = out.outputFiles[0].text;
  // Node
  const fn = new Function(`${code}; return BrainProbe;`);
  const nodeHash = fn().brainProbe();
  // Chromium
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ content: code });
  const chromeHash = await page.evaluate(() => globalThis.BrainProbe.brainProbe());
  await browser.close();
  console.log(JSON.stringify({ node: nodeHash, chromium: chromeHash, equal: nodeHash === chromeHash }));
  process.exit(nodeHash === chromeHash ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
