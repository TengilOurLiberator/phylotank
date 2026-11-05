/**
 * src/sim outside the step: the pacer and its leases, the view streams (CONTRACT 12), the
 * session's commands, and the derived-event detectors (CONTRACT 11).
 */
import { describe, expect, it } from 'vitest';
import {
  decodeBodyEnter, decodeBodyFrame, decodeCborFrame, decodeDust, DUST_EMPTY, encodeCborFrame, encodeViewport, FRAME,
  readHeader, ByteReader, HEADER_BYTES, type SimEvent,
} from '../src/core/index.js';
import { Detectors } from '../src/sim/detectors.js';
import { ViewStream } from '../src/sim/frames.js';
import { drainEvents, fallbackSim as sim, type SimConfig } from '../src/sim/index.js';
import { Pacer, type PacerClock, type PacerStatus } from '../src/sim/pacer.js';
import { SimSession } from '../src/sim/session.js';
import { stateOf } from '../src/sim/state.js';
import { fastGenome } from './sim-helpers.js';

/** A fake clock: timers fire only when the test advances time. */
class FakeClock implements PacerClock {
  t = 0;
  private q: { at: number; fn: () => void }[] = [];
  now(): number { return this.t; }
  setTimer(fn: () => void, ms: number): unknown { const h = { at: this.t + ms, fn }; this.q.push(h); return h; }
  clearTimer(h: unknown): void { this.q = this.q.filter((x) => x !== h); }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at);
      const next = this.q[0];
      if (!next || next.at > end) break;
      this.q.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = end;
  }
}

function makePacer(): { p: Pacer; clock: FakeClock; ticks: { n: number }; statuses: (PacerStatus & { atTick: number })[] } {
  const clock = new FakeClock();
  const ticks = { n: 0 };
  const statuses: (PacerStatus & { atTick: number })[] = [];
  const p = new Pacer({ hz: 30, clock, onTicks: (n) => { ticks.n += n; clock.t += n * 0.05; }, currentTick: () => ticks.n, onStatus: (s) => statuses.push({ ...s, atTick: ticks.n }) });
  return { p, clock, ticks, statuses };
}

describe('pacer (never fast-forward silently)', () => {
  it('runs 30 ticks per wall second at 1x and none while paused', () => {
    const { p, clock, ticks } = makePacer();
    p.start();
    clock.advance(10_000);
    expect(ticks.n).toBeGreaterThanOrEqual(299);
    expect(ticks.n).toBeLessThanOrEqual(301);
    p.setSpeed(0);
    const n0 = ticks.n;
    clock.advance(5_000);
    expect(ticks.n).toBe(n0);
    p.stop();
  });

  it('refuses fast-forward without an attended window or an unattended until', () => {
    const { p, statuses } = makePacer();
    p.start();
    expect(p.request({ speed: 16 })).toBe('needs-attended-window');
    expect(p.request({ speed: 'max', unattended: true })).toBe('unattended-needs-until');
    expect(p.status().speed).toBe(1);
    expect(statuses.every((s) => !s.fastForward)).toBe(true);
    p.stop();
  });

  it('an attended lease runs at 4x and lapses to 1x, reported, when the window detaches', () => {
    const { p, clock, ticks, statuses } = makePacer();
    p.start();
    p.setAttended(true);
    expect(p.request({ speed: 4 })).toBeNull();
    clock.advance(5_000);
    expect(ticks.n).toBeGreaterThan(550);
    expect(statuses.at(-1)).toMatchObject({ speed: 4, fastForward: true, reason: 'command' });
    p.setAttended(false);
    expect(statuses.at(-1)).toMatchObject({ speed: 1, fastForward: false, reason: 'detached' });
    p.stop();
  });

  it('the overnight lease runs at max until its tick, stops exactly there and reports the lapse', () => {
    const { p, clock, ticks, statuses } = makePacer();
    p.start();
    expect(p.request({ speed: 'max', unattended: true, untilTick: 5_000 })).toBeNull();
    clock.advance(2_000);
    // max ran 5,000 ticks in well under 2 s of wall time, then lapsed to 1x exactly at the tick
    expect(statuses.at(-1)).toMatchObject({ speed: 1, reason: 'lease-tick', atTick: 5_000 });
    expect(ticks.n).toBeGreaterThan(5_000);
    expect(ticks.n).toBeLessThanOrEqual(5_000 + 61);
    p.stop();
  });

  it('a wall-time lease lapses at its time', () => {
    const { p, clock, statuses } = makePacer();
    p.start();
    expect(p.request({ speed: 16, unattended: true, untilWallMs: 3_000 })).toBeNull();
    clock.advance(4_000);
    expect(statuses.at(-1)).toMatchObject({ speed: 1, reason: 'lease-wall' });
    p.stop();
  });
});

