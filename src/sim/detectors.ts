/**
 * Derived-event detectors (CONTRACT 11): hunts, giants, schools, mass deaths and endangered
 * species here; carcasses and frenzies, migration, blooms and bloom fronts, records, novelty,
 * outbreaks and epidemic fronts, new roles and lineage stories in the event suite
 * (`./events/`, docs/modules/events.md), which this class runs on the same ticks. They read world state and the primitive event stream and never write
 * sim state, so they can run anywhere outside the step (the host, the dream-tank worker, a
 * replay tool) without touching determinism. They are deterministic anyway: a pure function
 * of the state and events they are shown, so a replay reproduces the director's story.
 *
 * Primitive events from the step (birth, death, bite, mate, speciation, extinction, god,
 * release) pass through untouched; the session forwards both kinds on the EVENT channel.
 */
import {
  CENSUS_EVERY, CF, G_REL, LIFE, TICK_HZ, type SimEvent, type V2, type World,
} from '../core/index.js';
import { entityId } from './requests.js';
import { EventSuite, type SuiteOptions } from './events/index.js';

type Distribute<E> = E extends SimEvent ? Omit<E, 't' | 'eid' | 'epoch'> : never;
type Derived = Distribute<SimEvent>;

export interface DetectorOptions {
  /** Seconds without a bite before a hunt ends as an escape. */
  huntTimeoutS?: number;
  /** School: neighbour radius (m), minimum members, minimum polarisation. */
  schoolRadiusM?: number;
  schoolMin?: number;
  schoolPolarisation?: number;
  /** Mass death: window (s), minimum deaths, z threshold over the running baseline. */
  massWindowS?: number;
  massMin?: number;
  massZ?: number;
  /** Outbreak: prevalence to start and to end. */
  outbreakOn?: number;
  outbreakOff?: number;
  /** Options for the event suite (carcass, migration, bloom, records, novelty, outbreak, roles, lineage). */
  suite?: SuiteOptions;
}

interface Hunt { pred: number; prey: number; start: number; last: number; pos: V2 }
interface School { n: number; centroid: V2 }

/** x * x (not `**`, whose result the spec leaves implementation-approximated). */
function sq(x: number): number { return x * x; }

export class Detectors {
  private readonly o: Required<Omit<DetectorOptions, 'suite'>>;
  private readonly hunts = new Map<number, Hunt>();
  private readonly giants = new Set<number>();
  private readonly schools = new Map<number, School>();
  readonly suite: EventSuite;
  private readonly endangered = new Set<number>();
  private readonly peak = new Map<number, number>();
  private deathsInWindow: V2[] = [];
  private windowStart = -1;
  private mean = 0;
  private var = 0;
  private windows = 0;
  private eid = 1;

  constructor(opts: DetectorOptions = {}) {
    const { suite, ...rest } = opts;
    this.o = {
      huntTimeoutS: 5, schoolRadiusM: 0.4, schoolMin: 8, schoolPolarisation: 0.6, massWindowS: 10, massMin: 10, massZ: 4,
      outbreakOn: 0.15, outbreakOff: 0.05, ...rest,
    };
    this.suite = new EventSuite({ every: CENSUS_EVERY, ...suite, outbreak: { on: this.o.outbreakOn, off: this.o.outbreakOff, ...suite?.outbreak } });
  }

  /**
   * Feed the events of the latest tick(s) and the world at the current tick. Returns derived
   * events stamped with the world's tick and epoch (event ids from a detector-local counter,
   * offset so they never collide with the step's ids).
   */
  observe(world: World, events: readonly SimEvent[]): SimEvent[] {
    const out: Derived[] = [];
    const tick = world.g.tick;
    for (const e of events) {
      if (e.k === 'bite') this.onBite(e.attacker, e.target, e.pos, tick, out);
      else if (e.k === 'death') this.onDeath(e, tick, out);
    }
    this.expireHunts(tick, out);
    out.push(...(this.suite.observe(world, events) as unknown as Derived[]));
    if (tick % CENSUS_EVERY === 0) {
      this.detectGiants(world, out);
      this.detectSchools(world, out);
      this.detectEndangered(world, out);
      out.push(...(this.suite.run(world, true) as unknown as Derived[]));
    }
    return out.map((d) => ({ ...d, t: tick, eid: 2 ** 52 + this.eid++, epoch: world.g.epoch }) as SimEvent);
  }

