/**
 * Severing and corpse fragments (02 §2.4.7, DESIGN Q5): a segment at damage 1 leaves with its
 * subtree as a sinking, fading CARCASS fragment; tissue and reserve move in exact quanta.
 */
import { describe, expect, it } from 'vitest';
import { CF, LIFE, Q_MASS } from '../src/core/index.js';
import {
  commitSevers, createPhysics, fragmentGlow, localSeverHooks, pendingSevers, workFor, LINK, linkState,
} from '../src/physics/index.js';
import { restage } from '../src/physics/body.js';
import { addLink } from '../src/physics/links.js';
import { fish, makePhenotype, makeWorld, nextTick, spawn } from '../src/physics/testkit.js';

function setup(gravity = true) {
  const tw = makeWorld();
  const phys = createPhysics({ gravity, contacts: false });
  const ph = makePhenotype(fish());
  const slot = spawn(tw, phys.loadBody, ph, 16, 9);
  const c = tw.world.cr.c;
  c.qTissue[slot] = 1_000_003; c.qReserve[slot] = 200_001; c.qGut[slot * 3 + 1] = 77;
  c.glow[slot] = 0.8;
  return { tw, phys, slot, ph, c, sg: tw.world.seg.c };
}

const total = (c: ReturnType<typeof setup>['c'], hw: number): number => {
  let q = 0;
  for (let s = 0; s < hw; s++) if (c.life[s] !== LIFE.FREE) q += c.qTissue[s]! + c.qReserve[s]! + c.qRepro[s]! + c.qGut[s * 3]! + c.qGut[s * 3 + 1]! + c.qGut[s * 3 + 2]!;
  return q;
};

