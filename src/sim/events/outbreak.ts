/**
 * Outbreaks and epidemic fronts (CONTRACT 11 `outbreak`, `epidemicFront`; 06 §6.2.2).
 *
 * Per (strain, host species): infected hosts (either infection slot), prevalence p among the
 * species' living members, sampled each run into a ring covering `windowS`. An outbreak starts
 * when p > `on`, its growth over the window > `growthPerMin` and at least `minInfected` hosts
 * are infected; it updates every `updateS` and ends when p < `off`. Centroid and RMS radius of
 * the infected hosts.
 *
 * Epidemic front: while an outbreak runs, the 90th percentile distance of infected hosts from
 * where it started is its reach. When the reach grows by at least `frontStepM` (and at most
 * every `frontEveryS`), a front event gives the mean position of the infected hosts beyond the
 * old reach, the new reach as its radius, the direction from the origin and the speed.
 *
 * Bounded: at most `maxPairs` (strain, host) pairs are followed, the largest first.
 */
import { NONE_U32, TICK_HZ, type V2 } from './util.js';
import { sq, type Derived, type Detector, type Scan } from './types.js';

export interface OutbreakOptions {
  on?: number;
  off?: number;
  growthPerMin?: number;
  minInfected?: number;
  windowS?: number;
  /** Nominal seconds between runs (unused by the rules, which are in sim time). */
  everyS?: number;
  updateS?: number;
  frontStepM?: number;
  frontEveryS?: number;
  maxPairs?: number;
}

interface Pair { strain: number; host: number; slots: number[] }
interface Active { first: number; lastUpdate: number; origin: V2; reach: number; lastFront: number; frontPos: V2 }

export class OutbreakDetector implements Detector {
  readonly name = 'outbreak';
  private readonly o: Required<OutbreakOptions>;
  private readonly hist = new Map<string, { t: number[]; p: number[] }>();
  private readonly active = new Map<string, Active>();
  private readonly ever = new Set<number>();

  constructor(opts: OutbreakOptions = {}) {
    this.o = {
      on: 0.15, off: 0.05, growthPerMin: 0.02, minInfected: 10, windowS: 30, everyS: 1, updateS: 10, frontStepM: 1,
      frontEveryS: 10, maxPairs: 64, ...opts,
    };
  }

