/**
 * `.ptk` world container (CONTRACT 14.1): a 64-byte header, a section table, and 8-aligned
 * sections, each with its own codec and xxh64. Compression codecs are injected (deflate-raw
 * comes from node:zlib on the host and CompressionStream in browsers), so core stays
 * platform-free. Column sections share one layout so pools round-trip by column name.
 */
import { ByteReader, ByteWriter, FormatError, utf8Decode, utf8Encode } from './bytes.js';
import { fourcc, fourccToString } from './genome-schema.js';
import { crc32, xxh64 } from './hash.js';
import { CODE_TYPE, makeArray, TYPE_BYTES, TYPE_CODE, type AnyTypedArray, type ColType, type ColumnSpec, type Pool } from './soa.js';

export const PTK_MAGIC = 'PHYLOTNK';
export const PTK_CONTAINER_VERSION = 1;
export const PTK_SCHEMA_VERSION = 1;
export const CODEC = { NONE: 0, DEFLATE_RAW: 1, ZSTD: 2 } as const;
export const PTK_FLAG = { FULL: 1, LITE: 2 } as const;
const HEADER = 64;
const ENTRY = 40;
const MAX_RATIO = 50;

export interface Codec { encode(raw: Uint8Array): Uint8Array; decode(stored: Uint8Array, rawLen: number): Uint8Array }
export type CodecTable = Partial<Record<number, Codec>>;

export interface SectionIn { fourcc: string; data: Uint8Array; required: boolean; codec?: number }
export interface PtkHeader { container: number; schema: number; flags: number; tick: number; simHash: bigint; epoch: number }
export interface PtkFile { header: PtkHeader; sections: Map<string, Uint8Array>; skipped: string[] }

export function writePtk(header: PtkHeader, sections: SectionIn[], codecs: CodecTable = {}): Uint8Array {
  const stored = sections.map((s) => {
    const codec = s.codec ?? CODEC.NONE;
    const c = codecs[codec];
    if (codec !== CODEC.NONE && !c) throw new FormatError(`codec ${codec} not available`);
    return { s, codec, bytes: codec === CODEC.NONE ? s.data : c!.encode(s.data), hash: xxh64(s.data) };
  });
  const w = new ByteWriter(HEADER + ENTRY * sections.length + 1024);
  w.bytes(utf8Encode(PTK_MAGIC)).u32(header.container).u32(header.schema).u32(header.flags).u32(sections.length)
    .u64n(header.tick).u64(header.simHash).u32(header.epoch).zeros(16);
  w.u32(0); // header CRC, patched below
  const tableAt = w.pos;
  w.zeros(ENTRY * sections.length).align(8);
  const offsets: number[] = [];
  for (const st of stored) { offsets.push(w.pos); w.bytes(st.bytes).align(8); }
  const out = w.finish();
  const dv = new DataView(out.buffer);
  stored.forEach((st, i) => {
    const at = tableAt + i * ENTRY;
    dv.setUint32(at, fourcc(st.s.fourcc), true);
    dv.setUint8(at + 4, st.codec);
    dv.setUint8(at + 5, st.s.required ? 1 : 0);
    dv.setBigUint64(at + 8, BigInt(offsets[i]!), true);
    dv.setBigUint64(at + 16, BigInt(st.bytes.length), true);
    dv.setBigUint64(at + 24, BigInt(st.s.data.length), true);
    dv.setBigUint64(at + 32, st.hash, true);
  });
  dv.setUint32(60, crc32(out, 0, 60), true);
  return out;
}

export interface ReadPtkOptions { codecs?: CodecTable; knownSections?: ReadonlySet<string>; maxRawBytes?: number }

