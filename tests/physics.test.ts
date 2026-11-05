/** Unit, property and determinism tests for src/physics (02 §2.13 C, B5, I1, I2, R9). */
import { describe, expect, it } from 'vitest';
import { hashWorld, KIND, LIFE, ORGAN, RngStreams } from '../src/core/index.js';
import {
  createPhysics, drainBites, drainFlags, massProps, physics, toSegmentSpecs, workFor,
} from '../src/physics/index.js';
import { buildHash, closestSegSeg, queryPairs } from '../src/physics/contacts.js';
import { chain, com, fish, kinetic, makePhenotype, makeWorld, nextTick, spawn, type TestWorld } from '../src/physics/testkit.js';

function jointGap(tw: TestWorld, slot: number): number {
  const w = tw.world; const sg = w.seg.c; const s0 = w.cr.c.segStart[slot]!;
  let worst = 0;
  for (let k = 1; k < w.cr.c.segCount[slot]!; k++) {
    const i = s0 + k; const p = s0 + sg.parent[i]!;
    const ax = sg.posX[p]! + Math.cos(sg.angle[p]!) * sg.attachU[i]! * sg.len[p]!;
    const ay = sg.posY[p]! + Math.sin(sg.angle[p]!) * sg.attachU[i]! * sg.len[p]!;
    const bx = sg.posX[i]! - Math.cos(sg.angle[i]!) * 0.5 * sg.len[i]!;
    const by = sg.posY[i]! - Math.sin(sg.angle[i]!) * 0.5 * sg.len[i]!;
    worst = Math.max(worst, Math.hypot(ax - bx, ay - by) / sg.len[i]!);
  }
  return worst;
}

describe('physics: bodies', () => {
  it('toSegmentSpecs clamps fractions and narrows joint ranges with armour', () => {
    const ph = makePhenotype([
      { parent: -1, attachU: 0, restAngle: 0, length: 0.01, radius: 0.002, muscleFrac: 2, lipidFrac: -1 },
      { parent: 0, attachU: 0.9, restAngle: 0.2, length: 0.01, radius: 0.002, armour: 0.5, limit: 1 },
    ]);
    const s = toSegmentSpecs(ph);
    expect(s[0]!.muscleFrac).toBe(0.8);
    expect(s[0]!.lipidFrac).toBe(0);
    expect(s[1]!.attachU).toBe(0.5);
    expect(s[1]!.limitHi - s[1]!.restAngle).toBeCloseTo(0.5, 5);
    expect(s[1]!.restAngle - s[1]!.limitLo).toBeCloseTo(0.5, 5);
  });

  it('loadBody seats every joint, sums masses to the ledger mass, and lipids make bodies lighter', () => {
    const tw = makeWorld();
    const ph = makePhenotype(fish());
    const geo = toSegmentSpecs(ph).map(massProps).reduce((a, p) => a + p.m, 0);
    const slot = spawn(tw, physics.loadBody, ph, 10, 5, 0.7);
    expect(jointGap(tw, slot)).toBeLessThan(1e-9);
    const sg = tw.world.seg.c;
    let m = 0;
    for (let k = 0; k < 8; k++) m += sg.mass[k]!;
    expect(m).toBeCloseTo(geo, 6);
    // ledger mass rescales
    const c = tw.world.cr.c;
    const s2 = tw.world.cr.highWater;
    c.massKg[s2] = geo * 0.5;
    spawn(tw, physics.loadBody, ph, 12, 5);
    let m2 = 0;
    for (let k = 0; k < 8; k++) m2 += sg.mass[c.segStart[s2]! + k]!;
    expect(m2 / geo).toBeCloseTo(0.5, 5);
    const fat = toSegmentSpecs(makePhenotype(fish().map((p) => ({ ...p, lipidFrac: 0.5 })))).map(massProps).reduce((a, p) => a + p.m, 0);
    expect(fat).toBeLessThan(geo);
  });

  it('restage keeps the pose and re-seats joints at the new lengths', () => {
    const tw = makeWorld();
    const slot = spawn(tw, physics.loadBody, makePhenotype(fish()), 10, 5);
    for (let k = 0; k < 20; k++) { physics.step(tw.world, tw.ctx); nextTick(tw); }
    const h0 = tw.world.cr.c.heading[slot]!;
    physics.restage(tw.world, slot, makePhenotype(fish(8, 0.208)));
    expect(tw.world.seg.c.len[0]).toBeCloseTo(0.026, 6);
    expect(jointGap(tw, slot)).toBeLessThan(1e-6);
    expect(tw.world.cr.c.heading[slot]).toBe(h0);
  });
});

