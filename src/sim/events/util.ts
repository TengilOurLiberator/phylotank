/** Small helpers shared by the detectors. */
export { CF, LIFE, NONE_U32, TICK_HZ, type V2, type World } from '../../core/index.js';
import type { World } from '../../core/index.js';

/** The u64 entity id of a slot as a JS number (CONTRACT 5.1). */
export function entityIdOf(world: World, slot: number): number {
  const c = world.cr.c;
  return c.idHi[slot]! * 4294967296 + c.idLo[slot]!;
}

/** Sim seconds between two ticks. */
export function secs(fromTick: number, toTick: number): number { return (toTick - fromTick) / 30; }

/** A Map bounded by insertion order: the oldest entry goes when it is full. */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(readonly cap: number) { super(); }
  override set(k: K, v: V): this {
    if (!this.has(k) && this.size >= this.cap) { const first = this.keys().next().value as K; this.delete(first); }
    return super.set(k, v);
  }
}
