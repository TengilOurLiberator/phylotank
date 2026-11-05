/**
 * Per-creature metabolism and feeding (CONTRACT 9.2 to 9.6, DESIGN R5, R11, review R10, R11).
 *
 * Each ecology tick, for every loaded living creature in ascending slot order: environment,
 * burning (Kleiber basal with the Arrhenius factor, immune and thermal-breadth costs, repair
 * per the disposable-soma rule, physics' powerW and the brain's brainW), starvation
 * catabolism, field feeding through demand, resolve and collect (Holling type II filters,
 * rasping mats and sediment, photosynthesis), digestion by the bridge rule, growth and
 * restage requests, reproduction requests with the per-offspring overhead and the additive
 * cap fee, the Gompertz ageing hazard and the health hazards. Carcasses leach to D and N.
 * Every mass change is an integer transfer; carries hold the fractions.
 */
import {
  CARRY, cbrt, CF, clamp, C_G, CATABOLISM_EFF, decodeQ, DIET, DT_ECO, E_A_EV, E_B, exp, FAT_CAPACITY_0, GUT,
  K_BOLTZMANN_EV, LIFE, LN2, M_REF_1M, OVERHEAD_ABS_KG, OVERHEAD_FRACTION, pow, Q_MASS, quantiseWithCarry,
  RNG_STREAM, SDA_FRACTION, T, TRAITS, T_REF_K, B0_KLEIBER, ENZYME_THETA, ORGAN, MATERIAL,
  type DeathCause, type MouthDescriptor, type Phenotype, type StepContext, type World,
} from '../core/index.js';
import { ageingHazard, agentCapFeeKg, book, repairPowerW } from './ledger.js';
import { P } from './params.js';
import { CH, ER, ER_LANES, scratch, type BirthRequest, type EcoState } from './state.js';
import { coarseIndex, consumeO2, fineIndex, tBase } from './env.js';
import { q10 } from './producers.js';

function sq(x: number): number { return x * x; }

const EA_K = E_A_EV / K_BOLTZMANN_EV;
const Q_PER_KG = 1 / Q_MASS;

/** Values the ecosystem needs from a creature's genome and phenotype (loadCreature). */
export interface CreatureEcoInit {
  /** Trait q values of the genome (TRAT section). */
  traits: Uint16Array;
  phenotype?: Pick<Phenotype, 'mouth' | 'gGut' | 'gutVolume'> & Partial<Pick<Phenotype, 'massKg' | 'adultLengthM' | 'nParts' | 'organs' | 'length' | 'span'>>;
  /** Mass of the adult body, kg (default m_ref of the adult length). */
  adultMassKg?: number;
  /** Photosynthetic area, m^2 (default from PHOTOSYNTH parts of the phenotype). */
  photoAreaM2?: number;
  /** Tick of arrival for immigrants and reseeds; children inherit the parent's value. */
  immigrantTick?: number;
}

export function trait(traits: Uint16Array, name: string): number {
  const idx = T[name]!;
  return decodeQ(traits[idx]!, TRAITS[idx]!);
}

/** Kleiber basal power at 15 C reference with the Arrhenius factor, W (CONTRACT 9.4). */
export function basalPowerW(massKg: number, tempC: number, immune: number, tempTol: number): number {
  if (massKg <= 0) return 0;
  const arr = exp(EA_K * (1 / T_REF_K - 1 / (tempC + 273.15)));
  return B0_KLEIBER * pow(massKg, 0.75) * arr * (1 + 0.15 * immune) * (1 + 0.04 * Math.max(0, tempTol - 3));
}

/** Holling type II filter intake, kg/s (CONTRACT 9.5). */
export function hollingFilter(jRaw: number, basalW: number, fFood = 0.6): number {
  const jMax = (P.hollingK * basalW) / (fFood * E_B);
  return jMax <= 0 ? 0 : jRaw / (1 + jRaw / jMax);
}
/** Pumping power of an open filter (CONTRACT 9.5), for physics to add to powerW. */
export function pumpPowerW(basalW: number, filter: number, mouthOpen: number): number {
  return 0.5 * basalW * filter * mouthOpen;
}

/** Assimilation a_k = eps_max,k(g_gut) * e_k^1.3 (DESIGN R11, 02 §2.6.5). */
export function assimilation(lane: number, gGut: number, enzyme: number): number {
  const eps = lane === GUT.PLANT ? 0.15 + 0.6 * gGut : lane === GUT.MEAT ? 0.9 - 0.4 * gGut : 0.1 + 0.35 * gGut;
  return enzyme <= 0 ? 0 : eps * pow(enzyme, ENZYME_THETA);
}
const GUT_HALF = [60, 15, 90];
const GUT_F = [0.6, 1.0, 0.3];

export function ensureCapacity(s: EcoState, cap: number): void {
  if (s.erCap >= cap) return;
  const er = new Float64Array(cap * ER_LANES);
  er.set(s.er);
  s.er = er; s.erCap = cap;
}

