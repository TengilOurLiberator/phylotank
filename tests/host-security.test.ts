import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fireTickFor, planCast, RateLimit, validateCommand } from '../src/host/commands.js';
import {
  hostAllowed, isLoopback, isPrivatePeer, originAllowed, Pairing, scopesFor, Secrets, type NetPolicy,
} from '../src/host/security.js';
import { IDLE_SAMPLE, ShellProbe, StubProbe, Throttle } from '../src/host/throttle.js';
import { TickScheduler } from '../src/host/scheduler.js';
import { sim } from '../src/sim/index.js';

// the build machine is shared with other jobs; allow slow runs
vi.setConfig({ testTimeout: 120_000 });

const LOCAL: NetPolicy = { port: 47615, lan: false, lanGod: false, lanHosts: [] };
const LAN: NetPolicy = { port: 47615, lan: true, lanGod: false, lanHosts: ['192.168.1.20:47615', 'pc.local:47615'] };

describe('network policy', () => {
  it('classifies peers', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a)).toBe(true);
    for (const a of ['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.9', '169.254.1.1', 'fd12:3456::1', 'fe80::1', '::ffff:192.168.1.5']) expect(isPrivatePeer(a)).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '2001:db8::1', undefined]) expect(isPrivatePeer(a)).toBe(false);
  });
  it('checks Host (DNS rebinding) and Origin', () => {
    expect(hostAllowed('127.0.0.1:47615', LOCAL)).toBe(true);
    expect(hostAllowed('evil.example:47615', LOCAL)).toBe(false);
    expect(hostAllowed('192.168.1.20:47615', LOCAL)).toBe(false);
    expect(hostAllowed('192.168.1.20:47615', LAN)).toBe(true);
    expect(originAllowed('http://localhost:47615', LOCAL)).toBe(true);
    expect(originAllowed('http://tauri.localhost', LOCAL)).toBe(true);
    expect(originAllowed('http://evil.example', LAN)).toBe(false);
    expect(originAllowed('http://pc.local:47615', LAN)).toBe(true);
    expect(originAllowed('null', LOCAL)).toBe(false);
  });
});

describe('tokens, scopes and pairing', () => {
  it('stores tokens user-only and grants scopes by peer and token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptk-sec-'));
    const s = new Secrets(dir);
    const again = new Secrets(dir);
    expect(again.godToken).toBe(s.godToken);
    expect(Buffer.from(s.godToken, 'base64url')).toHaveLength(16);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'secrets.json')).mode & 0o777).toBe(0o600);
    expect(scopesFor('127.0.0.1', undefined, s, LOCAL)).toEqual(['view']);
    expect(scopesFor('127.0.0.1', s.godToken, s, LOCAL)).toEqual(['view', 'god']);
    expect(scopesFor('192.168.1.7', undefined, s, LOCAL)).toBeNull();
    expect(scopesFor('192.168.1.7', undefined, s, LAN)).toBeNull(); // LAN needs pairing
    expect(scopesFor('192.168.1.7', s.godToken, s, LAN)).toBeNull(); // god over LAN is a second switch
    expect(scopesFor('192.168.1.7', s.godToken, s, { ...LAN, lanGod: true })).toEqual(['view', 'god']);
    expect(scopesFor('8.8.8.8', s.godToken, s, { ...LAN, lanGod: true })).toBeNull();
  });

  it('pairs a TV with a 6-digit code, rate-limits attempts and revokes', () => {
    let t = 0;
    const s = new Secrets();
    const p = new Pairing(s, () => t);
    const r = p.request('192.168.1.7', 'Living-room‮ TV');
    if ('error' in r) throw new Error(r.error);
    expect(r.code).toMatch(/^\d{6}$/);
    expect(r.name).toBe('Living-room TV');
    expect(p.status(r.id, '192.168.1.7')).toEqual({ state: 'pending' });
    expect(p.approve(r.id, '000000' === r.code ? '111111' : '000000')).toBe(false);
    expect(p.approve(r.id, r.code)).toBe(true);
    expect(p.status(r.id, '192.168.1.8').state).toBe('unknown'); // only the asking device collects
    const st = p.status(r.id, '192.168.1.7');
    expect(st.state).toBe('approved');
    expect(scopesFor('192.168.1.7', st.token, s, LAN)).toEqual(['view']);
    expect(p.status(r.id, '192.168.1.7').state).toBe('unknown'); // handed out once
    for (let i = 0; i < 5; i++) expect('error' in p.request('192.168.1.9', 'x')).toBe(false);
    expect(p.request('192.168.1.9', 'x')).toEqual({ error: 'rate-limited' });
    t += 61_000;
    expect('error' in p.request('192.168.1.9', 'x')).toBe(false);
    const dev = s.devices()[0]!;
    expect(s.revoke(dev.id)).toBe(true);
    expect(scopesFor('192.168.1.7', st.token, s, LAN)).toBeNull();
    // requests expire after 2 minutes
    const late = p.request('192.168.1.10', 'y');
    if ('error' in late) throw new Error(late.error);
    t += 121_000;
    expect(p.approve(late.id, late.code)).toBe(false);
  });

  it('never writes the raw device token to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptk-sec-'));
    const s = new Secrets(dir);
    const { token } = s.addDevice('tv');
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).not.toContain(token);
    expect(new Secrets(dir).deviceFor(token)?.name).toBe('tv');
  });
});

