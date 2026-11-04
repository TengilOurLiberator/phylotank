/**
 * Wall-clock pacing for a sim loop (worker and host). This file is the only place in src/sim
 * that may read the clock or use timers; it is exempt from the determinism lint because it
 * decides only when ticks run, never what they compute (CONTRACT 4.2 rule 1).
 */
export interface PacerOptions {
  hz: number;
  /** Ticks to run per wake-up at most; beyond that the sim slows down instead of spiralling. */
  maxCatchUp?: number;
  onTicks: (n: number) => void;
}

export class Pacer {
  private t0 = 0;
  private done = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private speed = 1;
  /** Achieved ticks per wall second, smoothed. */
  achievedHz = 0;
  private lastStat = 0;
  private statTicks = 0;

  constructor(private readonly opts: PacerOptions) {}

  start(): void {
    if (this.timer) return;
    this.t0 = performance.now();
    this.done = 0;
    this.lastStat = this.t0;
    this.loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  setSpeed(s: number): void {
    this.t0 = performance.now();
    this.done = 0;
    this.speed = s;
  }

  private loop = (): void => {
    const now = performance.now();
    const rate = this.opts.hz * this.speed;
    const target = Math.floor(((now - this.t0) * rate) / 1000);
    let due = target - this.done;
    const cap = this.opts.maxCatchUp ?? 4;
    if (due > cap) {
      // fell behind: drop the backlog (the world runs slower, never faster than asked)
      this.done = target - cap;
      due = cap;
    }
    if (due > 0 && this.speed > 0) {
      this.opts.onTicks(due);
      this.done += due;
      this.statTicks += due;
    }
    if (now - this.lastStat >= 1000) {
      this.achievedHz = (this.statTicks * 1000) / (now - this.lastStat);
      this.statTicks = 0;
      this.lastStat = now;
    }
    const nextAt = this.t0 + ((this.done + 1) * 1000) / Math.max(rate, 1e-6);
    this.timer = setTimeout(this.loop, Math.max(1, nextAt - performance.now()));
  };
}
