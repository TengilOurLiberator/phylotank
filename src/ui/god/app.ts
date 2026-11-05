/**
 * The god window (07 §3): top bar with clock and time controls (pause, 0.25x, 1x, 4x, 16x, max
 * and the overnight "run at max until" lease), the left rail and its panels (map, powers,
 * designer, library, stats, bookmarks, settings), the inspector, the event timeline, the
 * always-on minimap, and the tank viewport with user camera, picking and power targeting.
 */
import { CORE_POWERS, encodeGenome, decodeGenome, isMajorPower, type Camera, type PowerId, type Speed, type Target } from '../../core/index.js';
import { binomial, h, mount, store } from '../dom.js';
import { fmtNum, getLocale, localeChanged, setLocale, t, tk, type Locale, type MsgKey } from '../i18n.js';
import { DesignerView } from '../designer/designer.js';
import { drawBody, growBody } from '../designer/body.js';
import { importDesign, Library, makeMeta, designString, packDesign } from '../designer/library.js';
import { downloadPtkg } from '../designer/designer.js';
import { drawHistogram, drawLines, drawMinimap, drawPhylogeny, drawPopulation, drawTimeline, diversitySeries, GLYPHS, prep, rgb, type EvFilter, type MiniLayers, type TimelineHit } from './charts.js';
import { clockOf, GodClient } from './client.js';
import { Inspector } from './inspector.js';
import { CastController, inTarget, POWER_SPECS } from './powers.js';
import { GOD_CSS } from './styles.js';
import { diversity, sampleCounts } from './diversity.js';
import { zoneKey } from '../captions.js';
import type { SimLink } from '../../core/index.js';

type Panel = 'map' | 'powers' | 'designer' | 'library' | 'stats' | 'bookmarks' | 'settings';
const RAIL: [Panel, string, MsgKey, string][] = [
  ['map', '◫', 'rail.map', 'M'], ['powers', '✦', 'rail.powers', 'P'], ['designer', '✎', 'rail.designer', 'D'], ['library', '▤', 'rail.library', 'L'],
  ['stats', '▦', 'rail.stats', 'S'], ['bookmarks', '⚑', 'rail.bookmarks', 'B'], ['settings', '⚙', 'rail.settings', ','],
];
const RAIL_W = 76;
const SPEEDS: Speed[] = [0, 0.25, 1, 4, 16, 'max'];
const PAL: number[][] = [];

export class GodApp {
  readonly client: GodClient;
  readonly library = new Library();
  readonly designer: DesignerView;
  inspector: Inspector;
  readonly cast: CastController;
  private chrome = h('div');
  private overlay: HTMLCanvasElement;
  private top = h('header', { class: 'pt-top' });
  private rail = h('nav', { class: 'pt-rail', 'aria-label': 'Panels' });
  private panelEl = h('section', { class: 'pt-panel', role: 'region' });
  private timeEl = h('footer', { class: 'pt-time' });
  private timeCanvas = h('canvas', { height: 64, role: 'img', 'aria-label': 'Event timeline' });
  private tlCard = h('div', { class: 'pt-toast', style: 'display:none;bottom:72px;transform:none;pointer-events:none;max-width:360px' });
  private mini = h('div', { class: 'pt-mini' });
  private miniCanvas = h('canvas', { role: 'img', 'aria-label': t('map.title') });
  private lastMini = 0;
  private lastTl = 0;
  private toastEl = h('div', { class: 'pt-toast', role: 'status', 'aria-live': 'polite', style: 'display:none' });
  private countEl = h('div', { class: 'pt-count', role: 'timer', 'aria-live': 'assertive', style: 'display:none' });
  private bannerEl = h('div', { class: 'pt-banner', style: 'display:none' });
  private panel: Panel | null = null;
  private inspOpen = true;
  private cam: Camera = { cx: 16, cy: 9, zeta: 5 };
  private fitted = false;
  private follow = -1;
  private hoverWorld: [number, number] | null = null;
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private filters = new Set<EvFilter>(['god', 'life', 'death', 'disease', 'records']);
  private tlHits: TimelineHit[] = [];
  private tlHover = -1;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private layers: MiniLayers = { zones: true, currents: false, light: false, temp: false, pop: true, events: true };
  private statsTab: 'population' | 'phylogeny' | 'genes' | 'diversity' = 'population';
  private statsTable = false;
  private statsLog = false;
  private geneTrait = 'ADULT_LENGTH';
  private libFilter: 'all' | 'template' | 'designed' | 'captured' | 'imported' = 'all';
  private libQuery = '';
  private panelCanvas: HTMLCanvasElement | null = null;
  private previewText: HTMLElement | null = null;
  private holdFill: HTMLElement | null = null;
  private lastSlow = 0;
  private dialogs: HTMLElement[] = [];
  private mapCanvas: HTMLCanvasElement | null = null;
  private mapUnder: HTMLElement | null = null;
  private speciesPick = new Set<number>();
  private panelSig = '';
  private mapSpecies: HTMLElement | null = null;

