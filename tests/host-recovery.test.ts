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
