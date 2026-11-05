/**
 * Local fallback EcosystemModule (phase 1). It wraps the real src/ecosystem module (terrain,
 * flow, the initial endowment, stepSlow, audit and god events are the real ones) and adds a
 * minimal life cycle to `stepEcology`, so budding creatures eat, burn, grow, breed and die
 * with an exact ledger while src/ecosystem is built. Replaced through `createSim({ ecosystem })`.
 *
 * Order within one ecology tick (CONTRACT 10.1 step 4):
 *   real stepEcology; then per creature in slot order: carcass decay, feeding (eat and
 *   contact), digestion, metabolism (basal, repair, active, brain), growth and restage,
 *   reproduction requests, ageing and starvation deaths; then the producer field.
 *
 * Simplifications (documented in docs/modules/sim.md): phytoplankton lives in the anchor fine
 * cell (top-left) of each coarse cell; temperature is 14 C plus `tAnom`; the gut has one
 * (plant) lane in use; sex finds a mate in the same coarse cell.
 */
import {
  B0_KLEIBER, CF, clamp, DT_ECO, E_A_EV, E_B, ENZYME_THETA, exp, FAT_CAPACITY_0, K_BOLTZMANN_EV, LIFE, NONE_U32, pow,
  Q_MASS, quantiseWithCarry, RNG_STREAM, sin, T, T_REF_K, TAU, TRAITS, decodeQ, C_G, CATABOLISM_EFF, SDA_FRACTION,
  CARRY, cbrt, cos, DT, PI, SLOW_EVERY, type EcosystemModule, type Genome, type StepContext, type World,
} from '../../core/index.js';
import { ageingHazard, ecosystem as realEcosystem, FLOW_MODES, FLOW_TAU_S } from '../../ecosystem/index.js';
import { dayPhase } from '../clocks.js';
import { burnTo, coarseCell, currentFeeKg, newbornKg, offspringCost } from '../commit.js';
import { requestBirth, requestDeath } from '../requests.js';
import { CH, stateOf } from '../state.js';
import { capsuleMassKg, lengthAt } from './genome.js';

/** Producer constants (per second). */
export const PROD_RATE = 4e-4;
export const PROD_MORT = 1e-4;
export const REMIN_RATE = 4e-4;
export const LIGHT_DEPTH_M = 5;
/** Gut emptying rate (1/s) and capacity (fraction of body mass). */
const GUT_RATE = 0.5;
const GUT_CAP = 0.1;
const A_MAX = 0.8;
/** Maximum growth rate, fraction of tissue per second at GROWTH_RATE 1. */
const GROW_MAX = 0.01;
const CARCASS_DECAY = 0.02;
/** Repro reserve accrual: surplus above this fraction of the fat capacity goes to qRepro. */
const REPRO_KEEP = 0.5;
const K_CAPSULE = capsuleMassKg(1);

/** Decoded traits per slot, refreshed when the slot's entity changes. */
interface TraitCache {
  idLo: Uint32Array; idHi: Uint32Array;
  ePlant: Float32Array; basalMult: Float32Array; repairMult: Float32Array; fat: Float32Array; grow: Float32Array;
  lb: Float32Array; la: Float32Array; matureAt: Float32Array; clutch: Uint8Array; sexProb: Float32Array;
  senescence: Float32Array; brood: Float32Array; reproReserve: Float32Array; stageLen: Float32Array;
}
const caches = new WeakMap<World, TraitCache>();
function cacheOf(world: World): TraitCache {
  let t = caches.get(world);
  if (!t) {
    const n = world.cr.capacity;
    const f = (): Float32Array => new Float32Array(n);
    t = {
      idLo: new Uint32Array(n).fill(NONE_U32), idHi: new Uint32Array(n).fill(NONE_U32), ePlant: f(), basalMult: f(),
      repairMult: f(), fat: f(), grow: f(), lb: f(), la: f(), matureAt: f(), clutch: new Uint8Array(n), sexProb: f(),
      senescence: f(), brood: f(), reproReserve: f(), stageLen: f(),
    };
    caches.set(world, t);
  }
  return t;
}
function tr(g: Genome, idx: number): number { return decodeQ(g.traits[idx]!, TRAITS[idx]!); }

