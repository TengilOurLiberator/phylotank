/**
 * Birth and death commit (CONTRACT 4.2 rule 6, 9.6), slot and segment allocation, releases.
 *
 * Order at the end of every ecology tick:
 *   1. deaths, in (entityId, request tick) order: ALIVE becomes CARCASS, its pools stay;
 *   2. empty carcasses are freed, in ascending slot order;
 *   3. restages, in ascending slot order;
 *   4. births (deferred ones from earlier commits first by their older tick), in
 *      (parentEntityId, tick, requestIndex) order: genome operators keyed by the child's new
 *      entity id, develop, physics.loadBody, brain.allocate, species assignment.
 * Every mass movement is an integer number of quanta, so the ledger stays exact.
 */
import {
  C_G, CF, clamp, cos, decodeGenome, FAT_CAPACITY_0, GENOME_FLAG_LEVIATHAN, K_ENDOW, LIFE, MAX_WORLD_MASS_KG, NONE_U32, OVERHEAD_ABS_KG, OVERHEAD_FRACTION, packRGBA, pow, Q_MASS, RNG_STREAM,
  SEGMENT_COLUMNS, sin, T, TAU, TRAITS, decodeQ, clearSlot,
  type AnyTypedArray, type DeathCause, type Genome, type MutationContext, type Phenotype, type StepContext, type V2, type World,
} from '../core/index.js';
import { agentCapFeeKg } from '../ecosystem/index.js';
import { cmpBirth, cmpDeath, entityId, requestsOf, type BirthRequest } from './requests.js';
import { CH, stateOf, type ReleaseEntry, type SimState } from './state.js';

// ---------------------------------------------------------------- slots and segments

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
  c.idLo[slot] = id % 4294967296 >>> 0;
  c.idHi[slot] = Math.floor(id / 4294967296) >>> 0;
  c.gen[slot] = (c.gen[slot]! + 1) & 0xffff;
  c.birthTick[slot] = world.g.tick;
  return slot;
}

function hasFreeCreatureSlot(world: World): boolean {
  if (world.cr.highWater < world.cr.capacity) return true;
  const life = world.cr.c.life;
  for (let s = 0; s < world.cr.highWater; s++) if (life[s] === LIFE.FREE) return true;
  return false;
}

/** First-fit contiguous run of n free segment slots, lowest first; -1 if none. */
function findSegmentRun(world: World, n: number): number {
  const owner = world.seg.c.owner;
  const hw = world.seg.highWater;
  let run = 0;
  for (let k = 0; k < hw; k++) {
    if (owner[k] === NONE_U32) { if (++run === n) return k - n + 1; } else run = 0;
  }
  const start = hw - run;
  return start + n <= world.seg.capacity ? start : -1;
}

function segColumns(world: World): { arr: AnyTypedArray; lanes: number; init: number }[] {
  const cols = world.seg.c as unknown as Record<string, AnyTypedArray>;
  return SEGMENT_COLUMNS.map((s) => ({ arr: cols[s.name]!, lanes: 'lanes' in s ? s.lanes : 1, init: 'init' in s ? s.init : 0 }));
}

/**
 * Compact segment ranges towards slot 0, keeping their relative order (CONTRACT 5.2: "the
 * sim compacts on births"). Owners are visited in ascending segStart, so copies never overlap
 * forwards.
 */
export function compactSegments(world: World): void {
  const c = world.cr.c;
  const owners: number[] = [];
  for (let s = 0; s < world.cr.highWater; s++) if (c.life[s] !== LIFE.FREE && c.segCount[s]! > 0) owners.push(s);
  owners.sort((a, b) => c.segStart[a]! - c.segStart[b]! || a - b);
  const cols = segColumns(world);
  let dst = 0;
  for (const s of owners) {
    const src = c.segStart[s]!;
    const n = c.segCount[s]!;
    if (src !== dst) for (const col of cols) col.arr.copyWithin(dst * col.lanes, src * col.lanes, (src + n) * col.lanes);
    c.segStart[s] = dst;
    dst += n;
  }
  for (const col of cols) col.arr.fill(col.init, dst * col.lanes, world.seg.highWater * col.lanes);
  world.seg.highWater = dst;
}

