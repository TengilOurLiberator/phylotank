/**
 * src/physics: rigid segment trees in XPBD, muscles, fluid drag, contacts, bites, grabs and
 * latches, active power, exploit watchdogs. CONTRACT 2, 5.1, 5.2, 7, 10.3. See README.md.
 *
 * Creatures with segments run the full-tier XPBD integrator (solver.ts); creatures without
 * segments (the skeleton's motes) stay passive point drifters: implicit drag towards the local
 * water velocity plus a weak seeded wander, reflected at the tank walls.
 */
import {
  DT, LIFE, RNG_STREAM, TAU, cos, sin, type Phenotype, type PhysicsModule, type StepContext,
  type World,
} from '../core/index.js';
import type { SegmentSpec } from './segment-spec.js';
import { loadBody, restage } from './body.js';
import {
  DEFAULT_OPTIONS, beginCreature, endCreature, stepCreature, substepCreature, substepCreatureEnd, type FlowSampler,
  type PhysicsOptions,
} from './solver.js';
import { coolLatches, islands, linkState, pruneLinks, resetLinkForces, scrapeLatches, solveLinks } from './links.js';
import type { Work } from './work.js';
import { stepContacts } from './contacts.js';
import { workFor } from './work.js';
import { watch } from './watchdog.js';
import { fadeFragments, findSevers } from './sever.js';

export type { SegmentSpec, PhysicsOptions };
export { toSegmentSpecs } from './segment-spec.js';
export { DEFAULT_OPTIONS, stepCreature, hill, tauAct, basalW } from './solver.js';
export { massProps, dragCoeffs, segVolume, tissueDensity } from './body.js';
export { workFor } from './work.js';
export { drainFlags, waterFrameEnergy } from './watchdog.js';
export { drainBites, type BiteRecord } from './contacts.js';
export { LINK, itch, latches, linkState, scrapeLatches, SCRAPE_BL_PER_S, SCRAPE_S, type Link } from './links.js';
export {
  gasVolume, molesFor, pressureAt, setBladder, JET_FRAC, BLADDER_RATE, ROLL_ON, ROLL_OFF, ROLL_COOLDOWN_S,
} from './organs.js';
export {
  commitSevers, findSevers, fadeFragments, fragmentGlow, localSeverHooks, pendingSevers, FRAGMENT_GLOW_S,
  type SeverHooks, type SeverRequest, type SeverResult,
} from './sever.js';

/** Drag rate for passive drifters (1/s): a mote follows the water with a ~0.5 s lag. */
export const DRIFTER_DRAG = 2;
/** Wander acceleration of a drifter, m/s^2 (phase-0 visual life only). */
export const DRIFTER_WANDER = 0.004;

/**
 * Bilinear sample of the water velocity from the coarse `flowU`/`flowV` grids (cell centres),
 * which ecosystem rebuilds at 2 Hz (CONTRACT 5.4). Physics never imports ecosystem.
 */
export function sampleFlow(world: World, x: number, y: number, out: Float64Array): void {
  const f = world.fields;
  const [w, h] = f.coarse;
  const cs = world.preset.widthM / w;
  let gx = x / cs - 0.5;
  let gy = y / cs - 0.5;
  gx = gx < 0 ? 0 : gx > w - 1.001 ? w - 1.001 : gx;
  gy = gy < 0 ? 0 : gy > h - 1.001 ? h - 1.001 : gy;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;
  const i00 = iy * w + ix;
  // inline (a closure here allocated once per segment per tick)
  const U = f.flowU; const V = f.flowV;
  out[0] = (U[i00]! * (1 - fx) + U[i00 + 1]! * fx) * (1 - fy) + (U[i00 + w]! * (1 - fx) + U[i00 + w + 1]! * fx) * fy;
  out[1] = (V[i00]! * (1 - fx) + V[i00 + 1]! * fx) * (1 - fy) + (V[i00 + w]! * (1 - fx) + V[i00 + w + 1]! * fx) * fy;
}

const flow = new Float64Array(2);

