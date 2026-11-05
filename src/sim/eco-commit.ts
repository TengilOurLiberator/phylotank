/**
 * The birth and death commit over the real ecosystem (CONTRACT 9.6, request E1).
 *
 * With src/ecosystem in the module set, reproduction, starvation, ageing, predation and decay
 * are decided by the ecosystem's stepEcology, which leaves its requests in `takePending`. The
 * sim then, at the end of the same ecology tick:
 *   1. frees the brains of this tick's deaths (the ecosystem already made them carcasses and
 *      emitted `death`), and keeps the species counts;
 *   2. frees fully decayed carcasses;
 *   3. regrows restaged bodies, in ascending slot order;
 *   4. commits births in (parentEntityId, requestIndex) order: genome operators keyed by the
 *      child's new entity id, develop, slot and segments, physics.loadBody, brain.allocate,
 *      species, ecosystem loadCreature, then commitOffspring moves the mass from the parent;
 *   5. spawns whale-fall carcasses.
 * Requests that cannot be committed (cap, pools) lapse; the parent asks again next ecology tick
 * ("deferred, never dropped").
 *
 * Bites recorded by physics are handed to the ecosystem's conserving exchange before every
 * ecology tick (request P3, E3 adapter).
 */
import { CF, clamp, cos, LIFE, Q_MASS, RNG_STREAM, sin, TAU, type MutationContext, type StepContext, type V2, type World } from '../core/index.js';
import {
  applyBiteEco, commitCarcassSpawn, commitOffspringEco, ecosystem as realEcosystem, finishRequest, mutagenAt, releaseSlot, takePending, type BirthRequest,
} from '../ecosystem/index.js';
import { drainBites } from '../physics/index.js';
import {
  allocCreature, colourOf, freeCreature, restageSlot, spawn,
} from './commit.js';
import { entityId } from './requests.js';
import { stateOf, type SimState } from './state.js';

export function usesRealEcosystem(world: World): boolean {
  return stateOf(world).modules.ecosystem === realEcosystem;
}

/** Hand physics' bites to the ecosystem (before stepEcology). */
export function feedBites(world: World): void {
  for (const b of drainBites(world)) {
    const c = world.cr.c;
    if (c.life[b.attacker] !== LIFE.ALIVE || c.life[b.target] === LIFE.FREE) continue;
    applyBiteEco(world, b.attacker, b.target, b.dmKg);
  }
}

function spawnChild(world: World, ctx: StepContext, st: SimState, req: BirthRequest): number {
  const c = world.cr.c;
  const p = req.parentSlot;
  const bearerG = st.store.get(c.genome[p]!);
  const childId = world.g.nextEntityId;
  const mctx: MutationContext = {
    rng: ctx.rng, tick: ctx.tick, childId, lCeilingM: world.lCeilingM, mutagen: mutagenAt(world, c.posX[p]!, c.posY[p]!),
  };
  const gm = st.modules.genome;
  const childG = gm.repair(gm.mutate(bearerG, mctx));
  const handle = st.store.intern(childG);
  const d = ctx.rng.draw(RNG_STREAM.BIRTH, ctx.tick, childId);
  const ang = d.u01() * TAU;
  const r = 0.5 * c.length[p]! + 0.002 * d.u01();
  const pos: V2 = [
    clamp(c.posX[p]! + r * cos(ang), 0.02, world.preset.widthM - 0.02),
    clamp(c.posY[p]! + r * sin(ang), world.g.ySurface + 0.02, world.preset.heightM - 0.02),
  ];
  const [species, isNew] = st.species.assign(c.species[p]!, childG, handle, (a, b) => gm.distance(a, b), ctx.tick, childId, colourOf(childG));
  const slot = spawn(world, ctx, {
    handle, species, pos, heading: d.u01() * TAU, maturity: 0, qTissue: 0, qReserve: 0, flags: 0,
    massKg: req.childTissueQ * Q_MASS,
  });
  if (slot < 0) {
    st.store.release(handle);
    if (isNew) st.species.remove(species, ctx.tick);
    return -1;
  }
  if (!commitOffspringEco(world, req, slot, ctx)) {
    st.species.remove(species, ctx.tick);
    st.modules.brain.free(world, slot);
    world.g.liveCount--;
    freeCreature(world, slot);
    return -1;
  }
  c.generation[slot] = c.generation[p]! + 1;
  c.massKg[slot] = (c.qTissue[slot]! + c.qReserve[slot]!) * Q_MASS;
  st.sink.emit({ k: 'birth', id: childId, parents: [req.parentId], species, pos, size: c.length[slot]!, mode: 'bud' } as never);
  if (isNew) st.sink.emit({ k: 'speciation', parent: c.species[p]!, child: species, founders: [childId], pos } as never);
  return slot;
}

export function commitWithEcosystem(world: World, ctx: StepContext): void {
  const st = stateOf(world);
  const c = world.cr.c;
  const p = takePending(world);
  // 1. deaths (already carcasses): brains and species
  for (const d of p.deaths) {
    if (c.life[d.slot] !== LIFE.CARCASS) continue;
    st.modules.brain.free(world, d.slot);
    c.flags[d.slot] = c.flags[d.slot]! & ~(CF.BUDDING | CF.MATING | CF.EATING);
    if (st.species.remove(c.species[d.slot]!, world.g.tick)) {
      st.sink.emit({ k: 'extinction', species: c.species[d.slot]!, lastId: entityId(world, d.slot), pos: [c.posX[d.slot]!, c.posY[d.slot]!] } as never);
    }
  }
  p.deaths.length = 0;
  // 2. fully decayed carcasses
  for (const sl of p.free) {
    if (c.life[sl] !== LIFE.CARCASS) continue;
    const tot = c.qTissue[sl]! + c.qReserve[sl]! + c.qRepro[sl]! + c.qGut[sl * 3]! + c.qGut[sl * 3 + 1]! + c.qGut[sl * 3 + 2]!;
    if (tot !== 0) continue;
    world.g.carcassCount = Math.max(0, world.g.carcassCount - 1);
    releaseSlot(world, sl);
    freeCreature(world, sl);
  }
  p.free.length = 0;
  // 3. restages
  const rs = [...new Set(p.restage)].sort((a, b) => a - b);
  for (const sl of rs) if (c.life[sl] === LIFE.ALIVE) restageSlot(world, sl);
  p.restage.length = 0;
  // 4. births
  const reqs = p.births.slice().sort((a, b) => a.parentId - b.parentId || a.requestIndex - b.requestIndex);
  for (const req of reqs) {
    for (let k = 0; k < req.n; k++) {
      const softFull = st.popSoftLimit > 0 && world.g.liveCount >= st.popSoftLimit;
      if (world.g.liveCount + world.g.eggCount + world.g.carcassCount >= world.agentCap || softFull) { st.deferredBirths += req.n - k; break; }
      if (c.life[req.parentSlot] !== LIFE.ALIVE || entityId(world, req.parentSlot) !== req.parentId) break;
      if (spawnChild(world, ctx, st, req) < 0) { st.deferredBirths += req.n - k; break; }
    }
    finishRequest(world, req);
  }
  p.births.length = 0;
  // 5. whale falls (other spawn kinds arrive with god powers later)
  for (const sp of p.spawns) {
    if (sp.kind !== 'carcass') continue;
    const sl = allocCreature(world);
    if (sl < 0) continue;
    commitCarcassSpawn(world, sl, sp);
  }
  p.spawns.length = 0;
}
