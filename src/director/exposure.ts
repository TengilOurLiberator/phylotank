/**
 * Exposure memory (06 §6.2.4): seconds of prominent screen time per entity, species, story type
 * and region cell, each decaying with its own half-life. Lazily decayed; bounded by pruning.
 */
import { exp, LN2 } from '../core/index.js';

class DecayMap<K> {
  private readonly m = new Map<K, { v: number; t: number }>();
  private readonly k: number;
  constructor(halfLifeS: number) { this.k = LN2 / halfLifeS; }
  get(key: K, now: number): number {
    const e = this.m.get(key);
    if (!e) return 0;
    return e.v * exp(-this.k * (now - e.t));
  }
  add(key: K, amount: number, now: number): void {
    const e = this.m.get(key);
    if (!e) { this.m.set(key, { v: amount, t: now }); return; }
    e.v = e.v * exp(-this.k * (now - e.t)) + amount;
    e.t = now;
  }
  private it: Iterator<[K, { v: number; t: number }]> | null = null;
  /** Amortised pruning: look at up to n entries, resuming where the last call stopped. */
  prune(now: number, below: number, n = 64): void {
    for (let i = 0; i < n; i++) {
      if (!this.it) this.it = this.m.entries();
      const r = this.it.next();
      if (r.done) { this.it = null; return; }
      const [key, e] = r.value;
      if (e.v * exp(-this.k * (now - e.t)) < below) this.m.delete(key);
    }
  }
  get size(): number { return this.m.size; }
}

export interface ExposureConfig {
  halfLife: { entity: number; species: number; type: number; region: number };
  beta: { entity: number; species: number; type: number; region: number };
  regionCellM: number;
}

export class ExposureMemory {
  readonly entity: DecayMap<number>;
  readonly species: DecayMap<number>;
  readonly type: DecayMap<string>;
  readonly region: DecayMap<number>;
  constructor(readonly cfg: ExposureConfig) {
    this.entity = new DecayMap(cfg.halfLife.entity);
    this.species = new DecayMap(cfg.halfLife.species);
    this.type = new DecayMap(cfg.halfLife.type);
    this.region = new DecayMap(cfg.halfLife.region);
  }
  regionKey(x: number, y: number): number {
    const c = this.cfg.regionCellM;
    return (Math.floor(x / c) + 512) * 4096 + Math.floor(y / c) + 512;
  }
  /** Novelty factor N for a story (Ee and Es are maxima over its subjects and species). */
  novelty(subjects: readonly number[], species: readonly number[], type: string, x: number, y: number, now: number): number {
    let ee = 0;
    for (let i = 0; i < subjects.length && i < 2; i++) ee = Math.max(ee, this.entity.get(subjects[i]!, now));
    let es = 0;
    for (const sp of species) es = Math.max(es, this.species.get(sp, now));
    const et = this.type.get(type, now);
    const er = this.region.get(this.regionKey(x, y), now);
    const b = this.cfg.beta;
    return exp(-(b.entity * ee + b.species * es + b.type * et + b.region * er));
  }
  /** Region exposure in [0, 1) for idle-drift waypoint choice. */
  regionLoad(x: number, y: number, now: number): number {
    const er = this.region.get(this.regionKey(x, y), now);
    return 1 - exp(-this.cfg.beta.region * er * 4);
  }
  prune(now: number): void {
    this.entity.prune(now, 0.05);
    this.species.prune(now, 0.05);
    this.type.prune(now, 0.05);
    this.region.prune(now, 0.05);
  }
}