/** Passive point drifters only (creatures with no segments); the sim fallback physics uses this. */
export function stepDrifters(world: World, ctx: StepContext): void {
  const c = world.cr.c;
  const W = world.preset.widthM;
  const H = world.preset.heightM;
  const top = world.g.ySurface;
  const k = DRIFTER_DRAG * DT;
  const stream = ctx.rng.stream(RNG_STREAM.PHYSICS);
  const block = new Uint32Array(4);
  for (let s = 0; s < world.cr.highWater; s++) {
    if (c.life[s] !== LIFE.ALIVE || c.segCount[s] !== 0) continue;
    const x = c.posX[s]!;
    const y = c.posY[s]!;
    sampleFlow(world, x, y, flow);
    // one Philox block per drifter per tick: a slowly turning wander direction
    stream.block(ctx.tick >>> 5, c.idLo[s]! + c.idHi[s]! * 4294967296, 0, block);
    const th = (block[0]! / 4294967296) * TAU + c.heading[s]!;
    const ax = DRIFTER_WANDER * cos(th);
    const ay = DRIFTER_WANDER * sin(th);
    // implicit drag: v' = (v + dt a + k u) / (1 + k)
    let vx = (c.velX[s]! + DT * ax + k * flow[0]!) / (1 + k);
    let vy = (c.velY[s]! + DT * ay + k * flow[1]!) / (1 + k);
    let nx = x + DT * vx;
    let ny = y + DT * vy;
    const r = 0.05;
    if (nx < r) { nx = 2 * r - nx; vx = -vx; }
    if (nx > W - r) { nx = 2 * (W - r) - nx; vx = -vx; }
    if (ny < top + r) { ny = 2 * (top + r) - ny; vy = -vy; }
    if (ny > H - r) { ny = 2 * (H - r) - ny; vy = -vy; }
    c.posX[s] = nx; c.posY[s] = ny; c.velX[s] = vx; c.velY[s] = vy;
  }
}

/** Linked creatures step together: common substep count, links solved inside every substep (R6). */
export const ISLAND_SUBSTEPS = 8;
function stepIsland(world: World, members: readonly number[], wk: Work, opts: PhysicsOptions, flowAt: FlowSampler | null): void {
  const cts = members.map((m) => beginCreature(world, m, wk, opts, flowAt, Math.max(ISLAND_SUBSTEPS, opts.nSub)));
  const nSub = cts[0]!.nSub;
  for (let s = 0; s < nSub; s++) {
    for (const ct of cts) substepCreature(world, ct, wk, opts, s);
    solveLinks(world, wk, members, cts[0]!.h);
    for (const ct of cts) substepCreatureEnd(world, ct, wk, opts, s);
  }
  for (const ct of cts) {
    endCreature(world, ct, wk, opts);
    if (opts.watchdog) watch(world, ct.slot, wk, opts.dt, opts.gravity);
  }
}

/** Build a physics module with options (tests and benchmarks); `physics` is the default. */
export function createPhysics(over: Partial<PhysicsOptions> = {}): PhysicsModule & { readonly opts: PhysicsOptions } {
  const opts: PhysicsOptions = { ...DEFAULT_OPTIONS, ...over };
  return {
    opts,
    loadBody(world: World, slot: number, ph: Phenotype) { loadBody(world, slot, ph); },
    restage(world: World, slot: number, ph: Phenotype) { restage(world, slot, ph); },
    step(world, ctx) {
      stepDrifters(world, ctx);
      const c = world.cr.c;
      const wk = workFor(world);
      const sampler = null; // the solver samples the flow grid inline (same arithmetic as sampleFlow)
      resetLinkForces(world);
      const isl = linkState(world).links.length > 0 ? islands(world) : null;
      const rootOf = new Map<number, number>();
      if (isl) for (const [r, ms] of isl) for (const m of ms) rootOf.set(m, r);
      for (let s = 0; s < world.cr.highWater; s++) {
        const life = c.life[s];
        if ((life !== LIFE.ALIVE && life !== LIFE.CARCASS) || c.segCount[s] === 0) continue;
        const root = rootOf.get(s);
        if (root !== undefined) {
          if (root === s) stepIsland(world, isl!.get(root)!, wk, opts, sampler);
          continue;
        }
        stepCreature(world, s, wk, opts, sampler);
        if (opts.watchdog) watch(world, s, wk, opts.dt, opts.gravity);
      }
      if (opts.contacts) stepContacts(world, ctx, wk, opts);
      coolLatches(world, wk, opts.dt);
      scrapeLatches(world, wk, opts.dt);
      pruneLinks(world);
      findSevers(world);
      fadeFragments(world, opts.dt);
    },
  };
}

export const physics: PhysicsModule = createPhysics();
