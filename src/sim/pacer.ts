/**
 * Wall-clock pacing for a sim loop (worker and host). This file is the only place in src/sim
 * that may read the clock or use timers; it is exempt from the determinism lint because it
 * decides only when ticks run, never what they compute (CONTRACT 4.2 rule 1).
 *
 * Speeds (CONTRACT 13 `speed`, DESIGN R29): pause, 0.25x, 1x, 4x, 16x and max. Anything above
 * 1x needs a lease (William's Q2: "never fast-forward silently"):
 * - an attended lease lasts while a god window is attached (`setAttended(true)`) and lapses to
 *   1x when the last one detaches;
 * - an unattended lease (the overnight "run at max until ...") must carry an `until` (a tick or
 *   a wall time) and lapses to 1x when it is reached.
 * Every change of the effective speed calls `onStatus` with a reason, and the session
 * publishes the status to every view (CENSUS `env.speed`, STATS `pacer`), so a fast-forward
 * is always visible.
 */
export type SpeedSetting = 0 | 0.25 | 1 | 4 | 16 | 'max';
export const SPEEDS: readonly SpeedSetting[] = [0, 0.25, 1, 4, 16, 'max'];

export interface Lease {
  speed: SpeedSetting;
  untilTick?: number;
  untilWallMs?: number;
  unattended: boolean;
  grantedWallMs: number;
}

export interface PacerStatus {
  /** Speed in force now. */
  speed: SpeedSetting;
  /** True whenever the world runs faster than 1x. */
  fastForward: boolean;
  /** Achieved ticks per wall second (smoothed) and as a multiple of 1x. */
  achievedHz: number;
  achievedX: number;
  lease: Lease | null;
  /** Why the speed last changed: 'start', 'command', 'lease-tick', 'lease-wall', 'detached'. */
  reason: string;
}

export interface PacerClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
}