  private onBite(pred: number, prey: number, pos: V2, tick: number, out: Derived[]): void {
    const h = this.hunts.get(pred);
    if (!h || h.prey !== prey) {
      if (h) out.push({ k: 'hunt', phase: 'end', pred, prey: h.prey, pos: h.pos, outcome: 'escape' });
      this.hunts.set(pred, { pred, prey, start: tick, last: tick, pos });
      out.push({ k: 'hunt', phase: 'start', pred, prey, pos });
    } else {
      h.pos = pos;
      if (tick - h.last >= TICK_HZ) out.push({ k: 'hunt', phase: 'update', pred, prey, pos });
      h.last = tick;
    }
  }

  private onDeath(e: Extract<SimEvent, { k: 'death' }>, tick: number, out: Derived[]): void {
    if (e.killer !== undefined) {
      const h = this.hunts.get(e.killer);
      out.push({ k: 'hunt', phase: 'end', pred: e.killer, prey: e.id, pos: e.pos, outcome: 'kill' });
      if (h) this.hunts.delete(e.killer);
    }
    // a hunted prey that died of something else ends its hunts
    for (const [pred, h] of this.hunts) if (h.prey === e.id) { this.hunts.delete(pred); out.push({ k: 'hunt', phase: 'end', pred, prey: e.id, pos: e.pos, outcome: 'escape' }); }
    this.hunts.delete(e.id);
    this.giants.delete(e.id);
    // mass-death windows
    const w = this.o.massWindowS * TICK_HZ;
    if (this.windowStart < 0) this.windowStart = tick;
    while (tick - this.windowStart >= w) this.closeWindow(out);
    this.deathsInWindow.push(e.pos);
  }

  private closeWindow(out: Derived[]): void {
    const x = this.deathsInWindow.length;
    const sd = Math.sqrt(this.var);
    if (this.windows >= 6 && x >= this.o.massMin && x > this.mean + this.o.massZ * Math.max(sd, 1)) {
      let cx = 0, cy = 0;
      for (const p of this.deathsInWindow) { cx += p[0]; cy += p[1]; }
      cx /= x; cy /= x;
      let r2 = 0;
      for (const p of this.deathsInWindow) r2 += sq(p[0] - cx) + sq(p[1] - cy);
      out.push({ k: 'massDeath', centroid: [cx, cy], radius: Math.sqrt(r2 / x), deaths: x, z: (x - this.mean) / Math.max(sd, 1) });
    }
    // EMA baseline over about 10 windows
    const a = this.windows < 10 ? 1 / (this.windows + 1) : 0.1;
    const d = x - this.mean;
    this.mean += a * d;
    this.var = (1 - a) * (this.var + a * d * d);
    this.windows++;
    this.deathsInWindow = [];
    this.windowStart += this.o.massWindowS * TICK_HZ;
  }

  private expireHunts(tick: number, out: Derived[]): void {
    const limit = this.o.huntTimeoutS * TICK_HZ;
    for (const [pred, h] of [...this.hunts]) {
      if (tick - h.last > limit) { this.hunts.delete(pred); out.push({ k: 'hunt', phase: 'end', pred, prey: h.prey, pos: h.pos, outcome: 'escape' }); }
    }
  }

  private detectGiants(world: World, out: Derived[]): void {
    const c = world.cr.c;
    const lens: number[] = [];
    for (let s = 0; s < world.cr.highWater; s++) if (c.life[s] === LIFE.ALIVE && c.maturity[s]! >= 1) lens.push(c.length[s]!);
    lens.sort((a, b) => a - b);
    const p995 = lens.length >= 200 ? lens[Math.floor(lens.length * 0.995)]! : Infinity;
    const gAbs = G_REL * world.lCeilingM;
    for (let s = 0; s < world.cr.highWater; s++) {
      if (c.life[s] !== LIFE.ALIVE) continue;
      const L = c.length[s]!;
      const lev = (c.flags[s]! & CF.LEVIATHAN) !== 0;
      if (!(lev || L >= gAbs || L > p995)) continue;
      const id = entityId(world, s);
      if (this.giants.has(id)) continue;
      this.giants.add(id);
      let below = 0;
      for (const v of lens) if (v < L) below++;
      out.push({ k: 'giant', id, species: c.species[s]!, size: L, percentile: lens.length ? below / lens.length : 1 });
    }
  }

