import { describe, expect, it } from 'vitest';
import { decodeDust, LIFE, readHeader, FRAME, type WorldConfig } from '../src/core/index.js';
import { ecosystem } from '../src/ecosystem/index.js';
import { encodeViewFrames, fallbackSim as sim } from '../src/sim/index.js';

const cfg = (seedLo: number): WorldConfig => ({ preset: 'small', seedLo, seedHi: 7, backend: 'cpu', skeletonMotes: 800 });

describe('sim (runs in Node: the host and headless tests use the same code)', { timeout: 180_000 }, () => {
  it('is deterministic: same seed, same state hash after 600 ticks', () => {
    const a = sim.create(cfg(42));
    const b = sim.create(cfg(42));
    for (let i = 0; i < 600; i++) { sim.step(a); sim.step(b); }
    expect(sim.hash(a)).toBe(sim.hash(b));
    const c = sim.create(cfg(43));
    for (let i = 0; i < 600; i++) sim.step(c);
    expect(sim.hash(c)).not.toBe(sim.hash(a));
  });
  it('keeps creatures inside the tank and moving with the current', () => {
    const w = sim.create(cfg(1));
    const x0 = Array.from(w.cr.c.posX.subarray(0, 800));
    for (let i = 0; i < 300; i++) sim.step(w);
    let moved = 0;
    for (let s = 0; s < 800; s++) {
      expect(w.cr.c.life[s]).toBe(LIFE.ALIVE);
      const x = w.cr.c.posX[s]!, y = w.cr.c.posY[s]!;
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(32);
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(18);
      if (Math.abs(x - x0[s]!) > 0.01) moved++;
    }
    expect(moved).toBeGreaterThan(700);
  });
  it('flow is divergence-free (finite-difference check)', () => {
    const w = sim.create(cfg(5));
    const o = new Float64Array(2), p = new Float64Array(2);
    const e = 1e-4;
    for (const [x, y] of [[3, 4], [10, 9], [25, 15], [16, 2]] as const) {
      ecosystem.flowAt(w, x + e, y, o); const ux1 = o[0]!; ecosystem.flowAt(w, x - e, y, p); const ux0 = p[0]!;
      ecosystem.flowAt(w, x, y + e, o); const vy1 = o[1]!; ecosystem.flowAt(w, x, y - e, p); const vy0 = p[1]!;
      expect(Math.abs((ux1 - ux0) / (2 * e) + (vy1 - vy0) / (2 * e))).toBeLessThan(1e-8);
    }
  });
  it('the mass ledger is exact (integer equality, CONTRACT 9.1)', () => {
    const w = sim.create(cfg(9));
    for (let i = 0; i < 90; i++) sim.step(w);
    const a = ecosystem.audit(w);
    expect(a.ok).toBe(true);
    expect(a.totalQ).toBe(w.g.mTargetQ);
    expect(Number.isSafeInteger(a.totalQ)).toBe(true);
  });
  it('emits whole-tank DUST_FRAMEs with stable slots', () => {
    const w = sim.create(cfg(2));
    const f1 = decodeDust(encodeViewFrames(w));
    sim.step(w); sim.step(w);
    const f2 = decodeDust(encodeViewFrames(w));
    expect(readHeader(encodeViewFrames(w)).type).toBe(FRAME.DUST_FRAME);
    expect(f1.n).toBe(800);
    expect(f2.n).toBe(800);
    // same slot, same mote: it can only have moved a little in two ticks
    for (let s = 0; s < 800; s++) expect(Math.abs(f2.x[s]! - f1.x[s]!)).toBeLessThan(200);
  });
});
