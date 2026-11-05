/**
 * Life-history numbers decoded from the trait block, for the sim and the ecosystem
 * (01 §1.4.4, CONTRACT 9.4, 9.6; review R10: CLUTCH_SIZE and BIRTH_FRACTION decode exactly).
 *
 * Growth clock (von Bertalanffy on a size-scaled clock):
 *   L(t) = L_inf - (L_inf - L_0) exp(-k t),  L_inf = L_adult / 0.98,  L_0 = BIRTH_FRACTION x L_adult
 *   k = GROWTH_RATE x K0 x (L_adult / 1 cm)^-(3 (1 - KLEIBER_EXP))
 * tMature is the time to reach MATURITY_FRACTION x L_adult; lifespan = LIFESPAN_MULT x tMature.
 * Ecology owns actual growth (energy-limited); these are the genetic schedule and the targets.
 */
import { KLEIBER_EXP, exp, log, type Genome } from '../core/index.js';
import { K0_GROWTH } from './constants.js';
import { expressedAdultLength } from './ceiling.js';
import { TI, trait } from './genes.js';

export interface LifeHistory {
  adultLengthM: number;
  birthLengthM: number;
  /** Growth constant k, 1/s. */
  k: number;
  tMatureS: number;
  lifespanS: number;
  clutchSize: number;
  birthFraction: number;
  maturityFraction: number;
  sexProb: number;
}

export function lifeHistory(g: Genome, lCeilingM: number): LifeHistory {
  const La = expressedAdultLength(g, lCeilingM);
  const bf = trait(g, TI.BIRTH_FRACTION);
  const mf = trait(g, TI.MATURITY_FRACTION);
  const L0 = bf * La;
  const Linf = La / 0.98;
  const k = trait(g, TI.GROWTH_RATE) * K0_GROWTH * exp(-3 * (1 - KLEIBER_EXP) * log(La / 0.01));
  const target = Math.max(mf * La, L0);
  const tMatureS = target <= L0 ? 0 : -log((Linf - target) / (Linf - L0)) / k;
  return {
    adultLengthM: La, birthLengthM: L0, k, tMatureS, lifespanS: trait(g, TI.LIFESPAN_MULT) * tMatureS,
    clutchSize: Math.max(1, Math.min(64, Math.round(trait(g, TI.CLUTCH_SIZE)))),
    birthFraction: bf, maturityFraction: mf, sexProb: trait(g, TI.SEX_PROB),
  };
}
