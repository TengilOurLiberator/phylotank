/**
 * Host detectors (CONTRACT 11, DESIGN R19): derived events for the director, stats and audio.
 * They read world state and primitive events and never write sim state, so they may use any
 * arithmetic. Windows are in sim ticks, so the same world and events give the same output.
 *
 * Here: giant, endangered, extinction, massDeath, hunt (from bites and kills) and school
 * (same-species groups with aligned headings, from a 1 m grid). The rest of CONTRACT 11 comes
 * from the sim's event suite (`src/sim/events`, docs/modules/events.md), run on the same
 * timer: carcass (whale falls) and frenzy, migration, bloom and bloomFront, record (size, speed,
 * age), novelty, outbreak and epidemicFront, newRole and the lineage stories. Pass a `clock`
 * to have the suite measure its cost per detector (`costs()`).
 */
import { G_REL, LIFE, TICK_HZ, type SimEvent, type V2, type World } from '../core/index.js';
import { entityId } from './interest.js';
import { EventSuite, type DetectorCost, type SuiteOptions } from '../sim/events/index.js';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type DerivedEvent = DistOmit<SimEvent, 'eid' | 'epoch' | 't'>;
type Out = DerivedEvent;

interface SpeciesSeen { count: number; peak: number; endangered: boolean; lastId: number; lastPos: V2; meanY: number[] }

export interface DetectorOptions {
  /** Sim ticks between runs of the state detectors (1 s at 1x). */
  every?: number;
  endangeredBelow?: number;
  endangeredFrom?: number;
  massDeathWindowTicks?: number;
  massDeathMin?: number;
  huntTimeoutTicks?: number;
  migrationWindowTicks?: number;
  migrationFraction?: number;
  schoolMin?: number;
  schoolPolarisation?: number;
  frenzyMin?: number;
  /** Carcasses at least this fraction of L_ceiling are reported. */
  carcassRel?: number;
  /** Wall clock (ms) for the suite's cost accounting. */
  clock?: () => number;
  /** Further options for the event suite. */
  suite?: SuiteOptions;
}

export class Detectors {
  private readonly o: Required<Omit<DetectorOptions, 'clock' | 'suite'>>;
  readonly suite: EventSuite;
  private giants = new Set<number>();
  private species = new Map<number, SpeciesSeen>();
  private deaths: { tick: number; pos: V2 }[] = [];
  private windowCounts: number[] = [];
  private lastMassDeath = -Infinity;
  private hunts = new Map<string, { pred: number; prey: number; start: number; last: number; pos: V2 }>();
  private lastRun = -Infinity;
  private schools = new Map<number, { centroid: V2; lastUpdate: number }>();

  constructor(opts: DetectorOptions = {}) {
    const { clock, suite, ...rest } = opts;
    this.o = {
      every: TICK_HZ, endangeredBelow: 5, endangeredFrom: 10, massDeathWindowTicks: 10 * TICK_HZ, massDeathMin: 10,
      huntTimeoutTicks: 10 * TICK_HZ, migrationWindowTicks: 60 * TICK_HZ, migrationFraction: 0.15,
      schoolMin: 8, schoolPolarisation: 0.7, frenzyMin: 5, carcassRel: 0.25, ...rest,
    };
    const everyS = this.o.every / TICK_HZ;
    this.suite = new EventSuite({
      every: this.o.every, ...(clock ? { clock } : {}), ...suite,
      carcass: { carcassRel: this.o.carcassRel, frenzyMin: this.o.frenzyMin, ...suite?.carcass },
      migration: { windowS: this.o.migrationWindowTicks / TICK_HZ, fraction: this.o.migrationFraction, everyS, ...suite?.migration },
    });
  }

  /** Measured cost of the event suite per detector (empty without a clock). */
  costs(): DetectorCost[] { return this.suite.costs(); }

  /** Feed primitive events from the step. Returns derived events they complete. */
  onPrimitive(world: World, evs: readonly SimEvent[]): Out[] {
    const out: Out[] = [];
    for (const e of evs) {
      if (e.k === 'death') {
        this.deaths.push({ tick: e.t, pos: e.pos });
        if (e.killer !== undefined) {
          const key = `${e.killer}:${e.id}`;
          const h = this.hunts.get(key);
          if (h) { out.push({ k: 'hunt', phase: 'end', pred: h.pred, prey: h.prey, pos: e.pos, outcome: 'kill' }); this.hunts.delete(key); }
        }
        for (const [key, h] of this.hunts) if (h.pred === e.id || h.prey === e.id) this.hunts.delete(key);
      } else if (e.k === 'bite') {
        const key = `${e.attacker}:${e.target}`;
        const h = this.hunts.get(key);
        if (h) h.last = e.t;
        else { this.hunts.set(key, { pred: e.attacker, prey: e.target, start: e.t, last: e.t, pos: e.pos }); out.push({ k: 'hunt', phase: 'start', pred: e.attacker, prey: e.target, pos: e.pos }); }
      }
    }
    out.push(...(this.suite.observe(world, evs) as unknown as Out[]));
    return out;
  }

