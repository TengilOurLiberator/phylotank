/**
 * Genome store (CONTRACT 5.1 `genome` column, 6.8). Immutable genomes keyed by xxh64 of their
 * canonical bytes; the creature column holds a u32 handle. Clones share one entry (01 §1.7.2).
 *
 * The contract gives the store to src/genome but defines no interface for it, so this is a
 * local adapter (docs/contract-requests/sim.md). Handles are reused lowest-first, and the
 * store is mutated only by the birth and death commit, which runs in a fixed order, so handle
 * assignment is deterministic.
 */
import { encodeGenome, xxh64, type Genome } from '../core/index.js';

export interface StoreEntry {
  genome: Genome;
  key: bigint;
  bytes: Uint8Array;
  refs: number;
  /** Cached per-genome values the commit needs (newborn mass, kg), filled lazily. */
  newbornKg: number;
}

export class GenomeStore {
  private readonly entries: (StoreEntry | null)[] = [];
  private readonly byKey = new Map<bigint, number>();
  /** Free handles, kept sorted ascending so reuse is lowest-first. */
  private readonly free: number[] = [];

  /** Add a reference to a genome, interning it by content. Returns the handle. */
  intern(g: Genome): number {
    const bytes = encodeGenome(g);
    const key = xxh64(bytes);
    const h = this.byKey.get(key);
    if (h !== undefined) { this.entries[h]!.refs++; return h; }
    const handle = this.free.length > 0 ? this.free.shift()! : this.entries.length;
    this.entries[handle] = { genome: g, key, bytes, refs: 1, newbornKg: -1 };
    this.byKey.set(key, handle);
    return handle;
  }

  retain(handle: number): void { this.entry(handle).refs++; }

  release(handle: number): void {
    const e = this.entry(handle);
    if (--e.refs > 0) return;
    this.entries[handle] = null;
    this.byKey.delete(e.key);
    // sorted insert (lowest-first reuse)
    let i = this.free.length;
    while (i > 0 && this.free[i - 1]! > handle) i--;
    this.free.splice(i, 0, handle);
  }

  entry(handle: number): StoreEntry {
    const e = this.entries[handle];
    if (!e) throw new Error(`genome handle ${handle} is not live`);
    return e;
  }
  get(handle: number): Genome { return this.entry(handle).genome; }
  key(handle: number): bigint { return this.entry(handle).key; }
  byGenomeKey(key: bigint): StoreEntry | null {
    const h = this.byKey.get(key);
    return h === undefined ? null : this.entries[h]!;
  }
  get size(): number { return this.byKey.size; }

  /** Deterministic digest input: (handle, key, refs) for every live handle, in handle order. */
  digestWords(): number[] {
    const out: number[] = [];
    this.entries.forEach((e, h) => {
      if (!e) return;
      out.push(h, Number(e.key & 0xffffffffn), Number(e.key >> 32n), e.refs);
    });
    return out;
  }
}
