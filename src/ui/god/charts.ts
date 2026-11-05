/**
 * Canvas 2D drawing for the god window: minimap with zones, timeline strip, population chart,
 * species phylogeny (spindle style), gene histogram and diversity series. Species also carry a
 * glyph so charts never rely on colour alone (07 §6.1).
 */
import type { SimEvent } from '../../core/index.js';
import { diversity, sampleCounts } from './diversity.js';
import type { SnapshotInfo, SpeciesInfo } from './wire.js';

export const GLYPHS = ['●', '■', '▲', '◆', '★', '✚', '⬟', '⬢', '▼', '◐', '◑', '✖', '♦', '♠', '♣', '♥', '◉', '▣', '⬣', '✦', '✧', '⧫', '⬤', '◈'];
/** Size a canvas to its CSS box at the device pixel ratio; returns a context in CSS pixels. */
export function prep(cv: HTMLCanvasElement, cssH?: number): { c: CanvasRenderingContext2D; w: number; h: number } {
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const w = Math.max(10, cv.clientWidth || cv.width), h = Math.max(10, cssH ?? (cv.clientHeight || cv.height));
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const c = cv.getContext('2d')!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { c, w, h };
}
export const rgb = (c: readonly number[], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export interface MiniLayers { zones: boolean; currents: boolean; light: boolean; temp: boolean; pop: boolean; events: boolean }
export interface Dust { rect: [number, number, number, number]; n: number; x: Uint16Array; y: Uint16Array; colour: Uint8Array }

export function drawMinimap(
  c: CanvasRenderingContext2D, w: number, h: number, tank: { w: number; h: number }, dust: Dust | null,
  palette: readonly (readonly number[])[], view: [number, number, number, number] | null, layers: MiniLayers,
  vents: readonly [number, number][], godEvents: readonly { pos: [number, number]; radius: number; age: number }[], highlight?: number,
  speciesOfSlot?: (s: number) => number | undefined,
): void {
  const sx = w / tank.w, sy = h / tank.h;
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#0d3446'); g.addColorStop(0.33, '#082231'); g.addColorStop(0.66, '#041320'); g.addColorStop(1, '#02070c');
  c.fillStyle = g; c.fillRect(0, 0, w, h);
  if (layers.light) { const lg = c.createLinearGradient(0, 0, 0, h * 0.5); lg.addColorStop(0, 'rgba(255,240,180,.25)'); lg.addColorStop(1, 'rgba(255,240,180,0)'); c.fillStyle = lg; c.fillRect(0, 0, w, h * 0.5); }
  if (layers.temp) { const tg = c.createLinearGradient(0, 0, 0, h); tg.addColorStop(0, 'rgba(255,140,80,.22)'); tg.addColorStop(1, 'rgba(80,140,255,.22)'); c.fillStyle = tg; c.fillRect(0, 0, w, h); }
  if (layers.zones) {
    c.strokeStyle = 'rgba(160,220,235,.25)'; c.setLineDash([3, 3]); c.lineWidth = 1;
    for (const f of [0.33, 0.66]) { c.beginPath(); c.moveTo(0, h * f); c.lineTo(w, h * f); c.stroke(); }
    c.setLineDash([]);
    c.fillStyle = 'rgba(190,225,235,.5)'; c.font = `${Math.max(9, Math.min(12, Math.round(h / 14)))}px system-ui`;
    c.fillText('photic', 4, h * 0.1); c.fillText('twilight', 4, h * 0.43); c.fillText('midnight', 4, h * 0.76);
    // seabed
    c.fillStyle = 'rgba(40,30,25,.9)';
    c.beginPath(); c.moveTo(0, h);
    for (let x = 0; x <= w; x += 4) c.lineTo(x, h - (3 + 3 * Math.sin(x * 0.05) + 2 * Math.sin(x * 0.13)) * (h / 120));
    c.lineTo(w, h); c.fill();
    for (const v of vents) { c.fillStyle = 'rgba(255,150,80,.9)'; c.beginPath(); c.arc(v[0] * sx, v[1] * sy, 3, 0, Math.PI * 2); c.fill(); }
  }
  if (layers.currents) {
    c.strokeStyle = 'rgba(150,210,230,.35)'; c.lineWidth = 1;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 16; i++) {
      const x = ((i + 0.5) / 16) * w, y = ((j + 0.5) / 8) * h, a = Math.sin(j * 0.9 + i * 0.3) * 0.6;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * 6, y + Math.sin(a) * 6); c.stroke();
    }
  }
  if (dust && layers.pop) {
    const [x0, y0, x1, y1] = dust.rect;
    for (let s = 0; s < dust.n; s++) {
      const col = dust.colour[s]!;
      if (col === 255) continue;
      const sp = speciesOfSlot?.(s);
      const dim = highlight !== undefined && sp !== highlight;
      c.fillStyle = rgb(palette[col % palette.length] ?? [200, 230, 255], dim ? 0.15 : 0.85);
      const px = ((x0 + (dust.x[s]! / 65535) * (x1 - x0)) * sx), py = ((y0 + (dust.y[s]! / 65535) * (y1 - y0)) * sy);
      const ds = w > 300 ? 2.2 : 1.5;
      c.fillRect(px - ds / 2, py - ds / 2, ds, ds);
    }
  }
  if (layers.events) for (const e of godEvents) {
    c.strokeStyle = `rgba(239,140,114,${Math.max(0, 0.9 - e.age)})`; c.lineWidth = 1.5;
    c.beginPath(); c.arc(e.pos[0] * sx, e.pos[1] * sy, Math.max(3, e.radius * sx), 0, Math.PI * 2); c.stroke();
  }
  if (view) {
    c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 1.2;
    c.strokeRect(view[0] * sx, view[1] * sy, (view[2] - view[0]) * sx, (view[3] - view[1]) * sy);
  }
}

