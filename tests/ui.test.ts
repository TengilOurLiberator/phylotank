/** src/ui unit and property tests (07 §9: UX-T01 to T07, T10 to T12, T21 to T24 against the mock, T28, T31, T37). */
import { describe, expect, it } from 'vitest';
import {
  BRAIN_TRAITS, decodeCborFrame, decodeGenome, encodeCborFrame, encodeGenome, FRAME, GENOME_FLAG_LEVIATHAN, KIND, readHeader,
  TRAITS, VIEW_PROFILES, type CborValue, type CommandResult, type SimEvent,
} from '../src/core/index.js';
import { CaptionScheduler, captionFor } from '../src/ui/captions.js';
import { format, LOCALES, setLocale, t } from '../src/ui/i18n.js';
import { MockSimLink } from '../src/ui/mock-sim.js';
import { GodClient } from '../src/ui/god/client.js';
import { CastController, HOLD_MS, inTarget, POWER_SPECS } from '../src/ui/god/powers.js';
import { diversity } from '../src/ui/god/diversity.js';
import { mulberry32 } from '../src/ui/dom.js';
import {
  addPart, breakOut, deleteRule, duplicateRule, getModule, getTrait, History, sameBytes, setModuleField, setTrait, view,
} from '../src/ui/designer/model.js';
import { sketch } from '../src/ui/designer/body.js';
import { basalW, computeBudget, validate } from '../src/ui/designer/budget.js';
import { TEMPLATES, templateGenome } from '../src/ui/designer/templates.js';
import { designString, importDesign, makeMeta, packDesign } from '../src/ui/designer/library.js';
import { byteCapacity, encodeQr, formatBits, rsDivisor, rsRemainder } from '../src/ui/designer/qr.js';

const L_CEIL = 0.126;

describe('i18n (UX-T37)', () => {
  it('Swedish has every English key and every message formats', () => {
    const en = Object.keys(LOCALES.en), sv = Object.keys(LOCALES.sv);
    expect(sv.sort()).toEqual(en.sort());
    const vars = new Proxy({}, { get: () => 3 }) as Record<string, number>;
    for (const loc of ['en', 'sv'] as const) for (const k of en) expect(() => format(LOCALES[loc][k as keyof typeof LOCALES.en], vars, loc)).not.toThrow();
  });
  it('plurals and Swedish numbers', () => {
    expect(format(LOCALES.en['count.creatures'], { n: 1 }, 'en')).toBe('1 creature');
    expect(format(LOCALES.en['count.creatures'], { n: 12345.6 }, 'en')).toBe('12,345.6 creatures');
    expect(format(LOCALES.sv['count.creatures'], { n: 12345.6 }, 'sv').replace(/\s/g, ' ')).toBe('12 345,6 varelser');
    setLocale('sv'); expect(t('power.meteor')).toBe('Meteornedslag'); setLocale('en');
  });
});

describe('captions (UX-T31, DESIGN R30)', () => {
  it('a burst of 50 events in 60 s gives at most 2 screensaver captions, highest priority first', () => {
    const p = VIEW_PROFILES.screensaver.captions!;
    const s = new CaptionScheduler(p.holdS, p.minGapS);
    const r = mulberry32(3);
    for (let i = 0; i < 600; i++) {
      const now = i * 0.1;
      if (i % 12 === 0) s.offer({ text: `e${i}`, priority: i === 0 ? 0.5 : r(), at: now });
      if (i === 1) s.offer({ text: 'big', priority: 2, at: now });
      s.update(now);
    }
    expect(s.history.length).toBeLessThanOrEqual(2);
    expect(s.history[0]!.text).toBe('e0');
    expect(s.history[1]!.start - s.history[0]!.start).toBeGreaterThanOrEqual(45);
  });
  it('fades in over 1 s, holds, fades out; TV gap is 25 s', () => {
    const p = VIEW_PROFILES.tv.captions!;
    const s = new CaptionScheduler(p.holdS, p.minGapS);
    s.offer({ text: 'a', priority: 1, at: 0 });
    expect(s.update(0)!.alpha).toBe(0);
    expect(s.update(0.5)!.alpha).toBeCloseTo(0.5);
    expect(s.update(3)!.alpha).toBe(1);
    expect(s.update(1 + 6 + 0.75)!.alpha).toBeCloseTo(0.5);
    expect(s.update(9)).toBeNull();
    s.offer({ text: 'b', priority: 1, at: 20 }); expect(s.update(20)).toBeNull();
    s.offer({ text: 'c', priority: 1, at: 25.5 }); expect(s.update(25.5)?.text).toBe('c');
    expect(VIEW_PROFILES.wallpaper.captions).toBeNull();
  });
  it('captions name the species as a slot and skip uncaptioned kinds', () => {
    const ev = { k: 'extinction', species: 2, lastId: 1, pos: [1, 1], t: 0, eid: 1, epoch: 0 } as SimEvent;
    const c = captionFor(ev, () => 'Pratilux tondens', 18)!;
    expect(c.species).toBe('Pratilux tondens');
    expect(c.text).toContain('has died out');
    expect(captionFor({ k: 'birth', id: 1, parents: [], species: 0, pos: [0, 0], size: 1, mode: 'bud', t: 0, eid: 2, epoch: 0 } as SimEvent, () => '', 18)).toBeNull();
  });
});

