import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { decodeCborFrame, decodeDust, encodeCborFrame, FRAME, readHeader } from '../src/core/index.js';
import { originAllowed, startHost, type RunningHost } from '../src/host/index.js';

let host: RunningHost;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptk-host-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
  host = await startHost({ port: 0, staticDir: dir, config: { preset: 'small', seedLo: 1, seedHi: 2, backend: 'cpu', skeletonMotes: 200 } });
});
afterAll(async () => { await host.stop(); });

describe('host', () => {
  it('serves the manifest and refuses other paths and hosts', async () => {
    const ok = await fetch(`http://127.0.0.1:${host.port}/index.html`);
    expect(ok.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${host.port}/../package.json`)).status).toBe(404);
    expect(originAllowed('http://evil.example', host.port)).toBe(false);
  });
  it('streams WELCOME and DUST_FRAMEs over /ws/v1', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws/v1`);
    const frames: Uint8Array[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(encodeCborFrame(FRAME.HELLO, 0, { view: 'wallpaper' })));
      ws.on('message', (d) => { frames.push(new Uint8Array(d as Buffer)); if (frames.length >= 6) resolve(); });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 5000);
    });
    ws.close();
    const types = frames.map((f) => readHeader(f).type);
    expect(types[0]).toBe(FRAME.WELCOME);
    const welcome = decodeCborFrame(frames[0]!).payload as { tank: { w: number } };
    expect(welcome.tank.w).toBe(32);
    const dust = frames.find((f) => readHeader(f).type === FRAME.DUST_FRAME)!;
    expect(decodeDust(dust).n).toBe(200);
  });
  it('rejects a foreign Origin', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws/v1`, { headers: { origin: 'http://evil.example' } });
    const code = await new Promise<string>((resolve) => { ws.on('error', (e) => resolve(String(e))); ws.on('open', () => resolve('open')); });
    expect(code).not.toBe('open');
  });
});