/** Decode a creature's traits into the cache. Call on birth, release and snapshot restore. */
export function loadCreature(world: World, s: EcoState, slot: number, init: CreatureEcoInit): void {
  ensureCapacity(s, world.cr.capacity);
  const c = world.cr.c;
  const e = s.er, o = slot * ER_LANES;
  e.fill(0, o, o + ER_LANES);
  const tr = init.traits;
  const x1 = trait(tr, 'DIET_PLANT'), x2 = trait(tr, 'DIET_DETRITUS');
  e[o + ER.E_PLANT] = x1 * (1 - x2); e[o + ER.E_MEAT] = (1 - x1) * (1 - x2); e[o + ER.E_DET] = x2;
  e[o + ER.LIFESPAN_MULT] = trait(tr, 'LIFESPAN_MULT');
  e[o + ER.SENESCENCE] = trait(tr, 'SENESCENCE');
  e[o + ER.IMMUNE] = trait(tr, 'IMMUNE_INVEST');
  e[o + ER.T_OPT] = trait(tr, 'TEMP_OPTIMUM');
  e[o + ER.T_TOL] = trait(tr, 'TEMP_TOLERANCE');
  e[o + ER.O_CRIT] = trait(tr, 'O_CRIT');
  e[o + ER.FAT_CAP] = trait(tr, 'FAT_CAPACITY');
  e[o + ER.CLUTCH] = Math.max(1, Math.round(trait(tr, 'CLUTCH_SIZE')));
  e[o + ER.REPRO_RES] = trait(tr, 'REPRO_RESERVE');
  e[o + ER.BIRTH_FRAC] = trait(tr, 'BIRTH_FRACTION');
  e[o + ER.GROWTH] = trait(tr, 'GROWTH_RATE');
  e[o + ER.MAT_FRAC] = trait(tr, 'MATURITY_FRACTION');
  e[o + ER.SESSILE] = trait(tr, 'SESSILE');
  e[o + ER.BROOD] = trait(tr, 'BROOD_INTERVAL');
  e[o + ER.SEX_PROB] = trait(tr, 'SEX_PROB');
  e[o + ER.SHELL] = trait(tr, 'SHELL');
  e[o + ER.TOXICITY] = trait(tr, 'TOXICITY');
  e[o + ER.ODOUR_A] = trait(tr, 'ODOUR_A'); e[o + ER.ODOUR_B] = trait(tr, 'ODOUR_B');
  e[o + ER.ODOUR_C] = trait(tr, 'ODOUR_C'); e[o + ER.ODOUR_D] = trait(tr, 'ODOUR_D');
  const ph = init.phenotype;
  const mouth: MouthDescriptor = ph?.mouth ?? { filter: 0, scrape: 0, bite: 0, suction: 0, latch: 0, gape: 0, biteForce: 0, mesh: 0 };
  // A suction mouth inhales particles and loose detritus: it feeds through the filter path at
  // 0.8 of a filter's rate (integration decision: suction had no intake at all, so every
  // suction feeder starved; docs/spikes/integration-1.md). Selectivity follows its enzymes.
  e[o + ER.FILTER] = Math.max(mouth.filter, 0.8 * mouth.suction); e[o + ER.SCRAPE] = mouth.scrape; e[o + ER.BITE] = mouth.bite; e[o + ER.GAPE] = mouth.gape;
  const adultL = c.adultLength[slot]! > 0 ? c.adultLength[slot]! : (ph?.adultLengthM ?? Math.min(trait(tr, 'ADULT_LENGTH'), world.lCeilingM));
  c.adultLength[slot] = adultL;
  const adultM = init.adultMassKg ?? M_REF_1M * adultL * adultL * adultL;
  e[o + ER.ADULT_TISSUE_Q] = Math.max(1, Math.floor(adultM * Q_PER_KG));
  e[o + ER.G_GUT] = ph?.gGut ?? 0.5;
  e[o + ER.GUT_VOL] = ph?.gutVolume ?? (0.1 * adultM) / P.gutDensity;
  let photo = init.photoAreaM2 ?? 0;
  if (init.photoAreaM2 === undefined && ph?.organs && ph.length && ph.span && ph.nParts) {
    for (let k = 0; k < ph.nParts; k++) if (ph.organs[k]! & ORGAN.PHOTOSYNTH) photo += ph.length[k]! * ph.span[k]!;
  }
  e[o + ER.PHOTO_AREA] = photo;
  e[o + ER.IMMIGRANT_TICK] = init.immigrantTick ?? -1e18;
  e[o + ER.STAGE_LEN] = c.length[slot]! > 0 ? c.length[slot]! : adultL * e[o + ER.BIRTH_FRAC]!;
  e[o + ER.BIRTH_TISSUE_Q] = Math.floor(e[o + ER.ADULT_TISSUE_Q]! * cube(e[o + ER.BIRTH_FRAC]!));
  e[o + ER.PREV_HEALTH] = c.health[slot]!;
  // time to maturity from the growth law, and the lifespan bought (CONTRACT 9.4)
  if (!(c.tMature[slot]! > 0)) {
    const bf = e[o + ER.BIRTH_FRAC]!, mf = e[o + ER.MAT_FRAC]!;
    const k = 0.25 * 2 * e[o + ER.GROWTH]! * B0_KLEIBER / (E_B * 1.4);
    c.tMature[slot] = Math.max(30, (pow(adultM * cube(mf), 0.25) - pow(adultM * cube(bf), 0.25)) / k);
  }
  if (!(c.lifespan[slot]! > 0)) c.lifespan[slot] = e[o + ER.LIFESPAN_MULT]! * c.tMature[slot]!;
  if (!(c.reproTimer[slot]! > 0)) c.reproTimer[slot] = 0;
  e[o + ER.LOADED] = 1;
}
function cube(x: number): number { return x * x * x; }

export function isLoaded(s: EcoState, slot: number): boolean {
  return slot < s.erCap && s.er[slot * ER_LANES + ER.LOADED] === 1;
}

