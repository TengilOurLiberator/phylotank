/**
 * Lineage stories: speciation and extinction as narratives (contract request EV2 `lineage`).
 *
 * The step already emits `speciation` and `extinction`; this detector keeps a small record per
 * species (parent, depth in the species tree, founding tick, peak population, the last death
 * causes, its daughters) and turns those primitive events into stories the director can tell:
 *
 * - `founded`: a new species, with how deep its line is and how long its parent had existed;
 * - `radiation`: a parent that has budded off at least `radiationMin` daughters within
 *   `radiationS` (an adaptive radiation), at most once per parent per window;
 * - `extinct`: a species gone, with its lifespan, peak, the commonest cause among its last deaths
 *   and how many daughter species survive it;
 * - `lineEnded`: the extinction also ended its whole line (no living descendant of the root
 *   ancestor), the end of a dynasty.
 *
 * Founders (species with no speciation event) are recorded lazily from the scan at depth 0.
 * Bounded: at most `maxSpecies` records (the oldest extinct first).
 */
import { TICK_HZ, type V2, type World } from './util.js';
import type { SimEvent } from '../../core/index.js';
import type { Derived, Detector, Scan } from './types.js';

export interface LineageOptions {
  radiationMin?: number;
  radiationS?: number;
  maxSpecies?: number;
  causeRing?: number;
}

interface SpRec {
  id: number; parent: number; root: number; depth: number; founded: number; peak: number; alive: boolean;
  daughters: number[]; causes: string[]; lastPos: V2; lastRadiation: number;
}

export class LineageDetector implements Detector {
  readonly name = 'lineage';
  private readonly o: Required<LineageOptions>;
  private readonly recs = new Map<number, SpRec>();

  constructor(opts: LineageOptions = {}) {
    this.o = { radiationMin: 3, radiationS: 600, maxSpecies: 4096, causeRing: 16, ...opts };
  }

  private rec(id: number, tick: number, parent = 0, pos: V2 = [0, 0]): SpRec {
    let r = this.recs.get(id);
    if (r) return r;
    const p = parent > 0 ? this.recs.get(parent) : undefined;
    r = {
      id, parent, root: p ? p.root : id, depth: p ? p.depth + 1 : 0, founded: tick, peak: 0, alive: true, daughters: [],
      causes: [], lastPos: pos, lastRadiation: -Infinity,
    };
    if (this.recs.size >= this.o.maxSpecies) this.evict();
    this.recs.set(id, r);
    if (p) p.daughters.push(id);
    return r;
  }

  private evict(): void {
    for (const [id, r] of this.recs) if (!r.alive) { this.recs.delete(id); return; }
    this.recs.delete(this.recs.keys().next().value as number);
  }

  observe(world: World, events: readonly SimEvent[], out: Derived[]): void {
    for (const e of events) {
      if (e.k === 'death') {
        const r = this.recs.get(e.species);
        if (r) { r.causes.push(e.cause); if (r.causes.length > this.o.causeRing) r.causes.shift(); r.lastPos = e.pos; }
      } else if (e.k === 'speciation') {
        const parent = this.rec(e.parent, e.t);
        const r = this.rec(e.child, e.t, e.parent, e.pos);
        r.lastPos = e.pos;
        out.push({
          k: 'lineage', story: 'founded', species: e.child, parent: e.parent, depth: r.depth, pos: e.pos, peak: 0, descendants: 0,
          daughters: parent.daughters.length, durationS: (e.t - parent.founded) / TICK_HZ, size: 0, novelty: Math.min(1, 0.3 + 0.1 * r.depth),
        });
        const recent = parent.daughters.filter((d) => { const x = this.recs.get(d); return x !== undefined && e.t - x.founded <= this.o.radiationS * TICK_HZ; });
        if (recent.length >= this.o.radiationMin && e.t - parent.lastRadiation >= this.o.radiationS * TICK_HZ) {
          parent.lastRadiation = e.t;
          out.push({
            k: 'lineage', story: 'radiation', species: e.parent, parent: parent.parent, depth: parent.depth, pos: e.pos, peak: parent.peak,
            descendants: this.livingDescendants(parent.id), daughters: recent.length, durationS: (e.t - this.recs.get(recent[0]!)!.founded) / TICK_HZ,
            size: 0, novelty: Math.min(1, recent.length / (2 * this.o.radiationMin)),
          });
        }
      } else if (e.k === 'extinction') {
        const r = this.rec(e.species, e.t, 0, e.pos);
        r.alive = false;
        const pos = e.pos ?? r.lastPos;
        const desc = this.livingDescendants(r.id);
        const cause = this.commonest(r.causes);
        const base = { species: r.id, parent: r.parent, depth: r.depth, pos, peak: r.peak, descendants: desc, durationS: (e.t - r.founded) / TICK_HZ, size: 0 };
        out.push({ k: 'lineage', story: 'extinct', ...base, ...(cause ? { cause } : {}), novelty: desc === 0 ? 0.6 : 0.3 });
        if (desc === 0 && this.livingDescendants(r.root) === 0 && !(this.recs.get(r.root)?.alive)) {
          out.push({ k: 'lineage', story: 'lineEnded', ...base, ...(cause ? { cause } : {}), novelty: 1 });
        }
      }
    }
    void world;
  }

  run(scan: Scan): void {
    for (const [sp, a] of scan.species) {
      const r = this.rec(sp, scan.tick, 0, [a.sx / a.n, a.sy / a.n]);
      r.alive = true;
      if (a.n > r.peak) r.peak = a.n;
      r.lastPos = [a.sx / a.n, a.sy / a.n];
    }
  }

  /** Living species descended from `id` (not counting itself). Bounded by the record count. */
  livingDescendants(id: number): number {
    let n = 0; const stack = [...(this.recs.get(id)?.daughters ?? [])]; let guard = 0;
    while (stack.length && guard++ < this.o.maxSpecies) {
      const d = stack.pop()!; const r = this.recs.get(d);
      if (!r) continue;
      if (r.alive) n++;
      stack.push(...r.daughters);
    }
    return n;
  }

  depthOf(id: number): number { return this.recs.get(id)?.depth ?? 0; }

  private commonest(causes: string[]): string | undefined {
    const m = new Map<string, number>();
    for (const c of causes) m.set(c, (m.get(c) ?? 0) + 1);
    let best: string | undefined; let bn = 0;
    for (const [c, n] of [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (n > bn) { bn = n; best = c; }
    return best;
  }
}
