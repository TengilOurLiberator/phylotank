/** evolab: the toy world, the recorder, the exploit detectors and the outputs. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { RngStream, RNG_STREAM } from '../src/core/index.js';
import { parseArgs } from '../tools/evolab/cli.js';
import { runDetectors } from '../tools/evolab/detectors.js';
import { runLab, toCsv, writeOutputs } from '../tools/evolab/lab.js';
import { renderChart } from '../tools/evolab/plot/chart.js';
import { bodyMass, dragForce, frontalArea, shapeCd, steadySpeed } from '../tools/evolab/toy/body.js';
import { Cursor } from '../tools/evolab/toy/cursor.js';
import { ToyEngine } from '../tools/evolab/toy/engine.js';
import { decodeGene, encodeGene, GENES, GI, mutate, NG } from '../tools/evolab/toy/genome.js';

const tiny = (over: ConstructorParameters<typeof ToyEngine>[0] = {}): ToyEngine => new ToyEngine({ preset: 'tiny', seed: 3, ...over });

describe('evolab toy: genome and body', () => {
  it('genes round-trip through their ranges', () => {
    GENES.forEach((g, i) => {
      for (const u of [0, 0.25, 0.5, 1]) expect(encodeGene(i, decodeGene(i, u))).toBeCloseTo(u, 9);
      expect(decodeGene(i, 0)).toBeCloseTo(g.lo, 9);
      expect(decodeGene(i, 1)).toBeCloseTo(g.hi, 9);
    });
  });
  it('mutation is deterministic, bounded, and respects the size ceiling', () => {
    const src = new Float64Array(NG).fill(0.5);
    src[GI.mutRate] = 1;
    const a = new Float64Array(NG), b = new Float64Array(NG);
    const s = new RngStream(5, 0, RNG_STREAM.MUTATION);
    const o = { perGeneP: 1, lengthGeneMax: 0.4, mutagen: 1 };
    mutate(src, 0, a, 0, s.draw(10, 77), o);
    mutate(src, 0, b, 0, s.draw(10, 77), o);
    expect(Array.from(a)).toEqual(Array.from(b));
    for (const x of a) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1); }
    expect(a[GI.length]).toBeLessThanOrEqual(0.4);
    expect(Array.from(a)).not.toEqual(Array.from(src));
  });
  it('a better-built body swims faster: fins help, bluntness hurts, drag is viscous at small size', () => {
    const base = { lengthM: 0.01, aspect: 0.4, finArea: 0.1, muscle: 0.15 };
    const v0 = steadySpeed(base, 1);
    expect(steadySpeed({ ...base, finArea: 0.5 }, 1)).toBeGreaterThan(v0);
    expect(steadySpeed({ ...base, aspect: 0.15 }, 1)).toBeGreaterThan(v0);
    expect(steadySpeed({ ...base, muscle: 0.4 }, 1)).toBeGreaterThan(v0);
    expect(bodyMass({ ...base, lengthM: 0.02 }) / bodyMass(base)).toBeCloseTo(8, 6);
    // micro scale: drag about linear in speed
    const m = { ...base, lengthM: 0.0005 };
    const A = frontalArea(m), c = shapeCd(m.aspect);
    expect(dragForce(m, 2e-4, A, c) / dragForce(m, 1e-4, A, c)).toBeCloseTo(2, 1);
  });
  it('the reusable cursor draws the same numbers as core Draw', () => {
    const s = new RngStream(9, 1, RNG_STREAM.PHYSICS);
    const cur = new Cursor(s).reset(123, 4567);
    const d = s.draw(123, 4567);
    for (let i = 0; i < 10; i++) expect(cur.u01()).toBe(d.u01());
  });
});

describe('evolab toy: world', () => {
  it('is deterministic: same seed, same trajectory', () => {
    const a = tiny(), b = tiny();
    a.step(600); b.step(600);
    const oa = a.observe(), ob = b.observe();
    expect(oa.n).toBe(ob.n);
    expect(Array.from(oa.id)).toEqual(Array.from(ob.id));
    expect(Array.from(oa.lengthM)).toEqual(Array.from(ob.lengthM));
    expect(a.audit().pools).toEqual(b.audit().pools);
    const c = tiny({ seed: 4 });
    c.step(600);
    expect(Array.from(c.observe().lengthM)).not.toEqual(Array.from(oa.lengthM));
  });
  it('the mass ledger is exact (integer equality) on every sample and energy closes', () => {
    const e = tiny();
    for (let k = 0; k < 30; k++) {
      e.step(40);
      const a = e.audit();
      expect(a.ok).toBe(true);
      expect(a.totalQ).toBe(a.expectedQ);
      expect(Math.abs(a.energyResidual!)).toBeLessThan(1e-9);
    }
  });
  it('creatures are born, die of several causes, and inherit generations', () => {
    const e = tiny();
    const res = runLab(e, { hours: 0.75, sampleS: 60 });
    const s = res.summary as { births: number; deathsByCause: Record<string, number>; generationsMaxFinal: number };
    expect(s.births).toBeGreaterThan(50);
    expect(s.deathsByCause.age! + s.deathsByCause.starvation! + s.deathsByCause.predation!).toBeGreaterThan(20);
    expect(s.generationsMaxFinal).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

describe('evolab detectors', () => {
  it('a clean run trips none of the leak and swimmer detectors', () => {
    const res = runLab(tiny(), { hours: 0.5, sampleS: 60, detector: { burnInH: 0.1 } });
    const v = Object.fromEntries(res.verdicts.map((x) => [x.name, x]));
    expect(v.energyLeaks!.fired).toBe(false);
    expect(v.degenerateSwimmers!.available).toBe(true);
    expect(v.degenerateSwimmers!.fired).toBe(false);
  }, 120_000);
  it('energy leaks: a ledger bypass is caught on the first sample', () => {
    const res = runLab(tiny({ leakQPerStep: 1 }), { hours: 0.1, sampleS: 60 });
    const v = res.verdicts.find((x) => x.name === 'energyLeaks')!;
    expect(v.fired).toBe(true);
    expect(v.evidence.worstMassDiffQ).toBeGreaterThan(0);
  });
  it('degenerate swimmers: a propulsive efficiency above 1 is caught', () => {
    const res = runLab(tiny({ thrustBug: 3, founders: [{ label: 'finny', count: 120, traits: { length: 0.004, finArea: 0.95, muscle: 0.3, cruise: 0.6, filter: 0.9, dietPlant: 0.95, dietDetritus: 0.02 } }] }), { hours: 0.05, sampleS: 30, detector: { burnInH: 0 } });
    const v = res.verdicts.find((x) => x.name === 'degenerateSwimmers')!;
    expect(v.fired).toBe(true);
    expect(v.evidence.worstRatio as number).toBeGreaterThan(1.05);
  });
  it('immortal blobs and microbe flood fire on synthetic series and stay clear on benign ones', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      tH: 1 + i, pop: 1000, capFill: 0.95, n_lt2mm: 900, n_2to5mm: 50, maxAgeOverLifespan: 5,
      trait_lifespanMult: 19, trait_senescence: 0.02, deaths: 10, deaths_age: 0, ledgerOk: 1, ledgerDiffQ: 0, energyResidual: 0,
    }));
    const obs = { traitBounds: { lifespanMult: [1, 20] as const, senescence: [0, 1] as const } } as never;
    const v = Object.fromEntries(runDetectors(rows, obs).map((x) => [x.name, x]));
    expect(v.immortalBlobs!.fired).toBe(true);
    expect(v.microbeFlood!.fired).toBe(true);
    const blob = rows.map((r, i) => ({ ...r, maxAgeOverLifespan: 1.5, trait_senescence: 0.5, trait_lifespanMult: 4 + i * 0.3, sessileFrac: i > 5 ? 0.95 : 0 }));
    const b = runDetectors(blob, obs).find((x) => x.name === 'immortalBlobs')!;
    expect(b.fired).toBe(true);
    expect(b.firstH).toBeGreaterThan(5);
    const calm = rows.map((r) => ({ ...r, sessileFrac: 0, capFill: 0.5, maxAgeOverLifespan: 1.2, trait_lifespanMult: 4, trait_senescence: 0.5 }));
    const w = Object.fromEntries(runDetectors(calm, obs).map((x) => [x.name, x]));
    expect(w.immortalBlobs!.fired).toBe(false);
    expect(w.microbeFlood!.fired).toBe(false);
  });
});

describe('evolab outputs', () => {
  it('writes CSV, JSON and valid PNG charts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evolab-'));
    try {
      const res = runLab(tiny(), { hours: 0.2, sampleS: 60 });
      const files = writeOutputs(dir, res, true);
      expect(files.some((f) => f.endsWith('series.csv'))).toBe(true);
      const csv = readFileSync(join(dir, 'series.csv'), 'utf8').split('\n');
      expect(csv[0]).toContain('pop');
      expect(csv[0]).toContain('vMaxMean');
      expect(csv.length).toBeGreaterThan(res.rows.length);
      const sum = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
      expect(sum.detectors.energyLeaks.fired).toBe(false);
      for (const f of files.filter((x) => x.endsWith('.png'))) {
        const b = readFileSync(f);
        expect(Array.from(b.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);
  it('PNG pixels decode to the requested size', () => {
    const png = renderChart({ title: 'T', xLabel: 'X', yLabel: 'Y', series: [{ name: 'A', x: [0, 1, 2], y: [1, 3, 2] }], width: 120, height: 80 });
    const dv = new DataView(png.buffer, png.byteOffset);
    expect(dv.getUint32(16)).toBe(120);
    expect(dv.getUint32(20)).toBe(80);
    const len = dv.getUint32(33);
    const raw = inflateSync(png.subarray(41, 41 + len));
    expect(raw.length).toBe((120 * 4 + 1) * 80);
  });
  it('CSV leaves non-finite cells empty and parses CLI flags', () => {
    expect(toCsv([{ a: 1, b: NaN }, { a: 2, c: 3 }])).toBe('a,b,c\n1,,\n2,,3\n');
    const a = parseArgs(['run', '--hours', '2', '--param', 'b0Mult=1.5', '--free-immortality']);
    expect(a.cmd).toBe('run');
    expect(a.flags.hours).toBe('2');
    expect(a.flags['free-immortality']).toBe(true);
    expect(a.params.b0Mult).toBe(1.5);
  });
});
