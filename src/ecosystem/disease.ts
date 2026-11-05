/**
 * Pathogens with immune keys (04 §4.6): a strain table, two infection slots per host,
 * matching-alleles recognition, adhesin binding to the host's surface signature, within-host
 * logistic load with immune clearance, mass drain to N and D (conserving), extra death hazard,
 * contact, waterborne (spores), vertical and trophic transmission, strain mutation, acquired
 * memory, garbage collection and dormant reservoir strains.
 */
import {
  CF, DAY_S, DT_ECO, exp, LIFE, NONE_U32, pow, RNG_STREAM, sigmoid, type StepContext, type World,
} from '../core/index.js';
import { book } from './ledger.js';
import { P } from './params.js';
import { CH, ER, ER_LANES, type EcoState } from './state.js';
import { coarseIndex } from './env.js';

export function popcount32(x: number): number {
  let v = x >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}
/** Key similarity 1 - popcount(a xor b) / 32. */
export function keySim(a: number, b: number): number { return 1 - popcount32((a ^ b) >>> 0) / 32; }
export function bindProb(adhesin: number, surfaceSig: number): number { return sigmoid(20 * (keySim(adhesin, surfaceSig) - 0.75)); }
export function recogProb(immuneKey: number, memory: number, antigen: number): number {
  return sigmoid(20 * (Math.max(keySim(immuneKey, antigen), keySim(memory, antigen)) - 0.7));
}
export function infectProb(beta: number, dose: number, bind: number, iota: number, recog: number): number {
  return 1 - exp(-beta * dose * bind * (1 - iota * recog));
}

export interface StrainSpec { antigen: number; adhesin: number; beta: number; virulence: number; growth: number; envHalfLife: number; routes?: number; parent?: number }

/** Allocate a strain (lowest free slot). Returns the slot or -1 when the table is full. */
export function newStrain(s: EcoState, tick: number, spec: StrainSpec): number {
  const st = s.strains;
  let k = -1;
  for (let i = 0; i < st.n; i++) if (!st.live[i]) { k = i; break; }
  if (k < 0) { if (st.n >= st.live.length) return -1; k = st.n++; }
  st.live[k] = 1; st.id[k] = st.nextId++; st.parent[k] = spec.parent ?? 0; st.bornTick[k] = tick;
  st.antigen[k] = spec.antigen >>> 0; st.adhesin[k] = spec.adhesin >>> 0;
  st.beta[k] = spec.beta; st.virulence[k] = Math.min(P.vMax, spec.virulence); st.growth[k] = spec.growth;
  st.envHalfLife[k] = spec.envHalfLife; st.routes[k] = spec.routes ?? 0xf; st.hostCount[k] = 0; st.sporeLoad[k] = 0;
  return k;
}

/** Try to infect a host with a dose of a strain; may mutate on transmission. */
export function expose(world: World, s: EcoState, slot: number, strain: number, dose: number, u: () => number): boolean {
  const c = world.cr.c;
  const st = s.strains;
  if (!st.live[strain] || c.life[slot] !== LIFE.ALIVE) return false;
  if (c.infStrain[slot * 2] === strain || c.infStrain[slot * 2 + 1] === strain) return false;
  const laneFree = c.infStrain[slot * 2] === NONE_U32 ? 0 : c.infStrain[slot * 2 + 1] === NONE_U32 ? 1 : -1;
  if (laneFree < 0) return false;
  const iota = slot < s.erCap ? s.er[slot * ER_LANES + ER.IMMUNE]! : 0.2;
  const p = infectProb(st.beta[strain]!, dose, bindProb(st.adhesin[strain]!, c.surfaceSig[slot]!), iota,
    recogProb(c.immuneKey[slot]!, c.immuneMemory[slot]!, st.antigen[strain]!));
  if (u() >= p) return false;
  let k = strain;
  if (u() < P.muS * s.mods.mutagen) {
    const flipAntigen = u() < 0.8;
    const bit = 1 << Math.floor(u() * 32);
    const n = (x: number): number => x * exp(0.1 * (u() * 2 - 1) * 1.7);
    const child = newStrain(s, world.g.tick, {
      antigen: flipAntigen ? (st.antigen[strain]! ^ bit) >>> 0 : st.antigen[strain]!,
      adhesin: flipAntigen ? st.adhesin[strain]! : (st.adhesin[strain]! ^ bit) >>> 0,
      beta: n(st.beta[strain]!), virulence: n(st.virulence[strain]!), growth: n(st.growth[strain]!),
      envHalfLife: st.envHalfLife[strain]!, routes: st.routes[strain]!, parent: st.id[strain]!,
    });
    if (child >= 0) k = child;
  }
  c.infStrain[slot * 2 + laneFree] = k;
  c.infLoad[slot * 2 + laneFree] = 0.02;
  c.flags[slot] = c.flags[slot]! | CF.INFECTED;
  st.hostCount[k] = st.hostCount[k]! + 1;
  return true;
}

