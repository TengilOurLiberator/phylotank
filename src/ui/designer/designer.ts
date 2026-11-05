/**
 * Designer view (07 §1): gene sliders generated from TRAITS and BRAIN_TRAITS, a part editor over
 * growth rules, a growth strip, a toy test tank, the energy budget estimate, warn-never-forbid
 * issues, and the Release / Release as leviathan / Save / Share actions. Both editors read and
 * write the same genome bytes through ./model.ts.
 */
import {
  BRAIN_TRAITS, decodeGenome, decodeQ, encodeGenome, GENOME_FLAG_LEVIATHAN, KIND, MODULE_RECORD, SYMMETRY, TRAITS,
  type DesignMeta, type TemplateId, type TraitSpec,
} from '../../core/index.js';
import { h, mount, binomial } from '../dom.js';
import { fmtDuration, fmtLength, fmtNum, getLocale, t, tk, type MsgKey } from '../i18n.js';
import { drawBody, growBody, pickPart, type GrownBody } from './body.js';
import { anyInviable, computeBudget, tradeoffs, validate, type Budget, type Issue, type Tradeoff } from './budget.js';
import { designString, fingerprint, makeMeta, packDesign, type Library } from './library.js';
import {
  addPart, breakOut, countKind, deleteRule, duplicateRule, fromX, getModule, getTrait, History, linksTo, moduleFieldValue,
  sameBytes, setLinkField, setModuleField, setTrait, tableOf, toX, view, type ModuleField, type TraitTable,
} from './model.js';
import { drawQr, encodeQr } from './qr.js';
import { TEMPLATES, templateGenome, templateInfo } from './templates.js';

export interface DesignerHost {
  library: Library;
  toast(msg: string): void;
  dialog(el: HTMLElement): () => void;
  release(ptkg: Uint8Array, opts: { count: number; pos: [number, number]; asLeviathan: boolean; founderProtection: boolean }): Promise<{ ok: boolean; reason?: string }>;
  tank(): { w: number; h: number };
  lCeiling(): number;
  canRelease(): boolean;
}

interface Doc { genome: Uint8Array; genus: string; epithet: string; common: string; notes: string; origin: DesignMeta['origin']; parents: string[]; libraryId?: string; template?: TemplateId }

const GROUP_ORDER = ['Life', 'Reproduction', 'Diet', 'Body', 'Shape', 'Senses', 'Habitat', 'Health', 'Look', 'Mating', 'Behaviour', 'Mutation', 'Brain', 'Instinct', 'Personality', 'Drives', 'Plasticity', 'Advanced'] as const;
const BRAIN_GROUPS = new Set(['Instinct', 'Personality', 'Drives', 'Plasticity']);
const PARTS_OWNED = new Set(['G_FIN', 'G_EYE', 'G_MOUTH', 'G_SPIKE', 'G_LIMB_LENGTH', 'G_PHOTOPHORE']);

interface Locus { table: TraitTable; spec: TraitSpec; group: string }
function loci(): Locus[] {
  const out: Locus[] = [];
  for (const s of TRAITS) if (s) out.push({ table: 'T', spec: s, group: s.group === 'hidden' ? 'Advanced' : s.group === 'Size' ? 'Life' : s.group });
  for (const s of BRAIN_TRAITS) if (s && !s.immutable) out.push({ table: 'B', spec: s, group: s.group });
  return out;
}
const LOCI = loci();

function prettyName(n: string): string { return n.toLowerCase().replace(/_/g, ' ').replace(/^g /, 'scale: ').replace(/^\w/, (c) => c.toUpperCase()); }
function showValue(spec: TraitSpec, v: number): string {
  switch (spec.name) {
    case 'ADULT_LENGTH': return fmtLength(v);
    case 'TEMP_OPTIMUM': case 'TEMP_TOLERANCE': return `${fmtNum(v, 1)} °C`;
    case 'MU_LOG': return `${fmtNum(10 ** v * 1000, 2)}‰`;
    case 'MUSCLE_STRENGTH': return `${fmtNum(v / 1000, 0)} kPa`;
    case 'PULSE_FREQ': case 'F_LOW': case 'F_HIGH': return `${fmtNum(v, 2)} Hz`;
    case 'TAU_FORGET': return fmtDuration(v);
    default: return spec.scale === 'int' || spec.name === 'CLUTCH_SIZE' ? fmtNum(Math.round(v), 0) : fmtNum(v, Math.abs(v) >= 10 ? 1 : 2);
  }
}

export class DesignerView {
  readonly el: HTMLDivElement;
  private doc!: Doc;
  private saved: Uint8Array | null = null;
  private history = new History();
  private mode: 'genes' | 'parts' = 'genes';
  private group = 'Life';
  private sel: { rule: number; link: number; copy: number } | null = null;
  private age = 1;
  private playing = false;
  private playStart = 0;
  private focusTrait: string | null = null;
  private body!: GrownBody;
  private adult!: GrownBody;
  private budget!: Budget;
  private issues: Issue[] = [];
  private fp = '';
  private chips: Tradeoff[] = [];
  private chipTimer: ReturnType<typeof setTimeout> | null = null;
  private tankSeed = 1;
  private tankT0 = 0;
  // live elements
  private growthCanvas: HTMLCanvasElement | null = null;
  private tankCanvas: HTMLCanvasElement | null = null;
  private skeleton: HTMLCanvasElement | null = null;
  private skeletonMap: { scale: number; ox: number; oy: number } | null = null;
  private footEl: HTMLElement | null = null;
  private headEl: HTMLElement | null = null;
  private ageLabel: HTMLElement | null = null;
  private tankLabel: HTMLElement | null = null;

  constructor(private readonly host: DesignerHost) {
    this.el = h('div', { style: 'display:flex;flex-direction:column;height:100%' });
    this.openTemplate('meadowlamp');
  }

