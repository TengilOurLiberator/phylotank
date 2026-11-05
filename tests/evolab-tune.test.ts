/** evolab tuning harness: Morris screening, CMA-ES, band scoring, and one tiny end-to-end pass. */
import { describe, expect, it } from 'vitest';
import { RngStreams } from '../src/core/index.js';
import { CmaEs, eigSym } from '../tools/evolab/tune/cmaes.js';
import { runTuning } from '../tools/evolab/tune/harness.js';
import { morris } from '../tools/evolab/tune/morris.js';
import { robust, score, trapezoid, type Band } from '../tools/evolab/tune/objective.js';
import { fromUnit, toUnit, TOY_SPACE } from '../tools/evolab/tune/space.js';

const rng = (seed: number): { rand: () => number; normal: () => number } => {
  const d = new RngStreams(seed, 0).draw(200, 0, 0);
  return { rand: () => d.u01x53(), normal: () => d.normal() };
};

describe('evolab tuning', () => {
  it('Morris ranks influential parameters above inert ones', () => {
    const { rand } = rng(1);
    const res = morris(['big', 'none', 'small', 'inter'], (u) => 10 * u[0]! + 0 * u[1]! + u[2]! + 5 * u[0]! * u[3]!, 10, 4, rand);
    const m = Object.fromEntries(res.map((r) => [r.name, r]));
    expect(m.big!.muStar).toBeGreaterThan(m.small!.muStar);
    expect(m.none!.muStar).toBe(0);
    expect(m.inter!.sigma).toBeGreaterThan(0); // the interaction shows as spread
    expect(m.small!.sigma).toBeLessThan(1e-9); // linear, no interaction
  });
  it('Jacobi eigendecomposition reconstructs a symmetric matrix', () => {
    const A = [[4, 1, 0.5], [1, 3, 0.2], [0.5, 0.2, 2]];
    const { values, vectors } = eigSym(A);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += vectors[i]![k]! * values[k]! * vectors[j]![k]!;
      expect(s).toBeCloseTo(A[i]![j]!, 9);
    }
  });
  it('CMA-ES minimises a shifted ellipsoid in the unit box', () => {
    const { normal } = rng(2);
    const target = [0.2, 0.7, 0.4, 0.9];
    const f = (x: number[]): number => x.reduce((s, v, i) => s + (i + 1) * (v - target[i]!) ** 2, 0);
    const es = new CmaEs({ mean: [0.5, 0.5, 0.5, 0.5], sigma: 0.3 }, normal);
    for (let g = 0; g < 80; g++) { const xs = es.ask(); es.tell(xs, xs.map(f)); }
    expect(es.best.f).toBeLessThan(1e-6);
  });
  it('trapezoid bands, gates, geometric mean and the robust score', () => {
    expect(trapezoid(5, 3, 10)).toBe(1);
    expect(trapezoid(2, 3, 10)).toBeCloseTo(1 - 1 / 7, 12);
    expect(trapezoid(30, 3, 10)).toBe(0);
    expect(trapezoid(1, 2, Infinity)).toBeCloseTo(0.5, 12);
    const bands: Band[] = [
      { metric: 'g', lo: 1, hi: 1, weight: 1, gate: true, describe: '' },
      { metric: 'a', lo: 0, hi: 1, weight: 1, describe: '' },
      { metric: 'b', lo: 0, hi: 1, weight: 1, describe: '' },
    ];
    expect(score({ g: 1, a: 0.5, b: 0.5 }, bands).score).toBe(1);
    expect(score({ g: 0, a: 0.5, b: 0.5 }, bands).score).toBe(0);
    expect(score({ g: 1, a: 0.5, b: 1.5 }, bands).score).toBeCloseTo(Math.sqrt(0.5), 9);
    expect(robust([0.8, 0.8])).toBeCloseTo(0.8, 12);
    expect(robust([1, 0])).toBeCloseTo(0.25, 12);
  });
  it('parameter maps are inverse and respect log ranges', () => {
    for (const p of TOY_SPACE) {
      expect(fromUnit(p, toUnit(p, p.default))).toBeCloseTo(p.default, 9);
      expect(fromUnit(p, 0)).toBeCloseTo(p.lo, 9);
    }
  });
  it('end to end on the tiny toy: screens, selects, and runs CMA-ES', () => {
    const res = runTuning({
      preset: 'tiny', hours: 0.03, seeds: 1, morrisR: 1, top: 2, cmaGenerations: 1, cmaPopulation: 3, seed: 1,
      space: TOY_SPACE.slice(0, 3), sampleS: 120,
    });
    expect(res.screening).toHaveLength(3);
    expect(res.selected).toHaveLength(2);
    expect(res.cma).toHaveLength(1);
    expect(res.evaluations).toBe(4 + 1 + 3);
    expect(res.best.score).toBeGreaterThanOrEqual(0);
  }, 180_000);
});
