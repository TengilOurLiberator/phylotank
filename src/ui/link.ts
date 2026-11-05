/**
 * HostFirstLink (DESIGN R31, 07 §4.1): the wallpaper tries the host first; if no frame arrives
 * within 2 s it runs the in-page dream tank, and keeps probing the host with backoff (0.5, 1, 2,
 * 4, then 10 s). When the host answers it switches back. The page never shows an error: the
 * renderer just keeps drawing whatever stream it has. HELLO is replayed on every new link.
 */
import { FRAME, readHeader, type SimLink } from '../core/index.js';

export const HOST_TIMEOUT_MS = 2000;
export const SILENT_MS = 5000;
export const BACKOFF_MS = [500, 1000, 2000, 4000, 10_000] as const;

export interface LinkFactory { socket(url: string): SimLink; worker(): SimLink }

export class HostFirstLink implements SimLink {
  private cur: SimLink;
  private probe: SimLink | null = null;
  private cb: ((f: Uint8Array) => void) | null = null;
  private hello: Uint8Array | null = null;
  private attempt = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private closed = false;
  /** Switches so far, for diagnostics (`?debug=1`, the god window's view list). */
  readonly switches: ('worker' | 'socket')[] = [];

  constructor(private readonly hostUrl: string, private readonly make: LinkFactory, private readonly timeoutMs = HOST_TIMEOUT_MS) {
    this.cur = make.socket(hostUrl);
    let heard = false;
    this.cur.onFrame((f) => { heard = true; this.lastFrame = Date.now(); this.cb?.(f); });
    this.later(() => { if (!heard && !this.closed) this.toWorker(); }, timeoutMs);
    // a host that goes silent after answering: fall back again
    if (typeof setInterval !== 'undefined') this.watch = setInterval(() => {
      if (!this.closed && this.cur.kind === 'socket' && this.lastFrame > 0 && Date.now() - this.lastFrame > SILENT_MS) this.toWorker();
    }, 1000);
  }
  private lastFrame = 0;
  private watch: ReturnType<typeof setInterval> | null = null;

  get kind(): 'worker' | 'socket' { return this.cur.kind; }

  onFrame(cb: (f: Uint8Array) => void): void { this.cb = cb; }

  send(frame: Uint8Array): void {
    try { if (readHeader(frame).type === FRAME.HELLO) this.hello = frame.slice(); } catch { /* not a frame */ }
    this.cur.send(frame);
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    if (this.watch) clearInterval(this.watch);
    this.probe?.close();
    this.cur.close();
  }

  private later(fn: () => void, ms: number): void { this.timers.push(setTimeout(fn, ms)); }

  private toWorker(): void {
    this.lastFrame = 0;
    this.cur.close();
    this.cur = this.make.worker();
    this.cur.onFrame((f) => this.cb?.(f));
    if (this.hello) this.cur.send(this.hello);
    this.switches.push('worker');
    this.scheduleProbe();
  }

  private scheduleProbe(): void {
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    this.later(() => this.runProbe(), wait);
  }

  private runProbe(): void {
    if (this.closed) return;
    const p = this.make.socket(this.hostUrl);
    this.probe = p;
    let answered = false;
    p.onFrame((f) => {
      if (this.closed) return;
      this.lastFrame = Date.now();
      if (!answered) {
        answered = true;
        // the host is back: hand over (the renderer keeps its interpolation per slot)
        this.cur.close();
        this.cur = p;
        this.probe = null;
        this.attempt = 0;
        this.switches.push('socket');
      }
      this.cb?.(f);
    });
    if (this.hello) p.send(this.hello);
    this.later(() => { if (!answered && !this.closed) { p.close(); this.probe = null; this.scheduleProbe(); } }, this.timeoutMs);
  }
}