/** Allocate n contiguous segments for a creature, compacting once if fragmented. */
export function allocSegments(world: World, slot: number, n: number): boolean {
  let start = findSegmentRun(world, n);
  if (start < 0) {
    compactSegments(world);
    start = findSegmentRun(world, n);
    if (start < 0) return false;
  }
  const sg = world.seg.c;
  for (let k = start; k < start + n; k++) sg.owner[k] = slot;
  if (start + n > world.seg.highWater) world.seg.highWater = start + n;
  world.cr.c.segStart[slot] = start;
  world.cr.c.segCount[slot] = n;
  return true;
}

/** Free segment slots in the whole pool (below and above the high-water mark). */
export function freeSegmentCount(world: World): number {
  const owner = world.seg.c.owner;
  let n = world.seg.capacity - world.seg.highWater;
  for (let k = 0; k < world.seg.highWater; k++) if (owner[k] === NONE_U32) n++;
  return n;
}

export function freeSegments(world: World, slot: number): void {
  const c = world.cr.c;
  const start = c.segStart[slot]!;
  const n = c.segCount[slot]!;
  if (start !== NONE_U32 && n > 0) {
    for (const col of segColumns(world)) col.arr.fill(col.init, start * col.lanes, (start + n) * col.lanes);
  }
  c.segStart[slot] = NONE_U32;
  c.segCount[slot] = 0;
}

/** Free a creature slot completely (its pools must already be empty). Keeps `gen`. */
export function freeCreature(world: World, slot: number): void {
  const st = stateOf(world);
  const c = world.cr.c;
  st.modules.brain.free(world, slot);
  freeSegments(world, slot);
  const h = c.genome[slot]!;
  if (h !== NONE_U32) st.store.release(h);
  const gen = c.gen[slot]!;
  clearSlot(world.cr, slot);
  c.gen[slot] = gen;
}

// ---------------------------------------------------------------- helpers

export function coarseCell(world: World, x: number, y: number): number {
  const [w, h] = world.fields.coarse;
  const cs = world.preset.widthM / w;
  const ix = clamp(Math.floor(x / cs), 0, w - 1);
  const iy = clamp(Math.floor(y / cs), 0, h - 1);
  return iy * w + ix;
}

/** Burn quanta at a position: heat, the mass returns to dissolved N (CONTRACT 9.2). */
export function burnTo(world: World, x: number, y: number, q: number): void {
  if (q > 0) world.fields.qN[coarseCell(world, x, y)]! += q;
}

function traitOf(g: Genome, idx: number): number { return decodeQ(g.traits[idx]!, TRAITS[idx]!); }

/** HSL to packed RGBA8 without transcendentals. */
export function hslColour(h: number, s: number, l: number): number {
  const k = (n: number): number => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return packRGBA(f(0), f(8), f(4));
}

export function colourOf(g: Genome): number {
  return hslColour(traitOf(g, T.GLOW_HUE!), 0.35 + 0.5 * traitOf(g, T.BODY_SAT!), 0.35 + 0.3 * traitOf(g, T.BODY_LUM!));
}

function birthEnv(world: World, y: number): { depth01: number; tempC: number } {
  return { depth01: clamp((y - world.g.ySurface) / world.preset.heightM, 0, 1), tempC: 14 };
}

export function developOpts(world: World): { maxParts: number; lCeilingM: number } {
  return { maxParts: world.config.maxParts ?? 64, lCeilingM: world.lCeilingM };
}

/** Newborn mass of a genome's offspring (kg), cached per store entry. */
export function newbornKg(world: World, handle: number): number {
  const st = stateOf(world);
  const e = st.store.entry(handle);
  if (e.newbornKg < 0) e.newbornKg = st.modules.genome.develop(e.genome, 0, birthEnv(world, 0), developOpts(world)).massKg;
  return e.newbornKg;
}

