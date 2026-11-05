/**
 * src/ui second pass: localised slider labels (UX-T37), species renaming (07 §6.4, UX-T39 in
 * part), knobs and presets (07 §3.9), trophic levels (UX-T27), the food web and gene drift
 * against the mock, the onboarding state machine (07 §5.2), gamepad polling (UX-T36 in part),
 * and the CENSUS fallback for the real host.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { BRAIN_TRAITS, decodeCborFrame, encodeCborFrame, FRAME, TRAITS, type CborValue, type SimLink } from '../src/core/index.js';
import { setLocale } from '../src/ui/i18n.js';
import { EN2, SV2 } from '../src/ui/i18n2.js';
import { BRAIN_LABELS, groupLabel, missingLabels, traitLabel, TRAIT_LABELS } from '../src/ui/labels.js';
import { checkRename, NameBook, parseRenameValue, renameKey, renameValue } from '../src/ui/naming.js';
import { clampKnob, KNOBS, knobFromX, knobToX, matchPreset, presetValues } from '../src/ui/god/knobs.js';
import { buildWeb, layoutWeb, trophicLevels } from '../src/ui/god/foodweb.js';
import { ABIOTIC } from '../src/ui/god/wire.js';
import { initialState, LIVING_MIN, step, type OnbState } from '../src/ui/onboarding.js';
import { deadZone, GamepadPoller, PAD } from '../src/ui/gamepad.js';
import { MockSimLink } from '../src/ui/mock-sim.js';
import { GodClient } from '../src/ui/god/client.js';

// a tiny in-memory localStorage, so per-viewer mirrors can be tested in node
class MemStore { private m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } removeItem(k: string) { this.m.delete(k); } clear() { this.m.clear(); } }
beforeEach(() => { (globalThis as { localStorage?: unknown }).localStorage = new MemStore(); setLocale('en'); });

function rig() {
  const clock = { t: 0 };
  const link = new MockSimLink({ autoStart: false, warmupTicks: 300, now: () => clock.t });
  const client = new GodClient(link, () => clock.t);
  const pump = (ms: number, steps = 1) => { for (let i = 0; i < steps; i++) { clock.t += ms; link.pump(ms); } };
  return { link, client, pump, clock };
}

describe('localised slider labels (UX-T37)', () => {
  it('every schema trait, brain trait and group has an English and a Swedish label', () => {
    expect(missingLabels()).toEqual([]);
    for (const s of TRAITS) if (s) { const p = TRAIT_LABELS[s.name]!; expect(p[0].length).toBeGreaterThan(1); expect(p[1].length).toBeGreaterThan(1); }
  });
  it('labels follow the locale and never show schema identifiers', () => {
    setLocale('sv');
    expect(traitLabel('ADULT_LENGTH')).toBe('Vuxenlängd');
    expect(traitLabel('DRIVE_HUNGER_TAU', 'B')).toBe('Hunger: avklingningstid');
    expect(traitLabel('RULE2_CH', 'B')).toBe('Regel 3: kanal');
    expect(groupLabel('Personality')).toBe('Personlighet');
    for (const s of [...TRAITS, ...BRAIN_TRAITS]) if (s) expect(traitLabel(s.name, BRAIN_TRAITS.includes(s) ? 'B' : 'T')).not.toMatch(/_/);
    setLocale('xx');
    expect(traitLabel('ADULT_LENGTH')).toMatch(/^\[.*~+\]$/);
    setLocale('en');
    expect(traitLabel('NOT_A_TRAIT_YET')).toBe('Not a trait yet');
    expect(Object.keys(BRAIN_LABELS).length).toBeGreaterThan(30);
  });
  it('second-pass messages exist in both languages', () => {
    expect(Object.keys(SV2).sort()).toEqual(Object.keys(EN2).sort());
  });
});

describe('species rename (07 §6.4)', () => {
  const others = [{ id: 1, name: 'Pratilux tondens' }, { id: 2, name: 'Pratilux caerula' }];
  it('normalises case, refuses bad lengths and characters, warns on duplicates', () => {
    const ok = checkRename({ genus: 'willia', epithet: 'Nocturna' }, others);
    expect([ok.genus, ok.epithet, ok.errors]).toEqual(['Willia', 'nocturna', []]);
    expect(checkRename({ genus: 'Wi', epithet: 'nocturna' }, others).errors).toContain('genusLength');
    expect(checkRename({ genus: 'Willia', epithet: 'a'.repeat(25) }, others).errors).toContain('epithetLength');
    expect(checkRename({ genus: 'Will1a', epithet: 'noc turna' }, others).errors).toContain('genusLetters');
    expect(checkRename({ genus: 'Glödia', epithet: 'älva-ljus' }, others).errors).toEqual([]);
    const dup = checkRename({ genus: 'pratilux', epithet: 'caerula' }, others, 1);
    expect(dup.errors).toEqual([]); expect(dup.warnings).toEqual(['duplicate']);
    expect(checkRename({ genus: 'Pratilux', epithet: 'caerula' }, others, 2).warnings).toEqual([]);
    // bidi and control characters are stripped before the checks
    expect(checkRename({ genus: 'Wil‮lia', epithet: 'noc\u0007turna' }, others).genus).toBe('Willia');
  });
  it('the setting value round-trips and stays under the host limit', () => {
    const v = renameValue({ genus: 'Willia', epithet: 'nocturna', common: 'Night lamp', wholeGenus: true });
    expect(v.length).toBeLessThanOrEqual(256);
    expect(parseRenameValue(v)).toEqual({ genus: 'Willia', epithet: 'nocturna', common: 'Night lamp', wholeGenus: true });
    expect(parseRenameValue('{"g":"X","e":"y"}')).toBeNull();
    expect(parseRenameValue(42)).toBeNull();
    expect(renameKey(7)).toBe('species.7.name');
  });
  it('user names win, whole-genus renames, daughters inherit a user genus, and the mirror persists', () => {
    const all = [
      { id: 0, name: 'Pratilux tondens', parent: -1 }, { id: 1, name: 'Pratilux caerula', parent: 0 },
      { id: 2, name: 'Pratilux spinata', parent: 1 }, { id: 3, name: 'Umbrasoma lenta', parent: 0 },
    ];
    const nb = new NameBook('w1');
    nb.rename(0, { genus: 'Willia', epithet: 'prima' }, all);
    expect(nb.display(all[0]!, all)).toBe('Willia prima');
    expect(nb.display(all[1]!, all)).toBe('Willia caerula'); // same generated genus as the renamed parent
    expect(nb.display(all[2]!, all)).toBe('Willia spinata'); // through two generations
    expect(nb.display(all[3]!, all)).toBe('Umbrasoma lenta'); // a new genus is not touched
    const changed = new NameBook('w2').rename(1, { genus: 'Nova', epithet: 'caerula', wholeGenus: true }, all);
    expect(changed.sort()).toEqual([0, 1, 2]);
    expect(new NameBook('w1').display(all[0]!, all)).toBe('Willia prima'); // persisted per world
    expect(new NameBook('other').display(all[0]!, all)).toBe('Pratilux tondens');
  });
  it('against the mock: rename shows at once, reaches the host, the timeline, and inherits on speciation', async () => {
    const { client, link, pump } = rig();
    pump(34, 30);
    const id = client.species[0]!.id;
    const r = await client.rename(id, { genus: 'Willia', epithet: 'nocturna', common: 'Night lamp' });
    expect(r.ok).toBe(true);
    expect(client.speciesName(id)).toBe('Willia nocturna');
    expect(link.species[id]!.name).toBe('Willia nocturna');
    pump(34, 3);
    expect(client.events.some((e) => (e as unknown as { k: string; to?: string }).k === 'rename')).toBe(true);
    // a host that sends a different generated name later still loses to the user name
    link.species[id]!.name = 'Pratilux regeneratus';
    pump(1000, 2);
    expect(client.speciesName(id)).toBe('Willia nocturna');
    expect(client.generatedName(id)).toBe('Pratilux regeneratus');
  });
  it('a host that does not know renames keeps the name on this viewer', async () => {
    const { client, link, pump } = rig();
    pump(34, 30);
    const orig = link.send.bind(link);
    // a host without the key: answer unknown-setting like mod/host does
    (link as unknown as { send: (f: Uint8Array) => void }).send = (f) => {
      if (f[0] === FRAME.COMMAND) { const p = decodeCborFrame(f).payload as { id: string }; client.ingest(encodeCborFrame(FRAME.COMMAND_RESULT, 1, { id: p.id, ok: false, reason: 'unknown-setting' })); return; }
      orig(f);
    };
    const r = await client.rename(1, { genus: 'Solia', epithet: 'remota' });
    expect(r).toMatchObject({ ok: false, reason: 'unknown-setting' });
    expect(client.speciesName(1)).toBe('Solia remota');
  });
});

describe('knobs and presets (07 §3.9)', () => {
  it('clamps, quantises and round-trips slider positions', () => {
    for (const k of KNOBS) {
      if (k.scale === 'enum') { expect(clampKnob(k, 'nonsense')).toBe(k.default); continue; }
      expect(clampKnob(k, k.max * 10)).toBe(k.max);
      expect(clampKnob(k, -1e12)).toBe(k.min);
      const v = Number(k.default);
      if (k.id !== 'world.seed') expect(Math.abs(knobFromX(k, knobToX(k, v)) - v)).toBeLessThanOrEqual(Math.max(0.01 * Math.abs(v), k.scale === 'int' ? 1 : 0.01));
    }
  });
  it('presets match themselves and Custom is anything else', () => {
    for (const p of ['gentle', 'harsh', 'fast'] as const) expect(matchPreset(presetValues(p))).toBe(p);
    expect(presetValues('harsh')['life.metabolic']).toBe(1.5);
    expect(presetValues('harsh')['eco.plankton']).toBe(0.7);
    expect(presetValues('fast')['life.mutation']).toBe(3);
    expect(matchPreset({ ...presetValues('gentle'), 'climate.current': 2 })).toBe('custom');
    expect(matchPreset({ ...presetValues('gentle'), 'world.size': 'large' })).toBe('gentle'); // new-world knobs do not count
  });
  it('the mock applies live knobs, refuses unknown and new-world keys, and logs a timeline event', async () => {
    const { client, link, pump } = rig();
    pump(34, 10);
    expect((await client.send({ t: 'setting', key: 'life.metabolic', value: 9 })).ok).toBe(true);
    expect(link.settings['life.metabolic']).toBe(2);
    expect((await client.send({ t: 'setting', key: 'no.such.knob', value: 1 })).reason).toBe('unknown-setting');
    expect((await client.send({ t: 'setting', key: 'world.size', value: 'large' })).ok).toBe(false);
    pump(1000, 2);
    expect(client.settings['life.metabolic']).toBe(2);
    expect(client.events.some((e) => (e as unknown as { k: string; key?: string }).k === 'setting')).toBe(true);
  });
  it('a new empty world bumps the epoch and starts with no creatures', async () => {
    const { client, link, pump } = rig();
    pump(34, 10);
    const e0 = client.epoch;
    expect((await client.send({ t: 'setting', key: 'world.new', value: JSON.stringify({ empty: true }) })).ok).toBe(true);
    pump(1000, 2);
    expect(client.epoch).toBe(e0 + 1);
    expect(link.creatures.length).toBe(0);
    expect(link.snapshots.some((s) => s.info.name === 'Before new world')).toBe(true);
  });
});

describe('food web (UX-T27)', () => {
  it('a 4-species chain gets trophic levels 1, 2, 3, 4', () => {
    // plankton -> grazer -> predator -> top predator; w[i][j] = share of j's intake from i
    const w = [[0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1], [0, 0, 0, 0]];
    const tl = trophicLevels(w, [true, false, false, false]);
    tl.forEach((v, i) => expect(Math.abs(v - (i + 1))).toBeLessThan(0.01));
  });
  it('an omnivore half on plankton and half on a grazer sits at 2.5; an unfed node at 1', () => {
    const w = [[0, 1, 0.5, 0], [0, 0, 0.5, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const tl = trophicLevels(w, [true, false, false, false]);
    expect(tl[2]).toBeCloseTo(2.5, 6);
    expect(tl[3]).toBe(1);
  });
  it('builds the web from host flows, merges duplicates, and lays it out stably', () => {
    const sp = (id: number, name: string) => ({ id, name, count: 10, biomassKg: id + 1, colour: [1, 2, 3] as [number, number, number], parent: -1, bornTick: 0, origin: 'natural' as const, glyph: id, prefDepth: 0.5 });
    const web = { windowS: 600, flows: [[ABIOTIC.plankton, 0, 5, 0], [0, 1, 2, 0], [0, 1, 1, 0], [1, 2, 1, 1], [ABIOTIC.detritus, 2, 1, 2]] as [number, number, number, 0 | 1 | 2][] };
    const m = buildWeb(web, [sp(0, 'A a'), sp(1, 'B b'), sp(2, 'C c')], (k) => k);
    expect(m.edges.find((e) => e.from === 0 && e.to === 1)!.flow).toBe(3);
    const tl = new Map(m.nodes.map((n) => [n.id, n.tl]));
    expect(tl.get(0)).toBeCloseTo(2, 9); expect(tl.get(1)).toBeCloseTo(3, 9); expect(tl.get(2)).toBeCloseTo(3, 9); // half from B (TL 3), half from detritus (TL 1)
    expect(m.nodes.filter((n) => n.abiotic).map((n) => n.label).sort()).toEqual(['detritus', 'plankton']);
    const a = layoutWeb(m, new Map()), b = layoutWeb(m, new Map());
    expect([...a]).toEqual([...b]);
    for (const x of a.values()) { expect(x).toBeGreaterThanOrEqual(0.03); expect(x).toBeLessThanOrEqual(0.97); }
    const again = layoutWeb(m, a, 5);
    for (const [id, x] of again) expect(Math.abs(x - a.get(id)!)).toBeLessThan(0.16); // seeded by the previous frame: no jump
  });
  it('the mock streams a web whose levels put Deepcrown on top and grazers near 2', () => {
    const { client, pump } = rig();
    pump(1000, 3);
    expect(client.web).not.toBeNull();
    const m = buildWeb(client.web!, client.species, (k) => k);
    const byCommon = (c: string) => m.nodes.find((n) => client.species.find((s) => s.id === n.id)?.common === c)?.tl ?? NaN;
    expect(byCommon('Meadowlamp')).toBeCloseTo(2, 6);
    expect(byCommon('Deepcrown')).toBeGreaterThan(byCommon('Hushmaw'));
    expect(byCommon('Hushmaw')).toBeGreaterThan(2.5);
  });
});

describe('gene drift (07 §3.6)', () => {
  it('the client keeps a time series of histograms per trait and species, reset on rewind', async () => {
    const { client, link, pump } = rig();
    for (let i = 0; i < 30; i++) pump(5000);
    const d = client.drift.ADULT_LENGTH!;
    const series = Object.values(d)[0]!;
    expect(series.length).toBeGreaterThan(5);
    for (let i = 1; i < series.length; i++) expect(series[i]![0]).toBeGreaterThan(series[i - 1]![0]);
    for (const [, bins] of series) expect(bins.length).toBe(32);
    // Deepcrown's adult size creeps up in the mock: its mean bin rises over the run
    const deep = client.species.find((s) => s.common === 'Deepcrown')!;
    const mean = (b: number[]) => b.reduce((a, v, i) => a + v * i, 0) / Math.max(1, b.reduce((a, v) => a + v, 0));
    const ds = d[String(deep.id)]!;
    expect(mean(ds[ds.length - 1]![1])).toBeGreaterThan(mean(ds[0]![1]));
    const snap = link.snapshots[0]!.info.id;
    await client.send({ t: 'rewind', snapshotId: snap });
    // the new epoch's WELCOME brings one fresh sample per species; the old series is gone
    for (const bySp of Object.values(client.drift)) for (const ser of Object.values(bySp)) expect(ser.length).toBe(1);
  });
});

describe('onboarding state machine (07 §5.2)', () => {
  const run = (evs: Parameters<typeof step>[1][], from: OnbState = { s: 'firstRun' }) => evs.reduce(step, from);
  it('seeds until the tank is living, then welcomes', () => {
    expect(run([{ e: 'world', creatures: 3 }]).s).toBe('seeding');
    expect(run([{ e: 'world', creatures: 3 }, { e: 'world', creatures: LIVING_MIN }]).s).toBe('welcome');
  });
  it('the tour advances only on the action it asks for, then shows the views card', () => {
    const w: OnbState = { s: 'welcome' };
    expect(run([{ e: 'tour' }, { e: 'cast' }], w)).toEqual({ s: 'tour', step: 1 });
    expect(run([{ e: 'tour' }, { e: 'inspected' }, { e: 'cast' }, { e: 'designer' }], w).s).toBe('setup');
    expect(run([{ e: 'tour' }, { e: 'inspected' }, { e: 'cast' }, { e: 'designer' }, { e: 'setupDone' }], w).s).toBe('done');
  });
  it('every step can be skipped; Just watch and idle finish; Start empty needs a confirm', () => {
    for (const st of [{ s: 'tour', step: 1 }, { s: 'tour', step: 2 }, { s: 'tour', step: 3 }, { s: 'setup' }, { s: 'welcome' }] as OnbState[]) expect(step(st, { e: 'skip' }).s).toBe('done');
    expect(step({ s: 'welcome' }, { e: 'idle' }).s).toBe('done');
    expect(step({ s: 'welcome' }, { e: 'watch' }).s).toBe('done');
    expect(run([{ e: 'empty' }, { e: 'emptyCancelled' }], { s: 'welcome' }).s).toBe('welcome');
    expect(run([{ e: 'empty' }, { e: 'emptyConfirmed' }], { s: 'welcome' }).s).toBe('done');
    expect(step({ s: 'done', minimised: true }, { e: 'reopen' }).s).toBe('welcome');
  });
  it('saved flags skip the welcome on later visits', () => {
    expect(initialState(null).s).toBe('firstRun');
    expect(initialState({ version: 1, tourDone: true, viewsSetupDismissed: true, welcomed: true }).s).toBe('done');
    expect(initialState({ version: 0, tourDone: true, viewsSetupDismissed: true, welcomed: true }).s).toBe('firstRun');
  });
});

describe('gamepad polling (UX-T36)', () => {
  const pad = (pressed: number[], axes = [0, 0, 0, 0]) => ({ connected: true, id: 'test pad', axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0, touched: false })) }) as unknown as Gamepad;
  it('reports presses once on the edge, repeats the D-pad, and applies the dead zone', () => {
    let cur = pad([]);
    const got: number[] = [];
    const p = new GamepadPoller((b) => got.push(b), () => [cur]);
    p.poll(0);
    cur = pad([PAD.A]); p.poll(10); p.poll(20); p.poll(500);
    expect(got).toEqual([PAD.A]);
    cur = pad([PAD.RIGHT]); p.poll(600); p.poll(700); p.poll(1100); p.poll(1300);
    expect(got.filter((b) => b === PAD.RIGHT).length).toBeGreaterThanOrEqual(2);
    cur = pad([], [0.1, -0.9, 0, 0]); p.poll(1400);
    expect(p.state!.lx).toBe(0);
    expect(p.state!.ly).toBeLessThan(-0.8);
    expect(deadZone(1)).toBe(1);
    expect(p.poll.bind(p)).not.toThrow();
  });
  it('no pad means no state', () => {
    const p = new GamepadPoller(() => {}, () => [null]);
    p.poll(0);
    expect(p.state).toBeNull();
  });
});

describe('the real host link: CENSUS fallback', () => {
  it('a host whose STATS has no species list still gives the god window species from CENSUS', () => {
    let cb: ((f: Uint8Array) => void) | null = null;
    const link: SimLink = { kind: 'socket', onFrame: (f) => { cb = f; }, send: () => {}, close: () => {} };
    const client = new GodClient(link);
    const push = (type: number, v: unknown) => cb!(encodeCborFrame(type, 10, v as CborValue));
    push(FRAME.WELCOME, { worldId: 'w', tickHi: 0, epoch: 0, tickHz: 30, tank: { w: 32, h: 18, preset: 'small' }, lCeiling: 0.126, speciesTable: [{ id: 4, name: 'Pratilux tondens' }] });
    push(FRAME.STATS, { tick: 10, epoch: 0, population: 12, speciesCount: 2 }); // mod/host's shape today
    push(FRAME.CENSUS, { species: [{ id: 4, count: 9, biomassKg: 0.1, colour: [1, 2, 3] }, { id: 5, count: 3, biomassKg: 0.05, colour: [4, 5, 6] }] });
    expect(client.species.map((s) => [s.id, s.name, s.count])).toEqual([[4, 'Pratilux tondens', 9], [5, 'Species 5', 3]]);
    expect(client.speed.requested).toBe(1);
  });
});
