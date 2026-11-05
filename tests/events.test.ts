/**
 * Event detectors, second pass (src/sim/events): each detector on a synthetic world where its
 * event is staged, determinism and read-only checks, and the measured cost per tick.
 */
import { describe, expect, it, vi } from 'vitest';
import { hashWorld, LIFE, NONE_U32, ORGAN, type SimEvent, type World, type WorldConfig } from '../src/core/index.js';
import { createSim, drainEvents, fallbackModules, sim as productSim } from '../src/sim/index.js';
import { EventSuite, type Derived } from '../src/sim/events/index.js';
import { BloomDetector } from '../src/sim/events/bloom.js';
import { CarcassDetector } from '../src/sim/events/carcass.js';
import { LineageDetector } from '../src/sim/events/lineage.js';
import { MigrationDetector } from '../src/sim/events/migration.js';
import { NoveltyDetector, describe as describePlan } from '../src/sim/events/novelty.js';
import { OutbreakDetector } from '../src/sim/events/outbreak.js';
import { RecordDetector } from '../src/sim/events/records.js';
import { RoleDetector } from '../src/sim/events/roles.js';
import { Scanner } from '../src/sim/events/scan.js';
import type { Detector } from '../src/sim/events/types.js';

vi.setConfig({ testTimeout: 120_000 });

/** Staged worlds use the fallback modules (one capsule part, plain motes): the detectors are under test, not the modules. */
const sim = createSim(fallbackModules());

const CFG: WorldConfig = { preset: 'small', seedLo: 7, seedHi: 1, backend: 'cpu', skeletonMotes: 300 };
const base = { eid: 0, epoch: 0 };

function world(n = 300): World {
  const w = sim.create({ ...CFG, skeletonMotes: n });
  const c = w.cr.c;
  // spread everyone over a lattice, still and adult, so nothing is staged by accident
  let k = 0;
  for (let s = 0; s < w.cr.highWater; s++) {
    if (c.life[s] !== LIFE.ALIVE) continue;
    c.posX[s] = 1 + (k % 30) * 1.0; c.posY[s] = 1 + Math.floor(k / 30) * 1.5; c.velX[s] = 0; c.velY[s] = 0;
    c.maturity[s] = 1; c.birthTick[s] = 0; k++;
  }
  return w;
}

/** Run one detector at tick t over a fresh scan. */
function runAt(d: Detector, w: World, t: number, scanner = new Scanner()): Derived[] {
  w.g.tick = t;
  const out: Derived[] = [];
  d.run!(scanner.scan(w), out);
  return out;
}

function aliveOf(w: World, species?: number): number[] {
  const c = w.cr.c; const r: number[] = [];
  for (let s = 0; s < w.cr.highWater; s++) if (c.life[s] === LIFE.ALIVE && (species === undefined || c.species[s] === species)) r.push(s);
  return r;
}

describe('event suite', () => {
  it('never writes sim state and is deterministic (real modules)', () => {
    const sim = productSim;
    const outs: string[] = [];
    for (let rep = 0; rep < 2; rep++) {
      const w = sim.create({ ...CFG, skeletonMotes: 120 });
      const suite = new EventSuite();
      const got: Derived[] = [];
      for (let i = 0; i < 90; i++) {
        sim.step(w);
        const ev = drainEvents(w);
        if (i % 60 === 30) {
          const h = hashWorld(w);
          got.push(...suite.observe(w, ev), ...suite.run(w));
          expect(hashWorld(w)).toBe(h);
        } else got.push(...suite.observe(w, ev), ...suite.run(w));
      }
      outs.push(JSON.stringify(got));
    }
    expect(outs[0]).toBe(outs[1]);
  });
});

