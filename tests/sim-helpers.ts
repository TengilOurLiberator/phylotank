/** Shared imports for the sim tests. */
export * from '../src/core/index.js';
export { agentCapFeeKg as agentCapFeeKgFn } from '../src/ecosystem/index.js';

import { encodeGenome, encodeQ, T, TRAITS, type Genome } from '../src/core/index.js';
import { fallbackGenome } from '../src/sim/fallback/genome.js';

/** A fast budder: 2 mm adults, big newborns, short life, so births and deaths come early. */
export function fastGenome(sexProb = 0): Uint8Array {
  const g: Genome = fallbackGenome.template('motefly');
  const set = (i: number, v: number): void => { g.traits[i] = encodeQ(v, TRAITS[i]!); };
  set(T.ADULT_LENGTH!, 0.002); set(T.BIRTH_FRACTION!, 0.5); set(T.MATURITY_FRACTION!, 0.6);
  set(T.GROWTH_RATE!, 5); set(T.LIFESPAN_MULT!, 2); set(T.SENESCENCE!, 0.8); set(T.BROOD_INTERVAL!, 0.05);
  set(T.SEX_PROB!, sexProb);
  return encodeGenome(g);
}