/** Take q quanta of dissolved N for a new body, nearest cells first, then the reservoir. */
export function drawNutrient(world: World, startCell: number, q: number): number {
  const f = world.fields.qN;
  let need = q;
  const n = f.length;
  for (let k = 0; k < n && need > 0; k++) {
    const i = (startCell + k) % n;
    const m = Math.min(need, f[i]!);
    if (m > 0) { f[i] = f[i]! - m; need -= m; }
  }
  if (need > 0) { const m = Math.min(need, world.g.qReservoir); world.g.qReservoir -= m; need -= m; }
  return q - need;
}

/** Give a creature a body built from dissolved N (founders, releases, reseeds). */
export function endowCreature(world: World, s: EcoState, slot: number, tissueQ: number, reserveQ: number): boolean {
  const c = world.cr.c;
  const i = coarseIndex(world, c.posX[slot]!, c.posY[slot]!);
  const want = Math.floor(tissueQ) + Math.floor(reserveQ);
  let sumN = world.g.qReservoir;
  for (let k = 0; k < world.fields.qN.length; k++) sumN += world.fields.qN[k]!;
  if (sumN < want) return false;
  drawNutrient(world, i, want);
  c.qTissue[slot] = c.qTissue[slot]! + Math.floor(tissueQ);
  c.qReserve[slot] = c.qReserve[slot]! + Math.floor(reserveQ);
  const e = s.er, o = slot * ER_LANES;
  e[o + ER.TISSUE_PEAK_Q] = Math.max(e[o + ER.TISSUE_PEAK_Q]!, c.qTissue[slot]!);
  updateBodySize(world, s, slot);
  return true;
}

function updateBodySize(world: World, s: EcoState, slot: number): void {
  const c = world.cr.c;
  const o = slot * ER_LANES;
  const adultQ = s.er[o + ER.ADULT_TISSUE_Q]!;
  const L = c.adultLength[slot]! * cbrt(Math.max(1e-12, c.qTissue[slot]! / adultQ));
  c.length[slot] = L;
  const Lb = c.adultLength[slot]! * s.er[o + ER.BIRTH_FRAC]!;
  c.maturity[slot] = clamp((L - Lb) / Math.max(1e-9, c.adultLength[slot]! - Lb), 0, 1);
  c.massKg[slot] = (c.qTissue[slot]! + c.qReserve[slot]! + c.qRepro[slot]! + c.qGut[slot * 3]! + c.qGut[slot * 3 + 1]! + c.qGut[slot * 3 + 2]!) * Q_MASS;
}

// ---------- demand, resolve and collect (04 §4.4) ----------
const FIELD = { P: 0, D: 1, BP: 2, BC: 3, SED: 4, N: 5 } as const;
interface Demands { n: number; slot: Int32Array; field: Uint8Array; cell: Int32Array; q: Float64Array }
function demands(s: EcoState, cap: number): Demands {
  const key = 'dem';
  const need = cap * 6;
  let d = (s as unknown as { _dem?: Demands })._dem;
  if (!d || d.q.length < need) {
    d = { n: 0, slot: new Int32Array(need), field: new Uint8Array(need), cell: new Int32Array(need), q: new Float64Array(need) };
    (s as unknown as { _dem?: Demands })._dem = d;
  }
  void key;
  d.n = 0;
  return d;
}
function fieldArray(world: World, field: number): Float64Array {
  const f = world.fields;
  return field === 0 ? f.qP : field === 1 ? f.qD : field === 2 ? f.qBphoto : field === 3 ? f.qBchemo : field === 4 ? f.qSed : f.qN;
}

/** Cause of a pending death, set during the tick. */
function requestDeath(s: EcoState, world: World, slot: number, cause: DeathCause, killer?: number): void {
  const o = slot * ER_LANES;
  if (s.er[o + ER.LAST_DMG] === -1) return; // already requested this tick
  s.er[o + ER.LAST_DMG] = -1;
  const c = world.cr.c;
  s.pending.deaths.push({ slot, id: c.idLo[slot]! + c.idHi[slot]! * 4294967296, cause, ...(killer !== undefined ? { killer } : {}) });
}

