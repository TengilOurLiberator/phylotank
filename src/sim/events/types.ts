/**
 * Event detectors, phase 1 second pass (CONTRACT 11, 06 §6.2.2). Shared types.
 *
 * Every detector here reads world state and primitive events and never writes sim state. They
 * are deterministic anyway (slot order, sorted iteration, no clock), so a replay of the same
 * world and events gives the same derived events, which the director tests rely on.
 *
 * Events carry the CONTRACT 11 fields plus the optional scoring fields below (contract request
 * EV1 in docs/contract-requests/events.md): the director scores on size, novelty, position and
 * duration, and these let it do so without remembering every entity it has ever heard of.
 */
import type { SimEvent, V2, World } from '../../core/index.js';

/** Optional fields the director scores on (contract request EV1). */
export interface ScoreFields {
  /** Where to look (world metres). */
  pos?: V2;
  /** Size of the subject (body length, m) or of the region (radius, m). */
  size?: number;
  /** 0 (seen it before) to 1 (never seen anything like it). */
  novelty?: number;
  /** Sim seconds the phenomenon has lasted so far. */
  durationS?: number;
}

type Phase3 = 'start' | 'update' | 'end';
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Contract = DistOmit<SimEvent, 't' | 'eid' | 'epoch'>;
type Of<K extends Contract['k']> = Extract<Contract, { k: K }>;

/** Kinds this pass adds to CONTRACT 11 (contract request EV2). */
export type NewKinds =
  | { k: 'bloom'; phase: Phase3; pos: V2; radius: number; strength: number; areaM2: number }
  | {
    k: 'lineage'; story: 'founded' | 'radiation' | 'extinct' | 'lineEnded'; species: number; parent: number; depth: number;
    pos: V2; peak: number; descendants: number; cause?: string; daughters?: number;
  };

/** A derived event before the base fields (t, eid, epoch) are stamped. */
export type Derived = (
  | Of<'carcass'> & { phase?: Phase3; massKg?: number; fall?: boolean; feeding?: number }
  | Of<'frenzy'> & { phase?: Phase3; feeding?: number }
  | Of<'migration'> & { phase?: 'start' | 'update'; n?: number; fromY?: number; toY?: number }
  | Of<'bloomFront'> & { dir?: V2; speed?: number }
  | Of<'record'> & { species?: number; prevId?: number }
  | Of<'novelty'> & { plan?: string; nearest?: number }
  | Of<'outbreak'> & { infected?: number }
  | Of<'epidemicFront'> & { speed?: number; dir?: V2 }
  | Of<'newRole'> & { prevRole?: string; lineage?: boolean; n?: number }
  | NewKinds
) & ScoreFields;

export type DerivedKind = Derived['k'];

/** A view over the world computed once per detector run and shared by every detector. */
export interface Scan {
  world: World;
  tick: number;
  /** ALIVE slots in ascending order, `nAlive` of them. */
  alive: Int32Array;
  nAlive: number;
  /** CARCASS slots in ascending order. */
  carcass: Int32Array;
  nCarcass: number;
  /** Uniform grid over ALIVE slots: cell size `cellM`, `gw x gh` cells, counting-sorted. */
  cellM: number;
  gw: number;
  gh: number;
  cellStart: Int32Array;
  cellItems: Int32Array;
  /** Per species aggregates, in first-seen (slot) order. */
  species: Map<number, SpeciesAgg>;
  /** Median adult length (m), 0 if no adults. */
  medianAdultM: number;
}

export interface SpeciesAgg {
  n: number;
  adults: number;
  sx: number;
  sy: number;
  maxLen: number;
  /** First (lowest) slot seen. */
  first: number;
}

/** A detector of the suite. `observe` sees primitive events; `run` sees the shared scan. */
export interface Detector {
  readonly name: string;
  observe?(world: World, events: readonly SimEvent[], out: Derived[]): void;
  run?(scan: Scan, out: Derived[]): void;
}

/** x * x (not `**`). */
export function sq(x: number): number { return x * x; }
