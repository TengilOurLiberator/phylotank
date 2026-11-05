import { appendFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FormatError, hashWorld, PTK_SCHEMA_VERSION, type WorldConfig } from '../src/core/index.js';
import { schedule, sim } from '../src/sim/index.js';
import { migrateSections, type Migration } from '../src/host/migrations.js';
import { decodeWorld, encodeWorld } from '../src/host/snapshot.js';
import { readJournalBytes, WorldStore } from '../src/host/store.js';
import { HostWorld } from '../src/host/world-host.js';

const CFG: WorldConfig = { preset: 'small', seedLo: 7, seedHi: 9, backend: 'cpu', skeletonMotes: 300 };
const tmp = (): string => mkdtempSync(join(tmpdir(), 'ptk-world-'));

/** A tiny deterministic generator for the fuzz loops (tests only, never the sim). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

describe('.ptk world snapshots', () => {
  it('round-trip exactly and keep stepping bit for bit', () => {
    const a = sim.create(CFG);
    for (let i = 0; i < 50; i++) sim.step(a);
    const bytes = encodeWorld(a, { kind: 'auto', journalSeq: 1, pending: [] });
    const { world: b, meta } = decodeWorld(bytes);
    expect(meta.config.preset).toBe('small');
    expect(hashWorld(b)).toBe(hashWorld(a));
    for (let i = 0; i < 300; i++) { sim.step(a); sim.step(b); }
    expect(hashWorld(b)).toBe(hashWorld(a));
    expect(b.g.tick).toBe(350);
  });

  it('keeps scheduled inputs in EVTQ', () => {
    const a = sim.create(CFG);
    const entry = { tick: 40, kind: 'governor' as const, decision: { brainDiv: 2 as const } };
    schedule(a, entry);
    const { pending } = decodeWorld(encodeWorld(a, { kind: 'auto', journalSeq: 1, pending: [entry] }));
    expect(pending).toEqual([entry]);
  });

  it('rejects corruption with a FormatError and never crashes on fuzzed input', () => {
    const a = sim.create(CFG);
    const good = encodeWorld(a, { kind: 'auto', journalSeq: 1, pending: [] });
    const flipped = good.slice();
    flipped[flipped.length - 40]! ^= 0xff;
    expect(() => decodeWorld(flipped)).toThrow(FormatError);
    const rnd = lcg(42);
    let rejected = 0;
    for (let k = 0; k < 150; k++) {
      const f = good.slice(0, k % 7 === 0 ? Math.floor(rnd() * good.length) : good.length);
      const flips = 1 + Math.floor(rnd() * 8);
      for (let i = 0; i < flips && f.length > 0; i++) f[Math.floor(rnd() * f.length)] = Math.floor(rnd() * 256);
      try { decodeWorld(f); } catch (e) {
        expect(e).toBeInstanceOf(Error);
        rejected++;
        if (!(e instanceof FormatError)) throw new Error(`non-format error: ${(e as Error).message}`);
      }
    }
    expect(rejected).toBeGreaterThan(100);
  });
});

describe('migrations', () => {
  it('apply in a chain and refuse newer files', () => {
    const chain: Migration[] = [
      { from: 0, description: 'rename OLDM to META', apply: (s) => { s.set('META', s.get('OLDM')!); s.delete('OLDM'); return s; } },
      { from: 1, description: 'add a flag section', apply: (s) => { s.set('FLAG', new Uint8Array([1])); return s; } },
    ];
    const out = migrateSections(0, new Map([['OLDM', new Uint8Array([9])]]), 2, chain);
    expect([...out.keys()].sort()).toEqual(['FLAG', 'META']);
    expect(() => migrateSections(PTK_SCHEMA_VERSION + 1, new Map())).toThrow(/newer Phylotank/);
    expect(() => migrateSections(0, new Map(), 2, chain.slice(1))).toThrow(/no migration/);
  });
});

describe('world directory, journal and recovery', () => {
  it('replays the journal after a crash to the same state hash', () => {
    const dir = tmp();
    const a = HostWorld.open({ dir, config: CFG });
    expect(a.recovery.created).toBe(true);
    a.step(850);
    a.schedule({ tick: 900, kind: 'governor', decision: { brainDiv: 2 } });
    a.step(150); // crash after 1000 ticks without a clean close
    const ref = sim.create(CFG);
    schedule(ref, { tick: 900, kind: 'governor', decision: { brainDiv: 2 } });
    for (let i = 0; i < 901; i++) sim.step(ref);

    const b = HostWorld.open({ dir, config: CFG });
    expect(b.recovery.created).toBe(false);
    expect(b.recovery.replayedTicks).toBe(901);
    expect(b.recovery.hashChecks).toBe(3);
    expect(b.recovery.mismatchAt).toBeUndefined();
    expect(b.world.g.brainDiv).toBe(2);
    expect(hashWorld(b.world)).toBe(hashWorld(ref));
    a.close(); b.close();
  });

  it('survives a torn journal tail and falls back past a corrupt snapshot', () => {
    const dir = tmp();
    const a = HostWorld.open({ dir, config: CFG });
    a.step(600);
    const second = a.save('auto')!;
    a.step(300); // hash records at 768
    a.close();
    const store = new WorldStore(dir);
    const last = store.listJournals().at(-1)!;
    appendFileSync(last.path, new Uint8Array([200, 0, 0, 0, 1, 2, 3]));
    expect(readJournalBytes(new Uint8Array(readFileSync(last.path))).torn).toBe(true);
    const bytes = readFileSync(second.path);
    bytes[bytes.length - 20]! ^= 0x55;
    writeFileSync(second.path, bytes);

    const b = HostWorld.open({ dir, config: CFG });
    expect(b.recovery.failed.map((f) => f.id)).toEqual([second.id]);
    expect(b.recovery.base).toMatch(/^auto-e0000-t000000000000/);
    expect(b.recovery.tornJournals).toBe(1);
    expect(b.tick).toBe(768);
    expect(b.recovery.hashChecks).toBe(3);
    const ref = sim.create(CFG);
    for (let i = 0; i < 768; i++) sim.step(ref);
    expect(hashWorld(b.world)).toBe(hashWorld(ref));
    b.close(); store.close();
  });

  it('keeps the last 6 autosaves and every manual snapshot', () => {
    const dir = tmp();
    const a = HostWorld.open({ dir, config: CFG });
    a.save('manual', 'First light!');
    for (let i = 0; i < 9; i++) { a.step(10); a.save('auto'); }
    const snaps = a.listSnapshots();
    expect(snaps.filter((s) => s.kind === 'auto')).toHaveLength(6);
    expect(snaps.filter((s) => s.kind === 'manual').map((s) => s.label)).toEqual(['first-light']);
    expect(readdirSync(join(dir, 'snapshots')).some((f) => f.endsWith('.tmp'))).toBe(false);
    // journals older than the oldest kept snapshot are pruned
    const minSeq = Math.min(...snaps.map((s) => s.journalSeq));
    expect(new WorldStore(dir).listJournals().every((j) => j.seq >= minSeq)).toBe(true);
    a.close();
  });

  it('rewinds in place with a new epoch and a beforeRewind snapshot', () => {
    const dir = tmp();
    const a = HostWorld.open({ dir, config: CFG });
    a.step(30);
    const undo = a.save('beforePower', 'meteor')!;
    const hAt30 = hashWorld(a.world);
    a.step(100);
    a.rewind(undo.id);
    expect(a.epoch).toBe(1);
    expect(a.tick).toBe(30);
    const snaps = a.listSnapshots();
    expect(snaps.some((s) => s.kind === 'beforeRewind' && s.tick === 130)).toBe(true);
    expect(snaps[0]!.epoch).toBe(1);
    a.step(50);
    a.close();
    const b = HostWorld.open({ dir, config: CFG });
    expect(b.epoch).toBe(1);
    expect(b.tick).toBe(30);
    expect(hashWorld(b.world)).not.toBe(hAt30); // the epoch is part of the globals
    b.close();
  });
});