/** One ecology tick of metabolism, feeding, growth, reproduction requests, ageing and deaths. */
export function stepCreatures(world: World, s: EcoState, ctx: StepContext): void {
  const dt = DT_ECO;
  const c = world.cr.c;
  const f = world.fields;
  const [fw] = f.fine;
  const [cw] = f.coarse;
  const ccs = world.preset.widthM / cw;
  const fcs = world.preset.widthM / fw;
  const areaC = ccs * ccs, areaF = fcs * fcs;
  const e = s.er;
  const dem = demands(s, world.cr.capacity);
  const nAgents = s.nAgentsAtTick;
  const feeQ = agentCapFeeKg(nAgents, world.agentCap) * Q_PER_KG;
  if (feeQ > 0) s.capTaxTicks++;
  const ageStream = ctx.rng.stream(RNG_STREAM.AGEING);
  const blk = new Uint32Array(4);
  const intakeRate = scratch(s, 'intake', world.cr.capacity * 7);
  const hw = world.cr.highWater;
  for (let slot = 0; slot < hw; slot++) {
    const life = c.life[slot]!;
    if (life === LIFE.CARCASS) { leachCarcass(world, s, slot, dt); continue; }
    if (life !== LIFE.ALIVE || !isLoaded(s, slot)) continue;
    const o = slot * ER_LANES;
    e[o + ER.LAST_DMG] = 0;
    const x = c.posX[slot]!, y = c.posY[slot]!;
    const ci = coarseIndex(world, x, y);
    const fi = fineIndex(world, x, y);
    const Tc = tBase(s, y) + f.tAnom[ci]!;
    const O2 = f.o2[ci]!;
    c.tempC[slot] = Tc; c.oxygen[slot] = O2;
    const carry = c.carry.subarray(slot * 4, slot * 4 + 4);
    const bodyQ = c.qTissue[slot]! + c.qReserve[slot]! + c.qRepro[slot]!;
    const m = bodyQ * Q_MASS;
    const immune = e[o + ER.IMMUNE]!;
    const B = basalPowerW(m, Tc, immune, e[o + ER.T_TOL]!);
    const starving = c.qReserve[slot]! <= 0;
    e[o + ER.STARVING] = starving ? 1 : 0;
    const Prep = starving ? 0 : repairPowerW(B, e[o + ER.LIFESPAN_MULT]!);
    // pumping power of an open filter (CONTRACT 9.5); the intake below assumes the mouth open
    const Ppump = e[o + ER.FILTER]! > 0 ? pumpPowerW(B, e[o + ER.FILTER]!, 1) : 0;
    const Pmus = Math.max(0, c.powerW[slot]!), Pbr = Math.max(0, c.brainW[slot]!) + Ppump;
    const Ptot = B + Prep + Pmus + Pbr;
    // 1. burning (reserve to dissolved N, consumes oxygen), then catabolism of tissue
    const burnQ = quantiseWithCarry((Ptot * dt) / (Q_MASS * E_B), carry, CARRY.BURN);
    let fromRes = Math.min(burnQ, c.qReserve[slot]!);
    c.qReserve[slot] = c.qReserve[slot]! - fromRes;
    let burnt = fromRes;
    if (burnQ > fromRes) {
      const need = Math.ceil((burnQ - fromRes) / CATABOLISM_EFF);
      const t = Math.min(need, c.qTissue[slot]!);
      c.qTissue[slot] = c.qTissue[slot]! - t;
      burnt += t;
      fromRes = 0;
    }
    if (burnt > 0) {
      f.qN[ci] = f.qN[ci]! + burnt;
      consumeO2(world, ci, burnt);
      if (Ptot > 0) {
        book(world, CH.heatBasal, (burnt * B) / Ptot); book(world, CH.heatRepair, (burnt * Prep) / Ptot);
        book(world, CH.heatMuscle, (burnt * Pmus) / Ptot); book(world, CH.heatOrgans, (burnt * Pbr) / Ptot);
      }
    }
    if (c.qTissue[slot]! < P.starveFloor * e[o + ER.TISSUE_PEAK_Q]! || c.qTissue[slot]! <= 0) { requestDeath(s, world, slot, 'starvation'); continue; }
    // 2. field feeding demands
    const gutCap = (e[o + ER.GUT_VOL]! * P.gutDensity) * Q_PER_KG;
    const gutNow = c.qGut[slot * 3]! + c.qGut[slot * 3 + 1]! + c.qGut[slot * 3 + 2]!;
    let free = gutCap - gutNow;
    const L = c.length[slot]!;
    const gape = e[o + ER.GAPE]! > 0 ? e[o + ER.GAPE]! : 0.3 * L;
    const filt = e[o + ER.FILTER]!;
    if (free > 0 && filt > 0) {
      // Only a physically attached creature filters the current while standing still. The
      // SESSILE trait alone used to grant still-water intake in mid-water, which is the
      // "sessile jet blob" exploit of spike evolab-1 (integration decision, docs/spikes/integration-1.md).
      const sessile = (c.flags[slot]! & CF.SESSILE_ATTACHED) !== 0;
      const vx = (sessile ? 0 : c.velX[slot]!) - f.flowU[ci]!, vy = (sessile ? 0 : c.velY[slot]!) - f.flowV[ci]!;
      const vrel = Math.sqrt(vx * vx + vy * vy) + P.pumpFloorBL * L; // pumping keeps a floor of flow
      const cP = (f.qP[fi]! * Q_MASS) / areaF, cD = (f.qD[ci]! * Q_MASS) / areaC;
      // Selective filtering (integration decision, docs/spikes/integration-1.md): particles are
      // retained in proportion to the enzymes that can digest them, so a plant specialist is
      // not choked by detritus it cannot use (it keeps a quarter of what it meets).
      const sP = P.filterSelect0 + (1 - P.filterSelect0) * e[o + ER.E_PLANT]!;
      const sD = P.filterSelect0 + (1 - P.filterSelect0) * e[o + ER.E_DET]!;
      const eP = cP * sP, eD = cD * sD;
      const jRaw = filt * gape * vrel * (eP + eD);
      const J = hollingFilter(jRaw, B);
      let want = Math.min(free, (J * dt) * Q_PER_KG);
      if (want > 0 && eP + eD > 0) {
        const wp = quantiseWithCarry((want * eP) / (eP + eD), carry, CARRY.INTAKE);
        const wd = quantiseWithCarry((want * eD) / (eP + eD), carry, CARRY.INTAKE);
        pushDem(dem, slot, FIELD.P, fi, wp); pushDem(dem, slot, FIELD.D, ci, wd);
        free -= wp + wd; want = 0;
      }
    }
    const scr = e[o + ER.SCRAPE]!;
    if (free > 0 && scr > 0) {
      const sdfNear = nearSubstrate(world, x, y, Math.max(0.15, 2 * L));
      if (sdfNear) {
        const rate = scr * gape * P.scrapeRate * Math.max(L, 0.002);
        const cB = ((f.qBphoto[fi]! + f.qBchemo[fi]!) * Q_MASS) / areaF;
        const want = Math.min(free, rate * cB * dt * Q_PER_KG * 4);
        if (want > 0 && cB > 0) {
          const share = f.qBphoto[fi]! / (f.qBphoto[fi]! + f.qBchemo[fi]!);
          const a = quantiseWithCarry(want * share, carry, CARRY.INTAKE);
          const b = quantiseWithCarry(want * (1 - share), carry, CARRY.INTAKE);
          pushDem(dem, slot, FIELD.BP, fi, a); pushDem(dem, slot, FIELD.BC, fi, b);
          free -= a + b;
        }
        // deposit feeders also take sediment when their enzymes favour detritus
        if (e[o + ER.E_DET]! > 0.3 && free > 0) {
          const col = Math.min(cw - 1, Math.floor(x / ccs));
          const cS = (f.qSed[col]! * Q_MASS) / (ccs * world.preset.heightM * 0.05);
          const wq = quantiseWithCarry(Math.min(free, rate * cS * dt * Q_PER_KG), carry, CARRY.INTAKE);
          pushDem(dem, slot, FIELD.SED, col, wq);
        }
      }
    }
    const pa = e[o + ER.PHOTO_AREA]!;
    if (pa > 0) {
      const n = (f.qN[ci]! * Q_MASS) / areaC;
      const gain = P.photoEff * pa * f.light[ci]! * (n / (n + P.kN)) * q10(Tc) * s.mods.muBoost;
      const capQ = e[o + ER.FAT_CAP]! * bodyQ * 1.2;
      const room = Math.max(0, capQ - c.qReserve[slot]!);
      pushDem(dem, slot, FIELD.N, ci, quantiseWithCarry(Math.min(room, gain * dt * Q_PER_KG), carry, CARRY.INTAKE));
    }
    // 3. digestion by the bridge rule (CONTRACT 9.2)
    const gG = e[o + ER.G_GUT]!;
    const enz = [e[o + ER.E_PLANT]!, e[o + ER.E_MEAT]!, e[o + ER.E_DET]!];
    for (let k = 0; k < 3; k++) {
      const G = c.qGut[slot * 3 + k]!;
      if (G <= 0) continue;
      const th = GUT_HALF[k]! * pow(Math.max(m, 1e-12), 0.25);
      const proc = G * (1 - exp((-LN2 * dt) / th)) * q10(Tc);
      let F = quantiseWithCarry(Math.min(G, proc), carry, CARRY.EXCRETION);
      if (F > G) F = G;
      if (F <= 0) continue;
      const a = assimilation(k, gG, enz[k]!);
      const fk = GUT_F[k]!;
      const toRes = Math.floor(fk * a * F), toN = Math.floor((1 - fk) * a * F), toD = F - toRes - toN;
      const sda = Math.floor(SDA_FRACTION * toRes);
      c.qGut[slot * 3 + k] = G - F;
      c.qReserve[slot] = c.qReserve[slot]! + toRes - sda;
      f.qN[ci] = f.qN[ci]! + toN + sda;
      f.qD[ci] = f.qD[ci]! + toD;
      if (sda > 0) consumeO2(world, ci, sda);
      book(world, CH.absorption, toRes); book(world, CH.faeces, toD);
    }
    // 4. growth (C_G = 1.4) and restage requests
    const fatCap = e[o + ER.FAT_CAP]!;
    const resCap = fatCap * bodyQ;
    const adultQ = e[o + ER.ADULT_TISSUE_Q]!;
    if (c.qTissue[slot]! < adultQ && c.qReserve[slot]! > 0.3 * resCap) {
      const gMax = (2 * e[o + ER.GROWTH]! * B) / (E_B * Q_MASS * C_G);
      const avail = (c.qReserve[slot]! - 0.3 * resCap) / C_G;
      let dm = quantiseWithCarry(Math.min(gMax * dt, avail, adultQ - c.qTissue[slot]!), carry, CARRY.GROWTH);
      const cost = dm + Math.ceil((C_G - 1) * dm);
      if (cost > c.qReserve[slot]!) dm = 0;
      if (dm > 0) {
        c.qReserve[slot] = c.qReserve[slot]! - cost;
        c.qTissue[slot] = c.qTissue[slot]! + dm;
        f.qN[ci] = f.qN[ci]! + (cost - dm);
        book(world, CH.growth, dm);
      }
    }
    if (c.qTissue[slot]! > e[o + ER.TISSUE_PEAK_Q]!) e[o + ER.TISSUE_PEAK_Q] = c.qTissue[slot]!;
    updateBodySize(world, s, slot);
    if (Math.abs(c.length[slot]! / e[o + ER.STAGE_LEN]! - 1) >= 0.04) {
      e[o + ER.STAGE_LEN] = c.length[slot]!;
      c.stage[slot] = (c.stage[slot]! + 1) & 0xffff;
      s.pending.restage.push(slot);
    }
    // 5. reproduction: surplus reserve to qRepro, then a clutch request (CONTRACT 9.6)
    const mature = c.length[slot]! >= e[o + ER.MAT_FRAC]! * c.adultLength[slot]!;
    if (mature) {
      const keep = e[o + ER.REPRO_RES]! * resCap;
      const surplus = Math.floor(c.qReserve[slot]! - keep);
      if (surplus > 0) {
        const mv = Math.min(surplus, Math.floor((4 * B * dt) / (E_B * Q_MASS)) + 1);
        c.qReserve[slot] = c.qReserve[slot]! - mv;
        c.qRepro[slot] = c.qRepro[slot]! + mv;
      }
      c.reproTimer[slot] = Math.max(0, c.reproTimer[slot]! - dt);
      if (c.reproTimer[slot]! <= 0 && e[o + ER.REPRO_REQ] === 0 && nAgents < world.agentCap) {
        const ct = e[o + ER.BIRTH_TISSUE_Q]!;
        const cr = Math.floor(FAT_CAPACITY_0 * ct);
        const over = Math.floor(OVERHEAD_FRACTION * ct + OVERHEAD_ABS_KG * Q_PER_KG);
        const base = ct + Math.ceil((C_G - 1) * ct) + cr + over;
        const fee = s.capTaxMode === 'additive' ? Math.floor(feeQ) : Math.floor(base * 2 * pow(nAgents / world.agentCap, 8));
        const per = base + fee;
        const afford = Math.floor(c.qRepro[slot]! / per);
        const want = e[o + ER.CLUTCH]!;
        const gate = c.brainClass[slot] === 255 || c.out[slot * 8 + 4]! > -0.5;
        if (afford >= 1 && (afford >= want || c.qReserve[slot]! >= 0.95 * resCap) && gate) {
          const n = Math.min(want, afford);
          const req: BirthRequest = {
            parentSlot: slot, parentId: c.idLo[slot]! + c.idHi[slot]! * 4294967296, requestIndex: 0, n,
            mode: e[o + ER.SEX_PROB]! > 0.5 ? 'sex' : 'bud', childTissueQ: ct, childReserveQ: cr, overheadQ: over, feeQ: fee,
          };
          s.pending.births.push(req);
          e[o + ER.REPRO_REQ] = 1;
          c.reproTimer[slot] = Math.max(1, e[o + ER.BROOD]! * c.tMature[slot]!);
        }
      }
    }
    // 6. health: hypoxia and thermal stress; wounds from physics are predation
    const oc = e[o + ER.O_CRIT]!;
    let dmg = 0, cause: DeathCause = 'disaster';
    if (O2 < oc) { dmg += P.hypoxiaDamage * ((oc - O2) / oc) * dt; cause = 'hypoxia'; }
    if (Math.abs(Tc - e[o + ER.T_OPT]!) > 2.5 * e[o + ER.T_TOL]!) dmg += P.thermalDamage * dt;
    for (const z of s.mods.toxins) if (z[2]! < 0 || sq(x - z[0]!) + sq(y - z[1]!) < z[2]! * z[2]!) dmg += z[3]! * 0.05 * dt * (1 - e[o + ER.TOXICITY]!);
    const hPrev = e[o + ER.PREV_HEALTH]!;
    const wounded = c.health[slot]! < hPrev - 1e-6;
    let hNow = c.health[slot]! - dmg;
    if (dmg === 0 && !starving && !wounded) hNow = Math.min(1, hNow + P.healRate * dt);
    c.health[slot] = hNow;
    e[o + ER.PREV_HEALTH] = hNow;
    if (hNow <= 0) { requestDeath(s, world, slot, wounded ? 'predation' : cause); continue; }
    // 7. ageing hazard (Gompertz, frailty 3x while starving) from stream AGEING
    e[o + ER.AGE_CLOCK] = e[o + ER.AGE_CLOCK]! + dt * (starving ? 3 : 1);
    const h = ageingHazard(e[o + ER.AGE_CLOCK]!, Math.max(1, c.lifespan[slot]!), e[o + ER.SENESCENCE]!);
    const pDie = 1 - exp(-h * dt);
    ageStream.block(ctx.tick, c.idLo[slot]! + c.idHi[slot]! * 4294967296, 0, blk);
    if ((blk[0]! >>> 8) * (1 / 16777216) < pDie) { requestDeath(s, world, slot, 'age'); continue; }
  }
  resolveAndCollect(world, s, dem, intakeRate);
  updateFieldTrophic(world, s);
  // diet and trophic EMAs (role inference is a statistic only)
  const alpha = dt / P.dietTau;
  for (let slot = 0; slot < hw; slot++) {
    if (c.life[slot] !== LIFE.ALIVE || !isLoaded(s, slot)) continue;
    const o = slot * ER_LANES;
    let tot = 0;
    for (let k = 0; k < 7; k++) {
      const r = intakeRate[slot * 7 + k]!;
      c.diet[slot * 7 + k] = c.diet[slot * 7 + k]! * (1 - alpha) + alpha * r;
      tot += c.diet[slot * 7 + k]!;
    }
    void tot; void o;
  }
}

