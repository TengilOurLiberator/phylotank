/**
 * Genome binary format v1 codec (CONTRACT 6). Forward compatible: unknown sections and record
 * tails are kept and re-emitted; short records and short trait blocks take schema defaults.
 */
import { ByteReader, ByteWriter, FormatError } from './bytes.js';
import {
  GENOME_FORMAT_VERSION, GENOME_HEADER_SIZE, GENOME_MAGIC, GENOME_MAX_BYTES,
} from './constants.js';
import {
  BRAIN_TRAITS, BRAIN_TRAIT_COUNT, CPPN_CONN_RECORD, CPPN_NODE_RECORD, defaultQ, DIRECT_SYNAPSE_RECORD,
  fourcc, HIDDEN_NEURON_RECORD, LINK_RECORD, MODULE_RECORD, REG_RECORD, SECTION_ORDER, TRAITS, TRAIT_COUNT,
  type FieldDef, type RecordDef, type SectionTag,
} from './genome-schema.js';
import { crc32, xxh64 } from './hash.js';
import type { Genome, RawSection } from './types.js';



const TAG = Object.fromEntries(SECTION_ORDER.map((s) => [s, fourcc(s)])) as Record<SectionTag, number>;
const TAG_TO_NAME = new Map<number, SectionTag>(SECTION_ORDER.map((s) => [fourcc(s), s]));

const FIELD_SIZE: Record<FieldDef['type'], number> = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, u64: 8 };

function readField(dv: DataView, at: number, fd: FieldDef): number | bigint {
  switch (fd.type) {
    case 'u8': return dv.getUint8(at);
    case 'i8': return dv.getInt8(at);
    case 'u16': return dv.getUint16(at, true);
    case 'i16': return dv.getInt16(at, true);
    case 'u32': return dv.getUint32(at, true);
    case 'u64': return dv.getBigUint64(at, true);
  }
}
function writeField(dv: DataView, at: number, fd: FieldDef, v: number | bigint): void {
  switch (fd.type) {
    case 'u8': dv.setUint8(at, Number(v) & 0xff); break;
    case 'i8': dv.setInt8(at, Number(v)); break;
    case 'u16': dv.setUint16(at, Number(v) & 0xffff, true); break;
    case 'i16': dv.setInt16(at, Number(v), true); break;
    case 'u32': dv.setUint32(at, Number(v) >>> 0, true); break;
    case 'u64': dv.setBigUint64(at, BigInt.asUintN(64, BigInt(v)), true); break;
  }
}

/** A record with every field at its default. */
export function defaultRecord<T>(def: RecordDef): T {
  const o: Record<string, number | bigint> = {};
  for (const fd of def.fields) o[fd.name] = fd.type === 'u64' ? 0n : (fd.def ?? 0);
  return o as T;
}

function decodeRecords<T>(def: RecordDef, bytes: Uint8Array, recordSize: number, count: number): T[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: T[] = [];
  for (let r = 0; r < count; r++) {
    const base = r * recordSize;
    const o: Record<string, unknown> = {};
    for (const fd of def.fields) {
      if (fd.off + FIELD_SIZE[fd.type] <= recordSize) o[fd.name] = readField(dv, base + fd.off, fd);
      else o[fd.name] = fd.type === 'u64' ? 0n : (fd.def ?? 0);
    }
    if (recordSize > def.size) o.ext = bytes.slice(base + def.size, base + recordSize);
    out.push(o as T);
  }
  return out;
}

function recordSizeOf(records: readonly { ext?: Uint8Array }[], def: RecordDef): number {
  let extra = 0;
  for (const r of records) extra = Math.max(extra, r.ext?.length ?? 0);
  return def.size + extra;
}

function writeRecords(w: ByteWriter, def: RecordDef, records: readonly Record<string, unknown>[]): void {
  const size = recordSizeOf(records as { ext?: Uint8Array }[], def);
  w.u32(fourcc(def.tag)).u16(size).u16(0).u32(records.length);
  const block = new Uint8Array(size * records.length);
  const dv = new DataView(block.buffer);
  records.forEach((rec, r) => {
    for (const fd of def.fields) writeField(dv, r * size + fd.off, fd, rec[fd.name] as number | bigint);
    const ext = rec.ext as Uint8Array | undefined;
    if (ext) block.set(ext, r * size + def.size);
  });
  w.bytes(block).align(4);
}

