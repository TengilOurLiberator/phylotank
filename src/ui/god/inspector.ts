/**
 * Inspector (07 §3.5): Overview (identity, energy, health, actions), Genome (gene table against
 * the founder design), Body (the grown body), Brain (live network: inputs left, outputs right,
 * hidden by layer; brightness = activation, dashed = negative weight, thickness = |w|) and Kin.
 */
import { BRAIN_TRAITS, decodeGenome, decodeQ, TRAITS, type Genome } from '../../core/index.js';
import { h, mount, binomial } from '../dom.js';
import { fmtDuration, fmtLength, fmtNum, t, type MsgKey } from '../i18n.js';
import { drawBody, growBody } from '../designer/body.js';
import { traitLabel } from '../labels.js';
import type { GodClient } from './client.js';
import type { BrainGraph } from './wire.js';

export type InspTab = 'overview' | 'genome' | 'body' | 'brain' | 'kin';
export interface InspectorActions { follow(id: number): void; following(): number; saveGenome(g: Uint8Array, name: string): void; fork(g: Uint8Array, name: string): void; bookmark(): void; bless(id: number): void; rename(species: number): void }

export class Inspector {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tab: InspTab = 'overview';
  private brainCanvas: HTMLCanvasElement | null = null;
  private bodyCanvas: HTMLCanvasElement | null = null;
  private onlyDiff = true;
  private trace: number[] = [];
  private traceNode = -1;

  constructor(private readonly client: GodClient, private readonly actions: InspectorActions) {
    this.body = h('div', { class: 'body' });
    this.el = h('aside', { class: 'pt-insp', 'aria-label': t('inspector.title') }, h('header', null, h('strong', null, t('inspector.title'))), this.body);
    this.render();
  }
  setTab(tab: InspTab): void { this.tab = tab; this.render(); }
  private shownId = -1;
  /** Called on each STATS: rebuild only what changes (keeps focus and live canvases intact). */
  refresh(): void {
    const s = this.client.selected;
    if (!s || s.id !== this.shownId) { this.render(); return; }
    const o = this.ov;
    if (this.tab !== 'overview' || !o) return;
    o.energy.style.width = `${s.energy * 100}%`; o.energy.parentElement?.setAttribute('aria-valuenow', String(Math.round(s.energy * 100)));
    o.health.style.width = `${s.health * 100}%`;
    o.length.textContent = fmtLength(s.lengthM); o.action.textContent = s.action; o.offspring.textContent = String(s.offspring);
    o.sub.textContent = this.subline();
  }
  private ov: { energy: HTMLElement; health: HTMLElement; length: HTMLElement; action: HTMLElement; offspring: HTMLElement; sub: HTMLElement } | null = null;
  private subline(): string {
    const s = this.client.selected!;
    return `#${s.id} · ${s.adult ? t('inspector.adult') : t('inspector.juvenile')} · ${fmtDuration(s.ageS)} · ${t('inspector.generation')} ${s.generation}`;
  }

  private genome(): Genome | null {
    const s = this.client.selected;
    if (!s) return null;
    const bytes = this.client.genomes.get(`${s.genomeLo}:${s.genomeHi}`);
    if (!bytes) { this.client.requestGenome(s.genomeLo, s.genomeHi); return null; }
    try { return decodeGenome(bytes); } catch { return null; }
  }

  render(): void {
    const s = this.client.selected;
    if (this.client.selectedId < 0) { mount(this.body, h('p', { class: 'dim' }, t('inspector.none'))); return; }
    if (!s) { mount(this.body, h('p', { class: 'dim' }, `#${this.client.selectedId} …`)); return; }
    const name = this.client.speciesName(s.species);
    const tabs: InspTab[] = ['overview', 'genome', 'body', 'brain', 'kin'];
    const sub = h('div', { class: 'dim', style: 'font-size:12px' }, this.subline());
    this.ov = null;
    const head = h('div', { class: 'col', style: 'gap:4px;margin-bottom:8px' },
      h('div', { class: 'row', style: 'gap:6px' }, binomial(name), this.client.names.get(s.species) ? h('span', { class: 'faint', style: 'font-size:11px' }, t('rename.byUser')) : null,
        h('span', { class: 'grow' }), h('button', { class: 'small', onclick: () => this.actions.rename(s.species) }, '✎ ', t('rename.button'))),
      sub,
      h('div', { class: 'tabs', role: 'tablist' }, ...tabs.map((x) => h('button', { role: 'tab', 'aria-selected': String(x === this.tab), class: x === this.tab ? 'on' : '', onclick: () => this.setTab(x) }, t(`inspector.${x}` as MsgKey)))));
    let content: HTMLElement;
    switch (this.tab) {
      case 'overview': content = this.overview(sub); break;
      case 'genome': content = this.genomeTab(); break;
      case 'body': content = this.bodyTab(); break;
      case 'brain': content = this.brainTab(s.brain); break;
      default: content = this.kinTab();
    }
    const focused = document.activeElement instanceof HTMLElement && this.el.contains(document.activeElement) ? document.activeElement.textContent : null;
    mount(this.body, head, content);
    this.shownId = s.id;
    if (focused) for (const b of this.body.querySelectorAll('button')) if (b.textContent === focused) { b.focus(); break; }
  }