const cfg = (extra: Partial<SimConfig> = {}): SimConfig => ({
  preset: 'small', seedLo: 77, seedHi: 1, backend: 'cpu', founders: [{ template: 'motefly', count: 40, genome: fastGenome() }], ...extra,
});

describe('view streams (CONTRACT 12)', { timeout: 180_000 }, () => {
  it('streams bodies for big-on-screen creatures with BODY_ENTER before BODY_FRAME and skips them in dust', () => {
    const w = sim.create(cfg());
    const vs = new ViewStream(w);
    // zoom so a 1 mm creature is 20 px long
    vs.setViewport([0, 0, 32, 18], 20_000, false, false);
    const frames = vs.frames(w);
    const types = frames.map((f) => readHeader(f).type);
    expect(types).toEqual([FRAME.BODY_ENTER, FRAME.BODY_FRAME, FRAME.DUST_FRAME]);
    const enter = decodeBodyEnter(frames[0]!);
    expect(enter.length).toBe(40);
    const body = decodeBodyFrame(frames[1]!);
    expect(body.records.length).toBe(40);
    const dust = decodeDust(frames[2]!);
    for (const e of enter) expect(dust.colour[e.slot]).toBe(DUST_EMPTY);
    expect(enter[0]!.genomeKey).toBe(stateOf(w).store.key(w.cr.c.genome[enter[0]!.slot]!));
    // nothing changed: no enter or leave next time
    const again = vs.frames(w).map((f) => readHeader(f).type);
    expect(again).toEqual([FRAME.BODY_FRAME, FRAME.DUST_FRAME]);
  });

  it('sends BODY_LEAVE when a slot changes entity and on resync, before any re-enter', () => {
    const w = sim.create(cfg());
    const vs = new ViewStream(w);
    vs.setViewport([0, 0, 32, 18], 20_000, false, false);
    vs.frames(w);
    vs.setViewport([0, 0, 32, 18], 20_000, false, true);
    const f = vs.frames(w).map((x) => readHeader(x).type);
    expect(f.slice(0, 2)).toEqual([FRAME.BODY_LEAVE, FRAME.BODY_ENTER]);
    // zoom out: everything leaves to dust
    vs.setViewport([0, 0, 32, 18], 60, false, false);
    const out = vs.frames(w);
    expect(readHeader(out[0]!).type).toBe(FRAME.BODY_LEAVE);
    const dust = decodeDust(out.at(-1)!);
    expect([...dust.colour.subarray(0, 40)].every((c) => c !== DUST_EMPTY)).toBe(true);
  });

  it('dust slots are stable: a slot keeps its creature between frames', () => {
    const w = sim.create(cfg());
    const vs = new ViewStream(w);
    const a = decodeDust(vs.frames(w).at(-1)!);
    const ax = a.x.slice(0, a.n);
    sim.step(w); sim.step(w);
    const b = decodeDust(vs.frames(w).at(-1)!);
    for (let s = 0; s < 40; s++) expect(Math.abs(b.x[s]! - ax[s]!)).toBeLessThan(200);
  });
});