function pushDem(d: Demands, slot: number, field: number, cell: number, q: number): void {
  if (q <= 0) return;
  if (d.n >= d.q.length) return;
  d.slot[d.n] = slot; d.field[d.n] = field; d.cell[d.n] = cell; d.q[d.n] = q; d.n++;
}

function nearSubstrate(world: World, x: number, y: number, r: number): boolean {
  const [sw, sh] = world.fields.sdfGrid;
  const cs = world.preset.widthM / sw;
  const ix = clamp(Math.floor(x / cs), 0, sw - 1), iy = clamp(Math.floor(y / cs), 0, sh - 1);
  const sdf = world.fields.sdf[iy * sw + ix]!;
  return sdf < r && world.fields.material[iy * sw + ix] !== MATERIAL.ICE;
}

/** Resolve demands per (field, cell) pro rata and move the food into the guts. */
function resolveAndCollect(world: World, s: EcoState, d: Demands, intakeRate: Float64Array): void {
  const c = world.cr.c;
  const sums = new Map<number, number>();
  for (let k = 0; k < d.n; k++) {
    const key = d.field[k]! * 1e8 + d.cell[k]!;
    sums.set(key, (sums.get(key) ?? 0) + d.q[k]!);
  }
  for (let k = 0; k < d.n; k++) {
    const fld = d.field[k]!, cell = d.cell[k]!, slot = d.slot[k]!;
    const arr = fieldArray(world, fld);
    const D = sums.get(fld * 1e8 + cell)!;
    const avail = arr[cell]!;
    const rho = D <= avail ? 1 : avail / D;
    let q = Math.floor(d.q[k]! * rho);
    if (q > arr[cell]!) q = arr[cell]!;
    if (q <= 0) continue;
    arr[cell] = arr[cell]! - q;
    const o = slot * ER_LANES;
    if (fld === FIELD.N) {
      c.qReserve[slot] = c.qReserve[slot]! + q;
      book(world, CH.photosynthesis, q);
      s.er[o + ER.PHOTO_EMA] = s.er[o + ER.PHOTO_EMA]! * 0.999 + 0.001 * q;
      continue;
    }
    const lane = fld === FIELD.D || fld === FIELD.SED ? GUT.DETRITUS : GUT.PLANT;
    c.qGut[slot * 3 + lane] = c.qGut[slot * 3 + lane]! + q;
    book(world, CH.ingestion, q);
    const src = fld === FIELD.P ? DIET.PHYTO : fld === FIELD.BP || fld === FIELD.BC ? DIET.MAT : DIET.DETRITUS;
    intakeRate[slot * 7 + src] = intakeRate[slot * 7 + src]! + (q * Q_MASS) / DT_ECO;
    c.flags[slot] = c.flags[slot]! | CF.EATING;
  }
}

