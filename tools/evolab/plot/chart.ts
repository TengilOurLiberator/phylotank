/**
 * Offline line charts rendered to PNG: one y axis, recessive grid, 2 px lines, a legend for two or
 * more series, categorical colours in a fixed order (the validated reference palette, light mode).
 */
import { encodePng } from './png.js';
import { glyph, GLYPH_H, GLYPH_W } from './font.js';

export const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'] as const;
const SURFACE = '#fcfcfb';
const INK = '#0b0b0b';
const INK2 = '#52514e';
const GRID = '#e6e5e0';

export interface Series { name: string; x: number[]; y: number[]; colour?: string }
export interface ChartSpec {
  title: string;
  xLabel: string;
  yLabel: string;
  series: Series[];
  logY?: boolean;
  yMin?: number;
  width?: number;
  height?: number;
}

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

class Canvas {
  readonly px: Uint8Array;
  constructor(readonly w: number, readonly h: number, bg: string) {
    this.px = new Uint8Array(w * h * 4);
    const [r, g, b] = hex(bg);
    for (let i = 0; i < w * h; i++) { this.px[i * 4] = r; this.px[i * 4 + 1] = g; this.px[i * 4 + 2] = b; this.px[i * 4 + 3] = 255; }
  }
  set(x: number, y: number, c: [number, number, number]): void {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.px[i] = c[0]; this.px[i + 1] = c[1]; this.px[i + 2] = c[2];
  }
  rect(x0: number, y0: number, w: number, h: number, c: string): void {
    const cc = hex(c);
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, cc);
  }
  line(x0: number, y0: number, x1: number, y1: number, c: string, thick = 1): void {
    const cc = hex(c);
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const y = y0 + ((y1 - y0) * i) / n;
      for (let dy = 0; dy < thick; dy++) for (let dx = 0; dx < thick; dx++) this.set(x + dx - (thick >> 1), y + dy - (thick >> 1), cc);
    }
  }
  text(x: number, y: number, s: string, c: string, scale = 1, vertical = false): void {
    const cc = hex(c);
    let ox = 0;
    for (const ch of s) {
      const g = glyph(ch);
      for (let r = 0; r < GLYPH_H; r++) {
        for (let k = 0; k < GLYPH_W; k++) {
          if (!((g[r]! >> (GLYPH_W - 1 - k)) & 1)) continue;
          for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
            if (vertical) this.set(x + r * scale + sy, y - (ox + k * scale + sx), cc);
            else this.set(x + ox + k * scale + sx, y + r * scale + sy, cc);
          }
        }
      }
      ox += (GLYPH_W + 1) * scale;
    }
  }
}

export function textWidth(s: string, scale = 1): number { return s.length * (GLYPH_W + 1) * scale; }

function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

export function fmt(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e5 || a < 1e-3) return v.toExponential(0).replace('+', '');
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, '');
  if (a >= 1) return v.toFixed(2).replace(/\.?0+$/, '');
  return v.toPrecision(2);
}

export function renderChart(spec: ChartSpec): Uint8Array {
  const W = spec.width ?? 900, H = spec.height ?? 480;
  const cv = new Canvas(W, H, SURFACE);
  const left = 78, right = 20, top = 44, bottom = 52;
  const pw = W - left - right, ph = H - top - bottom;
  const series = spec.series.map((s, i) => ({ ...s, colour: s.colour ?? PALETTE[i % PALETTE.length]! }));
  const tf = (v: number): number => (spec.logY ? Math.log10(v) : v);
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const s of series) {
    for (let i = 0; i < s.x.length; i++) {
      const y = s.y[i]!;
      if (!Number.isFinite(y) || (spec.logY && y <= 0)) continue;
      xmin = Math.min(xmin, s.x[i]!); xmax = Math.max(xmax, s.x[i]!);
      ymin = Math.min(ymin, tf(y)); ymax = Math.max(ymax, tf(y));
    }
  }
  if (!Number.isFinite(xmin)) { xmin = 0; xmax = 1; ymin = 0; ymax = 1; }
  if (spec.yMin !== undefined && !spec.logY) ymin = Math.min(ymin, spec.yMin);
  if (xmax === xmin) xmax = xmin + 1;
  if (ymax === ymin) { ymax += 0.5 * Math.abs(ymax || 1); ymin -= 0.5 * Math.abs(ymin || 1); }
  const ys = spec.logY ? 1 : niceStep(ymax - ymin, 5);
  if (!spec.logY) { ymin = Math.floor(ymin / ys) * ys; ymax = Math.ceil(ymax / ys) * ys; } else { ymin = Math.floor(ymin); ymax = Math.ceil(ymax); }
  const X = (x: number): number => left + ((x - xmin) / (xmax - xmin)) * pw;
  const Y = (y: number): number => top + ph - ((y - ymin) / (ymax - ymin)) * ph;
  // grid and y ticks
  for (let v = ymin; v <= ymax + ys * 1e-9; v += ys) {
    const yy = Math.round(Y(v));
    cv.line(left, yy, left + pw, yy, GRID);
    const lab = spec.logY ? fmt(Math.pow(10, v)) : fmt(v);
    cv.text(left - 6 - textWidth(lab), yy - 3, lab, INK2);
  }
  const xs = niceStep(xmax - xmin, 8);
  for (let v = Math.ceil(xmin / xs) * xs; v <= xmax + xs * 1e-9; v += xs) {
    const xx = Math.round(X(v));
    cv.line(xx, top + ph, xx, top + ph + 4, INK2);
    const lab = fmt(v);
    cv.text(xx - textWidth(lab) / 2, top + ph + 8, lab, INK2);
  }
  cv.line(left, top + ph, left + pw, top + ph, INK2);
  // series
  for (const s of series) {
    let px: number | null = null, py: number | null = null;
    for (let i = 0; i < s.x.length; i++) {
      const y = s.y[i]!;
      if (!Number.isFinite(y) || (spec.logY && y <= 0)) { px = null; continue; }
      const xx = X(s.x[i]!), yy = Y(tf(y));
      if (px !== null && py !== null) cv.line(px, py, xx, yy, s.colour, 2);
      else cv.rect(Math.round(xx) - 1, Math.round(yy) - 1, 2, 2, s.colour);
      px = xx; py = yy;
    }
  }
  // title, labels, legend
  cv.text(left, 14, spec.title, INK, 2);
  cv.text(left + pw / 2 - textWidth(spec.xLabel) / 2, H - 18, spec.xLabel, INK2);
  cv.text(14, top + ph / 2 + textWidth(spec.yLabel) / 2, spec.yLabel + (spec.logY ? ' (LOG)' : ''), INK2, 1, true);
  if (series.length >= 2) {
    let lx = left + pw;
    const ly = top + 6;
    const items = series.map((s) => ({ s, w: 16 + textWidth(s.name) + 14 }));
    const rows: (typeof items)[] = [[]];
    let rowW = 0;
    for (const it of items) {
      if (rowW + it.w > pw * 0.95 && rows[rows.length - 1]!.length) { rows.push([]); rowW = 0; }
      rows[rows.length - 1]!.push(it); rowW += it.w;
    }
    rows.forEach((row, ri) => {
      lx = left + pw - row.reduce((a, it) => a + it.w, 0);
      for (const it of row) {
        cv.rect(Math.round(lx), ly + ri * 12, 10, 4, it.s.colour);
        cv.text(Math.round(lx) + 14, ly + ri * 12 - 2, it.s.name, INK);
        lx += it.w;
      }
    });
  }
  return encodePng(W, H, cv.px);
}
