/**
 * Browser-side world snapshots for the dream tank (DESIGN 6, v0.1 "best-effort autosave to
 * IndexedDB every 5 minutes"; acceptance test 7). The bytes are a `.ptk` with the same
 * sections the host writes (CONTRACT 14.1), uncompressed, so a dream-tank world can later be
 * imported by the host. Pure functions here; the IndexedDB glue lives in worker.ts.
 */
import {
  allocWorld, applyColumns, BRAIN_CLASSES, ByteWriter, cborDecode, cborEncode, decodeColumns, decodeGlobals,
  encodeCanonicalGlobals, encodeColumns, FIELD_COLUMNS, FormatError, hashWorld, makeArray, PRESETS, PTK_CONTAINER_VERSION,
  PTK_FLAG, PTK_SCHEMA_VERSION, readPtk, TYPE_BYTES, TYPE_CODE, utf8Encode, writePtk,
  type AnyTypedArray, type CborValue, type World, type WorldConfig,
} from '../core/index.js';
import { exportSimState, type SavedSim } from './persist.js';
import type { SimCoreWithModules } from './index.js';

function encodeFields(world: World): Uint8Array {
  const f = world.fields as unknown as Record<string, AnyTypedArray>;
  const w = new ByteWriter(FIELD_COLUMNS.reduce((a, s) => a + f[s.name]!.byteLength + 96, 8));
  w.u32(FIELD_COLUMNS.length);
  for (const spec of FIELD_COLUMNS) {
    const arr = f[spec.name]!;
    const lanes = 'lanes' in spec ? spec.lanes : 1;
    const name = utf8Encode(spec.name);
    w.u8(name.length).bytes(name).u8(TYPE_CODE[spec.type]).u8(lanes & 0xff).u8(lanes >> 8).u32(arr.length / lanes).u32(arr.byteLength).align(8);
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
    if (src.length !== dst.length) throw new FormatError(`field ${cd.name} has the wrong size`);
    dst.set(src as never);
  }
}

/** Encode a world (pools, fields, sim side state) as an uncompressed `.ptk`. */
export function encodeDreamWorld(world: World): Uint8Array {
  const meta = { config: { ...world.config }, appVersion: '0.1.0-dream', kind: 'auto', journalSeq: 0, stateHash: hashWorld(world).toString(16) };
  const sec = (fourcc: string, data: Uint8Array) => ({ fourcc, data, required: true });
  return writePtk(
    { container: PTK_CONTAINER_VERSION, schema: PTK_SCHEMA_VERSION, flags: PTK_FLAG.FULL, tick: world.g.tick, simHash: 1n, epoch: world.g.epoch },
    [
      sec('META', cborEncode(meta as unknown as CborValue)),
      sec('GLOB', encodeCanonicalGlobals(world.g)),
      sec('CREA', encodeColumns(world.cr)),
      sec('SEGS', encodeColumns(world.seg)),
      ...world.brains.map((b, i) => sec(`BRN${i}`, encodeColumns(b))),
      sec('FLDS', encodeFields(world)),
      sec('EVTQ', cborEncode([])),
      sec('SIMS', cborEncode(exportSimState(world) as unknown as CborValue)),
    ],
  );
}

/** Decode a dream-tank `.ptk` into a world that the given core can step. Throws FormatError. */
export function decodeDreamWorld(bytes: Uint8Array, core: SimCoreWithModules): World {
  const file = readPtk(bytes, { maxRawBytes: 1024 ** 3 });
  const need = (k: string): Uint8Array => {
    const s = file.sections.get(k);
    if (!s) throw new FormatError(`world file has no ${k} section`);
    return s;
  };
  const meta = cborDecode(need('META'), { maxDepth: 16 }) as unknown as { config: WorldConfig; stateHash?: string };
  if (!meta.config || !PRESETS[meta.config.preset]) throw new FormatError('META has no valid world config');
  const world = allocWorld({ ...meta.config, backend: 'cpu' });
  const g = decodeGlobals(need('GLOB'));
  Object.assign(world.g, g);
  world.g.flowModes.set(g.flowModes);
  applyColumns(world.cr, decodeColumns(need('CREA')));
  applyColumns(world.seg, decodeColumns(need('SEGS')));
  for (let i = 0; i < BRAIN_CLASSES.length; i++) applyColumns(world.brains[i]!, decodeColumns(need(`BRN${i}`)));
  applyFields(world, need('FLDS'));
  if (meta.stateHash && BigInt(`0x${meta.stateHash}`) !== hashWorld(world)) throw new FormatError('world state hash mismatch after load');
  const saved = cborDecode(need('SIMS'), { maxDepth: 32 }) as unknown as SavedSim;
  core.adopt(world, saved);
  return world;
}
