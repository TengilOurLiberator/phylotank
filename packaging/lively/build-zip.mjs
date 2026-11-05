// Build the Lively Wallpaper package: packaging/out/phylotank-lively-<version>.zip, plus the
// unpacked folder packaging/out/lively/ (handy for "Add wallpaper" from a folder, and for tests).
//
//   npm run build && node packaging/lively/build-zip.mjs [--out <dir>]
//
// Zip layout:
//   LivelyInfo.json, LivelyProperties.json, thumbnail.png
//   index.html, loader.js, idle.js       the loader (host first, dream tank fallback)
//   tank/wallpaper.html, app.js, sim-worker.js, sim-worker-inline.js, worker-shim.js
//                                        the standalone dream tank, runnable from file://
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { zipBuffer } from '../shared/zip.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');

/** Four-part Lively AppVersion from a semver string: 0.1.2 -> 0.1.2.0, 0.1.2-rc.3 -> 0.1.2.3. */
export function appVersion(semver) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]*?(\d+))?/.exec(String(semver));
  if (!m) throw new Error(`not a semver version: ${semver}`);
  return `${m[1]}.${m[2]}.${m[3]}.${m[4] ?? 0}`;
}

/**
 * The dream-tank page for the zip: dist/wallpaper.html with the worker shim loaded before
 * app.js and blob: workers allowed by its CSP. Throws if the page no longer has the expected
 * shape, so a change to web/wallpaper.html cannot silently break the package.
 */
export function patchWallpaperHtml(html) {
  const csp = /(worker-src )'self'/;
  const script = '<script src="app.js"></script>';
  if (!csp.test(html)) throw new Error("wallpaper.html: no \"worker-src 'self'\" in its CSP to extend");
  if (!html.includes(script)) throw new Error('wallpaper.html: no <script src="app.js"> to put the shim before');
  return html
    .replace(csp, "$1'self' blob:")
    .replace(script, '<script src="sim-worker-inline.js"></script>\n<script src="worker-shim.js"></script>\n' + script);
}

/** A procedural 320 x 180 RGB PNG thumbnail: dark water and a few glows (no binary assets). */
export function thumbnailPng(w = 320, h = 180) {
  const motes = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 26; i++) motes.push([rnd() * w, rnd() * h, 2 + rnd() * 5, rnd() < 0.75 ? [90, 200, 230] : [210, 120, 255]]);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0; // filter: none
    const d = y / (h - 1);
    for (let x = 0; x < w; x++) {
      let r = 4 * (1 - d), g = 19 * (1 - d) + 3 * d, b = 31 * (1 - d) + 6 * d;
      for (const [mx, my, mr, c] of motes) {
        const q = ((x - mx) ** 2 + (y - my) ** 2) / (mr * mr);
        if (q < 9) { const k = 0.9 / (1 + q * q); r += c[0] * k; g += c[1] * k; b += c[2] * k; }
      }
      const o = row + 1 + x * 3;
      raw[o] = Math.min(255, r); raw[o + 1] = Math.min(255, g); raw[o + 2] = Math.min(255, b);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Every file of the package as {name, data}. */
export function livelyEntries({ dist, version }) {
  const need = ['wallpaper.html', 'app.js', 'sim-worker.js'];
  for (const f of need) if (!existsSync(join(dist, f))) throw new Error(`${join(dist, f)} is missing: run "npm run build" first`);
  const info = JSON.parse(readFileSync(join(here, 'LivelyInfo.json'), 'utf8'));
  info.AppVersion = appVersion(version);
  const worker = readFileSync(join(dist, 'sim-worker.js'), 'utf8');
  return [
    { name: 'LivelyInfo.json', data: JSON.stringify(info, null, 2) + '\n' },
    { name: 'LivelyProperties.json', data: readFileSync(join(here, 'LivelyProperties.json')) },
    { name: 'thumbnail.png', data: thumbnailPng() },
    { name: 'index.html', data: readFileSync(join(here, 'index.html')) },
    { name: 'loader.js', data: readFileSync(join(here, 'loader.js')) },
    { name: 'idle.js', data: readFileSync(join(here, '..', 'shared', 'idle.js')) },
    { name: 'tank/wallpaper.html', data: patchWallpaperHtml(readFileSync(join(dist, 'wallpaper.html'), 'utf8')) },
    { name: 'tank/app.js', data: readFileSync(join(dist, 'app.js')) },
    { name: 'tank/sim-worker.js', data: worker },
    // a classic script, so it loads from file:// where fetch() and Worker(file) do not
    { name: 'tank/sim-worker-inline.js', data: `window.__ptWorkerSource=${JSON.stringify(worker)};\n` },
    { name: 'tank/worker-shim.js', data: readFileSync(join(here, 'worker-shim.js')) },
  ];
}

export function buildLively({ dist = join(repo, 'dist'), out = join(repo, 'packaging', 'out'), version } = {}) {
  const v = version ?? JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  const entries = livelyEntries({ dist, version: v });
  const folder = join(out, 'lively');
  rmSync(folder, { recursive: true, force: true });
  for (const e of entries) {
    const p = join(folder, e.name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, e.data);
  }
  const zipPath = join(out, `phylotank-lively-${v}.zip`);
  const zip = zipBuffer(entries);
  writeFileSync(zipPath, zip);
  return { zipPath, folder, bytes: zip.length, files: entries.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const i = process.argv.indexOf('--out');
  const r = buildLively(i > 0 ? { out: resolve(process.argv[i + 1]) } : {});
  console.log(`Lively package: ${r.zipPath} (${r.files} files, ${(r.bytes / 1024).toFixed(0)} KiB); unpacked in ${r.folder}`);
}
