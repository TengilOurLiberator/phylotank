/**
 * `.ptkg` design and species-pack container, and the `PTK1.` string form (CONTRACT 14.2).
 * Deflate is injected so core stays platform-free.
 */
import { ByteReader, ByteWriter, FormatError, fromBase64Url, toBase64Url } from './bytes.js';
import { cborDecode, cborEncode, type CborValue } from './cbor.js';
import { GENOME_FORMAT_VERSION } from './constants.js';
import { crc32 } from './hash.js';

export const PTKG_KIND = { DESIGN: 1, PACK: 2, WORLD_REF: 3 } as const;
export const PTKG_MAX_RAW = 65_536;
export const PTKG_MAX_DECOMPRESSED = 262_144;
export const PTK_STRING_PREFIX = 'PTK1.';

export interface DesignMeta {
  name: { genus: string; epithet: string; common?: string };
  notes?: string;
  author?: string;
  created: string;
  origin: 'designer' | 'captured' | 'template';
  parents: string[];
  tags: string[];
  world?: { name: string; day: number; generation: number };
  licence: 'CC0-1.0';
}
export interface Design { meta: DesignMeta; genome: Uint8Array }
export interface Ptkg { kind: number; genomeVersion: number; payload: { meta: DesignMeta; genome?: Uint8Array; designs?: Design[] } }

export interface Deflate { deflate(b: Uint8Array): Uint8Array; inflate(b: Uint8Array, maxBytes: number): Uint8Array }

export function encodePtkg(p: Ptkg, z?: Deflate): Uint8Array {
  const raw = cborEncode(p.payload as unknown as CborValue);
  const payload = z ? z.deflate(raw) : raw;
  const w = new ByteWriter(16 + payload.length);
  w.u8(0x50).u8(0x54).u8(0x4b).u8(1).u8(p.kind).u8(z ? 1 : 0).u16(p.genomeVersion || GENOME_FORMAT_VERSION).u32(payload.length);
  w.bytes(payload);
  const body = w.view();
  w.u32(crc32(body));
  return w.finish();
}

export function decodePtkg(bytes: Uint8Array, z?: Deflate): Ptkg {
  if (bytes.length > PTKG_MAX_RAW) throw new FormatError('design file too large');
  if (bytes.length < 16) throw new FormatError('design file too short');
  const r = new ByteReader(bytes);
  if (r.u8() !== 0x50 || r.u8() !== 0x54 || r.u8() !== 0x4b) throw new FormatError('not a Phylotank design');
  const version = r.u8();
  if (version !== 1) throw new FormatError(`design container v${version} not supported`);
  const kind = r.u8();
  const flags = r.u8();
  const genomeVersion = r.u16();
  if (genomeVersion > GENOME_FORMAT_VERSION) throw new FormatError(`made with a newer Phylotank (genome v${genomeVersion}); update to import`);
  const n = r.u32();
  const payload = r.bytes(n);
  const crc = r.u32();
  if (crc !== crc32(bytes, 0, 12 + n)) throw new FormatError('bad checksum');
  let raw = payload;
  if (flags & 1) {
    if (!z) throw new FormatError('compressed design needs a deflate implementation');
    raw = z.inflate(payload, PTKG_MAX_DECOMPRESSED);
    if (raw.length > PTKG_MAX_DECOMPRESSED) throw new FormatError('design decompresses too large');
  }
  const value = cborDecode(raw, { maxDepth: 16 }) as unknown as Ptkg["payload"];
  if (typeof value !== 'object' || value === null) throw new FormatError('design payload is not a map');
  return { kind, genomeVersion, payload: value };
}

export function toPtkString(bytes: Uint8Array): string { return PTK_STRING_PREFIX + toBase64Url(bytes); }
export function fromPtkString(s: string): Uint8Array {
  const t = s.trim();
  if (!t.startsWith(PTK_STRING_PREFIX)) throw new FormatError('not a PTK1 string');
  return fromBase64Url(t.slice(PTK_STRING_PREFIX.length));
}

/** Text sanitising for imported names and notes (07 §2.4). */
export function sanitiseText(s: string, maxLen: number): string {
  // eslint-disable-next-line no-control-regex
  const stripped = s.normalize('NFC').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '');
  return Array.from(stripped).slice(0, maxLen).join('');
}
