/**
 * Render templates (06 §6.1.3): the grown skeleton as a parent-first node list, the capsules
 * between nodes, the L1 macro capsules (chain simplification, at most 8), the L2 core capsules
 * (at most 3), L0 chunks of 8 capsules with rest-pose neighbour lists (§6.1.5), light organs
 * and the look. All lengths are in body lengths; the renderer scales by the creature's length.
 */
import type { Phenotype } from '../core/index.js';
import { KIND, ORGAN } from '../core/index.js';
import { lookFromGenes, type Look, type LookGenes } from './colour.js';

export const CAP = { BODY: 0, FIN: 1, GUT: 2, EYE: 3 } as const;
export type CapKind = (typeof CAP)[keyof typeof CAP];

export interface TNode {
  parent: number;       // -1 for the root
  len: number;          // distance from the parent node, body lengths
  angle: number;        // rest angle relative to the parent's absolute angle, rad
  r0: number;           // capsule radius at the parent end
  r1: number;           // capsule radius at this node
  kind: CapKind;
  s: number;            // arc-length coordinate along its chain, 0..1
  chain: number;
  amp: number;          // procedural swing amplitude, rad
  lag: number;          // phase lag of the swing, rad
  pulse: number;        // radius pulse amplitude (jets), fraction
  bendW: number;        // weight of the streamed body bend
  alpha: number;        // membrane alpha for fins
}

export interface Capsule { a: number; b: number; ra: number; rb: number; kind: CapKind; s0: number; s1: number; alpha: number }
export interface Organ { node: number; radius: number; hueShift: number; hue?: number; chroma?: number; periodS: number; phase: number; duty: number; gain: number; depth: number }
export interface Chunk { start: number; end: number; nb: number[] }

export type SwimMode = 'undulate' | 'flap' | 'jet' | 'drift';

export interface RenderTemplate {
  key: string;
  nodes: TNode[];
  capsules: Capsule[];
  macro: Capsule[];
  core: Capsule[];
  chunks: Chunk[];
  organs: Organ[];
  look: Look;
  swim: SwimMode;
  /** Radially symmetric bodies are never mirrored when they turn. */
  radial: boolean;
  /** Typical stroke frequency at 1 body length per second, Hz (for synthetic phase). */
  strokeHz: number;
  /** Rest-pose centre of the capsule bounds (body lengths), subtracted when posing. */
  centre: [number, number];
  /** Rest-pose half extent from the centre including the largest radius, body lengths. */
  extent: number;
  /** Median capsule radius (body lengths), sets the smooth-union blend radius. */
  medianR: number;
  rMax: number;
}

export const MAX_MACRO = 8;
export const MAX_CORE = 3;
export const CHUNK = 8;
/** Bodies with at most this many capsules are one chunk: a pixel then evaluates each capsule once. */
export const SINGLE_CHUNK_MAX = 32;

/** Rest-pose node positions in body lengths (x forward, y down = ventral). */
export function restPositions(nodes: readonly TNode[]): { x: Float64Array; y: Float64Array; ang: Float64Array } {
  const n = nodes.length;
  const x = new Float64Array(n), y = new Float64Array(n), ang = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const nd = nodes[i]!;
    if (nd.parent < 0) { ang[i] = nd.angle; continue; }
    const p = nd.parent;
    ang[i] = ang[p]! + nd.angle;
    x[i] = x[p]! + nd.len * Math.cos(ang[i]!);
    y[i] = y[p]! + nd.len * Math.sin(ang[i]!);
  }
  return { x, y, ang };
}

const capArea = (len: number, ra: number, rb: number): number => len * (ra + rb) + 0.5 * Math.PI * (ra * ra + rb * rb);

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const bax = bx - ax, bay = by - ay;
  const l2 = bax * bax + bay * bay;
  const h = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * bax + (py - ay) * bay) / l2)) : 0;
  return Math.hypot(px - ax - bax * h, py - ay - bay * h);
}

/** Approximate distance between two capsules' surfaces in rest pose. */
function capGap(c: Capsule, d: Capsule, P: { x: Float64Array; y: Float64Array }): number {
  let best = Infinity;
  for (let k = 0; k <= 4; k++) {
    const t = k / 4;
    const px = P.x[c.a]! + (P.x[c.b]! - P.x[c.a]!) * t, py = P.y[c.a]! + (P.y[c.b]! - P.y[c.a]!) * t;
    const r = c.ra + (c.rb - c.ra) * t;
    best = Math.min(best, segDist(px, py, P.x[d.a]!, P.y[d.a]!, P.x[d.b]!, P.y[d.b]!) - r - Math.max(d.ra, d.rb));
  }
  return best;
}