  private overview(sub: HTMLElement): HTMLElement {
    const s = this.client.selected!;
    const energy = h('i', { style: `width:${s.energy * 100}%` }), health = h('i', { style: `width:${s.health * 100}%;background:var(--accent)` });
    const length = h('span', null, fmtLength(s.lengthM)), action = h('span', null, s.action), offspring = h('span', null, String(s.offspring));
    this.ov = { energy, health, length, action, offspring, sub };
    const following = this.actions.following() === s.id;
    const g = this.client.genomes.get(`${s.genomeLo}:${s.genomeHi}`);
    if (!g) this.client.requestGenome(s.genomeLo, s.genomeHi);
    const name = this.client.speciesName(s.species);
    return h('div', { class: 'col' },
      h('div', { class: 'kv' },
        h('span', null, t('inspector.energy')), h('div', { class: 'bar', role: 'meter', 'aria-label': t('inspector.energy'), 'aria-valuenow': String(Math.round(s.energy * 100)), 'aria-valuemin': '0', 'aria-valuemax': '100' }, energy),
        h('span', null, t('inspector.health')), h('div', { class: 'bar', role: 'meter', 'aria-label': t('inspector.health'), 'aria-valuenow': String(Math.round(s.health * 100)), 'aria-valuemin': '0', 'aria-valuemax': '100' }, health),
        h('span', null, t('inspector.length')), length,
        h('span', null, t('inspector.action')), action,
        h('span', null, t('inspector.offspring')), offspring),
      h('div', { class: 'row' },
        h('button', { onclick: () => this.actions.follow(following ? -1 : s.id) }, following ? t('inspector.unfollow') : t('inspector.follow')),
        h('button', { onclick: () => this.actions.bookmark() }, t('inspector.bookmark')),
        h('button', { onclick: () => this.actions.bless(s.id) }, t('inspector.bless'))),
      h('div', { class: 'row' },
        h('button', { disabled: !g, onclick: () => g && this.actions.saveGenome(g, name) }, t('inspector.save')),
        h('button', { disabled: !g, onclick: () => g && this.actions.fork(g, name) }, t('inspector.fork'))));
  }

  private genomeTab(): HTMLElement {
    const g = this.genome();
    if (!g) return h('p', { class: 'dim' }, '…');
    const sp = this.client.species.find((x) => x.id === this.client.selected!.species);
    void sp;
    const rows: HTMLElement[] = [];
    const add = (table: typeof TRAITS, q: Uint16Array) => {
      for (const s of table) {
        if (!s) continue;
        const v = decodeQ(q[s.idx]!, s);
        if (this.onlyDiff && Math.abs(v - s.def) <= Math.abs(s.max - s.min) * 0.01) continue;
        rows.push(h('tr', null, h('td', null, traitLabel(s.name, table === TRAITS ? 'T' : 'B')), h('td', { class: 'num' }, fmtNum(v, 3)), h('td', { class: 'num faint' }, fmtNum(s.def, 3))));
      }
    };
    add(TRAITS, g.traits);
    add(BRAIN_TRAITS, g.brainTraits);
    const cb = h('input', { type: 'checkbox', checked: this.onlyDiff, id: 'pt-diff', onchange: () => { this.onlyDiff = cb.checked; this.render(); } });
    return h('div', null,
      h('label', { class: 'row', for: 'pt-diff', style: 'font-size:12px' }, cb, t('inspector.onlyDiff')),
      h('table', { class: 't' }, h('thead', null, h('tr', null, h('th', null, t('inspector.gene')), h('th', null, t('inspector.value')), h('th', null, t('inspector.founder')))), h('tbody', null, ...rows)));
  }

  private bodyTab(): HTMLElement {
    this.bodyCanvas = h('canvas', { width: 296, height: 200, style: 'width:100%;background:#02060a;border-radius:6px', role: 'img', 'aria-label': t('inspector.body') });
    return h('div', null, this.bodyCanvas);
  }

  private brainTab(_b: BrainGraph): HTMLElement {
    this.brainCanvas = h('canvas', { width: 296, height: 330, style: 'width:100%;background:#02060a;border-radius:6px;cursor:pointer', role: 'img', 'aria-label': t('inspector.brain') });
    this.brainCanvas.addEventListener('click', (e) => {
      const r = this.brainCanvas!.getBoundingClientRect();
      const hit = this.nodeAt(((e.clientX - r.left) / r.width) * 296, ((e.clientY - r.top) / r.height) * 330);
      if (hit >= 0) { this.traceNode = hit; this.trace = []; }
    });
    return h('div', null, this.brainCanvas, h('p', { class: 'faint', style: 'font-size:11px' }, t('inspector.brainLegend')));
  }

