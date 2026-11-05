/**
 * Species library and sharing (07 §2, CONTRACT 14.2): `.ptkg` containers, `PTK1.` strings,
 * fingerprints, and import safety. In browser-only mode the library lives in this viewer's
 * localStorage (a host library folder replaces it when the host lands). Imports are untrusted:
 * size caps, CRC, strict CBOR, schema decode, text sanitised, and they always open in the
 * designer preview first, never straight into the world.
 */
import {
  canonicalBytes, decodeGenome, decodePtkg, encodeGenome, encodePtkg, FormatError, fromPtkString, genomeFingerprint, PTKG_KIND,
  PTKG_MAX_RAW, sanitiseText, toHex64, toPtkString, xxh64,
  type Design, type DesignMeta, type Genome,
} from '../../core/index.js';
import { store } from '../dom.js';
import { TEMPLATES, templateGenome } from './templates.js';

export interface LibraryEntry {
  id: string;
  meta: DesignMeta;
  genome: Uint8Array;
  readOnly: boolean;
  origin: 'template' | 'designed' | 'captured' | 'imported';
}

const KEY = 'phylotank.library.v1';

export function makeMeta(genus: string, epithet: string, origin: DesignMeta['origin'], extra: Partial<DesignMeta> = {}): DesignMeta {
  return {
    name: { genus: sanitiseText(genus, 40), epithet: sanitiseText(epithet, 40), ...(extra.name?.common ? { common: sanitiseText(extra.name.common, 40) } : {}) },
    created: new Date().toISOString().slice(0, 10), origin, parents: extra.parents ?? [], tags: extra.tags ?? [], licence: 'CC0-1.0',
    ...(extra.notes ? { notes: sanitiseText(extra.notes, 1024) } : {}), ...(extra.world ? { world: extra.world } : {}),
  };
}

export function packDesign(meta: DesignMeta, genome: Uint8Array): Uint8Array {
  return encodePtkg({ kind: PTKG_KIND.DESIGN, genomeVersion: 1, payload: { meta, genome: canonicalBytes(genome) } });
}
export function designString(meta: DesignMeta, genome: Uint8Array): string { return toPtkString(packDesign(meta, genome)); }

