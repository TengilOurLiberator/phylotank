/**
 * Species registry (CONTRACT 5.5: host-side, not SoA). Assignment is the genome module's
 * `distance` against each species' representative (01 §1.9, simplified: the founder is the
 * representative and is never re-centred). The registry lives with the commit because a new
 * species and the last of a species are decided there, in commit order, so the speciation and
 * extinction events are deterministic primitive events.
 */
import type { Genome, V2 } from '../core/index.js';
import type { GenomeStore } from './store.js';

/** Distance above which a child founds a new species (01 THETA_SPECIES). */
export const THETA_SPECIES = 0.3;

export interface SpeciesRecord {
  id: number;
  parent: number;
  /** Genome-store handle of the representative (retained by the registry). */
  rep: number;
  founded: number;
  founders: number[];
  /** Living members (ALIVE and EGG). */
  count: number;
  /** Members ever born. */
  born: number;
  extinctTick: number;
  colour: number;
}

export type DistanceFn = (a: Genome, b: Genome) => number;

export class SpeciesRegistry {
  readonly list: SpeciesRecord[] = [];
  private readonly byId = new Map<number, SpeciesRecord>();
  nextId = 1;

  constructor(private store: GenomeStore, private readonly theta = THETA_SPECIES) {}

  /** Point the registry at a restored genome store (snapshot load). */
  rebind(store: GenomeStore): void { this.store = store; }

  get(id: number): SpeciesRecord | undefined { return this.byId.get(id); }

  /** Found a species with this representative. */
  found(parent: number, repHandle: number, tick: number, founderId: number, colour: number): SpeciesRecord {
    this.store.retain(repHandle);
    const r: SpeciesRecord = {
      id: this.nextId++, parent, rep: repHandle, founded: tick, founders: [founderId], count: 0, born: 0,
      extinctTick: -1, colour,
    };
    this.list.push(r);
    this.byId.set(r.id, r);
    return r;
  }

  /**
   * Species of a child of `parentSpecies` with genome `g`: the parent's species if within
   * theta of its representative, else a new species. Returns [id, isNew].
   */
  assign(parentSpecies: number, g: Genome, handle: number, dist: DistanceFn, tick: number, childId: number, colour: number): [number, boolean] {
    const sp = this.byId.get(parentSpecies);
    if (sp && dist(g, this.store.get(sp.rep)) <= this.theta) return [sp.id, false];
    return [this.found(parentSpecies, handle, tick, childId, colour).id, true];
  }

  /** A member was born (or released). */
  add(id: number): void { const r = this.byId.get(id); if (r) { r.count++; r.born++; } }

  /** A member died. Returns true when it was the last living member. */
  remove(id: number, tick: number): boolean {
    const r = this.byId.get(id);
    if (!r || r.count <= 0) return false;
    r.count--;
    if (r.count === 0) { r.extinctTick = tick; return true; }
    return false;
  }

  living(): SpeciesRecord[] { return this.list.filter((r) => r.count > 0); }

  digestWords(): number[] {
    const out: number[] = [];
    for (const r of this.list) out.push(r.id, r.parent, r.rep, r.count, r.born);
    return out;
  }
}

export type { V2 };

export interface SavedSpecies { nextId: number; list: SpeciesRecord[] }
export function saveSpecies(r: SpeciesRegistry): SavedSpecies {
  return { nextId: r.nextId, list: r.list.map((x) => ({ ...x, founders: [...x.founders] })) };
}
export function loadSpecies(r: SpeciesRegistry, saved: SavedSpecies): void {
  r.nextId = saved.nextId;
  const byId = (r as unknown as { byId: Map<number, SpeciesRecord> }).byId;
  for (const x of saved.list) { const rec = { ...x, founders: [...x.founders] }; r.list.push(rec); byId.set(rec.id, rec); }
}
