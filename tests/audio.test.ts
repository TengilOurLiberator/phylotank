/**
 * Audio tests (06 §6.8.3), run on the composer and the deterministic offline renderer in Node:
 * level bounds, no clipping or NaN, darkness lowers the spectral centroid and recovers, thud and
 * voice caps, determinism, silence when muted, and the mode, harmony and motif rules.
 */
import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../src/core/index.js';
import {
  Ambience, audioOnByDefault, centroid, Composer, harmonyFor, MAX_VOICES, modeFor, modeWeights, motifFor,
  mutateMotif, peakDb, renderOffline, rmsDb, voiceLead, type CameraIn,
} from '../src/audio/index.js';

const census = (kg: number, n = 6) => ({ species: Array.from({ length: n }, (_, i) => ({ id: i + 1, count: 50 + i * 10, biomassKg: kg / n })) });
const cam: CameraIn = { depth01: 0.3, zoom01: 0.3 };
const ev = (e: object): SimEvent => ({ t: 0, eid: 1, epoch: 0, ...e } as SimEvent);

/** Step the composer without synthesis (fast-forward), at 20 Hz. */
function ff(c: Composer, seconds: number, camIn: CameraIn = cam): void {
  for (let i = 0; i < seconds * 20; i++) { c.step(0.05, camIn); c.out.length = 0; }
}

describe('audio theory', () => {
  it('darkness moves the mode from Lydian to Phrygian, and raises the Phrygian weight monotonically', () => {
    expect(modeFor(0)).toBe('lydian');
    expect(modeFor(0.2)).toBe('ionian');
    expect(modeFor(0.5)).toBe('dorian');
    expect(modeFor(0.9)).toBe('phrygian');
    let prev = -1;
    for (let d = 0; d <= 1.0001; d += 0.05) {
      const w = modeWeights(d);
      const sum = Object.values(w).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 9);
      expect(w.phrygian).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = w.phrygian;
    }
  });
  it('diversity sets harmonic richness', () => {
    expect(harmonyFor(0.5)).toBe('triad');
    expect(harmonyFor(1.5)).toBe('add9');
    expect(harmonyFor(2.5)).toBe('add79');
  });
  it('leitmotifs are 3 to 5 notes, stable per species, and a child differs from its parent in one note', () => {
    for (let sp = 1; sp < 200; sp++) {
      const m = motifFor(sp);
      expect(m.length).toBeGreaterThanOrEqual(3);
      expect(m.length).toBeLessThanOrEqual(5);
      expect(motifFor(sp)).toEqual(m);
      const c = mutateMotif(m, sp + 1000);
      expect(c.length).toBe(m.length);
      expect(c.filter((x, i) => x !== m[i]).length).toBe(1);
    }
  });
  it('voice leading moves little between chords', () => {
    const a = voiceLead([], [0, 4, 7], 4, 48, 72);
    const b = voiceLead(a, [5, 9, 0], 4, 48, 72);
    const move = a.reduce((s, x, i) => s + Math.abs(x - b[i]!), 0);
    expect(move).toBeLessThanOrEqual(8);
  });
});