/** Content id (xxh64 of the canonical bytes) for de-duplication. */
export function contentId(genome: Uint8Array): string { return toHex64(xxh64(canonicalBytes(genome))); }
/** User-facing fingerprint (SHA-256 prefix), with an xxh64 fallback where SubtleCrypto is missing. */
export async function fingerprint(genome: Uint8Array): Promise<string> {
  try { return await genomeFingerprint(decodeGenome(genome)); } catch {
    const h = contentId(genome);
    return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}`;
  }
}

export interface Imported { designs: { meta: DesignMeta; genome: Uint8Array; notes: string[] }[] }

function cleanMeta(m: unknown): DesignMeta {
  const o = (typeof m === 'object' && m !== null ? m : {}) as Record<string, unknown>;
  const name = (typeof o.name === 'object' && o.name !== null ? o.name : {}) as Record<string, unknown>;
  const str = (v: unknown, n: number) => (typeof v === 'string' ? sanitiseText(v, n) : '');
  const origin = o.origin === 'captured' || o.origin === 'template' ? o.origin : 'designer';
  const common = str(name.common, 40);
  const notes = str(o.notes, 1024);
  return {
    name: { genus: str(name.genus, 40) || 'Ignotus', epithet: str(name.epithet, 40) || 'importatus', ...(common ? { common } : {}) },
    ...(notes ? { notes } : {}), ...(typeof o.author === 'string' ? { author: str(o.author, 40) } : {}),
    created: str(o.created, 32) || new Date().toISOString().slice(0, 10), origin,
    parents: Array.isArray(o.parents) ? o.parents.filter((p): p is string => typeof p === 'string').slice(0, 16).map((p) => sanitiseText(p, 32)) : [],
    tags: Array.isArray(o.tags) ? o.tags.filter((p): p is string => typeof p === 'string').slice(0, 16).map((p) => sanitiseText(p, 32)) : [],
    licence: 'CC0-1.0',
  };
}

function checkGenome(bytes: unknown): { genome: Uint8Array; notes: string[] } {
  if (!(bytes instanceof Uint8Array)) throw new FormatError('design has no genome');
  const g: Genome = decodeGenome(bytes);
  const notes: string[] = [];
  if (g.modules.length === 0) notes.push('no body parts');
  return { genome: encodeGenome(g), notes };
}

/** Parse a `.ptkg` file or a `PTK1.` string. Throws FormatError with a specific reason. */
export function importDesign(input: Uint8Array | string): Imported {
  let bytes: Uint8Array;
  if (typeof input === 'string') {
    if (input.length > PTKG_MAX_RAW * 2) throw new FormatError('too large');
    bytes = fromPtkString(input);
  } else bytes = input;
  const p = decodePtkg(bytes);
  if (p.kind === PTKG_KIND.DESIGN) {
    const { genome, notes } = checkGenome(p.payload.genome);
    return { designs: [{ meta: cleanMeta(p.payload.meta), genome, notes }] };
  }
  if (p.kind === PTKG_KIND.PACK) {
    const list = Array.isArray(p.payload.designs) ? p.payload.designs.slice(0, 64) : [];
    return { designs: list.map((d: Design) => ({ meta: cleanMeta(d.meta), ...checkGenome(d.genome) })) };
  }
  throw new FormatError('world-snapshot references open in the host, not the designer');
}

export class Library {
  entries: LibraryEntry[] = [];
  constructor() { this.load(); }

  private load(): void {
    const tmpl: LibraryEntry[] = TEMPLATES.map((t) => ({
      id: `template:${t.id}`, meta: makeMeta(t.genus, t.epithet, 'template', { name: { genus: t.genus, epithet: t.epithet, common: t.name }, tags: [t.niche] }),
      genome: encodeGenome(templateGenome(t.id)), readOnly: true, origin: 'template',
    }));
    const saved: LibraryEntry[] = [];
    const raw = store.get(KEY);
    if (raw) {
      try {
        for (const e of JSON.parse(raw) as { id: string; ptk: string; origin: LibraryEntry['origin'] }[]) {
          try {
            const d = importDesign(e.ptk).designs[0]!;
            saved.push({ id: e.id, meta: d.meta, genome: d.genome, readOnly: false, origin: e.origin });
          } catch { /* skip a damaged entry */ }
        }
      } catch { /* ignore */ }
    }
    this.entries = [...tmpl, ...saved];
  }
  private save(): void {
    store.set(KEY, JSON.stringify(this.entries.filter((e) => !e.readOnly).map((e) => ({ id: e.id, ptk: designString(e.meta, e.genome), origin: e.origin }))));
  }
  /** Add or update; de-duplicates by content id. Returns the entry and whether it was new. */
  put(meta: DesignMeta, genome: Uint8Array, origin: LibraryEntry['origin'], id?: string): { entry: LibraryEntry; added: boolean } {
    const cid = contentId(genome);
    const same = this.entries.find((e) => contentId(e.genome) === cid && !e.readOnly);
    if (same && !id) return { entry: same, added: false };
    const existing = id ? this.entries.find((e) => e.id === id && !e.readOnly) : undefined;
    if (existing) { existing.meta = meta; existing.genome = genome; this.save(); return { entry: existing, added: false }; }
    const entry: LibraryEntry = { id: `d:${cid}`, meta, genome, readOnly: false, origin };
    this.entries.push(entry);
    this.save();
    return { entry, added: true };
  }
  remove(id: string): void { this.entries = this.entries.filter((e) => e.id !== id || e.readOnly); this.save(); }
  search(q: string, filter: 'all' | LibraryEntry['origin']): LibraryEntry[] {
    const s = q.trim().toLowerCase();
    return this.entries.filter((e) => (filter === 'all' || e.origin === filter) &&
      (!s || `${e.meta.name.genus} ${e.meta.name.epithet} ${e.meta.name.common ?? ''} ${e.meta.tags.join(' ')}`.toLowerCase().includes(s)));
  }
}
