/**
 * src/audio: generative Web Audio ambience (06 §6.3): drone, pads, giants' thuds, birth bells,
 * darkness after disasters, seasonal key, species leitmotifs. Off on the wallpaper and the
 * screensaver by default, on for TV (CONTRACT 15, William's Q10). See README.md and
 * docs/modules/audio.md.
 */
import { VIEW_PROFILES, type AudioModule, type SimEvent, type ViewMode } from '../core/index.js';
import { Composer, type CameraIn, type CensusIn, type Mood } from './composer.js';
import { AudioGraph, type ACtx } from './webaudio.js';

export { Composer, MAX_VOICES, type CameraIn, type CensusIn, type Mood, type NoteEvent, type Params } from './composer.js';
export { renderOffline, peakDb, rmsDb, centroid } from './offline.js';
export { modeWeights, modeFor, motifFor, mutateMotif, harmonyFor, voiceLead, MODES } from './theory.js';

/** Whether a view mode plays audio unless the user turns it on (CONTRACT 15). */
export function audioOnByDefault(mode: ViewMode): boolean { return VIEW_PROFILES[mode].audioDefault; }

/** The phase-0 stub, kept for views that never make sound. */
export class SilentAudio implements AudioModule {
  running = false;
  mood: Mood = { activity: 0, richness: 0, stress: 0, darkness: 0, season: 0 };
  async start(): Promise<void> { this.running = true; }
  stop(): void { this.running = false; }
  setMood(m: Mood): void { this.mood = { ...m }; }
}

/**
 * The ambience. `start()` creates the AudioContext (it must follow a user gesture or a host
 * autoplay flag); without Web Audio it stays silent. Feed it with `census`, `events` and `camera`
 * (adapter API, docs/contract-requests/audio.md); `setMood` is the contract's coarse input.
 */
export class Ambience implements AudioModule {
  readonly composer: Composer;
  private ctx: ACtx | null = null;
  private graph: AudioGraph | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cam: CameraIn = { depth01: 0.5, zoom01: 0.3 };
  private clock0 = 0;
  private lastWall = 0;
  running = false;

  constructor(seedLo = 1, private readonly makeCtx: (() => ACtx | null) | null = defaultCtx) {
    this.composer = new Composer(seedLo, 0);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.composer.muted = false;
    const ctx = this.makeCtx ? this.makeCtx() : null;
    if (!ctx) return; // no Web Audio here: stay silent, keep the composer's state
    this.ctx = ctx;
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* autoplay refused */ } }
    this.graph = new AudioGraph(ctx);
    this.graph.fadeIn();
    this.clock0 = ctx.currentTime - this.composer.time;
    this.lastWall = ctx.currentTime;
    this.timer = setInterval(() => this.tick(), 50);
  }

  stop(): void {
    this.running = false;
    this.composer.muted = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.graph) this.graph.fadeOut();
    const ctx = this.ctx;
    this.ctx = null;
    this.graph = null;
    if (ctx) setTimeout(() => { void ctx.close(); }, 1000);
  }

  setMood(m: Mood): void {
    this.composer.setDarkness(Math.max(m.darkness, m.stress * 0.5));
    this.composer.setSeason(Math.round(m.season) % 4);
  }

  census(c: CensusIn): void { this.composer.census(c); }
  events(evs: readonly SimEvent[]): void { this.composer.events(evs); }
  camera(cam: CameraIn): void {
    // births and kills are counts since the last tick: accumulate until the scheduler runs
    const b = (this.cam.births ?? 0) + (cam.births ?? 0);
    const k = (this.cam.kills ?? 0) + (cam.kills ?? 0);
    this.cam = { ...cam, births: b, kills: k };
  }

  private tick(): void {
    const ctx = this.ctx;
    const g = this.graph;
    if (!ctx || !g) return;
    const now = ctx.currentTime;
    const dt = Math.min(1, Math.max(0, now - this.lastWall));
    this.lastWall = now;
    this.composer.step(dt, this.cam);
    this.cam = { ...this.cam, births: 0, kills: 0 };
    g.follow(this.composer);
    const out = this.composer.out;
    for (const n of out) g.play(n, Math.max(now, this.clock0 + n.t) + 0.05, this.composer.p.droneDetuneCents);
    out.length = 0;
  }
}

function defaultCtx(): ACtx | null {
  const g = globalThis as unknown as { AudioContext?: new () => ACtx; webkitAudioContext?: new () => ACtx };
  const C = g.AudioContext ?? g.webkitAudioContext;
  return C ? new C() : null;
}

/** The module instance used by src/ui; ui starts it only when the profile (or the user) says so. */
export const audio: AudioModule = new Ambience();
