/**
 * Birth and death request queues (CONTRACT 4.2 rule 6, 9.6).
 *
 * The contract names the commit but no queue type, and the ecosystem and physics may not
 * import src/sim, so this file is a local adapter: the shape below is the one proposed in
 * docs/contract-requests/sim.md for `src/core` (a `requests` record on the World). Until the
 * integrator moves it, the queues are held per world in a WeakMap and only the sim's own
 * fallback modules (src/sim/fallback) can reach them.
 */
import { CF, type DeathCause, type World } from '../core/index.js';

export interface BirthRequest {
  /** Creature slot and entity id of the bearer (the parent that pays). */
  parentSlot: number;
  parentId: number;
  /** Counts the requests of this parent in this commit window, from 0. */
  requestIndex: number;
  /** 'bud' clones and mutates the bearer; 'sex' crosses the bearer with the mate. */
  mode: 'bud' | 'sex';
  mateSlot: number;
  mateId: number;
  /** Requested clutch size, at least 1 (the commit shrinks it to what the bearer can pay). */
  n: number;
  /** Tick the request was made. */
  tick: number;
}

export interface DeathRequest {
  slot: number;
  id: number;
  cause: DeathCause;
  killer?: number;
  tick: number;
}

export interface SimRequests {
  births: BirthRequest[];
  deaths: DeathRequest[];
  /** Births deferred by the agent cap or a full pool; retried first at the next commit. */
  deferred: BirthRequest[];
}

const queues = new WeakMap<World, SimRequests>();

export function requestsOf(world: World): SimRequests {
  let q = queues.get(world);
  if (!q) { q = { births: [], deaths: [], deferred: [] }; queues.set(world, q); }
  return q;
}

/** Entity id of a creature slot as a JS number (< 2^53). */
export function entityId(world: World, slot: number): number {
  const c = world.cr.c;
  return c.idHi[slot]! * 4294967296 + c.idLo[slot]!;
}

/** Queue a birth. The request index is assigned here, per parent, in call order; sets CF.BUDDING. */
export function requestBirth(world: World, r: Omit<BirthRequest, 'requestIndex' | 'parentId' | 'mateId'>): void {
  const q = requestsOf(world);
  const parentId = entityId(world, r.parentSlot);
  let idx = 0;
  for (const b of q.births) if (b.parentId === parentId) idx++;
  q.births.push({ ...r, parentId, requestIndex: idx, mateId: r.mateSlot >= 0 ? entityId(world, r.mateSlot) : -1 });
  // CF.BUDDING marks a pending request; the commit clears it
  world.cr.c.flags[r.parentSlot] = world.cr.c.flags[r.parentSlot]! | CF.BUDDING;
}

/** Queue a death. A second request for the same entity in one window is ignored at commit. */
export function requestDeath(world: World, slot: number, cause: DeathCause, tick: number, killer?: number): void {
  const d: DeathRequest = { slot, id: entityId(world, slot), cause, tick };
  if (killer !== undefined) d.killer = killer;
  requestsOf(world).deaths.push(d);
}

/** Total order for the birth commit: (parentEntityId, requestIndex). */
export function cmpBirth(a: BirthRequest, b: BirthRequest): number {
  return a.parentId - b.parentId || a.requestIndex - b.requestIndex;
}
/** Total order for the death commit: (entityId, request tick); the first cause wins. */
export function cmpDeath(a: DeathRequest, b: DeathRequest): number {
  return a.id - b.id || a.tick - b.tick;
}
