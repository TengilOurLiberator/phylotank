/**
 * Physics-private constants (02 §2.2 to §2.6, CONTRACT 10.3). Contract-visible water constants
 * come from core; everything here is a physics starting value that the benchmarks tune.
 */
import { NU_WATER, RHO_WATER } from '../core/index.js';

export const RHO_TISSUE = 1060;
export const RHO_LIPID = 920;
export const RHO_ARMOUR = 2000;
/** Dynamic viscosity of tank water, Pa s. */
export const MU_WATER = RHO_WATER * NU_WATER;
/** Added-mass coefficient of the normal direction. */
export const C_ADDED = 1;
/** Muscle stress (Pa) and structural bending stress (Pa) for the torque caps. */
export const SIGMA_MUSCLE = 2e5;
export const SIGMA_STRUCT = 2e6;
/** Maximum shortening rate at 15 C, rad/s; Q10 = 2. */
export const OMEGA_MAX_15C = 20;
export const Q10_MUSCLE = 2;
/** Muscle efficiency for positive work; isometric cost factor (x basal). */
export const ETA_MUSCLE = 0.25;
export const KAPPA_ISO = 3;
/** Cilia: kappa_c, default slip speed (m/s), efficiency. */
export const KAPPA_CILIA = 3;
export const CILIA_SLIP = 1e-3;
export const ETA_CILIA = 0.02;
/** Default Young's modulus (Pa) when the phenotype carries none. */
export const YOUNGS_DEFAULT = 3e5;
export const DAMPING_DEFAULT = 0.2;
/** Contact: friction coefficient, depenetration speed in body lengths per second. */
export const CONTACT_FRICTION = 0.2;
export const DEPEN_BL_PER_S = 0.5;
/** Fixed-point unit for contact position corrections (CONTRACT 4.2 rule 5): 2^-20 m. */
export const FIX_POS = 1048576;
/** Bites (02 §2.4.3). */
export const SIGMA_JAW = 2e5;
export const H_TISSUE = 2e5;
export const C_BITE = 1e-6;
export const BITE_ON = 0.5;
export const BITE_OFF = 0.2;
/** Gauss point offset factor: xi = l / (2 sqrt 3). */
export const GAUSS_XI = 0.28867513459481287;
