import { mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  decodeBodyEnter, decodeBodyFrame, decodeCborFrame, decodeDust, DUST_EMPTY, encodeAck, encodeCborFrame, encodeViewport,
  FRAME, LIFE, readHeader, type WorldConfig,
} from '../src/core/index.js';
import { sim } from '../src/sim/index.js';
import { classify, decodeGlowField, encodeGlowField, entityId, InterestStream, interestRect, SlotMap } from '../src/host/interest.js';
import { startHost, type RunningHost } from '../src/host/index.js';
import { summarise } from '../src/host/summary.js';

// the build machine is shared with other jobs; allow slow runs
vi.setConfig({ testTimeout: 120_000 });

const CFG: WorldConfig = { preset: 'small', seedLo: 11, seedHi: 3, backend: 'cpu', skeletonMotes: 400 };

describe('interest management', () => {
  it('slot maps reuse lowest-first only after the frame that emptied them', () => {
    const m = new SlotMap(10);
    expect([m.alloc(100), m.alloc(101), m.alloc(102)]).toEqual([0, 1, 2]);
    m.release(100);
    expect(m.alloc(103)).toBe(3); // slot 0 is cooling for one frame
    m.settle();
    expect(m.alloc(104)).toBe(0);
    m.release(103); m.release(102); m.settle();
    expect(m.extent).toBe(2); // the top shrinks
  });

  it('grows the viewport by 25% and stretches it towards the predicted motion', () => {
    expect(interestRect([10, 10, 20, 20], 0.25, [0, 0])).toEqual([7.5, 7.5, 22.5, 22.5]);
    expect(interestRect([10, 10, 20, 20], 0.25, [3, -2])).toEqual([7.5, 5.5, 25.5, 22.5]);
  });

  it('classifies by projected size and respects the body budget', () => {
    const w = sim.create(CFG);
    const all: [number, number, number, number] = [0, 0, w.preset.widthM, w.preset.heightM];
    // motes are 1 to 5 mm long: at 2000 px/m they are 2 to 10 px
    const near = classify(w, all, 2000, { maxBodies: 1e6, maxDust: 1e6 });
    expect(near.body.length + near.dust.length).toBe(400);
    for (const s of near.body) expect(w.cr.c.length[s]! * 2000).toBeGreaterThanOrEqual(4);
    for (const s of near.dust) expect(w.cr.c.length[s]! * 2000).toBeLessThan(4);
    const far = classify(w, all, 50, { maxBodies: 1e6, maxDust: 1e6 });
    expect(far.glow.length).toBe(400); // under 0.5 px
    const capped = classify(w, all, 2000, { maxBodies: 10, maxDust: 20 });
    expect(capped.body).toHaveLength(10);
    expect(capped.dust).toHaveLength(20);
    expect(capped.glow).toHaveLength(370);
    // the kept bodies are the largest
    const minKept = Math.min(...capped.body.map((s) => w.cr.c.length[s]!));
    const maxDropped = Math.max(...capped.dust.map((s) => w.cr.c.length[s]!));
    expect(minKept).toBeGreaterThanOrEqual(maxDropped);
    const hero = capped.dust[0]!;
    const withHero = classify(w, all, 2000, { maxBodies: 10, maxDust: 20 }, (id) => (id === entityId(w, hero) ? 10 : 0));
    expect(withHero.body).toContain(hero);
  });

  it('keeps body slots stable across frames and sends ENTER and LEAVE on tier changes', () => {
    const w = sim.create(CFG);
    const st = new InterestStream({ maxBodies: 50, maxDust: 1000 });
    st.setViewport({ rect: [0, 0, 16, 9], pxPerM: 2000, paused: false, resync: false, leadS: 0 }, 0);
    const first = st.update(w);
    const enters = first.filter((f) => readHeader(f).type === FRAME.BODY_ENTER).flatMap(decodeBodyEnter);
    expect(enters.length).toBe(st.bodies.size);
    expect(enters.length).toBeLessThanOrEqual(50);
    const slotOf = new Map(enters.map((e) => [e.id, e.slot]));
    for (let i = 0; i < 20; i++) sim.step(w);
    const again = st.update(w);
    // nothing left the tier in 20 ticks of slow drift, so slots are unchanged
    for (const [id, slot] of slotOf) if (st.bodies.slotOf(id) !== undefined) expect(st.bodies.slotOf(id)).toBe(slot);
    const bf = decodeBodyFrame(st.bodyFrame(w));
    expect(bf.records.length).toBe(st.bodies.size);
    expect(again.every((f) => [FRAME.BODY_ENTER, FRAME.BODY_LEAVE].includes(readHeader(f).type as 0x10))).toBe(true);
    // zoom out: everything becomes glow, so every body leaves
    st.setViewport({ rect: [0, 0, 32, 18], pxPerM: 10, paused: false, resync: false, leadS: 0 }, 1000);
    const out = st.update(w);
    const leave = out.find((f) => readHeader(f).type === FRAME.BODY_LEAVE)!;
    expect(new DataView(leave.buffer, leave.byteOffset).getUint16(8, true)).toBe(enters.length);
    expect(st.bodies.size).toBe(0);
    const glow = decodeGlowField(st.glowFrame(w));
    expect(glow.w * glow.h * 4).toBe(glow.rgba.length);
    expect(glow.rgba.some((v) => v > 0)).toBe(true);
  });

  it('sends the whole tank as dust to a view without a viewport (phase-0 views)', () => {
    const w = sim.create(CFG);
    const st = new InterestStream();
    st.update(w);
    const d = decodeDust(st.dustFrameBytes(w));
    expect(d.n).toBe(400);
    expect([...d.colour.subarray(0, d.n)].filter((c) => c !== DUST_EMPTY)).toHaveLength(400);
  });

  it('splats glow additively inside the rect only', () => {
    const w = sim.create(CFG);
    const live = [...Array(w.cr.highWater).keys()].filter((s) => w.cr.c.life[s] === LIFE.ALIVE);
    const f = decodeGlowField(encodeGlowField(w, 0, [0, 0, 1, 1], live, 8, 8));
    const inside = live.filter((s) => w.cr.c.posX[s]! < 1 && w.cr.c.posY[s]! < 1).length;
    const alpha = [...Array(64).keys()].reduce((a, i) => a + f.rgba[i * 4 + 3]!, 0);
    expect(alpha > 0).toBe(inside > 0);
  });

  it('summarises the whole tank once per second for the director and stats', () => {
    const w = sim.create(CFG);
    const s = summarise(w);
    expect(s.population).toBe(400);
    expect(s.species.reduce((a, r) => a + r.count, 0)).toBe(400);
    expect(s.heat).toHaveLength(64 * 36 * 4);
  });
});