describe('carcass and frenzy', () => {
  it('reports a whale fall once, its crowd, its settling on the floor and its end', () => {
    const w = world();
    const c = w.cr.c;
    const d = new CarcassDetector();
    expect(runAt(d, w, 30)).toEqual([]);
    const [k, ...rest] = aliveOf(w);
    c.life[k!] = LIFE.CARCASS; c.length[k!] = 0.4 * w.lCeilingM; c.massKg[k!] = 0.05; c.posX[k!] = 16; c.posY[k!] = 9; c.velY[k!] = -0.01;
    const a = runAt(d, w, 60);
    expect(a).toEqual([expect.objectContaining({ k: 'carcass', phase: 'start', scavengers: 0, fall: false, size: c.length[k!], pos: [16, 9], durationS: 0 })]);
    // a crowd of grazers gathers: not a frenzy once diets are known
    for (const s of rest) c.diet[7 * s] = 1;
    rest.slice(0, 8).forEach((s, i) => { c.posX[s] = 16 + 0.02 * i; c.posY[s] = 9.01; });
    expect(runAt(d, w, 75).filter((e) => e.k === 'frenzy')).toEqual([]);
    // three of them eat meat
    rest.slice(0, 3).forEach((s) => { c.diet[7 * s + 4] = 1; });
    const b = runAt(d, w, 90);
    expect(b.filter((e) => e.k === 'carcass')).toEqual([]); // updates wait 30 s
    expect(b.filter((e) => e.k === 'frenzy')).toEqual([expect.objectContaining({ phase: 'start', n: 8, feeding: 3, carcass: expect.any(Number) })]);
    // it sinks to the floor and lies still: a whale fall
    c.posY[k!] = w.preset.heightM - 0.05; c.velY[k!] = 0;
    rest.slice(0, 8).forEach((s) => { c.posY[s] = w.preset.heightM - 0.06; });
    const f = runAt(d, w, 90 + 31 * 30);
    expect(f.find((e) => e.k === 'carcass')).toMatchObject({ phase: 'update', fall: true, durationS: (90 + 31 * 30 - 60) / 30 });
    // eaten away
    c.life[k!] = LIFE.FREE;
    const e = runAt(d, w, 2000);
    expect(e.map((x) => [x.k, (x as { phase: string }).phase])).toEqual([['carcass', 'end'], ['frenzy', 'end']]);
  });

  it('ignores small corpses and stays bounded in a corpse flood', () => {
    const w = world(3000);
    const c = w.cr.c;
    const d = new CarcassDetector({ maxCarcasses: 64 });
    for (const s of aliveOf(w).slice(0, 2500)) { c.life[s] = LIFE.CARCASS; c.length[s] = 0.003; }
    expect(runAt(d, w, 30)).toEqual([]);
    for (const s of aliveOf(w).slice(0, 10)) { c.life[s] = LIFE.CARCASS; c.length[s] = 0.5 * w.lCeilingM; }
    expect(runAt(d, w, 60).filter((e) => e.k === 'carcass')).toHaveLength(10);
  });
});

describe('migration', () => {
  it('reports a species rising through the column, then the same migration continuing', () => {
    const w = world();
    const c = w.cr.c;
    const sp = c.species[aliveOf(w)[0]!]!;
    const d = new MigrationDetector({ windowS: 10, everyS: 1 });
    const out: Derived[] = [];
    for (let k = 0; k < 40; k++) {
      for (const s of aliveOf(w, sp)) c.posY[s] = Math.max(0.1, c.posY[s]! - 0.5);
      out.push(...runAt(d, w, 30 * (k + 1)));
    }
    const m = out.filter((e) => e.k === 'migration');
    expect(m[0]).toMatchObject({ species: sp, direction: 'up', phase: 'start' });
    expect(m[0]!.durationS).toBeGreaterThanOrEqual(9);
    expect(m.slice(1).every((e) => (e as { phase: string }).phase === 'update')).toBe(true);
    expect((m[0] as { pos: number[] }).pos).toHaveLength(2);
  });

  it('stays quiet for a species that only jitters', () => {
    const w = world();
    const c = w.cr.c;
    const d = new MigrationDetector({ windowS: 10 });
    const out: Derived[] = [];
    for (let k = 0; k < 40; k++) {
      for (const s of aliveOf(w)) c.posY[s] = c.posY[s]! + (k % 2 ? 0.3 : -0.3);
      out.push(...runAt(d, w, 30 * (k + 1)));
    }
    expect(out).toEqual([]);
  });
});

