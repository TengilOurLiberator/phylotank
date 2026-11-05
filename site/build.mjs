// Build the GitHub Pages site into one self-contained folder.
//   node site/build.mjs                       site/_site from site/ and the app in dist/
//   node site/build.mjs --dist dist --out _site
//   node site/build.mjs --no-app              no demo tank (a placeholder page instead)
// Run `npm run build` first: the demo tank is the app's own dist/ bundle, copied to tank/
// without the Node host and source maps. Nothing here fetches anything from the network.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const out = resolve(root, opt('--out', join('site', '_site')));
const dist = resolve(root, opt('--dist', 'dist'));
const noApp = args.includes('--no-app');

const PAGES = ['index.html', 'share.html', 'style.css'];
/** Files from dist/ that the static site must not publish. */
const SKIP_FROM_DIST = (name) => name === 'host.mjs' || name.endsWith('.map') || name === 'site';

export async function buildSite({ outDir = out, distDir = dist, withApp = !noApp, quiet = false } = {}) {
  if (withApp && !existsSync(join(distDir, 'index.html'))) {
    throw new Error(`no app bundle at ${relative(root, distDir) || distDir}: run "npm run build" first, or pass --no-app`);
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: { landing: join(here, 'src/landing.ts'), share: join(here, 'src/share-main.ts') },
    outdir: outDir, bundle: true, platform: 'browser', format: 'iife', target: ['es2022', 'chrome110', 'firefox115', 'safari16'],
    minify: true, legalComments: 'none', logLevel: quiet ? 'silent' : 'info', charset: 'utf8',
  });
  for (const f of PAGES) cpSync(join(here, f), join(outDir, f));
  cpSync(join(here, 'assets'), join(outDir, 'assets'), { recursive: true });
  const tank = join(outDir, 'tank');
  mkdirSync(tank, { recursive: true });
  if (withApp) {
    for (const name of readdirSync(distDir)) {
      if (SKIP_FROM_DIST(name)) continue;
      const src = join(distDir, name);
      cpSync(src, join(tank, name), { recursive: statSync(src).isDirectory(), filter: (s) => !s.endsWith('.map') });
    }
  } else {
    writeFileSync(join(tank, 'index.html'), '<!doctype html><html lang="en-GB"><meta charset="utf-8"><title>Phylotank demo tank</title>'
      + '<style>html,body{margin:0;height:100%;background:#020a12;color:#a6c6d1;font:16px system-ui,sans-serif;display:grid;place-items:center}</style>'
      + '<p>The demo tank was not built into this copy of the site.</p></html>\n');
  }
  // Pages deployed from Actions skip Jekyll anyway; this keeps a branch deploy honest too.
  writeFileSync(join(outDir, '.nojekyll'), '');
  return outDir;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildSite().then((d) => console.log(`site: ${relative(root, d) || d}`), (e) => { console.error(String(e.message ?? e)); process.exit(1); });
}