describe('physics: water', () => {
  it('B5: a near-spherical dense segment settles at the Stokes speed', () => {
    const tw = makeWorld();
    const phys = createPhysics({ walls: false, contacts: false });
    const r = 1e-4;
    const slot = spawn(tw, phys.loadBody, makePhenotype([{ parent: -1, attachU: 0, restAngle: 0, length: 1e-5, radius: r, armour: 0.3 }]), 10, 5);
    for (let k = 0; k < 60; k++) { phys.step(tw.world, tw.ctx); nextTick(tw); }
    const sg = tw.world.seg.c;
    const V = Math.PI * r * r * 1e-5 + (4 / 3) * Math.PI * r ** 3;
    const req = Math.cbrt(3 * V / (4 * Math.PI));
    const drho = sg.mass[0]! / V - 1025;
    const stokes = (2 / 9) * drho * 9.81 * req * req / (1025 * 2e-5);
    expect(sg.velY[0]! / stokes).toBeGreaterThan(0.95);
    expect(sg.velY[0]! / stokes).toBeLessThan(1.05);
    void slot;
  });

  it('R9: a passive microbe in the strongest plume for 60 s triggers no watchdog and drifts with the water', () => {
    const tw = makeWorld();
    tw.world.fields.flowU.fill(0.25);
    tw.world.fields.flowV.fill(-0.05);
    const slot = spawn(tw, physics.loadBody, makePhenotype(chain(2, 5e-4, () => 5e-5)), 2, 9);
    for (let k = 0; k < 1800; k++) {
      physics.step(tw.world, tw.ctx); nextTick(tw);
      // keep it in the tank: re-centre when near the wall (a torus for the test)
      if (tw.world.cr.c.posX[slot]! > 30) for (let q = 0; q < 2; q++) tw.world.seg.c.posX[q] = tw.world.seg.c.posX[q]! - 28;
    }
    expect(drainFlags(tw.world)).toEqual([]);
    expect(tw.world.cr.c.velX[slot]!).toBeCloseTo(0.25, 2);
  });

  it('the watchdog flags energy from nothing and clamps it', () => {
    const tw = makeWorld();
    const slot = spawn(tw, physics.loadBody, makePhenotype(fish()), 10, 5);
    const sg = tw.world.seg.c;
    for (let k = 0; k < 200; k++) {
      // an "exploit": velocity injected every tick with no muscle work
      for (let q = 0; q < 8; q++) sg.velX[q] = sg.velX[q]! + 0.05;
      physics.step(tw.world, tw.ctx); nextTick(tw);
    }
    const flags = drainFlags(tw.world);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0]).toBe(slot);
  });

  it('cilia drive a microbe forward about one body length per second and cost power', () => {
    const tw = makeWorld();
    const slot = spawn(tw, physics.loadBody, makePhenotype([{ parent: -1, attachU: 0, restAngle: 0, length: 1e-3, radius: 1e-4, organs: ORGAN.CILIA, lipidFrac: 0.15 }]), 10, 5);
    tw.world.seg.c.cmd2[0] = 1;
    const x0 = tw.world.cr.c.posX[slot]!;
    for (let k = 0; k < 60; k++) { physics.step(tw.world, tw.ctx); nextTick(tw); }
    const bl = (tw.world.cr.c.posX[slot]! - x0) / 2 / 1e-3;
    expect(bl).toBeGreaterThan(0.5);
    expect(bl).toBeLessThan(2);
    expect(tw.world.cr.c.powerW[slot]!).toBeGreaterThan(0);
  });

  it('muscles report positive work and power; a body at rest costs nothing', () => {
    const tw = makeWorld();
    const a = spawn(tw, physics.loadBody, makePhenotype(fish()), 10, 5);
    const b = spawn(tw, physics.loadBody, makePhenotype(fish()), 20, 5);
    const sg = tw.world.seg.c; const c = tw.world.cr.c;
    let work = 0;
    for (let k = 0; k < 60; k++) {
      for (let j = 1; j < 8; j++) sg.cmd[c.segStart[a]! + j] = 0.3 * Math.sin(k * 0.4 - 0.8 * j);
      physics.step(tw.world, tw.ctx); nextTick(tw);
      for (let j = 1; j < 8; j++) work += sg.work[c.segStart[a]! + j]!;
    }
    expect(work).toBeGreaterThan(0);
    expect(c.powerW[a]!).toBeGreaterThan(0);
    expect(c.powerW[b]!).toBe(0);
  });
});

