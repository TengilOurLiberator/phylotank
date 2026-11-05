/** src/genome unit and property tests (01 §1.14, review R2, R14, R15, R22, CONTRACT 3.3, 6, 7). */
import { describe, expect, it } from 'vitest';
import {
  BT, GENOME_FLAG_LEVIATHAN, KIND, MAX_PARTS, ORGAN, PRESETS, REG_AXIS, REG_PARAM_GATE, RNG_STREAM, RngStreams, SYMMETRY,
  T, decodeGenome, emptyGenome, encodeGenome, fourcc, hash32, xxh64,
  type Genome, type MutationContext, type Phenotype,
} from '../src/core/index.js';
import {
  InnovationRegistry, MAX_RAW_PARTS, OP_WEIGHTS, Restager, TEMPLATE_IDS, TEMPLATE_NAMES, binomialFor, blankGenome,
  bodyPlanDescriptor, brainTrait, clampToCeiling, cloneGenome, commonNameFor, countGenes, createGenomeModule, crossoverWith,
  descriptorDistance, develop, distance, duplicateModule, expressedAdultLength, expressedSets, genome, isPronounceable,
  lifeHistory, makeLink, makeModule, makeReg, mutateWith, pickOperator, poisson, repair, setTrait, templateGenome, trait,
  type OpName,
} from '../src/genome/index.js';
import { GenomeStore } from '../src/genome/store.js';

const ENV = { depth01: 0.5, tempC: 14 };
const OPTS = { maxParts: MAX_PARTS, lCeilingM: PRESETS.default.lCeilingM };
const rng = new RngStreams(0x1234, 0x9876);
const ctx = (childId: number, extra: Partial<MutationContext> = {}): MutationContext =>
  ({ rng, tick: 7, childId, lCeilingM: PRESETS.default.lCeilingM, mutagen: 1, ...extra });

/** Bytes of every per-part array and the per-body scalars, for bit-exact comparisons. */
function phenoBytes(ph: Phenotype): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const k of Object.keys(ph).sort()) {
    const v = (ph as unknown as Record<string, unknown>)[k];
    if (ArrayBuffer.isView(v)) parts.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }
  const scal = new Float64Array([ph.nParts, ph.lengthM, ph.adultLengthM, ph.maturity, ph.massKg, ph.gutVolume, ph.gGut,
    ph.handlingSize, ph.buildCostKg, ...Object.values(ph.mouth)]);
  parts.push(new Uint8Array(scal.buffer));
  parts.push(new TextEncoder().encode(JSON.stringify(ph.organList)));
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const phHash = (ph: Phenotype): bigint => xxh64(phenoBytes(ph));

function checkPhenotype(ph: Phenotype): void {
  expect(ph.nParts).toBeGreaterThanOrEqual(1);
  expect(ph.nParts).toBeLessThanOrEqual(MAX_PARTS);
  expect(ph.parent[0]).toBe(-1);
  for (let i = 1; i < ph.nParts; i++) { expect(ph.parent[i]).toBeGreaterThanOrEqual(0); expect(ph.parent[i]).toBeLessThan(i); }
  for (const k of ['length', 'radius', 'span', 'youngsE', 'u', 'v', 'd', 'restAngle', 'limitLo', 'limitHi', 'params'] as const) {
    for (const x of ph[k]) expect(Number.isFinite(x)).toBe(true);
  }
  for (const x of ph.length) expect(x).toBeGreaterThan(0);
  for (const x of ph.radius) expect(x).toBeGreaterThan(0);
  expect(ph.massKg).toBeGreaterThan(0);
  expect(Number.isFinite(ph.buildCostKg)).toBe(true);
  for (const o of ph.organList) { expect(o.part).toBeGreaterThanOrEqual(0); expect(o.part).toBeLessThan(ph.nParts); }
}

function validGenome(g: Genome): void {
  const sorted = (a: { innov: number | bigint }[]): boolean => a.every((x, i) => i === 0 || a[i - 1]!.innov < x.innov);
  expect(sorted(g.modules)).toBe(true);
  expect(sorted(g.links)).toBe(true);
  expect(sorted(g.regs)).toBe(true);
  expect(g.modules.some((m) => m.innov === g.rootModuleInnov)).toBe(true);
  const mods = new Set(g.modules.map((m) => m.innov));
  for (const l of g.links) { expect(mods.has(l.fromInnov)).toBe(true); expect(mods.has(l.toInnov)).toBe(true); }
  for (const r of g.regs) if (r.targetInnov) expect(mods.has(r.targetInnov)).toBe(true);
  expect(g.modules.length).toBeLessThanOrEqual(48);
  expect(g.links.length).toBeLessThanOrEqual(64);
  expect(g.regs.length).toBeLessThanOrEqual(32);
  const bytes = encodeGenome(g);
  expect(bytes.length).toBeLessThanOrEqual(16384);
  expect(encodeGenome(decodeGenome(bytes))).toEqual(bytes);
}

