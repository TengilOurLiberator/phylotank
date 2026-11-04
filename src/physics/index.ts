/**
 * src/physics: rigid segment trees in XPBD, muscles, fluid drag, contacts, bites, grabs and
 * latches, active power, exploit watchdogs. CONTRACT 2, 5.1, 5.2, 7, 10.3. See README.md.
 *
 * Phase 0 implements only passive point drifters (creatures with no segments, the
 * skeleton's motes): implicit drag towards the local water velocity plus a weak seeded wander,
 * reflected at the tank walls. Everything else is a typed stub.
 */
import {
  DT, LIFE, NotImplementedError, RNG_STREAM, TAU, cos, sin, type Phenotype, type PhysicsModule, type StepContext,
  type World,
} from '../core/index.js';
import type { SegmentSpec } from './segment-spec.js';

export type { SegmentSpec };
export { toSegmentSpecs } from './segment-spec.js';

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
  const lerp2 = (a: Float32Array): number =>
    (a[i00]! * (1 - fx) + a[i00 + 1]! * fx) * (1 - fy) + (a[i00 + w]! * (1 - fx) + a[i00 + w + 1]! * fx) * fy;
  out[0] = lerp2(f.flowU);
  out[1] = lerp2(f.flowV);
}

const flow = new Float64Array(2);

function stepDrifters(world: World, ctx: StepContext): void {
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

export const physics: PhysicsModule = {
  loadBody(world: World, slot: number, ph: Phenotype) {
    void world; void slot; void ph;
    throw new NotImplementedError('physics.loadBody');
  },
  restage(world: World, slot: number, ph: Phenotype) {
    void world; void slot; void ph;
    throw new NotImplementedError('physics.restage');
  },
  step(world, ctx) {
    stepDrifters(world, ctx);
  },
};