  // ---------------- documents ----------------
  openTemplate(id: TemplateId): void {
    const info = templateInfo(id);
    this.open(encodeGenome(templateGenome(id)), { genus: info.genus, epithet: info.epithet, common: getLocale() === 'sv' ? info.nameSv : info.name, origin: 'template', template: id });
  }
  open(genome: Uint8Array, o: Partial<Doc> & { genus: string; epithet: string }): void {
    this.doc = { genome, genus: o.genus, epithet: o.epithet, common: o.common ?? '', notes: o.notes ?? '', origin: o.origin ?? 'designer', parents: o.parents ?? [],
      ...(o.libraryId ? { libraryId: o.libraryId } : {}), ...(o.template ? { template: o.template } : {}) };
    this.saved = o.origin === 'template' ? null : genome;
    this.history = new History();
    this.sel = null;
    this.recompute();
    this.render();
  }
  get genome(): Uint8Array { return this.doc.genome; }
  get dirty(): boolean { return !this.saved || !sameBytes(this.saved, this.doc.genome); }
  meta(): DesignMeta {
    return makeMeta(this.doc.genus, this.doc.epithet, this.doc.origin === 'template' ? 'designer' : this.doc.origin,
      { name: { genus: this.doc.genus, epithet: this.doc.epithet, ...(this.doc.common ? { common: this.doc.common } : {}) }, notes: this.doc.notes, parents: this.doc.parents });
  }

  private commit(next: Uint8Array, label: string, coalesce?: string): void {
    if (sameBytes(next, this.doc.genome)) return;
    this.history.push({ before: this.doc.genome, after: next, label, ...(coalesce ? { coalesce } : {}) });
    this.doc.genome = next;
    this.recompute();
  }
  undo(): void { const b = this.history.undo(); if (b) { this.doc.genome = b; this.recompute(); this.render(); } }
  redo(): void { const b = this.history.redo(); if (b) { this.doc.genome = b; this.recompute(); this.render(); } }

  private recompute(): void {
    const g = view(this.doc.genome);
    const L = this.host.lCeiling();
    this.adult = growBody(g, 1, L);
    this.body = this.age >= 0.999 ? this.adult : growBody(g, this.age, L);
    this.budget = computeBudget(g, this.adult);
    this.issues = validate(g, this.adult, this.budget, { count: 20, asLeviathan: false }, { tempMinC: 4, tempMaxC: 22, lCeilingM: L });
    this.tankT0 = performance.now();
    const bytes = this.doc.genome;
    // trade-off chips are 26 extra evaluations: compute them when the edits pause
    if (this.chipTimer) clearTimeout(this.chipTimer);
    this.chipTimer = setTimeout(() => {
      if (bytes !== this.doc.genome) return;
      this.chips = tradeoffs(view(bytes), (gg) => growBody(gg, 1, L));
      this.renderFoot();
    }, 250);
    void fingerprint(bytes).then((fp) => { if (bytes === this.doc.genome) { this.fp = fp; this.renderHead(); } });
  }

  // ---------------- rendering ----------------
  render(): void {
    this.headEl = h('div', { class: 'dhead' });
    const grid = h('div', { class: 'dz grow', style: 'min-height:0' });
    if (this.mode === 'genes') grid.append(this.groupsCol(), this.slidersCol(), this.previewCol());
    else grid.append(this.paletteCol(), this.skeletonCol(), this.ruleCol());
    this.footEl = h('div', { class: 'foot' });
    grid.append(this.footEl);
    mount(this.el, this.headEl, grid);
    this.renderHead();
    this.renderFoot();
  }

  private renderHead(): void {
    if (!this.headEl) return;
    const inviable = anyInviable(this.issues);
    const tmpl = h('select', { 'aria-label': t('designer.template'), onchange: (e: Event) => this.openTemplate((e.target as HTMLSelectElement).value as TemplateId) },
      ...TEMPLATES.map((x) => h('option', { value: x.id, selected: x.id === this.doc.template }, getLocale() === 'sv' ? x.nameSv : x.name)));
    const leviathan = (view(this.doc.genome).flags & GENOME_FLAG_LEVIATHAN) !== 0;
    mount(this.headEl,
      h('strong', null, t('designer.title')), ':',
      h('input', { type: 'text', value: this.doc.genus, 'aria-label': t('designer.genus'), style: 'width:120px;font-style:italic', oninput: (e: Event) => { this.doc.genus = (e.target as HTMLInputElement).value; } }),
      h('input', { type: 'text', value: this.doc.epithet, 'aria-label': t('designer.epithet'), style: 'width:110px;font-style:italic', oninput: (e: Event) => { this.doc.epithet = (e.target as HTMLInputElement).value; } }),
      this.doc.common ? h('span', { class: 'dim' }, `(${this.doc.common})`) : null,
      this.dirty ? h('span', { class: 'warn', style: 'font-size:11px' }, `● ${t('designer.dirty')}`) : null,
      leviathan ? h('span', { class: 'sev inviable' }, t('designer.leviathanFlag')) : null,
      h('span', { class: 'faint', style: 'font-size:11px;font-family:ui-monospace,monospace' }, this.fp ? t('designer.fingerprint', { fp: this.fp }) : ''),
      h('span', { class: 'grow' }),
      tmpl,
      h('div', { class: 'tabs', role: 'tablist' },
        h('button', { role: 'tab', 'aria-selected': String(this.mode === 'genes'), class: this.mode === 'genes' ? 'on' : '', onclick: () => this.setMode('genes') }, t('designer.genes')),
        h('button', { role: 'tab', 'aria-selected': String(this.mode === 'parts'), class: this.mode === 'parts' ? 'on' : '', onclick: () => this.setMode('parts') }, t('designer.parts'))),
      h('button', { onclick: () => this.undo(), disabled: !this.history.canUndo, title: 'Ctrl+Z' }, t('designer.undo')),
      h('button', { onclick: () => this.redo(), disabled: !this.history.canRedo, title: 'Ctrl+Shift+Z' }, t('designer.redo')),
      h('button', { onclick: () => this.save(), title: 'Ctrl+S' }, t('designer.save')),
      h('button', { onclick: () => this.share() }, t('designer.share')),
      h('button', { class: 'primary', onclick: () => this.releaseDialog(false), disabled: !this.host.canRelease() }, inviable ? t('designer.releaseAnyway') : t('designer.release')),
      h('button', { class: 'danger', onclick: () => this.releaseDialog(true), disabled: !this.host.canRelease() }, t('designer.releaseLeviathan')),
    );
  }

