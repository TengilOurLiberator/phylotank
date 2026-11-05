/**
 * src/ecosystem: habitat, fields, flow, producers, the mass ledger, metabolism, feeding,
 * ageing, reproduction requests, the agent-cap tax, disease and god-power effects.
 * CONTRACT 3, 5.4, 9, 13. See README.md and docs/modules/ecosystem.md.
 *
 * Cadence inside the contract's pipeline (CONTRACT 10.1):
 * - stepEcology (10 Hz): creatures (metabolism, feeding, growth, reproduction requests,
 *   ageing, health), disease, carcass leaching, the death commit; and on every fifth ecology
 *   tick (tick % 15 == 0, dt 0.5 s) the field pass: chemistry, producers, cycling and
 *   conservative transport of every field.
 * - stepSlow (2 Hz): god-power modifiers, clocks and surface light, flow modes and grids,
 *   the light scan.
 * Births, restages, carcass frees and spawns are left in `takePending` for the sim to commit
 * (docs/contract-requests/ecosystem.md); `commitPending` is a reference implementation.
 */
import {
  DT, DT_ECO, hash32, RNG_STREAM, LIFE, MATERIAL, Q_MASS, SCENT, smoothstep, SLOW_EVERY, exp, CF, NONE_U32,
  type DeathCause, type EcosystemModule, type GodEventScheduled, type LedgerAudit, type StepContext, type World,
} from '../core/index.js';
import { agentCapFeeKg, ageingHazard, audit as ledgerAudit, Dither, repairPowerW } from './ledger.js';
import { P } from './params.js';
import {
  ER, ER_LANES, getState, hasState, N_CHANNELS, newMods, newPending, newSpores, newStrains, scratch, setState,
  type BirthRequest, type EcoState, type Pending, type SpawnRequest,
} from './state.js';
import { generateTerrain, rebuildSdf, type HabitatName } from './terrain.js';
import { computeHFloor, FLOW_MODES, FLOW_TAU_S, flowAtPoint, initFlowModes, rebuildFineFlux, rebuildFlow, stepFlowModes } from './flow.js';
import { coarseIndex, kzRows, scanLight, stepChemistry, temperatureAt, updateEnv } from './env.js';
import { ringKernel, stepCycling, stepProducers } from './producers.js';
import { prepare, transportF, transportQ, type Grid, type TransportOpts } from './transport.js';
import {
  applyBite, clearRequest, commitDeath, commitOffspring, endowCreature, isLoaded, loadCreature, stepCreatures,
  type CreatureEcoInit,
} from './metabolism.js';
import { inheritInfection, seedReservoirStrains, stepDisease } from './disease.js';
import { applyGod, evalModifiers, mutagenAt as mutagenAtS, natureEvent as natureEventS } from './god.js';
import { computeMetrics as computeMetricsS, type EcoMetrics } from './metrics.js';

function sq(x: number): number { return x * x; }

export { agentCapFeeKg, ageingHazard, repairPowerW, FLOW_MODES, FLOW_TAU_S, P as ECO_PARAMS };
export type { BirthRequest, CreatureEcoInit, EcoMetrics, HabitatName, Pending, SpawnRequest };
export { basalPowerW, hollingFilter, pumpPowerW, assimilation, trait } from './metabolism.js';
export { envelopeFor, envelopeValue, leadTicks, planCast, leviathanEndowment, targetRegion } from './god.js';
export { hill, roleOf, trophicLevels, ROLES } from './metrics.js';
export { bindProb, recogProb, infectProb, keySim, popcount32, newStrain } from './disease.js';
export { ringKernel, leniaG, steele, q10 } from './producers.js';
export { HABITATS, sampleSdf } from './terrain.js';
export { transportQ, transportF } from './transport.js';
export { Dither, transfer, inject, remove } from './ledger.js';

/** Habitat preset: WorldConfig has no field for it yet (contract request), so it is read loosely. */
function habitatOf(world: World): HabitatName {
  const h = (world.config as { habitat?: string }).habitat;
  if (h === 'lagoon' || h === 'twinBasins' || h === 'open' || h === 'basin') return h;
  // Phase-0 compatibility: the skeleton's passive motes ignore terrain, so they get an open tank.
  return world.config.skeletonMotes ? 'open' : 'basin';
}