/** First-order carcass leaching to D and N, with the cold-slows-decay half-life (04 §4.4). */
function leachCarcass(world: World, s: EcoState, slot: number, dt: number): void {
  const c = world.cr.c;
  const f = world.fields;
  const ci = coarseIndex(world, c.posX[slot]!, c.posY[slot]!);
  const T = tBase(s, c.posY[slot]!) + f.tAnom[ci]!;
  const th = P.carcassHalfLife / q10(T);
  const pools = [c.qGut, c.qGut, c.qGut, c.qReserve, c.qRepro, c.qTissue];
  const idx = [slot * 3, slot * 3 + 1, slot * 3 + 2, slot, slot, slot];
  let tot = 0;
  for (let k = 0; k < 6; k++) tot += pools[k]![idx[k]!]!;
  const carry = c.carry.subarray(slot * 4, slot * 4 + 4);
  let q = tot < 1000 ? tot : quantiseWithCarry(tot * (1 - exp((-LN2 * dt) / th)), carry, CARRY.BURN);
  if (q > tot) q = tot;
  let taken = 0;
  for (let k = 0; k < 6 && taken < q; k++) {
    const a = pools[k]!, i = idx[k]!;
    const m = Math.min(a[i]!, q - taken);
    a[i] = a[i]! - m; taken += m;
  }
  const toD = Math.floor(taken / 2);
  f.qD[ci] = f.qD[ci]! + toD; f.qN[ci] = f.qN[ci]! + (taken - toD);
  consumeO2(world, ci, taken - toD);
  book(world, CH.decay, taken);
  if (tot - taken <= 0 && !s.pending.free.includes(slot)) s.pending.free.push(slot);
}

