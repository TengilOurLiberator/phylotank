/**
 * First-run onboarding (07 §5): a living tank first, then a small non-blocking welcome card,
 * an optional three-step tour (inspect, a harmless power, the designer) and the "make it your
 * wallpaper / screensaver / TV" card. One sentence and one highlighted control per step;
 * completing the action advances the tour; every step can be skipped, by keyboard too.
 *
 * The state machine (07 §5.2) is pure and unit-tested; `OnboardingUi` draws it in the god window.
 * Flags live in this viewer's localStorage (the per-viewer mirror of the host's world-independent
 * config; the host keys are proposed in docs/contract-requests/ui.md item 10).
 */
import { h, mount, store } from './dom.js';
import { t } from './i18n.js';

export const ONBOARDING_VERSION = 1;
/** "Just watch" also happens after this long without input on the welcome card. */
export const WELCOME_IDLE_MS = 20_000;
/** The welcome card appears this long after the tank has living creatures (07 §5.1 says ~10 s). */
export const WELCOME_DELAY_MS = 1500;
/** "Living" means at least this many creatures in view (UX-T33). */
export const LIVING_MIN = 50;

export type OnbState =
  | { s: 'firstRun' } | { s: 'seeding' } | { s: 'welcome' } | { s: 'confirmEmpty' }
  | { s: 'tour'; step: 1 | 2 | 3 } | { s: 'setup' } | { s: 'done'; minimised: boolean };
export type OnbEvent =
  | { e: 'world'; creatures: number } | { e: 'tour' } | { e: 'watch' } | { e: 'idle' } | { e: 'empty' } | { e: 'emptyConfirmed' } | { e: 'emptyCancelled' }
  | { e: 'inspected' } | { e: 'cast' } | { e: 'designer' } | { e: 'skip' } | { e: 'setupDone' } | { e: 'reopen' };
export interface OnbFlags { version: number; tourDone: boolean; viewsSetupDismissed: boolean; welcomed: boolean }

export function initialState(flags: OnbFlags | null): OnbState {
  if (flags && flags.version === ONBOARDING_VERSION && (flags.tourDone || flags.welcomed)) return { s: 'done', minimised: true };
  return { s: 'firstRun' };
}

/** Pure transition function for 07 §5.2. Unknown events leave the state unchanged. */
export function step(st: OnbState, ev: OnbEvent): OnbState {
  if (ev.e === 'reopen') return { s: 'welcome' };
  switch (st.s) {
    case 'firstRun': case 'seeding':
      if (ev.e === 'world') return ev.creatures >= LIVING_MIN ? { s: 'welcome' } : { s: 'seeding' };
      return st;
    case 'welcome':
      if (ev.e === 'tour') return { s: 'tour', step: 1 };
      if (ev.e === 'watch' || ev.e === 'idle' || ev.e === 'skip') return { s: 'done', minimised: true };
      if (ev.e === 'empty') return { s: 'confirmEmpty' };
      return st;
    case 'confirmEmpty':
      if (ev.e === 'emptyConfirmed') return { s: 'done', minimised: true };
      if (ev.e === 'emptyCancelled' || ev.e === 'skip') return { s: 'welcome' };
      return st;
    case 'tour':
      if (ev.e === 'skip') return { s: 'done', minimised: true };
      if (st.step === 1 && ev.e === 'inspected') return { s: 'tour', step: 2 };
      if (st.step === 2 && ev.e === 'cast') return { s: 'tour', step: 3 };
      if (st.step === 3 && ev.e === 'designer') return { s: 'setup' };
      return st;
    case 'setup':
      if (ev.e === 'setupDone' || ev.e === 'skip') return { s: 'done', minimised: true };
      return st;
    case 'done': return st;
  }
}

export function loadFlags(): OnbFlags | null {
  try { const raw = store.get('pt.onboarding'); return raw ? JSON.parse(raw) as OnbFlags : null; } catch { return null; }
}
export function saveFlags(f: OnbFlags): void { store.set('pt.onboarding', JSON.stringify(f)); }

