/**
 * Creature preview for the share page. Three sources, best first:
 *   1. the UI module's design preview, if it exports one (proposed in docs/contract-requests/site.md);
 *   2. `genome.develop()` (CONTRACT 7), drawn here from the Phenotype;
 *   3. a schematic unfolding of the genome's module graph, done here, while develop() is a stub.
 * Every source yields the same `Body` (parts in a 2D side view), so one painter draws them all.
 * This is view code only: it never feeds the simulation, so plain Math is fine here.
 */
import {
  decodeQ, KIND, LINK_FLAG, LINK_RECORD, MAX_PARTS, MODULE_FLAG, MODULE_RECORD, SEGMENT_SUBTYPE, SYMMETRY, T, TRAITS,
  type FieldDef, type Genome, type LinkGene, type ModuleGene, type Phenotype,
} from '../../src/core/index.js';

export interface Part {
  kind: number;
  subtype: number;
  /** Base point and direction, metres and radians, y up. */
  x: number; y: number; angle: number;
  length: number; radius: number; taper: number;
  /** 0..1 hue for the part, and its surface glow 0..1. */
  hue: number; glow: number;
}
export interface Look { bodyHue: number; bodySat: number; bodyLum: number; translucency: number; glowHue: number; glowBase: number }
export interface Body { parts: Part[]; look: Look; source: 'ui' | 'develop' | 'schematic'; adultLengthM: number }

const trait = (g: Genome, name: string): number => {
  const i = (T as Record<string, number | undefined>)[name];
  const spec = i === undefined ? undefined : TRAITS[i];
  if (i === undefined || !spec) return 0;
  return decodeQ(g.traits[i] ?? 0, spec);
};

export function lookOf(g: Genome): Look {
  return {
    bodyHue: trait(g, 'BODY_HUE'), bodySat: trait(g, 'BODY_SAT'), bodyLum: trait(g, 'BODY_LUM'),
    translucency: trait(g, 'TRANSLUCENCY'), glowHue: trait(g, 'GLOW_HUE'), glowBase: trait(g, 'GLOW_BASE'),
  };
}

