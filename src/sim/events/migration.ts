/**
 * Vertical migration (CONTRACT 11 `migration`): a species' mean depth moving by at least
 * `fraction` of the water column within `windowS`. Mean depths are sampled once per run, with
 * their tick, into a ring per species covering the window (at most 256 samples; at most
 * `maxSpecies` species tracked, the oldest dropped), so the cost is O(species) per run on top
 * of the shared scan and the window is in sim time whatever the run rate. After an event the baseline is
 * reset; a migration that keeps going in the same direction is reported again as an `update`.
 */
import { TICK_HZ, type V2 } from './util.js';
import type { Derived, Detector, Scan } from './types.js';

export interface MigrationOptions {
  /** Window in sim seconds. */
  windowS?: number;
  /** Minimum shift as a fraction of the water column. */
  fraction?: number;
  /** Members needed for a species to be followed. */
  minMembers?: number;
  /** Nominal seconds between runs (a window counts as filled from `windowS - everyS`). */
  everyS?: number;
  maxSpecies?: number;
}

interface Track { ys: number[]; ts: number[]; start: number; lastDir: 'up' | 'down' | null; lastTick: number; began: number }

export class MigrationDetector implements Detector {
  readonly name = 'migration';
  private readonly o: Required<MigrationOptions>;
  private readonly tracks = new Map<number, Track>();

  constructor(opts: MigrationOptions = {}) {
    this.o = { windowS: 60, fraction: 0.15, minMembers: 10, everyS: 1, maxSpecies: 512, ...opts };
  }

  run(scan: Scan, out: Derived[]): void {
    const w = scan.world;
    const H = w.preset.heightM - w.g.ySurface;
    const win = this.o.windowS * TICK_HZ;
    const filled = Math.max(1, (this.o.windowS - this.o.everyS) * TICK_HZ);
    for (const [sp, a] of scan.species) {
      if (a.n < this.o.minMembers) { this.tracks.delete(sp); continue; }
      let tr = this.tracks.get(sp);
      if (!tr) {
        if (this.tracks.size >= this.o.maxSpecies) this.tracks.delete(this.tracks.keys().next().value as number);
        tr = { ys: [], ts: [], start: scan.tick, lastDir: null, lastTick: -Infinity, began: scan.tick };
        this.tracks.set(sp, tr);
      }
      const y = a.sy / a.n;
      tr.ys.push(y); tr.ts.push(scan.tick);
      while (tr.ts.length > 1 && (scan.tick - tr.ts[0]! > win || tr.ts.length > 256)) { tr.ts.shift(); tr.ys.shift(); }
      if (scan.tick - tr.ts[0]! < filled) continue;
      const d = (y - tr.ys[0]!) / H;
      if (Math.abs(d) < this.o.fraction) {
        if (scan.tick - tr.lastTick > 2 * this.o.windowS * TICK_HZ) tr.lastDir = null;
        continue;
      }
      const direction = d < 0 ? 'up' : 'down';
      const cont = tr.lastDir === direction && scan.tick - tr.lastTick <= 2 * this.o.windowS * TICK_HZ;
      if (!cont) tr.began = tr.ts[0]!;
      const pos: V2 = [a.sx / a.n, y];
      out.push({
        k: 'migration', phase: cont ? 'update' : 'start', species: sp, direction, fraction: Math.abs(d), n: a.n,
        fromY: tr.ys[0]!, toY: y, pos, size: Math.abs(y - tr.ys[0]!), durationS: (scan.tick - tr.began) / TICK_HZ,
        novelty: cont ? 0.2 : Math.min(1, Math.abs(d) / (2 * this.o.fraction)),
      });
      tr.lastDir = direction; tr.lastTick = scan.tick;
      tr.ys = [y]; tr.ts = [scan.tick];
    }
    for (const sp of [...this.tracks.keys()]) if (!scan.species.has(sp)) this.tracks.delete(sp);
  }
}
