import { describe, expect, it, vi } from 'vitest';
import { hashWorld, LIFE, type SimEvent, type WorldConfig } from '../src/core/index.js';
import { sim } from '../src/sim/index.js';
import { Detectors } from '../src/host/detectors.js';
import { entityId } from '../src/host/interest.js';

// the build machine is shared with other jobs; allow slow runs
vi.setConfig({ testTimeout: 120_000 });

const CFG: WorldConfig = { preset: 'small', seedLo: 4, seedHi: 4, backend: 'cpu', skeletonMotes: 300 };
const base = { eid: 1, epoch: 0 };

describe('host detectors', () => {
  it('never write sim state', () => {
    const w = sim.create(CFG);
    const h = hashWorld(w);
    const d = new Detectors({ every: 1 });
    for (let i = 0; i < 5; i++) { w.g.tick += 0; d.run(w); }
    expect(hashWorld(w)).toBe(h);
  });

  it('flags giants once, relative to the size ceiling', () => {
    const w = sim.create(CFG);
    const d = new Detectors({ every: 1 });
    expect(d.run(w).filter((e) => e.k === 'giant')).toHaveLength(0);
    w.cr.c.length[7] = 0.6 * w.lCeilingM + 0.001;
    w.g.tick = 10;
    const g = d.run(w).filter((e) => e.k === 'giant');
    expect(g).toEqual([expect.objectContaining({ k: 'giant', id: entityId(w, 7) })]);
    w.g.tick = 20;
    expect(d.run(w).filter((e) => e.k === 'giant')).toHaveLength(0);
  });

  it('reports endangered species and extinctions', () => {
    const w = sim.create(CFG);
    const d = new Detectors({ every: 1 });
    d.run(w);
    const sp = w.cr.c.species[0]!;
    const members = [...Array(w.cr.highWater).keys()].filter((s) => w.cr.c.species[s] === sp);
    expect(members.length).toBeGreaterThanOrEqual(10);
    for (const s of members.slice(3)) w.cr.c.life[s] = LIFE.FREE;
    w.g.tick = 5;
    const e = d.run(w).filter((x) => x.k === 'endangered');
    expect(e).toEqual([expect.objectContaining({ species: sp, remaining: 3 })]);
    for (const s of members.slice(0, 3)) w.cr.c.life[s] = LIFE.FREE;
    w.g.tick = 10;
    expect(d.run(w).filter((x) => x.k === 'extinction')).toEqual([expect.objectContaining({ species: sp })]);
  });

  it('turns bites and kills into hunts, and quiet hunts into escapes', () => {
    const w = sim.create(CFG);
    const d = new Detectors({ every: 1, huntTimeoutTicks: 30 });
    const bite = (t: number, a: number, b: number): SimEvent => ({ ...base, k: 'bite', t, attacker: a, target: b, pos: [1, 1], dmg: 1 });
    expect(d.onPrimitive(w, [bite(1, 5, 6)])).toEqual([expect.objectContaining({ k: 'hunt', phase: 'start', pred: 5, prey: 6 })]);
    expect(d.onPrimitive(w, [bite(2, 5, 6)])).toEqual([]);
    const kill: SimEvent = { ...base, k: 'death', t: 3, id: 6, species: 1, pos: [2, 2], size: 0.01, cause: 'predation', killer: 5 };
    expect(d.onPrimitive(w, [kill])).toEqual([expect.objectContaining({ k: 'hunt', phase: 'end', outcome: 'kill' })]);
    d.onPrimitive(w, [bite(4, 8, 9)]);
    w.g.tick = 100;
    expect(d.run(w).filter((e) => e.k === 'hunt')).toEqual([expect.objectContaining({ phase: 'end', outcome: 'escape', pred: 8 })]);
  });

  it('detects a mass death against the background rate', () => {
    const w = sim.create(CFG);
    const d = new Detectors({ every: 30, massDeathWindowTicks: 300 });
    const death = (t: number, x: number): SimEvent => ({ ...base, k: 'death', t, id: t * 100 + x, species: 1, pos: [x, 5], size: 0.01, cause: 'disaster' });
    for (let t = 0; t < 3000; t += 30) {
      w.g.tick = t;
      if (t % 300 === 0) d.onPrimitive(w, [death(t, 1)]);
      expect(d.run(w).filter((e) => e.k === 'massDeath')).toHaveLength(0);
    }
    w.g.tick = 3030;
    d.onPrimitive(w, Array.from({ length: 25 }, (_, i) => death(3030, 10 + (i % 5))));
    const m = d.run(w).filter((e) => e.k === 'massDeath');
    expect(m).toEqual([expect.objectContaining({ deaths: 25 })]);
  });

  it('notices a species moving through the water column', () => {
    const w = sim.create(CFG);
    const d = new Detectors({ every: 30, migrationWindowTicks: 300 });
    const sp = w.cr.c.species[0]!;
    let mig: unknown[] = [];
    for (let k = 0; k <= 12; k++) {
      w.g.tick = k * 30;
      for (let s = 0; s < w.cr.highWater; s++) if (w.cr.c.species[s] === sp) w.cr.c.posY[s] = Math.max(0.2, w.cr.c.posY[s]! - 0.6);
      mig = [...mig, ...d.run(w).filter((e) => e.k === 'migration')];
    }
    expect(mig[0]).toEqual(expect.objectContaining({ species: sp, direction: 'up' }));
  });

  it('finds aligned schools, big carcasses and frenzies', () => {
    const w = sim.create(CFG);
    const c = w.cr.c;
    const d = new Detectors({ every: 1 });
    // scatter everything far apart first, with random-ish headings
    for (let s = 0; s < w.cr.highWater; s++) { c.posX[s] = 20 + (s % 20) * 0.6; c.posY[s] = 1 + Math.floor(s / 20) * 1.1; c.heading[s] = s * 2.4; }
    d.run(w);
    const sp = c.species[0]!;
    const members = [...Array(w.cr.highWater).keys()].filter((s) => c.species[s] === sp).slice(0, 10);
    members.forEach((s, i) => { c.posX[s] = 5 + (i % 5) * 0.1; c.posY[s] = 5 + Math.floor(i / 5) * 0.1; c.heading[s] = 0.1 * (i % 3); });
    w.g.tick = 30;
    const start = d.run(w).filter((e) => e.k === 'school');
    expect(start).toEqual([expect.objectContaining({ phase: 'start', species: sp, n: 10 })]);
    w.g.tick = 31 + 300;
    expect(d.run(w).filter((e) => e.k === 'school')).toEqual([expect.objectContaining({ phase: 'update' })]);
    members.forEach((s, i) => { c.heading[s] = i * 0.7; });
    w.g.tick = 400;
    expect(d.run(w).filter((e) => e.k === 'school')).toEqual([expect.objectContaining({ phase: 'end', species: sp })]);
    // a carcass at a quarter of the ceiling, then scavengers arrive
    const k = members[0]!;
    c.life[k] = LIFE.CARCASS; c.length[k] = 0.3 * w.lCeilingM; c.posX[k] = 10; c.posY[k] = 10;
    w.g.tick = 500;
    expect(d.run(w).filter((e) => e.k === 'carcass')).toEqual([expect.objectContaining({ id: entityId(w, k), scavengers: 0 })]);
    members.slice(1, 7).forEach((s) => { c.posX[s] = 10.05; c.posY[s] = 10.05; });
    w.g.tick = 600;
    const out = d.run(w);
    expect(out.filter((e) => e.k === 'carcass')).toHaveLength(0);
    expect(out.filter((e) => e.k === 'frenzy')).toEqual([expect.objectContaining({ n: 6 })]);
  });
});

