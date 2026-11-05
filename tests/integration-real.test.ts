/**
 * Phase-2 integration: the product sim runs the real genome, physics, brain and ecosystem
 * modules together (src/sim `sim` = createSim(realModules())). Short runs, so the fast suite can
 * afford them on a loaded machine; the long evolution numbers live in docs/spikes/integration-1.md.
 */
import { describe, expect, it } from 'vitest';
import { hashWorld, LIFE, type WorldConfig } from '../src/core/index.js';
import { ecosystem, isEcoLoaded } from '../src/ecosystem/index.js';
import { decodeWorld, encodeWorld } from '../src/host/snapshot.js';
import { drainEvents, sim, stateOf } from '../src/sim/index.js';
import { DEFAULT_DREAM_CONFIG } from '../src/sim/session.js';
import { decodeDreamWorld, encodeDreamWorld } from '../src/sim/autosave.js';

const CFG = (seedLo: number): WorldConfig => ({
  preset: 'small', seedLo, seedHi: 5, backend: 'cpu', agentCap: 600,
  founders: [{ template: 'motefly', count: 40 }, { template: 'meadowlamp', count: 10 }, { template: 'hushmaw', count: 2 }],
} as WorldConfig);

describe('real modules in the product sim', { timeout: 600_000 }, () => {
  it('uses the real modules, grows multi-part bodies and keeps the ledger exact on every ecology tick', () => {
    const w = sim.create(CFG(1));
    const mods = stateOf(w).modules;
    expect(mods.ecosystem).toBe(ecosystem);
    const c = w.cr.c;
    let multi = 0;
    for (let s = 0; s < w.cr.highWater; s++) if (c.life[s] === LIFE.ALIVE) { if (c.segCount[s]! > 1) multi++; expect(isEcoLoaded(w, s)).toBe(true); }
    expect(multi).toBeGreaterThan(20);
    let audits = 0;
    for (let i = 0; i < 450; i++) {
      sim.step(w);
      if ((w.g.tick - 1) % 3 === 0) { expect(ecosystem.audit(w).ok).toBe(true); audits++; }
    }
    drainEvents(w);
    expect(audits).toBe(150);
    let finite = true, moving = 0, muscles = 0;
    for (let s = 0; s < w.cr.highWater; s++) {
      if (c.life[s] !== LIFE.ALIVE) continue;
      if (!Number.isFinite(c.posX[s]!) || !Number.isFinite(c.posY[s]!) || !Number.isFinite(c.velX[s]!)) finite = false;
      if (Math.hypot(c.velX[s]!, c.velY[s]!) > 0) moving++;
      if (c.workJ[s]! > 0) muscles++;
    }
    expect(finite).toBe(true);
    expect(moving).toBeGreaterThan(30);
    expect(muscles).toBeGreaterThan(5); // brains drive muscles and physics books the work
  });

  it('is deterministic: same seed, same state hash', () => {
    const a = sim.create(CFG(2)), b = sim.create(CFG(2));
    for (let i = 0; i < 150; i++) { sim.step(a); sim.step(b); }
    expect(hashWorld(a)).toBe(hashWorld(b));
  });

  it('restores a .ptk snapshot that steps on bit for bit (sim, physics, brain and ecosystem side state)', () => {
    const a = sim.create(CFG(3));
    for (let i = 0; i < 100; i++) sim.step(a);
    const { world: b } = decodeWorld(encodeWorld(a, { kind: 'auto', journalSeq: 1, pending: [] }));
    expect(hashWorld(b)).toBe(hashWorld(a));
    for (let i = 0; i < 200; i++) { sim.step(a); sim.step(b); }
    expect(hashWorld(b)).toBe(hashWorld(a));
  });

  it('the dream-tank autosave (IndexedDB bytes) resumes bit for bit', () => {
    const a = sim.create(CFG(4));
    for (let i = 0; i < 60; i++) sim.step(a);
    const b = decodeDreamWorld(encodeDreamWorld(a), sim);
    for (let i = 0; i < 90; i++) { sim.step(a); sim.step(b); }
    expect(hashWorld(b)).toBe(hashWorld(a));
  });

  it('the v0.1 dream tank seeds a mixed food web', () => {
    const roles = new Set(DEFAULT_DREAM_CONFIG.founders!.map((f) => f.template));
    expect(roles.size).toBeGreaterThanOrEqual(4);
  });
});
