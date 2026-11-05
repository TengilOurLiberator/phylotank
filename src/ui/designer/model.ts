/**
 * Designer model (07 §1.1): one genome, two editors. The single source of truth is the canonical
 * genome bytes; gene sliders and the part editor both go through these pure functions, which
 * decode, change one thing and re-encode. Nothing is cached between the two modes, so they
 * cannot drift. Undo is whole-genome patches (genomes are small), 200 entries, coalesced drags.
 */
import {
  BRAIN_TRAITS, decodeGenome, decodeQ, encodeGenome, encodeQ, KIND, LINK_FLAG, LINK_RECORD, MODULE_FLAG, MODULE_RECORD,
  SYMMETRY, TRAITS, defaultRecord,
  type Genome, type LinkGene, type ModuleGene, type TraitSpec,
} from '../../core/index.js';

export type TraitTable = 'T' | 'B';
export const tableOf = (t: TraitTable): readonly (TraitSpec | undefined)[] => (t === 'T' ? TRAITS : BRAIN_TRAITS);

let lastBytes: Uint8Array | null = null;
let lastGenome: Genome | null = null;
/** Decode with a one-entry cache (the designer re-reads the same bytes many times per frame). */
export function view(bytes: Uint8Array): Genome {
  if (bytes !== lastBytes) { lastGenome = decodeGenome(bytes); lastBytes = bytes; }
  return lastGenome!;
}
function edit(bytes: Uint8Array, fn: (g: Genome) => void): Uint8Array {
  const g = decodeGenome(bytes);
  fn(g);
  g.flags |= 2; // EDITED
  return encodeGenome(g);
}

export function getTraitQ(bytes: Uint8Array, table: TraitTable, idx: number): number {
  const g = view(bytes);
  return (table === 'T' ? g.traits : g.brainTraits)[idx] ?? 0;
}
export function getTrait(bytes: Uint8Array, table: TraitTable, idx: number): number {
  const spec = tableOf(table)[idx];
  if (!spec) return getTraitQ(bytes, table, idx);
  return decodeQ(getTraitQ(bytes, table, idx), spec);
}
/** Set one locus (decoded value, clamped to the schema range). Returns new bytes. */
export function setTrait(bytes: Uint8Array, table: TraitTable, idx: number, v: number): Uint8Array {
  const spec = tableOf(table)[idx];
  const q = spec ? encodeQ(v, spec) : Math.max(0, Math.min(65535, Math.round(v)));
  return setTraitQ(bytes, table, idx, q);
}
export function setTraitQ(bytes: Uint8Array, table: TraitTable, idx: number, q: number): Uint8Array {
  return edit(bytes, (g) => { (table === 'T' ? g.traits : g.brainTraits)[idx] = Math.max(0, Math.min(65535, Math.round(q))); });
}
/** Slider position 0..1 (x space, where mutation also works) for a decoded value. */
export function toX(spec: TraitSpec, v: number): number { return encodeQ(v, spec) / 65535; }
export function fromX(spec: TraitSpec, x: number): number { return decodeQ(Math.round(Math.max(0, Math.min(1, x)) * 65535), spec); }

// ---------------- Part editor operations (growth rules, not instances) ----------------
export const ROOT_SAFE_KINDS = [KIND.SEGMENT, KIND.FIN, KIND.LIMB, KIND.MOUTH, KIND.EYE, KIND.CHEMO, KIND.SPIKE, KIND.PHOTOPHORE, KIND.CILIA, KIND.JET, KIND.BLADDER, KIND.GLAND] as const;

function nextInnov(g: Genome): number {
  let m = 4095;
  for (const x of g.modules) m = Math.max(m, x.innov);
  for (const x of g.links) m = Math.max(m, x.innov);
  return m + 1;
}