function cmpInnov(a: { innov: number | bigint }, b: { innov: number | bigint }): number {
  return a.innov < b.innov ? -1 : a.innov > b.innov ? 1 : 0;
}
function cmpSyn(a: { src: number; dst: number }, b: { src: number; dst: number }): number {
  return a.src - b.src || a.dst - b.dst;
}

/** A genome with no structure, default traits and default brain traits. */
export function emptyGenome(): Genome {
  const traits = new Uint16Array(TRAIT_COUNT);
  for (let i = 0; i < TRAIT_COUNT; i++) traits[i] = defaultQ(TRAITS, i);
  const brainTraits = new Uint16Array(BRAIN_TRAIT_COUNT);
  for (let i = 0; i < BRAIN_TRAIT_COUNT; i++) brainTraits[i] = defaultQ(BRAIN_TRAITS, i);
  return {
    formatVersion: GENOME_FORMAT_VERSION, flags: 0, rootModuleInnov: 0, traits, immuneKey: 0, surfaceSig: 0,
    modules: [], links: [], regs: [], brainTraits, cppnNodes: [], cppnConns: [], hiddenNeurons: [],
    directSynapses: [], unknown: [],
  };
}

/** Encode in canonical form: known sections in order, records sorted, unknown sections last. */
export function encodeGenome(g: Genome): Uint8Array {
  const w = new ByteWriter(4096);
  w.u32(GENOME_MAGIC).u16(GENOME_FORMAT_VERSION).u16(g.flags & 0xffff).u16(0).u16(GENOME_HEADER_SIZE)
    .u32(0).u32(g.rootModuleInnov).u32(0).u32(0).u32(0);
  let nSections = 0;
  const u16Block = (tag: number, arr: Uint16Array): void => {
    w.u32(tag).u16(2).u16(0).u32(arr.length);
    for (let i = 0; i < arr.length; i++) w.u16(arr[i]!);
    w.align(4);
    nSections++;
  };
  u16Block(TAG.TRAT, g.traits);
  w.u32(TAG.KEYS).u16(4).u16(0).u32(2).u32(g.immuneKey).u32(g.surfaceSig);
  nSections++;
  const recs = (def: RecordDef, list: readonly object[], always: boolean, cmp: (a: never, b: never) => number): void => {
    if (!always && list.length === 0) return;
    const sorted = [...list].sort(cmp as (a: object, b: object) => number);
    writeRecords(w, def, sorted as Record<string, unknown>[]);
    nSections++;
  };
  recs(MODULE_RECORD, g.modules, true, cmpInnov);
  recs(LINK_RECORD, g.links, true, cmpInnov);
  recs(REG_RECORD, g.regs, false, cmpInnov);
  u16Block(TAG.BTRT, g.brainTraits);
  recs(CPPN_NODE_RECORD, g.cppnNodes, false, cmpInnov);
  recs(CPPN_CONN_RECORD, g.cppnConns, false, cmpInnov);
  recs(HIDDEN_NEURON_RECORD, g.hiddenNeurons, false, cmpInnov);
  recs(DIRECT_SYNAPSE_RECORD, g.directSynapses, false, cmpSyn);
  for (const s of g.unknown) {
    w.u32(s.tag).u16(s.recordSize).u16(s.sectionFlags).u32(s.count).bytes(s.bytes).align(4);
    nSections++;
  }
  w.patchU16(8, nSections);
  w.patchU32(12, w.pos);
  const out = w.finish();
  if (out.length > GENOME_MAX_BYTES) throw new FormatError(`genome is ${out.length} bytes, cap ${GENOME_MAX_BYTES}`);
  new DataView(out.buffer).setUint32(20, crc32Zeroed(out), true);
  return out;
}

function crc32Zeroed(b: Uint8Array): number {
  const c = b.slice();
  c[20] = 0; c[21] = 0; c[22] = 0; c[23] = 0;
  return crc32(c);
}

export interface DecodeOptions { verifyCrc?: boolean }

