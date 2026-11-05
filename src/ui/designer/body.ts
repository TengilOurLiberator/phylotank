/**
 * Grown bodies for drawing: the designer preview, growth strip, inspector body tab and library
 * thumbnails. `genome.develop()` is used when it is implemented; until then a local sketch
 * unfolds the body graph (links, repeats, mirror and radial symmetry, recursion) well enough to
 * draw and to point at rules. The sketch is view-only and never feeds the sim.
 */
import {
  decodeQ, GENOME_FLAG_LEVIATHAN, KIND, LINK_FLAG, LINK_RECORD, MAX_PARTS, MODULE_FLAG, MODULE_RECORD, SYMMETRY, T, TRAITS,
  type Genome, type ModuleGene, type Phenotype,
} from '../../core/index.js';
import { genome as genomeModule } from '../../genome/index.js';

export interface DrawPart {
  kind: number; subtype: number;
  /** Module (rule) innovation that grew this part, and the link that placed it (0 for the root). */
  rule: number; link: number; copy: number;
  parent: number;
  x0: number; y0: number; x1: number; y1: number; // body frame, metres; x forward (snout at +x)
  r0: number; r1: number;                         // radius at base and tip, m
  hue: number; glow: number; paired: boolean; dv: number;
}
export interface GrownBody { parts: DrawPart[]; lengthM: number; adultLengthM: number; massKg: number; source: 'develop' | 'sketch' }

const field = (name: string) => MODULE_RECORD.fields.find((f) => f.name === name)!;
const lfield = (name: string) => LINK_RECORD.fields.find((f) => f.name === name)!;
const dq16 = (m: ModuleGene, name: 'length' | 'width') => decodeQ(m[name], field(name).range!, 65535);
const dq8 = (m: ModuleGene, name: keyof ModuleGene) => decodeQ(m[name] as number, field(name as string).range!, 255);

export function adultLength(g: Genome, lCeilingM: number): number {
  const L = decodeQ(g.traits[T.ADULT_LENGTH!]!, TRAITS[T.ADULT_LENGTH!]!);
  return (g.flags & GENOME_FLAG_LEVIATHAN) !== 0 ? L : Math.min(L, lCeilingM);
}

/** Body length at a maturity 0..1 (newborn at BIRTH_FRACTION of the adult). */
export function lengthAt(g: Genome, maturity: number, lCeilingM: number): number {
  const La = adultLength(g, lCeilingM);
  const bf = decodeQ(g.traits[T.BIRTH_FRACTION!]!, TRAITS[T.BIRTH_FRACTION!]!);
  const m = Math.max(0, Math.min(1, maturity));
  return La * (bf + (1 - bf) * (1 - (1 - m) ** 1.6));
}

export function growBody(g: Genome, maturity: number, lCeilingM: number): GrownBody {
  try {
    const ph = genomeModule.develop(g, maturity, { depth01: 0.3, tempC: 14 }, { maxParts: MAX_PARTS, lCeilingM, editorPaths: true });
    return fromPhenotype(ph);
  } catch {
    return sketch(g, maturity, lCeilingM);
  }
}

function fromPhenotype(ph: Phenotype): GrownBody {
  const parts: DrawPart[] = [];
  const ang: number[] = [];
  for (let i = 0; i < ph.nParts; i++) {
    const p = ph.parent[i]!;
    const len = ph.length[i]!, r = ph.radius[i]!;
    let x0 = 0, y0 = 0, a = Math.PI;
    if (p >= 0) {
      const pp = parts[p]!;
      const u = ph.attachU[i]! + 0.5;
      x0 = pp.x0 + (pp.x1 - pp.x0) * u; y0 = pp.y0 + (pp.y1 - pp.y0) * u;
      a = ang[p]! + ph.restAngle[i]!;
    } else { x0 = len / 2; }
    ang.push(a);
    parts.push({
      kind: ph.kind[i]!, subtype: ph.subtype[i]!, rule: ph.moduleInnov[i]!, link: 0, copy: 0, parent: p,
      x0, y0, x1: x0 + Math.cos(a) * len, y1: y0 + Math.sin(a) * len, r0: r, r1: r * ph.taper[i]!,
      hue: ph.hue[i]!, glow: ph.glow[i]!, paired: (ph.organs[i]! & (1 << 12)) !== 0, dv: ph.dv[i]!,
    });
  }
  return { parts, lengthM: ph.lengthM, adultLengthM: ph.adultLengthM, massKg: ph.massKg, source: 'develop' };
}

