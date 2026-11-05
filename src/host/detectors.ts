/**
 * Host detectors (CONTRACT 11, DESIGN R19): derived events for the director, stats and audio.
 * They read world state and primitive events and never write sim state, so they may use any
 * arithmetic. Windows are in sim ticks, so the same world and events give the same output.
 *
 * Implemented: giant, record (size, age), endangered, extinction, massDeath, hunt (from bites
 * and kills), migration. The rest of the CONTRACT 11 table needs systems that do not exist yet
 * (schools need neighbour queries, outbreaks need disease, newRole and novelty need species
 * clustering).
 */
import { G_REL, LIFE, TICK_HZ, type SimEvent, type V2, type World } from '../core/index.js';
import { entityId } from './interest.js';

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
}

export class Detectors {
  private readonly o: Required<DetectorOptions>;
  private giants = new Set<number>();
  private records = { size: 0, age: 0 };
  private lastRecordTick = { size: -Infinity, age: -Infinity };
  private species = new Map<number, SpeciesSeen>();
  private deaths: { tick: number; pos: V2 }[] = [];
  private windowCounts: number[] = [];
  private lastMassDeath = -Infinity;
  private hunts = new Map<string, { pred: number; prey: number; start: number; last: number; pos: V2 }>();
  private lastRun = -Infinity;

  constructor(opts: DetectorOptions = {}) {
    this.o = {
      every: TICK_HZ, endangeredBelow: 5, endangeredFrom: 10, massDeathWindowTicks: 10 * TICK_HZ, massDeathMin: 10,
      huntTimeoutTicks: 10 * TICK_HZ, migrationWindowTicks: 60 * TICK_HZ, migrationFraction: 0.15, ...opts,
    };
  }

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
    void world;
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
    let maxLen = 0; let maxLenSlot = -1; let maxAge = 0; let maxAgeSlot = -1;
    for (let s = 0; s < world.cr.highWater; s++) {
      if (c.life[s] !== LIFE.ALIVE) continue;
      const len = c.length[s]!;
      if (c.maturity[s]! >= 0.99) lengths.push(len); // the percentile rule counts adults only
      if (len > maxLen) { maxLen = len; maxLenSlot = s; }
      const age = t - c.birthTick[s]!;
      if (age > maxAge) { maxAge = age; maxAgeSlot = s; }
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
    // records, at most one per kind per minute of sim time, and only for a 5% improvement
    const rec = (kind: 'size' | 'age', slot: number, value: number): void => {
      const prev = this.records[kind];
      if (slot < 0 || value <= prev * 1.05 || t - this.lastRecordTick[kind] < 60 * TICK_HZ) return;
      if (prev > 0) out.push({ k: 'record', kind, id: entityId(world, slot), value, prev });
      this.records[kind] = value; this.lastRecordTick[kind] = t;
    };
    rec('size', maxLenSlot, maxLen);
    rec('age', maxAgeSlot, maxAge / TICK_HZ);
    // endangered and extinction per species; migration by mean depth over a window
    const H = world.preset.heightM;
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
      s.meanY.push(row.ySum / row.n);
      const keep = Math.max(2, Math.round(this.o.migrationWindowTicks / this.o.every));
      if (s.meanY.length > keep) s.meanY.shift();
      if (s.meanY.length === keep) {
        const d = (s.meanY[s.meanY.length - 1]! - s.meanY[0]!) / H;
        if (Math.abs(d) >= this.o.migrationFraction) {
          out.push({ k: 'migration', species: sp, direction: d < 0 ? 'up' : 'down', fraction: Math.abs(d) });
          s.meanY = [s.meanY[s.meanY.length - 1]!];
        }
      }
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
    // hunts that went quiet end as escapes
    for (const [key, h] of this.hunts) {
      if (t - h.last > this.o.huntTimeoutTicks) { out.push({ k: 'hunt', phase: 'end', pred: h.pred, prey: h.prey, pos: h.pos, outcome: 'escape' }); this.hunts.delete(key); }
    }
    return out;
  }
}
