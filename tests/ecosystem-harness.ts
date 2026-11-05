/**
 * A minimal stand-in for the sim, for ecosystem tests and spike 3: it allocates worlds, seeds
 * creatures with trait vectors (no genome module, no physics, no brains), moves them with the
 * water plus a seeded swim, and commits births and frees through `commitPending`.
 * Test-only code: it lives outside src/ and never feeds the real sim.
 */
import {
  allocWorld, clearSlot, defaultQ, encodeQ, hashWorld, LIFE, RngStreams, RNG_STREAM, splitU64, T, TRAITS, TRAIT_COUNT,
  DT, ECO_EVERY, SLOW_EVERY, Q_MASS, M_REF_1M,
  type EventSink, type SimEvent, type StepContext, type World, type WorldConfig, type GodEventScheduled,
} from '../src/core/index.js';
import {
  commitPending, ecosystem, ecoState, endowCreatureEco, loadCreatureEco, type BirthRequest, type CommitHooks,
} from '../src/ecosystem/index.js';

export interface Harness {
  world: World; rng: RngStreams; events: SimEvent[]; traits: Map<number, Uint16Array>;
  ctx(): StepContext;
  step(n?: number): void;
  spawn(opts: SpawnOpts): number;
  /** Optional per-birth trait mutation (spike 3). */
  mutate?: (parent: Uint16Array, childId: number) => Uint16Array;
  births: number; deaths: number;
  powerFactor: number;
  pending: GodEventScheduled[];
}
export interface SpawnOpts {
  x: number; y: number; lengthM: number; traits?: Partial<Record<string, number>>; q?: Uint16Array; species?: number;
  maturity?: number; filter?: number; scrape?: number; immigrantTick?: number; reserveFrac?: number;
}

export function traitsQ(over: Partial<Record<string, number>> = {}): Uint16Array {
  const q = new Uint16Array(TRAIT_COUNT);
  for (let i = 0; i < TRAIT_COUNT; i++) q[i] = defaultQ(TRAITS, i);
  for (const [k, v] of Object.entries(over)) q[T[k]!] = encodeQ(v!, TRAITS[T[k]!]!);
  return q;
}

export function makeHarness(cfg: Partial<WorldConfig> & { habitat?: string } = {}): Harness {
  const config = { preset: 'small', seedLo: 11, seedHi: 3, backend: 'cpu', ...cfg } as WorldConfig;
  const world = allocWorld(config);
  const rng = new RngStreams(world.g.seedLo, world.g.seedHi);
  const events: SimEvent[] = [];
  const sink: EventSink = { emit(ev) { events.push({ ...ev, t: world.g.tick, eid: world.g.nextEventId++, epoch: 0 } as SimEvent); } };
  const traits = new Map<number, Uint16Array>();
  const H: Harness = {
    world, rng, events, traits, births: 0, deaths: 0, powerFactor: 1, pending: [],
    ctx: () => ({ tick: world.g.tick, config: world.config, rng, events: sink }),
    spawn(o) { return spawnCreature(H, o); },
    step(n = 1) {
      for (let k = 0; k < n; k++) {
        const ctx = H.ctx();
        const tick = world.g.tick;
        while (H.pending.length > 0 && H.pending[0]!.fireTick === tick) ecosystem.applyGodEvent(world, H.pending.shift()!, ctx);
        moveCreatures(H, ctx);
        if (tick % ECO_EVERY === 0) {
          ecosystem.stepEcology(world, ctx);
          const before = world.g.liveCount;
          commitPending(world, ctx, hooks(H));
          H.births += Math.max(0, world.g.liveCount - before);
        }
        if (tick % SLOW_EVERY === 0) ecosystem.stepSlow(world, ctx);
        world.g.tick = tick + 1;
      }
    },
  };
  ecosystem.initWorld(world, H.ctx());
  return H;
}

function allocSlot(world: World): number {
  const c = world.cr.c;
  let slot = -1;
  for (let s = 0; s < world.cr.highWater; s++) if (c.life[s] === LIFE.FREE) { slot = s; break; }
  if (slot < 0) { if (world.cr.highWater >= world.cr.capacity) return -1; slot = world.cr.highWater++; }
  clearSlot(world.cr as never, slot);
  const id = world.g.nextEntityId++;
  const [lo, hi] = splitU64(id);
  c.idLo[slot] = lo; c.idHi[slot] = hi;
  c.birthTick[slot] = world.g.tick;
  return slot;
}

function mouthFor(L: number, filter: number, scrape: number) {
  return { filter, scrape, bite: 0, suction: 0, latch: 0, gape: 0.3 * L, biteForce: 0, mesh: 1e-4 };
}