export type EvFilter = 'god' | 'life' | 'death' | 'disease' | 'records';
export function eventClass(e: SimEvent): EvFilter | null {
  switch (e.k as string) {
    case 'god': case 'release': case 'setting': case 'rename': return 'god';
    case 'speciation': case 'school': case 'newRole': case 'migration': case 'bloomFront': case 'hunt': case 'birth': return 'life';
    case 'extinction': case 'massDeath': case 'death': case 'frenzy': case 'carcass': return 'death';
    case 'outbreak': case 'epidemicFront': case 'infect': return 'disease';
    case 'giant': case 'record': case 'novelty': case 'endangered': return 'records';
    default: return null;
  }
}
const MARK: Record<EvFilter, [string, string]> = { god: ['#ef8c72', '◆'], life: ['#8ee0a0', '●'], death: ['#b9c4c9', '✕'], disease: ['#e8c06a', '▲'], records: ['#62d2e8', '★'] };

export interface TimelineHit { x: number; ev?: SimEvent; snap?: SnapshotInfo }
export function drawTimeline(
  c: CanvasRenderingContext2D, w: number, h: number, events: readonly SimEvent[], snaps: readonly SnapshotInfo[], nowTick: number,
  spanTicks: number, filters: ReadonlySet<EvFilter>, hover: number,
): TimelineHit[] {
  c.clearRect(0, 0, w, h);
  const t0 = Math.max(0, nowTick - spanTicks);
  const X = (t: number) => 12 + ((t - t0) / Math.max(1, nowTick - t0)) * (w - 40);
  c.strokeStyle = 'rgba(120,190,210,.35)'; c.lineWidth = 1;
  c.beginPath(); c.moveTo(12, h / 2); c.lineTo(w - 28, h / 2); c.stroke();
  c.fillStyle = 'rgba(150,180,190,.6)'; c.font = '10px system-ui';
  const day = 36000;
  for (let d = Math.ceil(t0 / (day / 4)) * (day / 4); d < nowTick; d += day / 4) {
    const x = X(d); c.fillRect(x, h / 2 - 3, 1, 6);
    if (d % day === 0) c.fillText(`day ${d / day + 1}`, x + 2, h - 6);
  }
  const hits: TimelineHit[] = [];
  for (const s of snaps) {
    if (s.tick < t0) continue;
    const x = X(s.tick);
    c.fillStyle = s.kind === 'manual' ? '#e8c06a' : 'rgba(232,192,106,.5)';
    c.beginPath(); c.moveTo(x, 6); c.lineTo(x + 5, 10); c.lineTo(x, 14); c.fill();
    c.fillRect(x - 0.5, 6, 1, h / 2 - 6);
    hits.push({ x, snap: s });
  }
  c.font = '12px system-ui'; c.textAlign = 'center';
  for (const e of events) {
    if (e.t < t0) continue;
    const cls = eventClass(e);
    if (!cls || !filters.has(cls)) continue;
    if (e.k === 'birth' || e.k === 'death') continue;
    const x = X(e.t);
    const [col, glyph] = MARK[cls];
    c.fillStyle = col;
    c.fillText(glyph, x, h / 2 + (cls === 'god' ? -8 : cls === 'death' ? 14 : 4));
    hits.push({ x, ev: e });
  }
  c.textAlign = 'left';
  c.fillStyle = 'rgba(98,210,232,.9)'; c.fillRect(w - 28, 8, 2, h - 16);
  c.fillStyle = 'rgba(200,225,232,.8)'; c.font = '10px system-ui'; c.fillText('now', w - 24, 18);
  if (hover >= 0) { c.fillStyle = 'rgba(255,255,255,.25)'; c.fillRect(hover - 0.5, 0, 1, h); }
  return hits;
}