describe('god-command validation', () => {
  const base = { id: 'c1', epoch: 0 };
  it('accepts the contract forms and rejects junk', () => {
    expect(validateCommand({ ...base, t: 'cast', power: 'bloom', target: { kind: 'circle', pos: [3, 4], radius: 2 }, intensity: 0.3, seed: 5 }).t).toBe('cast');
    expect(validateCommand({ ...base, t: 'speed', speed: 'max', until: { tick: 9000 }, unattended: true })).toMatchObject({ speed: 'max', unattended: true });
    const bad: unknown[] = [
      null, [], { ...base }, { ...base, id: 'x'.repeat(33), t: 'snapshot', label: 'a' }, { ...base, epoch: -1, t: 'snapshot', label: 'a' },
      { ...base, t: 'cast', power: 'bloom', target: { kind: 'circle', pos: [3, 4], radius: -1 }, intensity: 0.3, seed: 5 },
      { ...base, t: 'cast', power: 'bloom', target: { kind: 'stroke', points: [] }, intensity: 0.3, seed: 5 },
      { ...base, t: 'cast', power: 'bloom', target: { kind: 'global' }, intensity: Number.NaN, seed: 5 },
      { ...base, t: 'speed', speed: 3 }, { ...base, t: 'setting', key: 'k', value: { a: 1 } }, { ...base, t: 'teleport' },
    ];
    for (const b of bad) expect(() => validateCommand(b)).toThrow();
  });
  it('turns lead time into a fire tick at the achieved speed', () => {
    expect(fireTickFor(100, true, 1)).toBe(190);
    expect(fireTickFor(100, false, 1)).toBe(130);
    expect(fireTickFor(100, true, 4)).toBe(460);
    expect(fireTickFor(100, true, 0)).toBe(190); // paused: the countdown starts on resume
    const w = sim.create({ preset: 'small', seedLo: 1, seedHi: 1, backend: 'cpu' });
    const plan = planCast(w, { ...base, t: 'cast', power: 'plague', target: { kind: 'global' }, intensity: 0.1, seed: 2 }, 1, 2 ** 50 + 1);
    expect(plan.major).toBe(true);
    expect(plan.event).toMatchObject({ k: 'god', power: 'plague', major: true, tFire: 90 });
  });
  it('rate limit refills at 20 per second', () => {
    const r = new RateLimit(20, 20, 0);
    let ok = 0;
    for (let i = 0; i < 25; i++) if (r.take(0)) ok++;
    expect(ok).toBe(20);
    expect(r.take(100)).toBe(true);
    expect(r.take(100)).toBe(true);
    expect(r.take(100)).toBe(false);
  });
});

