/**
 * packaging/: the Lively loader's state machine, the zip writer, the Lively package builder and
 * the static files. The packaging scripts are plain .mjs and .js (no TS build step), so they
 * are loaded by URL here and typed by the small interfaces below.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { inflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const pk = (...p: string[]): string => join(root, 'packaging', ...p);

type Mount = 'none' | 'local' | 'host';
interface LState { source: string; mounted: Mount; failures: number; misses: number }
interface LOut { state: LState; mount?: Mount; next?: number; fallbackIn?: number }
type LEvent = { type: 'start' } | { type: 'fallback' } | { type: 'probe'; ok: boolean };
interface LoaderApi {
  DEFAULT_PORT: number; FALLBACK_MS: number; MONITOR_MS: number;
  parsePort(v: unknown): number; parseSource(v: unknown): string; retryDelay(n: number): number;
  healthUrl(p: number): string; hostWallpaperUrl(p: number): string;
  initial(source: string): LState; step(s: LState, e: LEvent): LOut;
}
interface ZipApi {
  zipBuffer(e: { name: string; data: Buffer | string }[]): Buffer;
  unzipBuffer(b: Buffer): Map<string, Buffer>;
}
interface PortableApi {
  buildPortable(o: { dist: string; bin: string; node?: string; out: string; version: string }): { zipPath: string; files: number };
}
interface LivelyApi {
  appVersion(v: string): string;
  patchWallpaperHtml(html: string): string;
  thumbnailPng(w?: number, h?: number): Buffer;
  buildLively(o: { dist?: string; out?: string; version?: string }): { zipPath: string; folder: string; files: number };
}

let L: LoaderApi;
let Z: ZipApi;
let B: LivelyApi;
let P: PortableApi;
beforeAll(async () => {
  const ctx: Record<string, unknown> = {};
  ctx.globalThis = ctx;
  runInNewContext(readFileSync(pk('lively', 'loader.js'), 'utf8'), ctx);
  L = ctx.PhylotankLoader as LoaderApi;
  Z = (await import(pathToFileURL(pk('shared', 'zip.mjs')).href)) as ZipApi;
  B = (await import(pathToFileURL(pk('lively', 'build-zip.mjs')).href)) as LivelyApi;
  P = (await import(pathToFileURL(pk('windows', 'make-portable.mjs')).href)) as PortableApi;
});

/** Drive the loader machine through a list of events and collect the mounts. */
function run(source: string, events: LEvent[]): { mounts: Mount[]; outs: LOut[]; state: LState } {
  let s = L.initial(source);
  const mounts: Mount[] = [];
  const outs: LOut[] = [];
  for (const e of events) {
    const o = L.step(s, e);
    s = o.state;
    if (o.mount) mounts.push(o.mount);
    outs.push(o);
  }
  return { mounts, outs, state: s };
}
const down: LEvent = { type: 'probe', ok: false };
const up: LEvent = { type: 'probe', ok: true };

