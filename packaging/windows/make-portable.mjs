// Assemble the Windows portable zip (review R20: v0.1 ships as a portable zip, no installer):
//   packaging/out/phylotank-windows-<version>.zip  ->  Phylotank\...
//
//   node packaging/windows/make-portable.mjs --bin <dir with phylotank-scr.exe and phylotank-tray.exe>
//        [--node <path to node.exe>] [--out <dir>] [--version <semver>]
//
// Layout inside the zip:
//   Phylotank\Phylotank.exe      tray shell (phylotank-tray.exe renamed)
//   Phylotank\phylotank.scr      screensaver (phylotank-scr.exe renamed)
//   Phylotank\web\               dist\ without source maps: the views, sim-worker.js, host.mjs
//   Phylotank\node\node.exe      optional bundled Node runtime
//   Phylotank\install.cmd, install.ps1, uninstall.ps1, README.txt
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zipBuffer } from '../shared/zip.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function portableEntries({ dist, bin, node, version }) {
  const need = [
    [join(bin, 'phylotank-tray.exe'), 'the tray build (cargo build --release -p phylotank-tray)'],
    [join(bin, 'phylotank-scr.exe'), 'the screensaver build (cargo build --release -p phylotank-scr)'],
    [join(dist, 'host.mjs'), 'dist/ (npm run build)'],
    [join(dist, 'screensaver.html'), 'dist/ (npm run build)'],
  ];
  for (const [p, what] of need) if (!existsSync(p)) throw new Error(`${p} is missing: build ${what} first`);
  const top = 'Phylotank/';
  const entries = [
    { name: top + 'Phylotank.exe', data: readFileSync(join(bin, 'phylotank-tray.exe')) },
    { name: top + 'phylotank.scr', data: readFileSync(join(bin, 'phylotank-scr.exe')) },
  ];
  for (const f of walk(dist)) {
    if (f.endsWith('.map')) continue;
    entries.push({ name: top + 'web/' + relative(dist, f).split(/[\\/]/).join('/'), data: readFileSync(f) });
  }
  if (node) entries.push({ name: top + 'node/node.exe', data: readFileSync(node) });
  for (const f of ['install.cmd', 'install.ps1', 'uninstall.ps1']) entries.push({ name: top + f, data: readFileSync(join(here, f)) });
  const readme = readFileSync(join(here, 'README.txt'), 'utf8').replace('{{VERSION}}', version);
  entries.push({ name: top + 'README.txt', data: readme.replace(/\r?\n/g, '\r\n') });
  return entries;
}

export function buildPortable({ dist = join(repo, 'dist'), bin, node, out = join(repo, 'packaging', 'out'), version } = {}) {
  const v = version ?? JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  const entries = portableEntries({ dist, bin, node, version: v });
  mkdirSync(out, { recursive: true });
  const zipPath = join(out, `phylotank-windows-${v}.zip`);
  const zip = zipBuffer(entries);
  writeFileSync(zipPath, zip);
  return { zipPath, bytes: zip.length, files: entries.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const opt = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const bin = opt('bin') ?? join(repo, 'packaging', 'target', 'release');
  const r = buildPortable({ bin: resolve(bin), node: opt('node') && resolve(opt('node')), out: opt('out') && resolve(opt('out')), version: opt('version') });
  console.log(`Windows portable zip: ${r.zipPath} (${r.files} files, ${(r.bytes / 1048576).toFixed(1)} MiB)`);
}