/** Stacked population chart from history samples. */
export function drawPopulation(c: CanvasRenderingContext2D, w: number, h: number, history: readonly [number, number[]][], species: readonly SpeciesInfo[], log: boolean, events: readonly SimEvent[]): void {
  c.clearRect(0, 0, w, h);
  const pad = { l: 40, r: 120, t: 10, b: 20 };
  const W = w - pad.l - pad.r, H = h - pad.t - pad.b;
  if (history.length < 2) { c.fillStyle = '#8fb0bb'; c.fillText('…', pad.l, pad.t + 20); return; }
  const t0 = history[0]![0], t1 = history[history.length - 1]![0];
  const ids = species.map((s) => s.id);
  const totals = history.map(([, f]) => { const m = sampleCounts(f); return ids.map((id) => m.get(id) ?? 0); });
  const maxTot = Math.max(1, ...totals.map((r) => r.reduce((a, b) => a + b, 0)));
  const yv = (v: number) => pad.t + H - (log ? (Math.log10(1 + v) / Math.log10(1 + maxTot)) : v / maxTot) * H;
  const X = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * W;
  const base = new Array(history.length).fill(0) as number[];
  ids.forEach((id, k) => {
    const sp = species[k]!;
    c.beginPath();
    history.forEach(([t], i) => { const y = yv(base[i]! + totals[i]![k]!); if (i) c.lineTo(X(t), y); else c.moveTo(X(t), y); });
    for (let i = history.length - 1; i >= 0; i--) c.lineTo(X(history[i]![0]), yv(base[i]!));
    c.closePath();
    c.fillStyle = rgb(sp.colour, 0.55); c.fill();
    c.strokeStyle = rgb(sp.colour, 0.9); c.lineWidth = 1; c.stroke();
    history.forEach((_, i) => { base[i]! += totals[i]![k]!; });
  });
  c.strokeStyle = 'rgba(150,180,190,.4)'; c.beginPath(); c.moveTo(pad.l, pad.t); c.lineTo(pad.l, pad.t + H); c.lineTo(pad.l + W, pad.t + H); c.stroke();
  c.fillStyle = 'rgba(160,190,200,.8)'; c.font = '10px system-ui';
  c.fillText(String(maxTot), 4, pad.t + 8); c.fillText('0', 4, pad.t + H);
  for (const e of events) if (e.k === 'god' || e.k === 'speciation' || e.k === 'extinction' || e.k === 'release') {
    if (e.t < t0) continue;
    const x = X(e.t);
    c.strokeStyle = e.k === 'god' ? 'rgba(239,140,114,.7)' : 'rgba(150,230,170,.5)'; c.setLineDash([2, 3]);
    c.beginPath(); c.moveTo(x, pad.t); c.lineTo(x, pad.t + H); c.stroke(); c.setLineDash([]);
  }
  // direct labels with glyphs (no colour-only legend)
  const last = totals[totals.length - 1]!;
  let yAcc = 0;
  const labels: { y: number; s: SpeciesInfo; n: number }[] = [];
  ids.forEach((_, k) => { const n = last[k]!; if (n > 0) labels.push({ y: yv(yAcc + n / 2), s: species[k]!, n }); yAcc += n; });
  let prevY = -99;
  for (const l of labels.sort((a, b) => b.y - a.y)) {
    const y = Math.min(l.y, prevY === -99 ? l.y : prevY - 11);
    prevY = y;
    c.fillStyle = rgb(l.s.colour, 1); c.fillText(`${GLYPHS[l.s.glyph % GLYPHS.length]} ${l.s.name} ${l.n}`, pad.l + W + 6, y + 3);
  }
}

