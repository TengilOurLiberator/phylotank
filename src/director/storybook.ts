/**
 * The StoryBook (06 §6.2.3): turns the event channel into bounded, merged stories. It also keeps
 * a small bounded memory of entity sizes and positions learnt from events, which the director
 * uses for giant promotion and tracking when no body locator is attached.
 */
import { G_REL, TICK_HZ, type Id, type SimEvent, type V2 } from '../core/index.js';
import type { StoryType } from './params.js';

export interface Story {
  id: number;
  type: StoryType;
  key: string;
  subjects: Id[];
  species: number[];
  pos: V2;
  radius: number;
  /** Velocity estimate of the primary subject (m/s), from successive positions. */
  vel: V2;
  /** Sim seconds. */
  tStart: number;
  tLast: number;
  magnitude: number;
  ended: boolean;
  /** God stories: the sim second the power fires. */
  tFire?: number;
  /** Extra caption data. */
  info: Record<string, string | number>;
  /** Last score computed by the director (for eviction). */
  score: number;
}

export interface BookOptions {
  maxStories: number;
  mergeRadiusM: number;
  mergeWindowS: number;
  lCeilingM: number;
  tankW: number;
  tankH: number;
}

/** Types merged by area and time rather than by identity. */
const AREA_TYPES: ReadonlySet<StoryType> = new Set<StoryType>(['massDeath', 'birthNotable', 'bloomFront']);

const MAX_TRACKED = 4096;

/** Insertion-ordered bounded map (oldest out first). */
class Bounded<V> {
  readonly m = new Map<number, V>();
  constructor(private readonly cap: number) {}
  get(k: number): V | undefined { return this.m.get(k); }
  set(k: number, v: V): void {
    if (this.m.has(k)) this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.cap) { const first = this.m.keys().next().value as number; this.m.delete(first); }
  }
  has(k: number): boolean { return this.m.has(k); }
}

export class StoryBook {
  readonly stories = new Map<string, Story>();
  private nextId = 1;
  /** id -> body length (m). */
  readonly sizes = new Bounded<number>(MAX_TRACKED);
  /** id -> [x, y, tSim]. */
  readonly seen = new Bounded<[number, number, number]>(MAX_TRACKED);
  readonly giants = new Bounded<true>(1024);
  /** species -> last known position. */
  readonly speciesPos = new Bounded<V2>(1024);
  private readonly seenSpecies = new Bounded<true>(4096);
  private readonly newSpecies = new Bounded<number>(1024);
  /** boom counters: key -> [count, tFirst] */
  private readonly booms = new Map<string, [number, number]>();
  evictions = 0;
  /** primary subject id -> keys of the stories it leads (for deaths mid-story). */
  private readonly bySubject = new Map<Id, string[]>();
  private index(s: Story): void {
    const id = s.subjects[0];
    if (id === undefined) return;
    const l = this.bySubject.get(id);
    if (l) { if (!l.includes(s.key)) l.push(s.key); } else this.bySubject.set(id, [s.key]);
  }

  constructor(readonly opts: BookOptions) {}

  giantThreshold(): number { return G_REL * this.opts.lCeilingM; }
  isGiant(id: Id): boolean {
    if (this.giants.has(id)) return true;
    const s = this.sizes.get(id);
    return s !== undefined && s >= this.giantThreshold();
  }

  private note(id: Id, pos: V2 | undefined, tS: number, size?: number): void {
    if (size !== undefined && size > 0) this.sizes.set(id, size);
    if (pos) this.seen.set(id, [pos[0], pos[1], tS]);
  }

  /** Last known position of an entity, or null. */
  where(id: Id): V2 | null {
    const p = this.seen.get(id);
    return p ? [p[0], p[1]] : null;
  }

  private cell(pos: V2, m: number): string {
    return `${Math.floor(pos[0] / m)}:${Math.floor(pos[1] / m)}`;
  }