  /** Run the state detectors if due. */
  run(world: World): Out[] {
    const t = world.g.tick;
    if (t - this.lastRun < this.o.every) return [];
    this.lastRun = t;
    const out: Out[] = [];
    const c = world.cr.c;
    const counts = new Map<number, { n: number; id: number; pos: V2; ySum: number }>();
    const lengths: number[] = [];
    for (let s = 0; s < world.cr.highWater; s++) {
      if (c.life[s] !== LIFE.ALIVE) continue;
      const len = c.length[s]!;
      if (c.maturity[s]! >= 0.99) lengths.push(len); // the percentile rule counts adults only
      const sp = c.species[s]!;
      const row = counts.get(sp) ?? { n: 0, id: 0, pos: [0, 0] as V2, ySum: 0 };
      row.n++; row.id = entityId(world, s); row.pos = [c.posX[s]!, c.posY[s]!]; row.ySum += c.posY[s]!;
      counts.set(sp, row);
    }
    // giants: relative to the ceiling, or above the 99.5th percentile of enough adults (CONTRACT 3.3)
    lengths.sort((a, b) => a - b);
    const p995 = lengths.length >= 200 ? lengths[Math.floor(lengths.length * 0.995)]! : Infinity;
    for (let s = 0; s < world.cr.highWater; s++) {
      if (c.life[s] !== LIFE.ALIVE) continue;
      const len = c.length[s]!;
      if (len < G_REL * world.lCeilingM && len < p995) continue;
      const id = entityId(world, s);
      if (this.giants.has(id)) continue;
      this.giants.add(id);
      const below = lengths.findIndex((x) => x >= len);
      out.push({ k: 'giant', id, species: c.species[s]!, size: len, percentile: lengths.length ? (100 * Math.max(0, below)) / lengths.length : 100 });
    }
    // endangered and extinction per species
    for (const [sp, row] of counts) {
      let s = this.species.get(sp);
      if (!s) { s = { count: 0, peak: 0, endangered: false, lastId: row.id, lastPos: row.pos, meanY: [] }; this.species.set(sp, s); }
      s.count = row.n; s.peak = Math.max(s.peak, row.n); s.lastId = row.id; s.lastPos = row.pos;
      if (!s.endangered && row.n < this.o.endangeredBelow && s.peak >= this.o.endangeredFrom) {
        s.endangered = true;
        const ids: number[] = [];
        for (let k = 0; k < world.cr.highWater && ids.length < 5; k++) if (c.life[k] === LIFE.ALIVE && c.species[k] === sp) ids.push(entityId(world, k));
        out.push({ k: 'endangered', species: sp, remaining: row.n, ids });
      } else if (s.endangered && row.n >= this.o.endangeredFrom) s.endangered = false;
    }
    for (const [sp, s] of this.species) {
      if (counts.has(sp)) continue;
      if (s.count > 0) out.push({ k: 'extinction', species: sp, lastId: s.lastId, pos: s.lastPos });
      this.species.delete(sp);
    }
    // mass death: deaths in the window against the running mean and spread of earlier windows
    const w0 = t - this.o.massDeathWindowTicks;
    this.deaths = this.deaths.filter((d) => d.tick >= w0);
    const n = this.deaths.length;
    const mean = this.windowCounts.length ? this.windowCounts.reduce((a, b) => a + b, 0) / this.windowCounts.length : 0;
    const sd = this.windowCounts.length > 1 ? Math.sqrt(this.windowCounts.reduce((a, b) => a + (b - mean) ** 2, 0) / (this.windowCounts.length - 1)) : 0;
    const z = (n - mean) / Math.max(1, sd);
    if (n >= this.o.massDeathMin && z >= 3 && t - this.lastMassDeath >= this.o.massDeathWindowTicks) {
      const cx = this.deaths.reduce((a, d) => a + d.pos[0], 0) / n; const cy = this.deaths.reduce((a, d) => a + d.pos[1], 0) / n;
      const radius = Math.max(...this.deaths.map((d) => Math.hypot(d.pos[0] - cx, d.pos[1] - cy)));
      out.push({ k: 'massDeath', centroid: [cx, cy], radius, deaths: n, z });
      this.lastMassDeath = t;
    }
    this.windowCounts.push(n);
    if (this.windowCounts.length > 120) this.windowCounts.shift();
    this.groups(world, out);
    out.push(...(this.suite.run(world, true) as unknown as Out[]));
    // hunts that went quiet end as escapes
    for (const [key, h] of this.hunts) {
      if (t - h.last > this.o.huntTimeoutTicks) { out.push({ k: 'hunt', phase: 'end', pred: h.pred, prey: h.prey, pos: h.pos, outcome: 'escape' }); this.hunts.delete(key); }
    }
    return out;
  }

