/**
 * The host's worker thread: journalled state hashes and snapshot encoding off the main thread,
 * so ticks and streams do not stall (REVIEW R17; 05 §5.4.2 "the sim keeps running during
 * compression"). The worker runs the same bundle (`dist/host.mjs`, with
 * `workerData.ptkRole = 'worker'`). Without a bundle path (tests, in-process callers) every
 * job runs inline and synchronously.
 */
import { Worker } from 'node:worker_threads';
import type { World } from '../core/index.js';
import { hashChunks, worldChunks } from './hasher.js';
import { finishSnapshot, type PreparedSnapshot } from './snapshot.js';
import { atomicWrite } from './store.js';

type Job =
  | { op: 'hash'; tick: number; tag: number; chunks: Uint8Array[] }
  | { op: 'snapshot'; id: number; prepared: PreparedSnapshot; path: string; dir: string };
type Reply =
  | { op: 'hash'; tick: number; tag: number; h: string }
  | { op: 'snapshot'; id: number; bytes?: number; error?: string };

export const WORKER_ROLE = 'worker';

function runJob(j: Job): Reply {
  if (j.op === 'hash') return { op: 'hash', tick: j.tick, tag: j.tag, h: hashChunks(j.chunks) };
  try {
    const bytes = finishSnapshot(j.prepared);
    atomicWrite(j.path, bytes, j.dir);
    return { op: 'snapshot', id: j.id, bytes: bytes.length };
  } catch (e) {
    return { op: 'snapshot', id: j.id, error: (e as Error).message };
  }
}

/** Worker body; main.ts calls it when the bundle runs as the host's worker. */
export function runHostWorker(port: { on(ev: 'message', cb: (m: Job) => void): void; postMessage(m: unknown): void }): void {
  port.on('message', (m) => port.postMessage(runJob(m)));
}

function transfers(j: Job): ArrayBuffer[] {
  const bufs = j.op === 'hash' ? j.chunks : [...j.prepared.raw.map((r) => r.data), ...j.prepared.hashInput];
  return [...new Set(bufs.map((b) => b.buffer as ArrayBuffer))];
}

export class HostWorker {
  private worker: Worker | null = null;
  private hashesInFlight = 0;
  private nextId = 1;
  private readonly waiting = new Map<number, (r: { bytes?: number; error?: string }) => void>();
  droppedHashes = 0;

  constructor(private readonly onHash: (tick: number, h: string, tag: number) => void, bundlePath?: string) {
    if (!bundlePath || !bundlePath.endsWith('.mjs')) return;
    try {
      const w = new Worker(bundlePath, { workerData: { ptkRole: WORKER_ROLE } });
      w.unref();
      w.on('message', (m: Reply) => {
        if (m.op === 'hash') { this.hashesInFlight--; this.onHash(m.tick, m.h, m.tag); return; }
        const cb = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        cb?.(m);
      });
      w.on('error', () => { this.worker = null; for (const cb of this.waiting.values()) cb({ error: 'worker failed' }); this.waiting.clear(); });
      this.worker = w;
    } catch { this.worker = null; }
  }

  get threaded(): boolean { return this.worker !== null; }

  /** `tag` comes back with the result, so a caller can drop hashes of a world it has replaced. */
  hash(world: World, tag = 0): void {
    const tick = world.g.tick;
    if (!this.worker) { this.onHash(tick, hashChunks(worldChunks(world)), tag); return; }
    if (this.hashesInFlight >= 2) { this.droppedHashes++; return; } // behind: skip a checkpoint rather than queue
    const job: Job = { op: 'hash', tick, tag, chunks: worldChunks(world) };
    this.hashesInFlight++;
    this.worker.postMessage(job, transfers(job));
  }

  /** Finish and write a prepared snapshot; resolves with its size, or rejects. Inline without a worker. */
  snapshot(prepared: PreparedSnapshot, path: string, dir: string): Promise<number> {
    const job: Job = { op: 'snapshot', id: this.nextId++, prepared, path, dir };
    if (!this.worker) {
      const r = runJob(job) as { bytes?: number; error?: string };
      return r.error ? Promise.reject(new Error(r.error)) : Promise.resolve(r.bytes!);
    }
    return new Promise((resolve, reject) => {
      this.waiting.set(job.id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.bytes!)));
      this.worker!.postMessage(job, transfers(job));
    });
  }

  get busy(): boolean { return this.waiting.size > 0; }

  async close(): Promise<void> {
    // let pending snapshot writes finish (they are atomic, so a cut-off one is simply absent)
    const deadline = Date.now() + 4000;
    while (this.waiting.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const w = this.worker; this.worker = null; if (w) await w.terminate();
  }
}