describe('templates', () => {
  it('ships the seven named templates plus Blank, all developing under 64 parts', () => {
    expect(TEMPLATE_IDS).toHaveLength(8);
    for (const id of TEMPLATE_IDS) {
      const g = genome.template(id);
      validGenome(g);
      for (const m of [0, 0.5, 1]) checkPhenotype(develop(g, m, ENV, OPTS));
    }
  });
  it('keeps William\'s names and the 07 binomials', () => {
    expect(TEMPLATE_NAMES.meadowlamp).toMatchObject({ common: 'Meadowlamp', genus: 'Pratilux', epithet: 'tondens' });
    expect(TEMPLATE_NAMES.hushmaw).toMatchObject({ genus: 'Tacitostoma', epithet: 'insidians' });
    expect(TEMPLATE_NAMES.sievebell).toMatchObject({ genus: 'Cribrocampana', epithet: 'lenta' });
    expect(TEMPLATE_NAMES.tetherling).toMatchObject({ genus: 'Haerentula', epithet: 'furtiva' });
    expect(TEMPLATE_NAMES.ashpicker).toMatchObject({ genus: 'Cineralegus', epithet: 'sedulus' });
    expect(TEMPLATE_NAMES.deepcrown).toMatchObject({ genus: 'Bathycorona', epithet: 'patiens' });
    expect(TEMPLATE_NAMES.motefly.common).toBe('Motefly');
  });
  it('matches the 07 table on the key genes', () => {
    const near = (a: number, b: number, rel = 0.02): void => expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(1e-9, Math.abs(b)) + 1e-4);
    near(trait(templateGenome('meadowlamp'), T.ADULT_LENGTH!), 0.01);
    near(trait(templateGenome('hushmaw'), T.ADULT_LENGTH!), 0.05);
    near(trait(templateGenome('sievebell'), T.ADULT_LENGTH!), 0.03);
    near(trait(templateGenome('tetherling'), T.ADULT_LENGTH!), 0.002);
    near(trait(templateGenome('ashpicker'), T.ADULT_LENGTH!), 0.02);
    near(trait(templateGenome('deepcrown'), T.ADULT_LENGTH!), 0.25);
    expect(trait(templateGenome('motefly'), T.ADULT_LENGTH!)).toBeLessThan(0.0015);
    expect(Math.round(trait(templateGenome('tetherling'), T.CLUTCH_SIZE!))).toBe(32);
    near(brainTrait(templateGenome('hushmaw'), BT.AGGRESSION!), 0.7);
  });
  it('gives each template its body plan', () => {
    const ph = (id: Parameters<typeof templateGenome>[0]): Phenotype => develop(templateGenome(id), 1, ENV, OPTS);
    const count = (p: Phenotype, k: number): number => Array.from(p.kind).filter((x) => x === k).length;
    expect(count(ph('meadowlamp'), KIND.SEGMENT)).toBe(5);
    expect(ph('meadowlamp').mouth.scrape).toBe(1);
    expect(count(ph('hushmaw'), KIND.SEGMENT)).toBe(3);
    expect(ph('hushmaw').mouth.bite).toBe(1);
    expect(ph('hushmaw').organList.some((o) => o.kind === 'photophore')).toBe(true);
    expect(count(ph('sievebell'), KIND.MOUTH)).toBe(6);
    expect(ph('sievebell').mouth.filter).toBe(1);
    expect(ph('sievebell').organList.some((o) => o.kind === 'eye')).toBe(false);
    expect(ph('tetherling').mouth.latch).toBeGreaterThan(0.5);
    expect(count(ph('ashpicker'), KIND.SEGMENT)).toBe(7);
    expect(ph('ashpicker').mouth.suction).toBe(1);
    expect(count(ph('deepcrown'), KIND.SEGMENT)).toBe(9);
    expect(ph('deepcrown').mouth.bite + ph('deepcrown').mouth.filter).toBe(2);
    const mf = ph('motefly');
    expect(Array.from(mf.subtype).filter((s, i) => mf.kind[i] === KIND.LIMB && s === 2).length).toBe(6);
  });
  it('Deepcrown is the leviathan seed: flagged, and its 25 cm adult is not clamped by any preset', () => {
    const g = templateGenome('deepcrown');
    expect(g.flags & GENOME_FLAG_LEVIATHAN).not.toBe(0);
    const ph = develop(g, 1, ENV, { maxParts: 64, lCeilingM: PRESETS.small.lCeilingM });
    expect(ph.adultLengthM).toBeCloseTo(0.25, 2);
    for (const id of TEMPLATE_IDS) if (id !== 'deepcrown') expect(templateGenome(id).flags & GENOME_FLAG_LEVIATHAN).toBe(0);
  });
  it('template ids stay in the reserved range and differ between templates', () => {
    for (const id of TEMPLATE_IDS) for (const m of templateGenome(id).modules) expect(m.innov).toBeLessThan(4096);
    const a = new Set(templateGenome('meadowlamp').modules.map((m) => m.innov));
    expect(templateGenome('hushmaw').modules.some((m) => a.has(m.innov))).toBe(false);
  });
});

