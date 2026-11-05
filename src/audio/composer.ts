/**
 * The composer: a pure, deterministic model of the ambience (06 §6.3.2). It turns tank state
 * (census, events, camera, director) into smoothed sound parameters and a stream of note events.
 * The Web Audio graph (webaudio.ts) and the offline test renderer (offline.ts) both play it, so
 * the musical behaviour is tested in Node without an AudioContext.
 */
import { clamp, exp, log, log10, RNG_STREAM, RngStream, type SimEvent } from '../core/index.js';
import {
  chordSteps, harmonyFor, MODES, modeFor, modeWeights, motifFor, mutateMotif, nextChord, stepToMidi, voiceLead,
  type Harmony, type ModeName,
} from './theory.js';

export interface Mood { activity: number; richness: number; stress: number; darkness: number; season: number }

export interface CensusIn { species: { id: number; count: number; biomassKg: number }[] }

export interface CameraIn {
  /** Depth of the view centre, 0 at the surface to 1 at the floor. */
  depth01: number;
  /** 0 = whole tank, 1 = microbe scale. */
  zoom01: number;
  /** Giants on screen: size relative to the giant threshold, screen area fraction, stroke phase. */
  giants?: { id: number; sizeRel: number; area: number; phase: number }[];
  /** Births on screen this frame. */
  births?: number;
  /** Kills on screen this frame. */
  kills?: number;
  /** Species the director features now (its leitmotif plays once). */
  featured?: number | null;
  night?: boolean;
}

export interface Params {
  density: number;
  darkness: number;
  diversityH: number;
  harmony: Harmony;
  mode: ModeName;
  modeWeights: Record<ModeName, number>;
  padVoices: number;
  chordEveryS: number;
  padCutoffHz: number;
  droneDetuneCents: number;
  reverbWet: number;
  droneOctaveDown: boolean;
  masterLowpassHz: number;
  droneGain: number;
  microGain: number;
  tonicMidi: number;
}

export type NoteKind = 'pad' | 'drone' | 'thud' | 'bell' | 'motif';
export interface NoteEvent { t: number; kind: NoteKind; midi: number; hz?: number; gain: number; dur: number; pan: number }

export const MAX_VOICES = 24;
const THUD_MIN_GAP_S = 1.5;
const BELL_MIN_GAP_S = 4;

/** Exponential smoothing towards x with time constant tau over dt (frame-rate independent). */
function smooth(v: number, x: number, tau: number, dt: number): number { return x + (v - x) * exp(-dt / tau); }

export class Composer {
  readonly p: Params;
  private t = 0;
  private biomassB = 0;
  private bRef = 0;
  private darknessTarget = 0;
  private hSm = 0;
  private chord = 0;
  private chordT = 0;
  private voices: number[] = [];
  private lastThud = -Infinity;
  private lastBell = -Infinity;
  private draws = 0;
  private readonly rng: RngStream;
  private readonly motifs = new Map<number, number[]>();
  private lastFeatured: number | null = null;
  private swell = 0;
  private season = 0;
  private seasonFrom = 0;
  private seasonT = -Infinity;
  private lastPhase = new Map<number, number>();
  muted = false;
  /** Notes produced since the last drain. */
  readonly out: NoteEvent[] = [];
  /** Sounding note ends, for the voice cap. */
  private sounding: number[] = [];

  constructor(seedLo = 0, seedHi = 0) {
    this.rng = new RngStream(seedLo, seedHi, RNG_STREAM.VIEW_AUDIO);
    this.p = {
      density: 0.5, darkness: 0, diversityH: 1, harmony: 'add9', mode: 'lydian', modeWeights: modeWeights(0),
      padVoices: 4, chordEveryS: 14, padCutoffHz: 300 * 2 ** 1.5, droneDetuneCents: 3, reverbWet: 0.3,
      droneOctaveDown: false, masterLowpassHz: 4000, droneGain: 0.5, microGain: 0.1, tonicMidi: 50,
    };
  }

  get time(): number { return this.t; }

