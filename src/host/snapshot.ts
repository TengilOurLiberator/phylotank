/**
 * World <-> `.ptk` (CONTRACT 14.1). The container itself is core (`writePtk`, `readPtk`); this
 * file decides which sections a world has, encodes the field grids in the shared column layout,
 * applies chained schema migrations on load and rebuilds a World that steps on bit for bit.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  allocWorld, applyColumns, BRAIN_CLASSES, ByteWriter, cborDecode, cborEncode, CODEC, decodeColumns, decodeGlobals,
  encodeCanonicalGlobals, encodeColumns, FIELD_COLUMNS, FormatError, hashWorld, makeArray, PRESETS, PTK_CONTAINER_VERSION,
  PTK_FLAG, PTK_SCHEMA_VERSION, readPtk, TYPE_BYTES, TYPE_CODE, utf8Encode, writePtk, type AnyTypedArray, type CborValue,
  type Codec, type CodecTable, type PtkHeader, type SectionIn, type World, type WorldConfig,
} from '../core/index.js';
import type { JournalEntry } from '../sim/index.js';
import { migrateSections } from './migrations.js';

/** Bumped whenever the sim build changes in a way that breaks bit-exact replay (header simHash). */
export const SIM_BUILD_HASH = 0x0001_0000_0000_0001n;
export const APP_VERSION = '0.1.0-host';

/** Compressed bytes of the last raw buffers seen, so choosing a codec does not compress twice. */
const deflated = new WeakMap<Uint8Array, Uint8Array>();
function deflateOnce(raw: Uint8Array): Uint8Array {
  let out = deflated.get(raw);
  if (!out) { out = new Uint8Array(deflateRawSync(raw, { level: 3 })); deflated.set(raw, out); }
  return out;
}
/** Readers refuse sections that inflate more than 50:1 (CONTRACT 14.1), so very sparse ones are stored raw. */
const MAX_RATIO = 50;
function codecFor(raw: Uint8Array, compress: boolean): number {
  if (!compress || raw.length < 256) return CODEC.NONE;
  return raw.length >= deflateOnce(raw).length * MAX_RATIO ? CODEC.NONE : CODEC.DEFLATE_RAW;
}

const deflate: Codec = {
  encode: deflateOnce,
  decode: (stored, rawLen) => {
    const out = inflateRawSync(stored, { maxOutputLength: Math.max(1, rawLen) });
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  },
};
export const HOST_CODECS: CodecTable = { [CODEC.DEFLATE_RAW]: deflate };

/** Every section a v1 world may carry; anything else must be `required = 0` to be skipped. */
export const KNOWN_SECTIONS: ReadonlySet<string> = new Set([
  'META', 'GLOB', 'CREA', 'SEGS', 'BRN0', 'BRN1', 'BRN2', 'BRN3', 'BRN4', 'FLDS', 'GENO', 'SPEC', 'LINE', 'GBNK',
  'PARA', 'EVTQ', 'JRNL', 'CAMR', 'THMB',
]);
/** Raw-size cap for untrusted files (05 §5.9: 8 GB default). */
export const MAX_RAW_BYTES = 8 * 1024 ** 3;

export interface SnapshotMeta {
  config: WorldConfig;
  appVersion: string;
  stateHash: string;
  /** Journal sequence number that starts at this snapshot (persistence.ts). */
  journalSeq: number;
  kind: string;
  label?: string;
  wallIso?: string;
}

/** Field grids in the column-section layout (CONTRACT 14.1), one column per field. */
export function encodeFields(world: World): Uint8Array {
  const f = world.fields as unknown as Record<string, AnyTypedArray>;
  const w = new ByteWriter(4096);
  w.u32(FIELD_COLUMNS.length);
  for (const spec of FIELD_COLUMNS) {
    const arr = f[spec.name]!;
    const lanes = 'lanes' in spec ? spec.lanes : 1;
    const count = arr.length / lanes;
    const name = utf8Encode(spec.name);
    w.u8(name.length).bytes(name).u8(TYPE_CODE[spec.type]).u8(lanes).u8(0).u32(count).u32(arr.byteLength).align(8);
    w.bytes(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)).align(8);
  }
  return w.finish();
}

function applyFields(world: World, bytes: Uint8Array): void {
  const f = world.fields as unknown as Record<string, AnyTypedArray>;
  for (const cd of decodeColumns(bytes)) {
    const spec = FIELD_COLUMNS.find((s) => s.name === cd.name);
    const dst = f[cd.name];
    if (!spec || !dst || spec.type !== cd.type) continue;
    const src = makeArray(cd.type, cd.data.buffer, cd.data.byteOffset, cd.data.byteLength / TYPE_BYTES[cd.type]);
    if (src.length !== dst.length) throw new FormatError(`field ${cd.name} has ${src.length} values, expected ${dst.length}`);
    dst.set(src as never);
  }
}