/** Integer parts of one offspring's cost (CONTRACT 9.6), in quanta. */
export interface OffspringCost { tissue: number; reserve: number; growthHeat: number; overhead: number; fee: number; total: number }
export function offspringCost(mKg: number, feeKg: number): OffspringCost {
  const tissue = Math.max(1, Math.round(mKg / Q_MASS));
  const growthHeat = Math.floor(tissue * (C_G - 1));
  const reserve = Math.floor(tissue * FAT_CAPACITY_0);
  const overhead = Math.floor((OVERHEAD_FRACTION * mKg + OVERHEAD_ABS_KG) / Q_MASS);
  const fee = Math.floor(feeKg / Q_MASS);
  return { tissue, reserve, growthHeat, overhead, fee, total: tissue + growthHeat + reserve + overhead + fee };
}

/** The agent-cap fee now (CONTRACT 9.6), from n_agents at the start of this tick. */
export function currentFeeKg(world: World): number {
  return agentCapFeeKg(stateOf(world).nAgentsAtTickStart, world.agentCap);
}

export function nAgents(world: World): number {
  return world.g.liveCount + world.g.eggCount + world.g.carcassCount;
}

/** Time to maturity (s) for the fallback life history: about 7 min for a 3 mm budder. */
export function tMatureS(g: Genome, adultLenM: number): number {
  return (400 * pow(adultLenM / 0.003, 0.25)) / traitOf(g, T.GROWTH_RATE!);
}

// ---------------------------------------------------------------- spawning

export interface SpawnSpec {
  handle: number; species: number; pos: V2; heading: number; maturity: number;
  qTissue: number; qReserve: number; flags: number;
}

/**
 * Create a living creature from a store handle (the caller has retained it for this slot).
 * Returns the slot, or -1 with nothing changed when a pool is full.
 */
export function spawn(world: World, ctx: StepContext, sp: SpawnSpec): number {
  const st = stateOf(world);
  const { genome: gm, physics, brain } = st.modules;
  const g = st.store.get(sp.handle);
  const ph: Phenotype = gm.develop(g, sp.maturity, birthEnv(world, sp.pos[1]), developOpts(world));
  if (!hasFreeCreatureSlot(world)) return -1;
  const slot = allocCreature(world);
  if (!allocSegments(world, slot, ph.nParts)) { rollback(world, slot); return -1; }
  const c = world.cr.c;
  c.life[slot] = LIFE.ALIVE;
  c.flags[slot] = sp.flags | ((g.flags & GENOME_FLAG_LEVIATHAN) !== 0 ? CF.LEVIATHAN : 0) | (sp.maturity < 1 ? CF.JUVENILE : 0);
  c.species[slot] = sp.species;
  c.genome[slot] = sp.handle;
  c.posX[slot] = sp.pos[0];
  c.posY[slot] = sp.pos[1];
  c.heading[slot] = sp.heading;
  c.length[slot] = ph.lengthM;
  c.adultLength[slot] = ph.adultLengthM;
  c.maturity[slot] = ph.maturity;
  c.qTissue[slot] = sp.qTissue;
  c.qReserve[slot] = sp.qReserve;
  c.massKg[slot] = (sp.qTissue + sp.qReserve) * Q_MASS;
  const tm = tMatureS(g, ph.adultLengthM);
  c.tMature[slot] = tm;
  c.lifespan[slot] = traitOf(g, T.LIFESPAN_MULT!) * tm;
  c.reproTimer[slot] = traitOf(g, T.BROOD_INTERVAL!) * tm * 0.25;
  c.immuneKey[slot] = g.immuneKey;
  c.surfaceSig[slot] = g.surfaceSig;
  c.glow[slot] = 0.15 + 0.6 * traitOf(g, T.GLOW_BASE!);
  c.colour[slot] = colourOf(g);
  c.tempC[slot] = 14;
  const sg = world.seg.c;
  const k0 = c.segStart[slot]!;
  for (let i = 0; i < ph.nParts; i++) {
    sg.parent[k0 + i] = ph.parent[i]!;
    sg.kind[k0 + i] = ph.kind[i]!;
    sg.organs[k0 + i] = ph.organs[i]!;
  }
  physics.loadBody(world, slot, ph);
  if (!brain.allocate(world, slot, ph, g, ctx)) { rollback(world, slot); return -1; }
  world.g.liveCount++;
  st.species.add(sp.species);
  return slot;
}