/** Sensible attachment defaults per kind: where on the parent and at what angle. */
const KIND_DEFAULTS: Record<number, { pos: number; angle: number; sym: number; length: number; width: number }> = {
  [KIND.SEGMENT]: { pos: 1, angle: 0, sym: SYMMETRY.NONE, length: 0.8, width: 0.4 },
  [KIND.FIN]: { pos: 0.6, angle: 70, sym: SYMMETRY.MIRROR, length: 0.5, width: 0.6 },
  [KIND.LIMB]: { pos: 0.5, angle: 100, sym: SYMMETRY.MIRROR, length: 1.2, width: 0.08 },
  [KIND.MOUTH]: { pos: 0, angle: 180, sym: SYMMETRY.NONE, length: 0.25, width: 0.9 },
  [KIND.EYE]: { pos: 0.15, angle: 35, sym: SYMMETRY.MIRROR, length: 0.15, width: 1 },
  [KIND.CHEMO]: { pos: 0, angle: 150, sym: SYMMETRY.MIRROR, length: 0.5, width: 0.06 },
  [KIND.SPIKE]: { pos: 0.5, angle: -90, sym: SYMMETRY.NONE, length: 0.35, width: 0.15 },
  [KIND.PHOTOPHORE]: { pos: 0.5, angle: -60, sym: SYMMETRY.NONE, length: 0.1, width: 1 },
  [KIND.CILIA]: { pos: 0.5, angle: 90, sym: SYMMETRY.MIRROR, length: 0.4, width: 0.3 },
  [KIND.JET]: { pos: 1, angle: 0, sym: SYMMETRY.NONE, length: 0.4, width: 0.8 },
  [KIND.BLADDER]: { pos: 0.5, angle: 0, sym: SYMMETRY.NONE, length: 0.4, width: 0.8 },
  [KIND.GLAND]: { pos: 0.5, angle: 90, sym: SYMMETRY.NONE, length: 0.2, width: 0.8 },
};
const mf = (name: string) => MODULE_RECORD.fields.find((f) => f.name === name)!;
const lf = (name: string) => LINK_RECORD.fields.find((f) => f.name === name)!;

/** Add a new rule: a module of `kind` attached to the rule `parentInnov`. */
export function addPart(bytes: Uint8Array, parentInnov: number, kind: number, subtype = 0): { bytes: Uint8Array; innov: number } {
  let innov = 0;
  const out = edit(bytes, (g) => {
    const d = KIND_DEFAULTS[kind] ?? KIND_DEFAULTS[KIND.FIN]!;
    const m = defaultRecord<ModuleGene>(MODULE_RECORD);
    innov = nextInnov(g);
    m.innov = innov; m.kind = kind; m.subtype = subtype; m.flags = MODULE_FLAG.ENABLED;
    m.length = encodeQ(d.length, mf('length').range!, 65535);
    m.width = encodeQ(d.width, mf('width').range!, 65535);
    m.span = 128; m.taper = 200; m.stiffness = 128; m.glow = 50; m.allometry = 128; m.jointRange = 60;
    m.muscleFraction = kind === KIND.SEGMENT || kind === KIND.FIN ? 96 : 0;
    m.gutFraction = kind === KIND.SEGMENT ? 64 : 0;
    m.cpgAmp = kind === KIND.FIN || kind === KIND.SEGMENT ? 128 : 0;
    m.p1 = m.p2 = m.p3 = m.p4 = m.p5 = 128;
    g.modules.push(m);
    const l = defaultRecord<LinkGene>(LINK_RECORD);
    l.innov = innov + 1; l.fromInnov = parentInnov; l.toInnov = innov;
    l.attachPos = Math.round(d.pos * 255); l.attachAngle = Math.round(d.angle / 1.41); l.repeat = 1; l.symmetry = d.sym;
    l.childScale = encodeQ(1, lf('childScale').range!, 255); l.repeatScale = encodeQ(1, lf('repeatScale').range!, 255);
    l.flags = LINK_FLAG.ENABLED;
    g.links.push(l);
  });
  return { bytes: out, innov };
}

/** Delete a rule and everything only it grew (never the root). */
export function deleteRule(bytes: Uint8Array, innov: number): Uint8Array {
  return edit(bytes, (g) => {
    if (innov === g.rootModuleInnov) return;
    const dead = new Set<number>([innov]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const m of g.modules) {
        if (dead.has(m.innov)) continue;
        const parents = g.links.filter((l) => l.toInnov === m.innov && !dead.has(l.fromInnov) && l.fromInnov !== m.innov);
        const fromDead = g.links.some((l) => l.toInnov === m.innov && dead.has(l.fromInnov));
        if (fromDead && parents.length === 0) { dead.add(m.innov); grew = true; }
      }
    }
    g.modules = g.modules.filter((m) => !dead.has(m.innov));
    g.links = g.links.filter((l) => !dead.has(l.fromInnov) && !dead.has(l.toInnov));
  });
}

/** Duplicate a rule (module plus its incoming links), as a new independent rule. */
export function duplicateRule(bytes: Uint8Array, innov: number): { bytes: Uint8Array; innov: number } {
  let fresh = 0;
  const out = edit(bytes, (g) => {
    const m = g.modules.find((x) => x.innov === innov);
    if (!m || innov === g.rootModuleInnov) return;
    fresh = nextInnov(g);
    g.modules.push({ ...m, innov: fresh, flags: m.flags & ~MODULE_FLAG.ROOT });
    let li = fresh + 1;
    for (const l of g.links.filter((x) => x.toInnov === innov)) g.links.push({ ...l, innov: li++, toInnov: fresh, attachAngle: Math.max(-128, Math.min(127, l.attachAngle + 10)) });
    for (const l of g.links.filter((x) => x.fromInnov === innov && x.toInnov !== innov)) g.links.push({ ...l, innov: li++, fromInnov: fresh });
  });
  return { bytes: out, innov: fresh };
}

