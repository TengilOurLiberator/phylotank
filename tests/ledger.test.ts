import { describe, expect, it } from 'vitest';
import { M_REF_1CM, mRef, quantiseWithCarry } from '../src/core/index.js';
import { ageingHazard, agentCapFeeKg, repairPowerW } from '../src/ecosystem/index.js';

describe('contract formulas (CONTRACT 9)', () => {
  it('carry quantisation conserves the real amount over many steps', () => {
    const carry = new Float64Array(4);
    let total = 0;
    for (let i = 0; i < 1000; i++) total += quantiseWithCarry(0.137, carry, 0);
    expect(total).toBe(137);
  });
  it('the agent-cap fee is additive, size-neutral in kg, and so hits microbes hardest (review R11)', () => {
    expect(agentCapFeeKg(1000, 4096)).toBe(0);
    const fee = agentCapFeeKg(0.9 * 4096, 4096);
    expect(fee).toBeCloseTo(0.64 * M_REF_1CM, 12);
    const microbeNewborn = mRef(0.002 * 0.2);
    const fishNewborn = mRef(0.2 * 0.2);
    expect(fee / microbeNewborn).toBeGreaterThan(100);
    expect(fee / fishNewborn).toBeLessThan(0.1);
    expect(agentCapFeeKg(5000, 4096)).toBe(M_REF_1CM);
  });
  it('no lifespan is free and no setting is immortal (review R10)', () => {
    expect(repairPowerW(1, 1.5)).toBeGreaterThan(0);
    expect(repairPowerW(1, 20)).toBeCloseTo(0.95, 10);
    for (const sen of [0, 0.5, 1]) {
      // cumulative hazard at t_life is 1: integrate numerically
      let H = 0;
      const life = 1000;
      for (let t = 0; t < life; t += 0.5) H += ageingHazard(t + 0.25, life, sen) * 0.5;
      expect(H).toBeCloseTo(1, 3);
      expect(ageingHazard(0, life, sen)).toBeGreaterThan(0);
    }
  });
});
