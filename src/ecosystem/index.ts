/**
 * src/ecosystem: habitat, fields, flow, producers, the mass ledger, metabolism, feeding,
 * ageing, reproduction requests, the agent-cap tax, disease and god-power effects.
 * CONTRACT 3, 5.4, 9, 13. See README.md.
 *
 * Phase 0 implements: the streamfunction flow modes (flowAt, stepSlow), the initial mass
 * endowment into dissolved N, and the exact ledger audit. Everything else is a typed stub.
 */
import {
  cos, DT, DT_ECO, ECO_EVERY, LIFE, NotImplementedError, PI, Q_MASS, RNG_STREAM, sin, SLOW_EVERY,
  type EcosystemModule, type GodEventScheduled, type LedgerAudit, type StepContext, type World,
} from '../core/index.js';
import { agentCapFeeKg, ageingHazard, repairPowerW } from './ledger.js';

export { agentCapFeeKg, ageingHazard, repairPowerW };

/** Flow modes (04 §4.2): each mode m is (kx index, ky index, mean amplitude m/s). */
export const FLOW_MODES: readonly (readonly [number, number, number])[] = [
  [1, 1, 0.05], [2, 1, 0.03], [1, 2, 0.03], [3, 2, 0.015], [4, 3, 0.01],
];
/** OU time constant of the mode amplitudes, sim seconds (3 days in 04; shorter keeps phase 0 lively). */
export const FLOW_TAU_S = 600;
const FLOW_SIGMA = 0.6; // relative OU noise

function initFlow(world: World, ctx: StepContext): void {
  const d = ctx.rng.draw(RNG_STREAM.WORLDGEN, 0, 1);
  FLOW_MODES.forEach(([, , a], m) => {
    world.g.flowModes[m] = a * (d.u01() < 0.5 ? -1 : 1) * (0.5 + d.u01());
  });
}

/** Rebuild the coarse flow grids from the mode amplitudes (2 Hz, 04 §4.2). */
export function rebuildFlowGrid(world: World): void {
  const f = world.fields;
  const [w, h] = f.coarse;
  const cs = world.preset.widthM / w;
  const out = new Float64Array(2);
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      ecosystem.flowAt(world, (ix + 0.5) * cs, (iy + 0.5) * cs, out);
      f.flowU[iy * w + ix] = out[0]!;
      f.flowV[iy * w + ix] = out[1]!;
    }
  }
}

function seedMass(world: World): void {
  const f = world.fields;
  const cells = f.coarse[0] * f.coarse[1];
  const totalQ = world.g.mTargetQ;
  const per = Math.floor(totalQ / cells);
  f.qN.fill(per);
  // The remainder goes to the reservoir so the total is exact.
  world.g.qReservoir = totalQ - per * cells;
  world.g.mTotalQ = totalQ;
}

function sumF64(a: Float64Array, stride = 1, lanes = 1, count = a.length / stride): number {
  let s = 0;
  for (let i = 0; i < count; i++) for (let l = 0; l < lanes; l++) s += a[i * stride + l]!;
  return s;
}

export const ecosystem: EcosystemModule = {
  initWorld(world, ctx) {
    initFlow(world, ctx);
    rebuildFlowGrid(world);
    seedMass(world);
  },

  flowAt(world, x, y, out) {
    const W = world.preset.widthM;
    const H = world.preset.heightM;
    let u = 0;
    let v = 0;
    for (let m = 0; m < FLOW_MODES.length; m++) {
      const [i, j] = FLOW_MODES[m]!;
      const a = world.g.flowModes[m]!;
      const kx = (i * PI) / W;
      const ky = (j * PI) / H;
      // psi = (a / ky) sin(kx x) sin(ky y); u = d psi / dy, v = -d psi / dx (divergence-free)
      u += a * sin(kx * x) * cos(ky * y);
      v -= a * (kx / ky) * cos(kx * x) * sin(ky * y);
    }
    out[0] = u;
    out[1] = v;
  },

  stepEcology(world, ctx) {
    // Phase 0: nothing eats, burns or breeds yet. The ledger is untouched, so audit() stays exact.
    void world; void ctx; void DT_ECO; void ECO_EVERY;
  },

  stepSlow(world, ctx) {
    const dt = SLOW_EVERY * DT;
    const d = ctx.rng.draw(RNG_STREAM.ECOLOGY, ctx.tick, 0);
    const k = dt / FLOW_TAU_S;
    FLOW_MODES.forEach(([, , mean], m) => {
      const a = world.g.flowModes[m]!;
      const target = (a >= 0 ? 1 : -1) * mean;
      world.g.flowModes[m] = a + (target - a) * k + FLOW_SIGMA * mean * Math.sqrt(2 * k) * d.normal();
    });
    rebuildFlowGrid(world);
  },

  applyGodEvent(world: World, ev: GodEventScheduled, ctx: StepContext) {
    void ctx;
    world.g.modifiers.push(ev);
    throw new NotImplementedError(`ecosystem.applyGodEvent(${ev.power})`);
  },

  audit(world): LedgerAudit {
    const f = world.fields;
    const cr = world.cr.c;
    const pools: Record<string, number> = {
      qN: sumF64(f.qN), qD: sumF64(f.qD), qP: sumF64(f.qP), qBphoto: sumF64(f.qBphoto), qBchemo: sumF64(f.qBchemo),
      qSed: sumF64(f.qSed), qCyst: sumF64(f.qCyst), qReservoir: world.g.qReservoir, creatures: 0,
    };
    let c = 0;
    for (let s = 0; s < world.cr.highWater; s++) {
      if (cr.life[s] === LIFE.FREE) continue;
      c += cr.qTissue[s]! + cr.qReserve[s]! + cr.qRepro[s]! + cr.qGut[s * 3]! + cr.qGut[s * 3 + 1]! + cr.qGut[s * 3 + 2]!;
    }
    pools.creatures = c;
    let total = 0;
    for (const v of Object.values(pools)) total += v;
    return { ok: total === world.g.mTotalQ && Number.isSafeInteger(total), totalQ: total, expectedQ: world.g.mTotalQ, pools };
  },
};

/** Convenience for tests and stats: total world mass in kg. */
export function worldMassKg(world: World): number { return world.g.mTotalQ * Q_MASS; }
