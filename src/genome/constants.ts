/** Genome-module constants (01 §1.6, §1.9; tuning values recorded in docs/modules/genome.md). */

/** First innovation id outside the reserved template range (CONTRACT 6.8). */
export const FIRST_FREE_INNOV = 4096;

/** Self-adaptation meta-rate in x space (01 §1.6.1). */
export const META_RATE = 0.02;
/** Structural operator weights (01 §1.6.2, brain rows for the direct encoding). */
export const OP_WEIGHTS = {
  repeat: 15, duplicate: 12, deleteModule: 8, addModule: 4, rewire: 8, symmetry: 4, kind: 4, toggle: 4, reg: 8,
  synAdd: 14, neuronAdd: 6, synDelete: 8, neuronDelete: 5,
} as const;
/** Probability that a duplication deep-copies the subtree (01 §1.6.2). */
export const DEEP_COPY_P = 0.3;

/** Crossover (01 §1.7.3). */
export const BLEND_P = 0.2;
export const DONOR_REG_P = 0.25;
export const DONOR_SYN_P = 0.25;
export const DONOR_MODULE_P = 0.15;

/** Distance weights (01 §1.9.1, DESIGN R3, review R14). */
export const C_S = 1.0;
export const C_P = 0.5;
export const C_T = 2.0;
export const CPPN_JACCARD_WEIGHT = 0.5;
export const THETA_SPECIES = 0.3;

/** Species hysteresis (01 §1.9.3, review R14). */
export const N_MIN = 8;
export const PERSIST_GENERATIONS = 2;
/** Promotion also needs this much living biomass, as a multiple of one founder adult's mass. */
export const BIOMASS_MIN_ADULTS = 4;
export const RESERVOIR_SIZE = 64;
export const MEDOID_EVERY = 256;

/** Growth clock: k = GROWTH_RATE x K0 x (L / 1 cm)^-(3(1 - 0.75)) per second (01 §1.4.4). */
export const K0_GROWTH = 1 / 600;