describe('bloom and bloomFront', () => {
  it('finds a bloom, follows its advancing front and its end', () => {
    const w = world();
    const q = w.fields.qP;
    const [fw] = w.fields.fine;
    q.fill(100);
    const d = new BloomDetector({ warmupRuns: 3 });
    const sc = new Scanner();
    const all: Derived[] = [];
    let t = 0;
    const step = (): Derived[] => { t += 30; const o = runAt(d, w, t, sc); all.push(...o); return o; };
    for (let i = 0; i < 6; i++) expect(step()).toEqual([]);
    // the day cycle lifts every block together: not a bloom
    q.fill(300);
    expect(step()).toEqual([]);
    for (let i = 0; i < 200; i++) step(); // let the baseline settle at 300
    expect(all).toEqual([]);
    // a 3 x 3 m patch blooms at x 4..7, y 4..7 (16 fine cells per metre)
    const patch = (x0: number, x1: number): void => {
      for (let y = 4 * 16; y < 7 * 16; y++) for (let x = x0 * 16; x < x1 * 16; x++) q[y * fw + x] = 3000;
    };
    patch(4, 7);
    const s1 = step();
    expect(s1).toEqual([expect.objectContaining({ k: 'bloom', phase: 'start', areaM2: 9 })]);
    const b = s1[0] as { pos: number[]; radius: number };
    expect(b.pos[0]).toBeCloseTo(5.5, 5); expect(b.pos[1]).toBeCloseTo(5.5, 5);
    // it spreads east
    for (let i = 0; i < 10; i++) step();
    patch(7, 10);
    const s2 = step();
    const front = s2.find((e) => e.k === 'bloomFront') as { pos: number[]; dir: number[]; radius: number } | undefined;
    expect(front).toBeDefined();
    expect(front!.pos[0]).toBeCloseTo(8.5, 5);
    expect(front!.dir[0]).toBeGreaterThan(0.99);
    expect(s2.filter((e) => e.k === 'bloom')).toEqual([]);
    q.fill(300);
    expect(step()).toEqual([expect.objectContaining({ k: 'bloom', phase: 'end' })]);
  });
  it('sweeps a big grid over several runs and finds the same bloom', () => {
    const w = world();
    const q = w.fields.qP;
    const [fw] = w.fields.fine;
    q.fill(100);
    const d = new BloomDetector({ warmupRuns: 3, cellsPerRun: 512 * 72 });
    expect(d.slicesFor(w)).toBe(4);
    const sc = new Scanner();
    const out: Derived[] = [];
    let t = 0;
    for (let i = 0; i < 40; i++) { t += 30; out.push(...runAt(d, w, t, sc)); }
    expect(out).toEqual([]);
    for (let y = 4 * 16; y < 7 * 16; y++) for (let x = 4 * 16; x < 7 * 16; x++) q[y * fw + x] = 3000;
    const after: number[] = [];
    for (let i = 0; i < 8; i++) { t += 30; const o = runAt(d, w, t, sc); if (o.length) after.push(i); out.push(...o); }
    expect(out).toEqual([expect.objectContaining({ k: 'bloom', phase: 'start', areaM2: 9 })]);
    expect(after[0]).toBeLessThan(4);
  });
});