/** What the god window lends the onboarding UI. */
export interface OnbHost {
  creatures(): number;
  selectedId(): number;
  /** Casts sent so far (the tour's power step advances on a new one). */
  casts(): number;
  designerOpen(): boolean;
  /** Elements to point at: the tank view, the bloom power button, the designer rail button. */
  target(which: 'tank' | 'bloom' | 'designer'): HTMLElement | null;
  openPowers(): void;
  openMeadowlamp(): void;
  startEmpty(): void;
  browserOnly(): boolean;
}

export class OnboardingUi {
  state: OnbState;
  readonly el = h('div', { class: 'pt-onb', role: 'region', 'aria-label': t('onb.help') });
  readonly helpButton: HTMLButtonElement;
  /** Wall time (performance.now) the welcome card first appeared, and when the tank first had LIVING_MIN creatures. */
  readonly timing: { livingAt: number | null; welcomeAt: number | null; t0: number } = { livingAt: null, welcomeAt: null, t0: 0 };
  private flags: OnbFlags;
  private shownKey = '';
  private welcomeSince = 0;
  private lastSel = -1;
  private castBase = 0;
  private highlighted: HTMLElement | null = null;

  constructor(private readonly host: OnbHost, opts: { force?: boolean; t0?: number } = {}) {
    this.flags = loadFlags() ?? { version: ONBOARDING_VERSION, tourDone: false, viewsSetupDismissed: false, welcomed: false };
    this.state = opts.force ? { s: 'firstRun' } : initialState(this.flags);
    this.timing.t0 = opts.t0 ?? 0;
    this.helpButton = h('button', { class: 'pt-help', 'aria-label': t('onb.help'), title: t('onb.help'), onclick: () => this.send({ e: 'reopen' }) }, '?');
    this.lastSel = host.selectedId();
    this.render();
  }

  send(ev: OnbEvent): void {
    const prev = this.state;
    this.state = step(this.state, ev);
    if (prev.s !== this.state.s || ('step' in prev && 'step' in this.state && prev.step !== this.state.step)) this.entered(prev);
    this.render();
  }

  private entered(prev: OnbState): void {
    const st = this.state;
    if (st.s === 'welcome') { this.welcomeSince = performance.now(); this.timing.welcomeAt ??= performance.now(); }
    if (st.s === 'tour' && st.step === 2) { this.castBase = this.host.casts(); this.host.openPowers(); }
    if (st.s === 'tour' && st.step === 3) this.host.openMeadowlamp();
    if (prev.s === 'confirmEmpty' && st.s === 'done') this.host.startEmpty();
    if (st.s === 'done') {
      this.flags.welcomed = true;
      if (prev.s === 'setup') { this.flags.tourDone = true; this.flags.viewsSetupDismissed = true; }
      saveFlags(this.flags);
    }
  }

  /** Called from the god window's slow loop (every 500 ms) and on input. */
  tick(now: number): void {
    const n = this.host.creatures();
    if (n >= LIVING_MIN && this.timing.livingAt === null) this.timing.livingAt = now;
    const st = this.state;
    if (st.s === 'firstRun' || st.s === 'seeding') {
      if (n >= LIVING_MIN && this.timing.livingAt !== null && now - this.timing.livingAt >= WELCOME_DELAY_MS) this.send({ e: 'world', creatures: n });
      else if (st.s === 'firstRun' && n < LIVING_MIN) { this.state = { s: 'seeding' }; this.render(); }
    } else if (st.s === 'welcome' && now - this.welcomeSince > WELCOME_IDLE_MS) this.send({ e: 'idle' });
    else if (st.s === 'tour') {
      const sel = this.host.selectedId();
      if (st.step === 1 && sel >= 0 && sel !== this.lastSel) this.send({ e: 'inspected' });
      else if (st.step === 2 && this.host.casts() > this.castBase) this.send({ e: 'cast' });
      else if (st.step === 3 && this.host.designerOpen()) this.send({ e: 'designer' });
      this.lastSel = sel;
      this.place();
    }
  }
  /** Any input on the welcome card resets its idle timer. */
  poke(): void { if (this.state.s === 'welcome') this.welcomeSince = performance.now(); }

  private key(): string { const st = this.state; return `${st.s}${'step' in st ? st.step : ''}`; }

