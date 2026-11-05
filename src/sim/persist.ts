/**
 * Snapshot support for the sim's non-SoA state (CONTRACT 14.1, request S2 and B2): the genome
 * store, the species registry, the request queues, the journal counters and the per-world genome
 * registry. The host writes `exportSimState` as the `.ptk` section SIMS and calls `adoptWorld`
 * after it has restored the SoA pools, so a loaded world steps exactly like the original.
 *
 * Module state that lives outside the pools is rebuilt here too: brains through
 * `BrainModule.rehydrate` (from the genome and the phenotype at the creature's maturity).
 * Physics keeps its persistent state in pool columns since phase 2 (request P1); its pending
 * bites and its cross-creature links (bites, grabs, latches) travel here. The real ecosystem's
 * side state travels as `eco` (request E4). Tested: a restored world steps bit for bit.
 */
import { decodeGenome, LIFE, type CborValue, type World } from '../core/index.js';
import { ecosystem as realEcosystem, restoreEcoState, saveEcoState } from '../ecosystem/index.js';
import { contactState, linkState, type BiteRecord, type Link } from '../physics/index.js';
import { birthEnvFor, developOpts } from './commit.js';
import { requestsOf, type SimRequests } from './requests.js';
import { loadSpecies, saveSpecies, type SavedSpecies } from './species.js';
import { initState, stateOf, type JournalEntry, type SimModules } from './state.js';
import { loadStore, saveStore, type SavedStore } from './store.js';

export const SIM_STATE_VERSION = 1;

export interface SavedSim {
  v: number;
  store: SavedStore;
  species: SavedSpecies;
  requests: SimRequests;
  seq: number;
  deferredBirths: number;
  popSoftLimit: number;
  nAgentsAtTickStart: number;
  hashEvery: number;
  /** The world's innovation registry, when the genome module has one (request G2). */
  registry?: unknown;
  /** Journal entries not yet applied (the host also keeps them in EVTQ). */
  pending: JournalEntry[];
  /** The real ecosystem's side state (request E4), when the world uses it. */
  eco?: CborValue;
  /** Bites physics recorded since the last ecology tick (request P3 queue). */
  bites?: BiteRecord[];
  /** Physics links between creatures (bites, grabs, latches). */
  links?: Link[];
}

interface WithRegistry { registry?: { save(): unknown } }

export function exportSimState(world: World): SavedSim {
  const s = stateOf(world);
  const q = requestsOf(world);
  const reg = (s.modules.genome as WithRegistry).registry;
  return {
    v: SIM_STATE_VERSION,
    store: saveStore(s.store),
    species: saveSpecies(s.species),
    requests: {
      births: q.births.map((b) => ({ ...b })), deaths: q.deaths.map((d) => ({ ...d })),
      deferred: q.deferred.map((b) => ({ ...b })), restages: [...q.restages],
    },
    seq: s.seq, deferredBirths: s.deferredBirths, popSoftLimit: s.popSoftLimit,
    nAgentsAtTickStart: s.nAgentsAtTickStart, hashEvery: s.hashEvery,
    ...(reg ? { registry: reg.save() } : {}),
    ...(s.modules.ecosystem === realEcosystem ? { eco: saveEcoState(world) } : {}),
    bites: contactState(world).bites.map((b) => ({ ...b })),
    links: linkState(world).links.map((l) => ({ ...l })),
    pending: s.journal.map(({ seq, ...e }) => { void seq; return e as JournalEntry; }),
  };
}

/**
 * Attach sim state to a world whose pools were restored from a snapshot. `modules` is the
 * module set of the SimCore that will step it (per-world genome modules are rebuilt from the
 * saved registry through `genomeFor`). Without `saved` (an old file), the store is rebuilt
 * from nothing, which only works for worlds without genome handles (phase-0 motes).
 */
export function adoptWorld(world: World, modules: SimModules, saved?: SavedSim | null): void {
  const mods: SimModules = { ...modules };
  if (modules.genomeFor) mods.genome = modules.genomeFor(saved?.registry);
  const st = initState(world, mods, saved?.hashEvery ?? 0);
  if (mods.ecosystem === realEcosystem) restoreEcoState(world, saved?.eco);
  if (!saved) return;
  if (saved.v !== SIM_STATE_VERSION) throw new Error(`unknown sim state version ${saved.v}`);
  st.store = loadStore(saved.store, decodeGenome);
  st.species.rebind(st.store);
  loadSpecies(st.species, saved.species);
  const q = requestsOf(world);
  q.births.push(...saved.requests.births); q.deaths.push(...saved.requests.deaths);
  q.deferred.push(...saved.requests.deferred); q.restages.push(...saved.requests.restages);
  st.seq = 0;
  for (const e of saved.pending) st.journal.push({ ...e, seq: st.seq++ });
  st.seq = Math.max(st.seq, saved.seq);
  st.deferredBirths = saved.deferredBirths;
  if (saved.bites) contactState(world).bites.push(...saved.bites.map((b) => ({ ...b })));
  if (saved.links) linkState(world).links.push(...saved.links.map((l) => ({ ...l })));
  st.popSoftLimit = saved.popSoftLimit;
  st.nAgentsAtTickStart = saved.nAgentsAtTickStart;
  // brains: rebuild the derived constants of every brained creature (request B2)
  const rehydrate = mods.brain.rehydrate;
  if (rehydrate) {
    const c = world.cr.c;
    for (let s = 0; s < world.cr.highWater; s++) {
      if (c.life[s] !== LIFE.ALIVE) continue;
      const g = st.store.get(c.genome[s]!);
      const ph = mods.genome.develop(g, c.brainStage[s]!, birthEnvFor(world, c.birthY[s]!), developOpts(world));
      rehydrate.call(mods.brain, world, s, ph, g);
    }
  }
}

export type { CborValue };
