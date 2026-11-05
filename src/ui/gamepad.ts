/**
 * Gamepad input (07 §6.2), W3C Gamepad API standard mapping. Polls `navigator.getGamepads()`
 * and turns button presses into edge events (with D-pad auto-repeat), and exposes the sticks
 * with a dead zone. Used by the TV overlay and the god window. Support in Google TV browsers
 * is unverified, so the TV view also maps the remote's keys (arrows, Enter, Back).
 */
export const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16 } as const;
export const DEAD_ZONE = 0.18;
const REPEAT_FIRST_MS = 400, REPEAT_MS = 140;
const DPAD: ReadonlySet<number> = new Set([PAD.UP, PAD.DOWN, PAD.LEFT, PAD.RIGHT]);

export interface PadState { lx: number; ly: number; rx: number; ry: number; lt: number; rt: number; id: string }
type PadSource = () => ArrayLike<Gamepad | null>;

export function deadZone(v: number): number { return Math.abs(v) < DEAD_ZONE ? 0 : (v - Math.sign(v) * DEAD_ZONE) / (1 - DEAD_ZONE); }

export class GamepadPoller {
  private down = new Map<number, number>();
  private last = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  state: PadState | null = null;
  /** The pad's id the first time one is seen (for a one-off "connected" toast). */
  onConnect: ((id: string) => void) | null = null;
  private seen = false;

  constructor(private readonly onPress: (button: number) => void, private readonly source: PadSource = () => (typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [])) {}

  start(everyMs = 33): void { if (!this.timer) this.timer = setInterval(() => this.poll(performance.now()), everyMs); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** One poll; exposed for tests. */
  poll(now: number): void {
    let pad: Gamepad | null = null;
    try { for (const p of Array.from(this.source())) if (p && p.connected) { pad = p; break; } } catch { pad = null; }
    if (!pad) { this.state = null; this.down.clear(); return; }
    if (!this.seen) { this.seen = true; this.onConnect?.(pad.id); }
    const ax = (i: number) => deadZone(pad!.axes[i] ?? 0);
    const btn = (i: number) => pad!.buttons[i];
    this.state = { lx: ax(0), ly: ax(1), rx: ax(2), ry: ax(3), lt: btn(PAD.LT)?.value ?? 0, rt: btn(PAD.RT)?.value ?? 0, id: pad.id };
    for (let i = 0; i < pad.buttons.length; i++) {
      const pressed = !!pad.buttons[i]?.pressed;
      const since = this.down.get(i);
      if (pressed && since === undefined) { this.down.set(i, now); this.onPress(i); }
      else if (pressed && since !== undefined && DPAD.has(i) && now - since > REPEAT_FIRST_MS) {
        if (now - this.last > REPEAT_MS) { this.last = now; this.onPress(i); }
      } else if (!pressed && since !== undefined) this.down.delete(i);
    }
  }
}

/** Focusable elements inside a container, in DOM order (for D-pad focus navigation). */
export function focusables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
}
/** Move focus by `dir` steps among the focusables of `root`, wrapping. Returns the new element. */
export function moveFocus(root: ParentNode, dir: 1 | -1): HTMLElement | null {
  const list = focusables(root);
  if (!list.length) return null;
  const i = list.indexOf(document.activeElement as HTMLElement);
  const next = list[(i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length)]!;
  next.focus();
  return next;
}