  setMode(m: 'genes' | 'parts'): void { this.mode = m; this.render(); }
  toggleMode(): void { this.setMode(this.mode === 'genes' ? 'parts' : 'genes'); }

  private groupsCol(): HTMLElement {
    const groups = GROUP_ORDER.filter((g) => LOCI.some((l) => l.group === g));
    return h('nav', { class: 'groups', 'aria-label': 'Gene groups' }, ...groups.map((g) =>
      h('button', { class: g === this.group ? 'on' : '', onclick: () => { this.group = g; this.render(); } }, g === 'Advanced' ? t('designer.group.Advanced') : g)));
  }

  private slidersCol(): HTMLElement {
    const col = h('div', { class: 'mid' });
    const list = LOCI.filter((l) => l.group === this.group);
    if (BRAIN_GROUPS.has(this.group)) col.append(h('div', { class: 'subhead' }, t('designer.instinct')));
    if (this.group === 'Body' || this.group === 'Senses' || this.group === 'Shape') {
      col.append(h('div', null,
        h('button', { class: 'ro-chip', onclick: () => this.setMode('parts') }, t('designer.eyesChip', { n: countKind(this.doc.genome, KIND.EYE) })),
        h('button', { class: 'ro-chip', onclick: () => this.setMode('parts') }, t('designer.finsChip', { n: countKind(this.doc.genome, KIND.FIN) }))));
    }
    for (const l of list) col.append(this.slider(l));
    if (this.group === 'Diet') col.append(this.dietTriangle());
    return col;
  }