describe('session', { timeout: 180_000 }, () => {
  const frames: Uint8Array[] = [];
  const client = { send: (f: Uint8Array): void => { frames.push(f); } };

  it('greets with WELCOME, ENV, CENSUS and a keyframe, then streams at the protocol cadences', () => {
    const s = new SimSession(cfg(), sim);
    s.add(client, ['view']);
    const t0 = frames.map((f) => readHeader(f).type);
    expect(t0.slice(0, 3)).toEqual([FRAME.WELCOME, FRAME.ENV, FRAME.CENSUS]);
    expect(t0).toContain(FRAME.DUST_FRAME);
    frames.length = 0;
    s.tick(60);
    const types = frames.map((f) => readHeader(f).type);
    expect(types.filter((t) => t === FRAME.DUST_FRAME).length).toBe(30);
    expect(types.filter((t) => t === FRAME.ENV).length).toBe(2);
    const census = decodeCborFrame(frames.find((f) => readHeader(f).type === FRAME.CENSUS)!).payload as {
      species: { count: number }[]; heat: Uint8Array; env: { speed: number; fastForward: boolean };
    };
    expect(census.species[0]!.count).toBe(40);
    expect(census.heat.length).toBe(64 * 36 * 4);
    expect(census.env.fastForward).toBe(false);
    expect(types).not.toContain(FRAME.STATS); // view scope
  });

  it('refuses commands from the view scope and stale epochs; schedules casts after the lead time', () => {
    const s = new SimSession(cfg(), sim);
    const got: Uint8Array[] = [];
    const v = { send: (f: Uint8Array): void => { got.push(f); } };
    const g = { send: (f: Uint8Array): void => { got.push(f); } };
    s.add(v, ['view']);
    s.add(g, ['view', 'god']);
    const cast = { t: 'cast', id: 'c1', epoch: 0, power: 'bloom', target: { kind: 'global' }, intensity: 0.3, seed: 9 };
    got.length = 0;
    s.receive(v, encodeCborFrame(FRAME.COMMAND, 0, cast));
    s.receive(g, encodeCborFrame(FRAME.COMMAND, 0, { ...cast, epoch: 5 }));
    s.receive(g, encodeCborFrame(FRAME.COMMAND, 0, cast));
    const res = got.filter((f) => readHeader(f).type === FRAME.COMMAND_RESULT).map((f) => decodeCborFrame(f).payload as { ok: boolean; reason?: string; fireTick?: number });
    expect(res[0]).toMatchObject({ ok: false, reason: 'scope' });
    expect(res[1]).toMatchObject({ ok: false, reason: 'stale-epoch' });
    expect(res[2]).toMatchObject({ ok: true, fireTick: 30 });
    got.length = 0;
    s.tick(31);
    const evs = got.filter((f) => readHeader(f).type === FRAME.EVENT).flatMap((f) => decodeCborFrame(f).payload as unknown as SimEvent[]);
    expect(evs.some((e) => e.k === 'god' && e.t === 30)).toBe(true);
    expect(got.some((f) => readHeader(f).type === FRAME.STATS)).toBe(true);
  });

  it('answers GENOME_REQ from the store and applies VIEWPORT', () => {
    const s = new SimSession(cfg(), sim);
    const got: Uint8Array[] = [];
    const c = { send: (f: Uint8Array): void => { got.push(f); } };
    s.add(c, ['view']);
    const key = stateOf(s.world).store.key(s.world.cr.c.genome[0]!);
    const req = new Uint8Array(HEADER_BYTES + 10);
    req.set([FRAME.GENOME_REQ, 0, 0x00, 0x01]);
    const dv = new DataView(req.buffer);
    dv.setUint16(HEADER_BYTES, 1, true);
    dv.setUint32(HEADER_BYTES + 2, Number(key & 0xffffffffn), true);
    dv.setUint32(HEADER_BYTES + 6, Number(key >> 32n), true);
    got.length = 0;
    s.receive(c, req);
    expect(readHeader(got[0]!).type).toBe(FRAME.GENOME);
    const r = new ByteReader(got[0]!, HEADER_BYTES);
    expect(r.u32()).toBe(Number(key & 0xffffffffn));
    s.receive(c, encodeViewport(0, { rect: [0, 0, 8, 4.5], pxPerM: 20_000, paused: false, resync: false, leadS: 0 }));
    got.length = 0;
    s.tick(2);
    expect(got.some((f) => readHeader(f).type === FRAME.BODY_FRAME)).toBe(true);
  });
});

