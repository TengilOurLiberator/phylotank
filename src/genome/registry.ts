/**
 * The world innovation registry for body and regulatory genes (CONTRACT 6.8, 01 §1.3.7, DESIGN R16).
 *
 * "Same structural event, same id" inside a sliding window of births. The window is kept as two
 * generations of maps (current and previous), rotated every `windowBirths` births, so lookups
 * never iterate a map and the result depends only on the order of births, which the sim fixes
 * (CONTRACT 4.2 rule 6). Duplications are keyed by (srcInnov, paralogCount) (review R22).
 *
 * Event keys are two u32 words from hash32 folded into one safe integer.
 */
import { hash32 } from '../core/index.js';
import { FIRST_FREE_INNOV } from './constants.js';

export const EVENT = {
  DUPLICATE: 1, DUP_LINK: 2, ADD_MODULE: 3, ADD_LINK: 4, ADD_REG: 5, ADD_NEURON: 6, REWIRE: 7,
} as const;

export function eventKey(kind: number, a: number, b: number, c: number): number {
  const h1 = hash32(kind, a >>> 0, b >>> 0);
  const h2 = hash32(h1, c >>> 0, kind ^ 0x5bd1e995);
  return (h1 & 0x1fffff) * 4294967296 + h2; // 53-bit key
}

export interface RegistryState { next: number; births: number; windowBirths: number; cur: [number, number][]; prev: [number, number][] }

export class InnovationRegistry {
  next: number;
  births = 0;
  private cur = new Map<number, number>();
  private prev = new Map<number, number>();
  constructor(next = FIRST_FREE_INNOV, readonly windowBirths = 100_000) { this.next = next; }

  /** Count one birth; rotates the window. Called once per mutate(). */
  noteBirth(): void {
    this.births++;
    if (this.births % this.windowBirths === 0) { this.prev = this.cur; this.cur = new Map(); }
  }
  /** The id previously given to this event, if it is still inside the window. */
  lookup(key: number): number | undefined {
    return this.cur.get(key) ?? this.prev.get(key);
  }
  /** The id for a structural event: reused inside the window, else fresh. */
  innovFor(key: number): number {
    const c = this.cur.get(key);
    if (c !== undefined) return c;
    const p = this.prev.get(key);
    if (p !== undefined) { this.cur.set(key, p); return p; }
    const id = this.next++;
    if (this.next > 0xfffffffe) this.next = FIRST_FREE_INNOV; // compaction is the host's job (CONTRACT 6.8)
    this.cur.set(key, id);
    return id;
  }
  /** Snapshot form (insertion order is deterministic because births are processed in a fixed order). */
  save(): RegistryState {
    return { next: this.next, births: this.births, windowBirths: this.windowBirths, cur: [...this.cur], prev: [...this.prev] };
  }
  static load(s: RegistryState): InnovationRegistry {
    const r = new InnovationRegistry(s.next, s.windowBirths);
    r.births = s.births;
    for (const [k, v] of s.cur) r.cur.set(k, v);
    for (const [k, v] of s.prev) r.prev.set(k, v);
    return r;
  }
}