describe('develop', () => {
  it('is deterministic: same genome, same bytes (U2)', () => {
    for (const id of TEMPLATE_IDS) {
      const g = templateGenome(id);
      expect(phHash(develop(g, 0.37, ENV, OPTS))).toBe(phHash(develop(cloneGenome(g), 0.37, ENV, OPTS)));
    }
  });
  it('restage equals a full develop at every maturity', () => {
    const r = new Restager();
    for (const id of TEMPLATE_IDS) {
      const g = templateGenome(id);
      for (let m = 0; m <= 1; m += 0.125) expect(phHash(r.phenotype(g, m, ENV, OPTS))).toBe(phHash(develop(g, m, ENV, OPTS)));
    }
  });
  it('clamps expressed adult length to the ceiling for non-leviathans (R2)', () => {
    const g = blankGenome();
    setTrait(g, T.ADULT_LENGTH!, 0.8);
    expect(develop(g, 1, ENV, OPTS).adultLengthM).toBeCloseTo(0.2, 6);
    g.flags |= GENOME_FLAG_LEVIATHAN;
    expect(develop(g, 1, ENV, OPTS).adultLengthM).toBeCloseTo(0.8, 2);
  });
  it('the root chain spans exactly the current length', () => {
    for (const id of ['meadowlamp', 'ashpicker', 'deepcrown'] as const) {
      const g = templateGenome(id);
      const ph = develop(g, 0.6, ENV, OPTS);
      let chain = 0;
      for (let i = 0; i < ph.nParts; i++) if (ph.kind[i] === KIND.SEGMENT && ph.dv[i] === 0 && (i === 0 || ph.u[i]! > 0)) chain += ph.length[i]!;
      expect(chain / ph.lengthM).toBeGreaterThan(0.99);
    }
  });

  function twoPart(link: Parameters<typeof makeLink>[3], child: Parameters<typeof makeModule>[3] = {}, kind: number = KIND.FIN): Genome {
    const g = emptyGenome();
    g.modules = [makeModule(1, KIND.SEGMENT, 1, { root: true, len: 1, aspect: 0.4 }), makeModule(2, kind, 0, { len: 0.5, aspect: 0.1, ...child })];
    g.rootModuleInnov = 1;
    g.links = [makeLink(10, 1, 2, link)];
    return repair(g);
  }

  it('mirror links give exact reflections; radial gives 2 pi k / n (U4)', () => {
    const ph = develop(twoPart({ pos: 0.5, angleDeg: 50, symmetry: SYMMETRY.MIRROR }), 1, ENV, OPTS);
    expect(ph.nParts).toBe(3);
    expect(ph.dv[1]).toBe(1); expect(ph.dv[2]).toBe(-1);
    expect(ph.restAngle[1]).toBeCloseTo(-ph.restAngle[2]!, 6);
    expect(ph.v[1]).toBeCloseTo(-ph.v[2]!, 6);
    expect(ph.u[1]).toBeCloseTo(ph.u[2]!, 6);
    const rad = develop(twoPart({ pos: 0.5, angleDeg: 0, repeat: 5, symmetry: SYMMETRY.RADIAL }), 1, ENV, OPTS);
    expect(rad.nParts).toBe(6);
    for (let k = 0; k < 5; k++) {
      let a = rad.restAngle[1 + k]!;
      if (a > Math.PI) a -= 2 * Math.PI;
      const want = (2 * Math.PI * k) / 5;
      expect(Math.abs(((a - want + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)).toBeLessThan(1e-5);
    }
  });
  it('repeat n gives n copies; recursion stops at the limit; terminalOnly at the leaves only (U5)', () => {
    for (const n of [1, 4, 9]) expect(develop(twoPart({ pos: 1, repeat: n }, {}, KIND.SEGMENT), 1, ENV, OPTS).nParts).toBe(1 + n);
    const g = twoPart({ pos: 1 }, { recursion: 3 }, KIND.LIMB);
    g.links.push(makeLink(11, 2, 2, { pos: 1 }));
    g.modules.push(makeModule(3, KIND.PHOTOPHORE, 0, { len: 0.5, aspect: 0.5 }));
    g.links.push(makeLink(12, 2, 3, { pos: 1, terminalOnly: true }));
    const ph = develop(repair(g), 1, ENV, OPTS);
    const limbs = Array.from(ph.kind).filter((k) => k === KIND.LIMB).length;
    expect(limbs).toBe(4); // one plus three recursions
    const lamps = ph.organList.filter((o) => o.kind === 'photophore');
    expect(lamps).toHaveLength(1);
    const lampPart = Array.from(ph.kind).indexOf(KIND.PHOTOPHORE);
    const host = lampPart >= 0 ? ph.parent[lampPart]! : lamps[0]!.part;
    expect(ph.kind[host]).toBe(KIND.LIMB);
    for (let i = 0; i < ph.nParts; i++) if (ph.parent[i] === host) expect(ph.kind[i]).not.toBe(KIND.LIMB);
  });
  it('an AP band gate expresses only inside its window; a maturity gate switches at its threshold (U6)', () => {
    const g = emptyGenome();
    g.modules = [makeModule(1, KIND.SEGMENT, 1, { root: true, len: 1 }), makeModule(2, KIND.SEGMENT, 0, { len: 1 }),
      makeModule(3, KIND.SPIKE, 0, { len: 0.5, aspect: 0.2 })];
    g.rootModuleInnov = 1;
    g.links = [makeLink(10, 1, 2, { pos: 1, repeat: 9 }), makeLink(11, 2, 3, { pos: 0.5, angleDeg: 90 })];
    g.regs = [makeReg(20, 3, REG_AXIS.AP, REG_PARAM_GATE, 3, 0.25, 0.2, 0.5)];
    const ph = develop(repair(g), 1, ENV, OPTS);
    const spikes = Array.from(ph.kind).map((k, i) => (k === KIND.SPIKE ? i : -1)).filter((i) => i >= 0);
    expect(spikes.length).toBeGreaterThan(0);
    for (const i of spikes) { expect(ph.u[i]).toBeGreaterThan(0.1); expect(ph.u[i]).toBeLessThan(0.4); }
    const meta = emptyGenome();
    meta.modules = [makeModule(1, KIND.SEGMENT, 1, { root: true, len: 1 }), makeModule(2, KIND.MOUTH, 1, { len: 0.3, aspect: 1 })];
    meta.rootModuleInnov = 1;
    meta.links = [makeLink(10, 1, 2, { pos: 0, angleDeg: 178 })];
    meta.regs = [makeReg(20, 2, REG_AXIS.MATURITY, REG_PARAM_GATE, 1, 0.4, 0.05, 0.5)];
    const m2 = repair(meta);
    expect(develop(m2, 0.3, ENV, OPTS).mouth.bite).toBe(0);
    expect(develop(m2, 0.5, ENV, OPTS).mouth.bite).toBe(1);
  });
  it('a gaussian scale regulator peaks at its centre (U6)', () => {
    const g = emptyGenome();
    g.modules = [makeModule(1, KIND.SEGMENT, 1, { root: true, len: 1 }), makeModule(2, KIND.SEGMENT, 0, { len: 1 }),
      makeModule(3, KIND.FIN, 0, { len: 0.5, aspect: 0.1 })];
    g.rootModuleInnov = 1;
    g.links = [makeLink(10, 1, 2, { pos: 1, repeat: 9 }), makeLink(11, 2, 3, { pos: 0.5, angleDeg: 60 })];
    g.regs = [makeReg(20, 3, REG_AXIS.AP, 8, 0, 0.5, 0.15, 1)];
    const ph = develop(repair(g), 1, ENV, OPTS);
    const fins = Array.from(ph.kind).map((k, i) => (k === KIND.FIN ? i : -1)).filter((i) => i >= 0);
    let best = fins[0]!;
    for (const i of fins) if (ph.length[i]! > ph.length[best]!) best = i;
    expect(Math.abs(ph.u[best]! - 0.5)).toBeLessThan(0.12);
  });
  it('allometry: alpha 0.6 gives BIRTH_FRACTION^-0.4 relative size at m = 0 (U7)', () => {
    const g = twoPart({ pos: 0.5, angleDeg: 60 }, { alpha: 0.6, len: 0.8, aspect: 0.2 });
    const a = develop(g, 1, ENV, OPTS), j = develop(g, 0, ENV, OPTS);
    const bf = trait(g, T.BIRTH_FRACTION!);
    const relA = a.length[1]! / a.lengthM, relJ = j.length[1]! / j.lengthM;
    const alpha = 0.5 + Math.round(0.1 * 256) / 256; // quantised exponent
    expect(relJ / relA).toBeCloseTo(Math.pow(bf, alpha - 1), 4);
  });
  it('absorbs EYE, CHEMO and PHOTOPHORE parts under 2% of body length as organ flags', () => {
    const g = twoPart({ pos: 0.3, angleDeg: 40, childScale: 0.25 }, { len: 0.05, aspect: 1 }, KIND.EYE);
    const ph = develop(g, 1, ENV, OPTS);
    expect(ph.nParts).toBe(1);
    expect(ph.organs[0]! & ORGAN.EYE).toBeTruthy();
    expect(ph.organList.some((o) => o.kind === 'eye' && o.part === 0)).toBe(true);
  });
  it('caps parts at maxParts, dropping distal parts first', () => {
    const g = twoPart({ pos: 1, repeat: 16 }, {}, KIND.SEGMENT);
    g.modules.push(makeModule(3, KIND.FIN, 0, { len: 0.5, aspect: 0.1 }));
    g.links.push(makeLink(11, 2, 3, { pos: 0.5, repeat: 4, symmetry: SYMMETRY.MIRROR }));
    const ph = develop(repair(g), 1, ENV, { maxParts: 32, lCeilingM: 0.2 });
    expect(ph.nParts).toBe(32);
    expect(develop(repair(g), 1, ENV, OPTS).nParts).toBe(64);
  });
  it('a new gene default leaves 1,000 developed bodies unchanged (CONTRACT 6.1 rule 5)', () => {
    const reg = new InnovationRegistry();
    let g = templateGenome('meadowlamp');
    for (let i = 0; i < 1000; i++) {
      g = mutateWith(g, ctx(10_000 + i, { mutagen: 4 }), reg);
      const before = phHash(develop(g, 0.8, ENV, OPTS));
      const ext = cloneGenome(g);
      const t = new Uint16Array(ext.traits.length + 8); t.set(ext.traits); ext.traits = t;
      ext.unknown.push({ tag: fourcc('ZZZZ'), recordSize: 4, sectionFlags: 0, count: 1, bytes: new Uint8Array([1, 2, 3, 4]) });
      const round = decodeGenome(encodeGenome(ext));
      expect(phHash(develop(round, 0.8, ENV, OPTS))).toBe(before);
    }
  });
});

describe('mutation', () => {
  it('produces valid genomes for 10,000 mutations from every template (U8)', () => {
    const reg = new InnovationRegistry();
    for (const id of TEMPLATE_IDS) {
      let g = templateGenome(id);
      for (let i = 0; i < 1250; i++) {
        g = mutateWith(g, ctx(i * 7 + id.length, { mutagen: 8 }), reg);
        if (i % 25 === 0) { validGenome(g); checkPhenotype(develop(g, (i % 5) / 4, ENV, OPTS)); }
      }
    }
  }, 120_000);
  it('is deterministic in (seed, tick, childId) and independent of call order', () => {
    const g = templateGenome('hushmaw');
    const a = mutateWith(g, ctx(42, { mutagen: 20 }), new InnovationRegistry());
    const b = mutateWith(g, ctx(42, { mutagen: 20 }), new InnovationRegistry());
    expect(encodeGenome(a)).toEqual(encodeGenome(b));
    const c = mutateWith(g, ctx(43, { mutagen: 20 }), new InnovationRegistry());
    expect(encodeGenome(a)).not.toEqual(encodeGenome(c));
  });
  it('point and structural rates follow MU_LOG: about 1.25 points per 250 genes at the default', () => {
    const g = blankGenome();
    const reg = new InnovationRegistry();
    let points = 0, structural = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const s = { points: 0, structural: 0, ops: [] as OpName[] };
      mutateWith(g, ctx(i), reg, s);
      points += s.points; structural += s.structural;
    }
    const expected = Math.pow(10, -2.3) * countGenes(g);
    expect(points / N).toBeGreaterThan(expected * 0.8);
    expect(points / N).toBeLessThan(expected * 1.25);
    expect(structural / N).toBeLessThan(points / N);
  });
  it('brain genes are perturbed far below 0.8 per connection (R15)', () => {
    const g = templateGenome('meadowlamp');
    for (let k = 0; k < 30; k++) g.directSynapses.push({ src: k, dst: 1000 + k, w: 1000, flags: 1, plasticity: 0 });
    const reg = new InnovationRegistry();
    let changed = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const c = mutateWith(g, ctx(i), reg);
      const before = new Map(g.directSynapses.map((s) => [s.src * 4294967296 + s.dst, s.w]));
      for (const s of c.directSynapses) if (before.has(s.src * 4294967296 + s.dst) && before.get(s.src * 4294967296 + s.dst) !== s.w) changed++;
    }
    expect(changed / N / 30).toBeLessThan(0.05);
  });
  it('operator choice follows the weights (U8, chi-squared)', () => {
    const names = Object.keys(OP_WEIGHTS) as OpName[];
    const counts = new Map<OpName, number>(names.map((n) => [n, 0]));
    const N = 60_000;
    const d = rng.draw(RNG_STREAM.MUTATION, 1, 99);
    for (let i = 0; i < N; i++) { const op = pickOperator(d, true); counts.set(op, counts.get(op)! + 1); }
    const direct = names.filter((n) => !n.startsWith('cppn'));
    const total = direct.reduce((a, n) => a + OP_WEIGHTS[n], 0);
    let chi = 0;
    for (const n of direct) { const e = (N * OP_WEIGHTS[n]) / total; chi += (counts.get(n)! - e) ** 2 / e; }
    for (const n of names) if (n.startsWith('cppn')) expect(counts.get(n)).toBe(0);
    expect(chi).toBeLessThan(40); // 12 degrees of freedom; p ~ 1e-4
  });
  it('duplicating the same module three times gives three copies (R22)', () => {
    const g = templateGenome('meadowlamp');
    const reg = new InnovationRegistry();
    const d = rng.draw(RNG_STREAM.MUTATION, 3, 3);
    const fin = 105;
    const ids = [duplicateModule(g, fin, reg, d, false), duplicateModule(g, fin, reg, d, false), duplicateModule(g, fin, reg, d, false)];
    const r = repair(g);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(r.modules.some((m) => m.innov === id)).toBe(true);
    expect(r.modules.filter((m) => m.kind === KIND.FIN && m.subtype === 0 && m.p1 === templateGenome('meadowlamp').modules.find((x) => x.innov === fin)!.p1).length).toBeGreaterThanOrEqual(4);
    // the same event in another lineage reuses the same ids (homology)
    const h = templateGenome('meadowlamp');
    expect(duplicateModule(h, fin, reg, d, false)).toBe(ids[0]);
  });
  it('a duplicated module takes its module-keyed synapses along, so it arrives wired (R15)', () => {
    const g = templateGenome('meadowlamp');
    g.directSynapses.push({ src: hash32(105, 0, 0), dst: hash32(101, 0, 1), w: 3000, flags: 1, plasticity: 0 });
    const reg = new InnovationRegistry();
    const id = duplicateModule(g, 105, reg, rng.draw(RNG_STREAM.MUTATION, 1, 1), false);
    expect(g.directSynapses.some((s) => s.src === hash32(id, 0, 0) && s.w === 3000)).toBe(true);
  });
  it('clamps ADULT_LENGTH to the ceiling unless the genome is a leviathan (R2)', () => {
    const reg = new InnovationRegistry();
    const g = blankGenome();
    setTrait(g, T.ADULT_LENGTH!, 0.9);
    const c = mutateWith(g, ctx(5), reg);
    expect(trait(c, T.ADULT_LENGTH!)).toBeLessThanOrEqual(PRESETS.default.lCeilingM);
    const lev = cloneGenome(g);
    lev.flags |= GENOME_FLAG_LEVIATHAN;
    expect(trait(mutateWith(lev, ctx(5), reg), T.ADULT_LENGTH!)).toBeGreaterThan(0.5);
    clampToCeiling(g, PRESETS.small.lCeilingM);
    expect(expressedAdultLength(g, 1)).toBeLessThanOrEqual(PRESETS.small.lCeilingM);
  });
  it('CPPN genomes (ENCODING 1) get CPPN operators with hashed ids and stay valid', () => {
    const reg = new InnovationRegistry();
    let g = templateGenome('meadowlamp');
    g.brainTraits[BT.ENCODING!] = 65535;
    g.cppnNodes = [{ innov: 11n, fn: 1, flags: 1, bias: 0 }, { innov: 12n, fn: 2, flags: 1, bias: 0 }];
    g.cppnConns = [{ innov: 99n, from: 11n, to: 12n, w: 1000, flags: 1 }];
    for (let i = 0; i < 400; i++) g = mutateWith(g, ctx(i, { mutagen: 40 }), reg);
    expect(g.brainTraits[BT.ENCODING!]).toBe(65535);
    expect(g.cppnNodes.length + g.cppnConns.length).toBeGreaterThan(3);
    expect(g.directSynapses).toHaveLength(0);
    validGenome(g);
  });
  it('ENCODING is immutable', () => {
    const reg = new InnovationRegistry();
    let g = templateGenome('ashpicker');
    for (let i = 0; i < 300; i++) g = mutateWith(g, ctx(i, { mutagen: 30 }), reg);
    expect(g.brainTraits[BT.ENCODING!]).toBe(0);
  });
  it('poisson has the right mean', () => {
    const d = rng.draw(RNG_STREAM.MUTATION, 9, 9);
    for (const lam of [0.3, 3, 25]) {
      let s = 0;
      for (let i = 0; i < 20000; i++) s += poisson(d, lam);
      expect(s / 20000).toBeCloseTo(lam, lam < 1 ? 1 : 0);
    }
  });
});