describe('records', () => {
  it('reports new holders of size, speed and age records, not a holder creeping up', () => {
    const w = world();
    const c = w.cr.c;
    const d = new RecordDetector({ warmupS: 10, cooldownS: 600 });
    const sc = new Scanner();
    const [a, b, e] = aliveOf(w);
    for (const s of aliveOf(w)) c.length[s] = 0.002;
    c.length[a!] = 0.004;
    expect(runAt(d, w, 30, sc)).toEqual([]);
    expect(runAt(d, w, 600, sc)).toEqual([]);
    // the holder grows 10%: silent
    c.length[a!] = 0.0044;
    expect(runAt(d, w, 630, sc)).toEqual([]);
    // a new creature beats it by 10%
    c.length[b!] = 0.0049;
    expect(runAt(d, w, 660, sc)).toEqual([expect.objectContaining({ k: 'record', kind: 'size', value: c.length[b!], prev: c.length[a!], size: c.length[b!] })]);
    // another 6% within the cooldown: silent; 25%: news
    c.length[e!] = 0.0052;
    expect(runAt(d, w, 690, sc)).toEqual([]);
    c.length[a!] = 0.0068;
    expect(runAt(d, w, 720, sc).map((x) => x.k)).toEqual(['record']);
    // speed: must last two runs
    c.velX[e!] = 0.05;
    expect(runAt(d, w, 750, sc).filter((x) => (x as { kind: string }).kind === 'speed')).toEqual([]);
    c.velX[b!] = 0.02;
    const sp1 = runAt(d, w, 780, sc).filter((x) => (x as { kind: string }).kind === 'speed');
    expect(sp1).toEqual([]); // the first sustained speed sets the bar
    c.velX[b!] = 0.1;
    runAt(d, w, 810, sc);
    const sp2 = runAt(d, w, 840, sc).filter((x) => (x as { kind: string }).kind === 'speed');
    expect(sp2).toEqual([expect.objectContaining({ kind: 'speed', value: expect.closeTo(0.1, 6) })]);
    // age: someone older than anyone (a, the oldest so far, only ageing is not news)
    expect(runAt(d, w, 870, sc).filter((x) => (x as { kind: string }).kind === 'age')).toEqual([]);
    c.birthTick[e!] = -100_000;
    expect(runAt(d, w, 900, sc).filter((x) => (x as { kind: string }).kind === 'age')).toEqual([expect.objectContaining({ kind: 'age' })]);
  });
});

describe('novelty', () => {
  /** Give slot s a body of n parts with organs, in a free segment range, and a fresh genome handle. */
  function body(w: World, s: number, organs: number[], handle: number, at: number): void {
    const c = w.cr.c; const g = w.seg.c;
    c.segStart[s] = at; c.segCount[s] = organs.length; c.genome[s] = handle; c.maturity[s] = 1;
    organs.forEach((o, k) => { g.parent[at + k] = k === 0 ? -1 : k - 1; g.kind[at + k] = k % 3; g.organs[at + k] = o; g.len[at + k] = 0.002; g.radius[at + k] = 0.0005; });
  }

  it('fires for a new body plan and not for near copies of known ones', () => {
    const w = world();
    const d = new NoveltyDetector({ warmupS: 5, k: 3 });
    const sc = new Scanner();
    expect(runAt(d, w, 30, sc)).toEqual([]);
    expect(d.archiveSize()).toBe(1); // every founder shares one plan
    const s = aliveOf(w);
    const top = w.seg.c.owner.length - 200;
    body(w, s[0]!, [ORGAN.HEAD | ORGAN.EYE | ORGAN.MOUTH, ORGAN.JET, ORGAN.CLAW, ORGAN.CLAW, ORGAN.PHOTOPHORE, 0], 900_001, top);
    const a = runAt(d, w, 600, sc);
    expect(a).toEqual([expect.objectContaining({ k: 'novelty', morphCluster: expect.any(Number), plan: expect.stringContaining('6 parts') })]);
    expect((a[0] as { distance: number }).distance).toBeGreaterThan(d.rho / 1.1);
    // a near copy (one organ different) is not news
    body(w, s[1]!, [ORGAN.HEAD | ORGAN.EYE | ORGAN.MOUTH, ORGAN.JET, ORGAN.CLAW, ORGAN.CLAW, ORGAN.PHOTOPHORE, ORGAN.PHOTOPHORE], 900_002, top + 20);
    expect(runAt(d, w, 630, sc)).toEqual([]);
    // the same genome is described once only
    expect(runAt(d, w, 660, sc)).toEqual([]);
    expect(describePlan(w, s[0]!)[0]).toBeCloseTo(Math.log2(7), 10);
  });
});