describe('Lively loader state machine', () => {
  it('auto: probes at once and falls back to the built-in tank after 2 s', () => {
    const r = run('auto', [{ type: 'start' }, down, { type: 'fallback' }]);
    expect(r.outs[0]!.next).toBe(0);
    expect(r.outs[0]!.fallbackIn).toBe(2000);
    expect(r.mounts).toEqual(['local']);
  });
  it('auto: a host that answers before the fallback is used directly, and the fallback is a no-op', () => {
    const r = run('auto', [{ type: 'start' }, up, { type: 'fallback' }]);
    expect(r.mounts).toEqual(['host']);
    expect(r.outs[1]!.next).toBe(L.MONITOR_MS);
  });
  it('retries with backoff 1, 2, 4, 8 s, then every 10 s', () => {
    const r = run('auto', [{ type: 'start' }, down, down, down, down, down, down]);
    expect(r.outs.slice(1).map((o) => o.next)).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
  });
  it('swaps from the built-in tank to the host when the host appears', () => {
    const r = run('auto', [{ type: 'start' }, down, { type: 'fallback' }, down, down, up]);
    expect(r.mounts).toEqual(['local', 'host']);
  });
  it('falls back only after 3 missed health checks in a row', () => {
    const r = run('auto', [{ type: 'start' }, up, down, down, up, down, down, down]);
    expect(r.mounts).toEqual(['host', 'local']);
    expect(r.state.mounted).toBe('local');
  });
  it('host only: never mounts the built-in tank, shows the idle water instead', () => {
    const r = run('host', [{ type: 'start' }, down, { type: 'fallback' }, down, up, down, down, down]);
    expect(r.outs[0]!.fallbackIn).toBeUndefined();
    expect(r.mounts).toEqual(['host', 'none']);
  });
  it('built-in only: mounts the tank at once and never probes', () => {
    const r = run('standalone', [{ type: 'start' }, up]);
    expect(r.mounts).toEqual(['local']);
    expect(r.outs.every((o) => o.next === undefined)).toBe(true);
  });
  it('parses Lively property values', () => {
    expect(L.parsePort('47616')).toBe(47616);
    expect(L.parsePort(' 50000 ')).toBe(50000);
    expect(L.parsePort('80')).toBe(47615);
    expect(L.parsePort('abc')).toBe(47615);
    expect(L.parsePort(undefined)).toBe(47615);
    expect(L.parseSource(0)).toBe('auto');
    expect(L.parseSource(1)).toBe('host');
    expect(L.parseSource('2')).toBe('standalone');
    expect(L.parseSource(9)).toBe('auto');
    expect(L.parseSource('HOST')).toBe('host');
  });
  it('only ever talks to the loopback host', () => {
    expect(L.healthUrl(47615)).toBe('http://127.0.0.1:47615/health');
    expect(L.hostWallpaperUrl(47615)).toBe('http://127.0.0.1:47615/wallpaper.html?lively=1');
    expect(L.hostWallpaperUrl(47616)).toBe('http://127.0.0.1:47616/wallpaper.html?lively=1&host=ws%3A%2F%2F127.0.0.1%3A47616%2Fws%2Fv1');
  });
});

describe('zip writer', () => {
  it('round-trips stored and deflated entries with UTF-8 names', () => {
    const big = 'glow '.repeat(5000);
    const bin = Buffer.from([0, 1, 2, 3, 255]);
    const zip = Z.zipBuffer([{ name: 'a/b.txt', data: big }, { name: 'x.bin', data: bin }, { name: 'Ålgräs.txt', data: 'hej' }]);
    const back = Z.unzipBuffer(zip);
    expect([...back.keys()]).toEqual(['a/b.txt', 'x.bin', 'Ålgräs.txt']);
    expect(back.get('a/b.txt')!.toString()).toBe(big);
    expect(back.get('x.bin')!.equals(bin)).toBe(true);
    expect(zip.length).toBeLessThan(big.length / 10);
  });
  it('is deterministic', () => {
    const e = [{ name: 'f', data: 'same' }];
    expect(Z.zipBuffer(e).equals(Z.zipBuffer(e))).toBe(true);
  });
  it('rejects unsafe or duplicate names', () => {
    expect(() => Z.zipBuffer([{ name: '../evil', data: '' }])).toThrow();
    expect(() => Z.zipBuffer([{ name: '/abs', data: '' }])).toThrow();
    expect(() => Z.zipBuffer([{ name: 'a', data: '' }, { name: 'a', data: '' }])).toThrow();
  });
});

