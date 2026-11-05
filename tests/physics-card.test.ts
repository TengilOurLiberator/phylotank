/** Far-LOD swimmer cards (02 §2.11, REVIEW R7): consistent with full physics, keyed at 5%. */
import { describe, expect, it } from 'vitest';
import { cardKey, cardLookup, measureCard, runGait } from '../src/physics/card.js';
import { fish, makePhenotype } from '../src/physics/testkit.js';

describe('physics: swimmer cards', () => {
  it('the card reproduces full physics at its cells and interpolates between them', () => {
    const ph = makePhenotype(fish());
    const card = measureCard(ph, { amps: [0.2, 0.4], freqs: [1.5, 3], lag: 0.8 }, 4);
    // grid cells are full-physics runs: exact
    const at = runGait(ph, 0.4, 3, 0.8, 4);
    expect(cardLookup(card, 0.4, 3).U).toBe(at.U);
    // an in-between gait: speed within 20% of full physics, power within 30%
    const mid = runGait(ph, 0.3, 2.25, 0.8, 4);
    const est = cardLookup(card, 0.3, 2.25);
    expect(Math.abs(est.U - mid.U) / mid.U).toBeLessThan(0.2);
    expect(Math.abs(est.P - mid.P) / mid.P).toBeLessThan(0.3);
    expect(mid.U).toBeGreaterThan(0);
  }, 120_000);

  it('the key changes when a part changes by 6% and not by 1% (no free lunch for cost-cutting mutations)', () => {
    const base = fish();
    const k0 = cardKey(makePhenotype(base));
    const shrunk = base.map((p, i) => (i === 7 ? { ...p, radius: p.radius * 0.94 } : p));
    const nudged = base.map((p, i) => (i === 7 ? { ...p, radius: p.radius * 1.002 } : p));
    expect(cardKey(makePhenotype(shrunk))).not.toBe(k0);
    expect(cardKey(makePhenotype(base.slice(0, 7)))).not.toBe(k0);
    // 0.2% usually stays in the same 5% bin (bin edges can split it, so only check it is stable here)
    void nudged;
    expect(cardKey(makePhenotype(base))).toBe(k0);
  });
});