describe('outbreak and epidemicFront', () => {
  it('starts, spreads with a front, and ends', () => {
    const w = world(600);
    const c = w.cr.c;
    const sp = c.species[aliveOf(w)[0]!]!;
    const hosts = aliveOf(w, sp);
    // order hosts by distance from (5, 5), so infection spreads outward
    hosts.sort((x, y) => (c.posX[x]! - 5) ** 2 + (c.posY[x]! - 5) ** 2 - ((c.posX[y]! - 5) ** 2 + (c.posY[y]! - 5) ** 2) || x - y);
    const d = new OutbreakDetector({ windowS: 10 });
    const sc = new Scanner();
    const out: Derived[] = [];
    for (let k = 1; k <= 40; k++) {
      const n = Math.min(hosts.length, k * 8);
      for (let i = 0; i < n; i++) c.infStrain[2 * hosts[i]!] = 77;
      out.push(...runAt(d, w, 30 * k, sc));
    }
    const start = out.find((e) => e.k === 'outbreak' && (e as { phase: string }).phase === 'start') as { prevalence: number; growth: number; infected: number } | undefined;
    expect(start).toBeDefined();
    expect(start!.prevalence).toBeGreaterThan(0.15);
    expect(start!.infected).toBeGreaterThanOrEqual(10);
    const fronts = out.filter((e) => e.k === 'epidemicFront') as { radius: number; strain: number; species: number }[];
    expect(fronts.length).toBeGreaterThan(1);
    expect(fronts[0]).toMatchObject({ strain: 77, species: sp });
    expect(fronts[fronts.length - 1]!.radius).toBeGreaterThan(fronts[0]!.radius);
    // recovery
    for (const s of hosts) c.infStrain[2 * s] = NONE_U32;
    expect(runAt(d, w, 30 * 41, sc)).toEqual([expect.objectContaining({ k: 'outbreak', phase: 'end', strain: 77 })]);
  });
});

describe('newRole', () => {
  it('reports a species turning predator, and a daughter species with a new role', () => {
    const w = world();
    const c = w.cr.c;
    const parents = new Map<number, number>([[9001, 0]]);
    const d = new RoleDetector({ parentOf: (s) => parents.get(s) });
    const sc = new Scanner();
    const sp = c.species[aliveOf(w)[0]!]!;
    const members = aliveOf(w, sp);
    const diet = (s: number, lane: number): void => { for (let i = 0; i < 7; i++) c.diet[7 * s + i] = i === lane ? 1 : 0.05; };
    for (const s of members) diet(s, 0); // phytoplankton
    for (let k = 1; k <= 3; k++) expect(runAt(d, w, 30 * k, sc)).toEqual([]);
    expect(d.roleOfSpecies(sp)).toBe('grazer');
    for (const s of members) { diet(s, 5); c.trophic[s] = 3; } // live prey
    const out: Derived[] = [];
    for (let k = 4; k <= 8; k++) out.push(...runAt(d, w, 30 * k, sc));
    expect(out).toEqual([expect.objectContaining({ k: 'newRole', species: sp, role: 'predator', prevRole: 'grazer', lineage: false, novelty: 1, trophic: 3 })]);
    // a daughter species (of sp) that scavenges
    parents.set(9001, sp);
    for (const s of members.slice(0, 6)) { c.species[s] = 9001; diet(s, 4); }
    const o2: Derived[] = [];
    for (let k = 9; k <= 12; k++) o2.push(...runAt(d, w, 30 * k, sc));
    expect(o2).toEqual([expect.objectContaining({ k: 'newRole', species: 9001, role: 'scavenger', prevRole: 'predator', lineage: true })]);
  });
});