  /** Create or update a story. Returns it. */
  private upsert(type: StoryType, key: string, tS: number, init: () => Omit<Story, 'id' | 'type' | 'key' | 'tStart' | 'tLast' | 'ended' | 'score' | 'vel' | 'info'> & { info?: Story['info'] }, update?: (s: Story) => void): Story {
    let s = this.stories.get(key);
    if (!s && AREA_TYPES.has(type)) s = this.findNear(type, init().pos, tS);
    if (s) {
      s.tLast = tS;
      if (update) update(s);
      return s;
    }
    const base = init();
    s = {
      id: this.nextId++, type, key, tStart: tS, tLast: tS, ended: false, score: 0, vel: [0, 0],
      subjects: base.subjects, species: base.species, pos: [base.pos[0], base.pos[1]], radius: base.radius,
      magnitude: base.magnitude, info: base.info ?? {},
    };
    if (base.tFire !== undefined) s.tFire = base.tFire;
    this.stories.set(key, s);
    this.index(s);
    this.bound();
    return s;
  }

  private findNear(type: StoryType, pos: V2, tS: number): Story | undefined {
    const r2 = this.opts.mergeRadiusM * this.opts.mergeRadiusM;
    for (const s of this.stories.values()) {
      if (s.type !== type || s.ended || tS - s.tLast > this.opts.mergeWindowS) continue;
      const dx = s.pos[0] - pos[0];
      const dy = s.pos[1] - pos[1];
      if (dx * dx + dy * dy <= r2) return s;
    }
    return undefined;
  }

  private move(s: Story, pos: V2, tS: number): void {
    const dt = tS - s.tLast;
    if (dt > 0.05 && dt < 5) {
      const k = 0.5;
      s.vel[0] = s.vel[0] * (1 - k) + ((pos[0] - s.pos[0]) / dt) * k;
      s.vel[1] = s.vel[1] * (1 - k) + ((pos[1] - s.pos[1]) / dt) * k;
    }
    s.pos[0] = pos[0];
    s.pos[1] = pos[1];
  }

  /** Bound the book: evict the lowest-scoring ended stories first, then the lowest-scoring at all. */
  private bound(): void {
    const max = this.opts.maxStories;
    if (this.stories.size <= max) return;
    // One pass: collect and sort by (ended desc, score asc, id asc); remove 1/16 of the book at once
    // so an event storm costs O(n log n) per 32 inserts rather than per insert.
    const all = [...this.stories.values()];
    all.sort((a, b) => (a.ended === b.ended ? 0 : a.ended ? -1 : 1) || a.score - b.score || a.id - b.id);
    const drop = Math.max(1, this.stories.size - max + (max >> 4));
    for (let i = 0; i < drop && i < all.length; i++) { this.stories.delete(all[i]!.key); this.evictions++; }
  }

  /** Drop stories that ended long ago (sim seconds), or idle past `staleS(story)` without news. */
  prune(nowS: number, staleS?: (s: Story) => number): void {
    for (const [k, s] of this.stories) {
      const age = nowS - s.tLast;
      if ((s.ended && age > 1800) || (staleS && age > Math.min(1800, staleS(s)) && s.type !== 'lastOfSpecies')) this.stories.delete(k);
    }
    if (this.bySubject.size > 4 * this.opts.maxStories) {
      this.bySubject.clear();
      for (const s of this.stories.values()) this.index(s);
    }
    for (const [k, b] of this.booms) if (nowS - b[1] > 20) this.booms.delete(k);
  }

  end(key: string, tS: number): Story | undefined {
    const s = this.stories.get(key);
    if (s && !s.ended) { s.ended = true; s.tLast = Math.max(s.tLast, tS); }
    return s;
  }