function refresh(world: World, t: TraitCache, s: number): void {
  const c = world.cr.c;
  if (t.idLo[s] === c.idLo[s] && t.idHi[s] === c.idHi[s]) return;
  t.idLo[s] = c.idLo[s]!; t.idHi[s] = c.idHi[s]!;
  const g = stateOf(world).store.get(c.genome[s]!);
  const x1 = tr(g, T.DIET_PLANT!);
  const x2 = tr(g, T.DIET_DETRITUS!);
  t.ePlant[s] = A_MAX * pow(x1 * (1 - x2), ENZYME_THETA);
  t.basalMult[s] = (1 + 0.15 * tr(g, T.IMMUNE_INVEST!)) * (1 + 0.04 * Math.max(0, tr(g, T.TEMP_TOLERANCE!) - 3));
  t.repairMult[s] = 0.05 * (tr(g, T.LIFESPAN_MULT!) - 1);
  t.fat[s] = tr(g, T.FAT_CAPACITY!);
  t.grow[s] = GROW_MAX * tr(g, T.GROWTH_RATE!);
  const la = lengthAt(g, 1, world.lCeilingM);
  const lb = lengthAt(g, 0, world.lCeilingM);
  t.la[s] = la; t.lb[s] = lb;
  t.matureAt[s] = clamp((tr(g, T.MATURITY_FRACTION!) * la - lb) / Math.max(1e-12, la - lb), 0, 1);
  t.clutch[s] = Math.max(1, Math.min(64, Math.round(tr(g, T.CLUTCH_SIZE!))));
  t.sexProb[s] = tr(g, T.SEX_PROB!);
  t.senescence[s] = tr(g, T.SENESCENCE!);
  t.brood[s] = tr(g, T.BROOD_INTERVAL!);
  t.reproReserve[s] = tr(g, T.REPRO_RESERVE!);
  t.stageLen[s] = c.length[s]!;
}

function arrhenius(tempC: number): number {
  return exp((E_A_EV / K_BOLTZMANN_EV) * (1 / T_REF_K - 1 / (tempC + 273.15)));
}

/** Coarse-cell buckets of mature living creatures for the mate search, in slot order. */
function mateBuckets(world: World, t: TraitCache): Map<number, number[]> {
  const c = world.cr.c;
  const m = new Map<number, number[]>();
  for (let s = 0; s < world.cr.highWater; s++) {
    if (c.life[s] !== LIFE.ALIVE || c.maturity[s]! < t.matureAt[s]!) continue;
    const k = coarseCell(world, c.posX[s]!, c.posY[s]!);
    const b = m.get(k);
    if (b) b.push(s); else m.set(k, [s]);
  }
  return m;
}

