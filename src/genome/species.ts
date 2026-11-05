/**
 * Online species assignment with hysteresis (01 §1.9.2 to 1.9.4, review R14).
 *
 * - assign(), join rule 'lineage' (default, review R14): a child joins its parent's species, or
 *   that species' split daughter when it is nearer the daughter's medoid. New species arise only
 *   from split detection on the reservoir (2-medoids, both clusters at least a quarter of the
 *   sample, medoids more than theta apart, mean silhouette above 0.25).
 *   Join rule 'medoid' (01 §1.9.3 as written): a child joins its parent's species if within theta
 *   of its medoid, else the nearest nearby species (parent, children and siblings of the parent's
 *   species, then the father's species), else it founds an incipient species.
 * - Distance: genetic (distance.ts) for sexual genomes; for budders (SEX_PROB < 0.5 in both) the
 *   expressed body-plan descriptor (review R14). Mode 'genetic' or 'phenotype' forces one.
 * - Promotion: an incipient species becomes a species with N_MIN living members, after
 *   PERSIST_GENERATIONS of its founder's generation time, and with living biomass of at least
 *   BIOMASS_MIN_ADULTS founder adults (review R14: biomass as well as count). Only promotions
 *   and extinctions of promoted species produce events.
 * - Medoid upkeep: a reservoir of RESERVOIR_SIZE members (Vitter's algorithm R, draws from
 *   stream SPECIES keyed by the child's entity id); every MEDOID_EVERY joins the medoid is
 *   recomputed from the reservoir, so a species follows gradual drift.
 * Species ids are sequential from 1; records live in an array, so nothing iterates a Map.
 * The view-level threshold slider (review R14, 01 open question 3) is `clusterAt()`.
 */
import { RNG_STREAM, TICK_HZ, type Genome, type RngStreams } from '../core/index.js';
import { BIOMASS_MIN_ADULTS, MEDOID_EVERY, N_MIN, PERSIST_GENERATIONS, RESERVOIR_SIZE, THETA_SPECIES } from './constants.js';
import { bodyPlanDescriptor, descriptorDistance, distance } from './distance.js';
import { TI, brainTrait, trait } from './genes.js';
import { BT, KIND_COUNT, log } from '../core/index.js';
import { binomialFor, type NameFeatures } from './names.js';
import { develop } from './develop.js';

export type SpeciesStatus = 'incipient' | 'species' | 'extinct' | 'absorbed';
export interface SpeciesRecord {
  id: number; parentId: number; status: SpeciesStatus;
  bornTick: number; promotedTick: number; extinctTick: number;
  medoid: Genome; founder: Genome; founderAdultKg: number; genTimeS: number;
  reservoir: Genome[]; joins: number; pop: number; peakPop: number; biomassKg: number;
  children: number[]; founders: number[];
  /** The latest daughter split off by split detection; members move over lazily at reproduction. */
  splitInto: number;
  genus: string; epithet: string; common: { en: string; sv: string }; namedBy: 'generator' | 'user' | 'template';
}
export type SpeciesEvent =
  | { k: 'speciation'; parent: number; child: number; founders: number[] }
  | { k: 'extinction'; species: number; lastId: number };
export interface AssignInput {
  genome: Genome; parentSpecies: number; fatherSpecies?: number; tick: number; entityId: number;
  massKg: number; adultMassKg: number; tMatureS: number;
  /** The bearer's genome, for the lineage join rule. */
  parentGenome?: Genome;
}
export interface SpeciesOptions {
  theta?: number; mode?: 'auto' | 'genetic' | 'phenotype'; lCeilingM: number; rng: RngStreams; seed?: number;
  nMin?: number; persistGenerations?: number; biomassMinAdults?: number;
  /** 'lineage' (default): a child within theta of its parent stays in the parent's species and new
   *  species arise from reservoir splits; 'medoid': 01 §1.9.3 as written (distance to the medoid only). */
  joinRule?: 'lineage' | 'medoid';
}

export class SpeciesRegistry {
  readonly records: (SpeciesRecord | undefined)[] = [undefined];
  readonly theta: number;
  readonly mode: 'auto' | 'genetic' | 'phenotype';
  readonly joinRule: 'lineage' | 'medoid';
  private readonly desc = new WeakMap<Genome, Float64Array>();
  private readonly genusTaken = new Set<string>();
  private readonly epithetTaken = new Set<string>();
  private readonly nMin: number;
  private readonly persist: number;
  private readonly biomassMin: number;
  distanceCalls = 0;

  constructor(readonly opts: SpeciesOptions) {
    this.theta = opts.theta ?? THETA_SPECIES;
    this.mode = opts.mode ?? 'auto';
    this.joinRule = opts.joinRule ?? 'lineage';
    this.nMin = opts.nMin ?? N_MIN;
    this.persist = opts.persistGenerations ?? PERSIST_GENERATIONS;
    this.biomassMin = opts.biomassMinAdults ?? BIOMASS_MIN_ADULTS;
  }