/** Recompute wet masks, floor rows and the mat substrate after any terrain change. */
export function refreshMasks(world: World, s: EcoState): void {
  const f = world.fields;
  const [w, h] = f.coarse;
  const [fw, fh] = f.fine;
  const [sw] = f.sdfGrid;
  const rs = sw / w, rf = fw / sw;
  for (let iy = 0; iy < h; iy++) for (let ix = 0; ix < w; ix++) {
    let n = 0;
    for (let ky = iy * rs; ky < (iy + 1) * rs; ky++) for (let kx = ix * rs; kx < (ix + 1) * rs; kx++) if (f.material[ky * sw + kx] === MATERIAL.WATER) n++;
    s.wetC[iy * w + ix] = n * 2 >= rs * rs ? 1 : 0;
  }
  const sub: number[] = [], mask: number[] = [];
  for (let jy = 0; jy < fh; jy++) for (let jx = 0; jx < fw; jx++) {
    const k = ((jy / rf) | 0) * sw + ((jx / rf) | 0);
    const wet = f.material[k] === MATERIAL.WATER ? 1 : 0;
    s.wetF[jy * fw + jx] = wet;
    if (!wet) continue;
    const m = smoothstep(0.4, 0.1, f.sdf[k]!);
    if (m > 0.01) { sub.push(jy * fw + jx); mask.push(m); }
  }
  s.substrate = Int32Array.from(sub);
  s.subMask = Float32Array.from(mask);
  for (let ix = 0; ix < w; ix++) {
    let r = -1;
    for (let iy = h - 1; iy >= 0; iy--) if (s.wetC[iy * w + ix]) { r = iy; break; }
    s.floorRowC[ix] = r;
  }
  rescueDryMass(world, s);
  computeHFloor(world, s);
}

/** Mass left in cells that turned to rock or ice moves to the nearest wet cell above (conserving). */
function rescueDryMass(world: World, s: EcoState): void {
  const f = world.fields;
  const [w, h] = f.coarse;
  const [fw, fh] = f.fine;
  const r = fw / w;
  const target = (ix: number, iy: number): number => {
    for (let y = iy; y >= 0; y--) if (s.wetC[y * w + ix]) return y * w + ix;
    for (let k = 0; k < w * h; k++) if (s.wetC[k]) return k;
    return -1;
  };
  for (let iy = 0; iy < h; iy++) for (let ix = 0; ix < w; ix++) {
    const i = iy * w + ix;
    if (s.wetC[i]) continue;
    if (f.qN[i]! > 0 || f.qD[i]! > 0) {
      const t = target(ix, iy);
      if (t < 0) continue;
      f.qN[t] = f.qN[t]! + f.qN[i]!; f.qD[t] = f.qD[t]! + f.qD[i]!; f.qN[i] = 0; f.qD[i] = 0;
    }
  }
  for (let jy = 0; jy < fh; jy++) for (let jx = 0; jx < fw; jx++) {
    const j = jy * fw + jx;
    if (s.wetF[j]) continue;
    const q = f.qP[j]! + f.qBphoto[j]! + f.qBchemo[j]!;
    if (q <= 0) continue;
    const t = target((jx / r) | 0, (jy / r) | 0);
    if (t < 0) continue;
    f.qD[t] = f.qD[t]! + q; f.qP[j] = 0; f.qBphoto[j] = 0; f.qBchemo[j] = 0;
  }
}

