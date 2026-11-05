/**
 * The Web Audio graph for the ambience (06 §6.3.1). No samples: soft PeriodicWave oscillators,
 * filtered noise, an FM bell and a generated reverb impulse. It plays the Composer's notes and
 * follows its parameters with setTargetAtTime (long time constants: music like weather).
 * Created only after start(), which the view calls after a user gesture or a host flag
 * (autoplay rules in browsers and WebView2).
 */
import type { CameraIn, Composer, NoteEvent } from './composer.js';
import { midiToHz } from './theory.js';

/* Minimal structural types so this file typechecks without the DOM library. */
interface AParam { value: number; setTargetAtTime(v: number, t: number, tc: number): void; setValueAtTime(v: number, t: number): void; linearRampToValueAtTime(v: number, t: number): void; exponentialRampToValueAtTime(v: number, t: number): void }
interface ANode { connect(n: ANode): ANode; disconnect(): void }
interface AGain extends ANode { gain: AParam }
interface AFilter extends ANode { type: string; frequency: AParam; Q: AParam }
interface AOsc extends ANode { frequency: AParam; detune: AParam; start(t: number): void; stop(t: number): void; setPeriodicWave(w: unknown): void; type: string }
interface APan extends ANode { pan: AParam }
interface AComp extends ANode { threshold: AParam; knee: AParam; ratio: AParam; attack: AParam; release: AParam }
interface AConv extends ANode { buffer: unknown }
interface ABuffer { getChannelData(c: number): Float32Array }
export interface ACtx {
  currentTime: number;
  sampleRate: number;
  destination: ANode;
  state: string;
  resume(): Promise<void>;
  close(): Promise<void>;
  createGain(): AGain;
  createBiquadFilter(): AFilter;
  createOscillator(): AOsc;
  createStereoPanner(): APan;
  createDynamicsCompressor(): AComp;
  createConvolver(): AConv;
  createBuffer(ch: number, len: number, rate: number): ABuffer;
  createPeriodicWave(re: Float32Array, im: Float32Array): unknown;
}

export class AudioGraph {
  private readonly master: AGain;
  private readonly depthLp: AFilter;
  private readonly padLp: AFilter;
  private readonly dry: AGain;
  private readonly wet: AGain;
  private readonly wave: unknown;

  constructor(readonly ctx: ACtx, seed = 1) {
    const c = ctx;
    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.003; limiter.release.value = 0.25;
    this.master = c.createGain();
    this.master.gain.value = 0;
    this.master.connect(limiter);
    limiter.connect(c.destination);
    this.depthLp = c.createBiquadFilter();
    this.depthLp.type = 'lowpass';
    this.depthLp.frequency.value = 4000;
    this.dry = c.createGain();
    this.wet = c.createGain();
    this.wet.gain.value = 0.3;
    const verb = c.createConvolver();
    verb.buffer = this.impulse(4, seed);
    this.depthLp.connect(this.dry);
    this.depthLp.connect(verb);
    verb.connect(this.wet);
    this.dry.connect(this.master);
    this.wet.connect(this.master);
    this.padLp = c.createBiquadFilter();
    this.padLp.type = 'lowpass';
    this.padLp.frequency.value = 800;
    this.padLp.connect(this.depthLp);
    // soft saw harmonics 1, 1/2, 1/3 ... 1/6 (the offline renderer uses the same)
    this.wave = c.createPeriodicWave(new Float32Array(7), new Float32Array([0, 1, 0.5, 0.33, 0.25, 0.2, 0.16]));
  }

  /** Decaying stereo noise, generated at start-up (a seeded LCG: no Math.random). */
  private impulse(seconds: number, seed: number): unknown {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(seconds * rate);
    const b = this.ctx.createBuffer(2, len, rate);
    let s = (seed * 2654435761) >>> 0;
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        d[i] = ((s / 4294967296) * 2 - 1) * Math.exp(-(3 * i) / len);
      }
    }
    return b;
  }

  fadeIn(): void { this.master.gain.setTargetAtTime(0.8, this.ctx.currentTime, 2); }
  fadeOut(): void { this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3); }

  /** Follow the composer's slow parameters. */
  follow(cmp: Composer): void {
    const t = this.ctx.currentTime;
    const p = cmp.p;
    this.depthLp.frequency.setTargetAtTime(p.masterLowpassHz, t, 3);
    this.padLp.frequency.setTargetAtTime(p.padCutoffHz, t, 8);
    this.wet.gain.setTargetAtTime(p.reverbWet, t, 10);
    this.dry.gain.setTargetAtTime(1 - p.reverbWet * 0.5, t, 10);
  }

  /** Play one note event at its time (relative to the composer's clock offset). */
  play(n: NoteEvent, at: number, droneDetuneCents: number): void {
    const c = this.ctx;
    const g = c.createGain();
    const pan = c.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, n.pan));
    g.connect(pan);
    const hz = n.hz ?? midiToHz(n.midi);
    const end = at + n.dur;
    g.gain.setValueAtTime(0, at);
    if (n.kind === 'thud') {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(hz * 1.6, at);
      o.frequency.exponentialRampToValueAtTime(hz, at + 0.25);
      const o2 = c.createOscillator();
      o2.type = 'sine';
      o2.frequency.setValueAtTime(hz * 2, at);
      const g2 = c.createGain(); g2.gain.value = 0.35;
      o.connect(g); o2.connect(g2); g2.connect(g);
      g.gain.linearRampToValueAtTime(n.gain, at + 0.02);
      g.gain.setTargetAtTime(0, at + 0.02, 0.25);
      pan.connect(this.depthLp);
      o.start(at); o2.start(at); o.stop(end); o2.stop(end);
      return;
    }
    if (n.kind === 'bell') {
      const car = c.createOscillator();
      const mod = c.createOscillator();
      const mg = c.createGain();
      car.frequency.value = hz; mod.frequency.value = hz * 3.5;
      mg.gain.setValueAtTime(hz * 1.2, at);
      mg.gain.setTargetAtTime(0, at, 0.3);
      mod.connect(mg); mg.connect(car.frequency as unknown as ANode);
      car.connect(g);
      g.gain.linearRampToValueAtTime(n.gain, at + 0.05);
      g.gain.setTargetAtTime(0, at + 0.05, 0.8);
      pan.connect(this.depthLp);
      car.start(at); mod.start(at); car.stop(end); mod.stop(end);
      return;
    }
    // pads, drone, motif: two detuned soft oscillators
    const att = n.kind === 'motif' ? 0.08 : 2;
    for (const det of [0, n.kind === 'drone' ? droneDetuneCents : 5]) {
      const o = c.createOscillator();
      o.setPeriodicWave(this.wave);
      o.frequency.value = hz;
      o.detune.value = det;
      o.connect(g);
      o.start(at); o.stop(end + 0.1);
    }
    g.gain.linearRampToValueAtTime(n.gain, at + att);
    g.gain.setTargetAtTime(0, Math.max(at + att, end - 2), 0.6);
    pan.connect(n.kind === 'pad' ? this.padLp : this.depthLp);
  }
}