function field(def: { fields: readonly FieldDef[] }, name: string): FieldDef {
  const f = def.fields.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name}`);
  return f;
}
const MOD = {
  length: field(MODULE_RECORD, 'length'), width: field(MODULE_RECORD, 'width'), taper: field(MODULE_RECORD, 'taper'),
  glow: field(MODULE_RECORD, 'glow'),
};
const LNK = { childScale: field(LINK_RECORD, 'childScale'), repeatScale: field(LINK_RECORD, 'repeatScale') };
const dq = (q: number, f: FieldDef): number => {
  const qMax = f.type === 'u16' ? 65535 : 255;
  return f.range ? decodeQ(q, f.range, qMax) : q / qMax;
};
const DEG = Math.PI / 180;
/** Organs sit on their parent's surface rather than sticking out as limbs. */
const SURFACE_KINDS = new Set<number>([KIND.EYE, KIND.PHOTOPHORE, KIND.MOUTH, KIND.CHEMO, KIND.CILIA, KIND.GLAND, KIND.BLADDER]);

/**
 * Schematic unfolding (a stand-in for develop() until src/genome lands): breadth-first from
 * the root module, following enabled links with their attach position, angle, repeats,
 * mirror or radial symmetry and child scale. The root is the head; its base is the snout and
 * the body runs backwards from it. Capped at MAX_PARTS like the real development.
 */
export function schematicBody(g: Genome): Body {
  const look = lookOf(g);
  const adultLengthM = trait(g, 'ADULT_LENGTH') || 0.02;
  const mods = new Map<number, ModuleGene>();
  for (const m of g.modules) if (m.flags & MODULE_FLAG.ENABLED) mods.set(m.innov, m);
  const root = mods.get(g.rootModuleInnov) ?? g.modules.find((m) => m.flags & MODULE_FLAG.ROOT) ?? g.modules[0];
  const parts: Part[] = [];
  if (!root) return { parts, look, source: 'schematic', adultLengthM };
  const linksFrom = new Map<number, LinkGene[]>();
  for (const l of g.links) {
    if (!(l.flags & LINK_FLAG.ENABLED) || !mods.has(l.toInnov)) continue;
    const list = linksFrom.get(l.fromInnov) ?? [];
    list.push(l);
    linksFrom.set(l.fromInnov, list);
  }
  for (const list of linksFrom.values()) list.sort((a, b) => a.innov - b.innov);

  const hueOf = (m: ModuleGene): number => (((look.bodyHue + m.hueOffset / 256) % 1) + 1) % 1;
  const make = (m: ModuleGene, x: number, y: number, angle: number, refLen: number, scale: number, parent: Part | null): Part => {
    const length = Math.max(1e-5, dq(m.length, MOD.length) * refLen * scale);
    const aspect = dq(m.width, MOD.width);
    const width = SURFACE_KINDS.has(m.kind) ? Math.min(length, (parent?.radius ?? length) * 0.9) : length * aspect;
    return {
      kind: m.kind, subtype: m.subtype, x, y, angle, length, radius: Math.max(width / 2, 1e-5),
      taper: m.kind === KIND.SEGMENT && m.subtype === SEGMENT_SUBTYPE.HEAD ? Math.max(0.6, dq(m.taper, MOD.taper)) : dq(m.taper, MOD.taper),
      hue: hueOf(m), glow: Math.max(look.glowBase * 0.4, dq(m.glow, MOD.glow)),
    };
  };

  interface Item { part: Part; mod: ModuleGene; depth: number; terminal: boolean; via: number }
  const rootPart = make(root, 0, 0, Math.PI, adultLengthM, 1, null);
  parts.push(rootPart);
  const queue: Item[] = [{ part: rootPart, mod: root, depth: 0, terminal: true, via: -1 }];
  const recursion = new Map<string, number>();
  for (let qi = 0; qi < queue.length && parts.length < MAX_PARTS; qi++) {
    const it = queue[qi]!;
    for (const l of linksFrom.get(it.mod.innov) ?? []) {
      if ((l.flags & LINK_FLAG.TERMINAL_ONLY) && !it.terminal) continue;
      const child = mods.get(l.toInnov)!;
      if (l.toInnov === l.fromInnov) {
        const key = `${l.innov}`;
        const used = recursion.get(key) ?? 0;
        if (used >= Math.min(7, child.recursionLimit)) continue;
        recursion.set(key, used + 1);
      }
      const p = it.part;
      const u = l.attachPos / 255;
      const bx = p.x + Math.cos(p.angle) * p.length * u;
      const by = p.y + Math.sin(p.angle) * p.length * u;
      const ang = l.attachAngle * (180 / 128) * DEG;
      const copies = l.symmetry === SYMMETRY.MIRROR ? [ang, -ang] : l.symmetry === SYMMETRY.RADIAL ? [0, 1, 2, 3, 4].map((k) => ang + (k * 2 * Math.PI) / 5) : [ang];
      const childScale = dq(l.childScale, LNK.childScale);
      const repeatScale = dq(l.repeatScale, LNK.repeatScale);
      const repeat = Math.max(1, Math.min(16, l.repeat));
      copies.forEach((a, ci) => {
        if (ci > 0 && Math.abs(Math.sin(a - copies[0]!)) < 1e-6 && Math.abs(Math.cos(a - copies[0]!) - 1) < 1e-6) return;
        let ox = bx, oy = by, dir = p.angle + a, scale = childScale;
        if (SURFACE_KINDS.has(child.kind)) {
          // on the surface: offset towards the side the angle points at
          const side = Math.sin(a) >= 0 ? 1 : -1;
          const lift = p.radius * (0.25 + 0.6 * Math.min(1, Math.abs(Math.sin(a))));
          ox = bx + Math.cos(p.angle + side * Math.PI / 2) * lift;
          oy = by + Math.sin(p.angle + side * Math.PI / 2) * lift;
          dir = p.angle + a;
        }
        let prev: Part | null = null;
        for (let r = 0; r < repeat && parts.length < MAX_PARTS; r++) {
          const part = make(child, ox, oy, dir, p.length, scale, p);
          parts.push(part);
          prev = part;
          if (!SURFACE_KINDS.has(child.kind)) {
            ox += Math.cos(dir) * part.length * 0.92;
            oy += Math.sin(dir) * part.length * 0.92;
          } else {
            ox += Math.cos(p.angle) * part.radius * 2.4;
            oy += Math.sin(p.angle) * part.radius * 2.4;
          }
          scale *= repeatScale;
          queue.push({ part, mod: child, depth: it.depth + 1, terminal: r === repeat - 1, via: l.innov });
        }
        void prev;
      });
    }
  }
  return { parts, look, source: 'schematic', adultLengthM };
}

/**
 * A developed Phenotype (CONTRACT 7) as a side-view Body. The Phenotype is parent-first BFS
 * with `attachU` along the parent and `restAngle` relative to it, `length` and `radius` in
 * metres; poses come from chaining those from the root.
 */
export function phenotypeBody(ph: Phenotype, g: Genome): Body {
  const look = lookOf(g);
  const parts: Part[] = [];
  for (let i = 0; i < ph.nParts; i++) {
    const pi = ph.parent[i] ?? -1;
    const parent = pi >= 0 && pi < i ? parts[pi]! : null;
    const u = ph.attachU[i] ?? 0;
    const x = parent ? parent.x + Math.cos(parent.angle) * parent.length * u : 0;
    const y = parent ? parent.y + Math.sin(parent.angle) * parent.length * u : 0;
    const angle = (parent ? parent.angle : Math.PI) + (ph.restAngle[i] ?? 0);
    parts.push({
      kind: ph.kind[i] ?? 0, subtype: ph.subtype[i] ?? 0, x, y, angle,
      length: Math.max(1e-5, ph.length[i] ?? 0), radius: Math.max(1e-5, ph.radius[i] ?? 0), taper: ph.taper[i] ?? 1,
      hue: ph.hue[i] ?? look.bodyHue, glow: ph.glow[i] ?? look.glowBase,
    });
  }
  return { parts, look, source: 'develop', adultLengthM: ph.adultLengthM };
}

/** Bounding box of a body, in metres. */
export function bounds(b: Body): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of b.parts) {
    const ex = p.x + Math.cos(p.angle) * p.length, ey = p.y + Math.sin(p.angle) * p.length;
    x0 = Math.min(x0, p.x - p.radius, ex - p.radius); x1 = Math.max(x1, p.x + p.radius, ex + p.radius);
    y0 = Math.min(y0, p.y - p.radius, ey - p.radius); y1 = Math.max(y1, p.y + p.radius, ey + p.radius);
  }
  if (!Number.isFinite(x0)) return { x0: -1, y0: -1, x1: 1, y1: 1 };
  return { x0, y0, x1, y1 };
}

const hsl = (h: number, s: number, l: number, a = 1): string =>
  `hsla(${Math.round(((h % 1) + 1) % 1 * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%, ${a.toFixed(3)})`;

/** Paint a still, glowing side view into a 2D canvas context. No animation, so nothing flashes. */
export function paintBody(ctx: CanvasRenderingContext2D, b: Body, w: number, h: number): void {
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  const bb = bounds(b);
  const bw = bb.x1 - bb.x0, bh = bb.y1 - bb.y0;
  const s = Math.min((w * 0.78) / Math.max(bw, 1e-6), (h * 0.7) / Math.max(bh, 1e-6));
  const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
  const X = (x: number): number => w / 2 + (x - cx) * s;
  const Y = (y: number): number => h / 2 - (y - cy) * s;
  const { look } = b;
  const alpha = 0.35 + 0.55 * (1 - look.translucency);
  const glowCol = hsl(look.glowHue, 0.9, 0.65);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const capsule = (p: Part, fill: string, stroke: string, lw: number): void => {
    const x0 = X(p.x), y0 = Y(p.y);
    const x1 = X(p.x + Math.cos(p.angle) * p.length), y1 = Y(p.y + Math.sin(p.angle) * p.length);
    const r0 = Math.max(1.2, p.radius * s), r1 = Math.max(0.8, r0 * Math.max(0.15, p.taper));
    const a = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath();
    ctx.arc(x0, y0, r0, a + Math.PI / 2, a - Math.PI / 2, false);
    ctx.arc(x1, y1, r1, a - Math.PI / 2, a + Math.PI / 2, false);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (lw > 0) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
  };
  const leaf = (p: Part, fill: string, stroke: string): void => {
    const x0 = X(p.x), y0 = Y(p.y);
    const len = p.length * s, wid = Math.max(3, p.radius * s * 2.2, len * 0.32);
    const a = -p.angle;
    ctx.save();
    ctx.translate(x0, y0);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    if (p.subtype === 2) { // fluke: a forked tail
      ctx.quadraticCurveTo(len * 0.5, -wid * 0.2, len, -wid);
      ctx.quadraticCurveTo(len * 0.75, 0, len, wid);
      ctx.quadraticCurveTo(len * 0.5, wid * 0.2, 0, 0);
    } else {
      ctx.quadraticCurveTo(len * 0.45, -wid, len, 0);
      ctx.quadraticCurveTo(len * 0.45, wid * 0.35, 0, 0);
    }
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // fin rays
    ctx.globalAlpha = 0.35;
    for (let k = 1; k < 5; k++) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(len * (0.55 + k * 0.1), (p.subtype === 2 ? (k - 2.5) * wid * 0.45 : -wid * (0.15 + k * 0.12)));
      ctx.stroke();
    }
    ctx.restore();
  };

  // 1. soft halo behind the whole body
  const R = Math.max(bw, bh) * s * 0.75;
  const halo = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, R);
  halo.addColorStop(0, hsl(look.glowHue, 0.8, 0.5, 0.18 + 0.2 * look.glowBase));
  halo.addColorStop(1, hsl(look.glowHue, 0.8, 0.5, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, w, h);

  // 2. limbs and spikes behind the trunk
  for (const p of b.parts) {
    const body = hsl(p.hue, 0.35 + 0.5 * look.bodySat, 0.35 + 0.4 * look.bodyLum, alpha * 0.7);
    const edge = hsl(p.hue, 0.8, 0.75, 0.85);
    if (p.kind === KIND.LIMB || p.kind === KIND.SPIKE || p.kind === KIND.JET) {
      ctx.save();
      ctx.shadowColor = glowCol; ctx.shadowBlur = 6 + 10 * p.glow;
      capsule({ ...p, radius: p.radius * (p.kind === KIND.SPIKE ? 1 : 0.6), taper: p.kind === KIND.SPIKE ? 0.05 : Math.min(p.taper, 0.5) }, body, edge, 1);
      ctx.restore();
    }
  }
  // 3. segments: one glowing rim around the union (thick strokes first, then fills on top,
  //    so the joints between segments read as one smooth body)
  const segs = b.parts.filter((p) => p.kind === KIND.SEGMENT);
  ctx.save();
  ctx.shadowColor = glowCol;
  ctx.shadowBlur = 14 + 26 * look.glowBase;
  for (const p of segs) capsule(p, 'rgba(0,0,0,0)', hsl(p.hue, 0.9, 0.78, 0.95), 3);
  ctx.restore();
  for (const p of [...segs].reverse()) { // tail first, so the head sits on top
    const x0 = X(p.x), y0 = Y(p.y);
    const grad = ctx.createLinearGradient(x0, y0 - p.radius * s, x0, y0 + p.radius * s);
    grad.addColorStop(0, hsl(p.hue, 0.45 + 0.4 * look.bodySat, 0.5 + 0.3 * look.bodyLum, 1));
    grad.addColorStop(0.55, hsl(p.hue, 0.45 + 0.4 * look.bodySat, 0.32 + 0.25 * look.bodyLum, 1));
    grad.addColorStop(1, hsl(p.hue, 0.45 + 0.4 * look.bodySat, 0.18 + 0.15 * look.bodyLum, 1));
    capsule(p, grad as unknown as string, '', 0);
  }
  // faint internal structure: a gut line and segment boundaries, like a glass body
  ctx.save();
  ctx.globalAlpha = 0.18 + 0.3 * look.translucency;
  ctx.strokeStyle = hsl(look.bodyHue, 0.8, 0.85, 1);
  ctx.lineWidth = 1;
  for (const p of segs.slice(1)) {
    const x0 = X(p.x), y0 = Y(p.y), r = p.radius * s * 0.85, a = -p.angle + Math.PI / 2;
    ctx.beginPath(); ctx.moveTo(x0 + Math.cos(a) * r, y0 + Math.sin(a) * r); ctx.lineTo(x0 - Math.cos(a) * r, y0 - Math.sin(a) * r); ctx.stroke();
  }
  ctx.restore();
  // fins over the body, translucent like glass
  for (const p of b.parts) if (p.kind === KIND.FIN) leaf(p, hsl(p.hue, 0.7, 0.62, 0.32), hsl(p.hue, 0.85, 0.8, 0.8));
  // 4. surface organs
  for (const p of b.parts) {
    const x0 = X(p.x), y0 = Y(p.y);
    const r = Math.max(2, p.radius * s);
    if (p.kind === KIND.EYE) {
      ctx.save();
      ctx.shadowColor = 'rgba(200,245,255,0.9)'; ctx.shadowBlur = 8;
      ctx.fillStyle = 'rgba(225,250,255,0.95)';
      ctx.beginPath(); ctx.arc(x0, y0, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#02101a';
      ctx.beginPath(); ctx.arc(x0 + r * 0.15, y0, r * 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath(); ctx.arc(x0 + r * 0.35, y0 - r * 0.25, r * 0.18, 0, Math.PI * 2); ctx.fill();
    } else if (p.kind === KIND.PHOTOPHORE) {
      const rr = p.subtype === 2 ? Math.max(r, 5) * 1.6 : r;
      const g = ctx.createRadialGradient(x0, y0, 0, x0, y0, rr * 3.2);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.25, hsl(look.glowHue, 1, 0.7, 0.9));
      g.addColorStop(1, hsl(look.glowHue, 1, 0.6, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x0, y0, rr * 3.2, 0, Math.PI * 2); ctx.fill();
    } else if (p.kind === KIND.MOUTH) {
      ctx.strokeStyle = hsl(p.hue, 0.6, 0.85, 0.9);
      ctx.lineWidth = Math.max(1.5, r * 0.3);
      ctx.beginPath(); ctx.arc(x0, y0, r, -Math.PI * 0.35, Math.PI * 0.35); ctx.stroke();
    } else if (p.kind === KIND.CILIA) {
      ctx.strokeStyle = hsl(p.hue, 0.7, 0.8, 0.6);
      ctx.lineWidth = 1;
      for (let k = -3; k <= 3; k++) {
        ctx.beginPath(); ctx.moveTo(x0 + k * r * 0.5, y0); ctx.lineTo(x0 + k * r * 0.5, y0 + r * 1.2); ctx.stroke();
      }
    } else if (SURFACE_KINDS.has(p.kind)) {
      ctx.fillStyle = hsl(p.hue, 0.6, 0.7, 0.8);
      ctx.beginPath(); ctx.arc(x0, y0, r * 0.7, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

/** A short plain-text description of the body, for screen readers and the stats list. */
export function describeBody(b: Body): string {
  const count = (k: number): number => b.parts.filter((p) => p.kind === k).length;
  const segs = count(KIND.SEGMENT), fins = count(KIND.FIN), eyes = count(KIND.EYE), lights = count(KIND.PHOTOPHORE);
  const limbs = count(KIND.LIMB), spikes = count(KIND.SPIKE);
  const bits: string[] = [`${segs} body segment${segs === 1 ? '' : 's'}`];
  if (fins) bits.push(`${fins} fin${fins === 1 ? '' : 's'}`);
  if (limbs) bits.push(`${limbs} limb${limbs === 1 ? '' : 's'} or tentacle${limbs === 1 ? '' : 's'}`);
  if (spikes) bits.push(`${spikes} spike${spikes === 1 ? '' : 's'}`);
  if (eyes) bits.push(`${eyes} eye${eyes === 1 ? '' : 's'}`);
  if (lights) bits.push(`${lights} light organ${lights === 1 ? '' : 's'}`);
  if (count(KIND.MOUTH)) bits.push('a mouth');
  const last = bits.pop()!;
  return bits.length ? `${bits.join(', ')} and ${last}` : last;
}