  /** CENSUS: biomass and Shannon diversity. */
  census(c: CensusIn): void {
    let B = 0;
    let N = 0;
    for (const s of c.species) { B += s.biomassKg; N += s.count; }
    let H = 0;
    if (N > 0) for (const s of c.species) { if (s.count > 0) { const q = s.count / N; H -= q * log(q); } }
    if (this.bRef === 0) this.bRef = Math.max(1e-6, B);
    // B_ref is the world's long median; a slow mean (tau 2 h) stands in for the 24 h median here
    this.bRef = this.bRef + (Math.max(1e-6, B) - this.bRef) * 0.0001;
    this.biomassB = B;
    this.hSm = this.hSm === 0 ? H : this.hSm;
    this.hTarget = H;
  }
  private hTarget = 1;

  /** EVENT frames: disasters and mass deaths raise darkness by the fraction of biomass lost. */
  events(evs: readonly SimEvent[]): void {
    for (const e of evs) {
      if (e.k === 'god' && e.major) this.darknessTarget = Math.min(1, this.darknessTarget + 0.25 * e.strength);
      else if (e.k === 'massDeath') {
        const lost = this.biomassB > 0 ? Math.min(1, (e.deaths * 0.01) / this.biomassB) : 0.2;
        this.darknessTarget = Math.min(1, this.darknessTarget + Math.max(0.1, lost));
      } else if (e.k === 'extinction') this.darknessTarget = Math.min(1, this.darknessTarget + 0.1);
      else if (e.k === 'speciation') {
        const parent = this.motif(e.parent);
        this.motifs.set(e.child, mutateMotif(parent, e.child));
      }
    }
  }

  /** Darkness set directly (from the mood scalar of AudioModule.setMood). */
  setDarkness(d: number): void { this.darknessTarget = clamp(d, 0, 1); }
  setSeason(s: number): void {
    if (s !== this.season) { this.seasonFrom = this.season; this.season = s; this.seasonT = this.t; }
  }

  motif(species: number): number[] {
    let m = this.motifs.get(species);
    if (!m) { m = motifFor(species); this.motifs.set(species, m); if (this.motifs.size > 2048) this.motifs.clear(); }
    return m;
  }

