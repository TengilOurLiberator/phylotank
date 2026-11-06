/**
 * Jets (low-Re fade-out), gas bladders (Boyle), roll triggering and parasite scraping
 * (02 §2.3.6, §2.3.8, §2.4.5; CONTRACT 8.2 ROLL).
 */
import { describe, expect, it } from 'vitest';
import { KIND, MOUTH_SUBTYPE, ORGAN } from '../src/core/index.js';
import {
  createPhysics, gasVolume, itch, LINK, linkState, molesFor, pressureAt, workFor, ROLL_COOLDOWN_S,
} from '../src/physics/index.js';
import { addLink } from '../src/physics/links.js';
import { com, fish, makePhenotype, makeWorld, nextTick, spawn, type PartDef } from '../src/physics/testkit.js';

function bell(scale: number): PartDef[] {
  return [
    { parent: -1, attachU: 0, restAngle: 0, length: 0.01 * scale, radius: 0.01 * scale, organs: ORGAN.JET, muscleFrac: 0 },
    { parent: 0, attachU: -0.5, restAngle: Math.PI, length: 0.01 * scale, radius: 0.001 * scale, muscleFrac: 0 },
  ];
}

/** Body lengths per pulse cycle (0.3 s contraction at drive 1, 0.7 s refill). */
function jetRun(scale: number): { blPerCycle: number; maxP: number } {
  const tw = makeWorld();
  const phys = createPhysics({ gravity: false, contacts: false });
  const slot = spawn(tw, phys.loadBody, makePhenotype(bell(scale)), 16, 9);
  const sg = tw.world.seg.c; const c = tw.world.cr.c; const s0 = c.segStart[slot]!;
  const x0 = com(tw.world, slot)[0];
  let maxP = 0;
  const cycles = 4;
  for (let k = 0; k < cycles * 30; k++) {
    sg.cmd2[s0] = (k % 30) < 9 ? 1 : 0;
    phys.step(tw.world, tw.ctx); nextTick(tw);
    maxP = Math.max(maxP, c.powerW[slot]!);
  }
  return { blPerCycle: (com(tw.world, slot)[0] - x0) / (0.02 * scale) / cycles, maxP };
}

describe('physics: jets', () => {
  it('a 2 cm bell jets forward; the same bell at 0.2 mm barely moves (low-Re fade-out)', () => {
    const big = jetRun(1);
    const small = jetRun(0.01);
    expect(big.blPerCycle).toBeGreaterThan(0.05);
    expect(big.maxP).toBeGreaterThan(0);
    expect(Math.abs(small.blPerCycle)).toBeLessThan(0.02 * big.blPerCycle);
  });

  it('the bell empties to its floor and refills', () => {
    const tw = makeWorld();
    const phys = createPhysics({ gravity: false, contacts: false });
    const slot = spawn(tw, phys.loadBody, makePhenotype(bell(1)), 16, 9);
    const wk = workFor(tw.world); const s0 = tw.world.cr.c.segStart[slot]!;
    const v0 = wk.jetVol[s0]!;
    tw.world.seg.c.cmd2[s0] = 1;
    for (let k = 0; k < 20; k++) { phys.step(tw.world, tw.ctx); nextTick(tw); }
    expect(wk.jetVol[s0]! / v0).toBeCloseTo(0.2, 6);
    tw.world.seg.c.cmd2[s0] = 0;
    for (let k = 0; k < 90; k++) { phys.step(tw.world, tw.ctx); nextTick(tw); }
    expect(wk.jetVol[s0]! / v0).toBeGreaterThan(0.95);
  });
});

