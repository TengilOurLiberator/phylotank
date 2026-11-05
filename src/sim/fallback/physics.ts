/**
 * Local fallback PhysicsModule (phase 1): a single-capsule swimmer per creature, so the tick
 * pipeline runs end to end while src/physics builds XPBD bodies. Replaced through
 * `createSim({ physics })`.
 *
 * - loadBody / restage: geometry and mass of segment 0 from the Phenotype (sim has already
 *   allocated the segment range and set owner, parent, kind, organs).
 * - step: implicit drag towards the water velocity plus a thrust along the heading from the
 *   brain's CPG_AMP output, turning by CPG_TURN; reflecting walls; carcasses sink; active
 *   power `powerW` = drag power of the thrust. Passive point drifters (no segments) are left
 *   to the real physics module's drifter code, which this delegates to.
 */
import {
  cos, DT, LIFE, PI, sin, wrapAngle, type Phenotype, type PhysicsModule, type StepContext, type World,
} from '../../core/index.js';
import { sampleFlow, stepDrifters } from '../../physics/index.js';

/** Swim speed at full CPG amplitude, body lengths per second. */
export const SWIM_BL_PER_S = 2;
/** Drag relaxation rate towards (water + thrust), 1/s. */
export const DRAG_RATE = 4;
export const TURN_RATE = 2.5;
export const CARCASS_SINK = 0.01;

function writeSegment(world: World, slot: number, ph: Phenotype): void {
  const c = world.cr.c;
  const s = world.seg.c;
  const k = c.segStart[slot]!;
  if (k === 0xffffffff || c.segCount[slot] === 0) return;
  s.len[k] = ph.length[0]!;
  s.radius[k] = ph.radius[0]!;
  s.span[k] = ph.span[0]!;
  s.mass[k] = c.massKg[slot]! > 0 ? c.massKg[slot]! : ph.massKg;
  const r = ph.radius[0]!;
  const L = ph.length[0]!;
  s.inertia[k] = (s.mass[k]! * (L * L + 3 * r * r)) / 12;
  s.posX[k] = c.posX[slot]!;
  s.posY[k] = c.posY[slot]!;
  s.angle[k] = c.heading[slot]!;
  s.damping[k] = ph.damping[0]!;
  s.compliance[k] = 1 / ph.youngsE[0]!;
}

const flow = new Float64Array(2);

function step(world: World, ctx: StepContext): void {
  const c = world.cr.c;
  const sg = world.seg.c;
  const W = world.preset.widthM;
  const H = world.preset.heightM;
  const top = world.g.ySurface;
  const k = DRAG_RATE * DT;
  for (let s = 0; s < world.cr.highWater; s++) {
    const life = c.life[s]!;
    if (life === LIFE.FREE || c.segCount[s] === 0) continue;
    const x = c.posX[s]!;
    const y = c.posY[s]!;
    sampleFlow(world, x, y, flow);
    let tx = 0;
    let ty = 0;
    if (life === LIFE.ALIVE) {
      const amp = c.out[s * 8 + 1]!;
      const turn = c.out[s * 8 + 2]!;
      const h = wrapAngle(c.heading[s]! + TURN_RATE * turn * DT);
      c.heading[s] = h;
      const v = SWIM_BL_PER_S * c.length[s]! * (amp < 0 ? 0 : amp > 1 ? 1 : amp);
      tx = v * cos(h);
      ty = v * sin(h);
    } else if (life === LIFE.CARCASS) {
      ty = CARCASS_SINK;
    }
    // implicit relaxation: v' = (v + k (u + thrust)) / (1 + k)
    let vx = (c.velX[s]! + k * (flow[0]! + tx)) / (1 + k);
    let vy = (c.velY[s]! + k * (flow[1]! + ty)) / (1 + k);
    let nx = x + DT * vx;
    let ny = y + DT * vy;
    const r = 0.02;
    if (nx < r) { nx = 2 * r - nx; vx = -vx; c.heading[s] = wrapAngle(PI - c.heading[s]!); }
    if (nx > W - r) { nx = 2 * (W - r) - nx; vx = -vx; c.heading[s] = wrapAngle(PI - c.heading[s]!); }
    if (ny < top + r) { ny = 2 * (top + r) - ny; vy = -vy; c.heading[s] = wrapAngle(-c.heading[s]!); }
    if (ny > H - r) { ny = life === LIFE.CARCASS ? H - r : 2 * (H - r) - ny; vy = life === LIFE.CARCASS ? 0 : -vy; c.heading[s] = wrapAngle(-c.heading[s]!); }
    c.posX[s] = nx; c.posY[s] = ny; c.velX[s] = vx; c.velY[s] = vy;
    // drag power of the thrust: m * rate * |thrust|^2
    c.powerW[s] = life === LIFE.ALIVE ? c.massKg[s]! * DRAG_RATE * (tx * tx + ty * ty) : 0;
    const seg = c.segStart[s]!;
    sg.posX[seg] = nx; sg.posY[seg] = ny; sg.angle[seg] = c.heading[s]!;
    sg.velX[seg] = vx; sg.velY[seg] = vy;
  }
  // passive drifters (segCount 0) keep the real module's phase-0 behaviour. Only the drifters:
  // since the physics merge the full module also steps every segmented body, which would
  // integrate the fallback's bodies twice (and NaN the unfilled segments of a restaged body).
  stepDrifters(world, ctx);
}

export const fallbackPhysics: PhysicsModule = {
  loadBody: writeSegment,
  restage: writeSegment,
  step,
};
