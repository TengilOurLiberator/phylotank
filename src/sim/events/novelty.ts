/**
 * Novelty: a body plan never seen before (CONTRACT 11 `novelty`, 06 §6.2.2).
 *
 * Each new adult genome is described once by its developed body: part count, tree depth,
 * distinct part kinds, counts of each organ, log size and aspect. The descriptor is compared with
 * a bounded archive of earlier plans (novelty search, Lehman and Stanley 2011): its sparseness is
 * the mean distance to its `k` nearest archived plans. Above `rho`, with its nearest archived
 * plan more than `rho / 2` away, it is news (`novelty` event with a new morph cluster); above
 * `rho / 2` (nearest more than `rho / 4` away) it joins the archive, so near copies are not news
 * again. `rho` adapts so the detector fires about `targetPerHour` times an hour: it rises by 25%
 * after an event that comes sooner than the target interval and falls by 10% for each target
 * interval without one, never below `rhoFloor`.
 *
 * Bounded: at most `perRun` new genomes are described per run (slot order, the rest next run),
 * the archive holds `archiveMax` plans (oldest out) and the set of described genomes (by
 * content key, so a reused store handle is described again) is capped at `seenMax`.
 */
import { exp, LN2, ORGAN, log, type World } from '../../core/index.js';
import { BoundedMap, entityIdOf, TICK_HZ } from './util.js';
import { hasState, stateOf } from '../state.js';
import type { Derived, Detector, Scan } from './types.js';

export interface NoveltyOptions {
  k?: number;
  rho?: number;
  rhoFloor?: number;
  targetPerHour?: number;
  perRun?: number;
  archiveMax?: number;
  seenMax?: number;
  /** Sim seconds during which plans only fill the archive (the founders set the baseline). */
  warmupS?: number;
}

/** Organ bits counted in the descriptor, in order. */
const ORGANS = [ORGAN.EYE, ORGAN.MOUTH, ORGAN.CLAW, ORGAN.JET, ORGAN.CILIA, ORGAN.PHOTOPHORE, ORGAN.SHELL, ORGAN.PHOTOSYNTH, ORGAN.CHEMO, ORGAN.LATERAL_LINE, ORGAN.BLADDER, ORGAN.PAIRED] as const;
const ORGAN_NAMES: readonly [string, string][] = [
  ['eye', 'eyes'], ['mouth', 'mouths'], ['claw', 'claws'], ['jet', 'jets'], ['ciliated part', 'ciliated parts'], ['light organ', 'light organs'],
  ['shell', 'shells'], ['photosynthetic part', 'photosynthetic parts'], ['chemosensor', 'chemosensors'], ['lateral line', 'lateral lines'],
  ['bladder', 'bladders'], ['paired limb', 'paired limbs'],
];
export const DESCRIPTOR_LEN = 4 + ORGANS.length + 1;

/** The body-plan descriptor of a slot (exported for tests). */
export function describe(world: World, slot: number, out = new Float64Array(DESCRIPTOR_LEN)): Float64Array {
  const c = world.cr.c; const sg = world.seg.c;
  const n = c.segCount[slot]!; const s0 = c.segStart[slot]!;
  const depth = new Int32Array(Math.max(1, n));
  let maxDepth = 0; let kinds = 0; let seenKinds = 0n; let maxR = 0; let sumLen = 0;
  const organCounts = new Int32Array(ORGANS.length);
  for (let k = 0; k < n; k++) {
    const g = s0 + k;
    const p = sg.parent[g]!;
    depth[k] = p >= 0 && p < k ? depth[p]! + 1 : 0;
    if (depth[k]! > maxDepth) maxDepth = depth[k]!;
    const bit = 1n << BigInt(sg.kind[g]! & 63);
    if ((seenKinds & bit) === 0n) { seenKinds |= bit; kinds++; }
    const org = sg.organs[g]!;
    for (let i = 0; i < ORGANS.length; i++) if ((org & ORGANS[i]!) !== 0) organCounts[i]!++;
    maxR = Math.max(maxR, sg.radius[g]!);
    if (depth[k] === 0 || p === 0) sumLen += sg.len[g]!;
  }
  const L = Math.max(1e-4, c.adultLength[slot]! || c.length[slot]!);
  const lg = (x: number): number => log(1 + x) / log(2);
  out[0] = lg(n); out[1] = lg(maxDepth); out[2] = lg(kinds);
  out[3] = log(L / 1e-3) / log(10); // decades above 1 mm
  for (let i = 0; i < ORGANS.length; i++) out[4 + i] = lg(organCounts[i]!);
  out[4 + ORGANS.length] = maxR > 0 ? lg(Math.max(sumLen, L) / (2 * maxR)) / 2 : 0;
  return out;
}