describe('designer model (UX-T01 to T04)', () => {
  const base = encodeGenome(templateGenome('meadowlamp'));
  it('UX-T01 slider round trip: set then get returns the clamped value, other loci unchanged', () => {
    const r = mulberry32(1);
    for (let n = 0; n < 1500; n++) {
      const table = r() < 0.6 ? 'T' : 'B';
      const specs = (table === 'T' ? TRAITS : BRAIN_TRAITS).filter((s) => s && !s.immutable);
      const spec = specs[Math.floor(r() * specs.length)]!;
      const v = spec.min - 0.2 * (spec.max - spec.min) + r() * 1.4 * (spec.max - spec.min);
      const g2 = setTrait(base, table, spec.idx, v);
      const clamped = Math.min(spec.max, Math.max(spec.min, v));
      const got = getTrait(g2, table, spec.idx);
      const tol = spec.scale === 'log' ? clamped * 2e-4 : (spec.max - spec.min) * 2e-5 + (spec.scale === 'int' ? 0.5 : 0);
      expect(Math.abs(got - clamped)).toBeLessThanOrEqual(tol + 1e-12);
      const a = decodeGenome(base), b = decodeGenome(g2);
      for (let i = 0; i < a.traits.length; i++) if (!(table === 'T' && i === spec.idx)) expect(b.traits[i]).toBe(a.traits[i]);
      for (let i = 0; i < a.brainTraits.length; i++) if (!(table === 'B' && i === spec.idx)) expect(b.brainTraits[i]).toBe(a.brainTraits[i]);
    }
  });
  it('UX-T02 one source: a part edit and a gene edit land in the same bytes that both editors read', () => {
    let g = setTrait(base, 'T', 0, 0.03);
    const head = view(g).rootModuleInnov;
    const r = addPart(g, head, KIND.EYE);
    g = setModuleField(r.bytes, r.innov, 'glow', 200);
    expect(getTrait(g, 'T', 0)).toBeCloseTo(0.03, 4);
    expect(getModule(g, r.innov)!.glow).toBe(200);
    expect(sketch(view(g), 1, L_CEIL).parts.some((p) => p.rule === r.innov)).toBe(true);
  });
  it('UX-T03 undo all edits restores the original bytes; redo restores the final bytes', () => {
    const rnd = mulberry32(9);
    const hist = new History();
    let g = base;
    for (let i = 0; i < 120; i++) {
      let next: Uint8Array;
      const op = rnd();
      if (op < 0.5) next = setTrait(g, 'T', [0, 2, 6, 20, 33][Math.floor(rnd() * 5)]!, rnd());
      else if (op < 0.8) next = addPart(g, view(g).rootModuleInnov, Math.floor(rnd() * 12)).bytes;
      else next = setModuleField(g, view(g).modules[0]!.innov, 'width', Math.floor(rnd() * 65535));
      hist.push({ before: g, after: next, label: 'e', ...(rnd() < 0.3 ? { coalesce: 'drag' } : {}) });
      g = next;
    }
    const final = g;
    let x: Uint8Array | null; let cur = final;
    while ((x = hist.undo())) cur = x;
    expect(sameBytes(cur, base)).toBe(true);
    while ((x = hist.redo())) cur = x;
    expect(sameBytes(cur, final)).toBe(true);
  });
  it('UX-T04 editing a repeated rule changes every copy; break out changes one copy only', () => {
    const g0 = view(base);
    const trunk = g0.modules.find((m) => m.kind === KIND.SEGMENT && m.innov !== g0.rootModuleInnov)!;
    const link = g0.links.find((l) => l.toInnov === trunk.innov)!;
    const before = sketch(g0, 1, L_CEIL).parts.filter((p) => p.rule === trunk.innov);
    expect(before.length).toBe(link.repeat);
    const wider = setModuleField(base, trunk.innov, 'width', Math.min(65535, trunk.width + 8000));
    const after = sketch(view(wider), 1, L_CEIL).parts.filter((p) => p.rule === trunk.innov);
    after.forEach((p, i) => expect(p.r0 / (p.x0 - p.x1 || 1)).not.toBeCloseTo(before[i]!.r0 / (before[i]!.x0 - before[i]!.x1 || 1), 6));
    const bo = breakOut(base, link.innov);
    const gb = view(bo.bytes);
    expect(gb.modules.filter((m) => m.kind === KIND.SEGMENT).length).toBe(g0.modules.filter((m) => m.kind === KIND.SEGMENT).length + 1);
    expect(gb.links.find((l) => l.innov === link.innov)!.repeat).toBe(link.repeat - 1);
    const edited = setModuleField(bo.bytes, bo.innov, 'width', 60000);
    const g1 = view(edited);
    const orig = g1.modules.find((m) => m.innov === trunk.innov)!;
    expect(orig.width).toBe(trunk.width); // the other copies keep their genes byte for byte
  });
  it('delete and duplicate rules never touch the root', () => {
    const root = view(base).rootModuleInnov;
    expect(sameBytes(deleteRule(base, root), base) || view(deleteRule(base, root)).modules.some((m) => m.innov === root)).toBe(true);
    const d = duplicateRule(base, view(base).modules[1]!.innov);
    expect(view(d.bytes).modules.length).toBe(view(base).modules.length + 1);
  });
});