describe('crossover', () => {
  it('crossover(A, A) == A (U10)', () => {
    for (const id of TEMPLATE_IDS) {
      const a = templateGenome(id);
      expect(encodeGenome(crossoverWith(a, a, ctx(1)))).toEqual(encodeGenome(a));
    }
  });
  it('takes structure from the bearer and alleles from both; matching genes come from A or B', () => {
    const reg = new InnovationRegistry();
    const a = templateGenome('meadowlamp');
    let b = a;
    for (let i = 0; i < 40; i++) b = mutateWith(b, ctx(500 + i, { mutagen: 6 }), reg);
    for (let k = 0; k < 50; k++) {
      const c = crossoverWith(a, b, ctx(900 + k));
      validGenome(c);
      for (let i = 0; i < c.traits.length; i++) {
        const lo = Math.min(a.traits[i]!, b.traits[i]!), hi = Math.max(a.traits[i]!, b.traits[i]!);
        expect(c.traits[i]).toBeGreaterThanOrEqual(lo); expect(c.traits[i]).toBeLessThanOrEqual(hi);
      }
      const am = new Map(a.modules.map((m) => [m.innov, m]));
      for (const m of c.modules) { const o = am.get(m.innov); if (o) { expect(m.kind).toBe(o.kind); expect(m.flags & 2).toBe(o.flags & 2); } }
    }
  });
  it('with an unrelated donor the child is the bearer plus admitted donor genes only', () => {
    const a = templateGenome('hushmaw'), b = templateGenome('sievebell');
    for (let k = 0; k < 30; k++) {
      const c = crossoverWith(a, b, ctx(70 + k));
      const aIds = new Set(a.modules.map((m) => m.innov)), bIds = new Set(b.modules.map((m) => m.innov));
      for (const m of a.modules) expect(c.modules.some((x) => x.innov === m.innov)).toBe(true);
      for (const m of c.modules) expect(aIds.has(m.innov) || bIds.has(m.innov)).toBe(true);
      expect(c.rootModuleInnov).toBe(a.rootModuleInnov);
      checkPhenotype(develop(c, 1, ENV, OPTS));
    }
  });
  it('inherits the leviathan flag from the bearer (CONTRACT 3.3)', () => {
    const lev = templateGenome('deepcrown');
    const plain = cloneGenome(lev); plain.flags &= ~GENOME_FLAG_LEVIATHAN;
    expect(crossoverWith(lev, plain, ctx(1)).flags & GENOME_FLAG_LEVIATHAN).not.toBe(0);
    const c = crossoverWith(plain, lev, ctx(1));
    expect(c.flags & GENOME_FLAG_LEVIATHAN).toBe(0);
    expect(trait(c, T.ADULT_LENGTH!)).toBeLessThanOrEqual(PRESETS.default.lCeilingM);
  });
});