const realClock: PacerClock = {
  now: () => performance.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface PacerOptions {
  hz: number;
  /** Ticks to run per wake-up at most at fixed speeds; beyond that the sim slows instead of spiralling. */
  maxCatchUp?: number;
  /** Fraction of wall time 'max' may use (a duty cap, so the host stays responsive). Default 0.8. */
  maxDuty?: number;
  onTicks: (n: number) => void;
  /** Current sim tick, for tick-bounded leases. */
  currentTick?: () => number;
  onStatus?: (s: PacerStatus) => void;
  clock?: PacerClock;
}

export interface SpeedRequest {
  speed: SpeedSetting;
  untilTick?: number;
  /** Lease end on this pacer's clock (ms). */
  untilWallMs?: number;
  /** Lease end as an ISO date (the `speed` command's `until.wallIso`), converted here. */
  untilWallIso?: string;
  unattended?: boolean;
}

export class Pacer {
  private readonly clock: PacerClock;
  private t0 = 0;
  private done = 0;
  private timer: unknown = null;
  private active = false;
  private speed: SpeedSetting = 1;
  private lease: Lease | null = null;
  private attended = 0;
  private reason = 'start';
  /** Achieved ticks per wall second, smoothed over about 1 s. */
  achievedHz = 0;
  private lastStat = 0;
  private statTicks = 0;

  constructor(private readonly opts: PacerOptions) {
    this.clock = opts.clock ?? realClock;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.t0 = this.clock.now();
    this.done = 0;
    this.lastStat = this.t0;
    this.emit('start');
    this.loop();
  }

  stop(): void {
    this.active = false;
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.timer = null;
  }

  get running(): boolean { return this.active; }

  /** Direct setter for pause, 0.25x and 1x (no lease needed); faster speeds go through `request`. */
  setSpeed(s: number): void {
    if (s !== 0 && s !== 0.25 && s !== 1) throw new Error(`setSpeed(${s}): use request() for fast-forward`);
    this.request({ speed: s });
  }

  /**
   * Ask for a speed. Above 1x the request needs either an attached god window or
   * `unattended` with an `until`. Returns a refusal reason, or null when granted.
   */
  request(r: SpeedRequest): string | null {
    if (!SPEEDS.includes(r.speed)) return 'bad-speed';
    if (r.untilWallIso !== undefined) {
      const at = Date.parse(r.untilWallIso);
      if (!Number.isFinite(at)) return 'bad-until';
      r = { ...r, untilWallMs: this.clock.now() + (at - Date.now()) };
    }
    const fast = r.speed === 'max' || r.speed > 1;
    if (fast) {
      const hasUntil = r.untilTick !== undefined || r.untilWallMs !== undefined;
      if (r.unattended && !hasUntil) return 'unattended-needs-until';
      if (!r.unattended && this.attended === 0) return 'needs-attended-window';
      this.lease = { speed: r.speed, unattended: !!r.unattended, grantedWallMs: this.clock.now() };
      if (r.untilTick !== undefined) this.lease.untilTick = r.untilTick;
      if (r.untilWallMs !== undefined) this.lease.untilWallMs = r.untilWallMs;
    } else {
      this.lease = null;
    }
    this.apply(r.speed, 'command');
    return null;
  }

  /** A god window attached (true) or detached (false). Attended leases lapse when none is left. */
  setAttended(on: boolean): void {
    this.attended = Math.max(0, this.attended + (on ? 1 : -1));
    if (this.attended === 0 && this.lease && !this.lease.unattended) this.lapse('detached');
  }

  status(): PacerStatus {
    return {
      speed: this.speed, fastForward: this.speed === 'max' || this.speed > 1, achievedHz: this.achievedHz,
      achievedX: this.achievedHz / this.opts.hz, lease: this.lease ? { ...this.lease } : null, reason: this.reason,
    };
  }

  private apply(s: SpeedSetting, reason: string): void {
    this.speed = s;
    this.t0 = this.clock.now();
    this.done = 0;
    this.emit(reason);
  }

  private lapse(reason: string): void {
    this.lease = null;
    this.apply(1, reason);
  }

  private emit(reason: string): void {
    this.reason = reason;
    this.opts.onStatus?.(this.status());
  }

  private checkLease(now: number): void {
    const l = this.lease;
    if (!l) return;
    if (l.untilTick !== undefined && this.opts.currentTick && this.opts.currentTick() >= l.untilTick) this.lapse('lease-tick');
    else if (l.untilWallMs !== undefined && now >= l.untilWallMs) this.lapse('lease-wall');
  }

  /** Run up to n ticks, stopping at a tick-bounded lease's end. */
  private run(n: number): number {
    const l = this.lease;
    if (l?.untilTick !== undefined && this.opts.currentTick) n = Math.max(0, Math.min(n, l.untilTick - this.opts.currentTick()));
    if (n > 0) this.opts.onTicks(n);
    return n;
  }

  /** One wake-up; public so tests can drive the pacer with a fake clock. */
  readonly loop = (): void => {
    if (!this.active) return;
    const now = this.clock.now();
    this.checkLease(now);
    let ran = 0;
    let nextMs: number;
    if (this.speed === 'max') {
      // bursts within a duty cap: run until maxDuty of a 20 ms window is used
      const budget = 20 * (this.opts.maxDuty ?? 0.8);
      const start = this.clock.now();
      while (this.speed === 'max' && this.clock.now() - start < budget) {
        const n = this.run(4);
        ran += n;
        if (n === 0) { this.checkLease(this.clock.now()); break; }
        this.checkLease(this.clock.now());
      }
      nextMs = Math.max(1, 20 - (this.clock.now() - start));
    } else {
      const rate = this.opts.hz * this.speed;
      const target = Math.floor(((now - this.t0) * rate) / 1000);
      let due = target - this.done;
      const cap = this.opts.maxCatchUp ?? 4;
      if (due > cap) {
        // fell behind: drop the backlog (the world runs slower, never faster than asked)
        this.done = target - cap;
        due = cap;
      }
      if (due > 0 && this.speed > 0) { ran = this.run(due); this.done += due; }
      const nextAt = this.t0 + ((this.done + 1) * 1000) / Math.max(rate, 1e-6);
      nextMs = this.speed === 0 ? 100 : Math.max(1, nextAt - this.clock.now());
    }
    this.statTicks += ran;
    const t = this.clock.now();
    if (t - this.lastStat >= 1000) {
      this.achievedHz = (this.statTicks * 1000) / (t - this.lastStat);
      this.statTicks = 0;
      this.lastStat = t;
    }
    this.timer = this.active ? this.clock.setTimer(this.loop, nextMs) : null;
  };
}
