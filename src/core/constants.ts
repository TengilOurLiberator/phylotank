/**
 * Contract constants. Every value here is quoted in docs/CONTRACT.md; values marked with a
 * dagger there are cross-checked by tests/contract.test.ts. Change both together.
 */

// 1. Units and the mass quantum
export const Q_MASS = 1e-12; // kg per quantum (1 ng)
export const MAX_WORLD_MASS_KG = 2 ** 53 * Q_MASS; // about 9007 kg: exact-integer f64 limit
export const M_REF_1CM = 3.1e-5; // kg, the 1 cm isometric reference body ("mu", display only)
export const M_REF_1M = 31; // kg, mass of the 1 m isometric reference body
/** Reference body mass for an isometric body of length L (m). Thresholds only, not physics. */
export function mRef(lengthM: number): number {
  return M_REF_1M * lengthM * lengthM * lengthM;
}
export const E_B = 4000; // J/kg, compressed biomass energy density (DESIGN R5)

// 3. Time
export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;
export const ECO_EVERY = 3;
export const DT_ECO = ECO_EVERY * DT;
export const SLOW_EVERY = 15;
export const CENSUS_EVERY = 30;
export const METRICS_EVERY = 1800;
export const HASH_EVERY = 256;
export const GOVERNOR_EVERY = 300;
export const DAY_S = 1200;
export const YEAR_DAYS = 20;

// 3.2 Presets
export type PresetName = 'small' | 'default' | 'large';
export interface TankPreset {
  readonly name: PresetName;
  readonly widthM: number;
  readonly heightM: number;
  readonly coarse: readonly [number, number];
  readonly fine: readonly [number, number];
  readonly sdf: readonly [number, number];
  readonly agentCap: number;
  readonly cpuAgentCap: number;
  readonly mTargetKg: number;
  readonly lCeilingM: number;
}
export const COARSE_CELL_M = 0.25;
export const FINE_CELL_M = 1 / 16;
export const SDF_CELL_M = 0.125;
export const SEG_PER_AGENT = 12;

// L_ceiling = 0.20 m * (M_target / 400 kg)^(1/3), rounded to the millimetre. Literals, so no
// platform cube root runs in sim code (CONTRACT 4.2 rule 3); tests/contract.test.ts checks them.
export const PRESETS: Readonly<Record<PresetName, TankPreset>> = {
  small: {
    name: 'small', widthM: 32, heightM: 18, coarse: [128, 72], fine: [512, 288], sdf: [256, 144],
    agentCap: 16_384, cpuAgentCap: 4_096, mTargetKg: 100, lCeilingM: 0.126,
  },
  default: {
    name: 'default', widthM: 64, heightM: 36, coarse: [256, 144], fine: [1024, 576], sdf: [512, 288],
    agentCap: 131_072, cpuAgentCap: 8_192, mTargetKg: 400, lCeilingM: 0.2,
  },
  large: {
    name: 'large', widthM: 128, heightM: 72, coarse: [512, 288], fine: [2048, 1152], sdf: [1024, 576],
    agentCap: 262_144, cpuAgentCap: 8_192, mTargetKg: 1_600, lCeilingM: 0.317,
  },
};

// 3.3 Size ceiling and leviathans
export const L_MIN = 0.0005;
export const L_MAX = 1.0;
export const K_ENDOW = 8;
export const G_REL = 0.6;
export const FULL_TIER_REL = 0.5;
export const GENOME_FLAG_DESIGNED = 1 << 0;
export const GENOME_FLAG_EDITED = 1 << 1;
export const GENOME_FLAG_HAS_SILENT = 1 << 2;
export const GENOME_FLAG_LEVIATHAN = 1 << 3;

// 4.1 RNG stream ids (ids >= 100 are view-only and must never feed the sim)
export const RNG_STREAM = {
  WORLDGEN: 1, MUTATION: 2, CROSSOVER: 3, BIRTH: 4, BRAIN_NOISE: 5, SENSOR_NOISE: 6,
  DEVELOPMENT: 7, PHYSICS: 8, ECOLOGY: 9, AGEING: 10, DISEASE: 11, GOD: 12, NATURE: 13,
  SPECIES: 14, GOVERNOR: 15, SKELETON: 16,
  VIEW_RENDER: 100, VIEW_DIRECTOR: 101, VIEW_AUDIO: 102,
} as const;
export type RngStreamId = (typeof RNG_STREAM)[keyof typeof RNG_STREAM];