describe('composer mapping (06 §6.3.2)', () => {
  it('biomass sets density (voices, chord rate, brightness) with a 60 s time constant', () => {
    const lo = new Composer(1); lo.census(census(10)); ff(lo, 10);
    for (let i = 0; i < 5; i++) { lo.census(census(1)); ff(lo, 60); }
    const hi = new Composer(1); hi.census(census(10)); ff(hi, 10);
    for (let i = 0; i < 5; i++) { hi.census(census(100)); ff(hi, 60); }
    expect(hi.p.density).toBeGreaterThan(lo.p.density + 0.3);
    expect(hi.p.padVoices).toBeGreaterThan(lo.p.padVoices);
    expect(hi.p.chordEveryS).toBeLessThan(lo.p.chordEveryS);
    expect(hi.p.padCutoffHz).toBeGreaterThan(lo.p.padCutoffHz);
  });
  it('a disaster raises darkness within seconds and it decays over about ten minutes', () => {
    const c = new Composer(1); c.census(census(10)); ff(c, 30);
    expect(c.p.darkness).toBeLessThan(0.01);
    c.events([ev({ k: 'massDeath', centroid: [1, 1], radius: 3, deaths: 2000, z: 9 })]);
    ff(c, 20);
    const peak = c.p.darkness;
    expect(peak).toBeGreaterThan(0.5);
    expect(['dorian', 'aeolian', 'phrygian']).toContain(c.p.mode);
    expect(c.p.droneDetuneCents).toBeGreaterThan(9);
    ff(c, 600);
    expect(c.p.darkness).toBeLessThan(peak * 0.45);
    ff(c, 1200);
    expect(c.p.darkness).toBeLessThan(0.1);
  });
  it('thuds follow power strokes at most once per 1.5 s, pitch 30 to 70 Hz', () => {
    const c = new Composer(1); c.census(census(10));
    const thuds: number[] = [];
    for (let i = 0; i < 20 * 120; i++) {
      // a giant stroking at 2 Hz: the phase wraps every 0.5 s
      const phase = ((i * 0.05) * 2) % 1;
      c.step(0.05, { ...cam, giants: [{ id: 9, sizeRel: 1.5, area: 0.2, phase }] });
      for (const n of c.out) if (n.kind === 'thud') { thuds.push(n.t); expect(n.hz!).toBeGreaterThanOrEqual(30); expect(n.hz!).toBeLessThanOrEqual(70); }
      c.out.length = 0;
    }
    expect(thuds.length).toBeGreaterThan(40);
    for (let i = 1; i < thuds.length; i++) expect(thuds[i]! - thuds[i - 1]!).toBeGreaterThanOrEqual(1.5 - 1e-9);
  });
  it('voices never exceed 24, births ring at most every 4 s, and the featured species plays its motif once', () => {
    const c = new Composer(3); c.census(census(1000, 12));
    const bells: number[] = [];
    let motifs = 0;
    for (let i = 0; i < 20 * 300; i++) {
      c.step(0.05, { ...cam, births: 3, kills: i % 200 === 0 ? 1 : 0, featured: i < 2000 ? 5 : 6, giants: [{ id: 1, sizeRel: 2, area: 0.3, phase: (i * 0.1) % 1 }] });
      expect(c.voiceCount).toBeLessThanOrEqual(MAX_VOICES);
      for (const n of c.out) { if (n.kind === 'bell') bells.push(n.t); if (n.kind === 'motif') motifs++; }
      c.out.length = 0;
    }
    for (let i = 1; i < bells.length; i++) expect(bells[i]! - bells[i - 1]!).toBeGreaterThanOrEqual(4 - 1e-9);
    expect(motifs).toBe(motifFor(5).length + motifFor(6).length);
  });
  it('a speciation gives the child its parent motif with one note changed', () => {
    const c = new Composer(1);
    c.events([ev({ k: 'speciation', parent: 7, child: 70, founders: [1], pos: [0, 0] })]);
    const diff = c.motif(70).filter((x, i) => x !== motifFor(7)[i]).length;
    expect(diff).toBe(1);
  });
});