  /** Schools: same-species neighbours within a radius, grid-hashed, union-find, polarised headings. */
  private detectSchools(world: World, out: Derived[]): void {
    const c = world.cr.c;
    const r = this.o.schoolRadiusM;
    const gw = Math.ceil(world.preset.widthM / r);
    const cells = new Map<number, number[]>();
    const alive: number[] = [];
    for (let s = 0; s < world.cr.highWater; s++) {
      if (c.life[s] !== LIFE.ALIVE) continue;
      alive.push(s);
      const k = Math.floor(c.posY[s]! / r) * gw + Math.floor(c.posX[s]! / r);
      const b = cells.get(k);
      if (b) b.push(s); else cells.set(k, [s]);
    }
    const parent = new Map<number, number>();
    const find = (a: number): number => { let x = a; while (parent.get(x) !== x) x = parent.get(x)!; parent.set(a, x); return x; };
    for (const s of alive) parent.set(s, s);
    for (const s of alive) {
      const cx = Math.floor(c.posX[s]! / r), cy = Math.floor(c.posY[s]! / r);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        for (const o of cells.get((cy + dy) * gw + cx + dx) ?? []) {
          if (o <= s || c.species[o] !== c.species[s]) continue;
          const ddx = c.posX[o]! - c.posX[s]!, ddy = c.posY[o]! - c.posY[s]!;
          if (ddx * ddx + ddy * ddy > r * r) continue;
          const a = find(s), b = find(o);
          if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
        }
      }
    }
    const groups = new Map<number, number[]>();
    for (const s of alive) { const g = find(s); const l = groups.get(g); if (l) l.push(s); else groups.set(g, [s]); }
    const best = new Map<number, { members: number[]; pol: number }>();
    for (const members of groups.values()) {
      if (members.length < this.o.schoolMin) continue;
      let hx = 0, hy = 0;
      for (const s of members) { const v = Math.sqrt(sq(c.velX[s]!) + sq(c.velY[s]!)) || 1; hx += c.velX[s]! / v; hy += c.velY[s]! / v; }
      const pol = Math.sqrt(hx * hx + hy * hy) / members.length;
      if (pol < this.o.schoolPolarisation) continue;
      const sp = c.species[members[0]!]!;
      const cur = best.get(sp);
      if (!cur || members.length > cur.members.length) best.set(sp, { members, pol });
    }
    for (const [sp, { members, pol }] of [...best].sort((a, b) => a[0] - b[0])) {
      let mx = 0, my = 0;
      for (const s of members) { mx += c.posX[s]!; my += c.posY[s]!; }
      mx /= members.length; my /= members.length;
      let r2 = 0;
      for (const s of members) r2 += sq(c.posX[s]! - mx) + sq(c.posY[s]! - my);
      const phase = this.schools.has(sp) ? 'update' : 'start';
      this.schools.set(sp, { n: members.length, centroid: [mx, my] });
      out.push({
        k: 'school', phase, species: sp, n: members.length, centroid: [mx, my], radius: Math.sqrt(r2 / members.length),
        polarisation: pol, sample: members.slice(0, 8).map((s) => entityId(world, s)),
      });
    }
    for (const [sp, sc] of [...this.schools]) {
      if (best.has(sp)) continue;
      this.schools.delete(sp);
      out.push({ k: 'school', phase: 'end', species: sp, n: 0, centroid: sc.centroid, radius: 0, polarisation: 0, sample: [] });
    }
  }

  private detectEndangered(world: World, out: Derived[]): void {
    const c = world.cr.c;
    const counts = new Map<number, number[]>();
    for (let s = 0; s < world.cr.highWater; s++) {
      if (c.life[s] !== LIFE.ALIVE) continue;
      const l = counts.get(c.species[s]!);
      if (l) l.push(s); else counts.set(c.species[s]!, [s]);
    }
    for (const [sp, slots] of [...counts].sort((a, b) => a[0] - b[0])) {
      const peak = Math.max(this.peak.get(sp) ?? 0, slots.length);
      this.peak.set(sp, peak);
      if (peak >= 20 && slots.length <= 5 && !this.endangered.has(sp)) {
        this.endangered.add(sp);
        out.push({ k: 'endangered', species: sp, remaining: slots.length, ids: slots.map((s) => entityId(world, s)) });
      } else if (slots.length > 10) this.endangered.delete(sp);
    }
  }
}
