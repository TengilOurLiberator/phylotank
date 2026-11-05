/**
 * src/sim: world creation, the tick pipeline (CONTRACT 10.1), journal application, birth and
 * death commit, state hash. Runs unchanged in a Web Worker, in the Node host and in tests.
 * Wall-clock pacing lives in pacer.ts, outside the deterministic step.
 *
 * The pipeline talks to the other modules only through their contract interfaces
 * (`SimModules`). `createSim(modules)` builds a SimCore over any module set; the default
 * `sim` uses the local fallbacks in ./fallback, so the pipeline runs end to end before the
 * real genome, physics, brain and ecosystem modules land. The integrator passes the real
 * modules to `createSim` (see docs/modules/sim.md).
 */
import {
  allocWorld, CF, ECO_EVERY, encodeGenome, GOVERNOR_EVERY, HASH_EVERY, hashWorld, LIFE, NotImplementedError,
  SLOW_EVERY, xxh64Parts,
  type GodEventScheduled, type SimCore, type SimEvent, type SimEventKind, type StepContext, type TemplateId,
  type World, type WorldConfig,
} from '../core/index.js';
import { commitBirthsAndDeaths, release, type ReleaseResult } from './commit.js';
import { adoptWorld, type SavedSim } from './persist.js';
import { fallbackBrain } from './fallback/brain.js';
import { withFallbackLife } from './fallback/ecology.js';
import { fallbackGenome } from './fallback/genome.js';
import { fallbackPhysics } from './fallback/physics.js';
import { requestsOf } from './requests.js';
import { initState, stateOf, type GovernorDecision, type JournalEntry, type ReleaseEntry, type SimModules } from './state.js';

export type { GovernorDecision, JournalEntry, ReleaseEntry, SimModules };
export type { ReleaseResult };
export { allocCreature, compactSegments, freeCreature, killNow, offspringCost, release } from './commit.js';
export { entityId, requestBirth, requestDeath, requestRestage, requestsOf } from './requests.js';
export type { BirthRequest, DeathRequest } from './requests.js';
export { stateOf } from './state.js';
export { adoptWorld, exportSimState, SIM_STATE_VERSION, type SavedSim } from './persist.js';

/** Founders seeded at world creation (a sim-local extension of WorldConfig, see the contract request). */
export interface FounderSpec { template: TemplateId; count: number; genome?: Uint8Array }
export interface SimConfig extends WorldConfig {
  founders?: FounderSpec[];
  /** Record a state hash every HASH_EVERY ticks (about 50 ms per hash on Small). */
  hashCheckpoints?: boolean;
}

/** The local fallback module set (phase 1). */
export function fallbackModules(): SimModules {
  return { genome: fallbackGenome, physics: fallbackPhysics, brain: fallbackBrain, ecosystem: withFallbackLife() };
}

export function contextFor(world: World): StepContext {
  const s = stateOf(world);
  return { tick: world.g.tick, config: world.config, rng: s.rng, events: s.sink };
}

/** Take the events emitted since the last drain. */
export function drainEvents(world: World): SimEvent[] {
  const s = stateOf(world);
  return s.events.splice(0, s.events.length);
}

/** Take the ledger channel tallies since the last drain (CONTRACT 9.7). */
export function drainChannels(world: World): Float64Array {
  const s = stateOf(world);
  const out = s.channels.slice();
  s.channels.fill(0);
  return out;
}

/**
 * Queue a journalled input, applied at the start of its tick (CONTRACT 10.1 step 0). Entries
 * for one tick apply in the order they were scheduled. Governor decisions are refused off
 * GOVERNOR_EVERY ticks (CONTRACT 4.4).
 */
export function schedule(world: World, entry: JournalEntry): void {
  if (!Number.isSafeInteger(entry.tick) || entry.tick < world.g.tick) throw new Error(`journal entry for past tick ${entry.tick}`);
  if (entry.kind === 'governor' && entry.tick % GOVERNOR_EVERY !== 0) {
    throw new Error(`governor decision at tick ${entry.tick} is not on a GOVERNOR_EVERY boundary`);
  }
  const s = stateOf(world);
  const e = { ...entry, seq: s.seq++ };
  const j = s.journal;
  let i = j.length;
  while (i > 0 && j[i - 1]!.tick > e.tick) i--;
  j.splice(i, 0, e);
}