/**
 * L1 macro capsules by chain simplification (06 §6.1.4): merge a capsule into its parent's
 * while the merged straight tapered capsule stays within 10% of the pair's area and the
 * joint stays inside it, then keep the 8 largest by area.
 */
export function simplify(caps: readonly Capsule[], nodes: readonly TNode[], max: number, kinds: readonly CapKind[]): Capsule[] {
  const P = restPositions(nodes);
  const work = caps.filter((c) => kinds.includes(c.kind)).map((c) => ({ ...c }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < work.length && !merged; i++) {
      const c = work[i]!;
      // the child capsule that continues this one: starts at c.b, same kind, and is c.b's only such child
      const kids = work.filter((d) => d.a === c.b && d.kind === c.kind && nodes[d.b]!.chain === nodes[c.b]!.chain);
      if (kids.length !== 1) continue;
      const d = kids[0]!;
      const lenC = Math.hypot(P.x[c.b]! - P.x[c.a]!, P.y[c.b]! - P.y[c.a]!);
      const lenD = Math.hypot(P.x[d.b]! - P.x[d.a]!, P.y[d.b]! - P.y[d.a]!);
      const lenM = Math.hypot(P.x[d.b]! - P.x[c.a]!, P.y[d.b]! - P.y[c.a]!);
      const sum = capArea(lenC, c.ra, c.rb) + capArea(lenD, d.ra, d.rb);
      const m = capArea(lenM, c.ra, d.rb);
      const t = lenM > 0 ? lenC / (lenC + lenD) : 0.5;
      const rMid = c.ra + (d.rb - c.ra) * t;
      const off = segDist(P.x[c.b]!, P.y[c.b]!, P.x[c.a]!, P.y[c.a]!, P.x[d.b]!, P.y[d.b]!);
      if (Math.abs(m - sum) <= 0.1 * sum && off <= 0.5 * rMid && Math.abs(rMid - c.rb) <= 0.35 * Math.max(c.rb, 1e-6)) {
        c.b = d.b; c.rb = d.rb; c.s1 = d.s1;
        work.splice(work.indexOf(d), 1);
        merged = true;
      }
    }
  }
  const area = (c: Capsule): number => capArea(Math.hypot(P.x[c.b]! - P.x[c.a]!, P.y[c.b]! - P.y[c.a]!), c.ra, c.rb) * (c.kind === CAP.FIN ? 0.5 : 1);
  if (work.length > max) {
    const keep = work.map((c, i) => ({ c, i, a: area(c) })).sort((p, q) => q.a - p.a || p.i - q.i).slice(0, max);
    return keep.sort((p, q) => p.i - q.i).map((k) => k.c);
  }
  return work;
}

/** L0 chunks of 8 capsules, each with the rest-pose neighbours that can affect its pixels. */
export function buildChunks(caps: readonly Capsule[], nodes: readonly TNode[], k: number, rMax: number): Chunk[] {
  if (caps.length <= SINGLE_CHUNK_MAX) return [{ start: 0, end: caps.length, nb: [] }];
  const P = restPositions(nodes);
  const chunks: Chunk[] = [];
  const slack = 0.12;
  for (let s = 0; s < caps.length; s += CHUNK) {
    const e = Math.min(caps.length, s + CHUNK);
    const nb: number[] = [];
    for (let j = 0; j < caps.length; j++) {
      if (j >= s && j < e) continue;
      for (let i = s; i < e; i++) if (capGap(caps[i]!, caps[j]!, P) < k + rMax + slack) { nb.push(j); break; }
    }
    chunks.push({ start: s, end: e, nb: nb.slice(0, 24) });
  }
  return chunks;
}