describe('FIELDS and INSPECT frames', () => {
  it('quantise the coarse fields per channel and report a selected creature', async () => {
    const { decodeFieldsFrame, decodeInspect, encodeFieldsFrame, encodeInspect, FIELD_CH } = await import('../src/host/frames.js');
    const w = sim.create(CFG);
    for (let i = 0; i < 20; i++) sim.step(w);
    w.fields.qP.fill(0); w.fields.qP[0] = 16; w.fields.qP[w.fields.fine[0] * w.fields.fine[1] - 1] = 32;
    const f = decodeFieldsFrame(encodeFieldsFrame(w));
    expect([f.w, f.h]).toEqual([...w.fields.coarse]);
    expect(f.channels.map((c) => c.id)).toEqual(Object.values(FIELD_CH));
    const p = f.channels.find((c) => c.id === FIELD_CH.plankton)!;
    expect(p.max).toBe(32);
    expect(p.data[0]).toBe(128);
    expect(p.data[f.w * f.h - 1]).toBe(255);
    const id = entityId(w, 3);
    const ins = decodeInspect(encodeInspect(w, id)!);
    expect(ins.id).toBe(id);
    expect(ins.activations.length).toBe(0); // phase-0 motes have no brains
    expect(encodeInspect(w, 999_999)).toBeNull();
  });
});