describe('energy budget and validation (UX-T06, T07)', () => {
  const g = templateGenome('meadowlamp');
  it('basal power scales with an exponent of 0.75', () => {
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < 20; i++) { const m = 1e-6 * 10 ** (i * 0.3); xs.push(Math.log(m)); ys.push(Math.log(basalW(m, g, 14))); }
    const mx = xs.reduce((a, b) => a + b) / 20, my = ys.reduce((a, b) => a + b) / 20;
    const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    expect(Math.abs(slope - 0.75)).toBeLessThan(0.01);
  });
  it('more muscle never lowers the muscle cost; break-even rises with cost', () => {
    let prev = -1, prevBE = -1;
    for (const q of [20, 60, 100, 160, 220]) {
      const bytes = setModuleField(encodeGenome(g), 2, 'muscleFraction', q);
      const gg = decodeGenome(bytes);
      const b = computeBudget(gg, sketch(gg, 1, L_CEIL));
      expect(b.muscleW).toBeGreaterThanOrEqual(prev);
      if (Number.isFinite(b.breakEven)) expect(b.breakEven).toBeGreaterThanOrEqual(prevBE - 1e-12);
      prev = b.muscleW; prevBE = Number.isFinite(b.breakEven) ? b.breakEven : prevBE;
    }
  });
  it('fixtures trigger their issues; nothing ever blocks release', () => {
    const issues = (gg: ReturnType<typeof templateGenome>, count = 20) => validate(gg, sketch(gg, 1, L_CEIL), computeBudget(gg, sketch(gg, 1, L_CEIL)), { count, asLeviathan: false }).map((i) => i.id);
    const sex = decodeGenome(setTrait(encodeGenome(g), 'T', 8, 1));
    expect(issues(sex, 1)).toContain('V05');
    expect(issues(decodeGenome(setTrait(encodeGenome(g), 'T', 16, -1)))).toContain('V11');
    expect(issues(decodeGenome(setTrait(encodeGenome(g), 'T', 0, 0.5)))).toContain('V13');
    const noMouth = decodeGenome(deleteRule(encodeGenome(g), 3));
    expect(issues(noMouth)).toContain('V14');
    const cold = decodeGenome(setTrait(setTrait(encodeGenome(g), 'T', 22, 30), 'T', 23, 1));
    expect(issues(cold)).toContain('V09');
    expect(issues(g)).toEqual([]);
  });
});