/** Initial distribution of M_target over the pools; the total is exact. */
function seedMass(world: World, s: EcoState): void {
  const f = world.fields;
  const M = world.g.mTargetQ;
  const [w, h] = f.coarse;
  const [fw, fh] = f.fine;
  const cs = world.preset.widthM / w;
  const r = fw / w;
  let placed = 0;
  const R0 = Math.floor(P.reservoirFrac * M);
  world.g.qReservoir = R0; s.rActiveTargetQ = R0; placed += R0;
  // phytoplankton in the photic quarter
  const photic: number[] = [];
  for (let jy = 0; jy < Math.floor(fh * 0.25); jy++) for (let jx = 0; jx < fw; jx++) if (s.wetF[jy * fw + jx]) photic.push(jy * fw + jx);
  const per = (q: number, n: number): number => (n > 0 ? Math.floor(q / n) : 0);
  const pEach = per(0.08 * M, photic.length);
  for (const j of photic) { f.qP[j] = pEach; placed += pEach; }
  // patchy mats on lit substrate, chemo mats near vents
  const seed = hash32(world.g.seedLo, world.g.seedHi, 0x3a75);
  const bMaxQ = (P.bMax * sq(world.preset.widthM / fw)) / Q_MASS;
  const patch: number[] = [], vent: number[] = [];
  for (let k = 0; k < s.substrate.length; k++) {
    const j = s.substrate[k]!;
    const jx = j % fw, jy = (j - jx) / fw;
    const x = (jx + 0.5) * (world.preset.widthM / fw), y = (jy + 0.5) * (world.preset.widthM / fw);
    if (s.terrain.vents.some((v) => sq(v.x - x) + sq(v.y - y) < 4)) vent.push(j);
    else if (y < 0.4 * world.preset.heightM && hash32(seed, jx >> 3, jy >> 3) / 4294967296 < 0.35) patch.push(j);
  }
  const bEach = Math.min(Math.floor(0.5 * bMaxQ), per(0.02 * M, patch.length));
  for (const j of patch) { f.qBphoto[j] = bEach; placed += bEach; }
  const cEach = Math.min(Math.floor(0.5 * bMaxQ), per(0.005 * M, vent.length));
  for (const j of vent) { f.qBchemo[j] = cEach; placed += cEach; }
  void r;
  // detritus, sediment
  const wet: number[] = [];
  for (let i = 0; i < w * h; i++) if (s.wetC[i]) wet.push(i);
  const dEach = per(0.02 * M, wet.length);
  for (const i of wet) { f.qD[i] = dEach; placed += dEach; }
  const floors: number[] = [];
  for (let ix = 0; ix < w; ix++) if (s.floorRowC[ix]! >= 0) floors.push(ix);
  const sEach = per(0.03 * M, floors.length);
  for (const ix of floors) { f.qSed[ix] = sEach; placed += sEach; }
  // dissolved N takes the rest, exactly
  const rest = M - placed;
  const nEach = per(rest, wet.length);
  for (const i of wet) f.qN[i] = f.qN[i]! + nEach;
  f.qN[wet[0]!] = f.qN[wet[0]!]! + (rest - nEach * wet.length);
  world.g.mTotalQ = M;
  for (let i = 0; i < w * h; i++) f.o2[i] = s.wetC[i] ? 1 : 0;
  void cs;
}

function newState(world: World, habitat: HabitatName): EcoState {
  const f = world.fields;
  const [w, h] = f.coarse;
  const [fw, fh] = f.fine;
  const terrain = generateTerrain(world, habitat);
  const s: EcoState = {
    terrain, wetC: new Uint8Array(w * h), wetF: new Uint8Array(fw * fh), floorRowC: new Int32Array(w),
    substrate: new Int32Array(0), subMask: new Float32Array(0), kernel: ringKernel(P.rB),
    er: new Float64Array(0), erCap: 0, pending: newPending(), strains: newStrains(), spores: newSpores(),
    ledgerTick: new Float64Array(N_CHANNELS), ledgerTotal: new Float64Array(N_CHANNELS),
    history: { firstSeen: new Map(), peak: new Map(), lastCount: new Map(), speciations: [], extinctions: [] },
    uFace: new Float64Array((w + 1) * h), vFace: new Float64Array(w * (h + 1)), psiC: new Float64Array((w + 1) * (h + 1)), hFloor: new Float64Array(w).fill(world.preset.heightM),
    uFaceF: new Float64Array((fw + 1) * fh), vFaceF: new Float64Array(fw * (fh + 1)),
    nAgentsAtTick: 0, capTaxTicks: 0, ecoTicks: 0, natureOn: true, capTaxMode: 'additive', yearOffset: 0, rActiveTargetQ: 0,
    scratch: new Map(),
    env: { t: 0, dayPhase: 0, yearPhase: 0, surfLight: 0, tSurf: P.tMean, yTh: 8, wTh: 2, strat: 1, ySurface: 0 },
    barriers: new Map(), mods: newMods(), diag: { nan: 0, refusedEndowments: 0 },
  };
  return s;
}

