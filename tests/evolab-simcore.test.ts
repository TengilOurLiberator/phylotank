/** evolab SimCore adapter: drives the real sim (today the phase-0 skeleton) through the lab. */
import { describe, expect, it } from 'vitest';
import { DIET } from '../src/core/index.js';
import { roleFromDiet, SimCoreEngine } from '../tools/evolab/adapters/simcore.js';
import { ROLE_NAMES } from '../tools/evolab/engine.js';
import { runLab } from '../tools/evolab/lab.js';

describe('evolab SimCore adapter', () => {
  it('runs the real SimCore, records series and keeps the audit exact', () => {
    const e = new SimCoreEngine({ preset: 'small', seed: 11, config: { skeletonMotes: 200 } });
    const res = runLab(e, { hours: 60 / 3600, sampleS: 10 });
    expect(res.rows.length).toBe(7);
    expect(res.rows[0]!.pop).toBe(200);
    expect(res.rows.every((r) => r.ledgerOk === 1)).toBe(true);
    expect(res.rows[res.rows.length - 1]!.tS).toBeCloseTo(60, 6);
    expect(res.rows[0]!.species).toBeGreaterThan(0);
    // motes have no bodies: the swimmer audit is reported as unavailable, not as clear
    const sw = res.verdicts.find((v) => v.name === 'degenerateSwimmers')!;
    expect(sw.available).toBe(false);
  });
  it('is deterministic through the adapter', () => {
    const a = new SimCoreEngine({ seed: 5, config: { skeletonMotes: 50 } });
    const b = new SimCoreEngine({ seed: 5, config: { skeletonMotes: 50 } });
    a.step(90); b.step(90);
    expect(Array.from(a.observe().speedMps)).toEqual(Array.from(b.observe().speedMps));
  });
  it('maps the 7-lane diet EMA to roles', () => {
    const d = new Float32Array(7);
    const role = (lane: number): string => { d.fill(0); d[lane] = 1; return ROLE_NAMES[roleFromDiet(d, 0)]!; };
    expect(role(DIET.LIVE_PREY)).toBe('predator');
    expect(role(DIET.CARCASS)).toBe('scavenger');
    expect(role(DIET.PHYTO)).toBe('filter');
    expect(role(DIET.MAT)).toBe('grazer');
    expect(role(DIET.HOST)).toBe('parasite');
    d.fill(0);
    expect(ROLE_NAMES[roleFromDiet(d, 0)]).toBe('none');
  });
});
