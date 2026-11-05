/**
 * Food web (trophic) diagram (07 §3.6). Nodes are species plus three abiotic nodes (plankton,
 * plants, detritus). The y position is the trophic level TL_j = 1 + sum_i w_ij TL_i, where w_ij
 * is the fraction of j's intake that came from i over the host's window (Ecopath convention:
 * abiotic nodes have TL 1), solved as (I - W^T) TL = 1. The x position comes from a small 1-D
 * force layout seeded by the previous frame, so the diagram does not jump. Edge width is log
 * energy flow; parasitism is dotted, scavenging dashed.
 */
import { ABIOTIC, type FlowKind, type FoodWeb, type SpeciesInfo } from './wire.js';
import { GLYPHS, rgb } from './charts.js';

/**
 * Trophic levels by Gaussian elimination with partial pivoting.
 * `w[i][j]` is the fraction of node j's intake that came from node i (columns sum to 1 or 0).
 * Nodes flagged in `basal` are fixed at TL 1. A node with no intake also gets TL 1.
 */
export function trophicLevels(w: readonly (readonly number[])[], basal: readonly boolean[]): number[] {
  const n = w.length;
  const a: number[][] = [];
  const b: number[] = new Array(n).fill(1);
  for (let j = 0; j < n; j++) {
    const row = new Array(n).fill(0) as number[];
    row[j] = 1;
    if (!basal[j]) for (let i = 0; i < n; i++) row[i]! -= w[i]![j]!;
    a.push(row);
  }
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
    if (Math.abs(a[p]![c]!) < 1e-12) continue; // singular (a closed loop with no basal input): leave as is
    [a[c], a[p]] = [a[p]!, a[c]!]; [b[c], b[p]] = [b[p]!, b[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r]![c]! / a[c]![c]!;
      if (f === 0) continue;
      for (let k = c; k < n; k++) a[r]![k]! -= f * a[c]![k]!;
      b[r]! -= f * b[c]!;
    }
  }
  return b.map((v, i) => (Math.abs(a[i]![i]!) < 1e-12 ? 1 : v / a[i]![i]!));
}

export interface WebNode { id: number; label: string; tl: number; biomass: number; colour: readonly number[]; glyph: string; abiotic: boolean; intake: number }
export interface WebEdge { from: number; to: number; flow: number; kind: FlowKind }
export interface WebModel { nodes: WebNode[]; edges: WebEdge[] }

const ABIOTIC_NODES: [number, string][] = [[ABIOTIC.plankton, 'plankton'], [ABIOTIC.plants, 'plants'], [ABIOTIC.detritus, 'detritus']];

/** Build nodes, edges and trophic levels from the host's flow list. */
export function buildWeb(web: FoodWeb, species: readonly SpeciesInfo[], abioticLabel: (k: string) => string): WebModel {
  const flows = new Map<string, WebEdge>();
  for (const [from, to, flow, kind] of web.flows) {
    if (!(flow > 0) || from === to) continue;
    const key = `${from}>${to}`;
    const e = flows.get(key);
    if (e) e.flow += flow; else flows.set(key, { from, to, flow, kind });
  }
  const used = new Set<number>();
  for (const e of flows.values()) { used.add(e.from); used.add(e.to); }
  const nodes: WebNode[] = [];
  for (const [id, k] of ABIOTIC_NODES) if (used.has(id)) nodes.push({ id, label: abioticLabel(k), tl: 1, biomass: 0, colour: [150, 175, 185], glyph: k === 'plankton' ? '∴' : k === 'plants' ? '♣' : '≈', abiotic: true, intake: 0 });
  for (const s of species) if (used.has(s.id) || s.count > 0) nodes.push({ id: s.id, label: s.name, tl: 1, biomass: s.biomassKg, colour: s.colour, glyph: GLYPHS[s.glyph % GLYPHS.length]!, abiotic: false, intake: 0 });
  const idx = new Map(nodes.map((nd, i) => [nd.id, i]));
  const edges = [...flows.values()].filter((e) => idx.has(e.from) && idx.has(e.to));
  for (const e of edges) nodes[idx.get(e.to)!]!.intake += e.flow;
  const n = nodes.length;
  const w = Array.from({ length: n }, () => new Array(n).fill(0) as number[]);
  for (const e of edges) { const j = idx.get(e.to)!; w[idx.get(e.from)!]![j]! += e.flow / nodes[j]!.intake; }
  const tl = trophicLevels(w, nodes.map((nd) => nd.abiotic));
  nodes.forEach((nd, i) => { nd.tl = tl[i]!; });
  return { nodes, edges };
}