export function spawnCreature(H: Harness, o: SpawnOpts): number {
  const w = H.world;
  const slot = allocSlot(w);
  if (slot < 0) return -1;
  const c = w.cr.c;
  const q = o.q ?? traitsQ({ ADULT_LENGTH: o.lengthM, ...(o.traits ?? {}) });
  c.life[slot] = LIFE.ALIVE;
  c.posX[slot] = o.x; c.posY[slot] = o.y;
  c.species[slot] = o.species ?? 1;
  c.immuneKey[slot] = 0x0f0f0f0f; c.surfaceSig[slot] = 0x12345678 ^ (o.species ?? 1);
  c.adultLength[slot] = Math.min(o.lengthM, w.lCeilingM);
  H.traits.set(slot, q);
  const L = c.adultLength[slot]!;
  loadCreatureEco(w, slot, {
    traits: q, phenotype: { mouth: mouthFor(L, o.filter ?? 1, o.scrape ?? 0.5), gGut: 0.5, gutVolume: (0.08 * M_REF_1M * L * L * L) / 1060 },
    ...(o.immigrantTick !== undefined ? { immigrantTick: o.immigrantTick } : {}),
  });
  const m = M_REF_1M * L * L * L * (o.maturity ?? 0.6) ** 3;
  w.g.liveCount++;
  if (!endowCreatureEco(w, slot, m, m * (o.reserveFrac ?? 0.2))) { c.life[slot] = LIFE.FREE; w.g.liveCount--; return -1; }
  return slot;
}

function hooks(H: Harness): CommitHooks {
  const w = H.world;
  const c = w.cr.c;
  return {
    spawnChild(req: BirthRequest) {
      const slot = allocSlot(w);
      if (slot < 0) return -1;
      const p = req.parentSlot;
      const id = c.idLo[slot]! + c.idHi[slot]! * 4294967296;
      const pq = H.traits.get(p)!;
      const q = H.mutate ? H.mutate(pq, id) : pq;
      H.traits.set(slot, q);
      c.life[slot] = LIFE.ALIVE;
      const d = H.rng.draw(RNG_STREAM.BIRTH, w.g.tick, id);
      c.posX[slot] = Math.min(w.preset.widthM - 0.3, Math.max(0.3, c.posX[p]! + (d.u01() - 0.5) * 0.2));
      c.posY[slot] = Math.min(w.preset.heightM - 0.3, Math.max(0.3, c.posY[p]! + (d.u01() - 0.5) * 0.2));
      c.species[slot] = c.species[p]!;
      c.immuneKey[slot] = c.immuneKey[p]!; c.surfaceSig[slot] = c.surfaceSig[p]!;
      const L = Math.min(decodeLen(q), w.lCeilingM);
      c.adultLength[slot] = L;
      loadCreatureEco(w, slot, { traits: q, phenotype: { mouth: mouthFor(L, 1, 0.5), gGut: 0.5, gutVolume: (0.08 * M_REF_1M * L * L * L) / 1060 } });
      w.g.liveCount++;
      return slot;
    },
    freeSlot(slot) {
      if (c.life[slot] === LIFE.ALIVE) w.g.liveCount--;
      c.life[slot] = LIFE.FREE;
      H.traits.delete(slot);
      clearSlot(w.cr as never, slot);
    },
  };
}

function decodeLen(q: Uint16Array): number {
  const s = TRAITS[T.ADULT_LENGTH!]!;
  return s.min * Math.exp((q[T.ADULT_LENGTH!]! / 65535) * Math.log(s.max / s.min));
}

/** Passive drift with the water plus a seeded swim at about one body length per second. */
function moveCreatures(H: Harness, ctx: StepContext): void {
  const w = H.world;
  const c = w.cr.c;
  const f = w.fields;
  const [cw, ch] = f.coarse;
  const cs = w.preset.widthM / cw;
  const st = ctx.rng.stream(RNG_STREAM.PHYSICS);
  const blk = new Uint32Array(4);
  const [sw, sh] = f.sdfGrid;
  const ss = w.preset.widthM / sw;
  for (let s = 0; s < w.cr.highWater; s++) {
    const life = c.life[s]!;
    if (life === LIFE.FREE) continue;
    const ix = Math.min(cw - 1, Math.max(0, Math.floor(c.posX[s]! / cs))), iy = Math.min(ch - 1, Math.max(0, Math.floor(c.posY[s]! / cs)));
    let vx = f.flowU[iy * cw + ix]!, vy = f.flowV[iy * cw + ix]!;
    if (life === LIFE.ALIVE) {
      st.block(ctx.tick >>> 6, c.idLo[s]!, 0, blk);
      const th = (blk[0]! / 4294967296) * 6.283185307179586;
      const sp = c.length[s]! * 1;
      const sx = sp * Math.cos(th), sy = sp * Math.sin(th);
      vx += sx; vy += sy;
      c.velX[s] = sx; c.velY[s] = sy;
      // swimming power: twice basal-scale, 1 W/kg of body at 1 body length per second (crude)
      c.powerW[s] = H.powerFactor * 0.3 * Math.pow(Math.max(c.massKg[s]!, 1e-12), 0.75);
    } else vy += 0.002; // carcasses sink slowly
    let nx = c.posX[s]! + vx * DT, ny = c.posY[s]! + vy * DT;
    nx = Math.min(w.preset.widthM - 0.05, Math.max(0.05, nx));
    ny = Math.min(w.preset.heightM - 0.05, Math.max(w.g.ySurface + 0.05, ny));
    const k = Math.min(sh - 1, Math.floor(ny / ss)) * sw + Math.min(sw - 1, Math.floor(nx / ss));
    if (f.sdf[k]! < 0) { nx = c.posX[s]!; ny = Math.max(w.g.ySurface + 0.05, c.posY[s]! - 0.01); }
    c.posX[s] = nx; c.posY[s] = ny;
  }
}

export function hash(H: Harness): bigint { return hashWorld(H.world); }
export { ecoState, Q_MASS };