/** Local body-graph unfolding for drawing (BFS from the root, at most MAX_PARTS parts). */
export function sketch(g: Genome, maturity: number, lCeilingM: number): GrownBody {
  const L = lengthAt(g, maturity, lCeilingM);
  const byInnov = new Map<number, ModuleGene>();
  for (const m of g.modules) if (m.flags & MODULE_FLAG.ENABLED) byInnov.set(m.innov, m);
  const root = byInnov.get(g.rootModuleInnov) ?? g.modules[0];
  const bodyHue = decodeQ(g.traits[T.BODY_HUE!]!, TRAITS[T.BODY_HUE!]!);
  const parts: DrawPart[] = [];
  if (!root) return { parts, lengthM: L, adultLengthM: adultLength(g, lCeilingM), massKg: 0, source: 'sketch' };
  const links = g.links.filter((l) => l.flags & LINK_FLAG.ENABLED);
  // late-appearing parts: anything that is not a segment grows in from maturity 0.15
  const m01 = Math.max(0, Math.min(1, maturity));
  interface Q { mod: ModuleGene; parent: number; x0: number; y0: number; ang: number; refLen: number; depth: number; link: number; copy: number; dv: number; terminal: boolean; mirror: number }
  const queue: Q[] = [{ mod: root, parent: -1, x0: 0, y0: 0, ang: Math.PI, refLen: 1, depth: 0, link: 0, copy: 0, dv: 0, terminal: true, mirror: 1 }];
  const pushPart = (q: Q): number => {
    const m = q.mod;
    let len = dq16(m, 'length') * q.refLen;
    const isSeg = m.kind === KIND.SEGMENT;
    if (!isSeg) len *= Math.min(1, 0.35 + m01);
    const w = dq16(m, 'width') * len;
    const taper = dq8(m, 'taper');
    const x1 = q.x0 + Math.cos(q.ang) * len, y1 = q.y0 + Math.sin(q.ang) * len;
    parts.push({
      kind: m.kind, subtype: m.subtype, rule: m.innov, link: q.link, copy: q.copy, parent: q.parent,
      x0: q.x0, y0: q.y0, x1, y1, r0: w / 2, r1: (w / 2) * Math.max(0.15, taper), hue: (bodyHue + m.hueOffset / 255 + 1) % 1,
      glow: dq8(m, 'glow'), paired: (m.flags & MODULE_FLAG.PAIRED) !== 0, dv: q.dv,
    });
    return parts.length - 1;
  };
  const recursion = new Map<string, number>();
  while (queue.length > 0 && parts.length < MAX_PARTS) {
    const q = queue.shift()!;
    const idx = pushPart(q);
    const me = parts[idx]!;
    const myLen = Math.hypot(me.x1 - me.x0, me.y1 - me.y0) / Math.max(1e-9, q.mod.kind === KIND.SEGMENT ? 1 : Math.min(1, 0.35 + m01));
    for (const l of links) {
      if (l.fromInnov !== q.mod.innov) continue;
      const child = byInnov.get(l.toInnov);
      if (!child) continue;
      if (l.flags & LINK_FLAG.TERMINAL_ONLY && !q.terminal) continue;
      const key = `${l.innov}`;
      if (l.toInnov === l.fromInnov) {
        const n = recursion.get(key) ?? 0;
        if (n >= child.recursionLimit) continue;
        recursion.set(key, n + 1);
      }
      const pos = l.attachPos / 255;
      const scale = decodeQ(l.childScale, lfield('childScale').range!, 255);
      const rscale = decodeQ(l.repeatScale, lfield('repeatScale').range!, 255);
      const baseAng = (l.attachAngle * 1.41 * Math.PI) / 180;
      const sides: { a: number; dv: number }[] = [];
      if (l.symmetry === SYMMETRY.MIRROR) sides.push({ a: baseAng, dv: 1 }, { a: -baseAng, dv: -1 });
      else if (l.symmetry === SYMMETRY.RADIAL) {
        const n = 6;
        for (let k = 0; k < n; k++) sides.push({ a: baseAng + (k - (n - 1) / 2) * (Math.PI / (n + 1)) * 0.9, dv: k < n / 2 ? -1 : 1 });
      } else sides.push({ a: baseAng, dv: 0 });
      for (const side of sides) {
        let px = me.x0 + (me.x1 - me.x0) * pos, py = me.y0 + (me.y1 - me.y0) * pos;
        let ref = myLen * scale;
        const reps = Math.max(1, l.repeat);
        // a chain of repeats: each copy attaches to the tip of the previous one
        for (let r = 0; r < reps; r++) {
          const ang = q.ang + side.a * q.mirror;
          const childLen = dq16(child, 'length') * ref;
          queue.push({ mod: child, parent: idx, x0: px, y0: py, ang, refLen: ref, depth: q.depth + 1, link: l.innov, copy: r, dv: side.dv, terminal: r === reps - 1, mirror: side.dv < 0 ? -q.mirror : q.mirror });
          if (child.kind !== KIND.SEGMENT || reps === 1) {
            if (reps > 1) { px += Math.cos(q.ang) * myLen * 0.12; py += Math.sin(q.ang) * myLen * 0.12; }
            continue;
          }
          px += Math.cos(ang) * childLen; py += Math.sin(ang) * childLen;
          ref *= rscale;
        }
      }
    }
  }
  // repeated segment chains attach in series, so only the last copy is terminal; fix parents
  // so copies chain visually (copy r's parent is copy r-1)
  // scale the axial chain to the body length
  let xmin = Infinity, xmax = -Infinity;
  for (const p of parts) { xmin = Math.min(xmin, p.x0, p.x1); xmax = Math.max(xmax, p.x0, p.x1); }
  const span = Math.max(1e-9, xmax - xmin);
  const k = L / span;
  let mass = 0;
  for (const p of parts) {
    p.x0 = (p.x0 - xmax) * k + L / 2; p.x1 = (p.x1 - xmax) * k + L / 2;
    p.y0 *= k; p.y1 *= k; p.r0 *= k; p.r1 *= k;
    const len = Math.hypot(p.x1 - p.x0, p.y1 - p.y0);
    const r = (p.r0 + p.r1) / 2;
    mass += 1060 * (Math.PI * r * r * len + (4 / 3) * Math.PI * r * r * r) * (p.kind === KIND.FIN ? 0.15 : 1);
  }
  return { parts, lengthM: L, adultLengthM: adultLength(g, lCeilingM), massKg: mass, source: 'sketch' };
}

