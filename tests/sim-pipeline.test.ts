/**
 * src/sim pipeline: determinism, the exact ledger through births and deaths, the commit order,
 * slot reuse, segment compaction, the agent-cap tax (CONTRACT 9.6, review R11), the journal
 * (CONTRACT 4.4, 10.1 step 0) and the fallback flow rebuild.
 */
import { describe, expect, it } from 'vitest';
import {
  agentCapFeeKgFn, CF, encodeGenome, GOVERNOR_EVERY, LIFE, M_REF_1CM, Q_MASS, T, TRAITS, encodeQ,
  type Genome, type WorldConfig,
} from './sim-helpers.js';
import { ecosystem } from '../src/ecosystem/index.js';
import {
  appliedJournal, compactSegments, createSim, drainChannels, drainEvents, entityId, killNow, requestBirth, requestDeath, requestRestage,
  requestsOf, schedule, sim, stateDigest, stateOf, type SimConfig,
} from '../src/sim/index.js';
import { fallbackGenome } from '../src/sim/fallback/genome.js';
import { runHeadless } from '../src/sim/runner.js';
import { fastGenome } from './sim-helpers.js';
import { allocSegments, freeSegments } from '../src/sim/commit.js';

/** Move q quanta from dissolved N into a creature's repro pool (ledger-exact). */
function fund(w: ReturnType<typeof sim.create>, slot: number, q: number): void {
  let need = q;
  for (let i = 0; i < w.fields.qN.length && need > 0; i++) { const t = Math.min(need, w.fields.qN[i]!); w.fields.qN[i]! -= t; need -= t; }
  w.cr.c.qRepro[slot]! += q - need;
}

const cfg = (seedLo: number, extra: Partial<SimConfig> = {}): SimConfig => ({
  preset: 'small', seedLo, seedHi: 3, backend: 'cpu',
  founders: [{ template: 'motefly', count: 120, genome: fastGenome() }], ...extra,
});

describe('sim pipeline', { timeout: 180_000 }, () => {
  it('is deterministic with births and deaths: same seed, same hash and digest', () => {
    const a = runHeadless(cfg(11), { ticks: 3000, auditEvery: 0 });
    const b = runHeadless(cfg(11), { ticks: 3000, auditEvery: 0 });
    expect(a.summary.births).toBeGreaterThan(0);
    expect(a.summary.hash).toBe(b.summary.hash);
    expect(a.summary.digest).toBe(b.summary.digest);
    const c = runHeadless(cfg(12), { ticks: 3000, auditEvery: 0 });
    expect(c.summary.hash).not.toBe(a.summary.hash);
  });

  it('keeps the ledger exact on every ecology tick through births, deaths and decay', () => {
    const { summary, world } = runHeadless(cfg(21), { ticks: 6000, auditEvery: 1 });
    expect(summary.births).toBeGreaterThan(20);
    expect(Object.values(summary.deaths).reduce((x, y) => x + y, 0)).toBeGreaterThan(0);
    expect(summary.audits).toBe(2001);
    expect(summary.auditFailures).toEqual([]);
    expect(ecosystem.audit(world).totalQ).toBe(world.g.mTotalQ);
    expect(summary.maxGeneration).toBeGreaterThanOrEqual(1);
  });

  it('counts agents consistently with the slots', () => {
    const { world } = runHeadless(cfg(5), { ticks: 3000, auditEvery: 0 });
    const c = world.cr.c;
    let live = 0, carc = 0;
    for (let s = 0; s < world.cr.highWater; s++) {
      if (c.life[s] === LIFE.ALIVE) live++;
      if (c.life[s] === LIFE.CARCASS) carc++;
    }
    expect(live).toBe(world.g.liveCount);
    expect(carc).toBe(world.g.carcassCount);
    const st = stateOf(world);
    expect(st.species.living().reduce((n, r) => n + r.count, 0)).toBe(live);
  });
});