function grids(world: World, s: EcoState): { gc: Grid; gf: Grid } {
  const f = world.fields;
  const [w, h] = f.coarse;
  const [fw, fh] = f.fine;
  return {
    gc: { w, h, cs: world.preset.widthM / w, wet: s.wetC, uFace: s.uFace, vFace: s.vFace },
    gf: { w: fw, h: fh, cs: world.preset.widthM / fw, wet: s.wetF, uFace: s.uFaceF, vFace: s.vFaceF },
  };
}

const SCENT_DECAY = [600, 120, 300, 60, 300, 300, 300, 300]; // s per channel

/**
 * The 2 Hz field passes (dt 0.5 s), staggered over the 15-tick cycle so no single tick carries
 * them all: phase A (tick % 15 == 0) chemistry, cycling, scents and coarse transport; phase B
 * (tick % 15 == 6) producer reactions; phase C (tick % 15 == 9) fine plankton transport.
 */
function fieldPhase(world: World, s: EcoState, ctx: StepContext, phase: number): void {
  const dt = SLOW_EVERY * DT;
  const f = world.fields;
  const { gc, gf } = grids(world, s);
  if (phase === 0) {
    stepChemistry(world, s, dt);
    stepCycling(world, s, ctx, dt);
    emitScents(world, s, dt);
    const kzC = kzRows(world, s, gc.h, gc.cs);
    const optN: TransportOpts = { dt, kh: P.kh, kz: kzC, ws: 0 };
    const optD: TransportOpts = {
      dt, kh: P.kh, kz: kzC, ws: P.wD,
      settle: (i, q) => { const col = i % gc.w; f.qSed[col] = f.qSed[col]! + q; },
    };
    const nC = gc.w * gc.h;
    const pD = prepare(gc, optD, undefined, scratch(s, 'frD', nC * 5));
    const pN = prepare(gc, optN, pD.sub, scratch(s, 'frN', nC * 5));
    const dC = scratch(s, 'deltaC', nC);
    transportQ(gc, f.qN, optN, ctx.rng, ctx.tick, 10, pN, dC);
    transportQ(gc, f.qD, optD, ctx.rng, ctx.tick, 11, pD, dC);
    transportF(gc, f.o2, optN, pN, 0, 1, dC);
    transportF(gc, f.sulphur, optN, pN, 0, 1, dC);
    transportF(gc, f.tAnom, optN, pN, 0, 1, dC);
    transportF(gc, f.turb, optN, pN, 0, 1, dC);
    for (let k = 0; k < 8; k++) transportF(gc, f.scent, optN, pN, k, 8, dC);
  } else if (phase === 6) {
    stepProducers(world, s, ctx, dt);
  } else if (phase === 9) {
    rebuildFineFlux(world, s);
    const kzF = kzRows(world, s, gf.h, gf.cs, gf.w / gc.w);
    const optP: TransportOpts = {
      dt, kh: P.kh, kz: kzF, ws: P.wP,
      settle: (j, q) => { const col = ((j % gf.w) / (gf.w / gc.w)) | 0; f.qCyst[col] = f.qCyst[col]! + q; },
    };
    const nF = gf.w * gf.h;
    const pP = prepare(gf, optP, undefined, scratch(s, 'frP', nF * 5));
    transportQ(gf, f.qP, optP, ctx.rng, ctx.tick, 12, pP, scratch(s, 'deltaF', nF));
  }
}

