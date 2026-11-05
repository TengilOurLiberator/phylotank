/**
 * TV view overlay (07 §4.3): captions as on the screensaver, plus a card that appears on any
 * remote or gamepad press. The card controls only this TV's camera and audio, never the world:
 *   [Director] [Follow] [Next event >] [Zoom in] [Zoom out]
 *   [Captions: on] [Sound: 6] [Back]
 * State: Hidden -> Shown(focus) -> Hidden after 8 s without input or on Back. Remote: arrows
 * move focus, Enter is OK, Back may arrive as Escape, Backspace or GoBack (all mapped). Gamepad
 * (standard mapping): left stick pans (takes the camera from the director), right stick Y or
 * LT/RT zoom, A opens and confirms, B hides, X toggles captions, Y toggles Director and Follow,
 * LB/RB jump to the previous or next event, D-pad moves focus. Sizes are for 10-foot viewing:
 * text at least 28 px at 1080p, everything inside a 5% title-safe margin.
 */
import { decodeBodyEnter, decodeCborFrame, decodeDust, FRAME, readHeader, ByteReader, HEADER_BYTES, type Camera, type DustFrame, type SimEvent } from '../core/index.js';
import { h, mount } from './dom.js';
import { fmtLength, t } from './i18n.js';
import { zoneKey } from './captions.js';
import { GamepadPoller, PAD } from './gamepad.js';

export const TV_HIDE_MS = 8000;
export type TvMode = 'director' | 'manual' | 'follow';
const BACK_KEYS = new Set(['Escape', 'Backspace', 'GoBack', 'BrowserBack', 'XF86Back']);

const TV_CSS = `
.tv-overlay{position:fixed;left:5vw;right:5vw;bottom:calc(5vh + 12vh);display:flex;justify-content:center;z-index:30;pointer-events:none}
.tv-card{pointer-events:auto;background:rgba(4,10,14,.88);border:2px solid rgba(140,210,225,.45);border-radius:18px;padding:2.2vh 2.6vw;max-width:90vw;
  font:400 max(28px,2.6vh)/1.3 system-ui,"Segoe UI",sans-serif;color:#e8f4f7;box-shadow:0 1vh 6vh rgba(0,0,0,.6)}
.tv-card h2{margin:0;font-size:max(22px,2vh);font-weight:500;color:#a9cbd4;letter-spacing:.04em;text-transform:uppercase}
.tv-card .now{margin:.4vh 0 1.6vh;font-size:max(30px,2.9vh)}
.tv-card .row{display:flex;gap:1vw;flex-wrap:wrap;margin-top:1vh}
.tv-card button{font:inherit;font-size:max(28px,2.5vh);color:#e8f4f7;background:rgba(98,210,232,.1);border:2px solid rgba(140,210,225,.4);border-radius:12px;
  padding:.9vh 1.4vw;min-height:max(64px,6vh);cursor:pointer}
.tv-card button[aria-pressed=true]{background:rgba(98,210,232,.3);border-color:#7fe3f5}
.tv-card button:focus,.tv-card button:focus-visible{outline:4px solid #ffd77a;outline-offset:3px;background:rgba(255,215,122,.16)}
.tv-mode{position:fixed;right:5vw;top:5vh;font:400 max(22px,2vh) system-ui,sans-serif;color:rgba(255,255,255,.75);background:rgba(0,0,0,.4);padding:.6vh 1vw;border-radius:10px;z-index:29}
@media (prefers-reduced-motion:reduce){.tv-card,.tv-card *{transition:none!important}}
`;

export interface TvHost {
  tank(): { w: number; h: number };
  speciesName(id: number): string;
  viewSize(): { w: number; h: number };
  setSound(level: number): void;
}

export class TvOverlay {
  mode: TvMode = 'director';
  captionsOn = true;
  sound = 6;
  shown = false;
  readonly el: HTMLDivElement;
  private card: HTMLDivElement;
  private now: HTMLDivElement;
  readonly modeEl: HTMLDivElement;
  private buttons: HTMLButtonElement[][] = [];
  private hideAt = 0;
  private cam: Camera | null = null;
  private auto: Camera = { cx: 16, cy: 9, zeta: 5 };
  private dust: DustFrame | null = null;
  private slots = new Map<number, { id: number; species: number; log2Length: number }>();
  private events: SimEvent[] = [];
  private evCursor = -1;
  private followSlot = -1;
  readonly pad: GamepadPoller;
  private lastPadFrame = 0;