/** Draw a grown body into a 2D context, fitted into the box. Returns the world-to-pixel scale. */
export function drawBody(
  ctx: CanvasRenderingContext2D, body: GrownBody, box: { x: number; y: number; w: number; h: number },
  opts: { highlightRule?: number; highlightCopy?: { link: number; copy: number }; glowBoost?: number; fixedScale?: number } = {},
): { scale: number; ox: number; oy: number } {
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const p of body.parts) {
    xmin = Math.min(xmin, p.x0 - p.r0, p.x1 - p.r1); xmax = Math.max(xmax, p.x0 + p.r0, p.x1 + p.r1);
    ymin = Math.min(ymin, p.y0 - p.r0, p.y1 - p.r1); ymax = Math.max(ymax, p.y0 + p.r0, p.y1 + p.r1);
  }
  if (!Number.isFinite(xmin)) return { scale: 1, ox: 0, oy: 0 };
  const scale = opts.fixedScale ?? 0.86 * Math.min(box.w / Math.max(1e-9, xmax - xmin), box.h / Math.max(1e-9, ymax - ymin));
  const ox = box.x + box.w / 2 - ((xmin + xmax) / 2) * scale;
  const oy = box.y + box.h / 2 - ((ymin + ymax) / 2) * scale;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // appendages under the body, segments, then sense organs and lights on top
  const layer = (k: number) => (k === KIND.SEGMENT ? 1 : k === KIND.EYE || k === KIND.PHOTOPHORE || k === KIND.MOUTH ? 2 : 0);
  const order = [...body.parts.keys()].sort((a, b) => (body.parts[a]!.dv < 0 ? -1 : 0) - (body.parts[b]!.dv < 0 ? -1 : 0) || layer(body.parts[a]!.kind) - layer(body.parts[b]!.kind) || a - b);
  for (const pass of [0, 1]) {
    for (const i of order) {
      const p = body.parts[i]!;
      const hl = opts.highlightRule !== undefined && p.rule === opts.highlightRule;
      const hc = opts.highlightCopy && p.link === opts.highlightCopy.link && p.copy === opts.highlightCopy.copy;
      const x0 = ox + p.x0 * scale, y0 = oy + p.y0 * scale, x1 = ox + p.x1 * scale, y1 = oy + p.y1 * scale;
      const hue = Math.round(p.hue * 360);
      const far = p.dv < 0 ? 0.55 : 1;
      const r0 = Math.max(0.8, p.r0 * scale), r1 = Math.max(0.6, p.r1 * scale);
      if (pass === 0) {
        const g = Math.min(1, (p.glow + (opts.glowBoost ?? 0)) * far);
        ctx.strokeStyle = `hsla(${hue},90%,62%,${(0.05 + 0.18 * g).toFixed(3)})`;
        ctx.lineWidth = Math.max(2, (r0 + r1) + 10 * g);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        continue;
      }
      const a = Math.atan2(y1 - y0, x1 - x0);
      ctx.beginPath();
      switch (p.kind) {
        case KIND.FIN: {
          // a fan: narrow root, broad trailing edge swept back
          const len = Math.hypot(x1 - x0, y1 - y0), wid = Math.max(2, (r0 + r1));
          const nx = -Math.sin(a), ny = Math.cos(a);
          ctx.moveTo(x0 + nx * wid * 0.25, y0 + ny * wid * 0.25);
          ctx.quadraticCurveTo(x0 + Math.cos(a) * len * 0.6 + nx * wid, y0 + Math.sin(a) * len * 0.6 + ny * wid, x1 + nx * wid * 0.5, y1 + ny * wid * 0.5);
          ctx.lineTo(x1 - nx * wid * 0.4, y1 - ny * wid * 0.4);
          ctx.quadraticCurveTo(x0 + Math.cos(a) * len * 0.5 - nx * wid * 0.3, y0 + Math.sin(a) * len * 0.5 - ny * wid * 0.3, x0 - nx * wid * 0.25, y0 - ny * wid * 0.25);
          ctx.closePath();
          ctx.fillStyle = `hsla(${hue},70%,55%,${(0.35 * far + 0.12).toFixed(3)})`;
          ctx.strokeStyle = `hsla(${hue},90%,72%,${(0.6 * far).toFixed(3)})`;
          break;
        }
        case KIND.EYE: {
          const r = Math.max(2, Math.min(r0 * 1.3, Math.hypot(x1 - x0, y1 - y0) * 0.7 + 1));
          ctx.arc(x1, y1, r, 0, Math.PI * 2);
          ctx.fillStyle = `hsla(${hue},25%,88%,${(0.9 * far).toFixed(3)})`; ctx.fill();
          ctx.beginPath(); ctx.arc(x1 + Math.cos(a) * r * 0.25, y1 + Math.sin(a) * r * 0.25, r * 0.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(5,10,14,.95)'; ctx.fill();
          if (hl || hc) { ctx.beginPath(); ctx.arc(x1, y1, r + 2, 0, Math.PI * 2); ctx.strokeStyle = hc ? '#ffd27a' : '#7fe8ff'; ctx.lineWidth = 2; ctx.stroke(); }
          continue;
        }
        case KIND.MOUTH: {
          const len = Math.hypot(x1 - x0, y1 - y0), wid = Math.max(2, r0);
          const nx = -Math.sin(a), ny = Math.cos(a);
          ctx.moveTo(x0 + nx * wid, y0 + ny * wid); ctx.lineTo(x0 + Math.cos(a) * len + nx * wid * 0.6, y0 + Math.sin(a) * len + ny * wid * 0.6);
          ctx.lineTo(x0 + Math.cos(a) * len * 0.55, y0 + Math.sin(a) * len * 0.55);
          ctx.lineTo(x0 + Math.cos(a) * len - nx * wid * 0.6, y0 + Math.sin(a) * len - ny * wid * 0.6); ctx.lineTo(x0 - nx * wid, y0 - ny * wid); ctx.closePath();
          ctx.fillStyle = `hsla(${hue},40%,30%,${(0.85 * far).toFixed(3)})`;
          ctx.strokeStyle = `hsla(${hue},70%,70%,${(0.7 * far).toFixed(3)})`;
          break;
        }
        case KIND.PHOTOPHORE: {
          ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
          ctx.strokeStyle = `hsla(${hue},60%,60%,${(0.6 * far).toFixed(3)})`; ctx.lineWidth = Math.max(1, r0 * 0.6); ctx.stroke();
          const g = ctx.createRadialGradient(x1, y1, 0, x1, y1, Math.max(4, r0 * 3));
          g.addColorStop(0, `hsla(${hue},100%,85%,${far})`); g.addColorStop(1, `hsla(${hue},100%,60%,0)`);
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x1, y1, Math.max(4, r0 * 3), 0, Math.PI * 2); ctx.fill();
          continue;
        }
        case KIND.LIMB: case KIND.CHEMO: case KIND.SPIKE: case KIND.CILIA: {
          taperedCapsule(ctx, x0, y0, x1, y1, Math.max(0.8, r0 * 0.8), Math.max(0.4, r1 * 0.5));
          ctx.fillStyle = `hsla(${hue},55%,${p.kind === KIND.SPIKE ? 70 : 50}%,${(0.6 * far + 0.2).toFixed(3)})`;
          ctx.strokeStyle = `hsla(${hue},80%,75%,${(0.5 * far).toFixed(3)})`;
          break;
        }
        default: {
          taperedCapsule(ctx, x0, y0, x1, y1, r0, r1);
          ctx.fillStyle = `hsla(${hue},55%,${24 + 20 * p.glow}%,${(0.55 * far + 0.35).toFixed(3)})`;
          ctx.strokeStyle = `hsla(${hue},85%,${62 + 15 * p.glow}%,${(0.75 * far).toFixed(3)})`;
        }
      }
      ctx.fill();
      ctx.lineWidth = hl || hc ? 2.2 : 1;
      if (hl || hc) ctx.strokeStyle = hc ? '#ffd27a' : '#7fe8ff';
      ctx.stroke();
    }
  }
  ctx.restore();
  return { scale, ox, oy };
}

function taperedCapsule(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, r0: number, r1: number): void {
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.arc(x0, y0, r0, a + Math.PI / 2, a - Math.PI / 2);
  ctx.arc(x1, y1, r1, a - Math.PI / 2, a + Math.PI / 2);
  ctx.closePath();
}

/** Hit-test a part (for the part editor): nearest part whose capsule contains the point. */
export function pickPart(body: GrownBody, map: { scale: number; ox: number; oy: number }, px: number, py: number): number {
  let best = -1, bestD = Infinity;
  body.parts.forEach((p, i) => {
    const x0 = map.ox + p.x0 * map.scale, y0 = map.oy + p.y0 * map.scale, x1 = map.ox + p.x1 * map.scale, y1 = map.oy + p.y1 * map.scale;
    const dx = x1 - x0, dy = y1 - y0;
    const tt = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / Math.max(1e-9, dx * dx + dy * dy)));
    const d = Math.hypot(px - (x0 + dx * tt), py - (y0 + dy * tt)) - Math.max(4, ((p.r0 + p.r1) / 2) * map.scale);
    if (d < bestD) { bestD = d; best = i; }
  });
  return bestD <= 6 ? best : -1;
}