describe('birth and death commit (CONTRACT 9.6)', { timeout: 180_000 }, () => {
  /** Step to just after the next ecology tick's commit. */
  const toCommit = (w: ReturnType<typeof sim.create>): void => { do sim.step(w); while ((w.g.tick - 1) % 3 !== 0); };

  it('commits births in (parentEntityId, requestIndex) order and reuses the lowest free slots', () => {
    const w = sim.create(cfg(31, { founders: [{ template: 'motefly', count: 12, genome: fastGenome() }] }));
    const c = w.cr.c;
    // free slots 3 and 7: kill, then empty their pools into dissolved N (ledger-exact)
    for (const s of [7, 3]) {
      killNow(w, s, 'disaster');
      const q = c.qTissue[s]! + c.qReserve[s]! + c.qRepro[s]! + c.qGut[s * 3]!;
      c.qTissue[s] = 0; c.qReserve[s] = 0; c.qRepro[s] = 0; c.qGut[s * 3] = 0;
      w.fields.qN[0]! += q;
    }
    const gen3 = c.gen[3]!;
    // two parents, requested out of order; give them reserve to pay from their own tissue mass
    for (const p of [9, 5]) fund(w, p, 1e6);
    drainEvents(w);
    requestBirth(w, { parentSlot: 9, mode: 'bud', mateSlot: -1, n: 1, tick: w.g.tick });
    requestBirth(w, { parentSlot: 5, mode: 'bud', mateSlot: -1, n: 1, tick: w.g.tick });
    toCommit(w);
    const births = drainEvents(w).filter((e) => e.k === 'birth');
    expect(births.length).toBe(2);
    // the lower parent id is committed first, so it takes the lower slot
    expect(births.map((b) => (b as { parents: number[] }).parents[0])).toEqual([entityId(w, 5), entityId(w, 9)]);
    expect(entityId(w, 3)).toBe(births[0]!.k === 'birth' ? births[0]!.id : -1);
    expect(entityId(w, 7)).toBe(births[1]!.k === 'birth' ? births[1]!.id : -1);
    expect(c.gen[3]).toBe((gen3 + 1) & 0xffff);
    expect(ecosystem.audit(w).ok).toBe(true);
  });

  it('turns deaths into carcasses that keep their mass, and frees empty carcasses', () => {
    const w = sim.create(cfg(32, { founders: [{ template: 'motefly', count: 8, genome: fastGenome() }] }));
    const before = ecosystem.audit(w).totalQ;
    requestDeath(w, 2, 'age', w.g.tick);
    requestDeath(w, 2, 'starvation', w.g.tick); // a second request for the same entity is ignored
    toCommit(w);
    const deaths = drainEvents(w).filter((e) => e.k === 'death');
    expect(deaths.length).toBe(1);
    expect((deaths[0] as { cause: string }).cause).toBe('age');
    expect(w.cr.c.life[2]).toBe(LIFE.CARCASS);
    expect(w.g.carcassCount).toBe(1);
    expect(ecosystem.audit(w).totalQ).toBe(before);
    // carcasses decay to detritus and are then freed
    for (let i = 0; i < 30 * 600 && w.cr.c.life[2] === LIFE.CARCASS; i++) sim.step(w);
    expect(w.cr.c.life[2]).not.toBe(LIFE.CARCASS);
    expect(ecosystem.audit(w).ok).toBe(true);
  });

  it('charges the additive agent-cap fee from n_agents at the start of the tick (R11)', () => {
    const cap = 64;
    const w = sim.create(cfg(33, { agentCap: cap, founders: [{ template: 'motefly', count: 48, genome: fastGenome() }] }));
    const c = w.cr.c;
    void c;
    // enough for one offspring plus a full fee, but not two
    fund(w, 0, Math.floor(1.05 * M_REF_1CM / Q_MASS));
    drainChannels(w);
    requestBirth(w, { parentSlot: 0, mode: 'bud', mateSlot: -1, n: 1, tick: w.g.tick });
    toCommit(w);
    const ch = drainChannels(w);
    const s = (48 / cap - 0.5) / 0.5;
    expect(agentCapFeeKgFn(48, cap)).toBeCloseTo(M_REF_1CM * s * s, 15);
    expect(ch[12]).toBe(Math.floor(agentCapFeeKgFn(48, cap) / Q_MASS));
    expect(w.g.liveCount).toBe(49);
    expect(ecosystem.audit(w).ok).toBe(true);
  });

  it('defers births at the agent cap, never drops them', () => {
    const w = sim.create(cfg(34, { agentCap: 16, founders: [{ template: 'motefly', count: 16, genome: fastGenome() }] }));
    const c = w.cr.c;
    fund(w, 1, 4e7); // the full cap fee is M_REF_1CM = 3.1e7 quanta
    requestBirth(w, { parentSlot: 1, mode: 'bud', mateSlot: -1, n: 1, tick: w.g.tick });
    toCommit(w);
    expect(requestsOf(w).deferred.length).toBe(1);
    expect(stateOf(w).deferredBirths).toBe(1);
    expect(w.g.liveCount).toBe(16);
    // free a slot completely: the deferred birth then lands in it
    killNow(w, 6, 'disaster');
    const q = c.qTissue[6]! + c.qReserve[6]! + c.qRepro[6]! + c.qGut[18]!;
    c.qTissue[6] = 0; c.qReserve[6] = 0; c.qRepro[6] = 0; c.qGut[18] = 0; w.fields.qN[0]! += q;
    drainEvents(w);
    toCommit(w);
    toCommit(w);
    const births = drainEvents(w).filter((e) => e.k === 'birth');
    expect(births.length).toBe(1);
    expect(entityId(w, 6)).toBe((births[0] as { id: number }).id);
    expect(requestsOf(w).deferred.length).toBe(0);
    expect(ecosystem.audit(w).ok).toBe(true);
  });

  it('mates sexually per SEX_PROB and records both parents', () => {
    const w = sim.create(cfg(35, { founders: [{ template: 'motefly', count: 300, genome: fastGenome(1) }] }));
    let sex = 0, mates = 0;
    for (let i = 0; i < 6000; i++) {
      sim.step(w);
      for (const e of drainEvents(w)) {
        if (e.k === 'birth') { expect(e.mode).toBe('sex'); expect(e.parents.length).toBe(2); sex++; }
        if (e.k === 'mate') mates++;
      }
    }
    expect(sex).toBeGreaterThan(0);
    expect(mates).toBeGreaterThan(0);
    expect(ecosystem.audit(w).ok).toBe(true);
  });

  it('compacts segment ranges and keeps their contents', () => {
    const w = sim.create(cfg(36, { founders: [{ template: 'motefly', count: 6, genome: fastGenome() }] }));
    const sg = w.seg.c;
    const c = w.cr.c;
    sg.len[c.segStart[4]!] = 0.123;
    freeSegments(w, 1); freeSegments(w, 2);
    compactSegments(w);
    const starts = [0, 3, 4, 5].map((s) => c.segStart[s]!);
    expect(starts).toEqual([0, 1, 2, 3]);
    expect(sg.len[c.segStart[4]!]).toBeCloseTo(0.123, 6);
    expect(sg.owner[2]).toBe(4);
    expect(w.seg.highWater).toBe(4);
    expect(allocSegments(w, 1, 1)).toBe(true);
    expect(c.segStart[1]).toBe(4);
  });
});

