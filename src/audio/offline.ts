/**
 * A small deterministic software renderer of the composer's notes, mirroring the Web Audio graph
 * (drone, pads through a lowpass, thuds with a pitch drop and a 2nd harmonic, FM bells, a soft
 * limiter at -1 dBFS). It exists so 06 §6.8.3's offline tests (loudness bounds, no clipping,
 * darkness lowers the spectral centroid, silence when muted) run in Node without a browser.
 * Mono, 8 kHz by default: enough for centroid and level checks, cheap to run for minutes.
 */
import { exp, sin, TAU } from '../core/index.js';
import { midiToHz } from './theory.js';
import type { Composer, CameraIn, NoteEvent } from './composer.js';

export interface RenderOut { samples: Float32Array; rate: number }

interface Voice { n: NoteEvent; hz: number; phase: number; phase2: number; lp: number; lp2: number; t0: number }

/** Peak in dBFS. */
export function peakDb(x: Float32Array): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]!); if (a > m) m = a; }
  return m > 0 ? 20 * Math.log10(m) : -Infinity;
}

/** RMS level in dBFS over a range. */
export function rmsDb(x: Float32Array, i0 = 0, i1 = x.length): number {
  let s = 0;
  for (let i = i0; i < i1; i++) s += x[i]! * x[i]!;
  const r = Math.sqrt(s / Math.max(1, i1 - i0));
  return r > 0 ? 20 * Math.log10(r) : -Infinity;
}

/** Spectral centroid (Hz) of a window: a Hann-windowed DFT on 64 log-spaced bins from 20 Hz. */
export function centroid(x: Float32Array, rate: number, i0: number, n: number): number {
  let num = 0; let den = 0;
  for (let b = 0; b < 64; b++) {
    const f = 20 * (rate / 2 / 20) ** (b / 63);
    let re = 0; let im = 0;
    const w = (TAU * f) / rate;
    for (let i = 0; i < n; i += 2) {
      const v = x[i0 + i]! * (0.5 - 0.5 * Math.cos((TAU * i) / n)); // Hann window: no leakage tail
      re += v * Math.cos(w * i); im += v * Math.sin(w * i);
    }
    const mag = Math.sqrt(re * re + im * im) * f; // weight by bin width (log spacing)
    num += f * mag; den += mag;
  }
  return den > 0 ? num / den : 0;
}

/**
 * Render `seconds` of the composer driven by `drive(t)` (which may feed census, events and camera
 * into the composer). The composer is stepped at 20 Hz; notes are synthesised sample by sample.
 */
export function renderOffline(c: Composer, seconds: number, drive: (t: number, c: Composer) => CameraIn, rate = 8000): RenderOut {
  const n = Math.floor(seconds * rate);
  const out = new Float32Array(n);
  const voices: Voice[] = [];
  const ctl = Math.floor(rate / 20);
  let lpState = 0;
  let env = 1; // limiter gain
  for (let i = 0; i < n; i++) {
    if (i % ctl === 0) {
      const cam = drive(i / rate, c);
      c.step(ctl / rate, cam);
      for (const e of c.out) voices.push({ n: e, hz: e.hz ?? midiToHz(e.midi), phase: 0, phase2: 0, lp: 0, lp2: 0, t0: e.t });
      c.out.length = 0;
      for (let k = voices.length - 1; k >= 0; k--) if (c.time > voices[k]!.n.t + voices[k]!.n.dur + 0.1) voices.splice(k, 1);
    }
    const t = c.time - ctl / rate + (i % ctl) / rate;
    let s = 0;
    const p = c.p;
    const padK = 1 - exp((-TAU * p.padCutoffHz) / rate);
    for (const v of voices) {
      const age = t - v.n.t;
      if (age < 0 || age > v.n.dur) continue;
      const kind = v.n.kind;
      let a: number;
      let y: number;
      if (kind === 'thud') {
        // sine with a pitch drop, 20 ms attack, plus a 2nd harmonic for small speakers
        a = Math.min(1, age / 0.02) * exp(-age / 0.25);
        const f = v.hz * (1 + 0.6 * exp(-age / 0.08));
        v.phase += (TAU * f) / rate;
        y = sin(v.phase) + 0.35 * sin(2 * v.phase);
      } else if (kind === 'bell') {
        a = Math.min(1, age / 0.05) * exp(-age / 0.8);
        v.phase += (TAU * v.hz) / rate;
        v.phase2 += (TAU * v.hz * 3.5) / rate;
        y = sin(v.phase + 1.2 * exp(-age / 0.3) * sin(v.phase2));
      } else {
        // pads, drone, motif: slow attack (>= 50 ms; pads 2 s), release over the last 2 s
        const att = kind === 'motif' ? 0.08 : 2;
        a = Math.min(1, age / att) * Math.min(1, (v.n.dur - age) / Math.min(2, v.n.dur / 2));
        const det = kind === 'drone' ? 2 ** (p.droneDetuneCents / 1200) : 1.003;
        v.phase += (TAU * v.hz) / rate;
        v.phase2 += (TAU * v.hz * det) / rate;
        const raw = 0.5 * (saw(v.phase) + saw(v.phase2));
        // two cascaded one-poles: 12 dB/octave like the graph's biquad lowpass
        const kk = kind === 'motif' ? 0.5 : padK;
        v.lp += (raw - v.lp) * kk;
        v.lp2 += (v.lp - v.lp2) * kk;
        y = v.lp2;
      }
      // keep phases small: dmath's trig is exact only after a cheap range reduction
      if (v.phase > TAU) v.phase -= TAU * Math.floor(v.phase / TAU);
      if (v.phase2 > TAU) v.phase2 -= TAU * Math.floor(v.phase2 / TAU);
      s += y * a * v.n.gain;
    }
    // whole-mix lowpass (camera depth), then a soft limiter keeping the peak under -1 dBFS
    const k = 1 - exp((-TAU * p.masterLowpassHz) / rate);
    lpState += (s - lpState) * k;
    const ceil = 0.89; // -1 dBFS
    const lvl = Math.abs(lpState) * env;
    if (lvl > ceil * 0.9) env *= 0.9; else env += (1 - env) * 0.0005;
    let o = lpState * env;
    if (o > ceil) o = ceil; else if (o < -ceil) o = -ceil;
    out[i] = c.muted ? 0 : o;
  }
  return { samples: out, rate };
}

/** Harmonic amplitudes of the soft saw (the PeriodicWave in webaudio.ts uses the same). */
export const HARMONICS = [1, 0.5, 0.33, 0.25, 0.2, 0.16] as const;
function saw(ph: number): number {
  let s = 0;
  for (let h = 0; h < HARMONICS.length; h++) s += HARMONICS[h]! * sin((h + 1) * ph);
  return s * 0.6;
}