/** Convert a living creature to a carcass (CONTRACT 9.2 "death"): its pools stay in place. */
export function commitDeath(world: World, s: EcoState, slot: number, cause: DeathCause, ctx: StepContext, killer?: number): void {
  const c = world.cr.c;
  if (c.life[slot] !== LIFE.ALIVE) return;
  c.life[slot] = LIFE.CARCASS;
  c.flags[slot] = c.flags[slot]! & ~(CF.EATING | CF.MATING | CF.LATCHED | CF.SESSILE_ATTACHED);
  world.g.liveCount = Math.max(0, world.g.liveCount - 1);
  world.g.carcassCount++;
  const q = c.qTissue[slot]! + c.qReserve[slot]! + c.qRepro[slot]!;
  book(world, CH.deathToCarcass, q);
  const id = c.idLo[slot]! + c.idHi[slot]! * 4294967296;
  ctx.events.emit({ k: 'death', id, species: c.species[slot]!, pos: [c.posX[slot]!, c.posY[slot]!], size: c.length[slot]!, cause, ...(killer !== undefined ? { killer } : {}) } as never);
  if (slot < s.erCap) s.er[slot * ER_LANES + ER.LOADED] = 2; // carcass: keep traits for trophic records
}

/**
 * Commit one offspring of a birth request into an allocated, loaded child slot. Moves the
 * child's tissue and starting reserve out of the parent's qRepro and burns the build cost,
 * the per-offspring overhead and the cap fee to dissolved N. Returns false (nothing moved)
 * when the parent can no longer pay.
 */