/** One ecology tick of within-host dynamics, drain, hazard and transmission. */
export function stepDisease(world: World, s: EcoState, ctx: StepContext): number[] {
  const c = world.cr.c;
  const st = s.strains;
  const dt = DT_ECO;
  const dayFrac = dt / DAY_S;
  const deaths: number[] = [];
  const [cw, ch] = world.fields.coarse;
  // bucket living creatures by coarse cell (ascending slot within each cell)
  const head = new Int32Array(cw * ch).fill(-1);
  const next = new Int32Array(world.cr.highWater).fill(-1);
  const tail = new Int32Array(cw * ch).fill(-1);
  let anyInfected = false;
  for (let slot = 0; slot < world.cr.highWater; slot++) {
    if (c.life[slot] !== LIFE.ALIVE) continue;
    if ((c.flags[slot]! & CF.INFECTED) !== 0) anyInfected = true;
    const i = coarseIndex(world, c.posX[slot]!, c.posY[slot]!);
    if (head[i] === -1) head[i] = slot; else next[tail[i]!] = slot;
    tail[i] = slot;
  }
  for (let k = 0; k < st.n; k++) st.hostCount[k] = 0;
  if (anyInfected) {
    for (let slot = 0; slot < world.cr.highWater; slot++) {
      if (c.life[slot] !== LIFE.ALIVE || (c.flags[slot]! & CF.INFECTED) === 0) continue;
      const d = ctx.rng.draw(RNG_STREAM.DISEASE, ctx.tick, c.idLo[slot]! + c.idHi[slot]! * 4294967296);
      const u = (): number => d.u01();
      const iota = slot < s.erCap ? s.er[slot * ER_LANES + ER.IMMUNE]! : 0.2;
      let infected = false;
      for (let lane = 0; lane < 2; lane++) {
        const k = c.infStrain[slot * 2 + lane]!;
        if (k === NONE_U32) continue;
        if (!st.live[k]) { c.infStrain[slot * 2 + lane] = NONE_U32; c.infLoad[slot * 2 + lane] = 0; continue; }
        let L = c.infLoad[slot * 2 + lane]!;
        const recog = recogProb(c.immuneKey[slot]!, c.immuneMemory[slot]!, st.antigen[k]!);
        L += dayFrac * (st.growth[k]! * L * (1 - L)) - dt * P.cClear * iota * recog * L;
        if (L < 0.01) { // cleared: acquired memory
          c.infStrain[slot * 2 + lane] = NONE_U32; c.infLoad[slot * 2 + lane] = 0;
          c.immuneMemory[slot] = st.antigen[k]!;
          continue;
        }
        L = Math.min(1, L);
        c.infLoad[slot * 2 + lane] = L;
        infected = true;
        st.hostCount[k] = st.hostCount[k]! + 1;
        const v = st.virulence[k]!;
        // drain: tissue to N and D (half each), never mass from nowhere
        const ci = coarseIndex(world, c.posX[slot]!, c.posY[slot]!);
        const drain = Math.min(c.qTissue[slot]!, Math.floor(v * L * c.qTissue[slot]! * dayFrac + u()));
        if (drain > 0) {
          c.qTissue[slot] = c.qTissue[slot]! - drain;
          const h = Math.floor(drain / 2);
          world.fields.qN[ci] = world.fields.qN[ci]! + h; world.fields.qD[ci] = world.fields.qD[ci]! + drain - h;
          book(world, CH.parasiteDrain, drain);
        }
        // extra death hazard
        if (u() < 1 - exp(-P.hV * v * L * dayFrac)) deaths.push(slot);
        // contact transmission inside the coarse cell
        for (let o = head[ci]!; o !== -1; o = next[o]!) {
          if (o === slot) continue;
          expose(world, s, o, k, P.contactRate * L * dt, u);
        }
        // shedding spores (virulence-transmission trade-off, z = 0.5)
        if (u() < P.shedRate * pow(Math.max(v, 1e-6), P.z) * L * dt && s.spores.n < s.spores.x.length) {
          const sp = s.spores, n = sp.n++;
          sp.x[n] = c.posX[slot]!; sp.y[n] = c.posY[slot]!; sp.strain[n] = k; sp.load[n] = 1;
        }
      }
      if (!infected) c.flags[slot] = c.flags[slot]! & ~CF.INFECTED;
    }
  }
  stepSpores(world, s, ctx, head, next);
  // garbage-collect strains with no hosts and no spores
  for (let k = 0; k < st.n; k++) st.sporeLoad[k] = 0;
  for (let n = 0; n < s.spores.n; n++) st.sporeLoad[s.spores.strain[n]!] = st.sporeLoad[s.spores.strain[n]!]! + s.spores.load[n]!;
  for (let k = 0; k < st.n; k++) if (st.live[k] && st.hostCount[k] === 0 && st.sporeLoad[k] === 0) st.live[k] = 0;
  return deaths;
}

