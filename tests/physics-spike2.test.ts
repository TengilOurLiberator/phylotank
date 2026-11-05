/**
 * Physics spike 2 (docs/spikes/physics-2.md): B4 after the drag review (boundary-layer run
 * length, Lighthill's trailing-edge term, a laterally compressed reference fish). Quick checks
 * always run; PT_SPIKE=1 runs the sweeps and prints "SPIKE" JSON lines.
 */
import { describe, expect, it } from 'vitest';
import { swim, type Gait } from '../src/physics/benchkit.js';
import { fish } from '../src/physics/testkit.js';

const LONG = !!process.env.PT_SPIKE;
const log = (tag: string, data: unknown): void => { if (LONG) console.log(`SPIKE ${tag} ${JSON.stringify(data)}`); };
/** Carangiform-style envelope: joint amplitude grows linearly towards the tail. */
const lin = (A: number): number[] => Array.from({ length: 7 }, (_, j) => A * (j + 1) / 7);

describe('physics spike 2: B4 inertial undulator', () => {
  it('B4: the compressed reference fish cruises at a Strouhal number in the real band', { timeout: 120_000 }, () => {
    const g: Gait = { f: 4, amp: lin(0.3), lag: 0.8 };
    const r = swim(g, { nSub: 4 }, LONG ? 8 : 4, fish(8, 0.2, 2));
    log('b4quick', r);
    expect(r.U).toBeGreaterThan(0.2);
    expect(r.Re).toBeGreaterThan(1000);
    expect(r.St).toBeGreaterThan(0.15);
    expect(r.St).toBeLessThan(0.5);
  });

  it('B4: the trailing-edge term is the difference (off, the same gait needs a far higher St)', { timeout: 120_000 }, () => {
    const g: Gait = { f: 4, amp: lin(0.3), lag: 0.8 };
    const on = swim(g, { nSub: 4 }, 4, fish(8, 0.2, 2));
    const off = swim(g, { nSub: 4, trailingEdge: 0 }, 4, fish(8, 0.2, 2));
    expect(on.U).toBeGreaterThan(1.5 * off.U);
  });

  it.runIf(LONG)('B4 sweep: before and after, round and compressed bodies', { timeout: 1_800_000 }, () => {
    const out: Record<string, unknown>[] = [];
    const cases: [string, Parameters<typeof swim>[1], number, (A: number) => number[]][] = [
      ['round, uniform gait, TE off (spike 1 body and gait; friction fix only)', { trailingEdge: 0 }, 1, (A) => [A]],
      ['round, uniform gait, TE on', {}, 1, (A) => [A]],
      ['round, tail envelope, TE on', {}, 1, lin],
      ['compressed x2, tail envelope, TE off', { trailingEdge: 0 }, 2, lin],
      ['compressed x2, tail envelope, TE on', {}, 2, lin],
      ['compressed x2.5, tail envelope, TE on', {}, 2.5, lin],
    ];
    for (const [name, opts, depth, env] of cases) {
      const rows: { A: number; f: number; U: number; BLps: number; Re: number; St: number; P: number; cot: number; eta: number; tipAmp: number }[] = [];
      for (const A of [0.3, 0.5]) for (const f of [1, 2, 3, 4, 6]) {
        const r = swim({ f, amp: env(A), lag: 0.8 }, { nSub: 4, ...opts }, 8, fish(8, 0.2, depth));
        rows.push({ A, f, U: r.U, BLps: r.U / 0.2, Re: r.Re, St: r.St, P: r.P, cot: r.cot, eta: r.eta, tipAmp: r.tipAmp });
      }
      // St at the peak efficiency of each amplitude
      const peaks = [0.3, 0.5].map((A) => rows.filter((q) => q.A === A).reduce((a, b) => (b.eta > a.eta ? b : a)));
      out.push({ name, rows, peaks: peaks.map((q) => ({ A: q.A, f: q.f, St: q.St, eta: q.eta, U: q.U })) });
      log('b4case', out[out.length - 1]);
    }
  });
});
