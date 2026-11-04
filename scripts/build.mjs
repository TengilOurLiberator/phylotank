// Build: bundle the view app, the sim worker and the Node host into dist/, and copy the pages.
//   node scripts/build.mjs          production build
//   node scripts/build.mjs --dev    watch and serve dist/ on http://127.0.0.1:8000/
import { context, build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const dev = process.argv.includes('--dev');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const f of readdirSync(join(root, 'web'))) if (f.endsWith('.html')) cpSync(join(root, 'web', f), join(dist, f));

const common = { bundle: true, sourcemap: true, logLevel: 'info', legalComments: 'none' };
const browser = { ...common, platform: 'browser', format: 'iife', target: ['es2022', 'chrome110'], minify: !dev };
const targets = [
  { ...browser, entryPoints: [join(root, 'web/main.ts')], outfile: join(dist, 'app.js') },
  { ...browser, entryPoints: [join(root, 'src/sim/worker.ts')], outfile: join(dist, 'sim-worker.js') },
  {
    ...common, platform: 'node', format: 'esm', target: 'node22', entryPoints: [join(root, 'src/host/main.ts')],
    outfile: join(dist, 'host.mjs'), external: ['bufferutil', 'utf-8-validate'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  },
];

if (dev) {
  const ctxs = await Promise.all(targets.map((t) => context(t)));
  await Promise.all(ctxs.map((c) => c.watch()));
  const { port } = await ctxs[0].serve({ servedir: dist, host: '127.0.0.1', port: 8000 });
  console.log(`dev server: http://127.0.0.1:${port}/  (wallpaper.html, screensaver.html, tv.html, god.html)`);
} else {
  await Promise.all(targets.map((t) => build(t)));
}