function stepSpores(world: World, s: EcoState, ctx: StepContext, head: Int32Array, next: Int32Array): void {
  const sp = s.spores;
  if (sp.n === 0) return;
  const f = world.fields;
  const dt = DT_ECO;
  const st = s.strains;
  const d = ctx.rng.draw(RNG_STREAM.DISEASE, ctx.tick, 0);
  const u = (): number => d.u01();
  let w = 0;
  for (let n = 0; n < sp.n; n++) {
    const k = sp.strain[n]!;
    const i = coarseIndex(world, sp.x[n]!, sp.y[n]!);
    sp.x[n] = Math.min(world.preset.widthM - 0.01, Math.max(0.01, sp.x[n]! + f.flowU[i]! * dt));
    sp.y[n] = Math.min(world.preset.heightM - 0.01, Math.max(0.01, sp.y[n]! + f.flowV[i]! * dt));
    let load = sp.load[n]! * exp((-0.6931471805599453 * dt) / Math.max(1, st.envHalfLife[k]!));
    for (let o = head[i]!; o !== -1 && load > 0.01; o = next[o]!) {
      if (u() < 0.05) { expose(world, s, o, k, load, u); load *= 0.5; }
    }
    if (load < 0.01 || !st.live[k]) continue;
    sp.x[w] = sp.x[n]!; sp.y[w] = sp.y[n]!; sp.strain[w] = k; sp.load[w] = load; w++;
  }
  sp.n = w;
}

/** Vertical transmission at birth: with probability 0.3 L per infection of the parent. */
export function inheritInfection(world: World, s: EcoState, parent: number, child: number, u: () => number): void {
  const c = world.cr.c;
  for (let lane = 0; lane < 2; lane++) {
    const k = c.infStrain[parent * 2 + lane]!;
    if (k === NONE_U32) continue;
    if (u() < 0.3 * c.infLoad[parent * 2 + lane]!) expose(world, s, child, k, 10, () => 0);
  }
}

/** Seed a few dormant reservoir strains at world creation (04 §4.6). */
export function seedReservoirStrains(s: EcoState, seedWord: (i: number) => number): void {
  for (let i = 0; i < 32; i++) {
    s.strains.archive.push([seedWord(i * 4), seedWord(i * 4 + 1), 0.5 + (seedWord(i * 4 + 2) % 1000) / 1000, 0.2 + (seedWord(i * 4 + 3) % 800) / 1000, 3, 600]);
  }
}

/** Wake one archived strain as spores at (x, y), for disturbances (meteor, vent, earthquake). */
export function wakeReservoirStrain(world: World, s: EcoState, x: number, y: number, pick: number): number {
  const a = s.strains.archive;
  if (a.length === 0) return -1;
  const r = a[pick % a.length]!;
  const k = newStrain(s, world.g.tick, { antigen: r[0]!, adhesin: r[1]!, beta: r[2]!, virulence: r[3]!, growth: r[4]!, envHalfLife: r[5]! });
  if (k < 0) return -1;
  const sp = s.spores;
  for (let j = 0; j < 8 && sp.n < sp.x.length; j++) {
    const n = sp.n++;
    sp.x[n] = x + (j - 4) * 0.1; sp.y[n] = y; sp.strain[n] = k; sp.load[n] = 1;
  }
  return k;
}