describe('detectors (CONTRACT 11)', { timeout: 180_000 }, () => {
  const base = { t: 0, eid: 0, epoch: 0 };
  it('turns bites and a kill into a hunt start and a kill end', () => {
    const w = sim.create(cfg({ founders: [] }));
    const d = new Detectors();
    const a = d.observe(w, [{ ...base, k: 'bite', attacker: 1, target: 2, pos: [1, 1], dmg: 0.1 }]);
    expect(a.map((e) => e.k === 'hunt' && e.phase)).toEqual(['start']);
    const b = d.observe(w, [{ ...base, k: 'death', id: 2, species: 1, pos: [1, 1], size: 0.01, cause: 'predation', killer: 1 }]);
    expect(b[0]).toMatchObject({ k: 'hunt', phase: 'end', outcome: 'kill', pred: 1, prey: 2 });
  });

  it('ends a hunt as an escape after the timeout', () => {
    const w = sim.create(cfg({ founders: [] }));
    const d = new Detectors({ huntTimeoutS: 1 });
    d.observe(w, [{ ...base, k: 'bite', attacker: 1, target: 2, pos: [1, 1], dmg: 0.1 }]);
    w.g.tick += 40;
    expect(d.observe(w, [])[0]).toMatchObject({ k: 'hunt', phase: 'end', outcome: 'escape' });
  });

  it('flags giants once, schools of polarised neighbours, and mass deaths over the baseline', () => {
    const w = sim.create(cfg({ founders: [{ template: 'motefly', count: 30, genome: fastGenome() }] }));
    const c = w.cr.c;
    // one giant
    c.length[3] = 0.9 * w.lCeilingM;
    // a school: 12 creatures packed and swimming the same way
    for (let s = 10; s < 22; s++) { c.posX[s] = 5 + (s - 10) * 0.02; c.posY[s] = 5; c.velX[s] = 0.01; c.velY[s] = 0; }
    w.g.tick = 30;
    const d = new Detectors();
    const ev = d.observe(w, []);
    expect(ev.filter((e) => e.k === 'giant').map((e) => (e as { size: number }).size)).toEqual([c.length[3]]);
    const school = ev.find((e) => e.k === 'school');
    expect(school).toMatchObject({ phase: 'start', n: 12 });
    w.g.tick = 60;
    expect(d.observe(w, []).filter((e) => e.k === 'giant').length).toBe(0);
    // mass death: quiet windows, then a burst
    const md = new Detectors({ massWindowS: 1 });
    let out: SimEvent[] = [];
    for (let win = 0; win < 10; win++) {
      w.g.tick = 1000 + win * 30;
      const n = win === 9 ? 40 : 1;
      for (let i = 0; i < n; i++) out = out.concat(md.observe(w, [{ ...base, k: 'death', id: 100 + win * 100 + i, species: 1, pos: [2, 2], size: 0.002, cause: 'disaster' }]));
    }
    w.g.tick += 31;
    out = out.concat(md.observe(w, [{ ...base, k: 'death', id: 5, species: 1, pos: [2, 2], size: 0.002, cause: 'age' }]));
    expect(out.find((e) => e.k === 'massDeath')).toMatchObject({ deaths: 40 });
  });

  it('reports a new species and the last of a species as primitive events from the commit', () => {
    const w = sim.create(cfg({ founders: [{ template: 'motefly', count: 3, genome: fastGenome() }] }));
    const st = stateOf(w);
    // force divergence: an impossible threshold makes every child a new species
    (st.species as unknown as { theta: number }).theta = -1;
    const kinds: string[] = [];
    for (let i = 0; i < 30 * 600 && !(kinds.includes('speciation') && kinds.includes('extinction')); i++) {
      sim.step(w);
      for (const e of drainEvents(w)) kinds.push(e.k);
    }
    expect(kinds).toContain('speciation');
    expect(kinds).toContain('extinction');
  });
});

describe('budget and governor (R4, R16)', () => {
  it('derives the population from the budget table and journals decisions on governor ticks only', async () => {
    const { populationFor, governorEntry, CPU_BUDGET_MS_PER_S } = await import('../src/sim/budget.js');
    const amb = populationFor(CPU_BUDGET_MS_PER_S.ambient, 1, 1);
    expect(amb).toBe(Math.floor((150_000 / 30 - 120) / 1));
    expect(populationFor(150, 16, 1)).toBeLessThan(amb / 10);
    expect(() => governorEntry(301, { state: 'ambient', usPerTick: 2000, meanAgents: 1000, speedX: 1, agentCap: 4096 }, 0)).toThrow();
    const e = governorEntry(600, { state: 'background', usPerTick: 4200, meanAgents: 4000, speedX: 1, agentCap: 4096 }, 0);
    expect(e?.kind).toBe('governor');
    const lim = (e as { decision: { popSoftLimit: number } }).decision.popSoftLimit;
    expect(lim).toBeGreaterThan(2000);
    expect(lim).toBeLessThan(4096);
    // hysteresis: a 5% change is not worth a decision
    expect(governorEntry(900, { state: 'background', usPerTick: 4200 * 0.95, meanAgents: 4000, speedX: 1, agentCap: 4096 }, lim)).toBeNull();
  });
});
