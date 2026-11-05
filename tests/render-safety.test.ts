/** 06 §6.1.7 and CONTRACT 15: flash safety by construction, with the stricter red limits. */
import { describe, expect, it } from 'vitest';
import { VIEW_PROFILES, type ViewMode } from '../src/core/index.js';
import {
  BASELINE_GLOW, clampPeriodS, stepEmission, FlashGuard, LumaLimiter, maxPulseDepth, minPeriodS, organIntensity, pulseShape, slew, worstFlashesPerSecond,
} from '../src/render/safety.js';

const MODES: ViewMode[] = ['wallpaper', 'screensaver', 'tv', 'god'];
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

describe('render flash safety', () => {
  it('period clamps per profile, stricter for red', () => {
    expect(minPeriodS(VIEW_PROFILES.wallpaper, false)).toBe(1);
    expect(minPeriodS(VIEW_PROFILES.screensaver, false)).toBe(0.5);
    for (const m of MODES) {
      expect(minPeriodS(VIEW_PROFILES[m], true)).toBeGreaterThanOrEqual(2);
      expect(clampPeriodS(0.05, VIEW_PROFILES[m], false)).toBeGreaterThanOrEqual(1 / VIEW_PROFILES[m].maxPulseHz);
      expect(clampPeriodS(100, VIEW_PROFILES[m], false)).toBe(12);
      expect(maxPulseDepth(VIEW_PROFILES[m], true)).toBeLessThan(maxPulseDepth(VIEW_PROFILES[m], false));
    }
  });

  it('pulse shape is a smooth raised cosine in [0, 1]', () => {
    let prev = pulseShape(0, 1, 0, 0.5);
    let maxStep = 0;
    for (let i = 1; i <= 1000; i++) {
      const v = pulseShape(i / 1000, 1, 0, 0.3);
      expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1);
      maxStep = Math.max(maxStep, Math.abs(v - prev));
      prev = v;
    }
    expect(maxStep).toBeLessThan(0.02); // no jumps at 1 kHz sampling
  });

  it('ten minutes of random organ genes never exceed the profile pulse rate (v0.1 acceptance 6)', () => {
    const rnd = lcg(7);
    const fps = 30;
    for (const m of MODES) {
      const P = VIEW_PROFILES[m];
      for (let g = 0; g < 40; g++) {
        const period = 0.25 * 80 ** rnd(); // genome range about 0.25 s to 20 s (0.05 to 4 Hz)
        const phase = rnd(), duty = rnd(), depth = rnd();
        const red = rnd() < 0.3;
        const lum: number[] = [];
        for (let i = 0; i < 600 * fps; i++) lum.push(0.05 + 0.9 * organIntensity(i / fps, period, phase, duty, depth, P, red));
        const worst = worstFlashesPerSecond(lum, fps);
        expect(worst).toBeLessThanOrEqual(3); // WCAG 2.3.1: never more than three flashes in any second
        expect(worst).toBeLessThanOrEqual(Math.ceil(red ? P.maxRedPulseHz : P.maxPulseHz));
      }
    }
  });

  it('the analyser catches a fast flash and passes a steady scene', () => {
    const fps = 60;
    const flash = Array.from({ length: 600 }, (_, i) => (Math.floor((i / fps) * 10) % 2 ? 0.9 : 0.05)); // 5 Hz square
    expect(worstFlashesPerSecond(flash, fps)).toBeGreaterThan(3);
    expect(worstFlashesPerSecond(new Array(600).fill(0.3), fps)).toBe(0);
  });

  it('emission slew follows a first-order response', () => {
    let v = 0;
    for (let i = 0; i < 30; i++) v = slew(v, 1, 0.01, 0.3);
    expect(v).toBeCloseTo(1 - Math.exp(-1), 2);
    expect(BASELINE_GLOW).toBeGreaterThan(0);
  });

  it('random brain-driven glow is limited to the profile pulse rate per creature', () => {
    const rnd = lcg(11);
    const fps = 30;
    for (const m of MODES) {
      for (const red of [false, true]) {
        const P = VIEW_PROFILES[m];
        const st = { level: 0, dir: 0, since: -1e9 };
        const lum: number[] = [];
        let target = 0;
        for (let i = 0; i < 120 * fps; i++) {
          if (i % 2 === 0) target = rnd() < 0.5 ? 0 : 1; // a 15 Hz random on/off brain output
          lum.push(stepEmission(st, target, i / fps, 1 / fps, P, red, 1));
        }
        expect(worstFlashesPerSecond(lum, fps)).toBeLessThanOrEqual(Math.ceil(red ? P.maxRedPulseHz : P.maxPulseHz));
      }
    }
  });

  it('the luminance limiter caps whole-screen change per second', () => {
    for (const m of MODES) {
      const cap = VIEW_PROFILES[m].maxLumaChangePerS;
      const lim = new LumaLimiter(cap, 0);
      const dt = 1 / 30;
      let shownPrev = 0.1 * lim.update(0.1, dt);
      for (let i = 0; i < 300; i++) {
        const scene = i < 30 ? 0.1 : 1.0; // a sudden 10x brightening
        const e = lim.update(scene, dt);
        const shown = scene * e;
        expect(Math.abs(shown - shownPrev) / shownPrev).toBeLessThanOrEqual(cap * dt * 1.0001);
        shownPrev = shown;
      }
    }
  });

  it('the runtime net engages on a large flashing region and recovers', () => {
    const g = new FlashGuard(16, 9);
    const n = 16 * 9;
    const fps = 30;
    let engaged = false;
    for (let i = 0; i < 60; i++) {
      const v = Math.floor(i / 3) % 2 ? 0.7 : 0.1; // 5 Hz over the whole screen
      engaged = g.update(new Float32Array(n).fill(v), i / fps, 1 / fps) || engaged;
    }
    expect(engaged).toBe(true);
    expect(Math.min(...g.gain)).toBeLessThan(0.6);
    expect(Math.min(...g.gain)).toBeGreaterThanOrEqual(0.3);
    for (let i = 60; i < 60 + 5 * fps; i++) g.update(new Float32Array(n).fill(0.3), i / fps, 1 / fps);
    expect(Math.min(...g.gain)).toBeCloseTo(1, 5);
    const calm = new FlashGuard(16, 9);
    for (let i = 0; i < 300; i++) expect(calm.update(new Float32Array(n).fill(0.2 + 0.05 * Math.sin(i / 30)), i / fps, 1 / fps)).toBe(false);
  });
});