/** Assemble a template from a node list, organs and look genes. */
export function buildTemplate(key: string, nodes: TNode[], organs: Organ[], genes: LookGenes, swim: SwimMode, strokeHz: number): RenderTemplate {
  const capsules: Capsule[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i]!;
    if (nd.parent < 0 || (nd.r0 <= 0 && nd.r1 <= 0)) continue;
    if (nd.kind === CAP.EYE) capsules.push({ a: i, b: i, ra: nd.r1, rb: nd.r1, kind: CAP.EYE, s0: nd.s, s1: nd.s, alpha: 1 });
    else capsules.push({ a: nd.parent, b: i, ra: nd.r0, rb: nd.r1, kind: nd.kind, s0: nodes[nd.parent]!.s, s1: nd.s, alpha: nd.alpha });
  }
  // body capsules first, then fins, guts and eyes, so the chunk order follows the silhouette
  const order = [CAP.BODY, CAP.FIN, CAP.GUT, CAP.EYE];
  capsules.sort((p, q) => order.indexOf(p.kind) - order.indexOf(q.kind) || p.b - q.b);
  const P = restPositions(nodes);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const radii: number[] = [];
  for (const c of capsules) {
    for (const [ni, r] of [[c.a, c.ra], [c.b, c.rb]] as const) {
      x0 = Math.min(x0, P.x[ni]! - r); x1 = Math.max(x1, P.x[ni]! + r);
      y0 = Math.min(y0, P.y[ni]! - r); y1 = Math.max(y1, P.y[ni]! + r);
    }
    if (c.kind === CAP.BODY) radii.push(Math.max(c.ra, c.rb));
  }
  radii.sort((a, b) => a - b);
  const medianR = radii.length ? radii[radii.length >> 1]! : 0.05;
  const rMax = radii.length ? radii[radii.length - 1]! : 0.05;
  const centre: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const extent = Math.hypot(x1 - x0, y1 - y0) / 2;
  const look = lookFromGenes(genes);
  const kBlend = 0.6 * medianR * genes.softness;
  return {
    key, nodes, capsules,
    macro: simplify(capsules, nodes, MAX_MACRO, [CAP.BODY, CAP.FIN]),
    core: simplify(capsules, nodes, MAX_CORE, [CAP.BODY]),
    chunks: buildChunks(capsules, nodes, kBlend, rMax),
    organs, look, swim, radial: false, strokeHz, centre, extent, medianR, rMax,
  };
}

/** Small authoring helper for templates: chains of nodes with relative angles. */
export class SkeletonBuilder {
  readonly nodes: TNode[] = [];
  private chains = 0;
  constructor(rootR = 0.05) {
    this.nodes.push({ parent: -1, len: 0, angle: 0, r0: rootR, r1: rootR, kind: CAP.BODY, s: 0, chain: 0, amp: 0, lag: 0, pulse: 0, bendW: 0, alpha: 1 });
  }
  /**
   * A chain of `radii.length` capsules from `parent`. `angles[i]` are relative angles per link
   * (the first relative to the parent's absolute angle). Swing: amplitude grows from amp0 to
   * amp1 along the chain, lag grows by `wave` radians over the chain.
   */
  chain(parent: number, lens: number[], angles: number[], radii: number[], opt: Partial<{ kind: CapKind; r0: number; amp0: number; amp1: number; wave: number; lag0: number; pulse: number; bendW: number; alpha: number }> = {}): number[] {
    const chain = ++this.chains;
    const ids: number[] = [];
    const n = radii.length;
    let prevR = opt.r0 ?? this.nodes[parent]!.r1;
    let p = parent;
    for (let i = 0; i < n; i++) {
      const s = n === 1 ? 1 : i / (n - 1);
      this.nodes.push({
        parent: p, len: lens[Math.min(i, lens.length - 1)]!, angle: angles[Math.min(i, angles.length - 1)] ?? 0,
        r0: prevR, r1: radii[i]!, kind: opt.kind ?? CAP.BODY, s, chain,
        amp: (opt.amp0 ?? 0) + ((opt.amp1 ?? 0) - (opt.amp0 ?? 0)) * s, lag: (opt.lag0 ?? 0) + (opt.wave ?? 0) * s,
        pulse: opt.pulse ?? 0, bendW: opt.bendW ?? 0, alpha: opt.alpha ?? 1,
      });
      p = this.nodes.length - 1;
      ids.push(p);
      prevR = radii[i]!;
    }
    return ids;
  }
  /** Absolute rest angle of a node. */
  absAng(id: number): number {
    let a = 0;
    for (let i = id; i >= 0; i = this.nodes[i]!.parent) a += this.nodes[i]!.angle;
    return a;
  }
  /** Relative angle that points a child of `parent` in absolute direction `abs`. */
  rel(parent: number, abs: number): number { return abs - this.absAng(parent); }
  eye(parent: number, len: number, angle: number, r: number): number {
    this.nodes.push({ parent, len, angle, r0: r, r1: r, kind: CAP.EYE, s: 0, chain: 0, amp: 0, lag: 0, pulse: 0, bendW: 0, alpha: 1 });
    return this.nodes.length - 1;
  }
  /** A point node (no capsule of its own kind matters), for organs. */
  point(parent: number, len: number, angle: number): number {
    this.nodes.push({ parent, len, angle, r0: 0, r1: 0, kind: CAP.GUT, s: 0, chain: 0, amp: 0, lag: 0, pulse: 0, bendW: 0, alpha: 0 });
    return this.nodes.length - 1;
  }
}