export function commitOffspring(world: World, s: EcoState, req: BirthRequest, childSlot: number): boolean {
  const c = world.cr.c;
  const p = req.parentSlot;
  const build = Math.ceil((C_G - 1) * req.childTissueQ);
  const per = req.childTissueQ + build + req.childReserveQ + req.overheadQ + req.feeQ;
  if (c.qRepro[p]! < per) return false;
  c.qRepro[p] = c.qRepro[p]! - per;
  c.qTissue[childSlot] = c.qTissue[childSlot]! + req.childTissueQ;
  c.qReserve[childSlot] = c.qReserve[childSlot]! + req.childReserveQ;
  const ci = coarseIndex(world, c.posX[p]!, c.posY[p]!);
  const burnt = build + req.overheadQ + req.feeQ;
  world.fields.qN[ci] = world.fields.qN[ci]! + burnt;
  book(world, CH.growth, build); book(world, CH.reproduction, req.overheadQ); book(world, CH.capFee, req.feeQ);
  const o = childSlot * ER_LANES, op = p * ER_LANES;
  if (isLoaded(s, childSlot)) {
    s.er[o + ER.TISSUE_PEAK_Q] = req.childTissueQ;
    s.er[o + ER.IMMIGRANT_TICK] = s.er[op + ER.IMMIGRANT_TICK]!;
    updateBodySize(world, s, childSlot);
    s.er[o + ER.STAGE_LEN] = c.length[childSlot]!;
  }
  c.trophic[childSlot] = c.trophic[p]!;
  return true;
}

/** End of a parent's request (all offspring committed or deferred): it may request again. */
export function clearRequest(s: EcoState, parentSlot: number): void {
  if (parentSlot < s.erCap) s.er[parentSlot * ER_LANES + ER.REPRO_REQ] = 0;
}

/**
 * A bite or swallow resolved by physics: up to chunkKg moves from the target (live or carcass)
 * into the attacker's meat gut. Returns the quanta moved. Live prey drained below the
 * starvation floor dies of predation.
 */
export function applyBite(world: World, s: EcoState, attacker: number, target: number, chunkKg: number): number {
  const c = world.cr.c;
  if (c.life[attacker] !== LIFE.ALIVE || (c.life[target] !== LIFE.ALIVE && c.life[target] !== LIFE.CARCASS)) return 0;
  const oa = attacker * ER_LANES;
  const gutCap = isLoaded(s, attacker) ? s.er[oa + ER.GUT_VOL]! * P.gutDensity * Q_PER_KG : chunkKg * Q_PER_KG;
  const free = gutCap - (c.qGut[attacker * 3]! + c.qGut[attacker * 3 + 1]! + c.qGut[attacker * 3 + 2]!);
  let want = Math.floor(Math.min(chunkKg * Q_PER_KG, free));
  if (want <= 0) return 0;
  const pools = [c.qTissue, c.qReserve, c.qRepro, c.qGut, c.qGut, c.qGut];
  const idx = [target, target, target, target * 3, target * 3 + 1, target * 3 + 2];
  let moved = 0;
  for (let k = 0; k < 6 && want > 0; k++) {
    const a = pools[k]!, i = idx[k]!;
    const m = Math.min(a[i]!, want);
    a[i] = a[i]! - m; want -= m; moved += m;
  }
  c.qGut[attacker * 3 + GUT.MEAT] = c.qGut[attacker * 3 + GUT.MEAT]! + moved;
  book(world, CH.ingestion, moved);
  const live = c.life[target] === LIFE.ALIVE;
  const lane = live ? DIET.LIVE_PREY : DIET.CARCASS;
  c.diet[attacker * 7 + lane] = c.diet[attacker * 7 + lane]! + (moved * Q_MASS) * (DT_ECO / P.dietTau) / DT_ECO;
  // trophic level: one above what was eaten (Levine 1980), as an EMA weighted by meal size
  const bodyQ = c.qTissue[attacker]! + c.qReserve[attacker]! + 1;
  const w = Math.min(1, moved / bodyQ);
  c.trophic[attacker] = c.trophic[attacker]! * (1 - w) + (c.trophic[target]! + 1) * w;
  if (live && isLoaded(s, target) && c.qTissue[target]! < P.starveFloor * s.er[target * ER_LANES + ER.TISSUE_PEAK_Q]!) {
    requestDeath(s, world, target, 'predation', c.idLo[attacker]! + c.idHi[attacker]! * 4294967296);
  }
  return moved;
}

/** Per-tick trophic EMA for field feeders: 1 + mean TL of food (field food has TL 1). */
export function updateFieldTrophic(world: World, s: EcoState): void {
  const c = world.cr.c;
  const a = DT_ECO / P.dietTau;
  for (let slot = 0; slot < world.cr.highWater; slot++) {
    if (c.life[slot] !== LIFE.ALIVE || !isLoaded(s, slot)) continue;
    let field = 0, meat = 0;
    for (let k = 0; k < 4; k++) field += c.diet[slot * 7 + k]!;
    meat = c.diet[slot * 7 + DIET.CARCASS]! + c.diet[slot * 7 + DIET.LIVE_PREY]! + c.diet[slot * 7 + DIET.HOST]!;
    const photo = s.er[slot * ER_LANES + ER.PHOTO_EMA]!;
    const tot = field + meat + photo * Q_MASS / DT_ECO;
    if (tot <= 0) continue;
    // producers sit at TL 1, field grazers at 2; meat eaters move in applyBite
    const wP = (photo * Q_MASS / DT_ECO) / tot, wF = field / tot;
    c.trophic[slot] = c.trophic[slot]! + a * (wP * (1 - c.trophic[slot]!) + wF * (2 - c.trophic[slot]!));
  }
}
