/**
 * The shared scan: one O(N) pass over the creature pool per detector run, reused by every
 * detector (alive and carcass lists, a counting-sorted grid, per-species aggregates). Buffers
 * are kept between runs, so a run allocates only the species map.
 */
import { LIFE, type World } from '../../core/index.js';
import type { Scan, SpeciesAgg } from './types.js';

export class Scanner {
  private alive = new Int32Array(0);
  private carcass = new Int32Array(0);
  private cellStart = new Int32Array(0);
  private cellItems = new Int32Array(0);
  private cellOf = new Int32Array(0);
  private lens = new Float64Array(0);
  private fill = new Int32Array(0);

  constructor(readonly cellM = 1) {}

  scan(world: World): Scan {
    const c = world.cr.c;
    const hw = world.cr.highWater;
    if (this.alive.length < hw) {
      this.alive = new Int32Array(hw); this.carcass = new Int32Array(hw);
      this.cellItems = new Int32Array(hw); this.cellOf = new Int32Array(hw); this.lens = new Float64Array(hw);
    }
    const cellM = this.cellM;
    const gw = Math.max(1, Math.ceil(world.preset.widthM / cellM));
    const gh = Math.max(1, Math.ceil(world.preset.heightM / cellM));
    if (this.cellStart.length !== gw * gh + 1) this.cellStart = new Int32Array(gw * gh + 1);
    const start = this.cellStart; start.fill(0);
    const species = new Map<number, SpeciesAgg>();
    let nA = 0; let nC = 0; let nL = 0;
    for (let s = 0; s < hw; s++) {
      const life = c.life[s]!;
      if (life === LIFE.CARCASS) { this.carcass[nC++] = s; continue; }
      if (life !== LIFE.ALIVE) continue;
      this.alive[nA] = s;
      const x = c.posX[s]!; const y = c.posY[s]!;
      const gx = Math.min(gw - 1, Math.max(0, Math.floor(x / cellM)));
      const gy = Math.min(gh - 1, Math.max(0, Math.floor(y / cellM)));
      const k = gy * gw + gx;
      this.cellOf[nA] = k;
      start[k + 1]!++;
      nA++;
      const sp = c.species[s]!;
      let a = species.get(sp);
      if (!a) { a = { n: 0, adults: 0, sx: 0, sy: 0, maxLen: 0, first: s }; species.set(sp, a); }
      a.n++; a.sx += x; a.sy += y;
      const L = c.length[s]!;
      if (L > a.maxLen) a.maxLen = L;
      if (c.maturity[s]! >= 0.99) { a.adults++; this.lens[nL++] = L; }
    }
    for (let k = 0; k < gw * gh; k++) start[k + 1]! += start[k]!;
    if (this.fill.length !== gw * gh) this.fill = new Int32Array(gw * gh);
    const fill = this.fill; fill.fill(0);
    for (let i = 0; i < nA; i++) {
      const k = this.cellOf[i]!;
      this.cellItems[start[k]! + fill[k]!] = this.alive[i]!;
      fill[k]!++;
    }
    let median = 0;
    if (nL > 0) {
      const l = this.lens.subarray(0, nL);
      l.sort((a, b) => a - b);
      median = l[nL >> 1]!;
    }
    return {
      world, tick: world.g.tick, alive: this.alive, nAlive: nA, carcass: this.carcass, nCarcass: nC,
      cellM, gw, gh, cellStart: start, cellItems: this.cellItems, species, medianAdultM: median,
    };
  }
}

/**
 * Visit ALIVE slots within `r` of (x, y), in (cell, slot) order. Returns the count; `visit`
 * may be omitted to count only.
 */
export function forNear(scan: Scan, x: number, y: number, r: number, visit?: (slot: number) => void): number {
  const c = scan.world.cr.c;
  const m = scan.cellM;
  const x0 = Math.max(0, Math.floor((x - r) / m)); const x1 = Math.min(scan.gw - 1, Math.floor((x + r) / m));
  const y0 = Math.max(0, Math.floor((y - r) / m)); const y1 = Math.min(scan.gh - 1, Math.floor((y + r) / m));
  const r2 = r * r;
  let n = 0;
  for (let gy = y0; gy <= y1; gy++) {
    for (let gx = x0; gx <= x1; gx++) {
      const k = gy * scan.gw + gx;
      for (let i = scan.cellStart[k]!; i < scan.cellStart[k + 1]!; i++) {
        const s = scan.cellItems[i]!;
        const dx = c.posX[s]! - x; const dy = c.posY[s]! - y;
        if (dx * dx + dy * dy > r2) continue;
        n++;
        if (visit) visit(s);
      }
    }
  }
  return n;
}