describe('templates, library and sharing (UX-T10 to T12)', () => {
  it('all seven named templates plus Blank encode, decode and grow under 64 parts', () => {
    expect(TEMPLATES.filter((x) => x.id !== 'blank').map((x) => x.name)).toEqual(['Meadowlamp', 'Hushmaw', 'Sievebell', 'Tetherling', 'Ashpicker', 'Deepcrown', 'Motefly']);
    for (const tm of TEMPLATES) {
      const g = templateGenome(tm.id);
      const bytes = encodeGenome(g);
      expect(sameBytes(encodeGenome(decodeGenome(bytes)), bytes)).toBe(true);
      const body = sketch(g, 1, L_CEIL);
      expect(body.parts.length).toBeGreaterThan(0);
      expect(body.parts.length).toBeLessThanOrEqual(64);
      const s = designString(makeMeta(tm.genus, tm.epithet, 'template'), bytes);
      expect(s.startsWith('PTK1.')).toBe(true);
      expect(s.length).toBeLessThanOrEqual(3000);
    }
  });
  it('PTK1 and .ptkg round trip; sanitised names; packs', () => {
    const g = encodeGenome(templateGenome('hushmaw'));
    const meta = makeMeta('Taci‮tostoma', 'insidians\u0007', 'designer', { notes: 'x'.repeat(5000) });
    expect(meta.name.genus).toBe('Tacitostoma');
    expect(meta.notes!.length).toBe(1024);
    const r = importDesign(designString(meta, g));
    expect(sameBytes(r.designs[0]!.genome, g)).toBe(true);
    expect(r.designs[0]!.meta.name.epithet).toBe('insidians');
    expect(sameBytes(importDesign(packDesign(meta, g)).designs[0]!.genome, g)).toBe(true);
  });
  it('UX-T12 hostile input: mutated and truncated buffers never crash or import out-of-schema data', () => {
    const good = packDesign(makeMeta('Pratilux', 'tondens', 'designer'), encodeGenome(templateGenome('meadowlamp')));
    const r = mulberry32(77);
    let accepted = 0;
    for (let n = 0; n < 3000; n++) {
      const b = good.slice(0, r() < 0.3 ? Math.floor(r() * good.length) : good.length);
      for (let k = 0; k < 1 + Math.floor(r() * 4); k++) if (b.length) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
      try { const d = importDesign(b); accepted++; for (const x of d.designs) decodeGenome(x.genome); } catch (e) { expect(e).toBeInstanceOf(Error); }
    }
    expect(accepted).toBeLessThan(3000);
    expect(() => importDesign('PTK1.!!!!')).toThrow();
    expect(() => importDesign('hello')).toThrow();
  });
});

describe('QR encoder', () => {
  it('capacities match the standard (v1-L 17, v40-L 2953, v40-M 2331 bytes)', () => {
    expect(byteCapacity(1, 'L')).toBe(17);
    expect(byteCapacity(40, 'L')).toBe(2953);
    expect(byteCapacity(40, 'M')).toBe(2331);
  });
  it('Reed-Solomon codewords leave a zero remainder; format bits are valid BCH codewords', () => {
    const data = Array.from({ length: 80 }, (_, i) => (i * 37 + 11) & 0xff);
    const div = rsDivisor(20);
    const ecc = rsRemainder(data, div);
    expect(rsRemainder([...data, ...ecc], div).every((x) => x === 0)).toBe(true);
    for (let m = 0; m < 8; m++) {
      let v = formatBits(m, 'L') ^ 0x5412;
      for (let i = 14; i >= 10; i--) if ((v >>> i) & 1) v ^= 0x537 << (i - 10);
      expect(v).toBe(0);
    }
  });
  it('encodes a template string with finder patterns in three corners', () => {
    const s = designString(makeMeta('Pratilux', 'tondens', 'designer'), encodeGenome(templateGenome('meadowlamp')));
    const q = encodeQr(new TextEncoder().encode(s), 'L');
    expect(q.size).toBe(q.version * 4 + 17);
    for (const [x, y] of [[0, 0], [q.size - 7, 0], [0, q.size - 7]] as const) {
      expect(q.modules[y]![x]).toBe(true); expect(q.modules[y + 1]![x + 1]).toBe(false); expect(q.modules[y + 3]![x + 3]).toBe(true);
    }
  });
});