  constructor(private readonly root: HTMLElement, link: SimLink, private readonly canvas: HTMLCanvasElement) {
    root.appendChild(h('style', null, GOD_CSS));
    this.client = new GodClient(link);
    this.overlay = h('canvas', { style: 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:5' });
    root.appendChild(this.overlay);
    root.appendChild(this.chrome);
    this.cast = new CastController({
      cast: (power, target, intensity, duration, seed) => this.client.send({ t: 'cast', power, target, intensity, ...(duration ? { duration } : {}), seed }),
      snapshot: (label) => this.client.send({ t: 'snapshot', label }),
      paused: () => this.client.speed.requested === 0,
    }, () => this.refreshPowers());
    this.designer = new DesignerView({
      library: this.library,
      toast: (m) => this.toast(m),
      dialog: (el) => this.dialog(el),
      release: async (ptkg, o) => this.client.send({ t: 'release', ptkg, pos: o.pos, count: o.count, asLeviathan: o.asLeviathan, founderProtection: o.founderProtection }),
      tank: () => this.client.tank,
      lCeiling: () => this.client.welcome?.lCeiling ?? 0.126,
      canRelease: () => true,
    });
    this.inspector = this.makeInspector();
    try { const p = store.get('pt.god.panel') as Panel | null; if (p && RAIL.some((r) => r[0] === p)) this.panel = p; } catch { /* default */ }
    this.inspOpen = store.get('pt.god.insp') !== '0';
    this.build();
    this.client.changed.on((c) => this.onChange(c));
    localeChanged.on(() => { this.inspector = this.makeInspector(); this.build(); this.designer.render(); });
    this.installInput();
    setInterval(() => this.client.sweep(), 1000);
    window.addEventListener('pagehide', () => this.client.close());
  }

  private makeInspector(): Inspector {
    return new Inspector(this.client, {
      follow: (id) => { this.follow = id; this.inspector.render(); },
      following: () => this.follow,
      saveGenome: (g, name) => {
        const [genus = 'Novus', epithet = 'captus'] = name.split(' ');
        const day = clockOf(this.client.tick, this.client.env).day;
        const r = this.library.put(makeMeta(genus, epithet, 'captured', { world: { name: t('app.worldName'), day, generation: this.client.selected?.generation ?? 0 } }), canonical(g), 'captured');
        this.toast(r.added ? t('inspector.saved') : t('library.exists'));
      },
      fork: (g, name) => {
        const [genus = 'Novus', epithet = 'captus'] = name.split(' ');
        this.designer.open(canonical(g), { genus, epithet: `${epithet}-f`, origin: 'captured' });
        this.openPanel('designer');
      },
      bookmark: () => void this.bookmarkNow(),
      bless: (id) => void this.client.send({ t: 'cast', power: 'bless', target: { kind: 'creature', entity: id }, intensity: 0.5, seed: 1 }),
    });
  }

  // ---------------- layout ----------------
  private build(): void {
    document.documentElement.lang = getLocale() === 'sv' ? 'sv-SE' : 'en-GB';
    this.rail = h('nav', { class: 'pt-rail', 'aria-label': 'Panels' });
    for (const [p, ico, key, kb] of RAIL) {
      this.rail.append(h('button', { class: this.panel === p ? 'on' : '', 'aria-pressed': String(this.panel === p), title: `${t(key)} (${kb})`, onclick: () => this.openPanel(this.panel === p ? null : p) },
        h('span', { class: 'ico', 'aria-hidden': 'true' }, ico), t(key)));
    }
    this.timeEl = h('footer', { class: 'pt-time' }, this.timeCanvas, h('div', { class: 'chips', role: 'group', 'aria-label': t('timeline.title') },
      h('div', { class: 'row', style: 'gap:3px' }, ...(['god', 'life', 'death'] as EvFilter[]).map((f) => this.chip(f))),
      h('div', { class: 'row', style: 'gap:3px' }, ...(['disease', 'records'] as EvFilter[]).map((f) => this.chip(f)))));
    this.mini = h('div', { class: 'pt-mini' }, this.miniCanvas);
    mount(this.chrome, this.top, this.rail, this.panelEl, this.inspector.el, this.timeEl, this.mini, this.bannerEl, this.countEl, this.toastEl, this.tlCard, ...this.dialogs);
    this.inspector.el.classList.toggle('collapsed', !this.inspOpen || this.panel === 'designer');
    this.renderTop();
    this.renderPanel();
    this.layoutMini();
  }
  private chip(f: EvFilter): HTMLElement {
    return h('button', { class: `chip${this.filters.has(f) ? ' on' : ''}`, 'aria-pressed': String(this.filters.has(f)), onclick: (e: Event) => {
      if (this.filters.has(f)) this.filters.delete(f); else this.filters.add(f);
      (e.currentTarget as HTMLElement).classList.toggle('on'); (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(this.filters.has(f)));
    } }, t(`timeline.${f}` as MsgKey));
  }
  private layoutMini(): void {
    const panelOpen = this.panel !== null && this.panel !== 'designer';
    this.mini.style.left = `${panelOpen ? RAIL_W + this.panelWidth() + 12 : RAIL_W + 12}px`;
    this.mini.style.display = this.panel === 'designer' || this.panel === 'map' ? 'none' : '';
  }

  private panelWidth(): number { return this.panel === 'stats' || this.panel === 'map' ? 600 : 420; }
  openPanel(p: Panel | null): void {
    this.panel = p;
    store.set('pt.god.panel', p ?? '');
    for (const b of this.rail.querySelectorAll('button')) b.classList.remove('on');
    const idx = RAIL.findIndex((r) => r[0] === p);
    if (idx >= 0) this.rail.querySelectorAll('button')[idx]?.classList.add('on');
    this.inspector.el.classList.toggle('collapsed', !this.inspOpen || p === 'designer');
    this.renderPanel();
    this.layoutMini();
  }
  toggleInspector(): void { this.inspOpen = !this.inspOpen; store.set('pt.god.insp', this.inspOpen ? '1' : '0'); this.inspector.el.classList.toggle('collapsed', !this.inspOpen || this.panel === 'designer'); }

  // ---------------- top bar ----------------
  private topKey = '';
  private clockEl: HTMLElement | null = null;
  private achievedEl: HTMLElement | null = null;
  /** Rebuild the top bar only when its structure changes, so its buttons stay put under the pointer. */
  private renderTop(): void {
    const ck = clockOf(this.client.tick, this.client.env, this.client.welcome?.tickHz ?? 30);
    const sp = this.client.speed;
    const unattended = sp.unattended && sp.until?.wallIso;
    const clockText = `${t('time.day', { d: ck.day })}  ${String(ck.hh).padStart(2, '0')}:${String(ck.mm).padStart(2, '0')}  ${t(`season.${ck.season}` as MsgKey)}`;
    const achievedText = sp.requested !== 1 ? t('time.achieved', { req: sp.requested === 'max' ? 'max' : `${sp.requested}x`, got: `${fmtNum(sp.achieved, 1)}x` }) : '';
    const down = !this.client.isMock && performance.now() - this.client.lastFrameAt > 3000;
    const key = `${getLocale()}|${sp.requested}|${unattended ?? ''}|${this.client.isMock}|${down}`;
    // host down (07 §8): world-changing controls are disabled; the designer and library still work
    document.body.classList.toggle('host-down', down);
    if (key === this.topKey && this.clockEl && this.achievedEl && this.clockEl.isConnected) {
      this.clockEl.textContent = clockText;
      this.achievedEl.textContent = achievedText;
      return;
    }
    this.topKey = key;
    const label = (s: Speed) => (s === 0 ? '❚❚' : s === 'max' ? t('time.max') : `${s}x`);
    const speedBtns = SPEEDS.map((s) => h('button', {
      class: sp.requested === s ? 'on' : '', 'aria-pressed': String(sp.requested === s), title: s === 0 ? t('time.pause') : s === 'max' || (typeof s === 'number' && s > 1) ? t('time.ff') : '',
      onclick: () => void this.client.setSpeed(s),
    }, label(s)));
    const status = this.client.isMock ? h('span', { class: 'pt-status', title: t('app.mockBanner') }, h('span', { class: 'dot mock' }), 'mock sim')
      : h('span', { class: 'pt-status' }, h('span', { class: `dot${down ? ' down' : ''}` }), down ? t('app.hostDown') : t('common.live'));
    const lang = h('select', { 'aria-label': t('app.language'), onchange: (e: Event) => setLocale((e.target as HTMLSelectElement).value as Locale) },
      h('option', { value: 'en', selected: getLocale() === 'en' }, 'English'), h('option', { value: 'sv', selected: getLocale() === 'sv' }, 'Svenska'));
    mount(this.top,
      h('span', { class: 'pt-brand' }, t('app.name').toUpperCase()), h('span', { class: 'pt-world' }, t('app.worldName')), h('span', { class: 'sep' }),
      this.clockEl = h('span', { class: 'pt-clock', 'aria-live': 'off' }, clockText),
      h('span', { class: 'sep' }),
      h('div', { class: 'row pt-speed', role: 'group', 'aria-label': t('time.ff') }, ...speedBtns),
      unattended ? h('span', { class: 'warn', style: 'font-size:12px' }, t('time.overnightActive', { time: new Date(sp.until!.wallIso!).toLocaleTimeString(getLocale() === 'sv' ? 'sv-SE' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) }), ' ',
        h('button', { onclick: () => void this.client.setSpeed(1) }, t('time.overnightCancel')))
        : h('button', { class: 'ovn', onclick: () => this.overnightDialog(), title: `${t('time.overnightTitle')}`, 'aria-label': t('time.overnight') }, '☾ ', h('span', { class: 'lbl' }, t('time.overnight'))),
      this.achievedEl = h('span', { class: 'dim', style: 'font-size:12px' }, achievedText),
      h('span', { class: 'grow' }),
      status, lang);
    this.bannerEl.style.display = down || (sp.requested !== 1 && !unattended && sp.requested !== 0) ? '' : 'none';
    this.bannerEl.textContent = down ? t('app.hostDown') : t('time.lease');
  }

  private overnightDialog(): void {
    const d = new Date(); d.setHours(7, 0, 0, 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    const input = h('input', { type: 'time', value: '07:00', 'aria-label': t('time.overnightUntil') });
    let close = () => {};
    const el = h('div', null, h('h3', null, t('time.overnightTitle')),
      h('div', { class: 'row' }, h('label', null, t('time.overnightUntil')), input),
      h('p', { class: 'dim', style: 'font-size:12px' }, t('time.overnightNote')),
      h('div', { class: 'actions' }, h('button', { onclick: () => close() }, t('common.cancel')),
        h('button', { class: 'primary', onclick: () => {
          const [hh, mm] = input.value.split(':').map(Number);
          const until = new Date(); until.setHours(hh ?? 7, mm ?? 0, 0, 0); if (until.getTime() <= Date.now()) until.setDate(until.getDate() + 1);
          void this.client.setSpeed('max', { until: { wallIso: until.toISOString() }, unattended: true });
          close();
        } }, t('time.overnightStart'))));
    close = this.dialog(el);
  }

  // ---------------- panels ----------------
  private renderPanel(): void {
    this.panelCanvas = null; this.mapCanvas = null; this.previewText = null; this.holdFill = null;
    if (!this.panel) { this.panelEl.style.display = 'none'; return; }
    this.panelEl.style.display = '';
    this.panelEl.classList.toggle('wide', this.panel === 'designer');
    this.panelEl.classList.toggle('mid', this.panel === 'stats' || this.panel === 'map');
    const titleKey: Record<Panel, MsgKey> = { map: 'map.title', powers: 'powers.title', designer: 'designer.title', library: 'library.title', stats: 'stats.title', bookmarks: 'bookmarks.title', settings: 'settings.title' };
    const body = h('div', { class: 'body' });
    if (this.panel === 'designer') {
      body.style.padding = '0';
      body.append(this.designer.el);
      mount(this.panelEl, body);
      this.panelEl.setAttribute('aria-label', t('designer.title'));
      return;
    }
    this.panelEl.setAttribute('aria-label', t(titleKey[this.panel]));
    mount(this.panelEl, h('header', null, h('h2', null, t(titleKey[this.panel])), h('button', { onclick: () => this.openPanel(null), 'aria-label': t('common.close') }, '✕')), body);
    switch (this.panel) {
      case 'map': this.mapPanel(body); break;
      case 'powers': this.powersPanel(body); break;
      case 'library': this.libraryPanel(body); break;
      case 'stats': this.statsPanel(body); break;
      case 'bookmarks': this.bookmarksPanel(body); break;
      case 'settings': this.settingsPanel(body); break;
    }
  }

  private mapPanel(body: HTMLElement): void {
    this.mapCanvas = h('canvas', { style: 'width:100%;aspect-ratio:16/9;border-radius:6px;cursor:crosshair;display:block', role: 'img', 'aria-label': t('map.title') });
    this.mapUnder = h('div', { class: 'dim', style: 'font-size:12px' }, '');
    this.mapCanvas.addEventListener('mousemove', (e) => {
      const r = this.mapCanvas!.getBoundingClientRect(); const tank = this.client.tank;
      const wy = ((e.clientY - r.top) / r.height) * tank.h;
      this.mapUnder!.textContent = t('map.under', { zone: t(zoneKey(wy, tank.h)), temp: fmtNum(18 - 14 * (wy / tank.h), 0), light: fmtNum(Math.exp(-3 * wy / tank.h), 2) });
    });
    this.mapCanvas.addEventListener('click', (e) => { const r = this.mapCanvas!.getBoundingClientRect(); this.jumpTo(((e.clientX - r.left) / r.width) * this.client.tank.w, ((e.clientY - r.top) / r.height) * this.client.tank.h); });
    const chips = (Object.keys(this.layers) as (keyof MiniLayers)[]).map((k) => h('button', { class: `chip${this.layers[k] ? ' on' : ''}`, 'aria-pressed': String(this.layers[k]),
      onclick: (e: Event) => { this.layers[k] = !this.layers[k]; (e.currentTarget as HTMLElement).classList.toggle('on'); } }, t(({ zones: 'map.zones', currents: 'map.currents', light: 'map.light', temp: 'map.temp', pop: 'map.pop', events: 'map.events' } as Record<string, MsgKey>)[k]!)));
    this.mapSpecies = this.speciesList();
    body.append(h('div', { class: 'row', style: 'margin-bottom:8px' }, ...chips), this.mapCanvas, this.mapUnder, this.mapSpecies);
  }
  private speciesList(): HTMLElement {
    const live = this.client.species.filter((s) => s.count > 0).sort((a, b) => b.count - a.count);
    return h('table', { class: 't', style: 'margin-top:10px' }, h('thead', null, h('tr', null, h('th', null, t('stats.species')), h('th', null, t('stats.count')))),
      h('tbody', null, ...live.map((s) => h('tr', null, h('td', null, h('span', { style: `color:${rgb(s.colour)}` }, GLYPHS[s.glyph % GLYPHS.length]!, ' '), binomial(s.name)), h('td', { class: 'num' }, String(s.count))))));
  }

  private powersPanel(body: HTMLElement): void {
    const st = this.cast.state;
    const current = 'power' in st ? st.power : null;
    const grid = h('div', { class: 'pgrid', role: 'group', 'aria-label': t('powers.title') }, ...CORE_POWERS.map((p) => {
      const sp = POWER_SPECS[p];
      return h('button', { class: `${current === p ? 'on ' : ''}${isMajorPower(p, 1) ? 'major' : ''}`, 'aria-pressed': String(current === p), onclick: () => { this.cast.pick(p); } },
        h('span', { class: 'ico', 'aria-hidden': 'true' }, sp?.glyph ?? '✦'), tk(`power.${p}`));
    }), h('button', { onclick: () => this.openPanel('library') }, h('span', { class: 'ico' }, '⇲'), t('power.release')));
    body.append(grid);
    const detail = h('div', { class: 'card col', style: 'margin-top:12px' });
    body.append(detail);
    this.fillPowerDetail(detail);
  }
  private fillPowerDetail(detail: HTMLElement): void {
    const st = this.cast.state;
    if (st.s === 'idle' || !('power' in st)) { mount(detail, h('div', { class: 'dim' }, t('powers.pick')), this.castMessage()); return; }
    const sp = POWER_SPECS[st.power]!;
    const major = this.cast.major;
    const inten = h('input', { type: 'range', min: 0, max: 100, value: String(Math.round(this.cast.intensity * 100)), 'aria-label': t('powers.intensity') });
    const effect = h('span', { class: 'dim', style: 'font-size:12px' }, sp.effect ? t(sp.effect.key, { v: sp.effect.value(this.cast.intensity) }) : '');
    inten.addEventListener('input', () => {
      const wasMajor = this.cast.major;
      this.cast.intensity = Number(inten.value) / 100;
      if (sp.effect) effect.textContent = t(sp.effect.key, { v: sp.effect.value(this.cast.intensity) });
      if (this.cast.state.s === 'previewing' && this.cast.state.target.kind === 'circle') this.cast.target({ ...this.cast.state.target, radius: this.cast.radius() });
      if (wasMajor !== this.cast.major) this.refreshPowers();
    });
    const rows: HTMLElement[] = [
      h('div', { class: 'row' }, h('strong', null, sp.glyph, ' ', tk(`power.${st.power}`)), h('span', { class: 'dim', style: 'font-size:12px' }, t('powers.targeting', { how: t(`target.${sp.targeting}` as MsgKey) }))),
      h('div', { class: 'slider', style: 'grid-template-columns:80px 1fr auto' }, h('label', null, t('powers.intensity')), inten, effect),
    ];
    if (sp.duration) {
      const d = h('input', { type: 'range', min: sp.duration.min, max: sp.duration.max, value: String(this.cast.duration ?? sp.duration.default), 'aria-label': t('powers.duration') });
      const dl = h('span', { class: 'dim', style: 'font-size:12px' }, `${fmtNum((this.cast.duration ?? sp.duration.default) / 1200, 1)} d`);
      d.addEventListener('input', () => { this.cast.duration = Number(d.value); dl.textContent = `${fmtNum(this.cast.duration / 1200, 1)} d`; });
      rows.push(h('div', { class: 'slider', style: 'grid-template-columns:80px 1fr auto' }, h('label', null, t('powers.duration')), d, dl));
    }
    if (sp.targeting === 'species') {
      const live = this.client.species.filter((s) => s.count > 0).sort((a, b) => b.count - a.count);
      rows.push(h('div', { class: 'dim', style: 'font-size:12px' }, t('powers.pickSpecies')),
        h('div', { class: 'col', style: 'gap:2px;max-height:150px;overflow:auto' }, ...live.map((s) => {
          const cb = h('input', { type: 'checkbox', checked: this.speciesPick.has(s.id), onchange: () => {
            if (cb.checked) this.speciesPick.add(s.id); else this.speciesPick.delete(s.id);
            if (this.speciesPick.size) this.cast.target({ kind: 'species', species: [...this.speciesPick] });
          } });
          return h('label', { class: 'row', style: 'font-size:12px' }, cb, h('span', { style: `color:${rgb(s.colour)}` }, GLYPHS[s.glyph % GLYPHS.length]!), binomial(s.name), h('span', { class: 'faint' }, String(s.count)));
        })));
    } else if (sp.targeting !== 'global') {
      // keyboard and screen-reader path: target without a pointer (07 §6.1)
      rows.push(h('div', { class: 'row' }, h('span', { class: 'dim', style: 'font-size:12px' }, st.s === 'armed' ? t('powers.clickTarget') : ''), h('span', { class: 'grow' }),
        h('button', { onclick: () => this.targetCentre() }, t('powers.targetCentre'))));
    }
    else rows.push(h('div', { class: 'dim', style: 'font-size:12px' }, t('powers.globalReady')));
    this.previewText = h('div', { style: 'font-size:12px' });
    rows.push(this.previewText);
    if (major) rows.push(h('div', { class: 'warn', style: 'font-size:12px' }, '⚠ ', t('powers.major')));
    const ready = st.s === 'previewing' || st.s === 'holding';
    if (major) {
      this.holdFill = h('i', { style: 'width:0%' });
      const hold = h('button', { class: 'danger hold', disabled: !ready, style: 'min-width:170px' }, this.holdFill, t('powers.hold'));
      hold.addEventListener('pointerdown', () => this.cast.confirmDown(performance.now()));
      hold.addEventListener('pointerup', () => this.cast.confirmUp(performance.now()));
      hold.addEventListener('pointerleave', () => this.cast.confirmUp(performance.now()));
      hold.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); this.cast.confirmDown(performance.now()); } });
      hold.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') this.cast.confirmUp(performance.now()); });
      rows.push(h('div', { class: 'row' }, hold, h('button', { disabled: !ready, onclick: () => this.cast.dialogConfirm() }, t('powers.confirmDialog'))),
        h('div', { class: 'faint', style: 'font-size:11px' }, t('powers.holdKey')));
    } else rows.push(h('div', { class: 'row' }, h('button', { class: 'primary', disabled: !ready, onclick: () => this.cast.confirmDown(performance.now()) }, t('powers.cast')),
      h('button', { onclick: () => this.cast.cancel() }, t('common.cancel'))));
    rows.push(this.castMessage());
    mount(detail, ...rows);
    this.updatePreviewCount();
  }
  private castMessage(): HTMLElement {
    const m = this.cast.message;
    if (!m) return h('span');
    const vars = { ...(m.vars ?? {}) };
    if (typeof vars.power === 'string') vars.power = tk(`power.${vars.power}`);
    return h('div', { class: m.key === 'powers.rejected' || m.key === 'powers.stale' ? 'bad' : 'good', style: 'font-size:12px' }, t(m.key, vars));
  }
  private refreshPowers(): void {
    if (this.panel === 'powers') {
      const detail = this.panelEl.querySelector('.card');
      const grid = this.panelEl.querySelector('.pgrid');
      if (detail instanceof HTMLElement && grid) {
        const st = this.cast.state; const current = 'power' in st ? st.power : null;
        grid.querySelectorAll('button').forEach((b, i) => { const on = CORE_POWERS[i] === current; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
        this.fillPowerDetail(detail);
      } else this.renderPanel();
    } else if (this.cast.state.s !== 'idle' && this.cast.state.s !== 'countdown') this.openPanel('powers');
    if (this.cast.message && this.cast.state.s === 'countdown') {
      const m = this.cast.message; const vars = { ...(m.vars ?? {}) }; if (typeof vars.power === 'string') vars.power = tk(`power.${vars.power}`);
      this.toast(t(m.key, vars));
    }
  }
  private updatePreviewCount(): void {
    if (!this.previewText) return;
    const st = this.cast.state;
    if (st.s !== 'previewing' && st.s !== 'holding') { this.previewText.textContent = ''; return; }
    const tg = st.target;
    const r = this.client.countWhere((x, y, sp) => inTarget(tg, x, y, sp));
    let top = '';
    if (r.n > 0) {
      const [sid, n] = [...r.species.entries()].sort((a, b) => b[1] - a[1])[0]!;
      top = ` (${Math.round((n / r.n) * 100)}% ${this.client.speciesName(sid)})`;
    }
    this.previewText.textContent = t('powers.inRange', { n: r.n, s: r.species.size }) + top;
  }

  private libraryPanel(body: HTMLElement): void {
    const list = h('div');
    const fill = () => {
      const entries = this.library.search(this.libQuery, this.libFilter);
      if (entries.length === 0) { mount(list, h('p', { class: 'dim' }, t('library.empty'))); return; }
      mount(list, ...entries.map((e) => {
        const thumb = h('canvas', { width: 192, height: 128, 'aria-hidden': 'true' });
        try { const g = decodeGenome(e.genome); drawBody(thumb.getContext('2d')!, growBody(g, 1, 0.126), { x: 4, y: 4, w: 184, h: 120 }); } catch { /* bad genome */ }
        const name = `${e.meta.name.genus} ${e.meta.name.epithet}`;
        return h('div', { class: 'lib-row' }, thumb,
          h('div', null, binomial(name), h('div', { class: 'dim', style: 'font-size:12px' }, `${e.meta.name.common ?? ''} · ${t(`library.${e.origin}` as MsgKey)}${e.meta.tags.length ? ` · ${e.meta.tags.join(', ')}` : ''}`)),
          h('div', { class: 'col', style: 'gap:3px' },
            h('button', { onclick: () => { this.designer.open(e.genome, { genus: e.meta.name.genus, epithet: e.meta.name.epithet, ...(e.meta.name.common ? { common: e.meta.name.common } : {}), origin: e.readOnly ? 'template' : e.origin === 'captured' ? 'captured' : 'designer', ...(e.readOnly ? { template: e.id.slice(9) as never } : { libraryId: e.id }) }); this.openPanel('designer'); } }, t('library.edit')),
            h('button', { onclick: () => { this.designer.open(e.genome, { genus: e.meta.name.genus, epithet: e.meta.name.epithet, origin: 'designer' }); this.designer.share(); } }, t('library.share')),
            e.readOnly ? null : h('button', { class: 'danger', onclick: () => { this.library.remove(e.id); fill(); } }, t('library.delete'))));
      }));
    };
    const search = h('input', { type: 'search', placeholder: t('library.search'), value: this.libQuery, 'aria-label': t('library.search'), style: 'flex:1', oninput: (e: Event) => { this.libQuery = (e.target as HTMLInputElement).value; fill(); } });
    const filters = (['all', 'template', 'designed', 'captured', 'imported'] as const).map((f) => h('button', { class: `chip${this.libFilter === f ? ' on' : ''}`, onclick: () => { this.libFilter = f; this.renderPanel(); } }, f === 'all' ? 'all' : t(`library.${f}` as MsgKey)));
    const paste = h('textarea', { rows: 2, placeholder: t('library.paste'), 'aria-label': t('library.paste'), style: 'width:100%;font:11px ui-monospace,monospace' });
    const file = h('input', { type: 'file', accept: '.ptkg,application/octet-stream', 'aria-label': `${t('library.import')} .ptkg`, onchange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0]; if (f) this.importInput(new Uint8Array(await f.arrayBuffer()));
    } });
    body.append(h('div', { class: 'row' }, search), h('div', { class: 'row', style: 'margin:6px 0' }, ...filters), list,
      h('div', { class: 'card col', style: 'margin-top:10px' }, h('strong', null, t('library.import')), paste, h('div', { class: 'row' }, h('button', { onclick: () => this.importInput(paste.value) }, t('library.import')), file),
        h('div', { class: 'faint', style: 'font-size:11px' }, t('library.importHint'))));
    fill();
  }
  importInput(input: Uint8Array | string): void {
    try {
      const r = importDesign(input);
      const d = r.designs[0];
      if (!d) throw new Error('empty pack');
      for (const x of r.designs) this.library.put(x.meta, x.genome, 'imported');
      this.designer.open(d.genome, { genus: d.meta.name.genus, epithet: d.meta.name.epithet, ...(d.meta.name.common ? { common: d.meta.name.common } : {}), origin: 'designer', parents: d.meta.parents });
      this.openPanel('designer');
      this.toast(t('library.importOk', { name: `${d.meta.name.genus} ${d.meta.name.epithet}` }));
    } catch (e) { this.toast(t('library.importFail', { reason: (e as Error).message })); }
  }

  private statsPanel(body: HTMLElement): void {
    const tabs = (['population', 'phylogeny', 'genes', 'diversity'] as const);
    const keys: Record<string, MsgKey> = { population: 'stats.population', phylogeny: 'stats.phylogeny', genes: 'stats.genes', diversity: 'stats.diversity' };
    body.append(h('div', { class: 'tabs', role: 'tablist' }, ...tabs.map((x) => h('button', { role: 'tab', 'aria-selected': String(this.statsTab === x), class: this.statsTab === x ? 'on' : '', onclick: () => { this.statsTab = x; this.renderPanel(); } }, t(keys[x]!)))));
    const opts = h('div', { class: 'row', style: 'margin:8px 0' },
      h('button', { class: `chip${this.statsTable ? ' on' : ''}`, onclick: () => { this.statsTable = !this.statsTable; this.renderPanel(); } }, this.statsTable ? t('common.showChart') : t('common.showTable')));
    if (this.statsTab === 'population') opts.append(h('button', { class: `chip${this.statsLog ? ' on' : ''}`, onclick: () => { this.statsLog = !this.statsLog; } }, t('stats.log')));
    if (this.statsTab === 'genes') opts.append(h('select', { 'aria-label': t('stats.trait'), onchange: (e: Event) => { this.geneTrait = (e.target as HTMLSelectElement).value; } },
      ...['ADULT_LENGTH', 'DIET_PLANT', 'GLOW_HUE', 'MU_LOG'].map((g) => h('option', { value: g, selected: g === this.geneTrait }, g.toLowerCase().replace(/_/g, ' ')))));
    body.append(opts);
    if (this.statsTable) { body.append(this.statsTableEl()); return; }
    this.panelCanvas = h('canvas', { style: `width:100%;height:${this.statsTab === 'phylogeny' ? 460 : 340}px;background:#02070b;border-radius:6px;display:block`, role: 'img', 'aria-label': t(keys[this.statsTab]!) });
    body.append(this.panelCanvas);
    if (this.statsTab === 'diversity') {
      const last = this.client.history[this.client.history.length - 1];
      const d = diversity(last ? [...sampleCounts(last[1]).values()] : []);
      body.append(h('div', { class: 'kv', style: 'margin-top:8px' }, h('span', null, t('stats.richness')), h('span', null, String(d.richness)), h('span', null, t('stats.shannon')), h('span', null, fmtNum(d.shannon, 3)),
        h('span', null, t('stats.effective')), h('span', null, fmtNum(d.effective, 2)), h('span', null, t('stats.simpson')), h('span', null, fmtNum(d.simpson, 3))));
    }
  }
  private statsTableEl(): HTMLElement {
    if (this.statsTab === 'diversity') {
      const s = diversitySeries(this.client.history).slice(-20);
      return h('table', { class: 't' }, h('thead', null, h('tr', null, ...['tick', t('stats.richness'), 'H′', 'exp(H′)', 'Simpson'].map((x) => h('th', null, x)))),
        h('tbody', null, ...s.map((r) => h('tr', null, h('td', null, String(r.t)), h('td', { class: 'num' }, String(r.richness)), h('td', { class: 'num' }, fmtNum(r.shannon, 3)), h('td', { class: 'num' }, fmtNum(r.effective, 2)), h('td', { class: 'num' }, fmtNum(r.simpson, 3))))));
    }
    return h('table', { class: 't' }, h('thead', null, h('tr', null, h('th', null, t('stats.species')), h('th', null, t('stats.count')), h('th', null, 'kg'), h('th', null, 'origin'))),
      h('tbody', null, ...this.client.species.map((s) => h('tr', null, h('td', null, binomial(s.name), s.extinctTick !== undefined ? ' ×' : ''), h('td', { class: 'num' }, String(s.count)), h('td', { class: 'num' }, fmtNum(s.biomassKg, 3)), h('td', null, s.origin)))));
  }

  private bookmarksPanel(body: HTMLElement): void {
    const snaps = [...this.client.snapshots].sort((a, b) => b.tick - a.tick);
    body.append(h('div', { class: 'row', style: 'margin-bottom:8px' }, h('button', { class: 'primary', onclick: () => void this.bookmarkNow() }, t('bookmarks.now'))));
    if (snaps.length === 0) { body.append(h('p', { class: 'dim' }, t('bookmarks.empty'))); return; }
    for (const s of snaps) {
      const ck = clockOf(s.tick, null);
      const when = `${t('time.day', { d: ck.day })} ${String(ck.hh).padStart(2, '0')}:${String(ck.mm).padStart(2, '0')}`;
      body.append(h('div', { class: 'snap' },
        h('div', null, h('div', null, s.parentId ? '└ ' : '', s.name), h('div', { class: 'meta' }, `${when} · ${t(`bookmarks.kind.${s.kind}` as MsgKey)} · ${t('bookmarks.life', { n: s.life })} · ${t('bookmarks.species', { n: s.species })}`)),
        h('button', { onclick: () => this.rewindDialog(s.id, when) }, t('bookmarks.rewind'))));
    }
  }
  private async bookmarkNow(): Promise<void> {
    const n = this.client.snapshots.filter((s) => s.kind === 'manual').length + 1;
    const r = await this.client.send({ t: 'bookmark', label: t('bookmarks.label', { n }), pos: [this.cam.cx, this.cam.cy], zoom: this.cam.zeta });
    this.toast(r.ok ? `⚑ ${t('bookmarks.label', { n })}` : t('powers.rejected', { reason: r.reason ?? '?' }));
  }
  rewindDialog(id: string, when: string): void {
    let close = () => {};
    const el = h('div', null, h('h3', null, t('bookmarks.rewind')), h('p', null, t('bookmarks.confirm', { when })),
      h('div', { class: 'actions' }, h('button', { onclick: () => close() }, t('common.cancel')),
        h('button', { class: 'danger', onclick: async () => {
          close();
          const r = await this.client.send({ t: 'rewind', snapshotId: id });
          this.toast(r.ok ? t('bookmarks.rewound', { when }) : t('powers.rejected', { reason: r.reason ?? '?' }));
        } }, t('bookmarks.rewind'))));
    close = this.dialog(el);
  }

  private settingsPanel(body: HTMLElement): void {
    const lang = h('select', { 'aria-label': t('settings.language'), onchange: (e: Event) => setLocale((e.target as HTMLSelectElement).value as Locale) },
      h('option', { value: 'en', selected: getLocale() === 'en' }, 'English'), h('option', { value: 'sv', selected: getLocale() === 'sv' }, 'Svenska'));
    const rm = h('input', { type: 'checkbox', id: 'pt-rm', checked: document.documentElement.classList.contains('reduced'), onchange: () => document.documentElement.classList.toggle('reduced', rm.checked) });
    const cap = h('input', { type: 'checkbox', id: 'pt-cap', checked: true, onchange: () => void this.client.send({ t: 'setting', key: 'views.captions', value: cap.checked }) });
    body.append(h('div', { class: 'col' },
      h('label', { class: 'row' }, t('settings.language'), lang),
      h('label', { class: 'row', for: 'pt-rm' }, rm, t('settings.reducedMotion')),
      h('label', { class: 'row', for: 'pt-cap' }, cap, t('settings.captions')),
      this.client.isMock ? h('p', { class: 'warn', style: 'font-size:12px' }, t('app.mockBanner')) : null));
  }

  // ---------------- helpers ----------------
  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.style.display = '';
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toastEl.style.display = 'none'; }, 4500);
  }
  dialog(content: HTMLElement): () => void {
    const el = h('div', { class: 'pt-dialog', role: 'dialog', 'aria-modal': 'false' }, content);
    this.dialogs.push(el);
    this.chrome.appendChild(el);
    const f = el.querySelector('button.primary, button.danger, input, button') as HTMLElement | null;
    f?.focus();
    return () => { el.remove(); this.dialogs = this.dialogs.filter((d) => d !== el); };
  }

  private onChange(c: string): void {
    if (c === 'welcome' || c === 'epoch') {
      if (!this.fitted) this.fit();
      PAL.length = 0;
      if (c === 'epoch') { this.toast(t('bookmarks.rewound', { when: `${t('time.day', { d: clockOf(this.client.tick, null).day })}` })); this.follow = -1; this.inspector.render(); }
    }
    if (c === 'stats') {
      if (this.client.selected) this.inspector.refresh();
      const sig = this.panel === 'bookmarks' ? this.client.snapshots.map((x) => x.id).join(',')
        : this.panel === 'stats' && this.statsTable ? this.client.species.map((x) => `${x.id}:${x.count}`).join(',') : '';
      if (sig && sig !== this.panelSig) { this.panelSig = sig; this.renderPanel(); }
      if (this.panel === 'map' && this.mapSpecies?.isConnected) { const n = this.speciesList(); this.mapSpecies.replaceWith(n); this.mapSpecies = n; }
    }
    if (c === 'genome') this.inspector.render();
  }

  // ---------------- camera and input ----------------
  private viewBox(): { x: number; y: number; w: number; h: number } {
    const left = RAIL_W + (this.panel && this.panel !== 'designer' ? this.panelWidth() : 0), right = this.inspOpen ? 320 : 0;
    return { x: left, y: 44, w: Math.max(200, window.innerWidth - left - right), h: Math.max(150, window.innerHeight - 44 - 64) };
  }
  private dpr(): number { return this.canvas.width / Math.max(1, this.canvas.clientWidth); }
  fit(): void {
    const tank = this.client.tank;
    const vb = { x: RAIL_W, y: 44, w: Math.max(200, window.innerWidth - RAIL_W - (this.inspOpen ? 320 : 0)), h: Math.max(150, window.innerHeight - 108) };
    const ppmCss = Math.min(vb.w / tank.w, vb.h / tank.h) * 0.96;
    const dpr = this.dpr();
    this.cam.zeta = Math.log2(ppmCss * dpr);
    this.cam.cx = tank.w / 2 - (vb.x + vb.w / 2 - window.innerWidth / 2) / ppmCss;
    this.cam.cy = tank.h / 2 - (vb.y + vb.h / 2 - window.innerHeight / 2) / ppmCss;
    this.fitted = true;
  }
  screenToWorld(sx: number, sy: number): [number, number] {
    const ppmCss = 2 ** this.cam.zeta / this.dpr();
    return [this.cam.cx + (sx - window.innerWidth / 2) / ppmCss, this.cam.cy + (sy - window.innerHeight / 2) / ppmCss];
  }
  worldToScreen(wx: number, wy: number): [number, number] {
    const ppmCss = 2 ** this.cam.zeta / this.dpr();
    return [(wx - this.cam.cx) * ppmCss + window.innerWidth / 2, (wy - this.cam.cy) * ppmCss + window.innerHeight / 2];
  }
  jumpTo(wx: number, wy: number): void {
    const vb = this.viewBox();
    const ppmCss = 2 ** this.cam.zeta / this.dpr();
    this.cam.cx = wx - (vb.x + vb.w / 2 - window.innerWidth / 2) / ppmCss;
    this.cam.cy = wy - (vb.y + vb.h / 2 - window.innerHeight / 2) / ppmCss;
  }
  zoomAt(sx: number, sy: number, factor: number): void {
    const [wx, wy] = this.screenToWorld(sx, sy);
    this.cam.zeta = Math.max(2, Math.min(12, this.cam.zeta + Math.log2(factor)));
    const [nx, ny] = this.screenToWorld(sx, sy);
    this.cam.cx += wx - nx; this.cam.cy += wy - ny;
  }
  camera(): Camera { return this.cam; }

  private installInput(): void {
    const cv = this.canvas;
    cv.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15); }, { passive: false });
    cv.addEventListener('pointerdown', (e) => { if (e.button === 0) this.drag = { x: e.clientX, y: e.clientY, cx: this.cam.cx, cy: this.cam.cy, moved: false }; });
    cv.addEventListener('pointermove', (e) => {
      this.hoverWorld = this.screenToWorld(e.clientX, e.clientY);
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true;
      if (this.drag.moved && this.cast.state.s !== 'armed') {
        const ppmCss = 2 ** this.cam.zeta / this.dpr();
        this.cam.cx = this.drag.cx - dx / ppmCss; this.cam.cy = this.drag.cy - dy / ppmCss; this.follow = -1;
      }
    });
    cv.addEventListener('pointerleave', () => { this.hoverWorld = null; });
    cv.addEventListener('pointerup', (e) => {
      const d = this.drag; this.drag = null;
      if (d && d.moved) return;
      this.viewportClick(e.clientX, e.clientY);
    });
    cv.addEventListener('dblclick', () => { if (this.client.selectedId >= 0) { this.follow = this.client.selectedId; this.inspector.render(); } });
    cv.addEventListener('contextmenu', (e) => { e.preventDefault(); this.cast.cancel(); this.openPanel('powers'); });
    this.miniCanvas.addEventListener('click', (e) => { const r = this.miniCanvas.getBoundingClientRect(); this.jumpTo(((e.clientX - r.left) / r.width) * this.client.tank.w, ((e.clientY - r.top) / r.height) * this.client.tank.h); this.follow = -1; });
    this.timeCanvas.addEventListener('mousemove', (e) => {
      const r = this.timeCanvas.getBoundingClientRect(); const x = e.clientX - r.left; this.tlHover = x;
      const hit = this.nearestHit(x);
      if (hit) {
        this.tlCard.style.display = ''; this.tlCard.style.left = `${Math.min(window.innerWidth - 370, Math.max(8, e.clientX - 60))}px`;
        this.tlCard.textContent = hit.snap ? `⚑ ${hit.snap.name} · ${t('bookmarks.rewind')}` : this.eventText(hit.ev!);
      } else this.tlCard.style.display = 'none';
    });
    this.timeCanvas.addEventListener('mouseleave', () => { this.tlHover = -1; this.tlCard.style.display = 'none'; });
    this.timeCanvas.addEventListener('click', (e) => {
      const r = this.timeCanvas.getBoundingClientRect(); const hit = this.nearestHit(e.clientX - r.left);
      if (!hit) return;
      if (hit.snap) { const ck = clockOf(hit.snap.tick, null); this.rewindDialog(hit.snap.id, `${t('time.day', { d: ck.day })} ${String(ck.hh).padStart(2, '0')}:${String(ck.mm).padStart(2, '0')}`); return; }
      const ev = hit.ev!; const pos = 'pos' in ev ? ev.pos : 'centroid' in ev ? ev.centroid : null;
      if (pos) { this.jumpTo(pos[0], pos[1]); this.follow = -1; }
    });
    window.addEventListener('resize', () => { if (!this.fitted) this.fit(); });
    window.addEventListener('keydown', (e) => this.key(e));
    document.addEventListener('paste', (e) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const txt = e.clipboardData?.getData('text') ?? '';
      if (txt.trim().startsWith('PTK1.')) { e.preventDefault(); this.importInput(txt); }
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) this.importInput(new Uint8Array(await f.arrayBuffer()));
      else { const s = e.dataTransfer?.getData('text') ?? ''; if (s.startsWith('PTK1.')) this.importInput(s); }
    });
  }
  private nearestHit(x: number): TimelineHit | null {
    let best: TimelineHit | null = null, bd = 6;
    for (const hh of this.tlHits) { const d = Math.abs(hh.x - x); if (d < bd) { bd = d; best = hh; } }
    return best;
  }
  eventText(e: import('../../core/index.js').SimEvent): string {
    const sp = (id: number) => this.client.speciesName(id);
    switch (e.k) {
      case 'speciation': return t('event.newSpecies', { species: sp(e.child), parent: sp(e.parent) });
      case 'extinction': return t('event.extinct', { species: sp(e.species) });
      case 'god': return t('event.god', { power: tk(`power.${e.power}`) });
      case 'release': return t('event.release', { species: sp(e.species), n: e.count });
      case 'giant': return t('event.giant', { species: sp(e.species) });
      case 'hunt': return t('event.hunt', { species: sp(this.speciesOfEntity(e.pred) ?? -1) });
      case 'massDeath': return t('event.massDeath', { n: e.deaths });
      case 'record': return t('event.record', { kind: e.kind });
      case 'outbreak': return t('event.outbreak');
      default: return t('event.other', { k: e.k });
    }
  }
  private speciesOfEntity(id: number): number | undefined { for (const v of this.client.slots.values()) if (v.id === id) return v.species; return undefined; }

  private viewCentre(): [number, number] { const vb = this.viewBox(); return this.screenToWorld(vb.x + vb.w / 2, vb.y + vb.h / 2); }
  targetCentre(): void {
    const st = this.cast.state;
    if (st.s !== 'armed' && st.s !== 'previewing') return;
    const [wx, wy] = this.viewCentre();
    const sp = POWER_SPECS[st.power];
    this.cast.target(sp?.targeting === 'circle' ? { kind: 'circle', pos: [wx, wy], radius: this.cast.radius() } : sp?.targeting === 'depthBand' ? { kind: 'depthBand', y0: Math.max(0, wy - 2), y1: wy + 2 } : { kind: 'point', pos: [wx, wy] });
  }
  /** Select the creature nearest the view centre (keyboard inspect). */
  selectCentre(): void {
    const [wx, wy] = this.viewCentre();
    const hit = this.client.pick(wx, wy, 1e9);
    if (hit) { this.client.select(hit.id); if (!this.inspOpen) this.toggleInspector(); this.inspector.render(); }
  }
  /** Jump to the next (or previous) located event on the timeline. */
  jumpEvent(dir: 1 | -1): void {
    const evs = this.client.events.filter((e) => 'pos' in e || 'centroid' in e);
    if (!evs.length) return;
    this.evCursor = Math.max(0, Math.min(evs.length - 1, (this.evCursor < 0 ? evs.length : this.evCursor) + dir));
    const e = evs[this.evCursor]!;
    const pos = 'pos' in e ? e.pos : (e as { centroid: [number, number] }).centroid;
    this.jumpTo(pos[0], pos[1]); this.follow = -1;
    this.toast(this.eventText(e));
  }
  private evCursor = -1;

  private viewportClick(sx: number, sy: number): void {
    const [wx, wy] = this.screenToWorld(sx, sy);
    const st = this.cast.state;
    if (st.s === 'armed' || st.s === 'previewing') {
      const sp = POWER_SPECS[st.power];
      if (sp && sp.targeting !== 'global' && sp.targeting !== 'species') {
        const tg: Target = sp.targeting === 'circle' ? { kind: 'circle', pos: [wx, wy], radius: this.cast.radius() }
          : sp.targeting === 'depthBand' ? { kind: 'depthBand', y0: Math.max(0, wy - 2), y1: wy + 2 }
          : sp.targeting === 'creature' ? { kind: 'creature', entity: this.client.pick(wx, wy, 1)?.id ?? -1 } : { kind: 'point', pos: [wx, wy] };
        this.cast.target(tg);
        return;
      }
    }
    const ppmCss = 2 ** this.cam.zeta / this.dpr();
    const hit = this.client.pick(wx, wy, 14 / ppmCss);
    if (hit) {
      this.client.select(hit.id);
      if (!this.inspOpen) this.toggleInspector();
      this.inspector.render();
    }
  }

  private key(e: KeyboardEvent): void {
    const tg = e.target as HTMLElement;
    const typing = tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT');
    if (e.key === 'Escape') {
      if (this.dialogs.length) { this.dialogs[this.dialogs.length - 1]!.remove(); this.dialogs.pop(); return; }
      if (this.cast.state.s !== 'idle') { this.cast.cancel(); return; }
      this.openPanel(null); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && this.panel === 'designer') { e.preventDefault(); if (e.shiftKey) this.designer.redo(); else this.designer.undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.designer.save(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); void this.bookmarkNow(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); this.openPanel('settings'); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const pan = 40 / (2 ** this.cam.zeta / this.dpr());
    switch (e.key) {
      case ' ': if (tg.tagName === 'BUTTON') return; e.preventDefault(); void this.client.setSpeed(this.client.speed.requested === 0 ? 1 : 0); break;
      case '1': void this.client.setSpeed(1); break;
      case '2': void this.client.setSpeed(4); break;
      case '3': void this.client.setSpeed(16); break;
      case '4': void this.client.setSpeed('max'); break;
      case '5': void this.client.setSpeed(0); break;
      case 'ArrowLeft': this.cam.cx -= pan; break;
      case 'ArrowRight': this.cam.cx += pan; break;
      case 'ArrowUp': this.cam.cy -= pan; break;
      case 'ArrowDown': this.cam.cy += pan; break;
      case '+': case '=': this.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.2); break;
      case '-': this.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.2); break;
      case 'c': case 'C': this.selectCentre(); break;
      case 'n': this.jumpEvent(1); break;
      case 'N': this.jumpEvent(-1); break;
      case 'f': case 'F': this.follow = this.follow >= 0 ? -1 : this.client.selectedId; this.inspector.render(); break;
      case 'i': case 'I': this.toggleInspector(); break;
      case 'g': case 'G': if (this.panel === 'designer') this.designer.toggleMode(); break;
      case 'Delete': if (this.panel === 'designer') this.designer.deleteSelected(); break;
      case 'm': case 'M': this.openPanel(this.panel === 'map' ? null : 'map'); break;
      case 'p': case 'P': this.openPanel(this.panel === 'powers' ? null : 'powers'); break;
      case 'd': case 'D': this.openPanel(this.panel === 'designer' ? null : 'designer'); break;
      case 'l': case 'L': this.openPanel(this.panel === 'library' ? null : 'library'); break;
      case 's': case 'S': this.openPanel(this.panel === 'stats' ? null : 'stats'); break;
      case 't': case 'T': case 'b': case 'B': this.openPanel(this.panel === 'bookmarks' ? null : 'bookmarks'); break;
      case 'Enter': if (this.cast.state.s === 'previewing' && !e.repeat && tg.tagName !== 'BUTTON') this.cast.confirmDown(performance.now()); break;
      default: return;
    }
  }

  // ---------------- per frame ----------------
  frame(now: number): void {
    if (!this.fitted && this.client.welcome) this.fit();
    if (this.follow >= 0) {
      const p = this.client.positionOf(this.follow);
      if (p) { const vb = this.viewBox(); const ppmCss = 2 ** this.cam.zeta / this.dpr(); const tx = p[0] - (vb.x + vb.w / 2 - window.innerWidth / 2) / ppmCss, ty = p[1] - (vb.y + vb.h / 2 - window.innerHeight / 2) / ppmCss; this.cam.cx += (tx - this.cam.cx) * 0.08; this.cam.cy += (ty - this.cam.cy) * 0.08; }
    }
    this.cast.update(now);
    if (this.holdFill) this.holdFill.style.width = `${this.cast.holdProgress(now) * 100}%`;
    if (this.cast.state.s === 'countdown') {
      const left = this.cast.countdownLeft(now);
      this.countEl.style.display = '';
      const p = tk(`power.${this.cast.state.power}`);
      this.countEl.textContent = this.client.speed.requested === 0 ? t('powers.countdownPaused', { power: p }) : t('powers.countdown', { power: p, s: fmtNum(Math.ceil(left * 10) / 10, 1) });
    } else this.countEl.style.display = 'none';
    this.drawOverlay(now);
    this.drawMini(now);
    if (now - this.lastTl > 200) {
      this.lastTl = now;
      const tl = prep(this.timeCanvas, 64);
      this.tlHits = drawTimeline(tl.c, tl.w, 64, this.client.events, this.client.snapshots, this.client.tick, 30 * 60 * 8, this.filters, this.tlHover);
    }
    if (this.panel === 'designer') this.designer.frame(now);
    this.inspector.frame();
    if (now - this.lastSlow > 500) {
      this.lastSlow = now;
      this.renderTop();
      this.updatePreviewCount();
      this.drawPanelCanvas();
    }
  }
  private palette(): number[][] {
    if (PAL.length === 0) for (const s of this.client.species) PAL[s.id % 16] = [...s.colour];
    return PAL;
  }
  private drawMini(now: number): void {
    if (this.mini.style.display === 'none' && !this.mapCanvas) return;
    if (now - this.lastMini < 100) return;
    this.lastMini = now;
    const tank = this.client.tank;
    const [x0, y0] = this.screenToWorld(this.viewBox().x, this.viewBox().y);
    const [x1, y1] = this.screenToWorld(this.viewBox().x + this.viewBox().w, this.viewBox().y + this.viewBox().h);
    const godEvents = this.client.events.filter((e) => e.k === 'god').slice(-6).map((e) => ({ pos: (e as { pos: [number, number] }).pos, radius: (e as { radius: number }).radius, age: (this.client.tick - e.t) / 1800 }));
    const vents = [[24, 17.2]] as [number, number][];
    const sel = this.client.selected?.species;
    const slotSp = (s: number) => this.client.slots.get(s)?.species;
    for (const cv of [this.miniCanvas, this.mapCanvas]) {
      if (!cv || (cv === this.miniCanvas && this.mini.style.display === 'none')) continue;
      const { c, w, h: hh } = prep(cv);
      drawMinimap(c, w, hh, tank, this.client.dust, this.palette(), [x0, y0, x1, y1], this.layers, vents, godEvents, cv === this.mapCanvas ? sel : undefined, slotSp);
    }
  }
  private drawPanelCanvas(): void {
    const cv = this.panelCanvas;
    if (!cv || !cv.isConnected) return;
    const { c, w, h: hh } = prep(cv);
    const sp = this.client.species;
    switch (this.statsTab) {
      case 'population': drawPopulation(c, w, hh, this.client.history, sp, this.statsLog, this.client.events); break;
      case 'phylogeny': drawPhylogeny(c, w, hh, sp, this.client.tick); break;
      case 'genes': {
        const g = this.client.genes[this.geneTrait] ?? {};
        const series = Object.entries(g).slice(0, 6).map(([id, bins]) => ({ bins, colour: sp.find((s) => s.id === Number(id))?.colour ?? [200, 200, 200], label: this.client.speciesName(Number(id)) }));
        drawHistogram(c, w, hh, series);
        c.font = '12px system-ui';
        series.forEach((s, i) => { c.fillStyle = rgb(s.colour); c.fillText(`■ ${s.label}`, 14, 18 + i * 15); });
        break;
      }
      case 'diversity': {
        const s = diversitySeries(this.client.history);
        drawLines(c, w, hh, [
          { label: 'S', colour: '#62d2e8', values: s.map((x) => x.richness) },
          { label: 'exp(H′)', colour: '#8ee0a0', values: s.map((x) => x.effective), dash: [5, 3] },
          { label: 'Simpson', colour: '#e8c06a', values: s.map((x) => x.simpson), dash: [2, 2] },
        ]);
      }
    }
  }
  private drawOverlay(now: number): void {
    const cv = this.overlay;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(window.innerWidth * dpr), H = Math.round(window.innerHeight * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const c = cv.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const ppmCss = 2 ** this.cam.zeta / this.dpr();
    // tank outline
    const tank = this.client.tank;
    const [tx0, ty0] = this.worldToScreen(0, 0), [tx1, ty1] = this.worldToScreen(tank.w, tank.h);
    c.strokeStyle = 'rgba(120,190,210,.18)'; c.lineWidth = 1; c.strokeRect(tx0, ty0, tx1 - tx0, ty1 - ty0);
    // selection
    if (this.client.selectedId >= 0) {
      const p = this.client.positionOf(this.client.selectedId);
      if (p) {
        const [sx, sy] = this.worldToScreen(p[0], p[1]);
        c.strokeStyle = 'rgba(255,230,160,.9)'; c.lineWidth = 1.5;
        c.beginPath(); c.arc(sx, sy, 11, 0, Math.PI * 2); c.stroke();
        c.beginPath(); c.moveTo(sx + 11, sy - 11); c.lineTo(sx + 22, sy - 22); c.stroke();
      }
    }
    // targeting preview
    const st = this.cast.state;
    let tg: Target | null = st.s === 'previewing' || st.s === 'holding' || st.s === 'sending' ? st.target : null;
    if (st.s === 'armed' && this.hoverWorld) {
      const sp = POWER_SPECS[st.power];
      if (sp?.targeting === 'circle') tg = { kind: 'circle', pos: this.hoverWorld, radius: this.cast.radius() };
      else if (sp?.targeting === 'point') tg = { kind: 'point', pos: this.hoverWorld };
    }
    if (tg) {
      const major = 'power' in st && isMajorPower(st.power, this.cast.intensity);
      c.strokeStyle = major ? 'rgba(239,140,114,.85)' : 'rgba(98,210,232,.85)';
      c.fillStyle = major ? 'rgba(239,140,114,.08)' : 'rgba(98,210,232,.07)';
      c.lineWidth = 1.5; c.setLineDash(st.s === 'armed' ? [5, 4] : []);
      if (tg.kind === 'circle' || tg.kind === 'point') {
        const [sx, sy] = this.worldToScreen(tg.pos[0], tg.pos[1]);
        const r = (tg.kind === 'circle' ? tg.radius : 1.5) * ppmCss;
        c.beginPath(); c.arc(sx, sy, r, 0, Math.PI * 2); c.fill(); c.stroke();
        const hp = this.cast.holdProgress(now);
        if (hp > 0) { c.lineWidth = 4; c.setLineDash([]); c.beginPath(); c.arc(sx, sy, r + 6, -Math.PI / 2, -Math.PI / 2 + hp * Math.PI * 2); c.stroke(); }
      } else if (tg.kind === 'depthBand') {
        const [, y0] = this.worldToScreen(0, tg.y0), [, y1] = this.worldToScreen(0, tg.y1);
        c.fillRect(tx0, y0, tx1 - tx0, y1 - y0); c.strokeRect(tx0, y0, tx1 - tx0, y1 - y0);
      } else if (tg.kind === 'global') { c.strokeRect(tx0 + 3, ty0 + 3, tx1 - tx0 - 6, ty1 - ty0 - 6); }
      c.setLineDash([]);
    }
    // recent god events fade over their aftermath
    for (const e of this.client.events.slice(-30)) {
      if (e.k !== 'god') continue;
      const age = (this.client.tick - e.t) / (30 * 20);
      if (age > 1 || age < 0) continue;
      const [sx, sy] = this.worldToScreen(e.pos[0], e.pos[1]);
      c.strokeStyle = `rgba(255,200,150,${(1 - age) * 0.6})`; c.lineWidth = 2;
      c.beginPath(); c.arc(sx, sy, Math.min(4000, e.radius * ppmCss * (1 + age * 0.3)), 0, Math.PI * 2); c.stroke();
    }
  }
}

function canonical(g: Uint8Array): Uint8Array { return encodeGenome(decodeGenome(g)); }
void designString; void packDesign; void downloadPtkg;
export type { PowerId };