describe('journal (CONTRACT 4.4, 10.1 step 0)', { timeout: 180_000 }, () => {
  it('applies governor decisions only on GOVERNOR_EVERY ticks and records them', () => {
    const w = sim.create(cfg(41));
    expect(() => schedule(w, { tick: 7, kind: 'governor', decision: { brainDiv: 2 } })).toThrow();
    schedule(w, { tick: GOVERNOR_EVERY, kind: 'governor', decision: { brainDiv: 2 } });
    for (let i = 0; i < GOVERNOR_EVERY; i++) sim.step(w);
    expect(w.g.brainDiv).toBe(1);
    sim.step(w);
    expect(w.g.brainDiv).toBe(2);
    expect(appliedJournal(w).length).toBe(1);
    expect(() => schedule(w, { tick: 3, kind: 'governor', decision: {} })).toThrow();
  });

  it('applies god events at their fire tick and releases with injected mass', () => {
    const w = sim.create(cfg(42));
    schedule(w, {
      tick: 10, kind: 'god', ev: {
        cmdId: 'c1', power: 'bloom', target: { kind: 'point', pos: [5, 2] }, intensity: 0.3, duration: 60, seed: 1,
        issuedTick: 0, fireTick: 10, author: 'god', envelope: { attack: 1, sustain: 10, release: 5 },
      },
    });
    schedule(w, { tick: 20, kind: 'release', release: { cmdId: 'r1', genome: fastGenome(), pos: [10, 4], count: 5, asLeviathan: false, founderProtection: true } });
    const m0 = w.g.mTotalQ;
    const live0 = w.g.liveCount;
    const seen: string[] = [];
    for (let i = 0; i < 30; i++) { sim.step(w); for (const e of drainEvents(w)) seen.push(`${e.k}@${e.t}`); }
    expect(seen).toContain('god@10');
    expect(seen).toContain('release@20');
    expect(w.g.mTotalQ).toBeGreaterThan(m0);
    expect(w.g.liveCount).toBe(live0 + 5);
    expect(ecosystem.audit(w).ok).toBe(true);
    const c = w.cr.c;
    let prot = 0;
    for (let s = 0; s < w.cr.highWater; s++) if (c.flags[s]! & CF.FOUNDER_PROTECTED) prot++;
    expect(prot).toBe(5);
  });

  it('replays: the same journal on the same seed gives the same hash', () => {
    const run = (): string => {
      const w = sim.create(cfg(43));
      schedule(w, { tick: 300, kind: 'governor', decision: { popSoftLimit: 130 } });
      schedule(w, { tick: 50, kind: 'release', release: { cmdId: 'r', genome: fastGenome(), pos: [3, 3], count: 4, asLeviathan: false, founderProtection: false } });
      for (let i = 0; i < 1500; i++) sim.step(w);
      return `${sim.hash(w)}:${stateDigest(w)}`;
    };
    expect(run()).toBe(run());
  });
});