  render(): void {
    const k = this.key();
    if (k === this.shownKey) return;
    this.shownKey = k;
    this.highlight(null);
    const st = this.state;
    this.helpButton.style.display = st.s === 'done' ? '' : 'none';
    document.body.classList.toggle('onb-on', st.s !== 'done' && st.s !== 'firstRun');
    this.el.className = 'pt-onb';
    switch (st.s) {
      case 'firstRun': mount(this.el); break;
      case 'seeding': mount(this.el, h('div', { class: 'onb-card small', role: 'status' }, t('onb.seeding'))); break;
      case 'welcome': {
        const tour = h('button', { class: 'primary', onclick: () => this.send({ e: 'tour' }) }, t('onb.tour'));
        mount(this.el, h('div', { class: 'onb-card', onpointermove: () => this.poke(), onkeydown: () => this.poke() },
          h('h2', null, t('onb.welcome')), h('p', null, t('onb.welcomeBody')),
          this.host.browserOnly() ? h('p', { class: 'faint', style: 'font-size:12px' }, t('onb.browserOnly')) : null,
          h('div', { class: 'row' }, tour, h('button', { onclick: () => this.send({ e: 'watch' }) }, t('onb.watch')),
            h('span', { class: 'grow' }), h('button', { class: 'ghost', onclick: () => this.send({ e: 'empty' }) }, t('onb.empty')))));
        tour.focus({ preventScroll: true });
        break;
      }
      case 'confirmEmpty': {
        const no = h('button', { onclick: () => this.send({ e: 'emptyCancelled' }) }, t('common.cancel'));
        mount(this.el, h('div', { class: 'onb-card', role: 'alertdialog', 'aria-label': t('onb.empty') }, h('p', null, t('onb.emptyConfirm')),
          h('div', { class: 'row' }, no, h('button', { class: 'danger', onclick: () => this.send({ e: 'emptyConfirmed' }) }, t('common.confirm')))));
        no.focus();
        break;
      }
      case 'tour': {
        const msg = st.step === 1 ? t('onb.step1') : st.step === 2 ? t('onb.step2') : t('onb.step3');
        const skip = h('button', { class: 'ghost', onclick: () => this.send({ e: 'skip' }) }, t('onb.skip'));
        this.el.classList.add('coach');
        mount(this.el, h('div', { class: 'onb-card coach-card', role: 'status', 'aria-live': 'polite' },
          h('div', { class: 'faint', style: 'font-size:11px' }, t('onb.step', { n: st.step })), h('strong', null, msg),
          st.step === 1 ? h('div', { class: 'faint', style: 'font-size:12px' }, t('onb.step1Key')) : null,
          h('div', { class: 'row' }, h('span', { class: 'grow' }), skip)));
        this.place();
        break;
      }
      case 'setup': {
        const done = h('button', { class: 'primary', onclick: () => this.send({ e: 'setupDone' }) }, t('onb.done'));
        mount(this.el, h('div', { class: 'onb-card' }, h('h2', null, t('onb.setup')), h('p', null, t('onb.setupBody')),
          h('ul', null, h('li', null, t('onb.setupWallpaper')), h('li', null, t('onb.setupScreensaver')), h('li', null, t('onb.setupTv'))),
          h('div', { class: 'row' }, h('span', { class: 'grow' }), done)));
        done.focus();
        break;
      }
      case 'done': mount(this.el); break;
    }
  }

  private highlight(el: HTMLElement | null): void {
    if (this.highlighted === el) return;
    this.highlighted?.classList.remove('coach-target');
    this.highlighted = el;
    el?.classList.add('coach-target');
  }
  /** Put the coach card next to its target. */
  private place(): void {
    const st = this.state;
    if (st.s !== 'tour') return;
    const target = this.host.target(st.step === 1 ? 'tank' : st.step === 2 ? 'bloom' : 'designer');
    this.highlight(st.step === 1 ? null : target);
    const card = this.el.firstElementChild as HTMLElement | null;
    if (!card) return;
    if (!target || st.step === 1) { card.style.left = ''; card.style.top = ''; card.classList.remove('pinned'); return; }
    // beside the target's panel (or rail), so the card never covers the controls next to the target
    const host = target.closest('.pt-panel, .pt-rail') ?? target;
    const r = target.getBoundingClientRect(), hr = host.getBoundingClientRect();
    card.classList.add('pinned');
    card.style.left = `${Math.round(hr.right + 14)}px`;
    card.style.top = `${Math.round(Math.max(52, r.top - 6))}px`;
  }
}