describe('physics: gas bladders', () => {
  const withBladder = (): PartDef[] => fish().map((p, k) => (k === 2 ? { ...p, organs: ORGAN.BLADDER } : p));

  it("Boyle's law: gas volume halves by about 10 m depth", () => {
    const tw = makeWorld();
    const top = tw.world.g.ySurface;
    const mol = molesFor(tw.world, 1e-5, top, 15);
    expect(gasVolume(tw.world, mol, top, 15)).toBeCloseTo(1e-5, 12);
    const r = gasVolume(tw.world, mol, top + 10.08, 15) / 1e-5;
    expect(r).toBeCloseTo(0.5, 2);
    expect(pressureAt(tw.world, top + 10)).toBeGreaterThan(2 * 101325 - 2000);
  });

  it('a bladder fish starts neutral and hovers; without the bladder it sinks; inflating lifts it', () => {
    const run = (parts: PartDef[], drive: number): { dy: number; P: number } => {
      const tw = makeWorld();
      const phys = createPhysics({ contacts: false });
      const slot = spawn(tw, phys.loadBody, makePhenotype(parts), 16, 9);
      const sg = tw.world.seg.c; const s0 = tw.world.cr.c.segStart[slot]!;
      const y0 = com(tw.world, slot)[1];
      let P = 0;
      for (let k = 0; k < 90; k++) { sg.cmd2[s0 + 2] = drive; phys.step(tw.world, tw.ctx); nextTick(tw); P += tw.world.cr.c.powerW[slot]!; }
      return { dy: com(tw.world, slot)[1] - y0, P: P / 90 };
    };
    const hover = run(withBladder(), 0);
    const plain = run(fish(), 0);
    const up = run(withBladder(), 1);
    expect(plain.dy).toBeGreaterThan(0.01); // sinks (y down)
    expect(Math.abs(hover.dy)).toBeLessThan(0.1 * plain.dy);
    expect(up.dy).toBeLessThan(-0.002); // rises
    expect(up.P).toBeGreaterThan(hover.P); // pumping costs
    expect(hover.P).toBeGreaterThan(0); // holding costs a little
  });

  it('neutral buoyancy is unstable: pushed deeper, the gas shrinks and the fish keeps sinking', () => {
    const tw = makeWorld();
    const phys = createPhysics({ contacts: false });
    const slot = spawn(tw, phys.loadBody, makePhenotype(withBladder()), 16, 4);
    const sg = tw.world.seg.c; const c = tw.world.cr.c; const s0 = c.segStart[slot]!;
    const wk = workFor(tw.world);
    const v0 = gasVolume(tw.world, wk.gasMol[s0 + 2]!, sg.posY[s0 + 2]!, 15);
    for (let k = 0; k < 8; k++) sg.posY[s0 + k] = sg.posY[s0 + k]! + 4; // displaced 4 m down
    for (let k = 0; k < 120; k++) { phys.step(tw.world, tw.ctx); nextTick(tw); }
    expect(wk.gasV[s0 + 2]!).toBeLessThan(0.8 * v0);
    expect(c.velY[slot]!).toBeGreaterThan(0);
  });
});

describe('physics: roll', () => {
  const bent = (): PartDef[] => fish().map((p, k) => (k >= 2 ? { ...p, restAngle: 0.25, limit: 0.4 } : p));

  it('ROLL above 0.5 flips the mirror once, with hysteresis and a cooldown, and the body swings over smoothly', () => {
    const tw = makeWorld();
    const phys = createPhysics({ gravity: false, contacts: false });
    const slot = spawn(tw, phys.loadBody, makePhenotype(bent()), 16, 9);
    const c = tw.world.cr.c; const sg = tw.world.seg.c; const s0 = c.segStart[slot]!;
    for (let k = 0; k < 30; k++) { phys.step(tw.world, tw.ctx); nextTick(tw); }
    const rel = (): number => sg.angle[s0 + 4]! - sg.angle[s0 + 3]!;
    expect(rel()).toBeCloseTo(0.25, 1);
    c.out[slot * 8 + 7] = 1;
    let flips = 0; let prev = c.mirror[slot]!; let maxStep = 0; let last = rel(); let first = 0; let peak = 0;
    for (let k = 0; k < 60; k++) {
      phys.step(tw.world, tw.ctx); nextTick(tw);
      if (c.mirror[slot] !== prev) { flips++; prev = c.mirror[slot]!; }
      maxStep = Math.max(maxStep, Math.abs(rel() - last)); last = rel();
      if (k === 0) first = rel();
      peak = Math.max(peak, Math.abs(rel()));
    }
    expect(flips).toBe(1); // held high: no second flip
    expect(c.mirror[slot]).toBe(-1);
    expect(rel()).toBeCloseTo(-0.25, 1);
    // no snap: the joint swings over through its spring (measured 0.25, 0.07, -0.28, -0.42, ...)
    expect(first).toBeGreaterThan(-0.1);
    expect(peak).toBeLessThan(0.65);
    expect(maxStep).toBeLessThan(0.5);
    // release, raise again after the cooldown: flips back
    c.out[slot * 8 + 7] = 0; phys.step(tw.world, tw.ctx); nextTick(tw);
    c.out[slot * 8 + 7] = 1;
    for (let k = 0; k < Math.ceil(ROLL_COOLDOWN_S * 30); k++) { phys.step(tw.world, tw.ctx); nextTick(tw); }
    expect(c.mirror[slot]).toBe(1);
    for (let k = 0; k < 8; k++) expect(Number.isFinite(sg.posX[s0 + k]!)).toBe(true);
  });
});