function stepLife(world: World, ctx: StepContext): void {
  const st = stateOf(world);
  const c = world.cr.c;
  const f = world.fields;
  const t = cacheOf(world);
  const ch = st.channels;
  const dt = DT_ECO;
  const [cw] = f.coarse;
  const fw = f.fine[0];
  const feeKg = currentFeeKg(world);
  let buckets: Map<number, number[]> | null = null;
  for (let s = 0; s < world.cr.highWater; s++) {
    const life = c.life[s]!;
    if (life === LIFE.FREE) continue;
    const x = c.posX[s]!;
    const y = c.posY[s]!;
    const cell = coarseCell(world, x, y);
    if (life === LIFE.CARCASS) {
      // carcass decay to suspended detritus (CONTRACT 9.2: carcasses leach to D)
      const lanes = [c.qTissue, c.qReserve, c.qRepro];
      for (const a of lanes) {
        const v = a[s]!;
        if (v <= 0) continue;
        const d = Math.min(v, Math.max(1, Math.floor(v * CARCASS_DECAY * dt)));
        a[s] = v - d; f.qD[cell]! += d; ch[CH.decay]! += d;
      }
      for (let l = 0; l < 3; l++) {
        const v = c.qGut[s * 3 + l]!;
        if (v > 0) { c.qGut[s * 3 + l] = 0; f.qD[cell]! += v; ch[CH.decay]! += v; }
      }
      continue;
    }
    if (life !== LIFE.ALIVE) continue;
    refresh(world, t, s);
    const massKg = (c.qTissue[s]! + c.qReserve[s]! + c.qRepro[s]! + c.qGut[s * 3]!) * Q_MASS;
    const tempC = 14 + f.tAnom[cell]!;
    c.tempC[s] = tempC;
    const basalW = B0_KLEIBER * pow(massKg, 0.75) * arrhenius(tempC) * t.basalMult[s]!;
    // eat and contact: graze the producer cell (Holling II ceiling J_max = 8 B / (f E_B), 9.5)
    const ix = cell % cw;
    const iy = (cell - ix) / cw;
    const anchor = iy * 4 * fw + ix * 4;
    const gutCap = Math.floor((GUT_CAP * massKg) / Q_MASS);
    const room = gutCap - c.qGut[s * 3]!;
    if (room > 0) {
      const jmaxQ = (8 * basalW * dt) / (0.6 * E_B * Q_MASS);
      const want = Math.min(room, Math.floor(jmaxQ * 0.5));
      const take = Math.min(want, f.qP[anchor]!);
      if (take > 0) { f.qP[anchor]! -= take; c.qGut[s * 3]! += take; ch[CH.ingestion]! += take; c.flags[s] = c.flags[s]! | CF.EATING; }
      else c.flags[s] = c.flags[s]! & ~CF.EATING;
    }
    // digestion: absorption a = a_max e^1.3; f a F to reserve, (1 - f) a F excreted to N, rest faeces to D
    const gut = c.qGut[s * 3]!;
    if (gut > 0) {
      const F = Math.min(gut, quantiseWithCarry(gut * GUT_RATE * dt, c.carry, s * 4 + CARRY.INTAKE));
      const a = t.ePlant[s]!;
      const toRes = Math.floor(0.6 * a * F);
      const toN = Math.floor(0.4 * a * F);
      const faeces = F - toRes - toN;
      const sda = Math.floor(SDA_FRACTION * toRes);
      c.qGut[s * 3] = gut - F;
      c.qReserve[s]! += toRes - sda;
      f.qN[cell]! += toN + sda;
      f.qD[cell]! += faeces;
      ch[CH.absorption]! += toRes; ch[CH.faeces]! += faeces; ch[CH.heatBasal]! += sda;
    }
    // metabolism: basal + repair + active + brain, burnt from the reserve to dissolved N
    const powerW = basalW * (1 + t.repairMult[s]!) + c.powerW[s]! + c.brainW[s]!;
    const burn = quantiseWithCarry((powerW * dt) / (Q_MASS * E_B), c.carry, s * 4 + CARRY.BURN);
    let starving = false;
    if (c.qReserve[s]! >= burn) {
      c.qReserve[s]! -= burn; f.qN[cell]! += burn;
    } else {
      // starvation: catabolise tissue at efficiency 0.8 (9.2)
      const deficit = burn - c.qReserve[s]!;
      f.qN[cell]! += c.qReserve[s]!;
      c.qReserve[s] = 0;
      const cat = Math.min(c.qTissue[s]!, Math.ceil(deficit / CATABOLISM_EFF));
      c.qTissue[s]! -= cat; f.qN[cell]! += cat;
      starving = true;
    }
    ch[CH.heatBasal]! += Math.floor(burn * basalW / Math.max(powerW, 1e-30));
    ch[CH.heatMuscle]! += burn - Math.floor(burn * basalW / Math.max(powerW, 1e-30));
    // growth: reserve above half the fat capacity builds tissue at C_G (9.2)
    const tissue = c.qTissue[s]!;
    const keep = Math.floor(t.fat[s]! * tissue * REPRO_KEEP);
    if (c.maturity[s]! < 1 && c.qReserve[s]! > keep) {
      const dm = Math.floor(Math.min((c.qReserve[s]! - keep) / C_G, t.grow[s]! * dt * tissue + 1));
      if (dm > 0) {
        const heat = Math.floor((C_G - 1) * dm);
        c.qReserve[s]! -= dm + heat; c.qTissue[s]! += dm; f.qN[cell]! += heat;
        ch[CH.growth]! += heat;
      }
    }
    // maturity and length from tissue (capsule mass ~ L^3), monotone; restage at 4%
    const L = cbrt((c.qTissue[s]! * Q_MASS) / K_CAPSULE);
    const m = clamp((L - t.lb[s]!) / Math.max(1e-12, t.la[s]! - t.lb[s]!), 0, 1);
    if (m > c.maturity[s]!) {
      c.maturity[s] = m;
      c.length[s] = t.lb[s]! + (t.la[s]! - t.lb[s]!) * m;
      if (c.length[s]! > 1.04 * t.stageLen[s]!) {
        t.stageLen[s] = c.length[s]!;
        c.stage[s] = c.stage[s]! + 1;
        const g = st.store.get(c.genome[s]!);
        const ph = st.modules.genome.develop(g, m, { depth01: 0, tempC }, { maxParts: 64, lCeilingM: world.lCeilingM });
        st.modules.physics.restage(world, s, ph);
      }
      if (m >= t.matureAt[s]!) c.flags[s] = c.flags[s]! & ~CF.JUVENILE;
    }
    c.massKg[s] = (c.qTissue[s]! + c.qReserve[s]! + c.qRepro[s]! + c.qGut[s * 3]!) * Q_MASS;
    c.reproTimer[s] = Math.max(0, c.reproTimer[s]! - dt);
    // reproduction: mature, timer elapsed, not already queued
    if (c.maturity[s]! >= t.matureAt[s]! && c.reproTimer[s] === 0 && (c.flags[s]! & CF.BUDDING) === 0) {
      const capKeep = Math.floor(FAT_CAPACITY_0 * c.qTissue[s]! * t.reproReserve[s]!);
      if (c.qReserve[s]! > capKeep) {
        const mv = c.qReserve[s]! - capKeep;
        c.qReserve[s]! -= mv; c.qRepro[s]! += mv;
      }
      const cost = offspringCost(newbornKg(world, c.genome[s]!), feeKg).total;
      if (c.qRepro[s]! >= cost) {
        const d = ctx.rng.draw(RNG_STREAM.BIRTH, ctx.tick, c.idHi[s]! * 4294967296 + c.idLo[s]!);
        let mate = -1;
        if (d.u01() < t.sexProb[s]!) {
          buckets ??= mateBuckets(world, t);
          for (const o of buckets.get(cell) ?? []) {
            if (o !== s && c.species[o] === c.species[s] && c.life[o] === LIFE.ALIVE) { mate = o; break; }
          }
        }
        if (mate >= 0 || t.sexProb[s]! < 0.98) {
          const n = Math.max(1, Math.min(t.clutch[s]!, Math.floor(c.qRepro[s]! / cost)));
          requestBirth(world, { parentSlot: s, mode: mate >= 0 ? 'sex' : 'bud', mateSlot: mate, n, tick: ctx.tick });
          c.flags[s] = c.flags[s]! | CF.BUDDING;
          c.reproTimer[s] = t.brood[s]! * c.tMature[s]!;
        }
      }
    }
    // ageing (Gompertz, stream AGEING) and starvation
    const age = (ctx.tick - c.birthTick[s]!) * (1 / 30) * (starving ? 3 : 1);
    const h = ageingHazard(age, c.lifespan[s]!, t.senescence[s]!);
    const pDie = 1 - exp(-h * dt);
    const da = ctx.rng.draw(RNG_STREAM.AGEING, ctx.tick, c.idHi[s]! * 4294967296 + c.idLo[s]!);
    if (da.u01() < pDie) requestDeath(world, s, 'age', ctx.tick);
    else if (starving && c.qTissue[s]! < 0.6 * (capsuleMassKg(c.length[s]!) / Q_MASS)) requestDeath(world, s, 'starvation', ctx.tick);
  }
}