/** Species tree with time on x; branch thickness ~ log population (spindle style). */
export function drawPhylogeny(c: CanvasRenderingContext2D, w: number, h: number, species: readonly SpeciesInfo[], nowTick: number): void {
  c.clearRect(0, 0, w, h);
  if (species.length === 0) return;
  const t0 = Math.min(...species.map((s) => s.bornTick));
  const X = (t: number) => 20 + ((t - t0) / Math.max(1, nowTick - t0)) * (w - 190);
  // depth-first order from roots, stable by id
  const kids = new Map<number, SpeciesInfo[]>();
  for (const s of species) { const k = kids.get(s.parent) ?? []; k.push(s); kids.set(s.parent, k); }
  const order: SpeciesInfo[] = [];
  const visit = (p: number) => { for (const s of (kids.get(p) ?? []).sort((a, b) => a.id - b.id)) { order.push(s); visit(s.id); } };
  visit(-1);
  const row = new Map<number, number>();
  order.forEach((s, i) => row.set(s.id, 16 + (i * (h - 30)) / Math.max(1, order.length - 1)));
  c.font = '11px system-ui';
  for (const s of order) {
    const y = row.get(s.id)!;
    const x0 = X(s.bornTick), x1 = X(s.extinctTick ?? nowTick);
    if (s.parent >= 0 && row.has(s.parent)) {
      c.strokeStyle = 'rgba(150,190,200,.5)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x0, row.get(s.parent)!); c.lineTo(x0, y); c.stroke();
    }
    const th = s.count > 0 ? 1.5 + Math.log10(1 + s.count) * 2.4 : 1;
    c.strokeStyle = rgb(s.colour, s.extinctTick !== undefined ? 0.35 : 0.9); c.lineWidth = th;
    c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke();
    const mark = s.origin === 'designed' ? '◇' : s.origin === 'imported' ? '○' : s.origin === 'template' ? '◇' : '•';
    c.fillStyle = 'rgba(210,230,235,.85)';
    c.fillText(`${mark} ${s.name}${s.extinctTick !== undefined ? ' ×' : ''}`, Math.min(w - 170, x1 + 6), y + 4);
  }
}

export function drawHistogram(c: CanvasRenderingContext2D, w: number, h: number, series: { bins: number[]; colour: readonly number[]; label: string }[]): void {
  c.clearRect(0, 0, w, h);
  const max = Math.max(1, ...series.flatMap((s) => s.bins));
  const bw = (w - 20) / 32;
  series.forEach((s, k) => {
    c.fillStyle = rgb(s.colour, 0.55);
    s.bins.forEach((v, i) => { const bh = (v / max) * (h - 30); c.fillRect(10 + i * bw + k * (bw / series.length), h - 18 - bh, bw / series.length - 1, bh); });
  });
  c.fillStyle = 'rgba(160,190,200,.8)'; c.font = '10px system-ui';
  c.fillText('min', 10, h - 4); c.textAlign = 'right'; c.fillText('max', w - 10, h - 4); c.textAlign = 'left';
}