/** Scent sources (DESIGN R13): plant scent from producers, blood from carcasses, toxin regions, alarm from the hurt. */
function emitScents(world: World, s: EcoState, dt: number): void {
  const f = world.fields;
  const [w, h] = f.coarse;
  const n = w * h;
  for (let k = 0; k < 8; k++) {
    const dec = exp(-dt / SCENT_DECAY[k]!);
    for (let i = 0; i < n; i++) f.scent[i * 8 + k] = f.scent[i * 8 + k]! * dec;
  }
  const [fw] = f.fine;
  const r = fw / w;
  const areaF = sq(world.preset.widthM / fw);
  for (let iy = 0; iy < h; iy++) for (let ix = 0; ix < w; ix++) {
    let q = 0;
    for (let jy = iy * r; jy < (iy + 1) * r; jy += 2) for (let jx = ix * r; jx < (ix + 1) * r; jx += 2) q += f.qP[jy * fw + jx]! + f.qBphoto[jy * fw + jx]!;
    const dens = (q * 4 * Q_MASS) / (areaF * r * r);
    const i = iy * w + ix;
    f.scent[i * 8 + SCENT.PLANT] = f.scent[i * 8 + SCENT.PLANT]! + (dt * dens) / (P.bMax * 60);
  }
  const c = world.cr.c;
  for (let sl = 0; sl < world.cr.highWater; sl++) {
    const life = c.life[sl]!;
    if (life === LIFE.FREE) continue;
    const i = coarseIndex(world, c.posX[sl]!, c.posY[sl]!);
    if (life === LIFE.CARCASS) f.scent[i * 8 + SCENT.BLOOD] = f.scent[i * 8 + SCENT.BLOOD]! + dt * 0.05;
    else if (life === LIFE.ALIVE) {
      if ((c.flags[sl]! & CF.HURT) !== 0) f.scent[i * 8 + SCENT.ALARM] = f.scent[i * 8 + SCENT.ALARM]! + dt * 0.1;
      if (sl < s.erCap && s.er[sl * ER_LANES + ER.LOADED] === 1) { // pheromones A to D from the ODOUR genes (DESIGN R13)
        const o = sl * ER_LANES;
        f.scent[i * 8 + SCENT.PHERO_A] = f.scent[i * 8 + SCENT.PHERO_A]! + dt * 0.01 * s.er[o + ER.ODOUR_A]!;
        f.scent[i * 8 + SCENT.PHERO_B] = f.scent[i * 8 + SCENT.PHERO_B]! + dt * 0.01 * s.er[o + ER.ODOUR_B]!;
        f.scent[i * 8 + SCENT.PHERO_C] = f.scent[i * 8 + SCENT.PHERO_C]! + dt * 0.01 * s.er[o + ER.ODOUR_C]!;
        f.scent[i * 8 + SCENT.PHERO_D] = f.scent[i * 8 + SCENT.PHERO_D]! + dt * 0.01 * s.er[o + ER.ODOUR_D]!;
      }
    }
  }
  for (const z of s.mods.toxins) {
    const i = coarseIndex(world, z[0]!, z[1]!);
    f.scent[i * 8 + SCENT.TOXIN] = f.scent[i * 8 + SCENT.TOXIN]! + dt * z[3]!;
  }
}

/** Convert pending deaths to carcasses, in (entity id) order. */
function commitDeaths(world: World, s: EcoState, ctx: StepContext): void {
  const seen = new Set<number>();
  const list = s.pending.deaths.slice().sort((a, b) => a.id - b.id);
  const out: typeof list = [];
  for (const d of list) {
    if (seen.has(d.slot)) continue;
    seen.add(d.slot);
    if (world.cr.c.life[d.slot] !== LIFE.ALIVE) continue;
    commitDeath(world, s, d.slot, d.cause, ctx, d.killer);
    out.push(d);
  }
  s.pending.deaths = out;
}