describe('diversity (UX-T28)', () => {
  it('matches reference values', () => {
    const d = diversity([10, 10, 10, 10]);
    expect(d.richness).toBe(4); expect(d.shannon).toBeCloseTo(Math.log(4), 12); expect(d.effective).toBeCloseTo(4, 10); expect(d.simpson).toBeCloseTo(0.75, 12);
    const e = diversity([90, 10, 0]);
    expect(e.richness).toBe(2); expect(e.shannon).toBeCloseTo(-(0.9 * Math.log(0.9) + 0.1 * Math.log(0.1)), 12); expect(e.simpson).toBeCloseTo(0.18, 12);
    expect(diversity([]).richness).toBe(0);
  });
});

// ---------------- god window against the mock host ----------------
function rig(clock = { t: 0 }) {
  const link = new MockSimLink({ autoStart: false, warmupTicks: 300, now: () => clock.t });
  const client = new GodClient(link, () => clock.t);
  const pump = (ms: number, steps = 1) => { for (let i = 0; i < steps; i++) { clock.t += ms; link.pump(ms); } };
  return { link, client, pump, clock };
}
async function cmd(c: GodClient, body: Parameters<GodClient['send']>[0]): Promise<CommandResult> { return c.send(body); }

describe('mock host and GodClient (UX-T21 to T24)', () => {
  it('welcome, stats and dust arrive; picking finds a creature', () => {
    const { client, pump } = rig();
    pump(34, 40);
    expect(client.welcome?.tank.w).toBe(32);
    expect(client.species.length).toBe(7);
    expect(client.history.length).toBeGreaterThan(0);
    const d = client.dust!;
    let s = 0; while (d.colour[s] === 255) s++;
    const x = (d.x[s]! / 65535) * 32, y = (d.y[s]! / 65535) * 18;
    expect(client.pick(x, y, 0.2)?.id).toBe(client.slots.get(s)!.id);
  });
  it('a major power snapshots before its effect and fires after the 3 s lead; minor after 1 s', async () => {
    const { client, link } = rig();
    const t0 = link.tick;
    const r = await cmd(client, { t: 'cast', power: 'meteor', target: { kind: 'circle', pos: [16, 9], radius: 3 }, intensity: 0.6, seed: 1 });
    expect(r.ok).toBe(true);
    expect(r.snapshotId).toBeDefined();
    expect(r.fireTick).toBe(t0 + 90);
    expect(link.snapshots.find((s) => s.info.id === r.snapshotId)!.info.kind).toBe('beforePower');
    const m = await cmd(client, { t: 'cast', power: 'bloom', target: { kind: 'circle', pos: [5, 3], radius: 3 }, intensity: 0.2, seed: 2 });
    expect(m.fireTick).toBe(t0 + 30);
    expect(m.snapshotId).toBeUndefined();
    for (let i = 0; i < 100; i++) link.step();
    expect(link.drainEvents().filter((e) => e.k === 'god').length).toBe(2);
  });
  it('rewind increments the epoch, keeps the present as beforeRewind, and stale commands are rejected', async () => {
    const { client, link, pump } = rig();
    pump(34, 5);
    const snap = link.snapshots[0]!.info.id;
    const oldEpoch = client.epoch;
    const r = await cmd(client, { t: 'rewind', snapshotId: snap });
    expect(r.ok).toBe(true);
    expect(client.epoch).toBe(oldEpoch + 1);
    expect(link.snapshots.some((s) => s.info.kind === 'beforeRewind')).toBe(true);
    // a command stamped with the old epoch (another window mid-cast)
    let res: CommandResult | null = null;
    link.onFrame((f) => { if (readHeader(f).type === FRAME.COMMAND_RESULT) res = decodeCborFrame(f).payload as unknown as CommandResult; });
    link.send(encodeCborFrame(FRAME.COMMAND, 0, { t: 'cast', id: 'x', epoch: oldEpoch, power: 'bloom', target: { kind: 'global' }, intensity: 0.1, seed: 1 } as unknown as CborValue));
    expect(res!.ok).toBe(false);
    expect(res!.reason).toBe('stale-epoch');
  });
  it('a speed lease lapses 30 s after its last renewal; the unattended lease does not', async () => {
    const { client, link, pump, clock } = rig();
    await client.setSpeed(16);
    expect(link.speedReq).toBe(16);
    pump(1000, 29); expect(link.speedReq).toBe(16);
    client.renewLease(); pump(1000, 29); expect(link.speedReq).toBe(16);
    pump(1000, 3); expect(link.speedReq).toBe(1);
    await client.setSpeed('max', { until: { wallIso: new Date(Date.now() + 3_600_000).toISOString() }, unattended: true });
    clock.t += 120_000; link.pump(10);
    expect(link.speedReq).toBe('max');
    await client.setSpeed(1);
  });
  it('a release reaches the world as a new species, with the leviathan flag when asked', async () => {
    const { client, link } = rig();
    const g = encodeGenome(templateGenome('deepcrown'));
    const n0 = link.species.length;
    const r = await cmd(client, { t: 'release', ptkg: packDesign(makeMeta('Bathycorona', 'regina', 'designer'), g), pos: [16, 12], count: 3, asLeviathan: true, founderProtection: true });
    expect(r.ok).toBe(true);
    expect(r.snapshotId).toBeDefined();
    const sp = link.species[n0]!;
    expect(sp.name).toBe('Bathycorona regina');
    expect(decodeGenome(sp.genome).flags & GENOME_FLAG_LEVIATHAN).toBeTruthy();
    expect(link.drainEvents().some((e) => e.k === 'release' && e.leviathan)).toBe(true);
  });
});