/**
 * Convert a developed Phenotype (CONTRACT 7) into a template. Each part becomes an attach node
 * on its parent and an end node; segments and limbs are body capsules, fins are membranes,
 * eyes are discs, photophores (parts or absorbed flags) are light organs, and GUT flags put a
 * gut capsule inside their segment.
 */
export function templateFromPhenotype(key: string, ph: Phenotype, genes: LookGenes, swim: SwimMode = 'undulate'): RenderTemplate {
  const L = Math.max(1e-6, ph.lengthM);
  const b = new SkeletonBuilder(Math.max(1e-3, ph.radius[0]! / L));
  const absAng = new Float64Array(ph.nParts);
  const endNode = new Int32Array(ph.nParts).fill(-1);
  const startNode = new Int32Array(ph.nParts).fill(-1);
  const organs: Organ[] = [];
  for (let i = 0; i < ph.nParts; i++) {
    const p = ph.parent[i]!;
    const len = ph.length[i]! / L, r = Math.max(1e-4, ph.radius[i]! / L);
    const rTip = Math.max(1e-4, r * (1 - Math.min(0.95, Math.max(0, ph.taper[i]!))));
    absAng[i] = (p >= 0 ? absAng[p]! : 0) + ph.restAngle[i]!;
    const kind = ph.kind[i]!;
    // the attach point: from the parent's end node back along the parent by (0.5 - attachU) of its length
    let anchor = 0;
    if (p >= 0) {
      const back = (0.5 - ph.attachU[i]!) * (ph.length[p]! / L);
      anchor = back > 1e-6 ? b.point(endNode[p]!, back, Math.PI) : endNode[p]!;
    }
    const rel = p >= 0 ? ph.restAngle[i]! - (anchor !== endNode[p]! ? Math.PI : 0) : 0;
    if (kind === KIND.EYE) {
      endNode[i] = b.eye(anchor, 0, rel, Math.max(r, 0.02));
      startNode[i] = anchor;
      continue;
    }
    if (kind === KIND.PHOTOPHORE) {
      endNode[i] = b.point(anchor, len * 0.5, rel);
      organs.push({ node: endNode[i]!, radius: Math.max(r, 0.03) * 2.5, hueShift: (ph.hue[i]! - 0.5) * 60, periodS: 3, phase: (i * 0.618) % 1, duty: 0.5, gain: 0.5 + ph.glow[i]!, depth: 0.5 });
      continue;
    }
    const capKind = kind === KIND.FIN ? CAP.FIN : CAP.BODY;
    const ids = b.chain(anchor, [len], [rel], [kind === KIND.FIN ? Math.max(rTip, ph.span[i]! / L * 0.5) : rTip], {
      kind: capKind, r0: kind === KIND.FIN ? Math.max(r, ph.span[i]! / L * 0.25) : r,
      amp0: ph.cpgAmp[i]! * 0.3, amp1: ph.cpgAmp[i]! * 0.3, lag0: ph.cpgPhase[i]!, bendW: kind === KIND.SEGMENT ? 1 : 0,
      alpha: kind === KIND.FIN ? 0.3 : 1,
    });
    startNode[i] = anchor;
    endNode[i] = ids[0]!;
    if ((ph.organs[i]! & ORGAN.GUT) && kind === KIND.SEGMENT) {
      b.chain(anchor, [len * 0.8], [rel], [r * 0.45], { kind: CAP.GUT, r0: r * 0.45 });
    }
    if ((ph.organs[i]! & ORGAN.PHOTOPHORE) && kind !== KIND.PHOTOPHORE) {
      organs.push({ node: endNode[i]!, radius: r * 1.5, hueShift: 0, periodS: 3, phase: (i * 0.618) % 1, duty: 0.5, gain: 0.4 + ph.glow[i]!, depth: 0.4 });
    }
    if ((ph.organs[i]! & ORGAN.EYE) && kind !== KIND.EYE) b.eye(endNode[i]!, r * 0.4, -Math.PI / 2, Math.max(0.015, r * 0.35));
  }
  void startNode;
  return buildTemplate(key, b.nodes, organs, genes, swim, 1.5);
}