export function decodeGenome(bytes: Uint8Array, opts: DecodeOptions = {}): Genome {
  if (bytes.length < GENOME_HEADER_SIZE) throw new FormatError('genome shorter than its header');
  if (bytes.length > GENOME_MAX_BYTES) throw new FormatError('genome exceeds 16 KB');
  const r = new ByteReader(bytes);
  if (r.u32() !== GENOME_MAGIC) throw new FormatError('bad genome magic');
  const formatVersion = r.u16();
  const flags = r.u16();
  const nSections = r.u16();
  const headerSize = r.u16();
  const totalLength = r.u32();
  const rootModuleInnov = r.u32();
  const crc = r.u32();
  if (totalLength > bytes.length || totalLength < headerSize || headerSize < GENOME_HEADER_SIZE) {
    throw new FormatError('bad genome lengths');
  }
  if (opts.verifyCrc !== false && crc32Zeroed(bytes.subarray(0, totalLength)) !== crc) {
    throw new FormatError('genome CRC mismatch');
  }
  const g = emptyGenome();
  g.formatVersion = formatVersion;
  g.flags = flags;
  g.rootModuleInnov = rootModuleInnov;
  const body = new ByteReader(bytes, headerSize, totalLength);
  for (let s = 0; s < nSections; s++) {
    const tag = body.u32();
    const recordSize = body.u16();
    const sectionFlags = body.u16();
    const count = body.u32();
    if (recordSize === 0 && count > 0) throw new FormatError('zero record size');
    const data = body.bytes(recordSize * count);
    body.align(4);
    const name = TAG_TO_NAME.get(tag);
    switch (name) {
      case 'TRAT': case 'BTRT': {
        if (recordSize < 2) throw new FormatError('trait record too small');
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const base = name === 'TRAT' ? g.traits : g.brainTraits;
        const arr = new Uint16Array(Math.max(base.length, count));
        arr.set(base);
        for (let i = 0; i < count; i++) arr[i] = dv.getUint16(i * recordSize, true);
        if (name === 'TRAT') g.traits = arr; else g.brainTraits = arr;
        break;
      }
      case 'KEYS': {
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        if (count > 0 && recordSize >= 4) g.immuneKey = dv.getUint32(0, true);
        if (count > 1 && recordSize >= 4) g.surfaceSig = dv.getUint32(recordSize, true);
        break;
      }
      case 'MODL': g.modules = decodeRecords(MODULE_RECORD, data, recordSize, count); break;
      case 'LINK': g.links = decodeRecords(LINK_RECORD, data, recordSize, count); break;
      case 'REGU': g.regs = decodeRecords(REG_RECORD, data, recordSize, count); break;
      case 'CPPN': g.cppnNodes = decodeRecords(CPPN_NODE_RECORD, data, recordSize, count); break;
      case 'CPPC': g.cppnConns = decodeRecords(CPPN_CONN_RECORD, data, recordSize, count); break;
      case 'DNEU': g.hiddenNeurons = decodeRecords(HIDDEN_NEURON_RECORD, data, recordSize, count); break;
      case 'DSYN': g.directSynapses = decodeRecords(DIRECT_SYNAPSE_RECORD, data, recordSize, count); break;
      default: {
        const raw: RawSection = { tag, recordSize, sectionFlags, count, bytes: data.slice() };
        g.unknown.push(raw);
      }
    }
  }
  const caps: [unknown[], RecordDef][] = [
    [g.modules, MODULE_RECORD], [g.links, LINK_RECORD], [g.regs, REG_RECORD], [g.cppnNodes, CPPN_NODE_RECORD],
    [g.cppnConns, CPPN_CONN_RECORD], [g.hiddenNeurons, HIDDEN_NEURON_RECORD], [g.directSynapses, DIRECT_SYNAPSE_RECORD],
  ];
  for (const [list, def] of caps) if (list.length > def.max) throw new FormatError(`${def.tag} has ${list.length} records, cap ${def.max}`);
  return g;
}

export function canonicalBytes(bytes: Uint8Array): Uint8Array { return encodeGenome(decodeGenome(bytes)); }

/** Internal content key (CONTRACT 6.1). */
export function genomeKey(g: Genome): bigint { return xxh64(encodeGenome(g)); }

/** User-facing fingerprint: first 8 bytes of SHA-256 of the canonical bytes, as 3fa9-12c0-88e1-04bd. */
export async function genomeFingerprint(g: Genome): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encodeGenome(g) as Uint8Array<ArrayBuffer>));
  const hex = Array.from(digest.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}