describe('physics: parasite scraping', () => {
  function scene(hostSpeed: number): { removed: boolean; itch0: number; relatchedWithin2s: boolean } {
    const tw = makeWorld();
    const phys = createPhysics({ contacts: true });
    const H = tw.world.preset.heightM;
    // host lies on the tank floor, the parasite latched on its mid segment from above
    const host = spawn(tw, phys.loadBody, makePhenotype(fish().map((p) => ({ ...p, damping: 0.5 }))), 16, H - 0.012);
    const par = spawn(tw, phys.loadBody, makePhenotype([
      { parent: -1, attachU: 0, restAngle: 0, length: 0.004, radius: 0.001, kind: KIND.MOUTH },
      { parent: 0, attachU: -0.5, restAngle: Math.PI, length: 0.004, radius: 0.001 },
    ]), 15.9, H - 0.026, Math.PI / 2);
    const sg = tw.world.seg.c; const c = tw.world.cr.c;
    const hs = c.segStart[host]!; const ps = c.segStart[par]!;
    workFor(tw.world).subtype[ps] = MOUTH_SUBTYPE.PROBOSCIS;
    sg.cmd3[ps * 2 + 1] = 1; // latch drive: cmd3 lane 1 (CONTRACT 5.2)
    addLink(tw.world, LINK.LATCH, ps, hs + 4, sg.posX[ps]!, sg.posY[ps]! + 0.002, 1e9);
    const itch0 = itch(tw.world, host);
    let offAt = -1; let relatched = false;
    for (let k = 0; k < 75; k++) {
      // the host rubs along the floor at hostSpeed; the parasite keeps its latch drive on
      for (let j = 0; j < 8; j++) { sg.velX[hs + j] = -hostSpeed; sg.velY[hs + j] = 0.05; }
      sg.cmd3[ps * 2 + 1] = 1; // latch drive: cmd3 lane 1 (CONTRACT 5.2)
      phys.step(tw.world, tw.ctx); nextTick(tw);
      const on = linkState(tw.world).links.some((l) => l.type === LINK.LATCH);
      if (!on && offAt < 0) offAt = k;
      if (on && offAt >= 0 && k - offAt < 59) relatched = true;
    }
    return { removed: offAt >= 0, itch0, relatchedWithin2s: relatched };
  }

  it('rubbing the latched segment along the floor faster than 1 body length per second scrapes the parasite off', () => {
    const fast = scene(0.4);
    const slow = scene(0.05);
    expect(fast.itch0).toBeCloseTo(1 / 8, 9);
    expect(fast.removed).toBe(true);
    expect(fast.relatchedWithin2s).toBe(false); // dislodged: no instant re-latch
    expect(slow.removed).toBe(false);
  });
});

describe('physics: organs are deterministic', () => {
  it('a jetting, bladder-pumping, rolling body runs bit for bit the same twice', () => {
    const run = (): string => {
      const tw = makeWorld();
      const phys = createPhysics({ contacts: false });
      const parts = fish().map((p, k) => (k === 0 ? { ...p, organs: ORGAN.JET } : k === 2 ? { ...p, organs: ORGAN.BLADDER } : p));
      const slot = spawn(tw, phys.loadBody, makePhenotype(parts), 16, 9);
      const c = tw.world.cr.c; const sg = tw.world.seg.c; const s0 = c.segStart[slot]!;
      for (let k = 0; k < 120; k++) {
        sg.cmd2[s0] = (k % 30) < 9 ? 1 : 0;
        sg.cmd2[s0 + 2] = Math.sin(k * 0.1);
        c.out[slot * 8 + 7] = (k % 60) < 30 ? 1 : 0;
        for (let j = 1; j < 8; j++) sg.cmd[s0 + j] = 0.3 * Math.sin(k * 0.5 - j);
        phys.step(tw.world, tw.ctx); nextTick(tw);
      }
      return [...Array.from(sg.posX.subarray(s0, s0 + 8)), ...Array.from(sg.angle.subarray(s0, s0 + 8)), c.mirror[slot], c.powerW[slot]].join(',');
    };
    expect(run()).toBe(run());
  });
});

