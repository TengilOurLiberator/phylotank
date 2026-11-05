/**
 * Share-page decoding (CONTRACT 14.2, 07 §2.3 to 2.5): read a `PTK1.` string from the URL
 * fragment, decode the `.ptkg` container and its genome, and turn the untrusted metadata
 * into safe plain text. Pure apart from DecompressionStream and crypto.subtle, which exist
 * in every supported browser and in Node 22, so the same code runs in the tests.
 */
import {
  decodeGenome, decodePtkg, FormatError, fromPtkString, genomeFingerprint, PTKG_KIND, PTKG_MAX_DECOMPRESSED,
  PTKG_MAX_RAW, PTK_STRING_PREFIX, sanitiseText, toPtkString,
  type DesignMeta, type Genome,
} from '../../src/core/index.js';

/** Longest string we look at: 64 KB raw as base64url plus the prefix (07 §2.4). */
export const MAX_STRING_CHARS = PTK_STRING_PREFIX.length + Math.ceil((PTKG_MAX_RAW * 4) / 3);
export const NAME_MAX = 40;
export const NOTES_MAX = 1024;
export const TAG_MAX = 24;
export const TAGS_MAX = 16;
export const PACK_MAX = 64;

/** A user-facing failure: `message` is a complete sentence that names the specific reason. */
export class ShareError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'ShareError'; }
}

export type FragmentRequest =
  | { kind: 'none' }
  | { kind: 'example' }
  | { kind: 'ptk'; value: string };

/**
 * Accepts `#ptk=PTK1.xxx` (the canonical share link), a bare `#PTK1.xxx`, and either form
 * percent-encoded or with whitespace from a line-wrapped chat message. `#example` asks for
 * the built-in example creature.
 */
export function readFragment(hash: string): FragmentRequest {
  let h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (h.length === 0) return { kind: 'none' };
  if (h.length > MAX_STRING_CHARS * 3 + 16) throw new ShareError('This link is far too long to be a Phylotank creature (the limit is 64 KB).', 'too-large');
  if (h === 'example') return { kind: 'example' };
  if (/^ptk=/i.test(h) || h.includes('&ptk=')) {
    const m = /(?:^|&)ptk=([^&]*)/i.exec(h);
    h = m ? m[1]! : '';
  }
  let value: string;
  try { value = decodeURIComponent(h.replace(/\+/g, '%2B')); } catch { throw new ShareError('The link is garbled: it contains a broken percent-escape.', 'bad-escape'); }
  value = value.replace(/\s+/g, '');
  if (value.length === 0) return { kind: 'none' };
  return { kind: 'ptk', value };
}

/** A share link for a string, relative to the share page's own URL. */
export function shareLink(pageHref: string, ptk: string): string {
  const u = new URL(pageHref);
  u.hash = `ptk=${ptk}`;
  return u.href;
}

export interface SafeMeta {
  genus: string;
  epithet: string;
  common: string;
  notes: string;
  author: string;
  created: string;
  origin: 'designer' | 'captured' | 'template' | 'unknown';
  tags: string[];
  world: { name: string; day: number; generation: number } | null;
  licence: string;
  parents: string[];
}

export interface LoadedDesign {
  meta: SafeMeta;
  genomeBytes: Uint8Array;
  genome: Genome;
  /** 3fa9-12c0-88e1-04bd (07 §2.3). */
  fingerprint: string;
}