  constructor(root: HTMLElement, private readonly host: TvHost, private readonly clock: () => number = () => performance.now()) {
    root.appendChild(h('style', null, TV_CSS));
    this.now = h('div', { class: 'now' });
    this.card = h('div', { class: 'tv-card', role: 'dialog', 'aria-label': t('tv.menu') });
    this.el = h('div', { class: 'tv-overlay', style: 'display:none' }, this.card);
    this.modeEl = h('div', { class: 'tv-mode', 'aria-live': 'polite', style: 'display:none' });
    root.append(this.el, this.modeEl);
    this.build();
    window.addEventListener('keydown', (e) => this.key(e));
    this.pad = new GamepadPoller((b) => this.button(b));
    this.pad.start();
  }

  private build(): void {
    const btn = (label: string, on: () => void, pressed?: boolean) => h('button', { ...(pressed !== undefined ? { 'aria-pressed': String(pressed) } : {}), onclick: () => { on(); this.touch(); this.build(); this.refocus(label); } }, label);
    this.buttons = [
      [btn(t('tv.director'), () => this.setMode('director'), this.mode === 'director'), btn(t('tv.follow'), () => this.setMode('follow'), this.mode === 'follow'),
        btn(`${t('tv.nextEvent')} ›`, () => this.nextEvent(1)), btn(`${t('tv.zoomIn')} +`, () => this.zoom(1.25)), btn(`${t('tv.zoomOut')} −`, () => this.zoom(0.8))],
      [btn(t('tv.captions', { state: this.captionsOn ? t('tv.on') : t('tv.off') }), () => { this.captionsOn = !this.captionsOn; }, this.captionsOn),
        btn(t('tv.sound', { v: this.sound }), () => { this.sound = (this.sound + 2) % 12; this.host.setSound(this.sound); }),
        btn(t('tv.back'), () => this.hide())],
    ];
    mount(this.card, h('h2', null, t('tv.nowWatching')), this.now, ...this.buttons.map((r) => h('div', { class: 'row' }, ...r)));
    this.updateNow();
  }
  private refocus(label: string): void {
    if (!this.shown) return;
    const all = this.buttons.flat();
    const b = all.find((x) => x.textContent === label) ?? all.find((x) => (x.textContent ?? '').split(':')[0] === label.split(':')[0]);
    b?.focus();
  }

  ingest(f: Uint8Array): void {
    try {
      const hd = readHeader(f);
      if (hd.type === FRAME.DUST_FRAME) this.dust = decodeDust(f, this.dust ?? undefined);
      else if (hd.type === FRAME.BODY_ENTER) for (const e of decodeBodyEnter(f)) this.slots.set(e.slot, { id: e.id, species: e.species, log2Length: e.log2Length });
      else if (hd.type === FRAME.BODY_LEAVE) { const r = new ByteReader(f, HEADER_BYTES); const n = r.u16(); for (let i = 0; i < n; i++) this.slots.delete(r.u16()); }
      else if (hd.type === FRAME.EVENT) {
        const evs = decodeCborFrame(f).payload as unknown as SimEvent[];
        for (const e of Array.isArray(evs) ? evs : []) if ('pos' in e || 'centroid' in e) this.events.push(e);
        if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
      } else if (hd.type === FRAME.WELCOME) { this.followSlot = -1; this.events = []; this.slots.clear(); }
    } catch { /* a malformed frame never breaks the view */ }
  }

  // ---------------- input ----------------
  touch(): void { this.hideAt = this.clock() + TV_HIDE_MS; }
  show(): void {
    if (!this.shown) { this.shown = true; this.el.style.display = ''; this.build(); this.buttons[0]![0]!.focus(); }
    this.touch();
  }
  hide(): void { this.shown = false; this.el.style.display = 'none'; (document.activeElement as HTMLElement | null)?.blur?.(); }

