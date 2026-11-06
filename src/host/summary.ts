/**
 * The 1 Hz whole-tank summary (CONTRACT 12 CENSUS and STATS, DESIGN R19, R32): per-species
 * counts, biomass and colour, the sim's 64 x 36 RGBA census heat (visible life, emissive,
 * activity, carcasses; the same channels the dream tank sends, so the director works in host
 * views too), environment, and host statistics for the god window. Computed once per
 * second and shared by every client.
 */
import { CENSUS_EVERY, encodeCborFrame, FRAME, LIFE, Q_MASS, type CborValue, type World } from '../core/index.js';
import { dayPhase, ecosystem, yearPhase } from '../sim/index.js';
import { censusPayload } from '../sim/frames.js';

export const HEAT_W = 64;
export const HEAT_H = 36;

export interface SpeciesRow { id: number; count: number; biomassKg: number; colour: number }
export interface TankSummary {
  tick: number;
  epoch: number;
  population: number;
  species: SpeciesRow[];
  biomassKg: number;
  heat: Uint8Array;
  env: { dayPhase: number; yearPhase: number; ySurface: number };
  ledger: { ok: boolean; totalQ: number; expectedQ: number } | null;
}

export function summarise(world: World): TankSummary {
  const c = world.cr.c;
  const bySpecies = new Map<number, SpeciesRow & { r: number; g: number; b: number }>();
  let pop = 0;
  let biomassQ = 0;
  for (let s = 0; s < world.cr.highWater; s++) {
    if (c.life[s] !== LIFE.ALIVE) continue;
    pop++;
    const q = c.qTissue[s]! + c.qReserve[s]! + c.qRepro[s]!;
    biomassQ += q;
    const sp = c.species[s]!;
    const col = c.colour[s]!;
    let row = bySpecies.get(sp);
    if (!row) { row = { id: sp, count: 0, biomassKg: 0, colour: col, r: 0, g: 0, b: 0 }; bySpecies.set(sp, row); }
    row.count++;
    row.biomassKg += q * Q_MASS;
  }
  const heatBytes = (censusPayload(world) as { heat: Uint8Array }).heat;
  let ledger: TankSummary['ledger'] = null;
  try { const a = ecosystem.audit(world); ledger = { ok: a.ok, totalQ: a.totalQ, expectedQ: a.expectedQ }; } catch { ledger = null; }
  const species = [...bySpecies.values()].sort((a, b) => b.count - a.count || a.id - b.id)
    .map(({ id, count, biomassKg, colour }) => ({ id, count, biomassKg, colour }));
  return {
    tick: world.g.tick, epoch: world.g.epoch, population: pop, species, biomassKg: biomassQ * Q_MASS, heat: heatBytes,
    env: { dayPhase: dayPhase(world), yearPhase: yearPhase(world), ySurface: world.g.ySurface }, ledger,
  };
}

export function censusFrame(s: TankSummary): Uint8Array {
  return encodeCborFrame(FRAME.CENSUS, s.tick, {
    species: s.species as unknown as CborValue, heat: s.heat, env: s.env as unknown as CborValue,
  });
}

export interface HostStats {
  achievedHz: number;
  speed: number | 'max';
  throttle: string;
  clients: number;
  stepErrors: number;
  lastSaveTick: number | null;
}

export function statsFrame(s: TankSummary, h: HostStats): Uint8Array {
  return encodeCborFrame(FRAME.STATS, s.tick, {
    tick: s.tick, epoch: s.epoch, population: s.population, speciesCount: s.species.length, biomassKg: s.biomassKg,
    ledger: s.ledger as unknown as CborValue, host: h as unknown as CborValue, censusEvery: CENSUS_EVERY,
  });
}