  run(scan: Scan, out: Derived[]): void {
    const w = scan.world; const c = w.cr.c; const t = scan.tick;
    const pairs = new Map<string, Pair>();
    for (let i = 0; i < scan.nAlive; i++) {
      const s = scan.alive[i]!;
      const a = c.infStrain[2 * s]!; const b = c.infStrain[2 * s + 1]!;
      if (a === NONE_U32 && b === NONE_U32) continue;
      const host = c.species[s]!;
      for (const strain of a === b ? [a] : [a, b]) {
        if (strain === NONE_U32) continue;
        const key = `${strain}:${host}`;
        let p = pairs.get(key);
        if (!p) { p = { strain, host, slots: [] }; pairs.set(key, p); }
        p.slots.push(s);
      }
    }
    let list = [...pairs.entries()];
    list.sort((x, y) => y[1].slots.length - x[1].slots.length || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    if (list.length > this.o.maxPairs) list = list.slice(0, this.o.maxPairs);
    const win = this.o.windowS * TICK_HZ;
    const live = new Set<string>();
    for (const [key, p] of list) {
      live.add(key);
      const n = p.slots.length;
      const hosts = scan.species.get(p.host)?.n ?? n;
      const prev = Math.max(0, Math.min(1, n / Math.max(1, hosts)));
      let h = this.hist.get(key);
      if (!h) { h = { t: [], p: [] }; this.hist.set(key, h); }
      h.t.push(t); h.p.push(prev);
      while (h.t.length > 1 && (t - h.t[0]! > win || h.t.length > 256)) { h.t.shift(); h.p.shift(); }
      const span = (t - h.t[0]!) / TICK_HZ / 60;
      const growth = span > 0 ? (prev - h.p[0]!) / span : 0;
      let sx = 0; let sy = 0;
      for (const s of p.slots) { sx += c.posX[s]!; sy += c.posY[s]!; }
      const centroid: V2 = [sx / n, sy / n];
      let r2 = 0;
      for (const s of p.slots) r2 += sq(c.posX[s]! - centroid[0]) + sq(c.posY[s]! - centroid[1]);
      const radius = Math.sqrt(r2 / n);
      const a = this.active.get(key);
      const base = { strain: p.strain, host: p.host, prevalence: prev, growth, centroid, radius, infected: n, pos: centroid, size: radius };
      if (!a) {
        if (prev > this.o.on && growth > this.o.growthPerMin && n >= this.o.minInfected) {
          const first = !this.ever.has(p.strain);
          this.ever.add(p.strain);
          this.active.set(key, { first: t, lastUpdate: t, origin: centroid, reach: this.reach(scan, p.slots, centroid), lastFront: t, frontPos: centroid });
          out.push({ k: 'outbreak', phase: 'start', ...base, durationS: 0, novelty: first ? 1 : 0.4 });
        }
        continue;
      }
      if (prev < this.o.off) {
        this.active.delete(key);
        out.push({ k: 'outbreak', phase: 'end', ...base, durationS: (t - a.first) / TICK_HZ });
        continue;
      }
      if (t - a.lastUpdate >= this.o.updateS * TICK_HZ) {
        a.lastUpdate = t;
        out.push({ k: 'outbreak', phase: 'update', ...base, durationS: (t - a.first) / TICK_HZ });
      }
      // the front
      const reach = this.reach(scan, p.slots, a.origin);
      if (reach >= a.reach + this.o.frontStepM && t - a.lastFront >= this.o.frontEveryS * TICK_HZ) {
        let fx = 0; let fy = 0; let fn = 0;
        for (const s of p.slots) {
          const d = Math.sqrt(sq(c.posX[s]! - a.origin[0]) + sq(c.posY[s]! - a.origin[1]));
          if (d >= a.reach) { fx += c.posX[s]!; fy += c.posY[s]!; fn++; }
        }
        if (fn > 0) {
          const pos: V2 = [fx / fn, fy / fn];
          const dx = pos[0] - a.origin[0]; const dy = pos[1] - a.origin[1]; const dl = Math.sqrt(dx * dx + dy * dy) || 1;
          const speed = (reach - a.reach) / Math.max(1e-9, (t - a.lastFront) / TICK_HZ);
          out.push({
            k: 'epidemicFront', species: p.host, strain: p.strain, pos, radius: reach, speed, dir: [dx / dl, dy / dl],
            size: reach, durationS: (t - a.first) / TICK_HZ, novelty: Math.min(1, fn / n),
          });
          a.reach = reach; a.lastFront = t; a.frontPos = pos;
        }
      }
    }
    for (const [key, a] of [...this.active]) {
      if (live.has(key)) continue;
      this.active.delete(key);
      const [strain, host] = key.split(':').map(Number) as [number, number];
      out.push({ k: 'outbreak', phase: 'end', strain, host, prevalence: 0, growth: 0, centroid: a.origin, radius: 0, infected: 0, durationS: (t - a.first) / TICK_HZ });
    }
    for (const key of [...this.hist.keys()]) if (!live.has(key)) this.hist.delete(key);
    if (this.ever.size > 4096) this.ever.clear();
  }

  /** 90th percentile distance of the infected from `o`. */
  private reach(scan: Scan, slots: number[], o: V2): number {
    const c = scan.world.cr.c;
    const d = new Float64Array(slots.length);
    for (let i = 0; i < slots.length; i++) { const s = slots[i]!; d[i] = Math.sqrt(sq(c.posX[s]! - o[0]) + sq(c.posY[s]! - o[1])); }
    d.sort((a, b) => a - b);
    return d.length ? d[Math.min(d.length - 1, Math.floor(0.9 * d.length))]! : 0;
  }
}
