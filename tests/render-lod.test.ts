/** 06 §6.1.4: five LOD tiers with +-15% hysteresis and per-profile caps. */
import { describe, expect, it } from 'vitest';
import { classify, TIER, TIER_CAPS, tierFor, type LodCandidate, type Tier } from '../src/render/lod.js';

describe('render LOD', () => {
  it('tiers from screen size', () => {
    expect(tierFor(0.5, -1)).toBe(TIER.D);
    expect(tierFor(2, -1)).toBe(TIER.L3);
    expect(tierFor(10, -1)).toBe(TIER.L2);
    expect(tierFor(50, -1)).toBe(TIER.L1);
    expect(tierFor(200, -1)).toBe(TIER.L0);
  });
  it('hysteresis of 15% each way', () => {
    expect(tierFor(30, TIER.L2)).toBe(TIER.L2);
    expect(tierFor(33, TIER.L2)).toBe(TIER.L1);
    expect(tierFor(25, TIER.L1)).toBe(TIER.L1);
    expect(tierFor(23, TIER.L1)).toBe(TIER.L2);
    // a big jump crosses several tiers at once
    expect(tierFor(500, TIER.L3)).toBe(TIER.L0);
    expect(tierFor(0.1, TIER.L0)).toBe(TIER.D);
  });
  it('a size wobbling 10% around a threshold never flickers', () => {
    let t: Tier | -1 = -1;
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      t = tierFor(110 * (1 + 0.1 * Math.sin(i * 0.37)), t);
      if (i > 0) seen.add(t);
    }
    expect(seen.size).toBe(1);
  });
  it('caps demote the smallest, never the director subject', () => {
    const cands: LodCandidate[] = Array.from({ length: 20 }, (_, i) => ({ id: i, sizePx: 200 + i, priority: 0 }));
    cands[0]!.priority = 1; // the smallest, but the shot's subject
    const prev = new Map<number, Tier>();
    const out: Tier[] = [];
    const counts = classify(cands, prev, TIER_CAPS.wallpaper, out);
    expect(counts[TIER.L0]).toBe(16);
    expect(counts[TIER.L1]).toBe(4);
    expect(out[0]).toBe(TIER.L0);
    for (let i = 1; i <= 4; i++) expect(out[i]).toBe(TIER.L1);
    expect(prev.get(19)).toBe(TIER.L0);
  });
});