describe('repair', () => {
  it('sorts, dedups, restores a root and drops dangling references', () => {
    const g = templateGenome('meadowlamp');
    g.modules.reverse();
    g.modules.push({ ...g.modules[0]! });
    g.links.push(makeLink(4000, 9999, 101));
    g.regs.push(makeReg(4001, 8888, REG_AXIS.AP, 8, 0, 0.5, 0.2, 0.5));
    g.rootModuleInnov = 31337;
    const r = repair(g);
    validGenome(r);
    expect(r.modules.filter((m) => (m.flags & 2) !== 0)).toHaveLength(1);
  });
  it('an empty genome becomes the Blank head', () => {
    const r = repair(emptyGenome());
    expect(r.modules).toHaveLength(1);
    checkPhenotype(develop(r, 1, ENV, OPTS));
  });
  it('keeps unreachable modules as silent genes and flags them', () => {
    const g = templateGenome('motefly');
    g.links = g.links.filter((l) => l.toInnov !== 703);
    const r = repair(g);
    expect(r.modules.some((m) => m.innov === 703)).toBe(true);
    expect(expressedSets(r).modules.has(703)).toBe(false);
    expect(r.flags & 4).toBe(4);
  });
});

describe('distance', () => {
  it('is zero on itself, symmetric and non-negative (U11)', () => {
    const reg = new InnovationRegistry();
    const gs: Genome[] = TEMPLATE_IDS.map((id) => templateGenome(id));
    let g = gs[0]!;
    for (let i = 0; i < 20; i++) { g = mutateWith(g, ctx(300 + i, { mutagen: 5 }), reg); gs.push(g); }
    for (const a of gs) {
      expect(distance(a, a)).toBe(0);
      for (const b of gs) { const d = distance(a, b); expect(d).toBeGreaterThanOrEqual(0); expect(d).toBeCloseTo(distance(b, a), 12); }
    }
    expect(distance(gs[0]!, gs[1]!)).toBeGreaterThan(0.3);
  });
  it('ignores neutral markers, look genes and silent structure (R14)', () => {
    const a = templateGenome('meadowlamp');
    const b = cloneGenome(a);
    setTrait(b, T.ODOUR_A!, 0.99); setTrait(b, T.BODY_HUE!, 0.01); setTrait(b, T.PULSE_FREQ!, 3);
    b.modules.push(makeModule(3000, KIND.SPIKE, 0, {}));
    b.directSynapses.push({ src: 1, dst: 2, w: 100, flags: 1, plasticity: 0 });
    expect(distance(a, repair(b))).toBe(0);
  });
  it('body-plan distance ignores every gene that does not change the developed adult', () => {
    const a = templateGenome('motefly');
    const b = cloneGenome(a);
    setTrait(b, T.ODOUR_B!, 0.1); setTrait(b, T.LIFESPAN_MULT!, 10);
    expect(descriptorDistance(bodyPlanDescriptor(a, 0.2), bodyPlanDescriptor(b, 0.2))).toBe(0);
    expect(descriptorDistance(bodyPlanDescriptor(a, 0.2), bodyPlanDescriptor(templateGenome('hushmaw'), 0.2))).toBeGreaterThan(0.3);
  });
});

