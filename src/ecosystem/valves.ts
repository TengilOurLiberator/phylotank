/**
 * Safety valves (04 §4.7): total consumer extinction for a grace period of 0.5 sim day asks
 * for a reseed; fewer than 2 consumer species with at least 10 individuals for 10 sim days
 * asks for immigration every 2 sim days until diversity recovers; background immigration at
 * p_imm = 0.05 per sim day. The ecosystem only detects and requests (SpawnRequest kind
 * 'reseed'); the host fills the request from the gene bank, taking the mass from N
 * (`endowCreature`), and marks arrivals with `immigrantTick` so the immigrant-descended
 * biomass share stays visible (review §4). Checked once per census (1 Hz).
 */
import { CENSUS_EVERY, DAY_S, DT, LIFE, RNG_STREAM, type StepContext, type World } from '../core/index.js';
import type { EcoState } from './state.js';

export interface ValveState { noConsumerSince: number; lowDiversitySince: number; lastImmigration: number; enabled: boolean; pImmPerDay: number }
export function newValves(): ValveState {
  return { noConsumerSince: -1, lowDiversitySince: -1, lastImmigration: -1e18, enabled: true, pImmPerDay: 0.05 };
}

/** Returns the reason of a request made this tick, or null. */
export function checkValves(world: World, s: EcoState, v: ValveState, ctx: StepContext): 'extinction' | 'diversity' | 'immigration' | null {
  if (!v.enabled || ctx.tick % CENSUS_EVERY !== 0) return null;
  const c = world.cr.c;
  const counts = new Map<number, number>();
  let consumers = 0;
  for (let sl = 0; sl < world.cr.highWater; sl++) {
    const life = c.life[sl]!;
    if (life !== LIFE.ALIVE && life !== LIFE.EGG) continue;
    consumers++;
    counts.set(c.species[sl]!, (counts.get(c.species[sl]!) ?? 0) + 1);
  }
  const tick = ctx.tick;
  const day = DAY_S / DT;
  let reason: 'extinction' | 'diversity' | 'immigration' | null = null;
  if (consumers === 0) {
    if (v.noConsumerSince < 0) v.noConsumerSince = tick;
    else if (tick - v.noConsumerSince >= 0.5 * day) { reason = 'extinction'; v.noConsumerSince = tick; }
  } else v.noConsumerSince = -1;
  let viable = 0;
  for (const n of counts.values()) if (n >= 10) viable++;
  if (reason === null && consumers > 0 && viable < 2) {
    if (v.lowDiversitySince < 0) v.lowDiversitySince = tick;
    else if (tick - v.lowDiversitySince >= 10 * day && tick - v.lastImmigration >= 2 * day) reason = 'diversity';
  } else if (viable >= 2) v.lowDiversitySince = -1;
  if (reason === null && v.pImmPerDay > 0) {
    const d = ctx.rng.draw(RNG_STREAM.ECOLOGY, tick, 2 ** 52 + 0x7a1 * 2 ** 36);
    if (d.u01() < (v.pImmPerDay * CENSUS_EVERY) / day) reason = 'immigration';
  }
  if (reason === null) return null;
  v.lastImmigration = tick;
  s.pending.spawns.push({ kind: 'reseed', cmdId: `${reason}-${tick}`, pos: [world.preset.widthM / 2, 1], massQ: 0, count: reason === 'immigration' ? 20 : 100 });
  ctx.events.emit({ k: 'reseed', reason, species: [] } as never);
  return reason;
}