/** Journal entries applied so far (the replay log), in application order. */
export function appliedJournal(world: World): readonly JournalEntry[] { return stateOf(world).applied; }
/** Hash checkpoints recorded so far (when `hashCheckpoints` is on). */
export function hashLog(world: World): readonly { tick: number; hash: bigint }[] { return stateOf(world).hashLog; }

const releaseResults = new WeakMap<World, Map<string, ReleaseResult>>();
/** Result of a journalled release once its tick has run, for COMMAND_RESULT. */
export function releaseResult(world: World, cmdId: string): ReleaseResult | undefined { return releaseResults.get(world)?.get(cmdId); }

function applyEntry(world: World, e: JournalEntry, ctx: StepContext): void {
  const s = stateOf(world);
  if (e.kind === 'god') applyGod(world, e.ev, ctx);
  else if (e.kind === 'governor') {
    if (e.decision.brainDiv) world.g.brainDiv = e.decision.brainDiv;
    if (e.decision.popSoftLimit !== undefined) s.popSoftLimit = e.decision.popSoftLimit;
  } else {
    const r = release(world, ctx, e.release, true);
    let m = releaseResults.get(world);
    if (!m) { m = new Map(); releaseResults.set(world, m); }
    m.set(e.release.cmdId, r);
  }
  s.applied.push(e);
}

function applyGod(world: World, ev: GodEventScheduled, ctx: StepContext): void {
  const s = stateOf(world);
  try {
    s.modules.ecosystem.applyGodEvent(world, ev, ctx);
  } catch (err) {
    // the phase-0 ecosystem records the modifier and throws: keep the world running
    if (!(err instanceof NotImplementedError)) throw err;
  }
  const pos: [number, number] = ev.target.kind === 'point' || ev.target.kind === 'circle'
    ? [ev.target.pos[0], ev.target.pos[1]] : [world.preset.widthM / 2, world.preset.heightM / 2];
  s.sink.emit({
    k: 'god', cmdId: ev.cmdId, power: ev.power, author: ev.author, tFire: ev.fireTick, pos,
    radius: ev.target.kind === 'circle' ? ev.target.radius : 0, strength: ev.intensity, major: false,
  } as never);
}

/** The actuate stage between think and physics: NaN outputs become 0, all clamp to [-1, 1]. */
function actuate(world: World): void {
  const out = world.cr.c.out;
  const n = world.cr.highWater * 8;
  for (let i = 0; i < n; i++) {
    const v = out[i]!;
    if (v !== v) out[i] = 0; else if (v > 1) out[i] = 1; else if (v < -1) out[i] = -1;
  }
  const sg = world.seg.c;
  const m = world.seg.highWater;
  for (let k = 0; k < m; k++) {
    const a = sg.cmd[k]!;
    if (a !== a) sg.cmd[k] = 0; else if (a > 1) sg.cmd[k] = 1; else if (a < -1) sg.cmd[k] = -1;
    const b = sg.cmd2[k]!;
    if (b !== b) sg.cmd2[k] = 0; else if (b > 1) sg.cmd2[k] = 1; else if (b < -1) sg.cmd2[k] = -1;
    for (let l = 2 * k; l < 2 * k + 2; l++) {
      const d = sg.cmd3[l]!;
      if (d !== d) sg.cmd3[l] = 0; else if (d > 1) sg.cmd3[l] = 1; else if (d < -1) sg.cmd3[l] = -1;
    }
  }
}

/** Build a SimCore over a module set; missing modules take the local fallbacks. */
/** A SimCore with its module set and snapshot adoption (see persist.ts). */
export interface SimCoreWithModules extends SimCore {
  readonly modules: SimModules;
  /** Attach sim state to a world restored from a snapshot (pools already loaded). */
  adopt(world: World, saved?: SavedSim | null): void;
}

