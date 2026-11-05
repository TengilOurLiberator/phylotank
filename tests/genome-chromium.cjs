// Node versus Chromium bit-identity of genome development and mutation (src/genome acceptance).
// Run: NODE_PATH=$(npm root -g) node tests/genome-chromium.cjs   (Playwright is installed globally)
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const root = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'genome-ce-'));
const esbuild = path.join(root, 'node_modules', '.bin', 'esbuild');
const entry = path.join(root, 'tests', 'genome-crossengine.ts');
execFileSync(esbuild, [entry, '--bundle', '--format=iife', '--global-name=GP', `--outfile=${out}/p.js`, '--log-level=warning']);
execFileSync(esbuild, [entry, '--bundle', '--format=cjs', '--platform=node', `--outfile=${out}/p.cjs`, '--log-level=warning']);
const nodeHash = require(`${out}/p.cjs`).probe();
(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addScriptTag({ content: fs.readFileSync(`${out}/p.js`, 'utf8') });
  const chromeHash = await page.evaluate(() => globalThis.GP.probe());
  const version = browser.version();
  await browser.close();
  console.log(`node ${process.version}: ${nodeHash}`);
  console.log(`chromium ${version}: ${chromeHash}`);
  if (nodeHash !== chromeHash) { console.error('MISMATCH'); process.exit(1); }
  console.log('bit-identical');
})();