export interface EncodeOptions {
  kind: string;
  label?: string;
  journalSeq: number;
  /** Journal inputs scheduled for this tick or later (EVTQ). */
  pending: readonly JournalEntry[];
  compress?: boolean;
  wallIso?: string;
}

export function encodeWorld(world: World, o: EncodeOptions): Uint8Array {
  const compress = o.compress !== false;
  const meta: SnapshotMeta = {
    config: { ...world.config }, appVersion: APP_VERSION, stateHash: hashWorld(world).toString(16),
    journalSeq: o.journalSeq, kind: o.kind, ...(o.label !== undefined ? { label: o.label } : {}),
    ...(o.wallIso !== undefined ? { wallIso: o.wallIso } : {}),
  };
  const sec = (fourcc: string, data: Uint8Array): SectionIn => ({ fourcc, data, required: true, codec: codecFor(data, compress) });
  const sections: SectionIn[] = [
    sec('META', cborEncode(meta as unknown as CborValue)),
    sec('GLOB', encodeCanonicalGlobals(world.g)),
    sec('CREA', encodeColumns(world.cr)),
    sec('SEGS', encodeColumns(world.seg)),
    ...world.brains.map((b, i) => sec(`BRN${i}`, encodeColumns(b))),
    sec('FLDS', encodeFields(world)),
    sec('EVTQ', cborEncode(o.pending as unknown as CborValue)),
  ];
  const header: PtkHeader = {
    container: PTK_CONTAINER_VERSION, schema: PTK_SCHEMA_VERSION, flags: PTK_FLAG.FULL, tick: world.g.tick,
    simHash: SIM_BUILD_HASH, epoch: world.g.epoch,
  };
  return writePtk(header, sections, HOST_CODECS);
}

export interface DecodedWorld { world: World; meta: SnapshotMeta; pending: JournalEntry[]; header: PtkHeader; skipped: string[]; migratedFrom: number }

function validConfig(v: unknown): WorldConfig {
  const c = v as Partial<WorldConfig> | null;
  if (!c || typeof c !== 'object' || typeof c.preset !== 'string' || !PRESETS[c.preset]) throw new FormatError('META has no valid world config');
  if (typeof c.seedLo !== 'number' || typeof c.seedHi !== 'number') throw new FormatError('META has no seed');
  const cap = c.agentCap ?? PRESETS[c.preset].cpuAgentCap;
  if (!Number.isInteger(cap) || cap < 1 || cap > PRESETS[c.preset].agentCap * 8) throw new FormatError('META agent cap out of range');
  return { ...c, backend: 'cpu' } as WorldConfig;
}

/** Decode and verify a `.ptk`. Throws FormatError on any corruption; never returns a half world. */
export function decodeWorld(bytes: Uint8Array): DecodedWorld {
  try {
    return decodeWorldUnchecked(bytes);
  } catch (e) {
    if (e instanceof FormatError) throw e;
    throw new FormatError(`unreadable world file: ${(e as Error).message}`);
  }
}

function decodeWorldUnchecked(bytes: Uint8Array): DecodedWorld {
  const file = readPtk(bytes, { codecs: HOST_CODECS, knownSections: KNOWN_SECTIONS, maxRawBytes: MAX_RAW_BYTES });
  const migratedFrom = file.header.schema;
  const sections = migrateSections(file.header.schema, file.sections);
  const need = (k: string): Uint8Array => {
    const s = sections.get(k);
    if (!s) throw new FormatError(`world file has no ${k} section`);
    return s;
  };
  const meta = cborDecode(need('META'), { maxDepth: 16 }) as unknown as SnapshotMeta;
  const config = validConfig(meta.config);
  const world = allocWorld(config);
  const g = decodeGlobals(need('GLOB'));
  if (g.preset !== config.preset) throw new FormatError('GLOB preset disagrees with META');
  Object.assign(world.g, g);
  world.g.flowModes.set(g.flowModes);
  applyColumns(world.cr, decodeColumns(need('CREA')));
  applyColumns(world.seg, decodeColumns(need('SEGS')));
  for (let i = 0; i < BRAIN_CLASSES.length; i++) applyColumns(world.brains[i]!, decodeColumns(need(`BRN${i}`)));
  applyFields(world, need('FLDS'));
  const pendingRaw = sections.get('EVTQ');
  const pending = pendingRaw ? (cborDecode(pendingRaw, { maxDepth: 16 }) as unknown as JournalEntry[]) : [];
  if (!Array.isArray(pending)) throw new FormatError('EVTQ is not a list');
  if (meta.stateHash !== undefined && migratedFrom === PTK_SCHEMA_VERSION && hashWorld(world).toString(16) !== meta.stateHash) {
    throw new FormatError('world state hash mismatch after load');
  }
  return { world, meta: { ...meta, config }, pending, header: file.header, skipped: file.skipped, migratedFrom };
}