export function readPtk(bytes: Uint8Array, opts: ReadPtkOptions = {}): PtkFile {
  if (bytes.length < HEADER) throw new FormatError('file shorter than a .ptk header');
  const r = new ByteReader(bytes);
  if (utf8Decode(r.bytes(8)) !== PTK_MAGIC) throw new FormatError('not a Phylotank world file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(60, true) !== crc32(bytes, 0, 60)) throw new FormatError('world header CRC mismatch');
  const header: PtkHeader = {
    container: r.u32(), schema: r.u32(), flags: r.u32(), tick: 0, simHash: 0n, epoch: 0,
  };
  const n = r.u32();
  header.tick = r.u64n();
  header.simHash = r.u64();
  header.epoch = r.u32();
  if (header.container > PTK_CONTAINER_VERSION) throw new FormatError(`world container v${header.container} is newer than this build`);
  if (HEADER + n * ENTRY > bytes.length) throw new FormatError('section table out of bounds');
  const sections = new Map<string, Uint8Array>();
  const skipped: string[] = [];
  let rawTotal = 0;
  for (let i = 0; i < n; i++) {
    const at = HEADER + i * ENTRY;
    const name = fourccToString(dv.getUint32(at, true));
    const codec = dv.getUint8(at + 4);
    const required = dv.getUint8(at + 5) === 1;
    const off = Number(dv.getBigUint64(at + 8, true));
    const storedLen = Number(dv.getBigUint64(at + 16, true));
    const rawLen = Number(dv.getBigUint64(at + 24, true));
    const hash = dv.getBigUint64(at + 32, true);
    if (opts.knownSections && !opts.knownSections.has(name)) {
      if (required) throw new FormatError(`This world needs a newer Phylotank (section ${name})`);
      skipped.push(name);
      continue;
    }
    if (off + storedLen > bytes.length || off < HEADER) throw new FormatError(`section ${name} out of bounds`);
    if (codec !== CODEC.NONE && rawLen > storedLen * MAX_RATIO) throw new FormatError(`section ${name} exceeds the decompression ratio cap`);
    rawTotal += rawLen;
    if (opts.maxRawBytes !== undefined && rawTotal > opts.maxRawBytes) throw new FormatError('world exceeds the raw size cap');
    const stored = bytes.subarray(off, off + storedLen);
    let raw: Uint8Array;
    if (codec === CODEC.NONE) raw = stored;
    else {
      const c = opts.codecs?.[codec];
      if (!c) throw new FormatError(`codec ${codec} not available for section ${name}`);
      raw = c.decode(stored, rawLen);
    }
    if (raw.length !== rawLen) throw new FormatError(`section ${name} has the wrong length`);
    if (xxh64(raw) !== hash) throw new FormatError(`section ${name} checksum mismatch`);
    sections.set(name, raw);
  }
  return { header, sections, skipped };
}

// ---------- column sections ----------
export interface ColumnData { name: string; type: ColType; lanes: number; count: number; data: Uint8Array }

export function encodeColumns(pool: Pool<readonly ColumnSpec[]>, count = pool.highWater): Uint8Array {
  const w = new ByteWriter(1024);
  w.u32(pool.spec.length);
  for (const col of pool.spec) {
    const lanes = col.lanes ?? 1;
    const arr = (pool.c as Record<string, AnyTypedArray>)[col.name]!;
    const byteLen = TYPE_BYTES[col.type] * lanes * count;
    const name = utf8Encode(col.name);
    w.u8(name.length).bytes(name).u8(TYPE_CODE[col.type]).u8(lanes).u8(0).u32(count).u32(byteLen).align(8);
    w.bytes(new Uint8Array(arr.buffer, arr.byteOffset, byteLen)).align(8);
  }
  return w.finish();
}

export function decodeColumns(bytes: Uint8Array): ColumnData[] {
  const r = new ByteReader(bytes);
  const n = r.u32();
  const out: ColumnData[] = [];
  for (let i = 0; i < n; i++) {
    const name = utf8Decode(r.bytes(r.u8()));
    const code = r.u8();
    const type = CODE_TYPE[code];
    if (!type) throw new FormatError(`unknown column type ${code}`);
    const lanes = r.u8();
    r.u8();
    const count = r.u32();
    const byteLen = r.u32();
    if (byteLen !== TYPE_BYTES[type] * lanes * count) throw new FormatError(`column ${name} has inconsistent length`);
    r.align(8);
    out.push({ name, type, lanes, count, data: r.bytes(byteLen).slice() });
    r.align(8);
  }
  return out;
}

/** Copy decoded columns into a pool by name. Missing columns keep their defaults; unknown ones are ignored. */
export function applyColumns(pool: Pool<readonly ColumnSpec[]>, cols: ColumnData[]): string[] {
  const ignored: string[] = [];
  let count = 0;
  for (const cd of cols) {
    const spec = pool.spec.find((s) => s.name === cd.name);
    if (!spec || spec.type !== cd.type || (spec.lanes ?? 1) !== cd.lanes) { ignored.push(cd.name); continue; }
    if (cd.count > pool.capacity) throw new FormatError(`column ${cd.name} has ${cd.count} slots, capacity ${pool.capacity}`);
    const dst = (pool.c as Record<string, AnyTypedArray>)[cd.name]!;
    const src = makeArray(cd.type, cd.data.buffer, cd.data.byteOffset, cd.lanes * cd.count);
    dst.set(src as never);
    count = Math.max(count, cd.count);
  }
  pool.highWater = count;
  return ignored;
}