  private key(e: KeyboardEvent): void {
    if (BACK_KEYS.has(e.key)) { e.preventDefault(); if (this.shown) this.hide(); return; }
    if (!this.shown) { e.preventDefault(); this.show(); return; }
    this.touch();
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); this.nav(0, 1); break;
      case 'ArrowLeft': e.preventDefault(); this.nav(0, -1); break;
      case 'ArrowDown': e.preventDefault(); this.nav(1, 0); break;
      case 'ArrowUp': e.preventDefault(); this.nav(-1, 0); break;
      default: break; // Enter and Space reach the focused button natively
    }
  }
  /** D-pad focus navigation: left/right walk every control (wrapping across rows), up/down change row. */
  nav(dRow: number, dCol: number): void {
    const all = this.buttons.flat();
    const cur = all.indexOf(document.activeElement as HTMLButtonElement);
    if (cur < 0) { all[0]?.focus(); return; }
    if (dCol) { all[(cur + dCol + all.length) % all.length]!.focus(); return; }
    let r = 0, c = cur;
    while (c >= this.buttons[r]!.length) { c -= this.buttons[r]!.length; r++; }
    const nr = Math.max(0, Math.min(this.buttons.length - 1, r + dRow));
    this.buttons[nr]![Math.min(c, this.buttons[nr]!.length - 1)]!.focus();
  }
  private button(b: number): void {
    if (!this.shown && b !== PAD.X && b !== PAD.Y && b !== PAD.LB && b !== PAD.RB) { this.show(); return; }
    this.touch();
    switch (b) {
      case PAD.A: (document.activeElement as HTMLElement | null)?.click(); break;
      case PAD.B: this.hide(); break;
      case PAD.X: this.captionsOn = !this.captionsOn; this.build(); break;
      case PAD.Y: this.setMode(this.mode === 'director' ? 'follow' : 'director'); this.build(); break;
      case PAD.LB: this.nextEvent(-1); break;
      case PAD.RB: this.nextEvent(1); break;
      case PAD.RIGHT: this.nav(0, 1); break;
      case PAD.LEFT: this.nav(0, -1); break;
      case PAD.DOWN: this.nav(1, 0); break;
      case PAD.UP: this.nav(-1, 0); break;
      default: break;
    }
  }

  // ---------------- camera ----------------
  setMode(m: TvMode): void {
    if (m === 'follow') this.followSlot = this.slotNear(this.current());
    if (m === 'manual' && !this.cam) this.cam = { ...this.auto };
    if (m !== 'manual') this.cam = null;
    this.mode = m === 'follow' && this.followSlot < 0 ? 'director' : m;
    this.modeEl.style.display = this.mode === 'director' ? 'none' : '';
    this.modeEl.textContent = t(this.mode === 'follow' ? 'tv.mode.follow' : 'tv.mode.manual');
  }
  private current(): Camera { return this.cam ?? this.auto; }
  private zoom(f: number): void {
    if (this.mode !== 'manual' && this.mode !== 'follow') this.setMode('manual');
    const c = this.cam ?? { ...this.auto };
    c.zeta = Math.max(2, Math.min(12, c.zeta + Math.log2(f)));
    this.cam = c;
    if (this.mode === 'follow') this.followZeta = c.zeta;
  }
  private followZeta: number | null = null;
  nextEvent(dir: 1 | -1): void {
    if (!this.events.length) return;
    this.evCursor = Math.max(0, Math.min(this.events.length - 1, (this.evCursor < 0 ? this.events.length : this.evCursor) + dir));
    const e = this.events[this.evCursor]! as SimEvent & { pos?: [number, number]; centroid?: [number, number] };
    const p = e.pos ?? e.centroid;
    if (!p) return;
    this.setMode('manual');
    const view = this.host.viewSize();
    this.cam = { cx: p[0], cy: p[1], zeta: Math.log2(view.w / 10) };
  }
  private posOf(slot: number): [number, number] | null {
    const d = this.dust;
    if (!d || slot < 0 || slot >= d.n || d.colour[slot] === 255) return null;
    const [x0, y0, x1, y1] = d.rect;
    return [x0 + (d.x[slot]! / 65535) * (x1 - x0), y0 + (d.y[slot]! / 65535) * (y1 - y0)];
  }
  private slotNear(c: Camera): number {
    const d = this.dust;
    if (!d) return -1;
    let best = -1, bd = Infinity;
    for (let s = 0; s < d.n; s++) {
      const p = this.posOf(s);
      if (!p) continue;
      const dd = (p[0] - c.cx) ** 2 + (p[1] - c.cy) ** 2;
      if (dd < bd) { bd = dd; best = s; }
    }
    return best;
  }

  /** Per frame: take the director's camera, apply the TV's own controls, return what to draw. */
  camera(auto: Camera, dtS: number): Camera {
    this.auto = auto;
    const now = this.clock();
    if (this.shown && now > this.hideAt) this.hide();
    const ps = this.pad.state;
    if (ps && (ps.lx || ps.ly || ps.ry || ps.lt || ps.rt)) {
      if (ps.lx || ps.ly) { if (this.mode !== 'manual') this.setMode('manual'); }
      const c = this.cam ?? { ...auto };
      const ppm = 2 ** c.zeta;
      const speed = (this.host.viewSize().w / ppm) * 0.5; // half a screen per second at full tilt
      c.cx += ps.lx * speed * dtS; c.cy += ps.ly * speed * dtS;
      const z = -ps.ry + ps.rt - ps.lt;
      if (z) c.zeta = Math.max(2, Math.min(12, c.zeta + z * 1.2 * dtS));
      if (this.mode === 'manual' || z) this.cam = c;
      if (this.mode === 'follow' && z) this.followZeta = c.zeta;
      this.lastPadFrame = now;
    }
    let out: Camera = auto;
    if (this.mode === 'manual' && this.cam) out = this.cam;
    else if (this.mode === 'follow') {
      const p = this.posOf(this.followSlot);
      if (!p) { this.setMode('director'); return auto; }
      const view = this.host.viewSize();
      const target: Camera = { cx: p[0], cy: p[1], zeta: this.followZeta ?? Math.log2(view.w / 6) };
      const prev = this.cam ?? auto;
      const k = Math.min(1, dtS * 2.5);
      this.cam = { cx: prev.cx + (target.cx - prev.cx) * k, cy: prev.cy + (target.cy - prev.cy) * k, zeta: prev.zeta + (target.zeta - prev.zeta) * k };
      out = this.cam;
    }
    if (this.shown && now % 1000 < 40) this.updateNow();
    return out;
  }

  /** "Now watching": the followed creature, or what is in view. */
  private updateNow(): void {
    const tank = this.host.tank();
    if (this.mode === 'follow' && this.followSlot >= 0) {
      const info = this.slots.get(this.followSlot);
      if (info) { mount(this.now, h('i', null, this.host.speciesName(info.species)), `, ${fmtLength(2 ** info.log2Length)}`); return; }
    }
    const c = this.current(), view = this.host.viewSize(), ppm = 2 ** c.zeta;
    const hw = view.w / (2 * ppm), hh = view.h / (2 * ppm);
    const counts = new Map<number, number>();
    let n = 0;
    const d = this.dust;
    if (d) for (let s = 0; s < d.n; s++) {
      const p = this.posOf(s);
      if (!p || Math.abs(p[0] - c.cx) > hw || Math.abs(p[1] - c.cy) > hh) continue;
      n++;
      const sp = this.slots.get(s)?.species;
      if (sp !== undefined) counts.set(sp, (counts.get(sp) ?? 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const whole = hw * 2 >= tank.w * 0.9;
    const zone = t(zoneKey(c.cy, tank.h));
    if (whole) { mount(this.now, t('tv.tank', { n })); return; }
    if (!top) { mount(this.now, t('a11y.empty', { zone })); return; }
    // the species name is a slot rendered in italics, never concatenated into the sentence
    const parts = t('a11y.view', { zone, n, species: '\u0000' }).split('\u0000');
    mount(this.now, ...parts.flatMap((p, i) => (i === 0 ? [p] : [h('i', null, this.host.speciesName(top[0])), p])));
  }
}