function rollback(world: World, slot: number): void {
  const c = world.cr.c;
  freeSegments(world, slot);
  const gen = c.gen[slot]!;
  clearSlot(world.cr, slot);
  c.gen[slot] = gen;
}

// ---------------------------------------------------------------- the commit

function emitDeath(world: World, st: SimState, slot: number, cause: string, killer?: number): void {
  const c = world.cr.c;
  const ev: Record<string, unknown> = {
    k: 'death', id: entityId(world, slot), species: c.species[slot]!, pos: [c.posX[slot]!, c.posY[slot]!],
    size: c.length[slot]!, cause,
  };
  if (killer !== undefined) ev.killer = killer;
  st.sink.emit(ev as never);
}

/** Kill a living creature now: it becomes a carcass with its pools intact. */
export function killNow(world: World, slot: number, cause: DeathCause, killer?: number): void {
  const st = stateOf(world);
  const c = world.cr.c;
  if (c.life[slot] !== LIFE.ALIVE) return;
  c.life[slot] = LIFE.CARCASS;
  c.flags[slot] = c.flags[slot]! & ~(CF.BUDDING | CF.MATING | CF.EATING);
  world.g.liveCount--;
  world.g.carcassCount++;
  st.modules.brain.free(world, slot);
  st.channels[CH.deathToCarcass]! += c.qTissue[slot]! + c.qReserve[slot]! + c.qRepro[slot]!;
  emitDeath(world, st, slot, cause, killer);
  if (st.species.remove(c.species[slot]!, world.g.tick)) {
    st.sink.emit({ k: 'extinction', species: c.species[slot]!, lastId: entityId(world, slot), pos: [c.posX[slot]!, c.posY[slot]!] } as never);
  }
}

function poolsEmpty(world: World, s: number): boolean {
  const c = world.cr.c;
  return c.qTissue[s] === 0 && c.qReserve[s] === 0 && c.qRepro[s] === 0
    && c.qGut[s * 3] === 0 && c.qGut[s * 3 + 1] === 0 && c.qGut[s * 3 + 2] === 0;
}

export function commitBirthsAndDeaths(world: World, ctx: StepContext): void {
  const st = stateOf(world);
  const q = requestsOf(world);
  const c = world.cr.c;

  // 1. deaths
  if (q.deaths.length > 0) {
    const deaths = q.deaths.splice(0, q.deaths.length).sort(cmpDeath);
    for (const d of deaths) {
      if (c.life[d.slot] !== LIFE.ALIVE || entityId(world, d.slot) !== d.id) continue;
      killNow(world, d.slot, d.cause, d.killer);
    }
  }

  // 2. empty carcasses release their slots
  for (let s = 0; s < world.cr.highWater; s++) {
    if (c.life[s] === LIFE.CARCASS && poolsEmpty(world, s)) {
      freeCreature(world, s);
      world.g.carcassCount--;
    }
  }

  // 3. restages, in ascending slot order: regrow the body, reallocating segments if the part count changed
  if (q.restages.length > 0) {
    const slots = [...new Set(q.restages.splice(0, q.restages.length))].sort((a, b) => a - b);
    for (const s of slots) if (c.life[s] === LIFE.ALIVE) restage(world, s);
  }

  // 4. births
  if (q.births.length === 0 && q.deferred.length === 0) return;
  const births = q.deferred.splice(0, q.deferred.length).concat(q.births.splice(0, q.births.length));
  births.sort((a, b) => a.parentId - b.parentId || a.tick - b.tick || cmpBirth(a, b));
  const feeKg = currentFeeKg(world);
  for (const b of births) commitBirth(world, ctx, st, b, feeKg);
}

function restage(world: World, slot: number): void {
  const st = stateOf(world);
  const c = world.cr.c;
  const g = st.store.get(c.genome[slot]!);
  const ph = st.modules.genome.develop(g, c.maturity[slot]!, birthEnv(world, c.posY[slot]!), developOpts(world));
  const old = c.segCount[slot]!;
  if (ph.nParts !== old) {
    // no room for the grown body even after compaction: keep the old body until there is
    if (ph.nParts > old && freeSegmentCount(world) + old < ph.nParts) return;
    freeSegments(world, slot);
    allocSegments(world, slot, ph.nParts);
    const sg = world.seg.c;
    const k0 = c.segStart[slot]!;
    for (let i = 0; i < ph.nParts; i++) { sg.parent[k0 + i] = ph.parent[i]!; sg.kind[k0 + i] = ph.kind[i]!; sg.organs[k0 + i] = ph.organs[i]!; }
  }
  st.modules.physics.restage(world, slot, ph);
}