export function diversitySeries(history: readonly [number, number[]][]): { t: number; richness: number; shannon: number; effective: number; simpson: number }[] {
  return history.map(([t, f]) => ({ t, ...diversity([...sampleCounts(f).values()]) }));
}
export function drawLines(c: CanvasRenderingContext2D, w: number, h: number, series: { label: string; colour: string; values: number[]; dash?: number[] }[]): void {
  c.clearRect(0, 0, w, h);
  const pad = 30;
  series.forEach((s, k) => {
    const max = Math.max(1e-9, ...s.values), min = Math.min(0, ...s.values);
    c.strokeStyle = s.colour; c.lineWidth = 1.5; c.setLineDash(s.dash ?? []);
    c.beginPath();
    s.values.forEach((v, i) => { const x = pad + (i / Math.max(1, s.values.length - 1)) * (w - pad - 10), y = 10 + (1 - (v - min) / (max - min)) * (h - 30); if (i) c.lineTo(x, y); else c.moveTo(x, y); });
    c.stroke(); c.setLineDash([]);
    c.fillStyle = s.colour; c.font = '11px system-ui';
    c.fillText(`${s.label}: ${s.values.length ? s.values[s.values.length - 1]!.toFixed(2) : '–'}`, pad + k * 150, h - 4);
  });
}

/**
 * Gene drift heat map (07 §3.6): time on x, gene value (32 bins, low at the bottom) on y,
 * density as brightness. Each column is normalised to its own maximum so a shrinking species
 * still shows where its genes sit. Returns the tick range drawn.
 */
export function drawDrift(c: CanvasRenderingContext2D, w: number, h: number, samples: readonly [number, number[]][], colour: readonly number[], labels: { lo: string; hi: string; t0: (tick: number) => string } = { lo: 'min', hi: 'max', t0: String }): [number, number] | null {
  c.clearRect(0, 0, w, h);
  if (samples.length === 0) return null;
  c.font = '10px system-ui';
  const L = Math.max(34, c.measureText(labels.lo).width + 10, c.measureText(labels.hi).width + 10), R = w - 8, T = 8, B = h - 22;
  const t0 = samples[0]![0], t1 = Math.max(t0 + 1, samples[samples.length - 1]![0]);
  const X = (t: number) => L + ((t - t0) / (t1 - t0)) * (R - L);
  const bh = (B - T) / 32;
  c.fillStyle = '#02070b'; c.fillRect(L, T, R - L, B - T);
  for (let i = 0; i < samples.length; i++) {
    const [tk, bins] = samples[i]!;
    const x0 = X(tk), x1 = i + 1 < samples.length ? X(samples[i + 1]![0]) : Math.max(x0 + 2, R);
    const max = Math.max(1, ...bins);
    for (let b = 0; b < 32; b++) {
      const v = (bins[b] ?? 0) / max;
      if (v <= 0) continue;
      c.fillStyle = rgb(colour, 0.08 + 0.92 * Math.sqrt(v));
      c.fillRect(x0, B - (b + 1) * bh, Math.max(1, x1 - x0 + 0.5), bh + 0.5);
    }
  }
  c.strokeStyle = 'rgba(120,190,210,.3)'; c.lineWidth = 1; c.strokeRect(L + 0.5, T + 0.5, R - L - 1, B - T - 1);
  c.fillStyle = 'rgba(160,190,200,.85)'; c.font = '10px system-ui';
  c.fillText(labels.hi, 4, T + 9); c.fillText(labels.lo, 4, B);
  c.fillText(labels.t0(t0), L, h - 6); c.textAlign = 'right'; c.fillText(labels.t0(t1), R, h - 6); c.textAlign = 'left';
  return [t0, t1];
}