export interface LoadedShare {
  /** The normalised `PTK1.` string. */
  string: string;
  /** The `.ptkg` container bytes, exactly as shared (what "Download .ptkg" saves). */
  container: Uint8Array;
  kind: 'design' | 'pack';
  compressed: boolean;
  designs: LoadedDesign[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !(v instanceof Uint8Array) && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? sanitiseText(v, max).trim() : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : 0);

/** Untrusted CBOR metadata to plain, capped, sanitised text (07 §2.4). Never throws. */
export function safeMeta(raw: unknown): SafeMeta {
  const m = isObj(raw) ? raw : {};
  const name = isObj(m.name) ? m.name : {};
  const origin = m.origin === 'designer' || m.origin === 'captured' || m.origin === 'template' ? m.origin : 'unknown';
  const tags = Array.isArray(m.tags) ? m.tags.slice(0, TAGS_MAX).map((t) => str(t, TAG_MAX)).filter((t) => t.length > 0) : [];
  const parents = Array.isArray(m.parents) ? m.parents.slice(0, 8).map((p) => str(p, 24)).filter((p) => p.length > 0) : [];
  const w = isObj(m.world) ? m.world : null;
  const created = str(m.created, 32);
  return {
    genus: str(name.genus, NAME_MAX),
    epithet: str(name.epithet, NAME_MAX),
    common: str(name.common, NAME_MAX),
    notes: str(m.notes, NOTES_MAX),
    author: str(m.author, NAME_MAX),
    created: /^\d{4}-\d{2}-\d{2}/.test(created) ? created : '',
    origin,
    tags,
    world: w ? { name: str(w.name, NAME_MAX), day: Math.max(0, Math.floor(num(w.day))), generation: Math.max(0, Math.floor(num(w.generation))) } : null,
    licence: str(m.licence, 16) || 'CC0-1.0',
    parents,
  };
}

/** "Genus epithet", or a fallback when the design carries no name. */
export function displayName(m: SafeMeta): string {
  const bin = [m.genus, m.epithet].filter((s) => s.length > 0).join(' ');
  return bin || m.common || 'Unnamed creature';
}

/** A file name safe on every OS: ASCII letters, digits and hyphens, then `.ptkg`. */
export function ptkgFileName(m: SafeMeta): string {
  const base = [m.genus, m.epithet].filter(Boolean).join('-') || m.common || 'phylotank-design';
  const ascii = base.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${ascii || 'phylotank-design'}.ptkg`;
}

/** deflate-raw inflate that aborts as soon as the output passes `maxBytes` (zip-bomb guard). */
export async function inflateRawCapped(input: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new ShareError('This browser cannot unpack compressed designs (no DecompressionStream). Try a current browser.', 'no-inflate');
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(input as Uint8Array<ArrayBuffer>).catch(() => undefined);
  writer.close().catch(() => undefined);
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ShareError('This design unpacks to more than 256 KB, so it was not opened.', 'too-large-inflated');
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof ShareError) throw e;
    throw new ShareError('The string is damaged: its compressed data does not unpack.', 'bad-deflate');
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function friendly(e: unknown): ShareError {
  if (e instanceof ShareError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const table: [RegExp, string, string][] = [
    [/not a PTK1 string/, 'This is not a Phylotank creature string: it should start with "PTK1.".', 'not-ptk'],
    [/invalid base64url/, 'The string contains characters that do not belong in a PTK1 string. Copy it again in full.', 'bad-base64'],
    [/too large/, 'This design is larger than 64 KB, so it was not opened.', 'too-large'],
    [/too short|out of range|past the end|truncated|beyond/i, 'The string is cut short. Copy it again in full.', 'truncated'],
    [/bad checksum/, 'The string is damaged (its checksum does not match). Copy it again in full.', 'bad-checksum'],
    [/not a Phylotank design/, 'This is not a Phylotank design (the container header is wrong).', 'bad-magic'],
    [/newer Phylotank|not supported/, `${msg.charAt(0).toUpperCase()}${msg.slice(1)}.`, 'newer'],
    [/genome/i, `The creature's genome could not be read (${msg}).`, 'bad-genome'],
  ];
  for (const [re, text, code] of table) if (re.test(msg)) return new ShareError(text, code);
  return new ShareError(`The design could not be read (${msg}).`, 'bad-design');
}

async function loadOne(meta: unknown, genome: unknown): Promise<LoadedDesign> {
  if (!(genome instanceof Uint8Array)) throw new ShareError('The design has no genome in it.', 'no-genome');
  let g: Genome;
  try { g = decodeGenome(genome, { verifyCrc: true }); } catch (e) { throw friendly(e instanceof FormatError ? new FormatError(`genome: ${e.message}`) : e); }
  return { meta: safeMeta(meta), genomeBytes: genome, genome: g, fingerprint: await genomeFingerprint(g) };
}

/** Decode a `PTK1.` string end to end. Throws ShareError with a specific, readable reason. */
export async function loadShare(input: string): Promise<LoadedShare> {
  const s = input.replace(/\s+/g, '');
  if (s.length > MAX_STRING_CHARS) throw new ShareError('This design is larger than 64 KB, so it was not opened.', 'too-large');
  try {
    const container = fromPtkString(s);
    const compressed = container.length >= 6 && (container[5]! & 1) === 1;
    let inflated: Uint8Array | null = null;
    if (compressed && container.length >= 16) {
      const n = new DataView(container.buffer, container.byteOffset, container.byteLength).getUint32(8, true);
      if (12 + n + 4 > container.length) throw new FormatError('design truncated');
      inflated = await inflateRawCapped(container.subarray(12, 12 + n), PTKG_MAX_DECOMPRESSED);
    }
    const ptkg = decodePtkg(container, {
      deflate: () => { throw new FormatError('deflate is not used when reading'); },
      inflate: () => inflated ?? new Uint8Array(0),
    });
    const payload = ptkg.payload as unknown;
    if (!isObj(payload)) throw new FormatError('design payload is not a map');
    if (ptkg.kind === PTKG_KIND.WORLD_REF) throw new ShareError('This is a reference to a whole world, not a creature. Open it in Phylotank itself.', 'world-ref');
    const designs: LoadedDesign[] = [];
    if (ptkg.kind === PTKG_KIND.DESIGN) {
      designs.push(await loadOne(payload.meta, payload.genome));
    } else if (ptkg.kind === PTKG_KIND.PACK) {
      const list = Array.isArray(payload.designs) ? payload.designs : [];
      if (list.length === 0) throw new ShareError('This species pack is empty.', 'empty-pack');
      if (list.length > PACK_MAX) throw new ShareError(`This pack holds ${list.length} designs; the limit is ${PACK_MAX}.`, 'pack-too-big');
      for (const d of list) designs.push(await loadOne(isObj(d) ? d.meta : undefined, isObj(d) ? d.genome : undefined));
    } else {
      throw new ShareError(`This design uses container kind ${ptkg.kind}, which this page does not know. It may need a newer Phylotank.`, 'unknown-kind');
    }
    return { string: toPtkString(container), container, kind: ptkg.kind === PTKG_KIND.PACK ? 'pack' : 'design', compressed, designs };
  } catch (e) {
    throw friendly(e);
  }
}

/** Build a `.ptkg` single-design container's metadata with the contract's required fields. */
export function designMeta(partial: Partial<DesignMeta> & Pick<DesignMeta, 'name'>): DesignMeta {
  return {
    created: '2026-11-05', origin: 'designer', parents: [], tags: [], licence: 'CC0-1.0', ...partial,
  };
}