describe('physics: contacts and bites', () => {
  it('I1: hash pairs equal brute force over a four-decade size spectrum, with no duplicates', () => {
    const tw = makeWorld();
    const rng = new RngStreams(3, 3);
    for (let i = 0; i < 300; i++) {
      const d = rng.draw(1, 0, i);
      const L = 0.0005 * Math.exp(d.u01() * Math.log(400));
      spawn(tw, physics.loadBody, makePhenotype(chain(3, L / 3, () => L * 0.08)), 5 + d.u01() * 0.6, 5 + d.u01() * 0.4, d.u01() * 6);
    }
    const w = tw.world; const sg = w.seg.c;
    const hs = buildHash(w);
    const found = new Set<string>();
    let dup = 0;
    const cp = new Float64Array(4);
    const overlap = (i: number, j: number): boolean => {
      const hi = 0.5 * sg.len[i]!; const hj = 0.5 * sg.len[j]!;
      const ci = Math.cos(sg.angle[i]!); const si = Math.sin(sg.angle[i]!); const cj = Math.cos(sg.angle[j]!); const sj = Math.sin(sg.angle[j]!);
      closestSegSeg(sg.posX[i]! - ci * hi, sg.posY[i]! - si * hi, sg.posX[i]! + ci * hi, sg.posY[i]! + si * hi,
        sg.posX[j]! - cj * hj, sg.posY[j]! - sj * hj, sg.posX[j]! + cj * hj, sg.posY[j]! + sj * hj, cp);
      return Math.hypot(cp[0]! - cp[2]!, cp[1]! - cp[3]!) < sg.radius[i]! + sg.radius[j]!;
    };
    for (let q = 0; q < hs.n; q++) {
      queryPairs(w, hs, hs.items[q]!, (i, j) => {
        if (sg.owner[i] === sg.owner[j] || !overlap(i, j)) return;
        const key = i < j ? `${i},${j}` : `${j},${i}`;
        if (found.has(key)) dup++;
        found.add(key);
      }, 1e9);
    }
    const brute = new Set<string>();
    const n = w.cr.highWater * 12;
    for (let i = 0; i < n; i++) {
      if (sg.owner[i] === 0xffffffff || i % 12 >= 3) continue;
      for (let j = i + 1; j < n; j++) {
        if (sg.owner[j] === 0xffffffff || j % 12 >= 3 || sg.owner[i] === sg.owner[j]) continue;
        if (overlap(i, j)) brute.add(`${i},${j}`);
      }
    }
    expect(dup).toBe(0);
    expect(brute.size).toBeGreaterThan(10);
    expect([...found].sort()).toEqual([...brute].sort());
  });

  it('overlapping bodies separate without gaining kinetic energy', () => {
    const tw = makeWorld();
    const phys = createPhysics({ fluid: false, gravity: false });
    const a = spawn(tw, phys.loadBody, makePhenotype(chain(2, 0.02, () => 0.005)), 10, 5);
    const b = spawn(tw, phys.loadBody, makePhenotype(chain(2, 0.02, () => 0.005)), 10.005, 5.004);
    const sg = tw.world.seg.c; const c = tw.world.cr.c;
    for (let q = 0; q < 2; q++) { sg.velX[c.segStart[b]! + q] = -0.05; }
    const E0 = kinetic(tw.world, a) + kinetic(tw.world, b);
    const d0 = Math.hypot(com(tw.world, a)[0] - com(tw.world, b)[0], com(tw.world, a)[1] - com(tw.world, b)[1]);
    for (let k = 0; k < 60; k++) { phys.step(tw.world, tw.ctx); nextTick(tw); }
    const E1 = kinetic(tw.world, a) + kinetic(tw.world, b);
    const d1 = Math.hypot(com(tw.world, a)[0] - com(tw.world, b)[0], com(tw.world, a)[1] - com(tw.world, b)[1]);
    expect(E1).toBeLessThanOrEqual(E0 * (1 + 1e-6));
    expect(d1).toBeGreaterThan(d0);
    let touched = 0;
    for (let i = 0; i < tw.world.seg.highWater; i++) touched += sg.touch[i]!;
    void touched;
  });

  it('a mouth with its bite drive on bites a touched body: event, damage and a bite record', () => {
    const tw = makeWorld();
    const pred = makePhenotype([
      { parent: -1, attachU: 0, restAngle: 0, length: 0.01, radius: 0.004, kind: KIND.MOUTH },
      { parent: 0, attachU: -0.5, restAngle: Math.PI, length: 0.02, radius: 0.004 },
    ]);
    const a = spawn(tw, physics.loadBody, pred, 10, 5, 0);
    const b = spawn(tw, physics.loadBody, makePhenotype(chain(2, 0.02, () => 0.004)), 10.012, 5, Math.PI / 2);
    tw.world.seg.c.cmd2[tw.world.cr.c.segStart[a]!] = 1;
    physics.step(tw.world, tw.ctx); nextTick(tw);
    const bites = drainBites(tw.world);
    expect(bites.length).toBe(1);
    expect(bites[0]!.attacker).toBe(a);
    expect(bites[0]!.target).toBe(b);
    expect(bites[0]!.dmKg).toBeGreaterThan(0);
    expect(tw.events.some((e) => e.k === 'bite')).toBe(true);
    expect(tw.world.seg.c.damage[bites[0]!.targetSeg]!).toBeGreaterThan(0);
    // cooldown: no second bite on the next tick
    physics.step(tw.world, tw.ctx); nextTick(tw);
    expect(drainBites(tw.world).length).toBe(0);
  });
});

