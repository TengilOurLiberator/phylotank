/**
 * Captions for the screensaver and TV (CONTRACT 15, DESIGN R30, 07 §4.2): one lower-third line,
 * a 1 s fade in, the profile's hold (5 s screensaver, 6 s TV), a 1.5 s fade out, and at least
 * the profile's gap between caption starts (45 s screensaver, 25 s TV). Highest priority wins.
 * The wallpaper never gets captions: its profile has none and no caption element is created.
 */
import { BASE_INTEREST, type SimEvent, type ViewProfile } from '../core/index.js';
import { h } from './dom.js';
import { t, tk, type MsgKey } from './i18n.js';

export interface CaptionOffer { text: string; species?: string; priority: number; at: number }
export interface CaptionShown { text: string; species?: string; alpha: number }

export const FADE_IN_S = 1;
export const FADE_OUT_S = 1.5;
/** An offer older than this is stale and dropped (the scene it described has moved on). */
export const OFFER_TTL_S = 10;

export class CaptionScheduler {
  private pending: CaptionOffer[] = [];
  private showing: (CaptionOffer & { start: number }) | null = null;
  private lastStart = -Infinity;
  /** Every caption started, for tests and diagnostics. */
  readonly history: { text: string; start: number }[] = [];

  constructor(readonly holdS: number, readonly minGapS: number) {}

  offer(o: CaptionOffer): void {
    this.pending.push(o);
    if (this.pending.length > 32) {
      this.pending.sort((a, b) => b.priority - a.priority || b.at - a.at);
      this.pending.length = 32;
    }
  }

  /** Advance to `nowS` (wall seconds) and return what to draw, if anything. */
  update(nowS: number): CaptionShown | null {
    this.pending = this.pending.filter((p) => nowS - p.at <= OFFER_TTL_S);
    const total = FADE_IN_S + this.holdS + FADE_OUT_S;
    if (this.showing && nowS - this.showing.start >= total) this.showing = null;
    if (!this.showing && this.pending.length > 0 && nowS - this.lastStart >= this.minGapS) {
      let best = 0;
      for (let i = 1; i < this.pending.length; i++) {
        const a = this.pending[i]!, b = this.pending[best]!;
        if (a.priority > b.priority || (a.priority === b.priority && a.at > b.at)) best = i;
      }
      const o = this.pending.splice(best, 1)[0]!;
      this.showing = { ...o, start: nowS };
      this.lastStart = nowS;
      this.history.push({ text: o.text, start: nowS });
      this.pending = [];
    }
    if (!this.showing) return null;
    const dt = nowS - this.showing.start;
    const alpha = dt < FADE_IN_S ? dt / FADE_IN_S : dt < FADE_IN_S + this.holdS ? 1 : Math.max(0, 1 - (dt - FADE_IN_S - this.holdS) / FADE_OUT_S);
    return { text: this.showing.text, ...(this.showing.species ? { species: this.showing.species } : {}), alpha };
  }
}

export function zoneKey(y: number, tankH: number): MsgKey {
  const f = y / Math.max(1e-9, tankH);
  return f < 0.33 ? 'zone.photic' : f < 0.66 ? 'zone.twilight' : 'zone.midnight';
}

/** Build the caption for an event, or null if the kind is not captioned. */
export function captionFor(
  ev: SimEvent, speciesName: (id: number) => string, tankH: number, speciesOfEntity?: (id: number) => number | undefined,
): CaptionOffer | null {
  const pos = 'pos' in ev ? ev.pos : 'centroid' in ev ? ev.centroid : undefined;
  const zone = pos ? t(zoneKey(pos[1], tankH)) : t('zone.twilight');
  const pri = BASE_INTEREST[ev.k] ?? 0.3;
  let text: string | null = null;
  let species: string | undefined;
  switch (ev.k) {
    case 'hunt': {
      if (ev.phase !== 'start') return null;
      const sp = speciesOfEntity?.(ev.pred);
      if (sp === undefined) return null;
      species = speciesName(sp); text = t('caption.hunt', { species: '\u0000', zone }); break;
    }
    case 'speciation': species = speciesName(ev.child); text = t('caption.speciation', { species: '\u0000', parent: speciesName(ev.parent) }); break;
    case 'extinction': species = speciesName(ev.species); text = t('caption.extinction', { species: '\u0000' }); break;
    case 'giant': species = speciesName(ev.species); text = t('caption.giant', { species: '\u0000' }); break;
    case 'god': text = t('caption.god', { power: tk(`power.${ev.power}`), zone }); break;
    case 'release': species = speciesName(ev.species); text = t('caption.release', { species: '\u0000' }); break;
    case 'school': if (ev.phase !== 'start') return null; species = speciesName(ev.species); text = t('caption.school', { species: '\u0000', zone }); break;
    case 'massDeath': text = t('caption.massDeath', { zone }); break;
    case 'frenzy': text = t('caption.frenzy', { zone }); break;
    case 'outbreak': if (ev.phase !== 'start') return null; text = t('caption.outbreak', { zone }); break;
    case 'bloomFront': text = t('caption.bloomFront', { zone }); break;
    case 'migration': species = speciesName(ev.species); text = t('caption.migration', { species: '\u0000' }); break;
    case 'newRole': species = speciesName(ev.species); text = t('caption.newRole', { species: '\u0000' }); break;
    default: return null;
  }
  return { text, ...(species ? { species } : {}), priority: pri, at: 0 };
}

/** DOM caption layer: lower third, white at 70% opacity on a 40% black band (07 §4.2). */
export class CaptionLayer {
  readonly el: HTMLDivElement;
  private line: HTMLDivElement;
  private shownText = '';
  constructor(root: HTMLElement, profile: ViewProfile) {
    const tv = profile.mode === 'tv';
    this.line = h('div', {
      style: `font:400 ${tv ? 'max(28px,2.6vh)' : '2.2vh'}/1.3 system-ui,"Segoe UI",sans-serif;color:rgba(255,255,255,.7);` +
        `padding:0 ${tv ? '5vw' : '4vw'};letter-spacing:.01em`,
    });
    this.el = h('div', {
      class: 'pt-caption', 'aria-live': 'polite', role: 'status',
      style: `position:fixed;left:0;right:0;bottom:${tv ? '5vh' : '0'};padding:${tv ? '2.4vh' : '3vh'} 0 ${tv ? '2vh' : '4vh'};` +
        'background:linear-gradient(to top,rgba(0,0,0,.4),rgba(0,0,0,.4) 60%,rgba(0,0,0,0));opacity:0;pointer-events:none;' +
        'transition:none',
    }, this.line);
    root.appendChild(this.el);
  }
  show(c: CaptionShown | null): void {
    if (!c) { this.el.style.opacity = '0'; return; }
    const key = `${c.text}|${c.species ?? ''}`;
    if (key !== this.shownText) {
      this.shownText = key;
      this.line.textContent = '';
      const parts = c.text.split('\u0000');
      parts.forEach((p, i) => {
        if (i > 0 && c.species) this.line.appendChild(h('i', null, c.species));
        this.line.appendChild(document.createTextNode(p));
      });
    }
    this.el.style.opacity = c.alpha.toFixed(3);
  }
}
