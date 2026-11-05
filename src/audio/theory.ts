/**
 * Music theory for the ambience (06 §6.3.2): modes ordered by darkness, a first-order Markov
 * chain over diatonic chords, minimal-movement voice leading, and species leitmotifs that mutate
 * at speciation. Pure and deterministic (core RNG and hash only).
 */
import { hash32, type Draw } from '../core/index.js';

/** Modes from bright to dark, as semitone steps from the tonic; darkness picks among them. */
export const MODES = {
  lydian: [0, 2, 4, 6, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
} as const;
export type ModeName = keyof typeof MODES;
/** Darkness anchors: Lydian 0, Ionian 0.2, Mixolydian 0.35, Dorian 0.5, Aeolian 0.7, Phrygian 0.9. */
export const MODE_ANCHORS: readonly [ModeName, number][] = [
  ['lydian', 0], ['ionian', 0.2], ['mixolydian', 0.35], ['dorian', 0.5], ['aeolian', 0.7], ['phrygian', 0.9],
];

/**
 * Weights of each mode for a darkness D: a triangular kernel around the anchors, so modes
 * crossfade as darkness moves (the Phrygian weight rises monotonically with D above 0.7).
 */
export function modeWeights(D: number): Record<ModeName, number> {
  const out = { lydian: 0, ionian: 0, mixolydian: 0, dorian: 0, aeolian: 0, phrygian: 0 } as Record<ModeName, number>;
  const d = Math.min(1, Math.max(0, D));
  for (let i = 0; i < MODE_ANCHORS.length; i++) {
    const [name, a] = MODE_ANCHORS[i]!;
    const prev = i > 0 ? MODE_ANCHORS[i - 1]![1] : a - 0.2;
    const next = i + 1 < MODE_ANCHORS.length ? MODE_ANCHORS[i + 1]![1] : a + 0.2;
    let w = 0;
    if (d <= a) w = d <= prev ? 0 : (d - prev) / (a - prev);
    else w = d >= next ? 0 : (next - d) / (next - a);
    if (i === MODE_ANCHORS.length - 1 && d >= a) w = 1;
    if (i === 0 && d <= a) w = 1;
    out[name] = w;
  }
  let tot = 0;
  for (const k in out) tot += out[k as ModeName];
  for (const k in out) out[k as ModeName] /= tot;
  return out;
}

/** The mode with the largest weight. */
export function modeFor(D: number): ModeName {
  const w = modeWeights(D);
  let best: ModeName = 'lydian';
  for (const [name] of MODE_ANCHORS) if (w[name] > w[best]) best = name;
  return best;
}

/** Chord degrees 0..6 (I..vii); Markov weights favour I, IV, vi, ii and returning home. */
const CHORD_NEXT: readonly (readonly number[])[] = [
  /* I   */ [0.5, 1.0, 0.2, 2.0, 1.0, 2.0, 0.0],
  /* ii  */ [1.0, 0.3, 0.2, 0.8, 1.5, 0.6, 0.0],
  /* iii */ [0.8, 0.5, 0.2, 1.2, 0.5, 1.5, 0.0],
  /* IV  */ [2.0, 1.0, 0.2, 0.3, 1.2, 1.0, 0.0],
  /* V   */ [2.5, 0.5, 0.3, 0.8, 0.2, 1.2, 0.0],
  /* vi  */ [1.0, 1.5, 0.3, 1.5, 0.8, 0.3, 0.0],
  /* vii */ [2.0, 0.2, 0.2, 0.2, 0.5, 0.5, 0.0],
];

export function nextChord(cur: number, d: Draw): number {
  const row = CHORD_NEXT[cur]!;
  let tot = 0;
  for (const w of row) tot += w;
  let r = d.u01() * tot;
  for (let i = 0; i < row.length; i++) { r -= row[i]!; if (r < 0) return i; }
  return 0;
}

export type Harmony = 'triad' | 'add9' | 'add79';
/** Diversity H (Shannon, nats) to harmonic richness. */
export function harmonyFor(H: number): Harmony { return H < 1 ? 'triad' : H <= 2 ? 'add9' : 'add79'; }

/** Pitch classes (scale steps) of a chord on degree `deg`: stacked thirds within the mode. */
export function chordSteps(deg: number, h: Harmony): number[] {
  const s = [deg, deg + 2, deg + 4];
  if (h === 'add9' || h === 'add79') s.push(deg + 8);
  if (h === 'add79') s.push(deg + 6);
  return s;
}

/** MIDI note of scale step `step` (may exceed 7) in `mode` from tonic MIDI note `tonic`. */
export function stepToMidi(step: number, mode: readonly number[], tonic: number): number {
  const oct = Math.floor(step / 7);
  const idx = ((step % 7) + 7) % 7;
  return tonic + 12 * oct + mode[idx]!;
}

export function midiToHz(m: number): number { return 440 * 2 ** ((m - 69) / 12); }

/**
 * Voice leading: for each previous voice choose the nearest note of the new chord (any octave in
 * [lo, hi]), so total semitone movement is small. Returns MIDI notes, sorted.
 */
export function voiceLead(prev: readonly number[], pcs: readonly number[], n: number, lo: number, hi: number): number[] {
  const cands: number[] = [];
  for (let m = lo; m <= hi; m++) if (pcs.includes(((m % 12) + 12) % 12)) cands.push(m);
  const out: number[] = [];
  const used = new Set<number>();
  const start = prev.length >= n ? prev.slice(0, n) : [...prev, ...spread(n - prev.length, lo, hi)];
  for (const p of start) {
    let best = cands[0] ?? p;
    let bd = Infinity;
    for (const c of cands) {
      const d = Math.abs(c - p) + (used.has(c) ? 7 : 0);
      if (d < bd) { bd = d; best = c; }
    }
    used.add(best);
    out.push(best);
  }
  return out.sort((a, b) => a - b);
}
function spread(n: number, lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.round(lo + ((i + 0.5) * (hi - lo)) / n));
  return out;
}

/** A 3 to 5 note leitmotif (scale steps relative to the tonic) from a hash of the species id. */
export function motifFor(species: number): number[] {
  const h = hash32(species >>> 0, 0x6d6f7469, 0x66);
  const len = 3 + (h % 3);
  const out: number[] = [];
  let step = 0;
  for (let i = 0; i < len; i++) {
    const r = (h >>> (4 + i * 5)) & 31;
    step += [-2, -1, 1, 2, 3, -3, 0, 4][r & 7]!;
    out.push(step);
  }
  return out;
}

/** The child's motif is its parent's with one note mutated (the evolution story told in sound). */
export function mutateMotif(parent: readonly number[], child: number): number[] {
  const h = hash32(child >>> 0, 0x6d757461, 0x74);
  const out = parent.slice();
  const i = h % out.length;
  const delta = (h >>> 8) & 1 ? 1 : -1;
  out[i] = out[i]! + delta * (1 + ((h >>> 9) & 1));
  return out;
}
