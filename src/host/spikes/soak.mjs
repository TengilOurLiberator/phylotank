// Host soak: run the built host (dist/host.mjs) with three viewers for N seconds and sample
// its RSS, tick rate and bytes streamed. Linux only (reads /proc).
//   node src/host/spikes/soak.mjs --seconds 600 --world bench/local/soak/w [--preset small] [--motes 3000]
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const seconds = Number(arg('seconds', 120));
const world = arg('world', 'bench/local/soak/w');
rmSync(world, { recursive: true, force: true });
const host = spawn(process.execPath, ['dist/host.mjs', '--port', '0', '--world', world, '--preset', arg('preset', 'small'), '--motes', arg('motes', '3000'), '--autosave-min', '2'], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
host.stdout.on('data', (d) => { out += d; });
host.stderr.on('data', (d) => { out += d; });
const port = await new Promise((res, rej) => {
  const t = setInterval(() => { const m = /127\.0\.0\.1:(\d+)/.exec(out); if (m) { clearInterval(t); res(Number(m[1])); } }, 50);
  setTimeout(() => rej(new Error('host did not start')), 10000);
});
const token = /token=([A-Za-z0-9_-]+)/.exec(out)[1];

// minimal CBOR maps of short strings and small ints, and the 8-byte frame header
const str = (s) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([0x60 | b.length]), b]); };
const map = (o) => Buffer.concat([Buffer.from([0xa0 | Object.keys(o).length]), ...Object.entries(o).flatMap(([k, v]) => [str(k), typeof v === 'number' ? Buffer.from([v]) : str(v)])]);
const frame = (type, payload) => { const h = Buffer.alloc(8); h.writeUInt8(type, 0); h.writeUInt16LE(0x0100, 2); return Buffer.concat([h, payload]); };
const viewport = (x0, y0, x1, y1, ppm) => { const b = Buffer.alloc(28); [x0, y0, x1, y1, ppm].forEach((v, i) => b.writeFloatLE(v, i * 4)); return frame(0x03, b); };
const ack = () => { const b = Buffer.alloc(4); return frame(0x04, b); };

const bytes = { wallpaper: 0, screensaver: 0, god: 0 };
const socks = [];
for (const [view, tok] of [['wallpaper', null], ['screensaver', null], ['god', token]]) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/v1`);
  await new Promise((r) => ws.on('open', r));
  ws.send(frame(0x01, map(tok ? { view, token: tok } : { view })));
  if (view === 'screensaver') ws.send(viewport(4, 2, 12, 6.5, 240));
  ws.on('message', (d) => { bytes[view] += d.length; });
  socks.push(ws);
}
const acker = setInterval(() => { for (const ws of socks) ws.send(ack()); }, 500);
const rss = () => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${host.pid}/status`, 'utf8'))[1]) / 1024;
const samples = [];
const t0 = Date.now();
let last = { ...bytes };
while (Date.now() - t0 < seconds * 1000) {
  await new Promise((r) => setTimeout(r, 10_000));
  const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  const kbs = Object.fromEntries(Object.entries(bytes).map(([k, v]) => [k, Math.round((v - last[k]) / 10 / 1000)]));
  last = { ...bytes };
  samples.push({ s: Math.round((Date.now() - t0) / 1000), tick: h.tick, hz: h.achievedHz, state: h.state, rssMb: +rss().toFixed(1), kbs });
  console.log(JSON.stringify(samples.at(-1)));
}
clearInterval(acker);
for (const ws of socks) ws.close();
host.kill('SIGTERM');
await new Promise((r) => host.on('exit', r));
const a = samples[1] ?? samples[0]; const b = samples.at(-1);
console.log(JSON.stringify({ seconds, ticks: b.tick, rssStartMb: a.rssMb, rssEndMb: b.rssMb, slopeMbPerHour: +(((b.rssMb - a.rssMb) / Math.max(1, b.s - a.s)) * 3600).toFixed(1) }));
const ls = await import('node:fs').then((fs) => fs.readdirSync(join(world, 'snapshots')));
console.log(JSON.stringify({ snapshots: ls }));