export const ecosystem: EcosystemModule = {
  initWorld(world, ctx) {
    const s = newState(world, habitatOf(world));
    setState(world, s);
    initFlowModes(world, ctx);
    refreshMasks(world, s);
    seedMass(world, s);
    updateEnv(world, s);
    rebuildFlow(world, s);
    scanLight(world, s);
    seedReservoirStrains(s, (i) => hash32(world.g.seedLo, world.g.seedHi ^ 0x5eed, i));
  },

  flowAt(world, x, y, out) {
    flowAtPoint(world, getState(world), x, y, out);
  },

  stepEcology(world, ctx) {
    const s = getState(world);
    // requests not taken by the sim lapse (CONTRACT 9.6: deferred, never dropped: the parent asks again)
    for (const b of s.pending.births) clearRequest(s, b.parentSlot);
    const keepFree = s.pending.free.filter((sl) => world.cr.c.life[sl] === LIFE.CARCASS);
    const keepDeaths = s.pending.deaths.filter((d) => world.cr.c.life[d.slot] === LIFE.ALIVE);
    s.pending = { ...newPending(), free: keepFree, deaths: keepDeaths, spawns: s.pending.spawns };
    s.ledgerTick.fill(0);
    s.ecoTicks++;
    s.nAgentsAtTick = world.g.liveCount + world.g.eggCount + world.g.carcassCount;
    stepCreatures(world, s, ctx);
    for (const sl of stepDisease(world, s, ctx)) {
      s.pending.deaths.push({ slot: sl, id: world.cr.c.idLo[sl]! + world.cr.c.idHi[sl]! * 4294967296, cause: 'disease' as DeathCause });
    }
    fieldPhase(world, s, ctx, ctx.tick % SLOW_EVERY);
    commitDeaths(world, s, ctx);
  },

  stepSlow(world, ctx) {
    const s = getState(world);
    evalModifiers(world, s, ctx.tick, refreshTerrain);
    updateEnv(world, s);
    stepFlowModes(world, ctx, s.mods.flowMult, s.mods.flowFlip);
    rebuildFlow(world, s);
    scanLight(world, s);
  },

  applyGodEvent(world: World, ev: GodEventScheduled, ctx: StepContext) {
    applyGod(world, getState(world), ev, ctx, refreshTerrain);
  },

  audit(world): LedgerAudit {
    return ledgerAudit(world);
  },
};

function refreshTerrain(world: World, s: EcoState): void {
  rebuildSdf(world);
  refreshMasks(world, s);
  rebuildFlow(world, s);
}

// ---------------- extensions the sim and host need (contract requests) ----------------

/** Decode a creature's genome traits and phenotype values into the ecosystem's cache. */
export function loadCreatureEco(world: World, slot: number, init: CreatureEcoInit): void {
  loadCreature(world, getState(world), slot, init);
}
/** Build a creature's body from dissolved N (founders, releases, reseeds). */
export function endowCreatureEco(world: World, slot: number, tissueKg: number, reserveKg: number): boolean {
  return endowCreature(world, getState(world), slot, tissueKg / Q_MASS, reserveKg / Q_MASS);
}
/** Requests made during the last ecology tick, for the sim's commit. Read, then commit. */
export function takePending(world: World): Pending { return getState(world).pending; }
/** Commit one offspring of a request into an allocated child slot that has been loaded. */
export function commitOffspringEco(world: World, req: BirthRequest, childSlot: number, ctx: StepContext): boolean {
  const s = getState(world);
  const ok = commitOffspring(world, s, req, childSlot);
  if (ok) {
    const d = ctx.rng.draw(RNG_STREAM.BIRTH, ctx.tick, world.cr.c.idLo[childSlot]! + world.cr.c.idHi[childSlot]! * 4294967296);
    inheritInfection(world, s, req.parentSlot, childSlot, () => d.u01());
  }
  return ok;
}
export function finishRequest(world: World, req: BirthRequest): void { clearRequest(getState(world), req.parentSlot); }
/** A bite, swallow or latch drain resolved by physics (contract request: a bite buffer). */
export function applyBiteEco(world: World, attacker: number, target: number, chunkKg: number): number {
  return applyBite(world, getState(world), attacker, target, chunkKg);
}
/** Put a fresh carcass of massQ quanta (from the reservoir, then N) into an allocated slot (whale fall). */
export function commitCarcassSpawn(world: World, slot: number, req: SpawnRequest): boolean {
  const s = getState(world);
  const c = world.cr.c;
  let need = req.massQ;
  const fromR = Math.min(need, world.g.qReservoir);
  world.g.qReservoir -= fromR; need -= fromR;
  const i = coarseIndex(world, req.pos[0], req.pos[1]);
  const fromN = Math.min(need, world.fields.qN[i]!);
  world.fields.qN[i] = world.fields.qN[i]! - fromN;
  c.qTissue[slot] = c.qTissue[slot]! + fromR + fromN;
  c.life[slot] = LIFE.CARCASS;
  c.posX[slot] = req.pos[0]; c.posY[slot] = req.pos[1];
  world.g.carcassCount++;
  void s;
  return true;
}
/** Mark a fully decayed carcass slot free in the ecosystem cache (the sim clears the columns). */
export function releaseSlot(world: World, slot: number): void {
  const s = getState(world);
  if (slot < s.erCap) s.er.fill(0, slot * ER_LANES, (slot + 1) * ER_LANES);
}
export function temperatureAtPoint(world: World, x: number, y: number): number { return temperatureAt(world, getState(world), x, y); }
export function mutagenAt(world: World, x: number, y: number): number { return mutagenAtS(getState(world), x, y); }
export function natureEvent(world: World, ctx: StepContext): GodEventScheduled | null { return natureEventS(world, ctx, getState(world).natureOn); }
export function setNatureMode(world: World, on: boolean): void { getState(world).natureOn = on; }
export function computeMetrics(world: World): EcoMetrics { return computeMetricsS(world, getState(world)); }
export function ecoState(world: World): EcoState { return getState(world); }
export function ledgerStats(world: World): { tick: Float64Array; total: Float64Array } {
  const s = getState(world); return { tick: s.ledgerTick, total: s.ledgerTotal };
}
export function hasEcoState(world: World): boolean { return hasState(world); }
export function isEcoLoaded(world: World, slot: number): boolean { return isLoaded(getState(world), slot); }
export function terrainInfo(world: World): EcoState['terrain'] { return getState(world).terrain; }