  /** Diet triangle (07 §1.2): a barycentric picker over the enzyme simplex of CONTRACT 9.3. */
  private dietTriangle(): HTMLElement {
    const W = 240, H = 200;
    const A: [number, number] = [W / 2, 18], B: [number, number] = [20, H - 22], C: [number, number] = [W - 20, H - 22]; // plant, meat, detritus
    const cv = h('canvas', { width: W, height: H, style: `width:${W}px;height:${H}px;cursor:crosshair;touch-action:none`, role: 'img', 'aria-label': 'Diet triangle: plant, meat, detritus' });
    const label = h('div', { class: 'dim', style: 'font-size:12px' });
    const draw = () => {
      const g = view(this.doc.genome);
      const x1 = decodeQ(g.traits[20]!, TRAITS[20]!), x2 = decodeQ(g.traits[21]!, TRAITS[21]!);
      const e = [x1 * (1 - x2), (1 - x1) * (1 - x2), x2];
      const c = cv.getContext('2d')!;
      c.clearRect(0, 0, W, H);
      c.beginPath(); c.moveTo(...A); c.lineTo(...B); c.lineTo(...C); c.closePath();
      c.fillStyle = 'rgba(98,210,232,.06)'; c.fill(); c.strokeStyle = 'rgba(120,190,210,.5)'; c.stroke();
      c.fillStyle = 'rgba(200,225,232,.85)'; c.font = '11px system-ui'; c.textAlign = 'center';
      c.fillText('plant', A[0], A[1] - 6); c.textAlign = 'left'; c.fillText('meat', B[0] - 8, B[1] + 16); c.textAlign = 'right'; c.fillText('detritus', C[0] + 8, C[1] + 16); c.textAlign = 'left';
      const px = e[0]! * A[0] + e[1]! * B[0] + e[2]! * C[0], py = e[0]! * A[1] + e[1]! * B[1] + e[2]! * C[1];
      c.fillStyle = '#e8c06a'; c.beginPath(); c.arc(px, py, 6, 0, Math.PI * 2); c.fill();
      label.textContent = `plant ${fmtNum(e[0]!, 2)} · meat ${fmtNum(e[1]!, 2)} · detritus ${fmtNum(e[2]!, 2)}`;
    };
    const set = (ev: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / r.width) * W, y = ((ev.clientY - r.top) / r.height) * H;
      // barycentric coordinates, clamped onto the triangle
      const det = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
      let a = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / det;
      let b = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / det;
      a = Math.max(0, a); b = Math.max(0, b);
      let cc = Math.max(0, 1 - a - b);
      const sum = a + b + cc; a /= sum; b /= sum; cc /= sum;
      const x2 = cc, x1 = x2 >= 0.999 ? 0.5 : a / (1 - x2);
      const next = setTrait(setTrait(this.doc.genome, 'T', 20, x1), 'T', 21, x2);
      this.commit(next, 'diet', 'diet');
      draw(); this.liveRefresh();
    };
    let dragging = false;
    cv.addEventListener('pointerdown', (e) => { dragging = true; cv.setPointerCapture(e.pointerId); set(e); });
    cv.addEventListener('pointermove', (e) => { if (dragging) set(e); });
    cv.addEventListener('pointerup', () => { dragging = false; this.history.seal(); this.render(); });
    draw();
    return h('div', { class: 'card', style: 'margin-top:10px;display:flex;gap:14px;align-items:center' }, cv,
      h('div', { class: 'col' }, label, h('div', { class: 'faint', style: 'font-size:11px' }, 'Enzyme simplex (CONTRACT 9.3): the three always sum to 1. Drag the dot, or use the two sliders.')));
  }

  private slider(l: Locus): HTMLElement {
    const v = getTrait(this.doc.genome, l.table, l.spec.idx);
    const val = h('input', { type: 'text', value: showValue(l.spec, v), 'aria-label': `${prettyName(l.spec.name)} value`, style: 'width:92px;text-align:right;font-size:12px' });
    const range = h('input', { type: 'range', min: 0, max: 1000, step: 1, value: String(Math.round(toX(l.spec, v) * 1000)), 'aria-label': prettyName(l.spec.name) });
    const key = `${l.table}${l.spec.idx}`;
    const owned = PARTS_OWNED.has(l.spec.name);
    range.addEventListener('input', (e) => {
      const fine = (e as InputEvent & { shiftKey?: boolean }).shiftKey;
      void fine;
      const x = Number(range.value) / 1000;
      this.commit(setTrait(this.doc.genome, l.table, l.spec.idx, fromX(l.spec, x)), l.spec.name, key);
      val.value = showValue(l.spec, getTrait(this.doc.genome, l.table, l.spec.idx));
      this.liveRefresh();
    });
    range.addEventListener('change', () => { this.history.seal(); this.renderHead(); this.renderFoot(); });
    range.addEventListener('dblclick', () => {
      const def = this.doc.template ? getTrait(encodeGenome(templateGenome(this.doc.template)), l.table, l.spec.idx) : l.spec.def;
      this.commit(setTrait(this.doc.genome, l.table, l.spec.idx, def), `reset ${l.spec.name}`);
      this.render();
    });
    val.addEventListener('change', () => {
      const n = Number(val.value.replace(',', '.').replace(/[^0-9.eE+-]/g, ''));
      if (Number.isFinite(n)) {
        const scaled = l.spec.name === 'MU_LOG' ? Math.log10(n / 1000) : l.spec.name === 'ADULT_LENGTH' ? (/mm/.test(val.value) ? n / 1000 : /cm/.test(val.value) ? n / 100 : n) : l.spec.name === 'MUSCLE_STRENGTH' ? n * 1000 : n;
        this.commit(setTrait(this.doc.genome, l.table, l.spec.idx, scaled), l.spec.name);
      }
      this.render();
    });
    return h('div', { class: `slider${this.focusTrait === l.spec.name ? ' hl' : ''}`, title: `${l.spec.name} (${l.spec.min} to ${l.spec.max}, ${l.spec.scale})${owned ? ' · also editable in Parts' : ''}` },
      h('label', null, prettyName(l.spec.name)), range, val);
  }

  private previewCol(): HTMLElement {
    this.growthCanvas = h('canvas', { width: 380, height: 150, style: 'width:100%;height:150px;background:#02060a;border-radius:6px', role: 'img', 'aria-label': 'Growth preview' });
    const scrub = h('input', { type: 'range', min: 0, max: 100, value: String(Math.round(this.age * 100)), 'aria-label': t('designer.growth') });
    scrub.addEventListener('input', () => { this.playing = false; this.setAge(Number(scrub.value) / 100); });
    this.ageLabel = h('span', { class: 'dim', style: 'font-size:12px;min-width:60px' }, t('designer.age', { a: fmtNum(this.age, 2) }));
    const play = h('button', { onclick: () => { this.playing = !this.playing; this.playStart = performance.now() - this.age * 6000; play.textContent = this.playing ? t('designer.stop') : t('designer.play'); } }, this.playing ? t('designer.stop') : t('designer.play'));
    const keys = h('div', { class: 'row' }, ...[0, 0.25, 0.5, 1].map((a) => h('button', { style: 'min-width:44px', onclick: () => { this.playing = false; scrub.value = String(a * 100); this.setAge(a); } }, String(a))));
    this.tankCanvas = h('canvas', { width: 380, height: 160, style: 'width:100%;height:160px;background:#020a10;border-radius:6px', role: 'img', 'aria-label': 'Test tank' });
    this.tankLabel = h('div', { class: 'dim', style: 'font-size:12px' });
    this.updateTankLabel();
    return h('div', { class: 'side' },
      h('div', { class: 'col' }, h('div', { class: 'row' }, h('strong', null, t('designer.growth')), h('span', { class: 'grow' }), this.ageLabel, play), this.growthCanvas, scrub, keys),
      h('div', { class: 'col' }, h('div', { class: 'row' }, h('strong', null, t('designer.testTank')), h('span', { class: 'faint', style: 'font-size:11px' }, t('designer.toyTank')), h('span', { class: 'grow' }),
        h('button', { onclick: () => { this.tankSeed++; this.tankT0 = performance.now(); } }, t('designer.reroll'))), this.tankCanvas, this.tankLabel),
    );
  }
  private updateTankLabel(): void {
    if (!this.tankLabel) return;
    const b = this.budget;
    const v = b.cruiseBLs * this.adult.adultLengthM;
    const cot = b.costW / Math.max(1e-12, b.massKg * 9.81 * Math.max(1e-6, v));
    this.tankLabel.textContent = `${t('designer.top', { v: fmtNum(b.cruiseBLs * 1.8, 1) })} · ${t('designer.cruise', { v: fmtNum(b.cruiseBLs, 1) })} · ${t('designer.cot', { v: fmtNum(cot, 2) })}`;
  }
  private setAge(a: number): void {
    this.age = a;
    this.body = a >= 0.999 ? this.adult : growBody(view(this.doc.genome), a, this.host.lCeiling());
    if (this.ageLabel) this.ageLabel.textContent = t('designer.age', { a: fmtNum(a, 2) });
  }
  private liveRefresh(): void {
    this.setAge(this.age);
    this.updateTankLabel();
  }

  // ---------------- parts mode ----------------
  private paletteCol(): HTMLElement {
    const parent = this.sel?.rule ?? view(this.doc.genome).rootModuleInnov;
    const kinds = [KIND.SEGMENT, KIND.FIN, KIND.LIMB, KIND.MOUTH, KIND.EYE, KIND.CHEMO, KIND.SPIKE, KIND.PHOTOPHORE, KIND.CILIA, KIND.JET, KIND.BLADDER, KIND.GLAND];
    return h('nav', { class: 'groups', 'aria-label': t('designer.palette') },
      h('div', { class: 'subhead', style: 'padding:0 14px' }, t('designer.palette')),
      ...kinds.map((k) => h('button', {
        onclick: () => { const r = addPart(this.doc.genome, parent, k, k === KIND.MOUTH ? 2 : 0); this.commit(r.bytes, `add ${k}`); this.sel = { rule: r.innov, link: r.innov + 1, copy: 0 }; this.render(); },
      }, `+ ${tk(`part.${k}`)}`)));
  }
  private skeletonCol(): HTMLElement {
    this.skeleton = h('canvas', { width: 720, height: 420, tabindex: 0, style: 'width:100%;height:100%;min-height:300px;background:#02060a;border-radius:6px;cursor:pointer', role: 'img', 'aria-label': 'Skeleton editor' });
    this.skeleton.addEventListener('click', (e) => {
      if (!this.skeletonMap || !this.skeleton) return;
      const r = this.skeleton.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * this.skeleton.width, py = ((e.clientY - r.top) / r.height) * this.skeleton.height;
      const i = pickPart(this.adult, this.skeletonMap, px, py);
      const p = i >= 0 ? this.adult.parts[i]! : null;
      this.sel = p ? { rule: p.rule, link: p.link, copy: p.copy } : null;
      this.render();
    });
    return h('div', { class: 'mid', style: 'display:flex;flex-direction:column;gap:6px' }, h('div', { class: 'faint', style: 'font-size:12px' }, t('designer.selectPart')), this.skeleton);
  }
  private ruleCol(): HTMLElement {
    const side = h('div', { class: 'side' });
    if (!this.sel) { side.append(h('div', { class: 'dim' }, t('designer.selectPart'))); return side; }
    const m = getModule(this.doc.genome, this.sel.rule);
    if (!m) { this.sel = null; side.append(h('div', { class: 'dim' }, t('designer.selectPart'))); return side; }
    const copies = this.adult.parts.filter((p) => p.rule === m.innov).length;
    const field = (f: ModuleField, label: string) => {
      const fd = MODULE_RECORD.fields.find((x) => x.name === f)!;
      const qMax = fd.type === 'u16' ? 65535 : 255;
      const raw = m[f] as number;
      const input = h('input', { type: 'range', min: f === 'hueOffset' ? -128 : 0, max: f === 'hueOffset' ? 127 : qMax, value: String(raw), 'aria-label': label });
      const out = h('span', { class: 'val' }, fmtNum(moduleFieldValue(m, f), 2));
      input.addEventListener('input', () => {
        this.commit(setModuleField(this.doc.genome, m.innov, f, Number(input.value)), `${f}`, `m${m.innov}${f}`);
        const mm = getModule(this.doc.genome, m.innov)!;
        out.textContent = fmtNum(moduleFieldValue(mm, f), 2);
        this.liveRefresh();
      });
      input.addEventListener('change', () => { this.history.seal(); this.renderHead(); this.renderFoot(); });
      return h('div', { class: 'slider', style: 'grid-template-columns:110px 1fr 56px' }, h('label', null, label), input, out);
    };
    const lk = linksTo(this.doc.genome, m.innov)[0];
    side.append(
      h('div', null, h('strong', null, `${t('designer.selected')}: ${tk(`part.${m.kind}`)} R${m.innov}`), h('div', { class: 'dim' }, t('designer.copies', { n: copies }))),
      field('length', 'length'), field('width', 'width'), field('taper', 'taper'), field('stiffness', 'stiffness'),
      field('muscleFraction', 'muscle'), field('glow', 'glow'), field('hueOffset', 'hue'), field('armourCoverage', 'armour'),
    );
    if (lk) {
      const sym = h('select', { 'aria-label': t('designer.symmetry'), onchange: (e: Event) => { this.commit(setLinkField(this.doc.genome, lk.innov, 'symmetry', Number((e.target as HTMLSelectElement).value)), 'symmetry'); this.render(); } },
        ...[SYMMETRY.NONE, SYMMETRY.MIRROR, SYMMETRY.RADIAL].map((s) => h('option', { value: s, selected: lk.symmetry === s }, t((['designer.sym.none', 'designer.sym.mirror', 'designer.sym.radial'] as MsgKey[])[s]!))));
      const rep = h('input', { type: 'number', min: 1, max: 16, value: String(lk.repeat), style: 'width:64px', 'aria-label': 'repeat',
        onchange: (e: Event) => { this.commit(setLinkField(this.doc.genome, lk.innov, 'repeat', Number((e.target as HTMLInputElement).value)), 'repeat'); this.render(); } });
      const pos = h('input', { type: 'range', min: 0, max: 255, value: String(lk.attachPos), 'aria-label': 'attach position' });
      pos.addEventListener('input', () => { this.commit(setLinkField(this.doc.genome, lk.innov, 'attachPos', Number(pos.value)), 'attachPos', `l${lk.innov}p`); this.liveRefresh(); });
      const ang = h('input', { type: 'range', min: -128, max: 127, value: String(lk.attachAngle), 'aria-label': 'attach angle' });
      ang.addEventListener('input', () => { this.commit(setLinkField(this.doc.genome, lk.innov, 'attachAngle', Number(ang.value)), 'attachAngle', `l${lk.innov}a`); this.liveRefresh(); });
      for (const el of [pos, ang]) el.addEventListener('change', () => { this.history.seal(); this.renderHead(); this.renderFoot(); });
      side.append(h('div', { class: 'card col' },
        h('div', { class: 'row' }, h('span', { class: 'dim' }, t('designer.symmetry')), sym, h('span', { class: 'dim' }, 'repeat'), rep),
        h('div', { class: 'slider', style: 'grid-template-columns:110px 1fr' }, h('label', null, 'attach position'), pos),
        h('div', { class: 'slider', style: 'grid-template-columns:110px 1fr' }, h('label', null, 'attach angle'), ang)));
    }
    const isRoot = m.innov === view(this.doc.genome).rootModuleInnov;
    side.append(h('div', { class: 'row' },
      h('button', { disabled: !lk || copies < 2, onclick: () => { const r = breakOut(this.doc.genome, lk!.innov); this.commit(r.bytes, 'break out'); this.sel = { rule: r.innov, link: r.innov + 1, copy: 0 }; this.render(); } }, t('designer.breakOut')),
      h('button', { disabled: isRoot, onclick: () => { const r = duplicateRule(this.doc.genome, m.innov); this.commit(r.bytes, 'duplicate'); this.sel = { rule: r.innov, link: 0, copy: 0 }; this.render(); } }, t('designer.duplicate')),
      h('button', { class: 'danger', disabled: isRoot, onclick: () => this.deleteSelected() }, t('designer.deleteRule'))));
    return side;
  }
  deleteSelected(): void {
    if (!this.sel || this.mode !== 'parts') return;
    this.commit(deleteRule(this.doc.genome, this.sel.rule), 'delete rule');
    this.sel = null;
    this.render();
  }

  // ---------------- energy and issues ----------------
  private renderFoot(): void {
    if (!this.footEl) return;
    const b = this.budget;
    const max = Math.max(b.income.rich, b.costW) * 1.05;
    const bar = (label: string, v: number, colour: string) => h('div', { class: 'ebar' }, h('span', { class: 'dim' }, label),
      h('div', { class: 'b' }, h('i', { style: `width:${Math.min(100, (v / max) * 100)}%;background:${colour}` })), h('span', { style: 'text-align:right;font-variant-numeric:tabular-nums' }, fmtW(v)));
    const costs: [string, number, string][] = [['basal', b.basalW, '#6fb7c9'], ['repair', b.repairW, '#5a8fa8'], ['muscle', b.muscleW, '#e8c06a'], ['brain', b.brainW, '#c59cf0'], ['organs', b.organW, '#8ee0a0'], ['glow', b.glowW, '#62d2e8'], ['repro', b.reproW, '#ef8c72']];
    const stack = h('div', { class: 'ebar' }, h('span', { class: 'dim' }, t('designer.costs')),
      h('div', { class: 'b' }, ...costs.map(([n, v, c]) => h('i', { title: `${n} ${fmtW(v)}`, style: `width:${(v / max) * 100}%;background:${c}` }))), h('span', { style: 'text-align:right' }, fmtW(b.costW)));
    const day = 1200;
    const simDays = (s: number) => (Number.isFinite(s) ? `${fmtNum(s / day, 1)} d` : '∞');
    const energy = h('div', { class: 'col', style: 'gap:3px' },
      h('div', { class: 'row' }, h('strong', null, t('designer.energy')), h('span', { class: 'faint', style: 'font-size:11px' }, costs.map(([n]) => n).join(' · '))),
      bar(`${t('designer.income')} ${t('designer.poor')}`, b.income.poor, '#3f8a62'),
      bar(`${t('designer.income')} ${t('designer.typical')}`, b.income.typical, '#5cbf86'),
      bar(`${t('designer.income')} ${t('designer.rich')}`, b.income.rich, '#8ee0a0'),
      stack,
      h('div', { class: 'dim', style: 'font-size:12px' }, t('designer.breakEven', { v: Number.isFinite(b.breakEven) ? fmtNum(b.breakEven, 2) : '∞' }), ' · ',
        t('designer.starves', { v: simDays(b.starveS) }), ' · ', t('designer.adultIn', { v: simDays(b.matureS) }), ' · ', t('designer.breeds', { v: simDays(b.breedEveryS) }), ' · ',
        t('designer.offspring', { v: fmtNum(Math.round(b.lifetimeOffspring), 0) })),
    );
    const issues = h('div', { class: 'col', style: 'gap:2px' }, h('strong', null, t('designer.issues')),
      ...(this.issues.length === 0 ? [h('div', { class: 'good', style: 'font-size:12px' }, t('designer.noIssues'))] :
        this.issues.map((i) => h('div', { class: 'issue', role: 'button', tabindex: 0, onclick: () => this.focusIssue(i) },
          h('span', { class: `sev ${i.severity}` }, t(`sev.${i.severity}` as MsgKey)), h('span', null, tk(`issue.${i.id}`)), h('span', { class: 'faint' }, i.id)))));
    const chips = h('div', { class: 'row', style: 'gap:4px;font-size:12px' }, h('span', { class: 'dim' }, t('designer.tradeoffs')),
      ...this.chips.map((c) => h('button', { class: 'ro-chip', onclick: () => { const l = LOCI.find((x) => x.spec.name === c.name && x.table === c.table); if (l) { this.mode = 'genes'; this.group = l.group; this.focusTrait = l.spec.name; this.render(); } } },
        t('designer.tradeoff', { locus: prettyName(c.name), net: `${c.dNetPct >= 0 ? '+' : ''}${fmtNum(c.dNetPct, 0)}` }))));
    energy.append(chips);
    mount(this.footEl, energy, issues);
  }
  private focusIssue(i: Issue): void {
    if (i.focus?.trait) {
      const l = LOCI.find((x) => x.spec.name === i.focus!.trait);
      if (l) { this.mode = 'genes'; this.group = l.group; this.focusTrait = l.spec.name; this.render(); }
    } else if (i.focus?.kind !== undefined) { this.mode = 'parts'; this.render(); }
  }

  // ---------------- per frame ----------------
  frame(now: number): void {
    if (this.playing) this.setAge(((now - this.playStart) % 6000) / 6000);
    if (this.growthCanvas && this.growthCanvas.isConnected) {
      const c = this.growthCanvas.getContext('2d')!;
      c.clearRect(0, 0, this.growthCanvas.width, this.growthCanvas.height);
      // fixed scale so growth reads as growth: the adult fills the box
      const adultMap = measure(this.adult, this.growthCanvas.width, this.growthCanvas.height);
      drawBody(c, this.body, { x: 0, y: 0, w: this.growthCanvas.width, h: this.growthCanvas.height }, { fixedScale: adultMap });
      c.fillStyle = 'rgba(160,200,210,.6)'; c.font = '11px system-ui';
      c.fillText(`${fmtLength(this.body.lengthM)} · ${this.body.source === 'sketch' ? 'sketch preview' : 'develop()'}`, 8, this.growthCanvas.height - 8);
    }
    if (this.tankCanvas && this.tankCanvas.isConnected) this.drawTank(now);
    if (this.skeleton && this.skeleton.isConnected) {
      const cv = this.skeleton;
      const r = cv.getBoundingClientRect();
      if (r.width > 10 && (cv.width !== Math.round(r.width) || cv.height !== Math.round(r.height))) { cv.width = Math.round(r.width); cv.height = Math.round(r.height); }
      const c = cv.getContext('2d')!;
      c.clearRect(0, 0, cv.width, cv.height);
      this.skeletonMap = drawBody(c, this.adult, { x: 20, y: 20, w: cv.width - 40, h: cv.height - 40 }, {
        ...(this.sel ? { highlightRule: this.sel.rule, highlightCopy: { link: this.sel.link, copy: this.sel.copy } } : {}),
      });
      c.fillStyle = 'rgba(160,200,210,.55)'; c.font = '12px system-ui';
      this.adult.parts.forEach((p) => {
        if (p.kind === KIND.SEGMENT && p.copy === 0 && p.dv === 0) c.fillText(`R${p.rule}`, this.skeletonMap!.ox + p.x0 * this.skeletonMap!.scale - 8, this.skeletonMap!.oy + p.y0 * this.skeletonMap!.scale - 14);
      });
    }
  }
  private drawTank(now: number): void {
    const cv = this.tankCanvas!;
    const c = cv.getContext('2d')!;
    const W = cv.width, H = cv.height;
    c.fillStyle = '#020a10'; c.fillRect(0, 0, W, H);
    const tS = (now - this.tankT0) / 1000;
    const seed = this.tankSeed;
    // food specks
    for (let i = 0; i < 24; i++) {
      const fx = ((Math.sin(i * 12.9898 + seed) * 43758.5453) % 1 + 1) % 1, fy = ((Math.sin(i * 78.233 + seed * 3) * 12345.678) % 1 + 1) % 1;
      c.fillStyle = 'rgba(140,255,170,.5)'; c.fillRect(fx * W, fy * H, 2, 2);
    }
    const speedPx = Math.min(70, 14 * this.budget.cruiseBLs);
    const x = ((tS * speedPx + seed * 37) % (W + 120)) - 60;
    const y = H / 2 + Math.sin(tS * 0.7 + seed) * H * 0.25;
    const bodyPx = 70;
    c.save();
    c.translate(x, y);
    const wig = Math.sin(tS * (2 + this.budget.cruiseBLs)) * 0.12;
    c.rotate(wig);
    drawBody(c, this.adult, { x: -bodyPx, y: -bodyPx / 2, w: bodyPx * 2, h: bodyPx }, {});
    c.restore();
  }

  // ---------------- actions ----------------
  save(): void {
    const origin = this.doc.origin === 'template' ? 'designed' : this.doc.origin === 'captured' ? 'captured' : 'designed';
    const r = this.host.library.put(this.meta(), this.doc.genome, origin, this.doc.libraryId);
    this.doc.libraryId = r.entry.id;
    if (this.doc.origin === 'template') this.doc.origin = 'designer';
    this.saved = this.doc.genome;
    this.host.toast(t('library.added', { name: `${this.doc.genus} ${this.doc.epithet}` }));
    this.renderHead();
  }

  share(): void {
    const meta = this.meta();
    const s = designString(meta, this.doc.genome);
    const name = `${meta.name.genus} ${meta.name.epithet}`;
    const ta = h('textarea', { readonly: true, rows: 4, style: 'width:100%;font:11px ui-monospace,monospace;word-break:break-all' });
    ta.value = s;
    const qrBox = h('div', { style: 'text-align:center;margin-top:8px' });
    if (s.length < 2300) {
      const cv = h('canvas', { role: 'img', 'aria-label': t('share.qr'), style: 'image-rendering:pixelated;max-width:280px;width:100%' });
      drawQr(cv.getContext('2d')!, encodeQr(new TextEncoder().encode(s), 'L'), 280);
      qrBox.append(cv);
    } else qrBox.append(h('div', { class: 'dim' }, t('share.qrTooBig')));
    let close = () => {};
    const el = h('div', null,
      h('h3', null, ...withName(t('share.title', { name: '\u0000' }), name)),
      h('div', { class: 'faint', style: 'font-family:ui-monospace,monospace;font-size:12px' }, this.fp ? `fp ${this.fp}` : ''),
      ta,
      h('div', { class: 'row' },
        h('button', { onclick: () => { void navigator.clipboard?.writeText(s).then(() => this.host.toast(t('share.copied')), () => { ta.select(); }); } }, t('share.copy')),
        h('span', { class: 'dim' }, t('share.chars', { n: s.length })), h('span', { class: 'grow' }),
        h('button', { onclick: () => downloadPtkg(`${meta.name.genus}-${meta.name.epithet}.ptkg`, packDesign(meta, this.doc.genome)) }, t('library.download'))),
      qrBox,
      h('div', { class: 'actions' }, h('button', { onclick: () => close() }, t('common.close'))));
    close = this.host.dialog(el);
  }

  releaseDialog(asLeviathan: boolean): void {
    const name = `${this.doc.genus} ${this.doc.epithet}`;
    const tank = this.host.tank();
    const g = view(this.doc.genome);
    const prefDepth = decodeQ(g.brainTraits[40]!, BRAIN_TRAITS[40]!);
    const zoneKey: MsgKey = prefDepth < 0.33 ? 'zone.photic' : prefDepth < 0.66 ? 'zone.twilight' : 'zone.midnight';
    const count = h('input', { type: 'number', min: 1, max: 500, value: asLeviathan ? '2' : '20', style: 'width:80px', 'aria-label': t('release.count') });
    const where = h('select', { 'aria-label': t('release.where') },
      h('option', { value: 'zone' }, t('release.zone', { zone: t(zoneKey) })), h('option', { value: 'centre' }, t('release.centre')), h('option', { value: 'scatter' }, t('release.scatter')));
    const protect = h('input', { type: 'checkbox', checked: true, id: 'pt-protect' });
    const issues = validate(g, this.adult, this.budget, { count: Number(count.value), asLeviathan });
    const inviable = anyInviable(issues);
    let close = () => {};
    const doRelease = async () => {
      let genome = this.doc.genome;
      if (asLeviathan) { const gg = decodeGenome(genome); gg.flags |= GENOME_FLAG_LEVIATHAN; genome = encodeGenome(gg); }
      const pos: [number, number] = where.value === 'centre' ? [tank.w / 2, tank.h / 2] : where.value === 'scatter' ? [tank.w * (0.2 + 0.6 * Math.random()), tank.h * (0.2 + 0.6 * Math.random())] : [tank.w / 2, Math.max(0.5, Math.min(tank.h - 0.5, prefDepth * tank.h))];
      const n = Math.max(1, Math.min(500, Math.round(Number(count.value) || 1)));
      const res = await this.host.release(packDesign(this.meta(), genome), { count: n, pos, asLeviathan, founderProtection: protect.checked });
      close();
      if (res.ok) {
        if (this.dirty) this.save();
        this.host.toast(t('release.done', { n, name }));
      } else this.host.toast(t('powers.rejected', { reason: res.reason ?? '?' }));
    };
    const actions = h('div', { class: 'actions' }, h('button', { onclick: () => close() }, t('common.cancel')));
    if (asLeviathan) {
      const fill = h('i', { style: 'width:0%' });
      const hold = h('button', { class: 'danger hold', style: 'min-width:220px' }, fill, t('release.leviathanHold'));
      let since = 0, raf = 0;
      const tick = () => { const p = Math.min(1, (performance.now() - since) / 1200); fill.style.width = `${p * 100}%`; if (p >= 1) { since = 0; void doRelease(); } else if (since) raf = requestAnimationFrame(tick); };
      const down = () => { since = performance.now(); raf = requestAnimationFrame(tick); };
      const up = () => { since = 0; cancelAnimationFrame(raf); fill.style.width = '0%'; };
      hold.addEventListener('pointerdown', down); hold.addEventListener('pointerup', up); hold.addEventListener('pointerleave', up);
      hold.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat && !since) { e.preventDefault(); down(); } });
      hold.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') up(); });
      actions.append(h('button', { onclick: () => void doRelease() }, t('powers.confirmDialog')), hold);
    } else actions.append(h('button', { class: 'primary', onclick: () => void doRelease() }, inviable ? t('release.anyway') : t('release.button')));
    const el = h('div', null,
      h('h3', null, ...withName(t(asLeviathan ? 'release.leviathanTitle' : 'release.title', { name: '\u0000' }), name)),
      asLeviathan ? h('p', { class: 'warn', style: 'font-size:12px' }, t('release.leviathanNote')) : null,
      h('div', { class: 'kv', style: 'grid-template-columns:110px 1fr;font-size:13px;align-items:center' },
        h('span', null, t('release.count')), count,
        h('span', null, t('release.where')), where,
        h('span', null, t('release.protect')), h('label', { for: 'pt-protect' }, protect),
        h('span', null, t('designer.issues')), h('div', null, ...(issues.length ? issues.map((i) => h('div', { class: 'issue' }, h('span', { class: `sev ${i.severity}` }, t(`sev.${i.severity}` as MsgKey)), tk(`issue.${i.id}`))) : [h('span', { class: 'good' }, t('designer.noIssues'))]))),
      actions);
    close = this.host.dialog(el);
  }
}

