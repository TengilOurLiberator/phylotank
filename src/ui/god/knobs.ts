/**
 * World settings and balancing knobs (07 §3.9). Each knob is a KnobSpec; the setting key is the
 * knob id, sent as `{t:'setting', key, value}` (CONTRACT 13). Live knobs apply at once; the
 * others are held until "Start a new world with these". Presets Gentle (default), Harsh and
 * Fast evolution; anything else reads as Custom. Every change is a timeline event on the host.
 *
 * A host that does not know a knob answers `unknown-setting`; the panel says so per knob
 * instead of pretending it applied (07 §0.1, honest numbers).
 */
import { h, mount } from '../dom.js';
import { fmtNum, t, type MsgKey } from '../i18n.js';
import type { GodClient } from './client.js';

export type KnobGroup = 'world' | 'light' | 'climate' | 'ecology' | 'life' | 'disease' | 'god' | 'snapshots' | 'views';
export interface KnobSpec {
  id: string; group: KnobGroup; label: MsgKey;
  min: number; max: number; scale: 'lin' | 'log' | 'int' | 'enum';
  default: number | string; live: boolean;
  unit?: string; options?: readonly string[]; hint?: MsgKey;
  /** 0 means "unlimited" (release budget). */
  zeroIsUnlimited?: boolean;
  /** Setting key the current host already understands, if it differs (mod/host: autosaveMin). */
  hostKey?: string;
}

export const KNOBS: readonly KnobSpec[] = [
  { id: 'world.size', group: 'world', label: 'knob.world.size', min: 0, max: 2, scale: 'enum', options: ['small', 'default', 'large'], default: 'default', live: false },
  { id: 'world.seed', group: 'world', label: 'knob.world.seed', min: 0, max: 4294967295, scale: 'int', default: 0, live: false },
  { id: 'light.dayLength', group: 'light', label: 'knob.light.dayLength', min: 2, max: 60, scale: 'int', default: 20, unit: 'min', live: true },
  { id: 'light.yearLength', group: 'light', label: 'knob.light.yearLength', min: 4, max: 60, scale: 'int', default: 12, unit: 'd', live: true },
  { id: 'light.surface', group: 'light', label: 'knob.light.surface', min: 0.2, max: 2, scale: 'log', default: 1, unit: '×', live: true },
  { id: 'climate.surfaceTemp', group: 'climate', label: 'knob.climate.surfaceTemp', min: 5, max: 35, scale: 'lin', default: 18, unit: '°C', live: true },
  { id: 'climate.swing', group: 'climate', label: 'knob.climate.swing', min: 0, max: 15, scale: 'lin', default: 6, unit: '°C', live: true },
  { id: 'climate.deepTemp', group: 'climate', label: 'knob.climate.deepTemp', min: 0, max: 10, scale: 'lin', default: 4, unit: '°C', live: true },
  { id: 'climate.current', group: 'climate', label: 'knob.climate.current', min: 0, max: 3, scale: 'lin', default: 1, unit: '×', live: true },
  { id: 'eco.plankton', group: 'ecology', label: 'knob.eco.plankton', min: 0.2, max: 5, scale: 'log', default: 1, unit: '×', live: true },
  { id: 'eco.recycling', group: 'ecology', label: 'knob.eco.recycling', min: 0.1, max: 3, scale: 'log', default: 1, unit: '×', live: true },
  { id: 'life.metabolic', group: 'life', label: 'knob.life.metabolic', min: 0.5, max: 2, scale: 'log', default: 1, unit: '×', live: true },
  { id: 'life.mutation', group: 'life', label: 'knob.life.mutation', min: 0, max: 10, scale: 'lin', default: 1, unit: '×', live: true, hint: 'knob.hint.mutation' },
  { id: 'life.popCap', group: 'life', label: 'knob.life.popCap', min: 1000, max: 1_000_000, scale: 'log', default: 20000, live: true },
  { id: 'disease.emergence', group: 'disease', label: 'knob.disease.emergence', min: 0, max: 5, scale: 'lin', default: 1, unit: '×', live: true },
  { id: 'disease.virulence', group: 'disease', label: 'knob.disease.virulence', min: 0, max: 1, scale: 'lin', default: 0.6, live: true },
  { id: 'god.disasters', group: 'god', label: 'knob.god.disasters', min: 0, max: 2, scale: 'enum', options: ['off', 'rare', 'normal'], default: 'off', live: true },
  { id: 'god.releaseBudget', group: 'god', label: 'knob.god.releaseBudget', min: 0, max: 100, scale: 'int', default: 0, live: true, zeroIsUnlimited: true },
  { id: 'snap.autosave', group: 'snapshots', label: 'knob.snap.autosave', min: 5, max: 240, scale: 'int', default: 30, unit: 'min', live: true, hostKey: 'autosaveMin' },
  { id: 'snap.retention', group: 'snapshots', label: 'knob.snap.retention', min: 4, max: 100, scale: 'int', default: 24, live: true },
  { id: 'views.brightness', group: 'views', label: 'knob.views.brightness', min: 0.2, max: 1.5, scale: 'lin', default: 1, unit: '×', live: true },
  { id: 'views.glow', group: 'views', label: 'knob.views.glow', min: 0, max: 2, scale: 'lin', default: 1, unit: '×', live: true },
];
export const KNOB = new Map(KNOBS.map((k) => [k.id, k]));
export const GROUPS: readonly KnobGroup[] = ['light', 'climate', 'ecology', 'life', 'disease', 'god', 'snapshots', 'views', 'world'];