describe('lineage stories', () => {
  it('tells founding, radiation, extinction and the end of a line', () => {
    const w = world();
    const d = new LineageDetector({ radiationMin: 3 });
    const out: Derived[] = [];
    const ev = (e: Record<string, unknown>): SimEvent => ({ ...base, ...e }) as unknown as SimEvent;
    d.observe(w, [
      ev({ k: 'speciation', t: 100, parent: 1, child: 2, founders: [11], pos: [1, 1] }),
      ev({ k: 'speciation', t: 200, parent: 1, child: 3, founders: [12], pos: [2, 1] }),
      ev({ k: 'speciation', t: 300, parent: 2, child: 4, founders: [13], pos: [3, 1] }),
      ev({ k: 'speciation', t: 400, parent: 1, child: 5, founders: [14], pos: [4, 1] }),
    ], out);
    expect(out.map((e) => [(e as { story: string }).story, (e as { species: number }).species])).toEqual([
      ['founded', 2], ['founded', 3], ['founded', 4], ['founded', 5], ['radiation', 1],
    ]);
    expect(out[2]).toMatchObject({ depth: 2, parent: 2 });
    out.length = 0;
    // species 4 dies of starvation; its parent 2 lives on
    d.observe(w, [
      ev({ k: 'death', t: 500, id: 1, species: 4, pos: [3, 3], size: 0.01, cause: 'starvation' }),
      ev({ k: 'death', t: 501, id: 2, species: 4, pos: [3, 3], size: 0.01, cause: 'predation' }),
      ev({ k: 'death', t: 502, id: 3, species: 4, pos: [3, 3], size: 0.01, cause: 'starvation' }),
      ev({ k: 'extinction', t: 502, species: 4, lastId: 3, pos: [3, 3] }),
    ], out);
    expect(out).toEqual([expect.objectContaining({ story: 'extinct', species: 4, cause: 'starvation', descendants: 0, durationS: (502 - 300) / 30 })]);
    out.length = 0;
    for (const sp of [2, 3, 5, 1]) d.observe(w, [ev({ k: 'extinction', t: 600, species: sp, lastId: 0, pos: [0, 0] })], out);
    const stories = out.map((e) => [(e as { story: string }).story, (e as { species: number }).species]);
    expect(stories).toEqual([['extinct', 2], ['extinct', 3], ['extinct', 5], ['extinct', 1], ['lineEnded', 1]]);
  });
});

describe('cost', () => {
  for (const [preset, n] of [['small', 4000], ['default', 8000]] as const) {
    it(`is bounded: a full ${preset} tank (${n} creatures) costs under a millisecond of CPU per tick`, () => {
      const w = sim.create({ ...CFG, preset, skeletonMotes: n });
      for (let i = 0; i < 6; i++) sim.step(w);
      const c = w.cr.c;
      // stage some of everything: carcasses, infections, diets, adults, plankton patches
      const alive = aliveOf(w);
      alive.slice(0, 200).forEach((s) => { c.life[s] = LIFE.CARCASS; c.length[s] = 0.05; });
      alive.slice(200, 800).forEach((s) => { c.infStrain[2 * s] = 3; });
      alive.forEach((s, i) => { c.diet[7 * s + (i % 6)] = 1; c.maturity[s] = 1; });
      // CPU time of this process: other jobs on a shared machine disturb it far less than wall time
      const cpuMs = (): number => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
      const suite = new EventSuite({ clock: cpuMs });
      const twin = new EventSuite();
      const a: Derived[] = []; const b: Derived[] = [];
      for (let i = 0; i < 40; i++) {
        w.g.tick += 30;
        if (i === 20) for (let k = 0; k < w.fields.qP.length; k += 7) w.fields.qP[k] = w.fields.qP[k]! * 3 + 1000;
        a.push(...suite.run(w)); b.push(...twin.run(w));
      }
      // the clock only measures: the same states give the same events
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      const costs = suite.costs();
      const total = costs.reduce((a, x) => a + x.perTickMs, 0);
      // eslint-disable-next-line no-console
      console.log(`events cost, ${preset}, ${alive.length} creatures: ${costs.map((x) => `${x.name} ${x.meanMs.toFixed(3)} (max ${x.maxMs.toFixed(2)})`).join(', ')} ms/run; total ${total.toFixed(4)} ms/tick`);
      expect(costs.find((x) => x.name === 'scan')!.runs).toBe(40);
      // the spike measured about 0.1 (Small) and 0.2 (Default) ms of CPU per tick; generous here
      expect(total).toBeLessThan(1);
    });
  }
});

