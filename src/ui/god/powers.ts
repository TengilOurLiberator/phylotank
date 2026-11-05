/**
 * Powers as data (07 §3.4, DESIGN R26) and the casting state machine:
 *   idle -> armed (power picked) -> previewing (target set) -> [holding] -> sending -> countdown -> idle
 * Minor powers confirm with a click; major powers (core `isMajorPower`) need a 1.2 s hold or the
 * dialog-button alternative, and get an automatic `beforePower` snapshot (the host takes it; if a
 * result comes back without one, the client takes it itself before the fire tick). The lead is
 * 3 s for major and 1 s for minor (DESIGN R7); while paused the countdown waits for resume.
 * Esc cancels from every state before sending.
 */
import {
  CORE_POWERS, isMajorPower, LEAD_MAJOR_S, LEAD_MINOR_S,
  type CommandResult, type PowerId, type Target,
} from '../../core/index.js';
import type { MsgKey } from '../i18n.js';

export type Targeting = 'global' | 'depthBand' | 'circle' | 'point' | 'stroke' | 'species' | 'creature';
export interface PowerSpec {
  id: PowerId;
  targeting: Targeting;
  radius?: { min: number; max: number };
  /** Effect label key and its value at intensity i. */
  effect?: { key: MsgKey; value: (i: number) => number };
  duration?: { min: number; max: number; default: number };
  glyph: string;
}

const spec = (id: PowerId, targeting: Targeting, glyph: string, o: Partial<PowerSpec> = {}): PowerSpec => ({ id, targeting, glyph, ...o });

export const POWER_SPECS: Readonly<Record<string, PowerSpec>> = Object.fromEntries([
  spec('bloom', 'circle', '✿', { radius: { min: 1, max: 8 }, effect: { key: 'effect.bloom', value: (i) => Math.round(1 + 9 * i) }, duration: { min: 1200, max: 12000, default: 3600 } }),
  spec('vent', 'point', '♨', { effect: { key: 'effect.vent', value: (i) => Math.round(5 + 35 * i) } }),
  spec('coldSnap', 'global', '❄', { effect: { key: 'effect.coldSnap', value: (i) => -Math.round(2 + 13 * i) }, duration: { min: 300, max: 8400, default: 1800 } }),
  spec('heatwave', 'global', '☀', { effect: { key: 'effect.heatwave', value: (i) => Math.round(2 + 13 * i) }, duration: { min: 300, max: 8400, default: 1800 } }),
  spec('plague', 'species', '☣', { effect: { key: 'effect.plague', value: (i) => Math.round(i * 100) / 100 } }),
  spec('meteor', 'circle', '☄', { radius: { min: 1, max: 6 }, effect: { key: 'effect.meteor', value: (i) => Math.round((1 + 5 * i) * 10) / 10 } }),
  spec('currentShift', 'global', '≋', { effect: { key: 'effect.currentShift', value: (i) => Math.round((0.02 + 0.2 * i) * 100) / 100 }, duration: { min: 600, max: 36000, default: 3600 } }),
  spec('longNight', 'global', '☾', { effect: { key: 'effect.longNight', value: (i) => Math.round(50 - 50 * i) }, duration: { min: 1200, max: 16800, default: 2400 } }),
  spec('mutagen', 'circle', '✺', { radius: { min: 1, max: 6 }, effect: { key: 'effect.mutagen', value: (i) => Math.round(2 + 18 * i) }, duration: { min: 1200, max: 6000, default: 2400 } }),
  spec('cull', 'species', '✂', { effect: { key: 'effect.cull', value: (i) => Math.round(10 + 80 * i) } }),
  spec('bless', 'species', '✦', { effect: { key: 'effect.bless', value: (i) => Math.round(10 + 90 * i) } }),
  spec('nutrientFlood', 'circle', '⛆', { radius: { min: 2, max: 12 }, effect: { key: 'effect.nutrientFlood', value: (i) => Math.round(2 + 8 * i) }, duration: { min: 600, max: 6000, default: 1800 } }),
].map((s) => [s.id, s]));

export const PALETTE_POWERS: readonly PowerId[] = CORE_POWERS;
export const HOLD_MS = 1200;

export type CastState =
  | { s: 'idle' }
  | { s: 'armed'; power: PowerId }
  | { s: 'previewing'; power: PowerId; target: Target }
  | { s: 'holding'; power: PowerId; target: Target; since: number }
  | { s: 'sending'; power: PowerId; target: Target }
  | { s: 'countdown'; power: PowerId; leadS: number; startedAt: number; pausedFor: number; pauseStart: number | null; snapshotId?: string; cmdId: string };

export interface CastSender {
  cast(power: PowerId, target: Target, intensity: number, duration: number | undefined, seed: number): Promise<CommandResult>;
  snapshot(label: string): Promise<CommandResult>;
  paused(): boolean;
}

export class CastController {
  state: CastState = { s: 'idle' };
  intensity = 0.5;
  duration: number | undefined;
  message: { key: MsgKey; vars?: Record<string, string | number> } | null = null;
  private seed = 1;
  constructor(private readonly sender: CastSender, private readonly onChange: () => void = () => {}) {}