describe('casting state machine (UX-T22)', () => {
  function ctl(result: Partial<CommandResult> = {}) {
    const sent: string[] = [];
    let paused = false;
    const c = new CastController({
      cast: async (p) => { sent.push(`cast:${p}`); return { id: 'c1', ok: true, fireTick: 10, ...result }; },
      snapshot: async (l) => { sent.push(`snap:${l}`); return { id: 's', ok: true, snapshotId: 'snap1' }; },
      paused: () => paused,
    });
    return { c, sent, setPaused: (p: boolean) => { paused = p; } };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  it('minor powers cast on click; major powers need a 1.2 s hold, and releasing early cancels', async () => {
    const { c, sent } = ctl();
    c.pick('bloom'); c.target({ kind: 'circle', pos: [1, 1], radius: 2 }); c.intensity = 0.3;
    c.confirmDown(0); await flush();
    expect(sent).toEqual(['cast:bloom']);
    const m = ctl({ snapshotId: 'x' });
    m.c.pick('meteor'); m.c.target({ kind: 'circle', pos: [1, 1], radius: 2 });
    m.c.confirmDown(0); m.c.confirmUp(HOLD_MS - 100); await flush();
    expect(m.sent).toEqual([]);
    expect(m.c.state.s).toBe('previewing');
    m.c.confirmDown(1000); m.c.update(1000 + HOLD_MS); await flush();
    expect(m.sent).toEqual(['cast:meteor']);
  });
  it('Esc cancels in every state before sending; the dialog button confirms without holding', async () => {
    for (const step of ['armed', 'previewing', 'holding'] as const) {
      const { c, sent } = ctl();
      c.pick('plague');
      if (step !== 'armed') c.target({ kind: 'species', species: [1] });
      if (step === 'holding') c.confirmDown(0);
      expect(c.state.s).toBe(step);
      c.cancel(); c.update(5000); await flush();
      expect(c.state.s).toBe('idle'); expect(sent).toEqual([]);
    }
    const { c, sent } = ctl({ snapshotId: 'x' });
    c.pick('cull'); c.target({ kind: 'species', species: [2] }); c.dialogConfirm(); await flush();
    expect(sent).toEqual(['cast:cull']);
  });
  it('a major cast without a host snapshot takes one itself; the countdown waits while paused', async () => {
    const { c, sent, setPaused } = ctl();
    c.pick('meteor'); c.target({ kind: 'circle', pos: [1, 1], radius: 2 }); c.dialogConfirm(); await flush(); await flush();
    expect(sent).toEqual(['cast:meteor', 'snap:Before meteor']);
    expect(c.state.s).toBe('countdown');
    const st = c.state as { startedAt: number };
    setPaused(true); c.update(st.startedAt + 500); c.update(st.startedAt + 5000);
    expect(c.countdownLeft(st.startedAt + 5000)).toBeCloseTo(2.5, 3);
    setPaused(false); c.update(st.startedAt + 6000);
    expect(c.countdownLeft(st.startedAt + 6000)).toBeCloseTo(2.5, 3);
    c.update(st.startedAt + 7000);
    expect(c.countdownLeft(st.startedAt + 7000)).toBeCloseTo(1.5, 3);
    c.update(st.startedAt + 9000);
    expect(c.state.s).toBe('idle');
  });
  it('core powers have specs and targets test containment', () => {
    for (const p of ['bloom', 'vent', 'coldSnap', 'heatwave', 'plague', 'meteor', 'currentShift', 'longNight', 'mutagen', 'cull', 'bless', 'nutrientFlood']) expect(POWER_SPECS[p]).toBeDefined();
    expect(inTarget({ kind: 'circle', pos: [0, 0], radius: 2 }, 1, 1, 0)).toBe(true);
    expect(inTarget({ kind: 'depthBand', y0: 2, y1: 4 }, 0, 5, 0)).toBe(false);
    expect(inTarget({ kind: 'species', species: [3] }, 0, 0, 3)).toBe(true);
  });
});

describe('host-first wallpaper link (DESIGN R31)', async () => {
  const { vi } = await import('vitest');
  const { HostFirstLink } = await import('../src/ui/link.js');
  class Fake {
    cb: ((f: Uint8Array) => void) | null = null; sent: Uint8Array[] = []; closed = false;
    constructor(readonly kind: 'worker' | 'socket') {}
    onFrame(cb: (f: Uint8Array) => void) { this.cb = cb; }
    send(f: Uint8Array) { this.sent.push(f); }
    close() { this.closed = true; }
  }
  it('falls back to the worker after 2 s of silence, replays HELLO, and returns when the host answers', () => {
    vi.useFakeTimers();
    try {
      const sockets: Fake[] = [], workers: Fake[] = [];
      const link = new HostFirstLink('ws://x', { socket: () => { const s = new Fake('socket'); sockets.push(s); return s; }, worker: () => { const w = new Fake('worker'); workers.push(w); return w; } });
      const got: number[] = [];
      link.onFrame((f) => got.push(f[0]!));
      link.send(encodeCborFrame(FRAME.HELLO, 0, { view: 'wallpaper' }));
      expect(link.kind).toBe('socket');
      vi.advanceTimersByTime(2100);
      expect(link.kind).toBe('worker');
      expect(sockets[0]!.closed).toBe(true);
      expect(readHeader(workers[0]!.sent[0]!).type).toBe(FRAME.HELLO);
      workers[0]!.cb!(new Uint8Array([FRAME.DUST_FRAME, 0, 1, 0, 0, 0, 0, 0]));
      vi.advanceTimersByTime(600); // first probe at 0.5 s
      expect(sockets.length).toBe(2);
      expect(readHeader(sockets[1]!.sent[0]!).type).toBe(FRAME.HELLO);
      sockets[1]!.cb!(new Uint8Array([FRAME.WELCOME, 0, 1, 0, 0, 0, 0, 0]));
      expect(link.kind).toBe('socket');
      expect(workers[0]!.closed).toBe(true);
      expect(got).toEqual([FRAME.DUST_FRAME, FRAME.WELCOME]);
      vi.advanceTimersByTime(6000); // the host goes silent
      expect(link.kind).toBe('worker');
      link.close();
    } finally { vi.useRealTimers(); }
  });
});