/** Per-row light: day cycle times depth attenuation (fallback for the light field). */
function stepProducers(world: World, ctx: StepContext): void {
  const f = world.fields;
  const [w, h] = f.coarse;
  const fw = f.fine[0];
  const cs = world.preset.widthM / w;
  // producers run on slow ticks only (2 Hz, dt = 0.5 s): a fallback, the field is smooth
  if (ctx.tick % SLOW_EVERY !== 0) return;
  const dt = SLOW_EVERY * DT;
  const st = stateOf(world);
  const day = clamp(0.35 + 0.75 * sin(TAU * dayPhase(world)), 0.05, 1);
  let photo = 0;
  for (let iy = 0; iy < h; iy++) {
    const depth = Math.max(0, (iy + 0.5) * cs - world.g.ySurface);
    const light = day * exp(-depth / LIGHT_DEPTH_M);
    const kProd = PROD_RATE * light * dt;
    for (let ix = 0; ix < w; ix++) {
      const i = iy * w + ix;
      const a = iy * 4 * fw + ix * 4;
      f.light[i] = light;
      const g = Math.floor(f.qN[i]! * kProd);
      f.qN[i]! -= g; f.qP[a]! += g; photo += g;
      const mort = Math.floor(f.qP[a]! * PROD_MORT * dt);
      f.qP[a]! -= mort; f.qD[i]! += mort;
      const rem = Math.floor(f.qD[i]! * REMIN_RATE * dt);
      f.qD[i]! -= rem; f.qN[i]! += rem;
    }
  }
  st.channels[CH.photosynthesis]! += photo;
}

