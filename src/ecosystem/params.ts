/**
 * Ecosystem parameters (04 §4.10, converted to SI and the CONTRACT 3.2 mass budgets).
 *
 * Densities: 04 wrote them in mu/m^2 for a 2e6 mu (62 kg) Default tank. Every preset now has
 * the same mean nutrient density M_target / area = 0.174 kg/m^2, which is 5.6 times the old
 * 1000 mu/m^2. So an old density of 1 mu/m^2 becomes DENS = 3.1e-5 * 5.6 kg/m^2 here, which
 * keeps every ratio of 04 (half-saturations, bloom shading, mat ceiling) where it was.
 * Rates: per sim second; 04's "per day" values are divided by DAY_S (1200 s).
 */
import { DAY_S, J_MAX_BASAL } from '../core/index.js';

export const DENS = 3.1e-5 * 5.6; // kg/m^2 per old mu/m^2
const PER_DAY = 1 / DAY_S;

export const P: { -readonly [K in keyof typeof P_BASE]: number } = {} as never;
const P_BASE = {
  // Light (04 §4.2)
  kW: 0.2, // /m
  kChl: 1 / (500 * DENS), // per (kg/m^2) per m: a 500 old-mu bloom doubles attenuation
  kTurb: 0.5, // per unit turbidity per m
  kIce: 1.2, // /m
  iK: 0.3,
  aI: 0.35,
  iMoon: 0.01,
  blur: 0.3,
  // Temperature (04 §4.2, DESIGN R15, R28); depths are for the 36 m Default and scale with H
  tMean: 14, aSeason: 5, aDay: 0.5, tDeep: 4,
  yThSummer36: 8, yThWinter36: 20, wTh36: 2,
  tauT: 0.5 * DAY_S, // anomaly relaxation, s
  ventT: 25, // C near a vent
  q10: 2,
  tRefC: 15,
  // Oxygen
  oxCap: 0.05, // kg of matter burnt per m^2 that uses up one saturation unit
  kAir: 1 / 3600, // surface exchange /s (top row)
  // Mixing
  kh: 0.002, kz0: 1e-4, kMix: 5e-3, // m^2/s
  // Flow
  d0: 0.75, // SDF ramp width, m
  ventPlume: 0.02, // plume vortex strength, m/s at the vent axis
  ventPlumeR: 1.0, // plume radius, m
  // Plankton (04 §4.3.1)
  muMax: 1.5 * PER_DAY,
  kN: 50 * DENS,
  mP: 0.05 * PER_DAY,
  mP2: (2e-4 / DENS) * PER_DAY, // per (kg/m^2) per s
  wP: 0.5 * PER_DAY, // sinking m/s
  wD: 8 * PER_DAY,
  cystGerm: 0.5 * PER_DAY,
  cystLight: 0.05,
  cystResusp: 0.05, // m/s
  // Mats (04 §4.3.2), Small CPU preset: radius 4 fine cells
  rB: 4, mB: 0.3, sB: 0.06,
  muB: 0.6 * PER_DAY, dB: 0.5 * PER_DAY,
  bMax: 400 * DENS, eSeed: 0.5 * DENS,
  kS: 0.2, // sulphur half-saturation for chemo mats
  // Cycling (04 §4.4)
  rD: 0.15 * PER_DAY, rSed: 0.02 * PER_DAY, burial: 0.001 * PER_DAY,
  excessHalfLife: 40 * DAY_S,
  reservoirFrac: 0.02,
  carcassHalfLife: 1.5 * DAY_S,
  sulphurRate: 0.5, // sulphur units per s at a vent cell
  sulphurTau: DAY_S,
  turbSettle: PER_DAY,
  // Feeding and digestion (DESIGN R11, 02 §2.6.5)
  scrapeRate: 0.5, // body lengths per second swept by a rasping mouth
  photoEff: 2e-6, // kg/s of reserve per m^2 of photosynthetic area at full light
  hollingK: J_MAX_BASAL, // J_max = 12 B / (f E_B) (CONTRACT 9.5; raised from 8 in integration, docs/spikes/integration-1.md)
  // Feeding current of a filter feeder, body lengths per second of water drawn through the
  // mouth on top of the creature's own speed through the water (cilia and pumping, 04 §4.5).
  pumpFloorBL: 1,
  // Retention of a particle kind by a filter with no enzyme for it (1 = unselective, 04 §4.5).
  filterSelect0: 0.25,
  gutDensity: 1060,
  // Health
  hypoxiaDamage: 0.2, // health per s at O2 = 0
  thermalDamage: 0.05, // health per s outside 2.5 sigma
  healRate: 0.01, // per s when unstressed
  starveFloor: 0.5, // die when tissue falls below this fraction of its peak
  // Disease (04 §4.6, DESIGN R28)
  cClear: 2 * PER_DAY, cIota: 0.15, muS: 0.02, vMax: 2, z: 0.5,
  contactRate: 0.5, // dose per s per unit partner load in the same cell
  shedRate: 0.2, // spores per s at virulence 1, load 1
  hV: 1, // hazard per day per unit virulence x load
  dietTau: DAY_S,
  // Nature mode (William's Q7): 1 per 10 sim days
  natureRate: 0.1 * PER_DAY,
} as const;
Object.assign(P, P_BASE);

/** The defaults, for tuning harnesses (04 §4.10). */
export const ECO_PARAM_DEFAULTS: Readonly<Record<string, number>> = Object.freeze({ ...P_BASE });

let applied: Readonly<Record<string, number>> | undefined;
/**
 * Make `P` the defaults plus a world's `config.params` overrides (request EV1). Called at the
 * entry of every ecosystem method, so worlds with different overrides can share a process.
 * Unknown names are an error.
 */
export function useParams(over: Readonly<Record<string, number>> | undefined): void {
  if (over === applied) return;
  Object.assign(P, P_BASE);
  if (over) {
    for (const [k, v] of Object.entries(over)) {
      if (!(k in P_BASE)) throw new Error(`unknown ecosystem parameter '${k}'`);
      if (!Number.isFinite(v)) throw new Error(`ecosystem parameter '${k}' is not finite`);
      (P as Record<string, number>)[k] = v;
    }
  }
  applied = over;
}

export type Params = typeof P;