// 6. Genome format
export const GENOME_MAGIC = 0x31475450; // bytes 'P','T','G','1'
export const GENOME_FORMAT_VERSION = 1;
export const GENOME_HEADER_SIZE = 32;
export const GENOME_MAX_BYTES = 16_384;
export const MAX_PARTS = 64;
export const MAX_PARTS_LAPTOP = 32;
export const KLEIBER_EXP = 0.75;

// 8. Brain
export const BRAIN_CLASSES = [
  { n: 16, i: 32, k: 8 },
  { n: 32, i: 64, k: 8 },
  { n: 64, i: 96, k: 16 },
  { n: 128, i: 160, k: 16 },
  { n: 256, i: 192, k: 16 },
] as const;
export const BRAIN_POOL_SHARE = [0.6, 0.25, 0.12, 0.04, 0.01] as const;
export const BRAIN_COST_NEURON_W = 2e-9;
export const BRAIN_COST_SYNAPSE_W = 2e-10;
export const BRAIN_COST_PLASTIC_W = 1e-9;
export const BRAIN_STATE_CLAMP = 8;

// 9. Ledger
export const C_G = 1.4; // reserve per unit soft tissue built
export const C_G_NEURAL = 2.0;
export const C_G_ARMOUR = 1.2;
export const CATABOLISM_EFF = 0.8;
export const SDA_FRACTION = 0.1;
export const B0_KLEIBER = 0.3; // W kg^-0.75 at 15 C
export const E_A_EV = 0.65;
export const K_BOLTZMANN_EV = 8.617333262e-5;
export const T_REF_K = 288.15;
export const C_REP = 0.05;
export const K_CAP = 1;
export const FAT_CAPACITY_0 = 0.3;
export const OVERHEAD_FRACTION = 0.15;
export const OVERHEAD_ABS_KG = 1e-3 * M_REF_1CM;
/** Genome replication cost per byte per offspring, kg (CONTRACT 9.6, request G9; 01 §1.6.4). */
export const KAPPA_DNA_KG = 2.6e-14;
export const ENZYME_THETA = 1.3;
export const FOOD_ENERGY = { plant: 0.6, meat: 1.0, detritus: 0.3 } as const;
/** Energy factor f (units of E_B per kg) per pool class (CONTRACT 9.2). */
export const POOL_ENERGY_FACTOR = {
  dissolved: 0, reservoir: 0, phyto: 0.6, mat: 0.6, gutPlant: 0.6, detritus: 0.3, sediment: 0.3,
  cyst: 0.3, gutDetritus: 0.3, tissue: 1, reserve: 1, repro: 1, egg: 1, carcass: 1, gutMeat: 1,
} as const;
export const LEDGER_CHANNELS = [
  'photosynthesis', 'chemosynthesis', 'godInjection', 'ingestion', 'absorption', 'faeces',
  'heatBasal', 'heatMuscle', 'heatOrgans', 'heatRepair', 'growth', 'reproduction', 'capFee',
  'deathToCarcass', 'decay', 'parasiteDrain',
] as const;

// 10.3 Water and physics constants others rely on
export const NU_WATER = 2e-5; // m^2/s, 20x sea water
export const RHO_WATER = 1025; // kg/m^3
export const GRAVITY = 9.81; // m/s^2 along +y
export const MIN_SUBSTEPS_ACTIVE = 4;
export const MAX_SUBSTEPS = 16;

// 12. Protocol
export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 0;
export const PROTOCOL_VERSION = (PROTOCOL_MAJOR << 8) | PROTOCOL_MINOR;
export const MAX_INBOUND_BYTES = 65_536;
export const HOST_PORT = 47_615;

// 13. Lead times (wall seconds)
export const LEAD_MAJOR_S = 3;
export const LEAD_MINOR_S = 1;