export function createSim(modules: Partial<SimModules> = {}): SimCoreWithModules {
  const mods: SimModules = { ...fallbackModules(), ...modules };
  return {
    modules: mods,
    adopt(world: World, saved?: SavedSim | null): void { adoptWorld(world, mods, saved); },
    create(config: WorldConfig): World {
      const cfg = config as SimConfig;
      const world = allocWorld(config);
      const perWorld: SimModules = mods.genomeFor ? { ...mods, genome: mods.genomeFor() } : mods;
      const st = initState(world, perWorld, cfg.hashCheckpoints ? HASH_EVERY : 0);
      const ctx = contextFor(world);
      perWorld.ecosystem.initWorld(world, ctx);
      const founders: FounderSpec[] = cfg.founders ?? (cfg.skeletonMotes ? [{ template: 'motefly', count: cfg.skeletonMotes }] : []);
      founders.forEach((f, i) => {
        const g = f.genome ?? encodeGenome(perWorld.genome.template(f.template));
        // one species per founder group, spread over the upper half; mass from the dissolved N under them
        const W = world.preset.widthM;
        const H = world.preset.heightM;
        release(world, ctx, {
          cmdId: `founders-${i}`, genome: g, pos: [W / 2, H * 0.3], spread: [W / 2 - 0.3, H * 0.25], count: f.count,
          asLeviathan: false, founderProtection: false,
        }, false);
      });
      drainEvents(world); // founder releases are not news
      st.nAgentsAtTickStart = world.g.liveCount + world.g.eggCount + world.g.carcassCount;
      return world;
    },

    step(world: World): void {
      const s = stateOf(world);
      const { brain, physics, ecosystem } = s.modules;
      const tick = world.g.tick;
      const ctx = contextFor(world);
      s.nAgentsAtTickStart = world.g.liveCount + world.g.eggCount + world.g.carcassCount;
      // 0. journal inputs due now
      while (s.journal.length > 0 && s.journal[0]!.tick === tick) {
        const { seq, ...e } = s.journal.shift()!;
        void seq;
        applyEntry(world, e as JournalEntry, ctx);
      }
      // 1 to 3: sense, think, actuate, physics (contacts, bites and grabs inside)
      brain.sense(world, ctx);
      brain.think(world, ctx);
      actuate(world);
      physics.step(world, ctx);
      // 4. ecology at 10 Hz (eat, digest, metabolism, growth, requests), then the commit
      if (tick % ECO_EVERY === 0) {
        ecosystem.stepEcology(world, ctx);
        commitBirthsAndDeaths(world, ctx);
      }
      // 5. flow, light and temperature at 2 Hz
      if (tick % SLOW_EVERY === 0) ecosystem.stepSlow(world, ctx);
      // 6. tick += 1; hash checkpoint on the new tick
      world.g.tick = tick + 1;
      if (s.hashEvery > 0 && world.g.tick % s.hashEvery === 0) s.hashLog.push({ tick: world.g.tick, hash: hashWorld(world) });
    },

    hash(world: World): bigint {
      return hashWorld(world);
    },
  };
}

/** The default SimCore over the local fallback modules. */
export const sim: SimCoreWithModules = createSim();

/**
 * Digest of the non-SoA sim state that the contract hash does not cover: the genome store,
 * the species registry, pending requests and the journal position.
 */
export function stateDigest(world: World): bigint {
  const s = stateOf(world);
  const q = requestsOf(world);
  const words = [
    ...s.store.digestWords(), ...s.species.digestWords(), q.births.length, q.deaths.length, q.deferred.length,
    s.journal.length, s.applied.length, s.popSoftLimit,
  ];
  const [h, l] = xxh64Parts(new Uint8Array(new Float64Array(words).buffer));
  return (BigInt(h) << 32n) | BigInt(l);
}

/** Living creatures by species, in species order (census and tests). */
export function census(world: World): { species: number; count: number; biomassKg: number; colour: number }[] {
  const s = stateOf(world);
  const c = world.cr.c;
  const by = new Map<number, { count: number; biomassKg: number }>();
  for (let k = 0; k < world.cr.highWater; k++) {
    if (c.life[k] !== LIFE.ALIVE) continue;
    const r = by.get(c.species[k]!) ?? { count: 0, biomassKg: 0 };
    r.count++; r.biomassKg += c.massKg[k]!;
    by.set(c.species[k]!, r);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([species, r]) => ({
    species, ...r, colour: s.species.get(species)?.colour ?? 0,
  }));
}

export { dayPhase, yearPhase } from './clocks.js';
/** Re-exported for the host, which may import only src/sim (CONTRACT 16). */
export { ecosystem } from '../ecosystem/index.js';
export type { SimEventKind };
export { encodeViewFrames, envFrameFor } from './frames.js';
export { CF };