// ---------------- the running host: several viewers of one world ----------------
let host: RunningHost;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptk-host-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
  host = await startHost({ port: 0, staticDir: dir, config: CFG, worldDir: join(dir, 'world') });
});
afterAll(async () => { await host.stop(); });

interface Conn { ws: WebSocket; frames: Uint8Array[]; wait(pred: (f: Uint8Array) => boolean, ms?: number): Promise<Uint8Array> }
function connect(hello: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws/v1`, { headers });
    const frames: Uint8Array[] = [];
    const waiters: { pred: (f: Uint8Array) => boolean; res: (f: Uint8Array) => void }[] = [];
    ws.on('message', (d) => {
      const f = new Uint8Array(d as Buffer);
      frames.push(f);
      for (const w of [...waiters]) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); w.res(f); }
    });
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(encodeCborFrame(FRAME.HELLO, 0, hello as never));
      resolve({
        ws, frames,
        wait: (pred, ms = 4000) => new Promise((res, rej) => {
          const hit = frames.find(pred);
          if (hit) { res(hit); return; }
          waiters.push({ pred, res });
          setTimeout(() => rej(new Error('timeout waiting for a frame')), ms);
        }),
      });
    });
  });
}
const ofType = (t: number) => (f: Uint8Array): boolean => readHeader(f).type === t;

describe('host streaming to several viewers', () => {
  it('gives each viewer its own interest rect and LOD', async () => {
    const wall = await connect({ view: 'wallpaper' });
    const zoom = await connect({ view: 'screensaver', caps: { maxBodies: 30 } });
    const god = await connect({ view: 'god', token: host.godToken });
    const welcome = decodeCborFrame(await god.wait(ofType(FRAME.WELCOME))).payload as { scopes: string[] };
    expect(welcome.scopes).toEqual(['view', 'god']);
    const wallWelcome = decodeCborFrame(await wall.wait(ofType(FRAME.WELCOME))).payload as { scopes: string[] };
    expect(wallWelcome.scopes).toEqual(['view']);
    zoom.ws.send(encodeViewport(0, { rect: [4, 2, 12, 6.5], pxPerM: 2000, paused: false, resync: true, leadS: 0.5 }));
    const enter = decodeBodyEnter(await zoom.wait(ofType(FRAME.BODY_ENTER)));
    expect(enter.length).toBeGreaterThan(0);
    expect(enter.length).toBeLessThanOrEqual(30);
    const bf = decodeBodyFrame(await zoom.wait(ofType(FRAME.BODY_FRAME)));
    expect(bf.rect[0]).toBeLessThan(4);
    const dust = decodeDust(await wall.wait(ofType(FRAME.DUST_FRAME)));
    expect(dust.n).toBe(400);
    await god.wait(ofType(FRAME.STATS));
    await wall.wait(ofType(FRAME.CENSUS), 3000);
    expect(wall.frames.some(ofType(FRAME.STATS))).toBe(false);
    expect(host.clients()).toHaveLength(3);
    for (const c of [wall, zoom, god]) c.ws.close();
  });

  it('journals god commands, snapshots before major powers and rejects stale epochs and views', async () => {
    const god = await connect({ view: 'god', token: host.godToken });
    const view = await connect({ view: 'wallpaper' });
    await god.wait(ofType(FRAME.WELCOME));
    const epoch = host.hw.epoch;
    god.ws.send(encodeCborFrame(FRAME.COMMAND, 0, { id: 'm1', epoch, t: 'cast', power: 'meteor', target: { kind: 'point', pos: [10, 5] }, intensity: 0.8, seed: 7 }));
    const r1 = decodeCborFrame(await god.wait(ofType(FRAME.COMMAND_RESULT))).payload as { ok: boolean; snapshotId?: string; fireTick: number; eventId: number };
    expect(r1.ok).toBe(true);
    expect(r1.snapshotId).toMatch(/^beforePower-.*-meteor$/);
    const queued = host.hw.pendingEntries().find((e) => e.kind === 'god' && e.ev.cmdId === 'm1');
    expect(queued?.kind === 'god' && queued.ev.fireTick - queued.ev.issuedTick).toBe(90); // 3 s lead at 1x
    expect(r1.fireTick).toBe(queued!.tick);
    const ev = await view.wait((f) => readHeader(f).type === FRAME.EVENT && (decodeCborFrame(f).payload as { k: string }[]).some((e) => e.k === 'god'));
    expect((decodeCborFrame(ev).payload as { cmdId: string }[])[0]!.cmdId).toBe('m1');
    god.ws.send(encodeCborFrame(FRAME.COMMAND, 0, { id: 'm2', epoch: epoch + 5, t: 'cast', power: 'bloom', target: { kind: 'global' }, intensity: 0.2, seed: 1 }));
    const r2 = decodeCborFrame(await god.wait((f) => ofType(FRAME.COMMAND_RESULT)(f) && (decodeCborFrame(f).payload as { id: string }).id === 'm2')).payload as { ok: boolean; reason: string };
    expect(r2).toMatchObject({ ok: false, reason: 'stale-epoch' });
    view.ws.send(encodeCborFrame(FRAME.COMMAND, 0, { id: 'v1', epoch, t: 'snapshot', label: 'x' }));
    const r3 = decodeCborFrame(await view.wait(ofType(FRAME.COMMAND_RESULT))).payload as { ok: boolean; reason: string };
    expect(r3).toMatchObject({ ok: false, reason: 'forbidden' });
    god.ws.send(encodeCborFrame(FRAME.COMMAND, 0, { id: 'b1', epoch, t: 'cast', power: 'nope', target: { kind: 'global' }, intensity: 2, seed: 1 }));
    const r4 = decodeCborFrame(await god.wait((f) => ofType(FRAME.COMMAND_RESULT)(f) && (decodeCborFrame(f).payload as { id: string }).id === 'b1')).payload as { reason: string };
    expect(r4.reason).toBe('unknown-power');
    god.ws.close(); view.ws.close();
  });

  it('rate-limits commands to 20 per second', async () => {
    const god = await connect({ view: 'god', token: host.godToken });
    await god.wait(ofType(FRAME.WELCOME));
    // `select` is not journalled, so no fsync slows the burst down
    for (let i = 0; i < 60; i++) god.ws.send(encodeCborFrame(FRAME.COMMAND, 0, { id: `b${i}`, epoch: host.hw.epoch, t: 'select', entity: 1, pin: false }));
    await god.wait((f) => ofType(FRAME.COMMAND_RESULT)(f) && (decodeCborFrame(f).payload as { id: string }).id === 'b59', 15_000);
    const results = god.frames.filter(ofType(FRAME.COMMAND_RESULT)).map((f) => decodeCborFrame(f).payload as { ok: boolean; reason?: string });
    expect(results.filter((r) => r.reason === 'rate-limited').length).toBeGreaterThanOrEqual(5);
    god.ws.close();
  });

  it('stops streaming to a frozen view and resumes on ACK', async () => {
    const v = await connect({ view: 'wallpaper' });
    await v.wait(ofType(FRAME.DUST_FRAME));
    v.ws.send(encodeAck(1));
    await new Promise((r) => setTimeout(r, 50));
    const c = host.clients().find((x) => x.view === 'wallpaper')!;
    c.lastAckMs = performance.now() - 5000;
    host.pump();
    expect(c.frozen).toBe(true);
    await new Promise((r) => setTimeout(r, 100)); // frames already in flight
    const n = v.frames.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(v.frames.length).toBe(n);
    v.ws.send(encodeAck(2));
    await new Promise((r) => setTimeout(r, 300));
    expect(v.frames.length).toBeGreaterThan(n);
    v.ws.close();
  });

  it('refuses a foreign Origin, a foreign Host and an unpaired god page from serving its token', async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${host.port}/ws/v1`, { headers: { origin: 'http://evil.example' } });
    expect(await new Promise<string>((r) => { bad.on('error', () => r('error')); bad.on('open', () => r('open')); })).toBe('error');
    const rebind = await new Promise<number>((resolve) => {
      request({ host: '127.0.0.1', port: host.port, path: '/index.html', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).end();
    });
    expect(rebind).toBe(421);
    const health = await fetch(`http://127.0.0.1:${host.port}/health`, { headers: { origin: 'null' } });
    expect(await health.json()).toEqual({ ok: true });
    const pair = await fetch(`http://127.0.0.1:${host.port}/pair/request`, { method: 'POST', body: '{}' });
    expect(pair.status).toBe(403); // LAN serving is off by default
    const pending = await fetch(`http://127.0.0.1:${host.port}/pair/pending`);
    expect(pending.status).toBe(403);
    const ok = await fetch(`http://127.0.0.1:${host.port}/pair/pending`, { headers: { authorization: `Bearer ${host.godToken}` } });
    expect(ok.status).toBe(200);
    const noTokenGod = await connect({ view: 'god' });
    const w = decodeCborFrame(await noTokenGod.wait(ofType(FRAME.WELCOME))).payload as { scopes: string[] };
    expect(w.scopes).toEqual(['view']);
    noTokenGod.ws.close();
  });
});