/** A message with the species name in italics where the {name} slot was. */
function withName(msg: string, name: string): (string | HTMLElement)[] {
  const [a = '', b = ''] = msg.split('\u0000');
  return [a, binomial(name), b];
}
function measure(body: GrownBody, w: number, hgt: number): number {
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const p of body.parts) { xmin = Math.min(xmin, p.x0 - p.r0, p.x1); xmax = Math.max(xmax, p.x0 + p.r0, p.x1); ymin = Math.min(ymin, p.y0 - p.r0, p.y1 - p.r1); ymax = Math.max(ymax, p.y0 + p.r0, p.y1 + p.r1); }
  return 0.86 * Math.min(w / Math.max(1e-9, xmax - xmin), hgt / Math.max(1e-9, ymax - ymin));
}
function fmtW(w: number): string {
  if (w <= 0) return '0';
  const units: [number, string][] = [[1, 'W'], [1e-3, 'mW'], [1e-6, 'µW'], [1e-9, 'nW']];
  for (const [k, u] of units) if (w >= k) return `${fmtNum(w / k, 2)} ${u}`;
  return `${fmtNum(w * 1e12, 1)} pW`;
}
export function downloadPtkg(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
  const a = h('a', { href: url, download: name.replace(/[^\w.-]+/g, '_') });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