function commitBirth(world: World, ctx: StepContext, st: SimState, b: BirthRequest, feeKg: number): void {
  const c = world.cr.c;
  const p = b.parentSlot;
  if (c.life[p] !== LIFE.ALIVE || entityId(world, p) !== b.parentId) return;
  const q = requestsOf(world);
  const done = (): void => { c.flags[p] = c.flags[p]! & ~CF.BUDDING; };
  let mode = b.mode;
  const bearerG = st.store.get(c.genome[p]!);
  if (mode === 'sex' && (c.life[b.mateSlot] !== LIFE.ALIVE || entityId(world, b.mateSlot) !== b.mateId)) {
    if (traitOf(bearerG, T.SEX_PROB!) >= 0.98) { done(); return; }
    mode = 'bud';
  }
  const cost = offspringCost(newbornKg(world, c.genome[p]!), feeKg);
  const afford = Math.floor(c.qRepro[p]! / cost.total);
  const n = Math.min(b.n, afford);
  if (n < 1) { done(); return; }
  const donorG = mode === 'sex' ? st.store.get(c.genome[b.mateSlot]!) : null;
  const px = c.posX[p]!;
  const py = c.posY[p]!;
  let born = 0;
  for (let i = 0; i < n; i++) {
    const softFull = st.popSoftLimit > 0 && world.g.liveCount >= st.popSoftLimit;
    if (nAgents(world) >= world.agentCap || softFull || !hasFreeCreatureSlot(world)) {
      // CONTRACT 9.6: at the cap births are deferred, never dropped
      q.deferred.push({ ...b, mode, n: n - i });
      st.deferredBirths += n - i;
      return;
    }
    const childId = world.g.nextEntityId;
    const mctx: MutationContext = { rng: ctx.rng, tick: ctx.tick, childId, lCeilingM: world.lCeilingM, mutagen: 1 };
    const gm = st.modules.genome;
    const childG = gm.repair(donorG ? gm.mutate(gm.crossover(bearerG, donorG, mctx), mctx) : gm.mutate(bearerG, mctx));
    const handle = st.store.intern(childG);
    const d = ctx.rng.draw(RNG_STREAM.BIRTH, ctx.tick, childId);
    const ang = d.u01() * TAU;
    const r = 0.5 * c.length[p]! + 0.002 * d.u01();
    const pos: V2 = [
      clamp(px + r * cos(ang), 0.02, world.preset.widthM - 0.02),
      clamp(py + r * sin(ang), world.g.ySurface + 0.02, world.preset.heightM - 0.02),
    ];
    const [species, isNew] = st.species.assign(c.species[p]!, childG, handle, (a, b) => gm.distance(a, b), ctx.tick, childId, colourOf(childG));
    const slot = spawn(world, ctx, {
      handle, species, pos, heading: d.u01() * TAU, maturity: 0, qTissue: cost.tissue, qReserve: cost.reserve, flags: 0,
    });
    if (slot < 0) {
      st.store.release(handle);
      if (isNew) st.species.remove(species, ctx.tick);
      q.deferred.push({ ...b, mode, n: n - i });
      st.deferredBirths += n - i;
      return;
    }
    // pay (CONTRACT 9.6): tissue and starting reserve to the child, the rest burnt at the parent
    c.qRepro[p]! -= cost.total;
    burnTo(world, px, py, cost.growthHeat + cost.overhead + cost.fee);
    st.channels[CH.growth]! += cost.growthHeat;
    st.channels[CH.reproduction]! += cost.tissue + cost.reserve + cost.overhead;
    st.channels[CH.capFee]! += cost.fee;
    born++;
    const parents = donorG ? [b.parentId, b.mateId] : [b.parentId];
    st.sink.emit({ k: 'birth', id: childId, parents, species, pos, size: c.length[slot]!, mode } as never);
    if (isNew) st.sink.emit({ k: 'speciation', parent: c.species[p]!, child: species, founders: [childId], pos } as never);
  }
  if (born > 0 && donorG) st.sink.emit({ k: 'mate', a: b.parentId, b: b.mateId, pos: [px, py] } as never);
  done();
}


