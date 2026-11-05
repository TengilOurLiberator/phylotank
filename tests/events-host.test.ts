/**
 * Protocol 1.1 through the running host: a view that says `caps.proto: 0x0101` in HELLO gets
 * delta BODY_FRAMEs that decode cleanly; a 1.0 view next to it gets keyframes only.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  BodyDeltaDecoder, decodeBodyFrame, encodeCborFrame, encodeViewport, FRAME, FRAME_FLAG, readHeader, type WorldConfig,
} from '../src/core/index.js';
import { startHost, type RunningHost } from '../src/host/index.js';

vi.setConfig({ testTimeout: 120_000 });

const CFG: WorldConfig = { preset: 'small', seedLo: 21, seedHi: 4, backend: 'cpu', skeletonMotes: 400 };
let host: RunningHost;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptk-events-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
  host = await startHost({ port: 0, staticDir: dir, config: CFG, worldDir: join(dir, 'world') });
});
afterAll(async () => { await host.stop(); });

function connect(hello: Record<string, unknown>): Promise<{ ws: WebSocket; bodies: Uint8Array[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws/v1`);
    const bodies: Uint8Array[] = [];
    ws.on('message', (d) => { const f = new Uint8Array(d as Buffer); if (readHeader(f).type === FRAME.BODY_FRAME) bodies.push(f); });
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(encodeCborFrame(FRAME.HELLO, 0, hello as never));
      ws.send(encodeViewport(0, { rect: [0, 0, 32, 18], pxPerM: 40000, paused: false, resync: true, leadS: 0 }));
      resolve({ ws, bodies });
    });
  });
}

describe('protocol 1.1 through the host', () => {
  it('sends deltas only to the view that asked, and they decode', async () => {
    const v10 = await connect({ view: 'screensaver', caps: { maxBodies: 500 } });
    const v11 = await connect({ view: 'screensaver', caps: { maxBodies: 500, proto: 0x0101 } });
    // the real modules tick slowly on a loaded machine: wait for frames rather than for a fixed time
    for (let i = 0; i < 600 && (v10.bodies.length < 8 || v11.bodies.length < 8); i++) await new Promise((r) => setTimeout(r, 100));
    v10.ws.close(); v11.ws.close();
    expect(v10.bodies.length).toBeGreaterThanOrEqual(8);
    expect(v11.bodies.length).toBeGreaterThanOrEqual(8);
    for (const f of v10.bodies) { expect(readHeader(f).flags & FRAME_FLAG.KEYFRAME).toBe(FRAME_FLAG.KEYFRAME); decodeBodyFrame(f); }
    const dec = new BodyDeltaDecoder();
    let deltas = 0; let b10 = 0; let b11 = 0;
    for (const f of v11.bodies) { if ((readHeader(f).flags & FRAME_FLAG.KEYFRAME) === 0) deltas++; expect(dec.decode(f).records.length).toBeGreaterThan(0); }
    for (const f of v10.bodies) b10 += f.length;
    for (const f of v11.bodies) b11 += f.length;
    expect(deltas).toBeGreaterThan(v11.bodies.length / 2);
    expect(b11 / v11.bodies.length).toBeLessThan(0.7 * (b10 / v10.bodies.length));
  });
});
