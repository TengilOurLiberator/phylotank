/**
 * The host genome store (CONTRACT 6.8, DESIGN R17): immutable genomes keyed by xxh64 of their
 * canonical bytes, with u32 handles for the creature column `genome`. Handles are allocated
 * lowest-free-first and reference counted, so the handle sequence is deterministic in the order
 * of puts and releases (the column is part of the hashed world state).
 *
 * The parent-diff forest for `.ptk` snapshots is the host's job (src/host); `entries()` lists
 * live blobs in handle order for it.
 */
import { decodeGenome, encodeGenome, xxh64, type Genome } from '../core/index.js';

interface Entry { key: bigint; bytes: Uint8Array; genome: Genome; refs: number }

export class GenomeStore {
  private readonly byKey = new Map<bigint, number>();
  private readonly slots: (Entry | null)[] = [];
  private readonly free: number[] = []; // ascending

  /** Add a reference to a genome; identical genomes share one handle. */
  put(g: Genome): number { return this.putBytes(encodeGenome(g), g); }
  putBytes(bytes: Uint8Array, decoded?: Genome): number {
    const key = xxh64(bytes);
    const h = this.byKey.get(key);
    if (h !== undefined) { this.slots[h]!.refs++; return h; }
    const handle = this.free.length > 0 ? this.free.shift()! : this.slots.length;
    this.slots[handle] = { key, bytes, genome: decoded ?? decodeGenome(bytes), refs: 1 };
    this.byKey.set(key, handle);
    return handle;
  }
  get(handle: number): Genome {
    const e = this.slots[handle];
    if (!e) throw new Error(`no genome at handle ${handle}`);
    return e.genome;
  }
  bytes(handle: number): Uint8Array { const e = this.slots[handle]; if (!e) throw new Error(`no genome at handle ${handle}`); return e.bytes; }
  key(handle: number): bigint { const e = this.slots[handle]; if (!e) throw new Error(`no genome at handle ${handle}`); return e.key; }
  handleOf(key: bigint): number | undefined { return this.byKey.get(key); }
  retain(handle: number): void { const e = this.slots[handle]; if (e) e.refs++; }
  release(handle: number): void {
    const e = this.slots[handle];
    if (!e) return;
    if (--e.refs > 0) return;
    this.byKey.delete(e.key);
    this.slots[handle] = null;
    let i = 0;
    while (i < this.free.length && this.free[i]! < handle) i++;
    this.free.splice(i, 0, handle);
  }
  get size(): number { return this.byKey.size; }
  /** Live entries in handle order. */
  *entries(): IterableIterator<{ handle: number; key: bigint; bytes: Uint8Array; refs: number }> {
    for (let h = 0; h < this.slots.length; h++) { const e = this.slots[h]; if (e) yield { handle: h, key: e.key, bytes: e.bytes, refs: e.refs }; }
  }
}