/** A short human description of a plan (captions). */
export function planText(d: Float64Array): string {
  const inv = (v: number): number => Math.round(exp(v * LN2) - 1);
  const parts = [`${inv(d[0]!)} part${inv(d[0]!) === 1 ? '' : 's'}`];
  for (let i = 0; i < ORGANS.length; i++) { const k = inv(d[4 + i]!); if (k > 0) parts.push(`${k} ${ORGAN_NAMES[i]![k === 1 ? 0 : 1]}`); }
  return parts.slice(0, 5).join(', ');
}

function dist(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i]! - b[i]!; s += d * d; }
  return Math.sqrt(s);
}

interface Entry { d: Float64Array; cluster: number }

/** The genome's content key, or its handle when the store does not know it (staged worlds). */
function keyOf(store: { key(h: number): bigint } | null, handle: number): number | bigint {
  if (!store || handle === 0xffffffff) return handle;
  try { return store.key(handle); } catch { return handle; }
}

export class NoveltyDetector implements Detector {
  readonly name = 'novelty';
  private readonly o: Required<NoveltyOptions>;
  private readonly archive: Entry[] = [];
  private readonly seen: BoundedMap<number | bigint, true>;
  rho: number;
  private lastEvent = -1;
  private lastDecay = -1;
  private firstTick = -1;
  private nextCluster = 1;

  constructor(opts: NoveltyOptions = {}) {
    this.o = { k: 15, rho: 1.5, rhoFloor: 0.5, targetPerHour: 2, perRun: 32, archiveMax: 512, seenMax: 8192, warmupS: 60, ...opts };
    this.seen = new BoundedMap(this.o.seenMax);
    this.rho = this.o.rho;
  }

  archiveSize(): number { return this.archive.length; }

  run(scan: Scan, out: Derived[]): void {
    const w = scan.world; const c = w.cr.c; const t = scan.tick;
    if (this.firstTick < 0) { this.firstTick = t; this.lastDecay = t; }
    const interval = (3600 / this.o.targetPerHour) * TICK_HZ;
    if (t - this.lastDecay >= interval && t - this.lastEvent >= interval) { this.rho = Math.max(this.o.rhoFloor, this.rho * 0.9); this.lastDecay = t; }
    const warm = t - this.firstTick >= this.o.warmupS * TICK_HZ;
    const store = hasState(w) ? stateOf(w).store : null;
    let done = 0;
    for (let i = 0; i < scan.nAlive && done < this.o.perRun; i++) {
      const s = scan.alive[i]!;
      if (c.maturity[s]! < 0.99) continue;
      // the genome's content key when the sim's store is there (handles can be reused), else the handle
      const handle = c.genome[s]!;
      const h = keyOf(store, handle);
      if (this.seen.has(h)) continue;
      this.seen.set(h, true);
      done++;
      const d = describe(w, s);
      const [sparse, nearest, nd] = this.sparseness(d);
      if (this.archive.length === 0 || (sparse > this.rho / 2 && nd > this.rho / 4)) {
        const nearCluster = nearest >= 0 ? this.archive[nearest]!.cluster : 0;
        const novel = warm && this.archive.length > 0 && sparse > this.rho && nd > this.rho / 2;
        const cluster = novel || nearest < 0 ? this.nextCluster++ : nearCluster;
        if (this.archive.length >= this.o.archiveMax) this.archive.shift();
        this.archive.push({ d, cluster });
        if (novel) {
          out.push({
            k: 'novelty', id: entityIdOf(w, s), species: c.species[s]!, morphCluster: cluster, distance: sparse,
            nearest: nearCluster, plan: planText(d),
            pos: [c.posX[s]!, c.posY[s]!], size: c.length[s]!, novelty: Math.min(1, sparse / (2 * this.rho)),
            durationS: (t - c.birthTick[s]!) / TICK_HZ,
          });
          if (this.lastEvent >= 0 && t - this.lastEvent < interval) this.rho *= 1.25;
          this.lastEvent = t; this.lastDecay = t;
        }
      }
    }
  }

  /** Mean distance to the k nearest archived plans, the index of the nearest and its distance. */
  private sparseness(d: Float64Array): [number, number, number] {
    const n = this.archive.length;
    if (n === 0) return [Infinity, -1, Infinity];
    const k = Math.min(this.o.k, n);
    const best = new Float64Array(k).fill(Infinity);
    let nearest = -1; let nd = Infinity;
    for (let i = 0; i < n; i++) {
      const x = dist(d, this.archive[i]!.d);
      if (x < nd) { nd = x; nearest = i; }
      if (x < best[k - 1]!) {
        let j = k - 1;
        while (j > 0 && best[j - 1]! > x) { best[j] = best[j - 1]!; j--; }
        best[j] = x;
      }
    }
    let s = 0; for (let i = 0; i < k; i++) s += best[i]!;
    return [s / k, nearest, nd];
  }
}