  get spec(): PowerSpec | null { return 'power' in this.state ? POWER_SPECS[this.state.power] ?? null : null; }
  get major(): boolean { return 'power' in this.state ? isMajorPower(this.state.power, this.intensity) : false; }

  pick(power: PowerId): void {
    const sp = POWER_SPECS[power];
    this.duration = sp?.duration?.default;
    this.message = null;
    if (sp?.targeting === 'global') this.state = { s: 'previewing', power, target: { kind: 'global' } };
    else this.state = { s: 'armed', power };
    this.onChange();
  }
  setIntensity(i: number): void { this.intensity = Math.max(0, Math.min(1, i)); this.onChange(); }
  radius(): number {
    const r = this.spec?.radius;
    return r ? r.min + (r.max - r.min) * this.intensity : 1 + 5 * this.intensity;
  }
  /** Set or move the target (from the viewport, minimap or form fields). */
  target(t: Target): void {
    if (this.state.s === 'armed' || this.state.s === 'previewing') { this.state = { s: 'previewing', power: this.state.power, target: t }; this.onChange(); }
  }
  /** Minor: casts now. Major: starts the hold. */
  confirmDown(now: number): void {
    if (this.state.s !== 'previewing') return;
    if (this.major) { this.state = { ...this.state, s: 'holding', since: now }; this.onChange(); }
    else void this.send();
  }
  /** Releasing early cancels the hold (back to previewing). */
  confirmUp(now: number): void {
    if (this.state.s !== 'holding') return;
    if (now - this.state.since >= HOLD_MS) void this.send();
    else { this.state = { s: 'previewing', power: this.state.power, target: this.state.target }; this.onChange(); }
  }
  holdProgress(now: number): number { return this.state.s === 'holding' ? Math.min(1, (now - this.state.since) / HOLD_MS) : 0; }
  /** Call every frame: completes a hold, advances the countdown. */
  update(now: number): void {
    if (this.state.s === 'holding' && now - this.state.since >= HOLD_MS) void this.send();
    if (this.state.s === 'countdown') {
      const st = this.state;
      const paused = this.sender.paused();
      if (paused && st.pauseStart === null) st.pauseStart = now;
      if (!paused && st.pauseStart !== null) { st.pausedFor += now - st.pauseStart; st.pauseStart = null; }
      if (this.countdownLeft(now) <= 0) { this.state = { s: 'idle' }; this.onChange(); }
    }
  }
  countdownLeft(now: number): number {
    if (this.state.s !== 'countdown') return 0;
    const st = this.state;
    const pausedFor = st.pausedFor + (st.pauseStart !== null ? now - st.pauseStart : 0);
    return Math.max(0, st.leadS - (now - st.startedAt - pausedFor) / 1000);
  }
  /** The accessible alternative to holding (07 §6.1 motor). */
  dialogConfirm(): void { if (this.state.s === 'previewing' || this.state.s === 'holding') void this.send(); }
  cancel(): void {
    if (this.state.s === 'sending' || this.state.s === 'countdown') return;
    this.state = { s: 'idle' }; this.message = null; this.onChange();
  }

  private async send(): Promise<void> {
    const st = this.state;
    if (st.s !== 'previewing' && st.s !== 'holding') return;
    const major = this.major;
    const power = st.power, target = st.target;
    this.state = { s: 'sending', power, target };
    this.onChange();
    const res = await this.sender.cast(power, target, this.intensity, this.duration, this.seed++);
    if (!res.ok) {
      this.message = res.reason === 'stale-epoch' ? { key: 'powers.stale' } : { key: 'powers.rejected', vars: { reason: res.reason ?? '?' } };
      this.state = { s: 'previewing', power, target };
      this.onChange();
      return;
    }
    let snapshotId = res.snapshotId;
    if (major && !snapshotId) {
      // an older host that does not snapshot: take it ourselves, well before the 3 s lead ends
      const snap = await this.sender.snapshot(`Before ${power}`);
      snapshotId = snap.snapshotId;
    }
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    this.state = { s: 'countdown', power, leadS: major ? LEAD_MAJOR_S : LEAD_MINOR_S, startedAt: now, pausedFor: 0, pauseStart: null, cmdId: res.id, ...(snapshotId ? { snapshotId } : {}) };
    this.message = snapshotId ? { key: 'powers.doneSnap', vars: { power, snap: `Before ${power}` } } : { key: 'powers.done', vars: { power } };
    this.onChange();
  }
}

/** Is a world point inside a target (preview counts)? */
export function inTarget(t: Target, x: number, y: number, species: number): boolean {
  switch (t.kind) {
    case 'global': return true;
    case 'point': return Math.hypot(x - t.pos[0], y - t.pos[1]) < 1.5;
    case 'circle': return Math.hypot(x - t.pos[0], y - t.pos[1]) < t.radius;
    case 'depthBand': return y >= t.y0 && y <= t.y1;
    case 'species': return t.species.includes(species);
    case 'stroke': return t.points.some((p) => Math.hypot(x - p[0], y - p[1]) < 1);
    case 'creature': return false;
  }
}
