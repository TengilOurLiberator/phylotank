/**
 * Plankton blooms and bloom fronts (CONTRACT 11 `bloomFront`, plus the `bloom` region story of
 * contract request EV2). The fine phytoplankton grid `qP` is summed into a fixed block grid
 * (32 x 18 blocks on every preset: 1 m on Small, 2 m on Default, 4 m on Large), so the cost is
 * one pass over the fine grid and O(blocks) after it, whatever the population.
 *
 * A block is hot when its plankton is at least `factor` times its own slow baseline (an EMA
 * with time constant `tauS`) and at least `overMean` times the tank mean, so the day cycle,
 * which lifts every block together, does not count. Hot blocks join into 4-connected regions;
 * a region of at least `minBlocks` is a bloom (start, update every `updateS`, end). When a
 * tracked bloom takes in at least `frontBlocks` new blocks, a `bloomFront` reports where it is
 * advancing: the centroid of the new blocks, their radius, mean strength, the direction of
 * advance and its speed.
 */
import { TICK_HZ, type V2, type World } from './util.js';
import { sq, type Derived, type Detector, type Scan } from './types.js';

export interface BloomOptions {
  blocksW?: number;
  blocksH?: number;
  factor?: number;
  overMean?: number;
  tauS?: number;
  minBlocks?: number;
  frontBlocks?: number;
  frontEveryS?: number;
  updateS?: number;
  everyS?: number;
  warmupRuns?: number;
  maxRegions?: number;
}

interface Region { id: number; blocks: Set<number>; first: number; lastUpdate: number; lastFront: number; frontPos: V2; centroid: V2 }

export class BloomDetector implements Detector {
  readonly name = 'bloom';
  private readonly o: Required<BloomOptions>;
  private sums = new Float64Array(0);
  private ema = new Float64Array(0);
  private colBlock = new Int32Array(0);
  private runs = 0;
  private regions: Region[] = [];
  private nextId = 1;

  constructor(opts: BloomOptions = {}) {
    this.o = {
      blocksW: 32, blocksH: 18, factor: 2, overMean: 1.5, tauS: 120, minBlocks: 3, frontBlocks: 2, frontEveryS: 10,
      updateS: 30, everyS: 1, warmupRuns: 5, maxRegions: 16, ...opts,
    };
  }

  /** Block sums of the fine plankton grid (exposed for tests). */
  sumBlocks(world: World): Float64Array {
    const [fw, fh] = world.fields.fine;
    const bw = this.o.blocksW; const bh = this.o.blocksH;
    if (this.sums.length !== bw * bh) { this.sums = new Float64Array(bw * bh); this.ema = new Float64Array(bw * bh); this.runs = 0; }
    if (this.colBlock.length !== fw) {
      this.colBlock = new Int32Array(fw);
      for (let ix = 0; ix < fw; ix++) this.colBlock[ix] = Math.min(bw - 1, Math.floor((ix * bw) / fw));
    }
    const q = world.fields.qP;
    const sums = this.sums; sums.fill(0);
    for (let iy = 0; iy < fh; iy++) {
      const row = Math.min(bh - 1, Math.floor((iy * bh) / fh)) * bw;
      const base = iy * fw;
      for (let ix = 0; ix < fw; ix++) sums[row + this.colBlock[ix]!]! += q[base + ix]!;
    }
    return sums;
  }

