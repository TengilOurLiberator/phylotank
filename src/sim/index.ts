/**
 * src/sim: world creation, the tick pipeline (CONTRACT 10.1), journal application, birth and
 * death commit, state hash. Runs unchanged in a Web Worker, in the Node host and in tests.
 * Wall-clock pacing lives in pacer.ts, outside the deterministic step.
 */
import {
  allocWorld, ECO_EVERY, hashWorld, LIFE, packRGBA, RngStreams, RNG_STREAM, SLOW_EVERY, splitU64, TAU,
  type EventSink, type GodEventScheduled, type SimCore, type SimEvent, type SimEventKind, type StepContext, type World,
  type WorldConfig,
} from '../core/index.js';
import { brain } from '../brain/index.js';
import { ecosystem } from '../ecosystem/index.js';
import { physics } from '../physics/index.js';

export { brain, ecosystem, physics };

/** Journal entry applied at a tick (CONTRACT 4.4, 13). */
export type JournalEntry =
  | { tick: number; kind: 'god'; ev: GodEventScheduled }
  | { tick: number; kind: 'governor'; decision: { brainDiv?: 1 | 2 | 3 } };

interface SimState {
  rng: RngStreams;
  events: SimEvent[];
  sink: EventSink;
  journal: JournalEntry[];
}
const state = new WeakMap<World, SimState>();

function st(world: World): SimState {
  let s = state.get(world);
  if (!s) {
    const events: SimEvent[] = [];
    const sink: EventSink = {
      emit(ev) {
        events.push({ ...ev, t: world.g.tick, eid: world.g.nextEventId++, epoch: world.g.epoch } as SimEvent);
      },
    };
    s = { rng: new RngStreams(world.g.seedLo, world.g.seedHi), events, sink, journal: [] };
    state.set(world, s);
  }
  return s;
}

export function contextFor(world: World): StepContext {
  const s = st(world);
  return { tick: world.g.tick, config: world.config, rng: s.rng, events: s.sink };
}

/** Take the events emitted since the last drain. */
export function drainEvents(world: World): SimEvent[] {
  const s = st(world);
  return s.events.splice(0, s.events.length);
}

/** Queue a journalled input. It is applied at the start of its tick (CONTRACT 10.1 step 0). */
export function schedule(world: World, entry: JournalEntry): void {
  if (entry.tick < world.g.tick) throw new Error(`journal entry for past tick ${entry.tick}`);
  const j = st(world).journal;
  j.push(entry);
  j.sort((a, b) => a.tick - b.tick);
}

/** Allocate a creature slot (lowest free first, CONTRACT 4.2 rule 4) with a fresh entity id. */
export function allocCreature(world: World): number {
  const c = world.cr.c;
  let slot = -1;
  for (let s = 0; s < world.cr.highWater; s++) if (c.life[s] === LIFE.FREE) { slot = s; break; }
  if (slot < 0) {
    if (world.cr.highWater >= world.cr.capacity) return -1;
    slot = world.cr.highWater++;
  }
  const id = world.g.nextEntityId++;
  const [lo, hi] = splitU64(id);
  c.idLo[slot] = lo;
  c.idHi[slot] = hi;
  c.gen[slot] = (c.gen[slot]! + 1) & 0xffff;
  c.birthTick[slot] = world.g.tick;
  return slot;
}

/** Phase-0 skeleton colours (RGB, 0..255) for the eight mote "species". */
export const SKELETON_COLOURS: readonly (readonly [number, number, number])[] = [
  [90, 230, 255], [60, 255, 200], [120, 160, 255], [190, 120, 255],
  [255, 120, 220], [140, 255, 120], [255, 200, 110], [100, 200, 255],
];

/** Phase-0 skeleton: passive glowing motes with no body, brain or mass. */
function seedMotes(world: World, n: number, ctx: StepContext): void {
  const c = world.cr.c;
  const W = world.preset.widthM;
  const H = world.preset.heightM;
  for (let i = 0; i < n; i++) {
    const slot = allocCreature(world);
    if (slot < 0) break;
    const d = ctx.rng.draw(RNG_STREAM.SKELETON, 0, c.idLo[slot]!);
    c.life[slot] = LIFE.ALIVE;
    c.posX[slot] = 0.2 + d.u01() * (W - 0.4);
    // more life near the lit surface, thinning with depth
    const u = d.u01();
    c.posY[slot] = 0.2 + u * u * (H - 0.4);
    c.heading[slot] = d.u01() * TAU;
    c.species[slot] = Math.floor(d.u01() * 8);
    c.length[slot] = 0.001 + 0.004 * d.u01();
    c.glow[slot] = 0.25 + 0.75 * d.u01() * d.u01();
    const [r, gg, b] = SKELETON_COLOURS[c.species[slot]!]!;
    c.colour[slot] = packRGBA(r, gg, b);
    c.segCount[slot] = 0;
    world.g.liveCount++;
  }
}

export const sim: SimCore = {
  create(config: WorldConfig): World {
    const world = allocWorld(config);
    const ctx = contextFor(world);
    ecosystem.initWorld(world, ctx);
    if (config.skeletonMotes) seedMotes(world, config.skeletonMotes, ctx);
    return world;
  },

  step(world: World): void {
    const s = st(world);
    const tick = world.g.tick;
    const ctx = contextFor(world);
    // 0. journal inputs due now
    while (s.journal.length > 0 && s.journal[0]!.tick === tick) {
      const e = s.journal.shift()!;
      if (e.kind === 'god') ecosystem.applyGodEvent(world, e.ev, ctx);
      else if (e.decision.brainDiv) world.g.brainDiv = e.decision.brainDiv;
    }
    // 1 to 3
    brain.sense(world, ctx);
    brain.think(world, ctx);
    physics.step(world, ctx);
    // 4. ecology and the birth and death commit
    if (tick % ECO_EVERY === 0) {
      ecosystem.stepEcology(world, ctx);
      commitBirthsAndDeaths(world, ctx);
    }
    // 5. flow, light and temperature
    if (tick % SLOW_EVERY === 0) ecosystem.stepSlow(world, ctx);
    // 6.
    world.g.tick = tick + 1;
  },

  hash(world: World): bigint {
    return hashWorld(world);
  },
};

/** Birth and death commit (CONTRACT 9.6). Phase 0 has no births or deaths yet. */
function commitBirthsAndDeaths(world: World, ctx: StepContext): void {
  void world; void ctx;
}

export { dayPhase, yearPhase } from './clocks.js';
export type { SimEventKind };
export { encodeViewFrames, envFrameFor } from './frames.js';