describe('species registry', () => {
  it('clones stay in one species; promotion needs count, persistence and biomass; extinction is reported', async () => {
    const { SpeciesRegistry } = await import('../src/genome/species.js');
    const sr = new SpeciesRegistry({ lCeilingM: 0.2, rng, joinRule: 'medoid' });
    const g = templateGenome('motefly');
    const lh = lifeHistory(g, 0.2);
    const adult = develop(g, 1, ENV, OPTS).massKg;
    const root = sr.found(g, 0, { adultMassKg: adult, tMatureS: lh.tMatureS, name: { genus: 'Flagellux', epithet: 'minima' } });
    for (let i = 0; i < 100; i++) expect(sr.assign({ genome: g, parentSpecies: root, tick: i, entityId: i + 1, massKg: adult, adultMassKg: adult, tMatureS: lh.tMatureS }).species).toBe(root);
    // a very different body founds an incipient species, which is promoted only later
    const h = templateGenome('hushmaw');
    const hAdult = develop(h, 1, ENV, OPTS).massKg;
    const first = sr.assign({ genome: h, parentSpecies: root, tick: 200, entityId: 1000, massKg: hAdult, adultMassKg: hAdult, tMatureS: 10 });
    expect(first.species).not.toBe(root);
    expect(sr.get(first.species)!.status).toBe('incipient');
    let promoted = false;
    for (let i = 1; i < 12; i++) {
      const r = sr.assign({ genome: h, parentSpecies: first.species, tick: 200 + i, entityId: 1000 + i, massKg: hAdult, adultMassKg: hAdult, tMatureS: 10 });
      expect(r.species).toBe(first.species);
      if (r.events.length) promoted = true;
    }
    expect(promoted).toBe(false); // persistence: two generations of 10 s have not passed
    const ev = sr.tick(200 + 30 * 25);
    expect(ev).toEqual([{ k: 'speciation', parent: root, child: first.species, founders: expect.any(Array) }]);
    const sp = sr.get(first.species)!;
    expect(isPronounceable(sp.genus)).toBe(true);
    let out: unknown[] = [];
    for (let i = 0; i < 12; i++) out = sr.death(first.species, hAdult, 2000 + i, 900);
    expect(out).toEqual([{ k: 'extinction', species: first.species, lastId: 2011 }]);
  });
});

describe('species registry, lineage rule (R14)', () => {
  it('a birth never founds a species; a bimodal species splits from its reservoir and the daughter is promoted', async () => {
    const { SpeciesRegistry } = await import('../src/genome/species.js');
    const sr = new SpeciesRegistry({ lCeilingM: 0.2, rng, mode: 'phenotype' });
    const a = templateGenome('motefly'), b = templateGenome('hushmaw');
    const root = sr.found(a, 0, { adultMassKg: 1e-7, tMatureS: 10 });
    let id = 1;
    const events: string[] = [];
    let daughter = 0;
    for (let i = 0; i < 2000; i++) {
      const g = i % 2 === 0 ? a : b;
      const parentSpecies = daughter && g === b ? daughter : root;
      const r = sr.assign({ genome: g, parentSpecies, tick: i * 3, entityId: id++, massKg: 1e-7, adultMassKg: 1e-7, tMatureS: 10, parentGenome: g });
      if (r.species !== root) daughter = r.species;
      for (const e of r.events) events.push(e.k);
    }
    events.push(...sr.tick(2000 * 3 + 30 * 30).map((e) => e.k));
    expect(sr.get(root)!.splitInto).toBeGreaterThan(0);
    expect(events).toContain('speciation');
    // after the split, the two body plans sit in different species
    const ra = sr.assign({ genome: a, parentSpecies: root, tick: 9000, entityId: id++, massKg: 1e-7, adultMassKg: 1e-7, tMatureS: 10 });
    const rb = sr.assign({ genome: b, parentSpecies: root, tick: 9000, entityId: id++, massKg: 1e-7, adultMassKg: 1e-7, tMatureS: 10 });
    expect(ra.species).not.toBe(rb.species);
  });
  it('clonal drift from one founder stays one species', async () => {
    const { SpeciesRegistry } = await import('../src/genome/species.js');
    const sr = new SpeciesRegistry({ lCeilingM: 0.2, rng });
    const reg = new InnovationRegistry();
    const f = templateGenome('motefly');
    const root = sr.found(f, 0, { adultMassKg: 1e-7, tMatureS: 10 });
    let pop = Array.from({ length: 64 }, () => f);
    let id = 1;
    for (let gen = 0; gen < 40; gen++) {
      pop = pop.map((p, k) => { const c = mutateWith(p, ctx(id++, { tick: gen }), reg); sr.assign({ genome: c, parentSpecies: root, tick: gen * 300, entityId: id, massKg: 1e-7, adultMassKg: 1e-7, tMatureS: 10, parentGenome: p }); return pop[(k * 7 + gen) % 64] === p ? c : c; });
    }
    expect(sr.living(true)).toHaveLength(1);
  });
});

describe('species reconcile', () => {
  it('merges species whose medoids are within theta / 2 and resolves the old id', async () => {
    const { SpeciesRegistry } = await import('../src/genome/species.js');
    const sr = new SpeciesRegistry({ lCeilingM: 0.2, rng, mode: 'phenotype' });
    const g = templateGenome('motefly');
    const a = sr.found(g, 0, { adultMassKg: 1e-7, tMatureS: 10 });
    const b = sr.found(cloneGenome(g), 5, { adultMassKg: 1e-7, tMatureS: 10 });
    const c = sr.found(templateGenome('hushmaw'), 5, { adultMassKg: 1e-7, tMatureS: 10 });
    for (const sp of [a, b, c]) sr.assign({ genome: g, parentSpecies: sp, tick: 9, entityId: sp * 10, massKg: 1e-7, adultMassKg: 1e-7, tMatureS: 10 });
    expect(sr.reconcile()).toEqual([[b, a]]);
    expect(sr.resolve(b)).toBe(a);
    expect(sr.get(a)!.pop).toBe(2);
    expect(sr.assign({ genome: g, parentSpecies: b, tick: 10, entityId: 99, massKg: 1e-7, adultMassKg: 1e-7, tMatureS: 10 }).species).toBe(a);
    expect(sr.reconcile((x, y) => (x === a && y === c ? 1 : 0))).toEqual([]);
  });
});