describe('offline renders (06 §6.8.3)', () => {
  // boom (biomass rising), crash (mass death), recovery; giant pass-by throughout
  const script = (t: number, c: Composer): CameraIn => {
    if (Math.abs(t % 1) < 1e-9) c.census(census(t < 40 ? 10 + t : 50));
    if (Math.abs(t - 60) < 0.025) c.events([ev({ k: 'massDeath', centroid: [1, 1], radius: 3, deaths: 3000, z: 9 })]);
    return { depth01: 0.3, zoom01: 0.3, births: t > 20 && t < 40 ? 1 : 0, giants: t > 80 && t < 110 ? [{ id: 3, sizeRel: 1.8, area: 0.25, phase: (t * 0.7) % 1 }] : [] };
  };
  const a = renderOffline(new Composer(11), 120, script);

  it('no NaN, peak at most -1 dBFS, level in the gentle background range', () => {
    let finite = true;
    for (const v of a.samples) if (!Number.isFinite(v)) { finite = false; break; }
    expect(finite).toBe(true);
    expect(peakDb(a.samples)).toBeLessThanOrEqual(-1 + 1e-6);
    const lvl = rmsDb(a.samples, 10 * a.rate, 50 * a.rate);
    expect(lvl).toBeGreaterThan(-45);
    expect(lvl).toBeLessThan(-15);
  });
  it('deterministic: the same seed and trajectory give a bit-identical buffer', () => {
    const b = renderOffline(new Composer(11), 120, script);
    expect(Buffer.from(b.samples.buffer).equals(Buffer.from(a.samples.buffer))).toBe(true);
  });
  it('the spectral centroid after a crash is at least 30% lower, and recovers within 20% after 15 minutes', () => {
    const N = 4096;
    const before = (centroid(a.samples, a.rate, 50 * a.rate, N) + centroid(a.samples, a.rate, 55 * a.rate, N)) / 2;
    const after = (centroid(a.samples, a.rate, 75 * a.rate, N) + centroid(a.samples, a.rate, 78 * a.rate, N)) / 2;
    expect(after).toBeLessThan(0.7 * before);
    // fast-forward the same composer state through 15 simulated minutes, then render again
    const c = new Composer(11);
    renderOffline(c, 70, script);
    ff(c, 15 * 60);
    const r = renderOffline(c, 20, () => ({ depth01: 0.3, zoom01: 0.3 }));
    const rec = (centroid(r.samples, r.rate, 8 * r.rate, N) + centroid(r.samples, r.rate, 12 * r.rate, N)) / 2;
    expect(Math.abs(rec - before) / before).toBeLessThan(0.2);
  });
  it('is silent when muted', () => {
    const c = new Composer(11);
    c.muted = true;
    const r = renderOffline(c, 10, script);
    expect(peakDb(r.samples)).toBe(-Infinity);
  });
});

describe('the Ambience module', () => {
  it('is off by default on the wallpaper and the screensaver, on for TV (CONTRACT 15, Q10)', () => {
    expect(audioOnByDefault('wallpaper')).toBe(false);
    expect(audioOnByDefault('screensaver')).toBe(false);
    expect(audioOnByDefault('tv')).toBe(true);
  });
  it('starts silently without Web Audio, and schedules notes through a graph when it has one', async () => {
    const quiet = new Ambience(1, () => null);
    await quiet.start();
    quiet.stop();
    // a minimal fake AudioContext records what the graph creates
    const made: string[] = [];
    const param = () => ({ value: 0, setTargetAtTime() {}, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
    const node = (kind: string) => { made.push(kind); return { connect: (n: unknown) => n, disconnect() {}, gain: param(), frequency: param(), Q: param(), detune: param(), pan: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), type: '', buffer: null, start() {}, stop() {}, setPeriodicWave() {} }; };
    const ctx = {
      currentTime: 0, sampleRate: 8000, destination: node('dest'), state: 'running',
      resume: async () => {}, close: async () => {},
      createGain: () => node('gain'), createBiquadFilter: () => node('filter'), createOscillator: () => node('osc'),
      createStereoPanner: () => node('pan'), createDynamicsCompressor: () => node('comp'), createConvolver: () => node('conv'),
      createBuffer: (_c: number, len: number) => ({ getChannelData: () => new Float32Array(len) }),
      createPeriodicWave: () => ({}),
    };
    const amb = new Ambience(1, () => ctx as never);
    amb.census(census(10));
    await amb.start();
    for (let i = 0; i < 10; i++) { ctx.currentTime += 0.05; (amb as unknown as { tick(): void }).tick(); }
    amb.stop();
    expect(made.filter((k) => k === 'osc').length).toBeGreaterThan(2);
    expect(made).toContain('comp');
  });
});