  /** Schools (one per species: its largest aligned cluster). */
  private groups(world: World, out: Out[]): void {
    const c = world.cr.c;
    const t = world.g.tick;
    const cell = 1; // metres
    const gw = Math.ceil(world.preset.widthM / cell);
    const grid = new Map<number, number[]>();
    const carc: number[] = [];
    for (let s = 0; s < world.cr.highWater; s++) {
      if (c.life[s] === LIFE.CARCASS) { carc.push(s); continue; }
      if (c.life[s] !== LIFE.ALIVE) continue;
      const k = Math.floor(c.posY[s]! / cell) * gw + Math.floor(c.posX[s]! / cell);
      const list = grid.get(k); if (list) list.push(s); else grid.set(k, [s]);
    }
    const near = (x: number, y: number, r: number): number[] => {
      const res: number[] = [];
      const x0 = Math.floor((x - r) / cell); const x1 = Math.floor((x + r) / cell);
      const y0 = Math.floor((y - r) / cell); const y1 = Math.floor((y + r) / cell);
      for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
        for (const s of grid.get(gy * gw + gx) ?? []) if (Math.hypot(c.posX[s]! - x, c.posY[s]! - y) <= r) res.push(s);
      }
      return res;
    };
    // schools: per grid cell, same-species members; keep each species' best aligned cluster
    const best = new Map<number, { n: number; pol: number; cx: number; cy: number; r: number; sample: number[] }>();
    for (const members of grid.values()) {
      const bySp = new Map<number, number[]>();
      for (const s of members) { const sp = c.species[s]!; const l = bySp.get(sp); if (l) l.push(s); else bySp.set(sp, [s]); }
      for (const [sp, seed] of bySp) {
        const s0 = seed[0]!;
        const group = near(c.posX[s0]!, c.posY[s0]!, 1.5 * cell).filter((s) => c.species[s] === sp);
        if (group.length < this.o.schoolMin) continue;
        let hx = 0; let hy = 0; let cx = 0; let cy = 0;
        for (const s of group) { hx += Math.cos(c.heading[s]!); hy += Math.sin(c.heading[s]!); cx += c.posX[s]!; cy += c.posY[s]!; }
        const pol = Math.hypot(hx, hy) / group.length;
        cx /= group.length; cy /= group.length;
        const prev = best.get(sp);
        if (pol >= this.o.schoolPolarisation && (!prev || group.length > prev.n)) {
          best.set(sp, { n: group.length, pol, cx, cy, r: Math.max(...group.map((s) => Math.hypot(c.posX[s]! - cx, c.posY[s]! - cy))), sample: group.slice(0, 8).map((s) => entityId(world, s)) });
        }
      }
    }
    for (const [sp, b] of best) {
      const known = this.schools.get(sp);
      const base = { k: 'school' as const, species: sp, n: b.n, centroid: [b.cx, b.cy] as V2, radius: b.r, polarisation: b.pol, sample: b.sample };
      if (!known) { out.push({ ...base, phase: 'start' }); this.schools.set(sp, { centroid: base.centroid, lastUpdate: t }); }
      else if (t - known.lastUpdate >= 10 * TICK_HZ) { out.push({ ...base, phase: 'update' }); known.lastUpdate = t; known.centroid = base.centroid; }
    }
    for (const [sp, known] of this.schools) {
      if (best.has(sp)) continue;
      out.push({ k: 'school', phase: 'end', species: sp, n: 0, centroid: known.centroid, radius: 0, polarisation: 0, sample: [] });
      this.schools.delete(sp);
    }
  }
}