describe('Lively package', () => {
  it('maps semver to a four-part AppVersion', () => {
    expect(B.appVersion('0.0.1')).toBe('0.0.1.0');
    expect(B.appVersion('1.2.3-rc.4')).toBe('1.2.3.4');
    expect(() => B.appVersion('one')).toThrow();
  });
  it('patches the dream-tank page for file:// and refuses an unexpected page', () => {
    const html = readFileSync(join(root, 'web', 'wallpaper.html'), 'utf8');
    const out = B.patchWallpaperHtml(html);
    expect(out).toContain("worker-src 'self' blob:");
    expect(out.indexOf('worker-shim.js')).toBeLessThan(out.indexOf('src="app.js"'));
    expect(out.indexOf('sim-worker-inline.js')).toBeLessThan(out.indexOf('worker-shim.js'));
    expect(() => B.patchWallpaperHtml('<html></html>')).toThrow();
  });
  it('makes a valid PNG thumbnail', () => {
    const png = B.thumbnailPng(64, 36);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(64);
    expect(png.readUInt32BE(20)).toBe(36);
    const idatLen = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect(raw.length).toBe((64 * 3 + 1) * 36);
  });
  it('LivelyInfo.json names the loader and the files it ships', () => {
    const info = JSON.parse(readFileSync(pk('lively', 'LivelyInfo.json'), 'utf8'));
    expect(info.FileName).toBe('index.html');
    expect(info.Type).toBe(1);
    expect(info.IsAbsolutePath).toBe(false);
    for (const f of ['index.html', 'loader.js', 'LivelyProperties.json']) expect(existsSync(pk('lively', f))).toBe(true);
    const props = JSON.parse(readFileSync(pk('lively', 'LivelyProperties.json'), 'utf8'));
    expect(Object.keys(props).sort()).toEqual(['port', 'source']);
    expect(props.source.items).toHaveLength(3);
  });
  it('builds a zip with the loader at the root and the dream tank in tank/ (fake dist)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pt-pkg-'));
    try {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const dist = join(tmp, 'dist');
      mkdirSync(dist);
      writeFileSync(join(dist, 'wallpaper.html'), readFileSync(join(root, 'web', 'wallpaper.html')));
      writeFileSync(join(dist, 'app.js'), '/* app */');
      writeFileSync(join(dist, 'sim-worker.js'), 'self.onmessage = () => {}; // "quoted"');
      const r = B.buildLively({ dist, out: join(tmp, 'out'), version: '0.3.0' });
      const z = Z.unzipBuffer(readFileSync(r.zipPath));
      expect([...z.keys()].sort()).toEqual([
        'LivelyInfo.json', 'LivelyProperties.json', 'idle.js', 'index.html', 'loader.js', 'tank/app.js',
        'tank/sim-worker-inline.js', 'tank/sim-worker.js', 'tank/wallpaper.html', 'tank/worker-shim.js', 'thumbnail.png',
      ]);
      expect(JSON.parse(z.get('LivelyInfo.json')!.toString()).AppVersion).toBe('0.3.0.0');
      const ctx: Record<string, unknown> = { window: {} };
      runInNewContext(z.get('tank/sim-worker-inline.js')!.toString(), ctx);
      expect((ctx.window as Record<string, string>).__ptWorkerSource).toBe('self.onmessage = () => {}; // "quoted"');
      for (const n of ['idle.js', 'loader.js']) expect(z.get('index.html')!.toString()).toContain(`src="${n}"`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Windows portable zip', () => {
  it('renames the binaries, ships dist without source maps and the install scripts', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const tmp = mkdtempSync(join(tmpdir(), 'pt-win-'));
    try {
      const dist = join(tmp, 'dist');
      const bin = join(tmp, 'bin');
      mkdirSync(dist);
      mkdirSync(bin);
      for (const f of ['host.mjs', 'screensaver.html', 'app.js', 'app.js.map', 'sim-worker.js']) writeFileSync(join(dist, f), f);
      writeFileSync(join(bin, 'phylotank-tray.exe'), 'MZtray');
      writeFileSync(join(bin, 'phylotank-scr.exe'), 'MZscr');
      writeFileSync(join(tmp, 'node.exe'), 'MZnode');
      const r = P.buildPortable({ dist, bin, node: join(tmp, 'node.exe'), out: join(tmp, 'out'), version: '0.2.0' });
      expect(r.zipPath.endsWith('phylotank-windows-0.2.0.zip')).toBe(true);
      const z = Z.unzipBuffer(readFileSync(r.zipPath));
      expect([...z.keys()].sort()).toEqual([
        'Phylotank/Phylotank.exe', 'Phylotank/README.txt', 'Phylotank/install.cmd', 'Phylotank/install.ps1', 'Phylotank/node/node.exe',
        'Phylotank/phylotank.scr', 'Phylotank/uninstall.ps1', 'Phylotank/web/app.js', 'Phylotank/web/host.mjs',
        'Phylotank/web/screensaver.html', 'Phylotank/web/sim-worker.js',
      ]);
      expect(z.get('Phylotank/phylotank.scr')!.toString()).toBe('MZscr');
      const readme = z.get('Phylotank/README.txt')!.toString();
      expect(readme).toContain('Phylotank 0.2.0 for Windows');
      expect(readme).toContain('\r\n');
      expect(() => P.buildPortable({ dist, bin: join(tmp, 'nope'), out: join(tmp, 'out'), version: '0.2.0' })).toThrow(/missing/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it('the install scripts stay per-user', () => {
    for (const f of ['install.ps1', 'uninstall.ps1']) {
      // code only: the help text may name what the scripts do not touch
      const s = readFileSync(pk('windows', f), 'utf8').replace(/<#[\s\S]*?#>/g, '').replace(/^\s*#.*$/gm, '');
      expect(s).not.toMatch(/HKLM:|HKEY_LOCAL_MACHINE|System32|Program Files|RunAs|-Verb\s+RunAs/i);
      expect(s).toContain('HKCU:');
    }
  });
});