describe('physics: determinism (I2)', () => {
  function run(): bigint {
    const tw = makeWorld({ seedLo: 9 });
    const rng = new RngStreams(4, 4);
    for (let i = 0; i < 40; i++) {
      const d = rng.draw(1, 0, i);
      const body = fish(5, 0.02 + 0.05 * d.u01());
      if (i % 3 === 0) body[0]!.kind = KIND.MOUTH;
      spawn(tw, physics.loadBody, makePhenotype(body), 8 + d.u01() * 0.5, 5 + d.u01() * 0.5, d.u01() * 6);
    }
    tw.world.fields.flowU.fill(0.01);
    const sg = tw.world.seg.c; const c = tw.world.cr.c;
    for (let k = 0; k < 150; k++) {
      for (let s = 0; s < 40; s++) {
        for (let j = 1; j < 5; j++) sg.cmd[c.segStart[s]! + j] = Math.sin(k * 0.3 + s - j);
        sg.cmd2[c.segStart[s]!] = (k + s) % 20 < 10 ? 1 : 0;
      }
      physics.step(tw.world, tw.ctx); nextTick(tw);
    }
    for (let s = 0; s < 40; s++) expect(c.life[s]).toBe(LIFE.ALIVE);
    void workFor;
    return hashWorld(tw.world);
  }
  it('two runs from the same state give the same state hash', () => {
    expect(run()).toBe(run());
  });
});