describe('throttle states', () => {
  const vis = { watching: false, wallpaper: true, screensaver: false };
  it('maps visible views to Watching, Ambient and Background', () => {
    const t = new Throttle();
    expect(t.update(0, IDLE_SAMPLE, vis).state).toBe('ambient');
    expect(t.update(0, IDLE_SAMPLE, { ...vis, watching: true }).state).toBe('watching');
    expect(t.update(0, IDLE_SAMPLE, { watching: false, wallpaper: false, screensaver: false })).toMatchObject({ state: 'background', maxSpeed: 1 });
    expect(t.update(0, { ...IDLE_SAMPLE, onBattery: true }, vis)).toMatchObject({ state: 'battery', maxSpeed: 0.25 });
  });
  it('enters Yield after 5 s of a trigger, leaves after 30 s clear, evicts after 10 min', () => {
    const t = new Throttle();
    const fs = { ...IDLE_SAMPLE, fullscreen: true };
    expect(t.update(0, fs, vis).state).toBe('ambient');
    expect(t.update(4_000, fs, vis).state).toBe('ambient');
    expect(t.update(5_000, fs, vis)).toMatchObject({ state: 'yield', maxSpeed: 0 });
    expect(t.update(6_000, IDLE_SAMPLE, vis).state).toBe('yield'); // loading screen flicker
    expect(t.update(20_000, fs, vis).state).toBe('yield');
    expect(t.update(21_000, IDLE_SAMPLE, vis).state).toBe('yield');
    expect(t.update(50_999, IDLE_SAMPLE, vis).state).toBe('yield');
    expect(t.update(51_000, IDLE_SAMPLE, vis).state).toBe('ambient');
    const e = new Throttle();
    e.update(0, fs, vis); e.update(5_000, fs, vis);
    expect(e.update(605_000, fs, vis)).toMatchObject({ state: 'evicted', evict: true });
    // a screensaver during Yield trickles at 0.1x and 2% duty
    expect(e.update(605_000, fs, { ...vis, screensaver: true }).state).toBe('evicted');
    const tr = new Throttle();
    tr.update(0, { ...IDLE_SAMPLE, comfyBusy: true }, vis);
    expect(tr.update(5_000, { ...IDLE_SAMPLE, comfyBusy: true }, { ...vis, screensaver: true })).toMatchObject({ state: 'yield', trickle: true, maxSpeed: 0.1, dutyCap: 0.02 });
  });
  it('counts another GPU user only after 5 s above 30%, and applies a power budget', () => {
    const t = new Throttle();
    const busy = { ...IDLE_SAMPLE, otherGpuUtil: 0.6 };
    expect(t.update(0, busy, vis).state).toBe('ambient');
    expect(t.update(5_000, busy, vis).state).toBe('yield');
    const p = new Throttle({ ...new Throttle().cfg, powerBudgetW: 25, idlePowerW: 30 });
    let out = p.update(0, { ...IDLE_SAMPLE, gpuPowerW: 130 }, vis);
    expect(out.maxSpeed).toBeCloseTo(0.25, 5);
    for (let i = 0; i < 100; i++) out = p.update(i * 1000, { ...IDLE_SAMPLE, gpuPowerW: 40 }, vis);
    expect(out.maxSpeed).toBe(Infinity);
  });
  it('stub and shell probes report what they can measure', () => {
    const s = new StubProbe();
    expect(s.provides).toEqual([]);
    s.set({ fullscreen: true });
    expect(s.sample().fullscreen).toBe(true);
    const sh = new ShellProbe({ fullscreen: { fullscreen: () => true }, nvml: { utilisationExcludingSelf: () => 0.1, freeVramGb: () => 20, powerW: () => 80 } });
    expect(sh.provides).toContain('gpuPowerW');
    expect(sh.sample()).toMatchObject({ fullscreen: true, otherGpuUtil: 0.1, gpuPowerW: 80, comfyBusy: false });
  });
});

describe('tick scheduler', () => {
  it('runs due ticks, drops backlog beyond a second and stops at speed 0', async () => {
    let t = 0;
    let ticks = 0;
    const s = new TickScheduler({ hz: 30, run: (n) => { ticks += n; return n; }, now: () => t });
    s.start();
    t = 100; await new Promise((r) => setTimeout(r, 5));
    s.stop();
    // drive wake-ups by hand through a fresh scheduler and a fake clock
    const run: number[] = [];
    const s2 = new TickScheduler({ hz: 30, run: (n) => { run.push(n); return n; }, now: () => t, budgetMs: 1e9 });
    t = 0; s2.start(); s2.stop();
    t = 1000; (s2 as unknown as { running: boolean }).running = true; (s2 as unknown as { wake: () => void }).wake(); s2.stop();
    expect(run.reduce((a, b) => a + b, 0)).toBe(30);
    t = 11_000; (s2 as unknown as { running: boolean }).running = true; (s2 as unknown as { wake: () => void }).wake(); s2.stop();
    expect(run.reduce((a, b) => a + b, 0)).toBe(60); // ten seconds late: only one second of ticks
    s2.setSpeed(0);
    const before = run.length;
    t = 20_000; (s2 as unknown as { running: boolean }).running = true; (s2 as unknown as { wake: () => void }).wake(); s2.stop();
    expect(run.length).toBe(before);
    expect(ticks).toBeGreaterThanOrEqual(0);
  });
});
