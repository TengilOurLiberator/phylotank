/** 06 §6.1.8: colour from genes in OKLCH. */
import { describe, expect, it } from 'vitest';
import { deltaEOK, isSaturatedRed, linearToOklab, lookFromGenes, lumHueFromGene, oklchToLinear } from '../src/render/colour.js';
import { ARCHETYPES, archetypeTemplate } from '../src/render/archetypes.js';

describe('render colour', () => {
  it('OKLCH endpoints and round trip', () => {
    const w = oklchToLinear(1, 0, 0);
    for (const c of w) expect(c).toBeCloseTo(1, 3);
    const k = oklchToLinear(0, 0, 0);
    for (const c of k) expect(Math.abs(c)).toBeLessThan(1e-6);
    const c = oklchToLinear(0.6, 0.1, 140);
    const lab = linearToOklab(c[0], c[1], c[2]);
    expect(lab[0]).toBeCloseTo(0.6, 3);
    expect(Math.hypot(lab[1], lab[2])).toBeCloseTo(0.1, 3);
  });
  it('gamut mapping keeps channels in range and the hue', () => {
    for (let h = 0; h < 360; h += 15) {
      const c = oklchToLinear(0.75, 0.4, h);
      for (const v of c) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
      const lab = linearToOklab(c[0], c[1], c[2]);
      const hue = ((Math.atan2(lab[2], lab[1]) * 180) / Math.PI + 360) % 360;
      const dh = Math.min(Math.abs(hue - h), 360 - Math.abs(hue - h));
      expect(dh).toBeLessThan(3);
    }
  });
  it('the luminescence hue warp puts most of the gene range in blue to green', () => {
    expect(lumHueFromGene(0.5)).toBeCloseTo(220, 6);
    let inBlueGreen = 0;
    for (let i = 0; i <= 100; i++) {
      const h = lumHueFromGene(i / 100);
      if (h >= 150 && h <= 290) inBlueGreen++;
    }
    expect(inBlueGreen).toBeGreaterThan(70);
    // rare lineages still reach red
    expect(isSaturatedRed(lumHueFromGene(0.98), 0.2)).toBe(true);
  });
  it('the gene table of 06 §6.1.8', () => {
    const L = lookFromGenes({ pigHue: 0.25, pigSat: 1, pigLight: 0, opacity: 1, lumHue: 0.5, lumGain: 1, stripeFreq: 0, stripeAmp: 0, spotDensity: 0, trailGain: 0.3, pulsePeriodS: 3, pulseDuty: 0.5, softness: 1 });
    expect(L.bodyHue).toBeCloseTo(90);
    expect(L.bodyChroma).toBeCloseTo(0.12);
    expect(L.bodyL).toBeCloseTo(0.3);
    expect(L.coreAlpha).toBeCloseTo(0.58);
    expect(L.edgeAlpha).toBeCloseTo(0.83);
    expect(L.rimGain).toBeCloseTo(4);
    expect(L.red).toBe(false);
  });
  it('saturated red detection is conservative', () => {
    expect(isSaturatedRed(20, 0.2)).toBe(true);
    expect(isSaturatedRed(355, 0.2)).toBe(true);
    expect(isSaturatedRed(220, 0.2)).toBe(false);
    expect(isSaturatedRed(20, 0.05)).toBe(false);
    expect(isSaturatedRed(100, 0.05, [1, 0.05, 0.05])).toBe(true);
  });
  it('archetypes are readable: distinct glow colours for most pairs', () => {
    const cols = ARCHETYPES.filter((a) => a !== 'tetherling').map((a) => archetypeTemplate(a).look.emission);
    let distinct = 0, pairs = 0;
    for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) { pairs++; if (deltaEOK(cols[i]!, cols[j]!) > 0.04) distinct++; }
    expect(distinct / pairs).toBeGreaterThan(0.6);
  });
});