describe('names', () => {
  it('generates deterministic, pronounceable binomials of at most 24 letters, unique in a world', () => {
    const seen = new Set<string>();
    const taken = new Set<string>();
    let dup = 0;
    for (let id = 1; id <= 3000; id++) {
      const f = {
        diet: [((id * 37) % 100) / 100, ((id * 53) % 100) / 100, ((id * 71) % 100) / 100] as [number, number, number],
        filter: id % 3 === 0 ? 1 : 0, latch: id % 11 === 0 ? 1 : 0, size: ((id * 13) % 100) / 100,
        segments: id % 9, fins: id % 4, eyes: id % 3, spikes: id % 5, photophores: id % 6, radial: id % 7 === 0,
        sessile: id % 13 === 0, depth: ((id * 29) % 100) / 100, glowHue: ((id * 17) % 100) / 100,
      };
      const a = binomialFor(42, id, f, null, null, (g) => taken.has(g));
      const b = binomialFor(42, id, f, null, null, (g) => taken.has(g));
      expect(a).toEqual(b);
      expect(isPronounceable(a.genus)).toBe(true);
      expect(a.genus.length).toBeLessThanOrEqual(24);
      expect(a.epithet).toMatch(/^[a-z]{3,24}$/);
      const full = `${a.genus} ${a.epithet}`;
      if (seen.has(full)) dup++;
      seen.add(full); taken.add(a.genus);
    }
    expect(dup).toBe(0);
  });
  it('makes English and Swedish common names', () => {
    const c = commonNameFor({ diet: [0.9, 0.1, 0], filter: 0, latch: 0, size: 0.5, segments: 4, fins: 2, eyes: 2, spikes: 0, photophores: 0, radial: false, sessile: false, depth: 0.2, glowHue: 0.6 });
    expect(c).toEqual({ en: 'blue-glow grazer', sv: 'blåglödande betare' });
  });
});

describe('genome store', () => {
  it('deduplicates by content and reuses the lowest free handle', () => {
    const s = new GenomeStore();
    const a = s.put(templateGenome('motefly')), b = s.put(templateGenome('motefly')), c = s.put(templateGenome('hushmaw'));
    expect(a).toBe(0); expect(b).toBe(0); expect(c).toBe(1);
    s.release(a); expect(s.size).toBe(2); s.release(a); expect(s.size).toBe(1);
    expect(s.put(templateGenome('sievebell'))).toBe(0);
  });
});

describe('module object', () => {
  it('implements GenomeModule with a per-world registry', () => {
    const m1 = createGenomeModule(), m2 = createGenomeModule();
    const g = templateGenome('meadowlamp');
    const c = { ...ctx(77, { mutagen: 50 }) };
    expect(encodeGenome(m1.mutate(g, c))).toEqual(encodeGenome(m2.mutate(g, c)));
    expect(m1.distance(g, g)).toBe(0);
    expect(m1.repair(g)).toEqual(repair(g));
    expect(MAX_RAW_PARTS).toBeGreaterThanOrEqual(MAX_PARTS);
  });
  it('life history decodes the clutch and the growth clock (R10)', () => {
    const lh = lifeHistory(templateGenome('tetherling'), 0.2);
    expect(lh.clutchSize).toBe(32);
    expect(lh.tMatureS).toBeGreaterThan(0);
    const big = lifeHistory(templateGenome('deepcrown'), 0.2), small = lifeHistory(templateGenome('meadowlamp'), 0.2);
    expect(big.tMatureS).toBeGreaterThan(small.tMatureS);
  });
});

describe('encodedSize', () => {
  it('matches the encoder for templates and mutants', async () => {
    const { encodedSize } = await import('../src/genome/genes.js');
    const reg = new InnovationRegistry();
    for (const id of TEMPLATE_IDS) {
      let g = templateGenome(id);
      for (let i = 0; i < 60; i++) { g = mutateWith(g, ctx(i, { mutagen: 10 }), reg); expect(encodedSize(g)).toBe(encodeGenome(g).length); }
    }
  });
});

describe('property tests', () => {
  function randomGenome(seed: number): Genome {
    const d = new RngStreams(seed, 77).draw(RNG_STREAM.WORLDGEN, 0, seed);
    const g = emptyGenome();
    for (let i = 0; i < g.traits.length; i++) if (d.bool(0.3)) g.traits[i] = d.int(65536);
    const nm = 1 + d.int(48);
    for (let k = 0; k < nm; k++) {
      const m = makeModule(10 + k, d.int(12), d.int(5), {});
      const rec = m as unknown as Record<string, number>;
      for (const f of ['length', 'width']) rec[f] = d.int(65536);
      for (const f of ['span', 'taper', 'stiffness', 'lipidFraction', 'muscleFraction', 'gutFraction', 'armourCoverage', 'glow', 'p1', 'p2', 'p3', 'p4', 'p5', 'cpgPhase', 'cpgAmp', 'jointRange', 'allometry', 'photoFraction', 'recursionLimit']) rec[f] = d.int(256);
      rec.hueOffset = d.int(256) - 128; rec.jointRest = d.int(256) - 128; rec.flags = d.int(16) | 1;
      g.modules.push(m);
    }
    g.rootModuleInnov = 10;
    const nl = d.int(65);
    for (let k = 0; k < nl; k++) {
      const l = makeLink(100 + k, 10 + d.int(nm), 10 + d.int(nm), {});
      const rec = l as unknown as Record<string, number>;
      for (const f of ['attachPos', 'repeat', 'symmetry', 'childScale', 'repeatScale', 'flags', 'phaseStep']) rec[f] = d.int(256);
      rec.attachAngle = d.int(256) - 128;
      g.links.push(l);
    }
    const nr = d.int(33);
    for (let k = 0; k < nr; k++) g.regs.push({ innov: 300 + k, targetInnov: d.bool() ? 0 : 10 + d.int(nm), targetKind: d.bool() ? 255 : d.int(12), axis: d.int(4), param: d.bool(0.2) ? 254 : d.int(32), shape: d.int(4), centre: d.int(256), width: d.int(256), amount: d.int(256) - 128, flags: 1 });
    return repair(g);
  }
  it('development of random genomes never throws, stays bounded and finite (U3)', () => {
    let maxParts = 0;
    for (let s = 1; s <= 600; s++) {
      const g = randomGenome(s);
      validGenome(g);
      for (const m of [0, 0.5, 1]) {
        const ph = develop(g, m, { depth01: (s % 10) / 10, tempC: 10 }, s % 2 ? OPTS : { maxParts: 32, lCeilingM: 0.126 });
        checkPhenotype(ph);
        expect(ph.nParts).toBeLessThanOrEqual(s % 2 ? 64 : 32);
        maxParts = Math.max(maxParts, ph.nParts);
      }
    }
    expect(maxParts).toBe(64);
  }, 120_000);
  it('any sequence of mutate and crossover gives a valid genome, and restage equals develop', () => {
    const reg = new InnovationRegistry();
    const pool: Genome[] = TEMPLATE_IDS.map((id) => templateGenome(id)).concat([randomGenome(5), randomGenome(6)]);
    const r = new Restager();
    const d = rng.draw(RNG_STREAM.BIRTH, 3, 3);
    for (let step = 0; step < 1500; step++) {
      const a = pool[d.int(pool.length)]!, b = pool[d.int(pool.length)]!;
      const c = d.bool(0.3) ? crossoverWith(a, b, ctx(step)) : mutateWith(a, ctx(step, { mutagen: 1 + d.int(20) }), reg);
      if (step % 10 === 0) {
        validGenome(c);
        const m = d.u01();
        expect(phHash(r.phenotype(c, m, ENV, OPTS))).toBe(phHash(develop(c, m, ENV, OPTS)));
      }
      pool[d.int(pool.length)] = c;
    }
  }, 120_000);
});