describe('physics: severing', () => {
  it('a segment at damage 1 leaves with its subtree, in place, with exact quanta', () => {
    const { tw, phys, slot, c, sg } = setup();
    for (let k = 0; k < 10; k++) { phys.step(tw.world, tw.ctx); nextTick(tw); }
    const s0 = c.segStart[slot]!;
    const before = Array.from({ length: 8 }, (_, k) => [sg.posX[s0 + k]!, sg.posY[s0 + k]!, sg.angle[s0 + k]!, sg.mass[s0 + k]!]);
    const q0 = total(c, tw.world.cr.highWater);
    sg.damage[s0 + 5] = 1;
    phys.step(tw.world, tw.ctx); nextTick(tw);
    expect(pendingSevers(tw.world).length).toBe(1);
    const s0b = c.segStart[slot]!;
    const after = Array.from({ length: 8 }, (_, k) => [sg.posX[s0b + k]!, sg.posY[s0b + k]!, sg.angle[s0b + k]!]);
    const res = commitSevers(tw.world, localSeverHooks);
    expect(res.length).toBe(1);
    const r = res[0]!;
    expect(c.segCount[slot]).toBe(5);
    expect(c.segCount[r.fragment]).toBe(3);
    expect(c.life[r.fragment]).toBe(LIFE.CARCASS);
    expect(c.flags[r.fragment]! & CF.FRAGMENT).toBe(CF.FRAGMENT);
    // every segment kept its world pose
    const f0 = c.segStart[r.fragment]!;
    for (let k = 0; k < 8; k++) {
      const i = k < 5 ? s0b + k : f0 + (k - 5);
      expect(sg.posX[i]).toBe(after[k]![0]); expect(sg.posY[i]).toBe(after[k]![1]); expect(sg.angle[i]).toBe(after[k]![2]);
    }
    void before;
    expect(sg.parent[f0]).toBe(-1); expect(sg.parent[f0 + 1]).toBe(0); expect(sg.parent[f0 + 2]).toBe(1);
    // exact ledger: totals unchanged, fragment holds its mass share (3/8 of the mass, rounded down)
    expect(total(c, tw.world.cr.highWater)).toBe(q0);
    expect(c.qGut[r.fragment * 3 + 1]).toBe(0);
    expect(r.qTissue).toBeGreaterThan(0);
    expect(Number.isInteger(r.qTissue) && Number.isInteger(r.qReserve)).toBe(true);
    let mF = 0; for (let k = 0; k < 3; k++) mF += sg.mass[f0 + k]!;
    let mAll = mF; for (let k = 0; k < 5; k++) mAll += sg.mass[s0b + k]!;
    expect(Math.abs(r.qTissue - Math.floor(1_000_003 * mF / mAll))).toBeLessThanOrEqual(1);
    expect(c.massKg[r.fragment]).toBeCloseTo((r.qTissue + r.qReserve) * Q_MASS, 12);
    // the part map follows: the survivor is parts 0..4, the fragment parts 5..7
    const wk = workFor(tw.world);
    expect(Array.from({ length: 5 }, (_, k) => wk.part[s0b + k])).toEqual([0, 1, 2, 3, 4]);
    expect(Array.from({ length: 3 }, (_, k) => wk.part[f0 + k])).toEqual([5, 6, 7]);
  });

  it('the survivor keeps swimming, and restage with the whole Phenotype keeps the loss', () => {
    const { tw, phys, slot, c, sg, ph } = setup(false);
    const s0 = c.segStart[slot]!;
    sg.damage[s0 + 6] = 1;
    phys.step(tw.world, tw.ctx); nextTick(tw);
    commitSevers(tw.world, localSeverHooks);
    expect(c.segCount[slot]).toBe(6);
    for (let k = 0; k < 60; k++) {
      for (let j = 1; j < 6; j++) sg.cmd[s0 + j] = 0.5 * Math.sin(k * 0.8 - j);
      phys.step(tw.world, tw.ctx); nextTick(tw);
    }
    for (let k = 0; k < 6; k++) expect(Number.isFinite(sg.posX[s0 + k]!)).toBe(true);
    // joints stay closed after the re-indexing
    for (let k = 1; k < 6; k++) {
      const i = s0 + k; const p = s0 + sg.parent[i]!;
      const ax = sg.posX[p]! + Math.cos(sg.angle[p]!) * sg.attachU[i]! * sg.len[p]!;
      const ay = sg.posY[p]! + Math.sin(sg.angle[p]!) * sg.attachU[i]! * sg.len[p]!;
      const bx = sg.posX[i]! - Math.cos(sg.angle[i]!) * 0.5 * sg.len[i]!;
      const by = sg.posY[i]! - Math.sin(sg.angle[i]!) * 0.5 * sg.len[i]!;
      expect(Math.hypot(ax - bx, ay - by)).toBeLessThan(1e-4);
    }
    const x = sg.posX[s0]!;
    restage(tw.world, slot, ph);
    expect(c.segCount[slot]).toBe(6);
    expect(sg.posX[s0]).toBe(x);
  });

  it('a fragment sinks to the floor and its glow fades to zero over 30 s', () => {
    const { tw, phys, slot, c, sg } = setup();
    const s0 = c.segStart[slot]!;
    for (let k = 0; k < 8; k++) sg.glow[s0 + k] = 0.6;
    sg.damage[s0 + 4] = 1;
    phys.step(tw.world, tw.ctx); nextTick(tw);
    const [r] = commitSevers(tw.world, localSeverHooks);
    const fr = r!.fragment;
    const f0 = c.segStart[fr]!;
    const y0 = c.posY[fr]!;
    const g0 = c.glow[fr]!;
    let g15 = 0;
    for (let k = 0; k < 31 * 30; k++) {
      phys.step(tw.world, tw.ctx); nextTick(tw);
      if (k === 15 * 30 - 1) g15 = c.glow[fr]!;
    }
    expect(g0).toBeCloseTo(0.8, 6);
    expect(g15 / g0).toBeCloseTo(0.5, 1);
    expect(c.glow[fr]).toBe(0);
    expect(sg.glow[f0]).toBe(0);
    expect(c.posY[fr]!).toBeGreaterThan(y0 + 0.5); // sank (y points down)
    expect(fragmentGlow(0)).toBe(1); expect(fragmentGlow(30)).toBe(0);
    // muscles are off on the fragment
    for (let k = 1; k < c.segCount[fr]!; k++) expect(sg.act[f0 + k]).toBe(0);
  });

  it('even a lipid-rich (buoyant) fragment sinks: waterlogged', () => {
    const tw = makeWorld();
    const phys = createPhysics({ contacts: false });
    const slot = spawn(tw, phys.loadBody, makePhenotype(fish().map((p) => ({ ...p, lipidFrac: 0.6 }))), 16, 9);
    const c = tw.world.cr.c; const sg = tw.world.seg.c;
    c.qTissue[slot] = 1000;
    sg.damage[c.segStart[slot]! + 4] = 1;
    phys.step(tw.world, tw.ctx); nextTick(tw);
    const [r] = commitSevers(tw.world, localSeverHooks);
    const y0 = c.posY[r!.fragment]!; const ys = c.posY[slot]!;
    for (let k = 0; k < 300; k++) { phys.step(tw.world, tw.ctx); nextTick(tw); }
    expect(c.posY[r!.fragment]!).toBeGreaterThan(y0 + 0.05);
    expect(c.posY[slot]!).toBeLessThan(ys); // the living, lipid-rich survivor floats up
  });

  it('links on moved segments follow them; deterministic across runs', () => {
    const run = (): string => {
      const { tw, phys, slot, c, sg } = setup();
      const s0 = c.segStart[slot]!;
      addLink(tw.world, LINK.GRAB, s0 + 1, s0 + 7, sg.posX[s0 + 7]!, sg.posY[s0 + 7]!, 1e9);
      sg.cmd2[s0 + 1] = 1;
      sg.damage[s0 + 5] = 1;
      phys.step(tw.world, tw.ctx); nextTick(tw);
      const [r] = commitSevers(tw.world, localSeverHooks);
      const l = linkState(tw.world).links[0];
      expect(l).toBeDefined();
      expect(l!.a).toBe(c.segStart[slot]! + 1); expect(l!.b).toBe(c.segStart[r!.fragment]! + 2);
      for (let k = 0; k < 30; k++) { phys.step(tw.world, tw.ctx); nextTick(tw); }
      return Array.from(sg.posX.subarray(0, 8 * 64)).join(',');
    };
    expect(run()).toBe(run());
  });
});