export type PresetId = 'gentle' | 'harsh' | 'fast';
export const PRESETS: Readonly<Record<PresetId, Readonly<Record<string, number | string>>>> = {
  gentle: {},
  harsh: { 'life.metabolic': 1.5, 'eco.plankton': 0.7 },
  fast: { 'life.mutation': 3 },
};
export type KnobValues = Record<string, number | string | boolean>;

/** Every knob's value under a preset (defaults plus the preset's overrides). */
export function presetValues(p: PresetId): KnobValues {
  const out: KnobValues = {};
  for (const k of KNOBS) out[k.id] = PRESETS[p][k.id] ?? k.default;
  return out;
}
/** Which preset the live values match, or 'custom'. New-world knobs do not count. */
export function matchPreset(values: KnobValues): PresetId | 'custom' {
  for (const p of ['gentle', 'harsh', 'fast'] as PresetId[]) {
    const pv = presetValues(p);
    if (KNOBS.every((k) => !k.live || near(values[k.id] ?? k.default, pv[k.id]!))) return p;
  }
  return 'custom';
}
function near(a: number | string | boolean, b: number | string | boolean): boolean {
  return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)) : a === b;
}

/** Clamp and quantise a value to its knob. */
export function clampKnob(k: KnobSpec, v: number | string | boolean): number | string {
  if (k.scale === 'enum') return typeof v === 'string' && k.options!.includes(v) ? v : (k.default as string);
  const n = typeof v === 'number' && Number.isFinite(v) ? v : Number(k.default);
  const c = Math.min(k.max, Math.max(k.min, n));
  return k.scale === 'int' ? Math.round(c) : Math.round(c * 1000) / 1000;
}
/** Slider position 0..1000 <-> value. */
export function knobToX(k: KnobSpec, v: number): number {
  if (k.scale === 'log') return Math.round((Math.log(v / k.min) / Math.log(k.max / k.min)) * 1000);
  return Math.round(((v - k.min) / (k.max - k.min)) * 1000);
}
export function knobFromX(k: KnobSpec, x: number): number {
  const f = x / 1000;
  return Number(clampKnob(k, k.scale === 'log' ? k.min * Math.exp(f * Math.log(k.max / k.min)) : k.min + f * (k.max - k.min)));
}
export function showKnob(k: KnobSpec, v: number | string | boolean): string {
  if (k.scale === 'enum') return t(`knobv.${String(v)}` as MsgKey);
  const n = Number(v);
  if (k.zeroIsUnlimited && n === 0) return t('knobs.unlimited');
  const digits = k.scale === 'int' ? 0 : Math.abs(n) >= 10 ? 1 : 2;
  return `${fmtNum(n, digits)}${k.unit ? (k.unit === '×' ? '×' : ` ${k.unit}`) : ''}`;
}

type Status = { s: 'sending' } | { s: 'applied' } | { s: 'refused'; reason: string };

/** The knobs part of the Settings panel. */
export class KnobsPanel {
  readonly el = h('div', { class: 'col knobs' });
  private status = new Map<string, Status>();
  /** New-world-only values chosen but not yet used. */
  private pendingWorld: KnobValues = {};
  private local: KnobValues = {};

  constructor(private readonly client: GodClient, private readonly confirm: (msg: string, ok: () => void) => void) { this.render(); }

  value(k: KnobSpec): number | string | boolean {
    if (!k.live && k.id in this.pendingWorld) return this.pendingWorld[k.id]!;
    return this.client.settings[k.id] ?? (k.hostKey ? this.client.settings[k.hostKey] : undefined) ?? this.local[k.id] ?? k.default;
  }
  values(): KnobValues { const o: KnobValues = {}; for (const k of KNOBS) o[k.id] = this.value(k); return o; }

  async set(k: KnobSpec, raw: number | string): Promise<void> {
    const v = clampKnob(k, raw);
    if (!k.live) { this.pendingWorld[k.id] = v; this.render(); return; }
    this.local[k.id] = v;
    this.status.set(k.id, { s: 'sending' });
    this.renderStatus(k);
    let r = await this.client.send({ t: 'setting', key: k.id, value: v });
    if (!r.ok && r.reason === 'unknown-setting' && k.hostKey) r = await this.client.send({ t: 'setting', key: k.hostKey, value: v });
    this.status.set(k.id, r.ok ? { s: 'applied' } : { s: 'refused', reason: r.reason ?? '?' });
    this.renderStatus(k);
    this.renderPresetRow();
  }
  async applyPreset(p: PresetId): Promise<void> {
    const pv = presetValues(p);
    await Promise.all(KNOBS.filter((k) => k.live && !near(this.value(k), pv[k.id]!)).map((k) => this.set(k, pv[k.id] as number | string)));
    this.render();
  }