/** 1-D force layout in x (y is fixed by TL), seeded by the previous positions in `prev` (0..1). */
export function layoutWeb(m: WebModel, prev: Map<number, number>, iterations = 80): Map<number, number> {
  const pos = new Map<number, number>();
  m.nodes.forEach((nd, i) => pos.set(nd.id, prev.get(nd.id) ?? (i + 0.5) / Math.max(1, m.nodes.length)));
  const ids = m.nodes.map((nd) => nd.id);
  const tl = new Map(m.nodes.map((nd) => [nd.id, nd.tl]));
  for (let it = 0; it < iterations; it++) {
    const f = new Map(ids.map((id) => [id, 0]));
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
      const ia = ids[a]!, ib = ids[b]!;
      const dx = pos.get(ia)! - pos.get(ib)!, dy = (tl.get(ia)! - tl.get(ib)!) * 0.25;
      const d2 = dx * dx + dy * dy + 1e-4;
      const push = 0.0009 / d2 * Math.sign(dx || (a < b ? -1 : 1));
      f.set(ia, f.get(ia)! + push); f.set(ib, f.get(ib)! - push);
    }
    for (const e of m.edges) {
      const dx = pos.get(e.to)! - pos.get(e.from)!;
      const pull = dx * 0.02;
      f.set(e.from, f.get(e.from)! + pull); f.set(e.to, f.get(e.to)! - pull);
    }
    for (const id of ids) pos.set(id, Math.min(0.97, Math.max(0.03, pos.get(id)! + Math.max(-0.03, Math.min(0.03, f.get(id)!)))));
  }
  return pos;
}

/** Draw the web. Returns node centres for hit testing and the data table. */
export function drawWeb(c: CanvasRenderingContext2D, w: number, h: number, m: WebModel, xs: Map<number, number>, tlLabel: string): Map<number, [number, number, number]> {
  c.clearRect(0, 0, w, h);
  const out = new Map<number, [number, number, number]>();
  if (m.nodes.length === 0) return out;
  const maxTl = Math.max(2, Math.ceil(Math.max(...m.nodes.map((nd) => nd.tl))));
  const L = 44, R = w - 16, T = 18, B = h - 26;
  const Y = (tl: number) => B - ((tl - 1) / (maxTl - 1)) * (B - T);
  c.font = '10px system-ui'; c.fillStyle = 'rgba(160,190,200,.8)'; c.strokeStyle = 'rgba(120,190,210,.12)'; c.lineWidth = 1;
  for (let k = 1; k <= maxTl; k++) { const y = Y(k); c.beginPath(); c.moveTo(L, y); c.lineTo(R, y); c.stroke(); c.fillText(String(k), 22, y + 3); }
  c.save(); c.translate(10, (T + B) / 2); c.rotate(-Math.PI / 2); c.textAlign = 'center'; c.fillText(tlLabel, 0, 0); c.restore();
  const maxB = Math.max(1e-9, ...m.nodes.map((nd) => nd.biomass));
  const maxF = Math.max(1e-9, ...m.edges.map((e) => e.flow));
  for (const nd of m.nodes) {
    const r = nd.abiotic ? 9 : 5 + 11 * Math.sqrt(nd.biomass / maxB);
    out.set(nd.id, [L + (xs.get(nd.id) ?? 0.5) * (R - L), Y(nd.tl), r]);
  }
  for (const e of m.edges) {
    const a = out.get(e.from), b = out.get(e.to);
    if (!a || !b) continue;
    c.strokeStyle = e.kind === 1 ? 'rgba(232,192,106,.75)' : 'rgba(160,210,225,.45)';
    c.lineWidth = 0.6 + 3.4 * Math.log1p(e.flow) / Math.log1p(maxF);
    c.setLineDash(e.kind === 1 ? [2, 3] : e.kind === 2 ? [6, 3] : []);
    c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
    // arrowhead at the eater
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), tx = b[0] - Math.cos(ang) * (b[2] + 2), ty = b[1] - Math.sin(ang) * (b[2] + 2);
    c.setLineDash([]); c.fillStyle = c.strokeStyle;
    c.beginPath(); c.moveTo(tx, ty); c.lineTo(tx - 7 * Math.cos(ang - 0.4), ty - 7 * Math.sin(ang - 0.4)); c.lineTo(tx - 7 * Math.cos(ang + 0.4), ty - 7 * Math.sin(ang + 0.4)); c.closePath(); c.fill();
  }
  c.setLineDash([]);
  c.font = '11px system-ui';
  const placed: [number, number, number, number][] = [];
  const free = (x0: number, y0: number, x1: number, y1: number) => !placed.some(([a, b, cc, d]) => x0 < cc && x1 > a && y0 < d && y1 > b);
  for (const nd of m.nodes) {
    const [x, y, r] = out.get(nd.id)!;
    c.fillStyle = nd.abiotic ? 'rgba(40,60,70,.95)' : rgb(nd.colour, 0.85);
    c.strokeStyle = 'rgba(230,245,250,.7)'; c.lineWidth = 1;
    c.beginPath();
    if (nd.abiotic) c.rect(x - r * 1.3, y - r * 0.8, r * 2.6, r * 1.6); else c.arc(x, y, r, 0, Math.PI * 2);
    c.fill(); c.stroke();
    c.fillStyle = nd.abiotic ? '#d3e7ee' : '#02070b'; c.textAlign = 'center';
    c.fillText(nd.glyph, x, y + 4);
    c.fillStyle = 'rgba(220,236,242,.92)';
    c.font = nd.abiotic ? '11px system-ui' : 'italic 11px system-ui';
    // label above the node, or below it when that would overlap a label already drawn
    const tw = c.measureText(nd.label).width, lx = Math.min(R - tw / 2, Math.max(L + tw / 2, x));
    let ly = y - r - 4;
    if (!free(lx - tw / 2, ly - 11, lx + tw / 2, ly + 2)) ly = y + r + 13;
    placed.push([lx - tw / 2, ly - 11, lx + tw / 2, ly + 2]);
    c.fillText(nd.label, lx, ly);
    c.font = '11px system-ui'; c.textAlign = 'left';
  }
  return out;
}
