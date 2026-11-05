/**
 * The journalled state hash (CONTRACT 4.5, every HASH_EVERY ticks) off the main thread.
 *
 * The core xxh64 is pure JS and runs at about 14 MB/s here, so `hashWorld` on the Small preset
 * takes about 0.4 s: done inline every 256 ticks it stalls the streams. The host copies the
 * hashed bytes (a few MB, about a millisecond) and hashes them on its worker thread (worker.ts).
 * `hashChunks(worldChunks(w))` equals `hashWorld(w)`; a test checks it.
 */
import {
  encodeCanonicalGlobals, FIELD_COLUMNS, liveBytes, toHex64, xxh64Parts, type AnyTypedArray, type ColumnSpec, type Pool,
  type World,
} from '../core/index.js';

/** Copies of the bytes `hashWorld` feeds, in its order. */
export function worldChunks(w: World): Uint8Array[] {
  const out: Uint8Array[] = [encodeCanonicalGlobals(w.g)];
  const pools: Pool<readonly ColumnSpec[]>[] = [w.cr, w.seg, ...w.brains];
  for (const p of pools) for (const col of p.spec) out.push(liveBytes(p, col.name).slice());
  const f = w.fields as unknown as Record<string, AnyTypedArray>;
  for (const spec of FIELD_COLUMNS) {
    const a = f[spec.name]!;
    out.push(new Uint8Array(a.buffer, a.byteOffset, a.byteLength).slice());
  }
  return out;
}

export function hashChunks(chunks: readonly Uint8Array[]): string {
  let [h, l] = xxh64Parts(chunks[0]!);
  for (let i = 1; i < chunks.length; i++) [h, l] = xxh64Parts(chunks[i]!, h, l);
  return toHex64((BigInt(h) << 32n) | BigInt(l));
}