describe('golden template phenotypes (U2)', () => {
  it('matches the checked-in hashes, so any change to development is noticed', () => {
    const got: Record<string, string> = {};
    for (const id of TEMPLATE_IDS) got[id] = [0, 0.5, 1].map((m) => phHash(develop(templateGenome(id), m, ENV, OPTS)).toString(16)).join(',');
    expect(got).toEqual(GOLDEN);
  });
});
/** Regenerate deliberately when development changes (and say why in the commit). */
const GOLDEN: Record<string, string> = {
  ashpicker: 'a834f44d6d33733,b84b3779fb304a7d,a2c3ae7fdb53d7e2',
  blank: 'b35e80ef93e267d,b98867fb8a9a08bc,d9ec1ddd36c1072b',
  deepcrown: 'c8bf9b28434fb00,c0b1240a449b2381,5b63c36e427fb732',
  hushmaw: 'c551bcd1d5011412,27b0bc55a80bef64,bc88c1d52834dcb',
  meadowlamp: 'a33e4fde40b9f112,462eb7172378147b,a18d86b235e16437',
  motefly: 'cb601ebe603266b,335081136c078161,324f659916d93e70',
  sievebell: '6f77184bc15f6d4b,aba953f2ba88c3e6,80a9438fe1e4341d',
  tetherling: 'dba0b001580609e8,36df41326245a35d,d8e00329f0da4556',
};

describe('trait readers', () => {
  it('enzymes sum to 1 and follow CONTRACT 9.3; colours pack deterministically', async () => {
    const { enzymes, packedColour, lookOf } = await import('../src/genome/look.js');
    for (const id of TEMPLATE_IDS) {
      const e = enzymes(templateGenome(id));
      expect(e[0] + e[1] + e[2]).toBeCloseTo(1, 12);
      expect(packedColour(templateGenome(id))).toBe(packedColour(templateGenome(id)));
      expect(lookOf(templateGenome(id)).patternKind).toBeLessThan(4);
    }
    const s = enzymes(templateGenome('sievebell'));
    expect(s[0]).toBeCloseTo(0.7, 2); expect(s[2]).toBeCloseTo(0.3, 2);
    expect(enzymes(templateGenome('tetherling'))[1]).toBeCloseTo(1, 3);
  });
});

describe('phylogeny (U13)', () => {
  it('the pruned tree keeps exactly the ancestry of the living, with the same MRCAs as a full log', async () => {
    const { Phylogeny } = await import('../src/genome/phylogeny.js');
    const ph = new Phylogeny();
    const full = new Map<number, number>(); // id -> mother, never pruned
    const alive: number[] = [];
    const d = rng.draw(RNG_STREAM.BIRTH, 11, 11);
    let next = 1;
    for (let i = 0; i < 20; i++) { ph.birth(next, 0, 0, 0, 1); full.set(next, 0); alive.push(next++); }
    for (let step = 0; step < 5000; step++) {
      const mother = alive[d.int(alive.length)]!;
      ph.birth(next, mother, 0, step, 1); full.set(next, mother); alive.push(next++);
      if (alive.length > 60) { const k = d.int(alive.length); ph.death(alive[k]!); alive.splice(k, 1); }
    }
    const fullMrca = (a: number, b: number): number => {
      const s = new Set<number>();
      for (let x = a; x; x = full.get(x)!) s.add(x);
      for (let y = b; y; y = full.get(y)!) if (s.has(y)) return y;
      return 0;
    };
    for (let k = 0; k < 300; k++) { const a = alive[d.int(alive.length)]!, b = alive[d.int(alive.length)]!; expect(ph.mrca(a, b)).toBe(fullMrca(a, b)); }
    // every node left is alive or an ancestor of a living node
    const needed = new Set<number>();
    for (const a of alive) for (let x = a; x; x = full.get(x)!) needed.add(x);
    expect(ph.size).toBe(needed.size);
    // compaction removes dead unary ancestors but keeps the MRCAs of living pairs
    const before = alive.map((a) => alive.map((b) => ph.mrca(a, b)));
    const spliced = ph.compact([...alive].sort((x, y) => x - y));
    expect(spliced).toBeGreaterThan(0);
    alive.forEach((a, i) => alive.forEach((b, j) => {
      const m = before[i]![j]!;
      const got = ph.mrca(a, b);
      // a spliced MRCA is replaced by the nearest surviving ancestor below it on both lines
      if (ph.get(m)) expect(got).toBe(m);
    }));
  });
});

describe('parent-diff encoding (R17)', () => {
  it('round-trips mutants exactly and is much smaller than the child', async () => {
    const { diffEncode, diffDecode } = await import('../src/genome/diff.js');
    const reg = new InnovationRegistry();
    let total = 0, patched = 0;
    for (const id of TEMPLATE_IDS) {
      let g = templateGenome(id);
      for (let i = 0; i < 40; i++) {
        const c = mutateWith(g, ctx(i, { mutagen: 3 }), reg);
        const pb = encodeGenome(g), cb = encodeGenome(c);
        const patch = diffEncode(pb, cb);
        expect(diffDecode(pb, patch)).toEqual(cb);
        total += cb.length; patched += patch.length;
        g = c;
      }
    }
    expect(patched / total).toBeLessThan(0.25);
    const a = encodeGenome(templateGenome('hushmaw')), b = encodeGenome(templateGenome('sievebell'));
    expect(diffDecode(a, diffEncode(a, b))).toEqual(b);
  });
});

describe('breed', () => {
  it('budding and sexual births are deterministic and valid', async () => {
    const { breed } = await import('../src/genome/index.js');
    const m = createGenomeModule();
    const a = templateGenome('meadowlamp');
    const b = mutateWith(a, ctx(1, { mutagen: 10 }), new InnovationRegistry());
    const c1 = breed(m, a, b, ctx(5)), c2 = breed(createGenomeModule(), a, b, ctx(5));
    expect(encodeGenome(c1)).toEqual(encodeGenome(c2));
    validGenome(breed(m, a, null, ctx(6)));
  });
});

describe('editor paths', () => {
  it('give each part its instance path when asked, and do not change the body', async () => {
    const g = templateGenome('meadowlamp');
    const plain = develop(g, 1, ENV, OPTS);
    const ed = develop(g, 1, ENV, { ...OPTS, editorPaths: true }) as import('../src/genome/develop.js').PhenotypeWithPaths;
    expect(phHash(ed)).toBe(phHash(plain));
    expect(ed.paths).toHaveLength(ed.nParts);
    expect(ed.paths![0]).toEqual([]);
    const eyes = Array.from(ed.kind).map((k, i) => (k === KIND.EYE ? i : -1)).filter((i) => i >= 0);
    expect(eyes.map((i) => ed.paths![i]!.at(-1)!.side).sort()).toEqual([-1, 1]);
    for (let i = 1; i < ed.nParts; i++) expect(ed.paths![i]!.length).toBeGreaterThan(0);
  });
});