  get(id: number): SpeciesRecord | undefined { return this.records[id]; }
  /** Living species in id order (promoted only unless `all`). */
  living(all = false): SpeciesRecord[] {
    return this.records.filter((r): r is SpeciesRecord => !!r && r.pop > 0 && (all ? r.status !== 'extinct' : r.status === 'species'));
  }

  private descriptor(g: Genome): Float64Array {
    let d = this.desc.get(g);
    if (!d) { d = bodyPlanDescriptor(g, this.opts.lCeilingM); this.desc.set(g, d); }
    return d;
  }
  /** The distance used for species: genetic, or body-plan for budders (review R14). */
  dist(a: Genome, b: Genome): number {
    this.distanceCalls++;
    const pheno = this.mode === 'phenotype'
      || (this.mode === 'auto' && trait(a, TI.SEX_PROB) < 0.5 && trait(b, TI.SEX_PROB) < 0.5);
    return pheno ? descriptorDistance(this.descriptor(a), this.descriptor(b)) : distance(a, b);
  }

  /** A seeded or designed founder species (promoted at once; parentId 0). */
  found(g: Genome, tick: number, opts: { adultMassKg: number; tMatureS: number; name?: { genus: string; epithet: string; common?: { en: string; sv: string } } }): number {
    const id = this.create(g, 0, tick, opts.adultMassKg, opts.tMatureS);
    const r = this.records[id]!;
    r.status = 'species'; r.promotedTick = tick;
    if (opts.name) {
      r.genus = opts.name.genus; r.epithet = opts.name.epithet; r.common = opts.name.common ?? { en: opts.name.genus, sv: opts.name.genus };
      r.namedBy = 'template';
      this.genusTaken.add(r.genus); this.epithetTaken.add(`${r.genus} ${r.epithet}`);
    } else this.nameSpecies(r);
    return id;
  }

  private create(g: Genome, parentId: number, tick: number, adultKg: number, tMatureS: number): number {
    const id = this.records.length;
    this.records.push({
      id, parentId, status: 'incipient', bornTick: tick, promotedTick: 0, extinctTick: 0, medoid: g, founder: g,
      founderAdultKg: adultKg, genTimeS: Math.max(1, tMatureS), reservoir: [g], joins: 0, pop: 0, peakPop: 0, biomassKg: 0,
      children: [], founders: [], splitInto: 0, genus: '', epithet: '', common: { en: '', sv: '' }, namedBy: 'generator',
    });
    if (parentId > 0) this.records[parentId]?.children.push(id);
    return id;
  }

  private nearby(sid: number, father?: number): number[] {
    const out: number[] = [];
    const add = (x: number | undefined): void => { if (x && x !== sid && !out.includes(x)) out.push(x); };
    const s = this.records[sid];
    if (s) {
      add(s.parentId);
      for (const c of s.children) add(c);
      const p = this.records[s.parentId];
      if (p) for (const c of p.children) add(c);
    }
    add(father);
    return out;
  }

  /** Assign a newborn. Returns its species id and any events (promotion). */
  assign(inp: AssignInput): { species: number; events: SpeciesEvent[] } {
    const events: SpeciesEvent[] = [];
    let sid = 0;
    let S = this.records[inp.parentSpecies];
    // a split daughter claims members of its parent species that are closer to its medoid
    if (S && S.splitInto) {
      const D = this.records[S.splitInto];
      if (D && D.status !== 'extinct' && this.dist(inp.genome, D.medoid) < this.dist(inp.genome, S.medoid)) S = D;
    }
    if (S && S.status !== 'extinct') {
      // lineage rule (review R14): a birth never founds a species by itself; species arise from
      // reservoir splits (detectSplit), so one odd mutant or a clonal burst cannot make one.
      if (this.joinRule === 'lineage') sid = S.id;
      else if (this.dist(inp.genome, S.medoid) < this.theta) sid = S.id;
    }
    if (!sid && S) {
      let best = Infinity;
      for (const t of this.nearby(S.id, inp.fatherSpecies)) {
        const T = this.records[t]!;
        if (T.status === 'extinct' || T.status === 'absorbed' || T.pop === 0) continue;
        const d = this.dist(inp.genome, T.medoid);
        if (d < this.theta && d < best) { best = d; sid = t; }
      }
    }
    if (!sid) sid = this.create(inp.genome, S ? S.id : 0, inp.tick, inp.adultMassKg, inp.tMatureS);
    this.join(sid, inp, events);
    return { species: sid, events };
  }