  /** Ingest one event. Returns the story it touched, if any. */
  ingest(ev: SimEvent): Story | undefined {
    const tS = ev.t / TICK_HZ;
    const tankC: V2 = [this.opts.tankW / 2, this.opts.tankH / 2];
    switch (ev.k) {
      case 'god': {
        const tFire = ev.tFire / TICK_HZ;
        return this.upsert('disaster', `god:${ev.cmdId}`, tS, () => ({
          subjects: [], species: [], pos: ev.pos, radius: Math.max(1, ev.radius), magnitude: ev.radius * (0.5 + ev.strength), tFire,
          info: { power: ev.power, author: ev.author },
        }));
      }
      case 'release': {
        return this.upsert(ev.leviathan ? 'giant' : 'release', `release:${ev.cmdId}`, tS, () => ({
          subjects: [], species: [ev.species], pos: ev.pos, radius: 2, magnitude: ev.leviathan ? 3 : Math.max(1, ev.count / 4),
          info: { leviathan: ev.leviathan ? 1 : 0 },
        }));
      }
      case 'hunt': {
        this.note(ev.pred, ev.pos, tS);
        const key = `hunt:${ev.pred}`;
        const giant = this.isGiant(ev.pred) || this.isGiant(ev.prey);
        const s = this.upsert(giant ? 'giantKill' : 'hunt', key, tS, () => ({
          subjects: [ev.pred, ev.prey], species: [], pos: ev.pos, radius: 1.5, magnitude: 1,
        }), (st) => {
          this.move(st, ev.pos, tS);
          st.magnitude = Math.min(10, st.magnitude + 0.25);
          if (giant && st.type === 'hunt') st.type = 'giantKill';
        });
        if (ev.phase === 'end') {
          s.ended = true;
          if (ev.outcome === 'kill') this.spawnKill(ev.prey, ev.pred, ev.pos, tS, this.sizes.get(ev.prey) ?? 0.02);
        }
        return s;
      }
      case 'death': {
        this.note(ev.id, ev.pos, tS, ev.size);
        const sp = this.speciesPos; sp.set(ev.species, ev.pos);
        // A tracked subject died: its stories end; hunts end in a kill.
        let touched: Story | undefined;
        if (ev.killer !== undefined) {
          const h = this.stories.get(`hunt:${ev.killer}`);
          if (h && !h.ended) { h.ended = true; h.tLast = tS; }
          touched = this.spawnKill(ev.id, ev.killer, ev.pos, tS, ev.size);
        } else if (this.isGiant(ev.id)) {
          touched = this.spawnKill(ev.id, undefined, ev.pos, tS, ev.size);
        }
        const keys = this.bySubject.get(ev.id);
        if (keys) {
          for (const k of keys) {
            const s = this.stories.get(k);
            if (s && !s.ended && s.subjects[0] === ev.id && s.type !== 'kill') {
              s.ended = true; s.tLast = tS; s.pos[0] = ev.pos[0]; s.pos[1] = ev.pos[1];
            }
          }
          this.bySubject.delete(ev.id);
        }
        return touched;
      }
      case 'birth': {
        this.note(ev.id, ev.pos, tS, ev.size);
        this.speciesPos.set(ev.species, ev.pos);
        const first = !this.seenSpecies.has(ev.species);
        this.seenSpecies.set(ev.species, true);
        const fromGiant = ev.parents.some((p) => this.isGiant(p));
        if ((first && this.newSpecies.has(ev.species)) || fromGiant) {
          return this.upsert('birthNotable', `birth:${ev.id}`, tS, () => ({
            subjects: [ev.id, ...ev.parents], species: [ev.species], pos: ev.pos, radius: 0.5,
            magnitude: fromGiant ? 10 : 5, info: { why: fromGiant ? 'giant' : 'first' },
          }));
        }
        const bk = `${ev.species}:${this.cell(ev.pos, 20)}`;
        const b = this.booms.get(bk);
        if (!b || tS - b[1] > 20) { this.booms.set(bk, [1, tS]); return undefined; }
        b[0]++;
        if (b[0] >= 10) {
          return this.upsert('birthNotable', `boom:${bk}`, tS, () => ({
            subjects: [ev.id], species: [ev.species], pos: ev.pos, radius: 3, magnitude: b[0], info: { why: 'boom' },
          }), (s) => { s.magnitude = b[0]; });
        }
        return undefined;
      }
      case 'mate': {
        this.note(ev.a, ev.pos, tS); this.note(ev.b, ev.pos, tS);
        const la = this.sizes.get(ev.a) ?? 0;
        const lb = this.sizes.get(ev.b) ?? 0;
        const big = 0.1 * this.opts.lCeilingM;
        if (la < big || lb < big) return undefined;
        return this.upsert('mating', `mate:${Math.min(ev.a, ev.b)}`, tS, () => ({
          subjects: [ev.a, ev.b], species: [], pos: ev.pos, radius: 1, magnitude: Math.max(la, lb),
        }), (s) => this.move(s, ev.pos, tS));
      }
      case 'bite': {
        this.note(ev.attacker, ev.pos, tS);
        const h = this.stories.get(`hunt:${ev.attacker}`);
        if (h && !h.ended) { this.move(h, ev.pos, tS); h.tLast = tS; }
        return h;
      }
      case 'infect': return undefined;
      case 'speciation': {
        this.newSpecies.set(ev.child, tS);
        this.speciesPos.set(ev.child, ev.pos);
        return this.upsert('speciation', `speciation:${ev.child}`, tS, () => ({
          subjects: ev.founders.slice(0, 8), species: [ev.child, ev.parent], pos: ev.pos, radius: 4, magnitude: ev.founders.length,
          info: { child: ev.child, parent: ev.parent },
        }));
      }
      case 'extinction': {
        this.end(`last:${ev.species}`, tS);
        this.end(`endangered:${ev.species}`, tS);
        const s = this.upsert('extinction', `extinction:${ev.species}`, tS, () => ({
          subjects: [ev.lastId], species: [ev.species], pos: ev.pos, radius: 2, magnitude: 1, info: { species: ev.species },
        }));
        s.ended = true;
        return s;
      }
      case 'reseed': return undefined;
      case 'school': {
        const key = `school:${ev.species}:${this.cell(ev.centroid, 20)}`;
        const s = this.upsert('school', key, tS, () => ({
          subjects: ev.sample.slice(0, 8), species: [ev.species], pos: ev.centroid, radius: Math.max(0.5, ev.radius), magnitude: ev.n,
          info: { polarisation: ev.polarisation },
        }), (st) => { this.move(st, ev.centroid, tS); st.radius = Math.max(0.5, ev.radius); st.magnitude = ev.n; });
        this.speciesPos.set(ev.species, ev.centroid);
        if (ev.phase === 'end') s.ended = true;
        return s;
      }
      case 'giant': {
        this.giants.set(ev.id, true);
        this.sizes.set(ev.id, ev.size);
        const pos = this.where(ev.id) ?? this.speciesPos.get(ev.species) ?? tankC;
        return this.upsert('giant', `giant:${ev.id}`, tS, () => ({
          subjects: [ev.id], species: [ev.species], pos, radius: Math.max(0.2, ev.size), magnitude: ev.size / this.giantThreshold(),
          info: { size: ev.size },
        }));
      }
      case 'record': {
        const pos = this.where(ev.id) ?? tankC;
        const pct = ev.prev > 0 ? (100 * (ev.value - ev.prev)) / ev.prev : 100;
        return this.upsert('record', `record:${ev.kind}:${ev.id}`, tS, () => ({
          subjects: [ev.id], species: [], pos, radius: 0.5, magnitude: pct, info: { kind: ev.kind, value: ev.value },
        }), (s) => { s.magnitude = pct; s.info['value'] = ev.value; });
      }
      case 'endangered': {
        const pos = (ev.ids[0] !== undefined ? this.where(ev.ids[0]) : null) ?? this.speciesPos.get(ev.species) ?? tankC;
        if (ev.remaining <= 1 && ev.ids[0] !== undefined) {
          this.end(`endangered:${ev.species}`, tS);
          return this.upsert('lastOfSpecies', `last:${ev.species}`, tS, () => ({
            subjects: [ev.ids[0]!], species: [ev.species], pos, radius: 0.5, magnitude: 1, info: { species: ev.species },
          }));
        }
        return this.upsert('endangered', `endangered:${ev.species}`, tS, () => ({
          subjects: ev.ids.slice(0, 8), species: [ev.species], pos, radius: 2, magnitude: 1, info: { remaining: ev.remaining },
        }), (s) => { s.info['remaining'] = ev.remaining; });
      }
      case 'outbreak': {
        const key = `outbreak:${ev.strain}:${ev.host}`;
        const s = this.upsert('outbreak', key, tS, () => ({
          subjects: [], species: [ev.host], pos: ev.centroid, radius: Math.max(1, ev.radius), magnitude: Math.max(0, ev.growth),
          info: { prevalence: ev.prevalence },
        }), (st) => { this.move(st, ev.centroid, tS); st.magnitude = Math.max(0, ev.growth); st.info['prevalence'] = ev.prevalence; });
        if (ev.phase === 'end') s.ended = true;
        return s;
      }
      case 'epidemicFront': {
        return this.upsert('outbreak', `outbreak:${ev.strain}:${ev.species}`, tS, () => ({
          subjects: [], species: [ev.species], pos: ev.pos, radius: Math.max(1, ev.radius), magnitude: 0.02, info: {},
        }), (st) => this.move(st, ev.pos, tS));
      }
      case 'massDeath': {
        return this.upsert('massDeath', `massDeath:${this.cell(ev.centroid, 20)}:${Math.floor(tS)}`, tS, () => ({
          subjects: [], species: [], pos: ev.centroid, radius: Math.max(1, ev.radius), magnitude: ev.deaths, info: { deaths: ev.deaths },
        }), (s) => { s.magnitude += ev.deaths; s.info['deaths'] = s.magnitude; });
      }
      case 'carcass': {
        this.note(ev.id, ev.pos, tS, ev.size);
        return this.upsert('carcass', `carcass:${ev.id}`, tS, () => ({
          subjects: [ev.id], species: [], pos: ev.pos, radius: Math.max(0.3, ev.size), magnitude: ev.scavengers, info: { size: ev.size },
        }), (s) => { s.magnitude = ev.scavengers; });
      }
      case 'frenzy': {
        return this.upsert('frenzy', `carcass:${ev.carcass}:frenzy`, tS, () => ({
          subjects: [ev.carcass], species: [], pos: ev.pos, radius: 1.5, magnitude: ev.n,
        }), (s) => { s.magnitude = ev.n; });
      }
      case 'migration': {
        const pos = this.speciesPos.get(ev.species) ?? tankC;
        return this.upsert('migration', `migration:${ev.species}`, tS, () => ({
          subjects: [], species: [ev.species], pos, radius: this.opts.tankH / 3, magnitude: ev.fraction, info: { direction: ev.direction },
        }));
      }
      case 'bloomFront': {
        return this.upsert('bloomFront', `bloom:${this.cell(ev.pos, 20)}`, tS, () => ({
          subjects: [], species: [], pos: ev.pos, radius: Math.max(1, ev.radius), magnitude: ev.strength,
        }), (s) => this.move(s, ev.pos, tS));
      }
      case 'newRole': {
        const pos = this.speciesPos.get(ev.species);
        if (!pos) return undefined;
        return this.upsert('newRole', `newRole:${ev.species}:${ev.role}`, tS, () => ({
          subjects: [], species: [ev.species], pos, radius: 2, magnitude: 1, info: { role: ev.role },
        }));
      }
      case 'novelty': {
        const pos = this.where(ev.id) ?? this.speciesPos.get(ev.species) ?? tankC;
        return this.upsert('novelty', `novelty:${ev.id}`, tS, () => ({
          subjects: [ev.id], species: [ev.species], pos, radius: 0.3, magnitude: ev.distance,
        }));
      }
      default: return undefined;
    }
  }

  private spawnKill(prey: Id, killer: Id | undefined, pos: V2, tS: number, size: number): Story {
    const giant = this.isGiant(prey) || (killer !== undefined && this.isGiant(killer));
    const key = `kill:${prey}`;
    const existing = this.stories.get(key);
    if (existing) return existing;
    const s: Story = {
      id: this.nextId++, type: 'kill', key, subjects: killer !== undefined ? [prey, killer] : [prey], species: [],
      pos: [pos[0], pos[1]], radius: Math.max(0.5, size * 2), vel: [0, 0], tStart: tS, tLast: tS,
      magnitude: giant ? Math.max(size, 0.2) * 5 : size, ended: true, score: 0, info: { giant: giant ? 1 : 0 },
    };
    this.stories.set(key, s);
    this.bound();
    return s;
  }
}