  /** Advance by dt seconds with the camera state; appends note events to `out`. */
  step(dt: number, cam: CameraIn): void {
    const p = this.p;
    this.t += dt;
    const t = this.t;
    // density from biomass, tau 60 s
    const B = this.biomassB;
    const d = B > 0 ? clamp(0.5 + log10(B / this.bRef) / 2, 0, 1) : 0;
    p.density = smooth(p.density, d, 60, dt);
    this.hSm = smooth(this.hSm, this.hTarget, 30, dt);
    p.diversityH = this.hSm;
    p.harmony = harmonyFor(this.hSm);
    // darkness: rises with tau 5 s towards the target, which decays with tau 10 min
    this.darknessTarget *= exp(-dt / 600);
    p.darkness = p.darkness < this.darknessTarget ? smooth(p.darkness, this.darknessTarget, 5, dt) : this.darknessTarget;
    const D = p.darkness;
    p.modeWeights = modeWeights(D);
    p.mode = modeFor(D);
    const night = cam.night === true;
    p.padVoices = 2 + Math.round(4 * p.density);
    p.chordEveryS = (20 - 12 * p.density) * (night ? 1.3 : 1);
    p.padCutoffHz = 300 * 2 ** (3 * p.density) * 2 ** (-2 * D) * (night ? 0.7 : 1);
    p.droneDetuneCents = 3 + 15 * D;
    p.reverbWet = 0.3 + 0.3 * D;
    p.droneOctaveDown = D > 0.6;
    // camera depth: 8 kHz at the surface to 1.2 kHz at the floor, exponential in depth
    p.masterLowpassHz = 8000 * (1200 / 8000) ** clamp(cam.depth01, 0, 1);
    p.droneGain = 0.5 * (1 - 0.6 * clamp(cam.zoom01, 0, 1));
    p.microGain = 0.1 + 0.4 * clamp(cam.zoom01, 0, 1);
    // season: the tonic moves a fifth per season (circle of fifths), crossfaded over 2 min
    const fifth = (s: number): number => 50 + ((((s * 7) % 12) + 12) % 12) - (((s * 7) % 12) > 6 ? 12 : 0);
    const f = clamp((t - this.seasonT) / 120, 0, 1);
    p.tonicMidi = f >= 1 ? fifth(this.season) : (f < 0.5 ? fifth(this.seasonFrom) : fifth(this.season));
    this.sounding = this.sounding.filter((e) => e > t);
    if (this.muted) return;
    const mode = MODES[p.mode];
    // kills pull the next chord change forward and voice it lower (a swell, no impact sound)
    if ((cam.kills ?? 0) > 0) { this.swell = 1; this.chordT = Math.min(this.chordT, t + 1.5); }
    if (t >= this.chordT) {
      const dr = this.rng.draw(this.draws++, 1);
      this.chord = nextChord(this.chord, dr);
      this.chordT = t + p.chordEveryS;
      const steps = chordSteps(this.chord, p.harmony);
      const pcs = steps.map((s) => ((stepToMidi(s, mode, p.tonicMidi) % 12) + 12) % 12);
      // darkness lowers the register; a kill's swell voices the next chord lower still
      const lo = 48 - Math.round(5 * D) - (this.swell > 0 ? 5 : 0);
      this.voices = voiceLead(this.voices, pcs, p.padVoices, lo, lo + 24);
      this.swell = 0;
      for (let i = 0; i < this.voices.length; i++) {
        this.emit({ t, kind: 'pad', midi: this.voices[i]!, gain: 0.05, dur: p.chordEveryS + 2, pan: (i / Math.max(1, this.voices.length - 1)) * 1.2 - 0.6 });
      }
      const droneMidi = p.tonicMidi - 12 - (p.droneOctaveDown ? 12 : 0);
      this.emit({ t, kind: 'drone', midi: droneMidi, gain: 0.08 * p.droneGain, dur: p.chordEveryS + 2, pan: 0 });
    }
    // giants: one thud per power stroke (phase wrap), at most one per 1.5 s
    for (const g of cam.giants ?? []) {
      const prev = this.lastPhase.get(g.id);
      this.lastPhase.set(g.id, g.phase);
      if (prev === undefined || g.phase >= prev) continue;
      if (t - this.lastThud < THUD_MIN_GAP_S) continue;
      this.lastThud = t;
      const hz = clamp(70 * g.sizeRel ** (-1 / 3), 30, 70);
      this.emit({ t, kind: 'thud', midi: 0, hz, gain: 0.25 * Math.sqrt(clamp(g.area, 0, 1)), dur: 0.8, pan: 0 });
    }
    if (this.lastPhase.size > 256) this.lastPhase.clear();
    // births on screen: a soft bell on a pentatonic subset of the chord, at most one per 4 s
    if ((cam.births ?? 0) > 0 && t - this.lastBell >= BELL_MIN_GAP_S && this.voices.length > 0) {
      this.lastBell = t;
      const dr = this.rng.draw(this.draws++, 2);
      const v = this.voices[dr.int(this.voices.length)]! + 24;
      this.emit({ t, kind: 'bell', midi: v, gain: 0.04, dur: 2.5, pan: dr.u01() - 0.5 });
    }
    // featured species: its leitmotif, once, softly, quantised to the current mode
    const fs = cam.featured ?? null;
    if (fs !== null && fs !== this.lastFeatured) {
      const m = this.motif(fs);
      for (let i = 0; i < m.length; i++) {
        this.emit({ t: t + i * 0.6, kind: 'motif', midi: stepToMidi(m[i]! + 14, mode, p.tonicMidi), gain: 0.035, dur: 1.2, pan: 0.2 });
      }
    }
    this.lastFeatured = fs;
  }

  /** Queue a note if the voice budget allows (one-shots may steal nothing: they wait). */
  private emit(n: NoteEvent): void {
    if (this.sounding.length >= MAX_VOICES) return;
    this.sounding.push(n.t + n.dur);
    this.out.push(n);
  }

  /** Voices sounding now (for the cap test). */
  get voiceCount(): number { return this.sounding.length; }
}