  private join(sid: number, inp: AssignInput, events: SpeciesEvent[]): void {
    const r = this.records[sid]!;
    r.pop++; r.joins++; r.biomassKg += inp.massKg;
    if (r.pop > r.peakPop) r.peakPop = r.pop;
    if (r.status === 'incipient' && r.founders.length < this.nMin) r.founders.push(inp.entityId);
    // reservoir sample (algorithm R)
    if (r.reservoir.length < RESERVOIR_SIZE) r.reservoir.push(inp.genome);
    else {
      const j = this.opts.rng.draw(RNG_STREAM.SPECIES, inp.tick, inp.entityId).int(r.joins);
      if (j < RESERVOIR_SIZE) r.reservoir[j] = inp.genome;
    }
    if (r.joins % MEDOID_EVERY === 0) { this.updateMedoid(r); this.detectSplit(r, inp.tick); }
    this.checkPromotion(r, inp.tick, events);
  }

  private checkPromotion(r: SpeciesRecord, tick: number, events: SpeciesEvent[]): void {
    if (r.status !== 'incipient') return;
    const ageS = (tick - r.bornTick) / TICK_HZ;
    if (r.pop >= this.nMin && ageS >= this.persist * r.genTimeS && r.biomassKg >= this.biomassMin * r.founderAdultKg) {
      r.status = 'species'; r.promotedTick = tick;
      this.nameSpecies(r);
      events.push({ k: 'speciation', parent: r.parentId, child: r.id, founders: r.founders.slice() });
    }
  }

  /** Re-check promotion for every incipient species (call on census ticks; also ages them). */
  tick(tick: number): SpeciesEvent[] {
    const ev: SpeciesEvent[] = [];
    for (const r of this.records) {
      if (!r || r.status !== 'incipient') continue;
      if (r.pop > 0) this.checkPromotion(r, tick, ev);
      // a split daughter that never received a member dissolves
      else if (r.joins === 0 && (tick - r.bornTick) / TICK_HZ > this.persist * r.genTimeS) { r.status = 'extinct'; r.extinctTick = tick; }
    }
    return ev;
  }

  /** Change a member's living mass (growth, starvation). */
  addMass(sid: number, dKg: number): void { const r = this.records[sid]; if (r) r.biomassKg = Math.max(0, r.biomassKg + dKg); }

  /** A member died (or became a carcass). */
  death(sid: number, massKg: number, entityId: number, tick: number): SpeciesEvent[] {
    const r = this.records[sid];
    if (!r || r.pop <= 0) return [];
    r.pop--; r.biomassKg = Math.max(0, r.biomassKg - massKg);
    if (r.pop > 0) return [];
    const wasSpecies = r.status === 'species';
    r.status = 'extinct'; r.extinctTick = tick; r.biomassKg = 0;
    return wasSpecies ? [{ k: 'extinction', species: r.id, lastId: entityId }] : [];
  }

  private updateMedoid(r: SpeciesRecord): void {
    const res = r.reservoir;
    let best = 0, bestSum = Infinity;
    for (let i = 0; i < res.length; i++) {
      let s = 0;
      for (let j = 0; j < res.length && s < bestSum; j++) if (i !== j) s += this.dist(res[i]!, res[j]!);
      if (s < bestSum) { bestSum = s; best = i; }
    }
    r.medoid = res[best]!;
  }

