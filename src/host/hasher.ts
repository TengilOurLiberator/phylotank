/**
 * The journalled state hash (CONTRACT 4.5, every HASH_EVERY ticks) off the main thread.
 *
 * The core xxh64 is pure JS and runs at about 14 MB/s here, so `hashWorld` on the Small preset
 * takes about 0.4 s: done inline every 256 ticks it stalls the streams. The host copies the
 * hashed bytes (a few MB, about a millisecond) and hashes them in a worker thread that runs the
 * same bundle (`dist/host.mjs`) with `workerData.ptkRole = 'hasher'`. Without a bundle path
 * (tests, `tsx`) it hashes inline. `hashChunks(worldChunks(w))` equals `hashWorld(w)`; a test
 * checks it.
 */
import { Worker } from 'node:worker_threads';
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

/** Worker body: hash what the main thread posts. Called by main.ts when it runs as the hasher. */
export function runHasherWorker(port: { on(ev: 'message', cb: (m: { tick: number; tag: number; chunks: Uint8Array[] }) => void): void; postMessage(m: unknown): void }): void {
  port.on('message', (m) => port.postMessage({ tick: m.tick, tag: m.tag, h: hashChunks(m.chunks) }));
}

export class AsyncHasher {
  private worker: Worker | null = null;
  private inFlight = 0;
  dropped = 0;

  constructor(private readonly onHash: (tick: number, h: string, tag: number) => void, bundlePath?: string) {
    if (!bundlePath || !bundlePath.endsWith('.mjs')) return;
    try {
      this.worker = new Worker(bundlePath, { workerData: { ptkRole: 'hasher' } });
      this.worker.unref();
      this.worker.on('message', (m: { tick: number; h: string; tag: number }) => { this.inFlight--; this.onHash(m.tick, m.h, m.tag); });
      this.worker.on('error', () => { this.worker = null; });
    } catch { this.worker = null; }
  }

  get threaded(): boolean { return this.worker !== null; }

  /** `tag` comes back with the result, so a caller can drop hashes of a world it has replaced. */
  submit(world: World, tag = 0): void {
    const tick = world.g.tick;
    if (!this.worker) { this.onHash(tick, hashChunks(worldChunks(world)), tag); return; }
    if (this.inFlight >= 2) { this.dropped++; return; } // the worker is behind: skip a checkpoint rather than queue
    const chunks = worldChunks(world);
    this.inFlight++;
    this.worker.postMessage({ tick, tag, chunks }, chunks.map((c) => c.buffer as ArrayBuffer));
  }

  async close(): Promise<void> { const w = this.worker; this.worker = null; if (w) await w.terminate(); }
}