  run(scan: Scan, out: Derived[]): void {
    const w = scan.world; const t = scan.tick;
    const sums = this.sumBlocks(w);
    const bw = this.o.blocksW; const bh = this.o.blocksH; const nb = bw * bh;
    const ema = this.ema;
    const a = Math.min(1, this.o.everyS / this.o.tauS);
    if (this.runs++ === 0) { ema.set(sums); return; }
    let total = 0;
    for (let i = 0; i < nb; i++) total += sums[i]!;
    const mean = total / nb;
    const hot = new Uint8Array(nb);
    const warm = this.runs > this.o.warmupRuns;
    for (let i = 0; i < nb; i++) {
      const s = sums[i]!;
      const isHot = warm && s > 0 && s >= this.o.factor * ema[i]! && s >= this.o.overMean * mean;
      hot[i] = isHot ? 1 : 0;
      ema[i] = ema[i]! + (isHot ? a / 4 : a) * (s - ema[i]!);
    }
    if (!warm) return;
    // 4-connected components in index order
    const comp = new Int32Array(nb).fill(-1);
    const comps: number[][] = [];
    const stack: number[] = [];
    for (let i = 0; i < nb; i++) {
      if (!hot[i] || comp[i]! >= 0) continue;
      const id = comps.length; const list: number[] = [];
      comp[i] = id; stack.push(i);
      while (stack.length) {
        const b = stack.pop()!; list.push(b);
        const bx = b % bw; const by = (b - bx) / bw;
        const nbrs = [bx > 0 ? b - 1 : -1, bx < bw - 1 ? b + 1 : -1, by > 0 ? b - bw : -1, by < bh - 1 ? b + bw : -1];
        for (const o of nbrs) if (o >= 0 && hot[o] && comp[o]! < 0) { comp[o] = id; stack.push(o); }
      }
      list.sort((x, y) => x - y);
      comps.push(list);
    }
    const bm = w.preset.widthM / bw; const bhm = w.preset.heightM / bh;
    const centre = (blocks: number[]): V2 => {
      let sx = 0; let sy = 0; let sw = 0;
      for (const b of blocks) { const m = Math.max(1e-9, sums[b]!); const bx = b % bw; sx += m * (bx + 0.5) * bm; sy += m * ((b - bx) / bw + 0.5) * bhm; sw += m; }
      return [sx / sw, sy / sw];
    };
    const strengthOf = (blocks: number[]): number => {
      let s = 0; let e = 0;
      for (const b of blocks) { s += sums[b]!; e += ema[b]!; }
      return e > 0 ? s / e : this.o.factor;
    };
    const matched = new Set<Region>();
    for (const blocks of comps) {
      // the tracked region with the largest overlap
      let best: Region | null = null; let bestN = 0;
      for (const r of this.regions) {
        if (matched.has(r)) continue;
        let n = 0; for (const b of blocks) if (r.blocks.has(b)) n++;
        if (n > bestN) { bestN = n; best = r; }
      }
      const pos = centre(blocks);
      const areaM2 = blocks.length * bm * bhm;
      const radius = Math.sqrt(areaM2 / Math.PI);
      const strength = strengthOf(blocks);
      if (!best) {
        if (blocks.length < this.o.minBlocks || this.regions.length >= this.o.maxRegions) continue;
        const r: Region = { id: this.nextId++, blocks: new Set(blocks), first: t, lastUpdate: t, lastFront: t, frontPos: pos, centroid: pos };
        this.regions.push(r); matched.add(r);
        out.push({ k: 'bloom', phase: 'start', pos, radius, strength, areaM2, size: radius, durationS: 0, novelty: Math.min(1, strength / (2 * this.o.factor)) });
        continue;
      }
      matched.add(best);
      const fresh = blocks.filter((b) => !best!.blocks.has(b));
      if (fresh.length >= this.o.frontBlocks && t - best.lastFront >= this.o.frontEveryS * TICK_HZ) {
        const fp = centre(fresh);
        const dx = fp[0] - best.centroid[0]; const dy = fp[1] - best.centroid[1];
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const dt = (t - best.lastFront) / TICK_HZ;
        const mv = Math.sqrt(sq(fp[0] - best.frontPos[0]) + sq(fp[1] - best.frontPos[1]));
        const fr = Math.sqrt((fresh.length * bm * bhm) / Math.PI);
        out.push({
          k: 'bloomFront', pos: fp, radius: fr, strength: strengthOf(fresh), dir: [dx / d, dy / d], speed: mv / Math.max(dt, 1e-9),
          size: fr, durationS: (t - best.first) / TICK_HZ, novelty: Math.min(1, fresh.length / Math.max(1, blocks.length)),
        });
        best.lastFront = t; best.frontPos = fp;
      }
      if (t - best.lastUpdate >= this.o.updateS * TICK_HZ) {
        best.lastUpdate = t;
        out.push({ k: 'bloom', phase: 'update', pos, radius, strength, areaM2, size: radius, durationS: (t - best.first) / TICK_HZ });
      }
      best.blocks = new Set(blocks); best.centroid = pos;
    }
    for (const r of [...this.regions]) {
      if (matched.has(r)) continue;
      this.regions.splice(this.regions.indexOf(r), 1);
      out.push({ k: 'bloom', phase: 'end', pos: r.centroid, radius: 0, strength: 0, areaM2: 0, size: 0, durationS: (t - r.first) / TICK_HZ });
    }
  }
}