/**
 * Separable rebuild of the coarse flow grids. Bit-identical to the real module's
 * `rebuildFlowGrid` (same operands, same operation order: `a * sin(kx x) * cos(ky y)`), but
 * with one sine and cosine per mode per row and per column instead of per cell: about 60x
 * faster on Small. tests/sim-fallback.test.ts checks it against the real one. Offered to the
 * ecosystem engineer in docs/modules/sim.md.
 */
export function rebuildFlowGridFast(world: World): void {
  const f = world.fields;
  const [w, h] = f.coarse;
  const cs = world.preset.widthM / w;
  const W = world.preset.widthM;
  const H = world.preset.heightM;
  const nm = FLOW_MODES.length;
  const sx = new Float64Array(nm * w), cx = new Float64Array(nm * w);
  const sy = new Float64Array(nm * h), cy = new Float64Array(nm * h);
  const ka = new Float64Array(nm);
  for (let m = 0; m < nm; m++) {
    const [i, j] = FLOW_MODES[m]!;
    const kx = (i * PI) / W;
    const ky = (j * PI) / H;
    ka[m] = kx / ky;
    for (let ix = 0; ix < w; ix++) { const x = (ix + 0.5) * cs; sx[m * w + ix] = sin(kx * x); cx[m * w + ix] = cos(kx * x); }
    for (let iy = 0; iy < h; iy++) { const y = (iy + 0.5) * cs; sy[m * h + iy] = sin(ky * y); cy[m * h + iy] = cos(ky * y); }
  }
  const amp = world.g.flowModes;
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      let u = 0;
      let v = 0;
      for (let m = 0; m < nm; m++) {
        const a = amp[m]!;
        u += a * sx[m * w + ix]! * cy[m * h + iy]!;
        v -= a * ka[m]! * cx[m * w + ix]! * sy[m * h + iy]!;
      }
      f.flowU[iy * w + ix] = u;
      f.flowV[iy * w + ix] = v;
    }
  }
}

/** The real stepSlow's OU update of the mode amplitudes (04 §4.2), then the fast rebuild. */
function stepSlowFast(world: World, ctx: StepContext): void {
  const dt = SLOW_EVERY * DT;
  const d = ctx.rng.draw(RNG_STREAM.ECOLOGY, ctx.tick, 0);
  const k = dt / FLOW_TAU_S;
  FLOW_MODES.forEach(([, , mean], m) => {
    const a = world.g.flowModes[m]!;
    const target = (a >= 0 ? 1 : -1) * mean;
    world.g.flowModes[m] = a + (target - a) * k + 0.6 * mean * Math.sqrt(2 * k) * d.normal();
  });
  rebuildFlowGridFast(world);
}

/** Wrap an ecosystem module (default: the real one) with the fallback life cycle. */
export function withFallbackLife(base: EcosystemModule = realEcosystem): EcosystemModule {
  // the fast flow rebuild is used only over the phase-0 ecosystem, whose stepSlow it reproduces
  const slow = base === realEcosystem ? stepSlowFast : (world: World, ctx: StepContext): void => base.stepSlow(world, ctx);
  return {
    initWorld(world, ctx) {
      base.initWorld(world, ctx);
      // start the producers: 5% of each cell's dissolved N becomes phytoplankton (exact)
      const f = world.fields;
      const [w, h] = f.coarse;
      const fw = f.fine[0];
      for (let iy = 0; iy < h; iy++) for (let ix = 0; ix < w; ix++) {
        const i = iy * w + ix;
        const q = Math.floor(f.qN[i]! * 0.05);
        f.qN[i]! -= q; f.qP[iy * 4 * fw + ix * 4]! += q;
      }
    },
    flowAt: (world, x, y, out) => base.flowAt(world, x, y, out),
    stepEcology(world, ctx) {
      base.stepEcology(world, ctx);
      stepLife(world, ctx);
      stepProducers(world, ctx);
    },
    stepSlow: slow,
    applyGodEvent: (world, ev, ctx) => base.applyGodEvent(world, ev, ctx),
    audit: (world) => base.audit(world),
  };
}

export { burnTo };
