/**
 * Records (CONTRACT 11 `record`, 06 §6.2.2): the biggest, fastest and oldest creature ever.
 *
 * A new holder is reported when it beats the all-time record by at least `gain` (5%), at most
 * once per `cooldownS` (10 min) per kind unless the gain is at least `bigGain` (20%). The holder
 * itself growing or ageing past its own record moves the record silently; a growing or speeding
 * holder is reported again after a `bigGain` over what was last reported (an ageing one never), so a growing animal does not stream
 * 0.1% "records". The first `warmupS` only set the bar. Speed must be sustained: it is the
 * lower of the creature's speed in this run and the previous one, tracked for the `topK`
 * fastest only (bounded).
 */
import { TICK_HZ } from './util.js';
import { entityIdOf } from './util.js';
import type { Derived, Detector, Scan } from './types.js';

export type RecordKind = 'size' | 'speed' | 'age';

export interface RecordOptions {
  gain?: number;
  bigGain?: number;
  cooldownS?: number;
  warmupS?: number;
  topK?: number;
  /** Ignore speeds above this many body lengths per second (contact kicks), and above this many m/s. */
  maxBodyLengthsPerS?: number;
}

interface Rec { value: number; id: number; reported: number; lastEmit: number; species: number }

export class RecordDetector implements Detector {
  readonly name = 'records';
  private readonly o: Required<RecordOptions>;
  private readonly recs: Record<RecordKind, Rec> = {
    size: { value: 0, id: -1, reported: 0, lastEmit: -Infinity, species: 0 },
    speed: { value: 0, id: -1, reported: 0, lastEmit: -Infinity, species: 0 },
    age: { value: 0, id: -1, reported: 0, lastEmit: -Infinity, species: 0 },
  };
  private prevSpeed = new Map<number, number>();
  private firstTick = -1;

  constructor(opts: RecordOptions = {}) {
    this.o = { gain: 0.05, bigGain: 0.2, cooldownS: 600, warmupS: 60, topK: 16, maxBodyLengthsPerS: 50, ...opts };
  }

  run(scan: Scan, out: Derived[]): void {
    const w = scan.world; const c = w.cr.c; const t = scan.tick;
    if (this.firstTick < 0) this.firstTick = t;
    let bigS = -1; let big = 0; let oldS = -1; let old = -1;
    const top: [number, number][] = []; // [speed, slot], kept sorted desc, length <= topK
    for (let i = 0; i < scan.nAlive; i++) {
      const s = scan.alive[i]!;
      const L = c.length[s]!;
      if (L > big) { big = L; bigS = s; }
      const age = t - c.birthTick[s]!;
      if (age > old) { old = age; oldS = s; }
      const v = Math.sqrt(c.velX[s]! * c.velX[s]! + c.velY[s]! * c.velY[s]!);
      if (!(v > 0) || v > this.o.maxBodyLengthsPerS * Math.max(L, 1e-4)) continue;
      if (top.length < this.o.topK || v > top[top.length - 1]![0]) {
        let j = top.length < this.o.topK ? top.length : top.length - 1;
        top[j] = [v, s];
        while (j > 0 && (top[j - 1]![0] < top[j]![0] || (top[j - 1]![0] === top[j]![0] && top[j - 1]![1] > top[j]![1]))) { const x = top[j - 1]!; top[j - 1] = top[j]!; top[j] = x; j--; }
      }
    }
    const warm = t - this.firstTick >= this.o.warmupS * TICK_HZ;
    if (bigS >= 0) this.offer('size', bigS, big, scan, warm, out);
    if (oldS >= 0) this.offer('age', oldS, old / TICK_HZ, scan, warm, out);
    // sustained speed: lower of this run and the last, for ids in both top lists
    let fastS = -1; let fast = 0;
    const next = new Map<number, number>();
    for (const [v, s] of top) {
      const id = entityIdOf(w, s);
      next.set(id, v);
      const p = this.prevSpeed.get(id);
      if (p === undefined) continue;
      const sus = Math.min(v, p);
      if (sus > fast) { fast = sus; fastS = s; }
    }
    this.prevSpeed = next;
    if (fastS >= 0) this.offer('speed', fastS, fast, scan, warm, out);
  }

  private offer(kind: RecordKind, slot: number, value: number, scan: Scan, warm: boolean, out: Derived[]): void {
    const r = this.recs[kind];
    const w = scan.world; const c = w.cr.c; const t = scan.tick;
    const id = entityIdOf(w, slot);
    if (value <= r.value) return;
    const prev = r.value; const prevId = r.id;
    const sameHolder = id === r.id;
    r.value = value; r.id = id; r.species = c.species[slot]!;
    if (!warm || prev <= 0) { r.reported = value; return; }
    const g = sameHolder ? value / r.reported - 1 : value / prev - 1;
    const due = t - r.lastEmit >= this.o.cooldownS * TICK_HZ;
    // an ageing holder is not news (it ages one second per second); a growing or speeding one is, at bigGain
    const emit = sameHolder ? kind !== 'age' && g >= this.o.bigGain : g >= this.o.gain && (due || g >= this.o.bigGain);
    if (!emit) return;
    const before = sameHolder ? r.reported : prev;
    r.reported = value; r.lastEmit = t;
    out.push({
      k: 'record', kind, id, value, prev: before, species: c.species[slot]!, prevId, pos: [c.posX[slot]!, c.posY[slot]!],
      size: c.length[slot]!, novelty: Math.min(1, g / (2 * this.o.bigGain)), durationS: (t - c.birthTick[slot]!) / TICK_HZ,
    });
  }

  /** Current all-time values (for stats and tests). */
  current(): Record<RecordKind, { value: number; id: number }> {
    return { size: { ...this.recs.size }, speed: { ...this.recs.speed }, age: { ...this.recs.age } };
  }
}
