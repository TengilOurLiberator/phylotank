import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashWorld, type WorldConfig } from '../src/core/index.js';
import { startHost } from '../src/host/index.js';
import { HostWorld } from '../src/host/world-host.js';

const CFG: WorldConfig = { preset: 'small', seedLo: 21, seedHi: 5, backend: 'cpu', skeletonMotes: 250 };

describe('kill and resume', () => {
  it('a god command journalled before a crash replays to the same state hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptk-kill-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const worldDir = join(dir, 'world');
    const host = await startHost({ port: 0, staticDir: dir, config: CFG, worldDir, autostart: false });
    host.hw.step(100);
    const r = host.command({ id: 'c1', epoch: 0, t: 'cast', power: 'bloom', target: { kind: 'circle', pos: [8, 4], radius: 3 }, intensity: 0.3, seed: 99 });
    expect(r).toMatchObject({ ok: true, fireTick: 130 });
    expect(r.snapshotId).toBeUndefined(); // a mild bloom is not major
    const m = host.command({ id: 'c2', epoch: 0, t: 'cast', power: 'cull', target: { kind: 'global' }, intensity: 0.5, seed: 3 });
    expect(m.snapshotId).toMatch(/^beforePower-/);
    host.hw.step(500); // fire ticks pass; hash records at 256 and 512
    expect(host.hw.stepErrors).toBeLessThanOrEqual(2); // phase 0: the ecosystem stub throws in applyGodEvent; the host keeps going
    // "kill": no clean stop, no shutdown snapshot. Close the sockets only.
    host.scheduler.stop();
    const live = host.hw.world;
    const liveTick = live.g.tick;
    const b = HostWorld.open({ dir: worldDir, config: CFG, readOnly: true });
    expect(b.recovery.mismatchAt).toBeUndefined();
    expect(b.recovery.hashChecks).toBeGreaterThanOrEqual(1);
    expect(b.tick).toBe(512);
    expect(liveTick).toBe(600);
    // step the recovered world to the live tick: identical
    b.step(liveTick - b.tick);
    expect(hashWorld(b.world)).toBe(hashWorld(live));
    expect(b.world.g.modifiers.map((x) => x.cmdId)).toEqual(live.g.modifiers.map((x) => x.cmdId));
    b.close();
    await host.stop();
  });

  it('a rewind command bumps the epoch, resyncs and rejects the old epoch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptk-rw-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const host = await startHost({ port: 0, staticDir: dir, config: CFG, worldDir: join(dir, 'w'), autostart: false });
    host.hw.step(40);
    const snap = host.command({ id: 's', epoch: 0, t: 'snapshot', label: 'before the storm' });
    expect(snap.snapshotId).toMatch(/^manual-.*before-the-storm$/);
    host.hw.step(60);
    const rw = host.command({ id: 'r', epoch: 0, t: 'rewind', snapshotId: snap.snapshotId! });
    expect(rw.ok).toBe(true);
    expect(host.hw.epoch).toBe(1);
    expect(host.hw.tick).toBe(40);
    expect(host.command({ id: 'x', epoch: 0, t: 'bookmark', label: 'a', pos: [1, 1], zoom: 2 })).toMatchObject({ ok: false, reason: 'stale-epoch' });
    expect(host.command({ id: 'y', epoch: 1, t: 'bookmark', label: 'a', pos: [1, 1], zoom: 2 }).ok).toBe(true);
    await host.stop();
  });
});

describe('host housekeeping', () => {
  it('autosaves on its cadence, caps viewers at 16 and survives junk frames', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptk-house-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const host = await startHost({ port: 0, staticDir: dir, config: CFG, worldDir: join(dir, 'w'), autosaveMs: 100 });
    const before = host.hw.listSnapshots().length;
    await new Promise((r) => setTimeout(r, 1300));
    expect(host.hw.listSnapshots().length).toBeGreaterThan(before);
    const WebSocket = (await import('ws')).default;
    const { encodeCborFrame, FRAME } = await import('../src/core/index.js');
    const open = (): Promise<InstanceType<typeof WebSocket>> => new Promise((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws/v1`);
      ws.on('open', () => { ws.send(encodeCborFrame(FRAME.HELLO, 0, { view: 'wallpaper' })); res(ws); });
    });
    const socks = await Promise.all(Array.from({ length: 17 }, open));
    await new Promise((r) => setTimeout(r, 300));
    expect(host.clients()).toHaveLength(16);
    // junk: short frames, a wrong protocol major, random bytes, text frames
    let seed = 5;
    const rnd = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (const ws of socks.slice(0, 8)) {
      const junk = new Uint8Array(1 + Math.floor(rnd() * 200)).map(() => Math.floor(rnd() * 256));
      junk[0] = [FRAME.VIEWPORT, FRAME.COMMAND, FRAME.ACK, 0x77][Math.floor(rnd() * 4)]!;
      ws.send(junk);
    }
    socks[8]!.send('hello');
    await new Promise((r) => setTimeout(r, 300));
    const h = await fetch(`http://127.0.0.1:${host.port}/health`);
    expect((await h.json() as { ok: boolean }).ok).toBe(true);
    for (const ws of socks) ws.close();
    await host.stop();
  });

  it('streams a whole Default tank to a wallpaper within 3 MB/s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptk-bw-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const host = await startHost({ port: 0, staticDir: dir, config: { preset: 'default', seedLo: 1, seedHi: 2, backend: 'cpu', skeletonMotes: 8192 } });
    const WebSocket = (await import('ws')).default;
    const { encodeCborFrame, FRAME } = await import('../src/core/index.js');
    let bytes = 0;
    const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws/v1`);
    await new Promise<void>((res) => ws.on('open', () => { ws.send(encodeCborFrame(FRAME.HELLO, 0, { view: 'wallpaper' })); res(); }));
    await new Promise((r) => setTimeout(r, 500));
    ws.on('message', (d) => { bytes += (d as Buffer).length; });
    await new Promise((r) => setTimeout(r, 2000));
    const perSec = bytes / 2;
    console.log(`wallpaper stream, 8192 motes, whole Default tank: ${Math.round(perSec / 1000)} KB/s`);
    expect(perSec).toBeGreaterThan(100_000);
    expect(perSec).toBeLessThan(3_000_000);
    ws.close();
    await host.stop();
  });
});