describe('fallback modules', { timeout: 180_000 }, () => {
  // 'the fast flow rebuild is bit-identical to the ecosystem one' was removed at the ecosystem
  // merge: the real flow is now terrain-following, and the fallback uses the real stepSlow.
  it('createSim takes a partial module set and falls back for the rest', () => {
    const core = createSim({ genome: fallbackGenome });
    const w = core.create(cfg(52) as WorldConfig);
    for (let i = 0; i < 90; i++) core.step(w);
    expect(w.g.liveCount).toBe(120);
  });
});

describe('restage at commit', { timeout: 180_000 }, () => {
  it('reallocates the segment range when the part count changes, keeping neighbours intact', () => {
    const grow: typeof fallbackGenome = {
      ...fallbackGenome,
      develop(g, m, env, opts) {
        const p = fallbackGenome.develop(g, m, env, opts);
        if (m < 0.5) return p;
        return { ...p, nParts: 3, parent: Int16Array.of(-1, 0, 1), kind: Uint8Array.of(0, 0, 1), organs: Uint16Array.of(p.organs[0]!, 0, 0) };
      },
    };
    const core = createSim({ genome: grow });
    const w = core.create(cfg(61, { founders: [{ template: 'motefly', count: 4, genome: fastGenome() }] }) as WorldConfig);
    const c = w.cr.c;
    // founders start at maturity 0.3 to 0.9: find one below 0.5 and grow it
    let s = -1;
    for (let k = 0; k < 4; k++) if (c.maturity[k]! < 0.5) { s = k; break; }
    if (s < 0) { s = 0; c.maturity[0] = 0.2; }
    const before = [0, 1, 2, 3].filter((k) => k !== s).map((k) => [k, c.segStart[k]!, w.seg.c.owner[c.segStart[k]!]!]);
    c.maturity[s] = 0.8;
    requestRestage(w, s);
    do core.step(w); while ((w.g.tick - 1) % 3 !== 0);
    expect(c.segCount[s]).toBe(3);
    const k0 = c.segStart[s]!;
    expect([0, 1, 2].map((i) => w.seg.c.owner[k0 + i])).toEqual([s, s, s]);
    expect([...w.seg.c.parent.subarray(k0, k0 + 3)]).toEqual([-1, 0, 1]);
    for (const [k, , owner] of before) expect(w.seg.c.owner[c.segStart[k!]!]).toBe(owner);
    expect(ecosystem.audit(w).ok).toBe(true);
  });
});