// ---------------------------------------------------------------- releases and founders

/** Result of a release, for COMMAND_RESULT. */
export interface ReleaseResult { ok: boolean; reason?: string; species?: number; slots: number[] }

/**
 * Release creatures of a genome (CONTRACT 13). World founders (`inject = false`) take their
 * mass from dissolved N under them; god releases inject it (ledger.inject, logged).
 */
export function release(world: World, ctx: StepContext, r: ReleaseEntry, inject: boolean): ReleaseResult {
  const st = stateOf(world);
  let g: Genome;
  try { g = decodeGenome(r.genome); } catch (e) { return { ok: false, reason: `bad-genome: ${String(e)}`, slots: [] }; }
  if (r.asLeviathan) g.flags |= GENOME_FLAG_LEVIATHAN;
  const gm = st.modules.genome;
  const adult = gm.develop(g, 1, birthEnv(world, r.pos[1]), developOpts(world));
  if (r.asLeviathan) {
    const endowQ = Math.round((K_ENDOW * r.count * adult.massKg) / Q_MASS);
    if ((world.g.mTotalQ + endowQ) * Q_MASS > 0.8 * MAX_WORLD_MASS_KG) return { ok: false, reason: 'endowment-too-large', slots: [] };
    world.fields.qN[coarseCell(world, r.pos[0], r.pos[1])]! += endowQ;
    world.g.mTotalQ += endowQ;
    world.g.mTargetQ += endowQ;
    st.channels[CH.godInjection]! += endowQ;
  }
  const handle = st.store.intern(g);
  const sp = st.species.found(0, handle, ctx.tick, world.g.nextEntityId, colourOf(g));
  const slots: number[] = [];
  const d = ctx.rng.draw(RNG_STREAM.GOD, ctx.tick, world.g.nextEntityId);
  for (let i = 0; i < r.count; i++) {
    const maturity = 0.3 + 0.6 * d.u01();
    const ph = gm.develop(g, maturity, birthEnv(world, r.pos[1]), developOpts(world));
    const qT = Math.max(1, Math.round(ph.massKg / Q_MASS));
    const qR = Math.floor(qT * FAT_CAPACITY_0 * 0.5);
    const pos: V2 = [
      clamp(r.pos[0] + (2 * d.u01() - 1) * (r.spread?.[0] ?? 0.2), 0.05, world.preset.widthM - 0.05),
      clamp(r.pos[1] + (2 * d.u01() - 1) * (r.spread?.[1] ?? 0.2), world.g.ySurface + 0.05, world.preset.heightM - 0.05),
    ];
    const cell = coarseCell(world, pos[0], pos[1]);
    if (!inject && world.fields.qN[cell]! < qT + qR) continue;
    st.store.retain(handle);
    const flags = CF.FOUNDER | (r.founderProtection ? CF.FOUNDER_PROTECTED : 0) | (g.flags & 1 ? CF.DESIGNED : 0);
    const slot = spawn(world, ctx, { handle, species: sp.id, pos, heading: d.u01() * TAU, maturity, qTissue: qT, qReserve: qR, flags });
    if (slot < 0) { st.store.release(handle); break; }
    if (inject) { world.g.mTotalQ += qT + qR; st.channels[CH.godInjection]! += qT + qR; } else world.fields.qN[cell]! -= qT + qR;
    slots.push(slot);
  }
  st.store.release(handle);
  if (slots.length === 0) { st.species.remove(sp.id, ctx.tick); return { ok: false, reason: 'no-room', slots }; }
  st.sink.emit({ k: 'release', cmdId: r.cmdId, species: sp.id, count: slots.length, pos: r.pos, leviathan: r.asLeviathan } as never);
  return { ok: true, species: sp.id, slots };
}