/**
 * Break out one copy of a repeated rule (07 §1.3): the link's repeat drops by one and a new
 * link to a duplicated module grows that copy, so it can be edited alone. The other copies keep
 * their genes byte for byte.
 */
export function breakOut(bytes: Uint8Array, linkInnov: number): { bytes: Uint8Array; innov: number } {
  let fresh = 0;
  const out = edit(bytes, (g) => {
    const l = g.links.find((x) => x.innov === linkInnov);
    if (!l) return;
    const m = g.modules.find((x) => x.innov === l.toInnov);
    if (!m) return;
    fresh = nextInnov(g);
    g.modules.push({ ...m, innov: fresh, flags: m.flags & ~MODULE_FLAG.ROOT });
    if (l.repeat > 1) l.repeat -= 1;
    else if (l.symmetry === SYMMETRY.MIRROR) l.symmetry = SYMMETRY.NONE;
    g.links.push({ ...l, innov: fresh + 1, toInnov: fresh, repeat: 1, symmetry: SYMMETRY.NONE, attachAngle: l.symmetry === SYMMETRY.NONE ? -l.attachAngle : l.attachAngle });
    for (const c of g.links.filter((x) => x.fromInnov === m.innov && x.toInnov !== m.innov)) g.links.push({ ...c, innov: nextInnov(g), fromInnov: fresh });
  });
  return { bytes: out, innov: fresh };
}

export type ModuleField = 'length' | 'width' | 'taper' | 'stiffness' | 'muscleFraction' | 'glow' | 'armourCoverage' | 'lipidFraction' | 'cpgAmp' | 'hueOffset' | 'subtype' | 'p1' | 'p2';
export function getModule(bytes: Uint8Array, innov: number): ModuleGene | undefined { return view(bytes).modules.find((m) => m.innov === innov); }
export function setModuleField(bytes: Uint8Array, innov: number, field: ModuleField, q: number): Uint8Array {
  return edit(bytes, (g) => {
    const m = g.modules.find((x) => x.innov === innov);
    if (!m) return;
    const max = field === 'length' || field === 'width' ? 65535 : field === 'hueOffset' ? 127 : 255;
    const min = field === 'hueOffset' ? -128 : 0;
    (m as unknown as Record<string, number>)[field] = Math.max(min, Math.min(max, Math.round(q)));
  });
}
export type LinkField = 'repeat' | 'symmetry' | 'attachPos' | 'attachAngle' | 'childScale';
export function linksTo(bytes: Uint8Array, innov: number): LinkGene[] { return view(bytes).links.filter((l) => l.toInnov === innov); }
export function setLinkField(bytes: Uint8Array, linkInnov: number, field: LinkField, v: number): Uint8Array {
  return edit(bytes, (g) => {
    const l = g.links.find((x) => x.innov === linkInnov);
    if (!l) return;
    const lim: Record<LinkField, [number, number]> = { repeat: [1, 16], symmetry: [0, 2], attachPos: [0, 255], attachAngle: [-128, 127], childScale: [0, 255] };
    const [lo, hi] = lim[field];
    l[field] = Math.max(lo, Math.min(hi, Math.round(v)));
  });
}
export function moduleFieldValue(m: ModuleGene, field: ModuleField): number {
  const f = mf(field);
  const v = m[field] as number;
  if (!f.range) return v;
  return decodeQ(v, f.range, f.type === 'u16' ? 65535 : 255);
}
export function countKind(bytes: Uint8Array, kind: number): number { return view(bytes).modules.filter((m) => m.kind === kind && (m.flags & MODULE_FLAG.ENABLED)).length; }

// ---------------- Undo history ----------------
export interface GenomePatch { before: Uint8Array; after: Uint8Array; label: string; coalesce?: string }
export const HISTORY_CAP = 200;
export class History {
  undoStack: GenomePatch[] = [];
  redoStack: GenomePatch[] = [];
  /** Record an edit. Consecutive edits with the same coalesce key (one drag) merge. */
  push(p: GenomePatch): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && p.coalesce && top.coalesce === p.coalesce) top.after = p.after;
    else { this.undoStack.push(p); if (this.undoStack.length > HISTORY_CAP) this.undoStack.shift(); }
    this.redoStack = [];
  }
  /** End a drag so the next edit starts a new entry. */
  seal(): void { const top = this.undoStack[this.undoStack.length - 1]; if (top) delete top.coalesce; }
  undo(): Uint8Array | null { const p = this.undoStack.pop(); if (!p) return null; this.redoStack.push(p); return p.before; }
  redo(): Uint8Array | null { const p = this.redoStack.pop(); if (!p) return null; this.undoStack.push(p); return p.after; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
}

/** Bytes equal. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
