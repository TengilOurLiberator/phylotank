/**
 * Wall-clock pacing for the host (REVIEW R17, R19). Ticks are paced by completion: each wake-up
 * runs every tick that is due, inside a time budget, then sleeps until the next one is due.
 * Backlog beyond one second is dropped (the world runs slower, never faster than asked) and
 * `max` runs as many ticks as the budget allows before yielding to I/O.
 */
export interface SchedulerOptions {
  hz: number;
  run: (n: number) => number;
  /** Longest a wake-up may spend ticking, so sockets and the HTTP server stay responsive. */
  budgetMs?: number;
  now?: () => number;
}

export class TickScheduler {
  private speed = 1;
  private max = false;
  private t0 = 0;
  private done = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  achievedHz = 0;
  private statT = 0;
  private statN = 0;
  /** Durations of recent wake-ups that ran ticks (ms), for the governor. */
  readonly recentTickMs: number[] = [];
  private readonly now: () => number;

  constructor(private readonly o: SchedulerOptions) { this.now = o.now ?? (() => performance.now()); }

  get speedValue(): number | 'max' { return this.max ? 'max' : this.speed; }

  setSpeed(s: number | 'max'): void {
    this.max = s === 'max';
    this.speed = s === 'max' ? 1 : Math.max(0, s);
    this.t0 = this.now();
    this.done = 0;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.t0 = this.now(); this.done = 0; this.statT = this.t0;
    this.wake();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private wake = (): void => {
    if (!this.running) return;
    const budget = this.o.budgetMs ?? 12;
    const start = this.now();
    let ran = 0;
    if (this.max) {
      while (this.now() - start < budget) { const n = this.o.run(1); ran += n; if (n === 0) break; }
    } else if (this.speed > 0) {
      const rate = this.o.hz * this.speed;
      const target = Math.floor(((start - this.t0) * rate) / 1000);
      let due = target - this.done;
      const cap = Math.max(1, Math.ceil(rate));
      if (due > cap) { this.done = target - cap; due = cap; }
      while (due > 0 && this.now() - start < budget) {
        const chunk = Math.min(due, 4);
        const n = this.o.run(chunk);
        ran += n; this.done += chunk; due -= chunk;
        if (n < chunk) break;
      }
    }
    const end = this.now();
    if (ran > 0) { this.recentTickMs.push((end - start) / ran); if (this.recentTickMs.length > 300) this.recentTickMs.shift(); }
    this.statN += ran;
    if (end - this.statT >= 1000) { this.achievedHz = (this.statN * 1000) / (end - this.statT); this.statN = 0; this.statT = end; }
    if (this.max) { this.timer = setTimeout(this.wake, 0); return; }
    const rate = this.o.hz * Math.max(this.speed, 1e-6);
    const nextAt = this.t0 + ((this.done + 1) * 1000) / rate;
    this.timer = setTimeout(this.wake, this.speed > 0 ? Math.max(1, Math.min(250, nextAt - this.now())) : 100);
  };
}