  private kinTab(): HTMLElement {
    const s = this.client.selected!;
    const node = (n: { id: number; gen: number; alive: boolean }) => h('div', { class: 'row', style: 'font-size:12px' },
      h('span', { style: `width:10px;height:10px;border-radius:50%;display:inline-block;border:2px solid var(--accent);background:${n.alive ? 'var(--accent)' : 'transparent'}` }),
      `#${n.id}`, h('span', { class: 'dim' }, `gen ${n.gen} · ${n.alive ? t('inspector.alive') : t('inspector.dead')}`));
    return h('div', { class: 'col' },
      h('div', { class: 'subhead' }, t('inspector.ancestors')),
      ...s.ancestors.map(node),
      s.collapsed > 0 ? h('div', { class: 'faint', style: 'font-size:12px;padding-left:16px' }, t('inspector.collapsed', { n: s.collapsed })) : null,
      h('div', { class: 'faint', style: 'font-size:12px' }, `◇ ${t('inspector.founderOf')}`),
      h('div', { class: 'subhead' }, t('inspector.children')),
      ...(s.children.length ? s.children.map(node) : [h('div', { class: 'faint' }, t('common.none'))]));
  }

  private layout(b: BrainGraph): { x: number; y: number }[] {
    const nIn = b.inputs.length, nOut = b.outputs.length;
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < nIn; i++) pts.push({ x: 58, y: 18 + (i * 294) / Math.max(1, nIn - 1) });
    for (let i = 0; i < nOut; i++) pts.push({ x: 226, y: 30 + (i * 270) / Math.max(1, nOut - 1) });
    for (let i = 0; i < b.hidden; i++) pts.push({ x: 122 + (i % 2) * 40, y: 30 + (Math.floor(i / 2) * 270) / Math.max(1, Math.ceil(b.hidden / 2) - 1) });
    return pts;
  }
  private nodeAt(x: number, y: number): number {
    const b = this.client.selected?.brain;
    if (!b) return -1;
    const pts = this.layout(b);
    let best = -1, bd = 12;
    pts.forEach((p, i) => { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  /** Per frame: live canvases. */
  frame(): void {
    const s = this.client.selected;
    if (!s) return;
    if (this.tab === 'brain' && this.brainCanvas?.isConnected) this.drawBrain(this.brainCanvas, s.brain);
    if (this.tab === 'body' && this.bodyCanvas?.isConnected) {
      const g = this.genome();
      const c = this.bodyCanvas.getContext('2d')!;
      c.clearRect(0, 0, 296, 200);
      if (g) drawBody(c, growBody(g, s.adult ? 1 : 0.5, this.client.welcome?.lCeiling ?? 0.126), { x: 0, y: 0, w: 296, h: 200 });
    }
  }
  private drawBrain(cv: HTMLCanvasElement, b: BrainGraph): void {
    const c = cv.getContext('2d')!;
    c.clearRect(0, 0, cv.width, cv.height);
    const pts = this.layout(b);
    const act = this.client.inspect?.act;
    const nIn = b.inputs.length;
    // activation index space: inputs, then motors (outputs), then hidden
    const a = (i: number) => (act && i < act.length ? act[i]! / 127 : 0);
    for (const [src, dst, w] of b.edges) {
      const p = pts[src], q = pts[dst];
      if (!p || !q) continue;
      const live = Math.abs(a(src));
      c.strokeStyle = w >= 0 ? `rgba(98,210,232,${0.15 + 0.6 * live})` : `rgba(239,140,114,${0.15 + 0.6 * live})`;
      c.lineWidth = 0.5 + 2.5 * Math.abs(w);
      c.setLineDash(w < 0 ? [4, 3] : []);
      c.beginPath();
      if (q.x <= p.x) { c.moveTo(p.x, p.y); c.quadraticCurveTo((p.x + q.x) / 2, Math.min(p.y, q.y) - 30, q.x, q.y); } else { c.moveTo(p.x, p.y); c.lineTo(q.x, q.y); }
      c.stroke();
    }
    c.setLineDash([]);
    c.font = '9px system-ui';
    pts.forEach((p, i) => {
      const v = a(i);
      c.fillStyle = `rgba(${v >= 0 ? '150,240,255' : '255,170,150'},${0.25 + 0.75 * Math.abs(v)})`;
      c.beginPath(); c.arc(p.x, p.y, i === this.traceNode ? 6 : 4.5, 0, Math.PI * 2); c.fill();
      c.fillStyle = 'rgba(200,225,232,.75)';
      if (i < nIn) { c.textAlign = 'right'; c.fillText(b.inputs[i]!, p.x - 8, p.y + 3); }
      else if (i < nIn + b.outputs.length) { c.textAlign = 'left'; c.fillText(b.outputs[i - nIn]!, p.x + 8, p.y + 3); }
    });
    c.textAlign = 'left';
    if (this.traceNode >= 0) {
      this.trace.push(a(this.traceNode));
      if (this.trace.length > 600) this.trace.shift();
      c.strokeStyle = 'rgba(232,192,106,.9)'; c.lineWidth = 1;
      c.beginPath();
      this.trace.forEach((v, i) => { const x = (i / 600) * cv.width, y = cv.height - 14 - v * 10; if (i) c.lineTo(x, y); else c.moveTo(x, y); });
      c.stroke();
    }
  }
}