describe('the director reads these events', () => {
  it('turns the staged detectors\' events into stories without knowing the entities first', async () => {
    const { StoryBook } = await import('../src/director/index.js');
    const w = world(600);
    const book = new StoryBook({ maxStories: 512, mergeRadiusM: 20, mergeWindowS: 10, lCeilingM: w.lCeilingM, tankW: 32, tankH: 18 });
    const c = w.cr.c;
    const suite = new EventSuite({ every: 30, records: { warmupS: 0 }, roles: { parentOf: () => undefined } });
    const stamp = (d: Derived[]): SimEvent[] => d.map((e, i) => ({ ...e, t: w.g.tick, eid: 1e6 + i, epoch: 0 }) as unknown as SimEvent);
    const evs: SimEvent[] = [];
    w.g.tick = 30; evs.push(...stamp(suite.run(w)));
    // a big corpse with a crowd, a migration, an outbreak, a predator turn
    const all = aliveOf(w);
    const k = all[0]!;
    c.life[k] = LIFE.CARCASS; c.length[k] = 0.4 * w.lCeilingM; c.posX[k] = 16; c.posY[k] = 9;
    all.slice(1, 9).forEach((s) => { c.posX[s] = 16.01; c.posY[s] = 9.01; });
    for (let r = 2; r <= 70; r++) {
      w.g.tick = 30 * r;
      for (const s of all.slice(20)) c.posY[s] = Math.max(0.1, c.posY[s]! - 0.1);
      for (const s of all.slice(20, 20 + 8 * r)) c.infStrain[2 * s] = 5;
      if (r === 10) for (const s of all) { for (let i = 0; i < 7; i++) c.diet[7 * s + i] = i === 0 ? 1 : 0; }
      if (r === 30) for (const s of all) { for (let i = 0; i < 7; i++) c.diet[7 * s + i] = i === 5 ? 1 : 0; }
      evs.push(...stamp(suite.run(w)));
    }
    const kinds = new Set(evs.map((e) => e.k));
    for (const k2 of ['carcass', 'frenzy', 'migration', 'outbreak', 'epidemicFront', 'newRole']) expect(kinds).toContain(k2);
    for (const e of evs) book.ingest(e);
    const types = new Set([...book.stories.values()].map((s) => s.type));
    for (const t of ['carcass', 'frenzy', 'migration', 'outbreak']) expect(types).toContain(t);
    // today's StoryBook drops a newRole whose species it has never seen placed, although the event
    // carries its position (contract requests EV1 and EV5)
    expect(types).not.toContain('newRole');
    expect(evs.find((e) => e.k === 'newRole')).toMatchObject({ pos: [expect.any(Number), expect.any(Number)] });
    // every story the events made sits where the event said, not at the tank centre
    const carcass = [...book.stories.values()].find((s) => s.type === 'carcass')!;
    expect(carcass.pos).toEqual([16, 9]);
  });
});