  /**
   * Split detection (01 §1.9.3, cladogenesis): 2-medoids on the reservoir. Split when the two
   * medoids are more than theta apart, each cluster holds at least a quarter of the sample and the
   * mean silhouette is above 0.25. The cluster nearer the old medoid keeps the id.
   */
  private detectSplit(r: SpeciesRecord, tick: number): void {
    const res = r.reservoir;
    const n = res.length;
    if (n < 32 || (r.splitInto && this.records[r.splitInto]?.status !== 'extinct')) return;
    const D = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const d = this.dist(res[i]!, res[j]!); D[i * n + j] = d; D[j * n + i] = d; }
    // seeds: the current medoid's farthest member, then that member's farthest member
    let a = 0, b = 0;
    const mi = Math.max(0, res.indexOf(r.medoid));
    for (let j = 0; j < n; j++) if (D[mi * n + j]! > D[mi * n + a]!) a = j;
    for (let j = 0; j < n; j++) if (D[a * n + j]! > D[a * n + b]!) b = j;
    if (D[a * n + b]! <= this.theta) return;
    const lab = new Uint8Array(n);
    for (let it = 0; it < 4; it++) {
      for (let i = 0; i < n; i++) lab[i] = D[i * n + a]! <= D[i * n + b]! ? 0 : 1;
      const med = (c: number): number => {
        let best = -1, bs = Infinity;
        for (let i = 0; i < n; i++) if (lab[i] === c) {
          let s = 0; for (let j = 0; j < n; j++) if (lab[j] === c) s += D[i * n + j]!;
          if (s < bs) { bs = s; best = i; }
        }
        return best;
      };
      const na = med(0), nb = med(1);
      if (na < 0 || nb < 0) return;
      a = na; b = nb;
    }
    let ca = 0;
    for (let i = 0; i < n; i++) if (lab[i] === 0) ca++;
    if (ca < n / 4 || n - ca < n / 4 || D[a * n + b]! <= this.theta) return;
    let sil = 0;
    for (let i = 0; i < n; i++) {
      let inS = 0, inN = 0, outS = 0, outN = 0;
      for (let j = 0; j < n; j++) if (j !== i) { if (lab[j] === lab[i]) { inS += D[i * n + j]!; inN++; } else { outS += D[i * n + j]!; outN++; } }
      const ai = inN ? inS / inN : 0, bi = outN ? outS / outN : 0;
      sil += bi > ai ? (bi - ai) / bi : ai > 0 ? (bi - ai) / ai : 0;
    }
    if (sil / n <= 0.25) return;
    // the cluster nearer the old medoid keeps the id
    const keepA = this.dist(res[a]!, r.medoid) <= this.dist(res[b]!, r.medoid);
    const stay = keepA ? 0 : 1;
    const dm = res[keepA ? b : a]!;
    const id = this.create(dm, r.id, tick, r.founderAdultKg, r.genTimeS);
    const d = this.records[id]!;
    d.reservoir = res.filter((_, i) => lab[i] !== stay);
    r.reservoir = res.filter((_, i) => lab[i] === stay);
    r.medoid = res[keepA ? a : b]!;
    r.splitInto = id;
  }

  /** Name a promoted species (genus inherited below 3 theta from the parent's founder, 07 §6.4). */
  private nameSpecies(r: SpeciesRecord): void {
    if (r.namedBy === 'user') return;
    const p = this.records[r.parentId];
    const f = nameFeatures(r.medoid, this.opts.lCeilingM);
    const pf = p ? nameFeatures(p.medoid, this.opts.lCeilingM) : null;
    const inherit = p && p.genus && this.dist(r.medoid, p.founder) < 3 * this.theta ? p.genus : null;
    const b = binomialFor(this.opts.seed ?? 0, r.id, f, pf, inherit, (g) => this.genusTaken.has(g),
      (g, e) => this.epithetTaken.has(`${g} ${e}`));
    r.genus = b.genus; r.epithet = b.epithet; r.common = b.common;
    this.genusTaken.add(b.genus); this.epithetTaken.add(`${b.genus} ${b.epithet}`);
  }

  /** William's rename (07 §6.4): flagged so the generator never overwrites it. */
  rename(id: number, genus: string, epithet: string): void {
    const r = this.records[id];
    if (!r) return;
    r.genus = genus; r.epithet = epithet; r.namedBy = 'user';
    this.genusTaken.add(genus); this.epithetTaken.add(`${genus} ${epithet}`);
  }

  /**
   * View-level threshold (review R14 default answer): cluster the living species' medoids at
   * `theta` by single linkage, returning the lumped group index per species id.
   */
  clusterAt(theta: number): Map<number, number> {
    const live = this.living();
    const parent = live.map((_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!; return i; };
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      if (this.dist(live[i]!.medoid, live[j]!.medoid) < theta) { const a = find(i), b = find(j); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
    }
    const out = new Map<number, number>();
    live.forEach((r, i) => out.set(r.id, find(i)));
    return out;
  }
}

/** Naming features of a genome (developed adult plus a few traits). */
export function nameFeatures(g: Genome, lCeilingM: number): NameFeatures {
  const ph = develop(g, 1, { depth01: 0.5, tempC: 14 }, { maxParts: 64, lCeilingM });
  const counts = new Array<number>(KIND_COUNT).fill(0);
  for (let i = 0; i < ph.nParts; i++) counts[ph.kind[i]!]!++;
  let eyes = 0, photo = 0;
  for (const o of ph.organList) { if (o.kind === 'eye') eyes++; else if (o.kind === 'photophore') photo++; }
  const x1 = trait(g, TI.DIET_PLANT), x2 = trait(g, TI.DIET_DETRITUS);
  const radial = g.links.some((l) => l.symmetry === 2) || ph.subtype[0] === 2;
  return {
    diet: [x1 * (1 - x2), (1 - x1) * (1 - x2), x2], filter: ph.mouth.filter, latch: ph.mouth.latch,
    size: sizeX(ph.adultLengthM),
    segments: counts[0]!, fins: counts[1]!, eyes, spikes: counts[6]!, photophores: photo,
    radial, sessile: trait(g, TI.SESSILE) > 0.5, depth: brainTrait(g, BT.PREF_DEPTH!), glowHue: trait(g, TI.GLOW_HUE),
  };
}
const sizeX = (L: number): number => log(L / 0.0005) / 7.6009024595420822;
