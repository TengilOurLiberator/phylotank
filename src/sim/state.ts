/**
 * Per-world sim state that is not SoA (CONTRACT 5.5): the module set, the journal, the genome
 * store, the species registry, the event buffer and the ledger statistics. Held in a WeakMap
 * keyed by the World, so the World type stays the contract's.
 */
import {
  LEDGER_CHANNELS, RngStreams, type BrainModule, type EcosystemModule, type EventSink, type GenomeModule,
  type GodEventScheduled, type PhysicsModule, type SimEvent, type World,
} from '../core/index.js';
import { SpeciesRegistry } from './species.js';
import { GenomeStore } from './store.js';

export interface SimModules {
  genome: GenomeModule;
  physics: PhysicsModule;
  brain: BrainModule;
  ecosystem: EcosystemModule;
}

/** A governor decision (CONTRACT 4.4). Applied only on ticks with tick % GOVERNOR_EVERY == 0. */
export interface GovernorDecision { brainDiv?: 1 | 2 | 3; popSoftLimit?: number }

/** A creature release (CONTRACT 13 `release`), journalled like a god event. */
export interface ReleaseEntry {
  cmdId: string;
  genome: Uint8Array;
  pos: [number, number];
  /** Half-extents of the release area around `pos` (default 0.2 m). */
  spread?: [number, number];
  count: number;
  asLeviathan: boolean;
  founderProtection: boolean;
}

/** Journal entry applied at the start of its tick (CONTRACT 4.4, 10.1 step 0, 13). */
export type JournalEntry =
  | { tick: number; kind: 'god'; ev: GodEventScheduled }
  | { tick: number; kind: 'governor'; decision: GovernorDecision }
  | { tick: number; kind: 'release'; release: ReleaseEntry };

export interface SimState {
  modules: SimModules;
  rng: RngStreams;
  events: SimEvent[];
  sink: EventSink;
  /** Pending entries, sorted by (tick, seq). */
  journal: (JournalEntry & { seq: number })[];
  /** Entries already applied, in order (for persistence and replay). */
  applied: JournalEntry[];
  seq: number;
  store: GenomeStore;
  species: SpeciesRegistry;
  /** n_agents = live + eggs + carcasses at the start of the current tick (CONTRACT 9.6). */
  nAgentsAtTickStart: number;
  /** Births deferred at the agent cap (statistics). */
  deferredBirths: number;
  /** Population soft limit from the governor (0 = none). */
  popSoftLimit: number;
  /** Ledger statistics per channel, accumulated since the last drain (CONTRACT 9.7). */
  channels: Float64Array;
  /** (tick, hash) checkpoints every HASH_EVERY ticks when enabled. */
  hashLog: { tick: number; hash: bigint }[];
  hashEvery: number;
}

const states = new WeakMap<World, SimState>();

export function initState(world: World, modules: SimModules, hashEvery = 0): SimState {
  const events: SimEvent[] = [];
  const sink: EventSink = {
    emit(ev) {
      events.push({ ...ev, t: world.g.tick, eid: world.g.nextEventId++, epoch: world.g.epoch } as SimEvent);
    },
  };
  const store = new GenomeStore();
  const s: SimState = {
    modules, rng: new RngStreams(world.g.seedLo, world.g.seedHi), events, sink, journal: [], applied: [], seq: 0,
    store, species: new SpeciesRegistry(store), nAgentsAtTickStart: 0, deferredBirths: 0, popSoftLimit: 0,
    channels: new Float64Array(LEDGER_CHANNELS.length), hashLog: [], hashEvery,
  };
  states.set(world, s);
  return s;
}

export function stateOf(world: World): SimState {
  const s = states.get(world);
  if (!s) throw new Error('world was not created by src/sim');
  return s;
}

export function hasState(world: World): boolean { return states.has(world); }

export const CH = Object.fromEntries(LEDGER_CHANNELS.map((n, i) => [n, i])) as Record<(typeof LEDGER_CHANNELS)[number], number>;
