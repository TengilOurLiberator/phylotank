/**
 * Real bodies for the renderer: views regrow each creature from its genome with the shared
 * `develop()` (DESIGN 2, CONTRACT 12 GENOME_REQ / GENOME), then hand the phenotype to
 * render's `templateFromPhenotype`. Until a body's genome arrives the renderer draws the
 * species archetype, so nothing pops out of view while the request is in flight.
 */
import {
  ByteReader, ByteWriter, decodeBodyEnter, decodeGenome, FRAME, HEADER_BYTES, MAX_PARTS, readHeader, writeHeader,
  type Genome,
} from '../core/index.js';
import { genome as genomeModule, lookOf } from '../genome/index.js';
import { ARCHETYPES, archetypeTemplate, templateFromPhenotype, type RenderTemplate } from '../render/index.js';
import type { LookGenes } from '../render/colour.js';

/** Map the genome's look traits onto the renderer's look genes. */
export function lookGenesOf(g: Genome): LookGenes {
  const lk = lookOf(g);
  const stripes = lk.patternKind === 1 || lk.patternKind === 3;
  const spots = lk.patternKind === 2;
  return {
    pigHue: lk.hue, pigSat: lk.sat, pigLight: lk.lum, opacity: 1 - 0.8 * lk.translucency,
    lumHue: lk.glowHue, lumGain: lk.glowBase, stripeFreq: stripes ? lk.patternFreq : 0, stripeAmp: stripes ? lk.patternContrast : 0,
    spotDensity: spots ? lk.patternFreq : 0, trailGain: lk.trail,
    pulsePeriodS: lk.pulseHz > 0 ? Math.min(20, Math.max(0.25, 1 / lk.pulseHz)) : 4, pulseDuty: lk.pulseShape,
    softness: 1,
  };
}

/** Build a render template from genome bytes (adult form; the renderer scales by length). */
export function templateFromGenomeBytes(key: bigint, bytes: Uint8Array, lCeilingM: number): RenderTemplate | null {
  const g = decodeGenome(bytes);
  const ph = genomeModule.develop(g, 1, { depth01: 0.3, tempC: 14 }, { maxParts: MAX_PARTS, lCeilingM });
  if (ph.nParts === 0) return null;
  return templateFromPhenotype(key.toString(16), ph, lookGenesOf(g));
}

export function encodeGenomeReq(tick: number, keys: bigint[]): Uint8Array {
  const w = new ByteWriter(HEADER_BYTES + 2 + keys.length * 8);
  writeHeader(w, FRAME.GENOME_REQ, tick);
  w.u16(keys.length);
  for (const k of keys) w.u32(Number(k & 0xffffffffn)).u32(Number(k >> 32n));
  return w.finish();
}

/** Per-view genome cache: requests unknown keys, builds templates, serves the renderer. */
export class GenomeTemplates {
  private readonly tpl = new Map<bigint, RenderTemplate | null>();
  private readonly asked = new Set<bigint>();
  private want: bigint[] = [];
  lCeilingM = 0.2;
  built = 0;

  /** Feed every frame from the link; returns GENOME_REQ frames to send (at most 64 keys each). */
  ingest(f: Uint8Array): Uint8Array[] {
    const h = readHeader(f);
    if (h.type === FRAME.BODY_ENTER) {
      for (const e of decodeBodyEnter(f)) {
        const k = BigInt(e.genomeKey);
        if (!this.tpl.has(k) && !this.asked.has(k)) { this.asked.add(k); this.want.push(k); }
      }
    } else if (h.type === FRAME.GENOME) {
      const r = new ByteReader(f, HEADER_BYTES);
      const lo = r.u32(), hi = r.u32(), len = r.u32();
      const key = (BigInt(hi) << 32n) | BigInt(lo);
      const bytes = f.subarray(HEADER_BYTES + 12, HEADER_BYTES + 12 + len);
      try { this.tpl.set(key, templateFromGenomeBytes(key, bytes, this.lCeilingM)); this.built++; } catch { this.tpl.set(key, null); }
      this.asked.delete(key);
      if (this.tpl.size > 4096) { const first = this.tpl.keys().next().value; if (first !== undefined) this.tpl.delete(first); }
    }
    if (this.want.length === 0) return [];
    const out: Uint8Array[] = [];
    while (this.want.length > 0) out.push(encodeGenomeReq(h.tick, this.want.splice(0, 64)));
    return out;
  }

  /** The renderer's TemplateSource. */
  source = (key: bigint, species: number): RenderTemplate | null => {
    const t = this.tpl.get(BigInt(key));
    if (t) return t;
    const a = ARCHETYPES[((species % ARCHETYPES.length) + ARCHETYPES.length) % ARCHETYPES.length]!;
    let at = this.arche.get(a);
    if (!at) { at = archetypeTemplate(a); this.arche.set(a, at); }
    return at;
  };
  private readonly arche = new Map<string, RenderTemplate>();

  /** Whether a key's real template has arrived (the renderer re-asks while it has the archetype). */
  has(key: bigint): boolean { return !!this.tpl.get(BigInt(key)); }
}