/** Hooks for the reference commit (the sim owns slot allocation, genomes, bodies and brains). */
export interface CommitHooks {
  /** Allocate and initialise a child of `req` (offspring index k); return its slot or -1 to defer. */
  spawnChild(req: BirthRequest, k: number): number;
  /** Clear a slot whose carcass has fully decayed. */
  freeSlot(slot: number): void;
  restage?(slot: number): void;
  spawn?(req: SpawnRequest): void;
}

/** Reference birth and death commit (CONTRACT 9.6): births in (parentEntityId, requestIndex) order. */
export function commitPending(world: World, ctx: StepContext, hooks: CommitHooks): { births: number; deferred: number } {
  const s = getState(world);
  const p = s.pending;
  let births = 0, deferred = 0;
  const reqs = p.births.slice().sort((a, b) => a.parentId - b.parentId || a.requestIndex - b.requestIndex);
  for (const req of reqs) {
    for (let k = 0; k < req.n; k++) {
      if (world.g.liveCount + world.g.eggCount + world.g.carcassCount >= world.agentCap) { deferred += req.n - k; break; }
      if (world.cr.c.life[req.parentSlot] !== LIFE.ALIVE) break;
      const slot = hooks.spawnChild(req, k);
      if (slot < 0) { deferred += req.n - k; break; }
      if (!commitOffspringEco(world, req, slot, ctx)) { hooks.freeSlot(slot); break; }
      births++;
    }
    clearRequest(s, req.parentSlot);
  }
  for (const sl of p.restage) hooks.restage?.(sl);
  for (const sp of p.spawns) hooks.spawn?.(sp);
  for (const sl of p.free) {
    if (world.cr.c.life[sl] !== LIFE.CARCASS) continue;
    const c = world.cr.c;
    const tot = c.qTissue[sl]! + c.qReserve[sl]! + c.qRepro[sl]! + c.qGut[sl * 3]! + c.qGut[sl * 3 + 1]! + c.qGut[sl * 3 + 2]!;
    if (tot !== 0) continue;
    world.g.carcassCount = Math.max(0, world.g.carcassCount - 1);
    releaseSlot(world, sl);
    hooks.freeSlot(sl);
  }
  s.pending = newPending();
  return { births, deferred };
}

/** Convenience for tests and stats: total world mass in kg. */
export function worldMassKg(world: World): number { return world.g.mTotalQ * Q_MASS; }
export { NONE_U32, ER, DT_ECO, Dither as _Dither };