  private statusEls = new Map<string, HTMLElement>();
  private presetRow = h('div', { class: 'row' });
  private renderStatus(k: KnobSpec): void {
    const el = this.statusEls.get(k.id);
    if (!el) return;
    const s = this.status.get(k.id);
    el.className = `kst ${s?.s === 'refused' ? 'warn' : 'faint'}`;
    el.textContent = !s ? (k.live ? '' : t('knobs.newWorld'))
      : s.s === 'sending' ? t('knobs.sending') : s.s === 'applied' ? t('knobs.applied')
        : s.reason === 'unknown-setting' ? t('knobs.unsupported') : t('knobs.refused', { reason: s.reason });
  }
  private renderPresetRow(): void {
    const cur = matchPreset(this.values());
    const sel = h('select', { 'aria-label': t('knobs.preset'), onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v !== 'custom') void this.applyPreset(v as PresetId); } },
      ...(['gentle', 'harsh', 'fast', 'custom'] as const).map((p) => h('option', { value: p, selected: cur === p, disabled: p === 'custom' && cur !== 'custom' }, t(`preset.${p}` as MsgKey))));
    const base: PresetId = cur === 'custom' ? 'gentle' : cur;
    mount(this.presetRow, h('label', { class: 'row' }, h('span', null, t('knobs.preset')), sel), h('span', { class: 'grow' }),
      h('button', { onclick: () => void this.applyPreset(base) }, t('knobs.resetAll')));
  }

  render(): void {
    this.statusEls.clear();
    this.renderPresetRow();
    const groups = GROUPS.map((g) => {
      const rows = KNOBS.filter((k) => k.group === g).map((k) => this.row(k));
      return h('fieldset', { class: 'kgroup' }, h('legend', null, t(`knobg.${g}` as MsgKey)), ...rows,
        g === 'world' ? h('div', { class: 'row', style: 'margin-top:4px' }, h('button', {
          disabled: Object.keys(this.pendingWorld).length === 0,
          onclick: () => this.confirm(t('knobs.newWorldConfirm'), () => {
            void this.client.send({ t: 'setting', key: 'world.new', value: JSON.stringify(this.pendingWorld) });
            this.pendingWorld = {}; this.render();
          }),
        }, t('knobs.newWorldButton'))) : null);
    });
    mount(this.el, h('h3', { class: 'sub' }, t('knobs.title')), h('p', { class: 'faint', style: 'margin:0;font-size:12px' }, t('knobs.note')), this.presetRow, ...groups);
  }

  private row(k: KnobSpec): HTMLElement {
    const v = this.value(k);
    const id = `knob-${k.id.replace(/\W/g, '-')}`;
    const st = h('span', { class: 'kst faint', 'aria-live': 'polite' });
    this.statusEls.set(k.id, st);
    let input: HTMLElement;
    const out = h('output', { class: 'val', for: id }, showKnob(k, v));
    if (k.scale === 'enum') {
      input = h('select', { id, onchange: (e: Event) => void this.set(k, (e.target as HTMLSelectElement).value) },
        ...k.options!.map((o) => h('option', { value: o, selected: v === o }, t(`knobv.${o}` as MsgKey))));
    } else if (k.id === 'world.seed') {
      input = h('input', { id, type: 'number', min: 0, max: k.max, step: 1, value: String(v), onchange: (e: Event) => void this.set(k, Number((e.target as HTMLInputElement).value)) });
    } else {
      const r = h('input', { id, type: 'range', min: 0, max: 1000, step: 1, value: String(knobToX(k, Number(v))) });
      r.setAttribute('aria-valuetext', showKnob(k, v));
      r.addEventListener('input', () => { const nv = knobFromX(k, Number(r.value)); out.textContent = showKnob(k, nv); r.setAttribute('aria-valuetext', out.textContent); });
      r.addEventListener('change', () => void this.set(k, knobFromX(k, Number(r.value))));
      input = r;
    }
    const isDefault = near(v, k.default);
    const reset = h('button', { class: 'kreset', 'aria-label': t('knobs.reset', { knob: t(k.label) }), title: t('knobs.reset', { knob: t(k.label) }), disabled: isDefault,
      onclick: () => void this.set(k, k.default).then(() => this.render()) }, '↺');
    const row = h('div', { class: 'knob' }, h('label', { for: id }, t(k.label)), input, out, reset,
      h('div', { class: 'khint' }, k.hint ? h('span', { class: 'faint' }, t(k.hint), ' · ') : null, st));
    this.renderStatus(k);
    return row;
  }
}
