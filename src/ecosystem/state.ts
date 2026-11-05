/**
 * Per-world ecosystem state that is not in the contract's SoA layout yet (see
 * docs/contract-requests/ecosystem.md): the decoded per-creature traits cache, the pending
 * birth, death and restage requests, strains and spores, ledger statistics, metric history
 * and terrain metadata. Held in a WeakMap keyed by the World, so the World type is unchanged.
 */
import { LEDGER_CHANNELS, type World } from '../core/index.js';
import type { TerrainInfo } from './terrain.js';
import type { DeathCause } from '../core/index.js';

/** Per-creature cached traits and phenotype values (Float64 lanes per slot). */
export const ER = {
  LOADED: 0, E_PLANT: 1, E_MEAT: 2, E_DET: 3, LIFESPAN_MULT: 4, SENESCENCE: 5, IMMUNE: 6,
  T_OPT: 7, T_TOL: 8, O_CRIT: 9, FAT_CAP: 10, CLUTCH: 11, REPRO_RES: 12, BIRTH_FRAC: 13,
  GROWTH: 14, MAT_FRAC: 15, SESSILE: 16, BROOD: 17, FILTER: 18, SCRAPE: 19, BITE: 20, GAPE: 21,
  G_GUT: 22, GUT_VOL: 23, PHOTO_AREA: 24, ADULT_TISSUE_Q: 25, TISSUE_PEAK_Q: 26, AGE_CLOCK: 27,
  STARVING: 28, STAGE_LEN: 29, IMMIGRANT_TICK: 30, PHOTO_EMA: 31, INTAKE_EMA: 32, LAST_DMG: 33,
  SEX_PROB: 34, SHELL: 35, TOXICITY: 36, BIRTH_TISSUE_Q: 37, PREV_HEALTH: 38, REPRO_REQ: 39,
  ODOUR_A: 40, ODOUR_B: 41, ODOUR_C: 42, ODOUR_D: 43,
} as const;
export const ER_LANES = 44;

export interface BirthRequest {
  parentSlot: number; parentId: number; requestIndex: number; n: number; mode: 'bud' | 'sex';
  childTissueQ: number; childReserveQ: number; overheadQ: number; feeQ: number;
}
export interface DeathRequest { slot: number; id: number; cause: DeathCause; killer?: number }
export interface SpawnRequest {
  kind: 'carcass' | 'release' | 'predatorFlood' | 'reseed'; cmdId: string; pos: [number, number];
  massQ: number; count: number; species?: number[];
}
export interface Pending {
  births: BirthRequest[];
  deaths: DeathRequest[];
  restage: number[];
  /** Carcasses fully decayed: their pools are empty and the sim may free the slot. */
  free: number[];
  spawns: SpawnRequest[];
}

export interface Strains {
  n: number; // high water
  live: Uint8Array; id: Uint32Array; parent: Uint32Array; bornTick: Float64Array;
  antigen: Uint32Array; adhesin: Uint32Array; beta: Float32Array; virulence: Float32Array;
  growth: Float32Array; envHalfLife: Float32Array; routes: Uint32Array; hostCount: Uint32Array;
  sporeLoad: Float32Array; nextId: number;
  archive: number[][]; // reservoir strains: [antigen, adhesin, beta, virulence, growth, envHalfLife]
}
export interface Spores { n: number; x: Float64Array; y: Float64Array; strain: Uint32Array; load: Float32Array }

export interface MetricsHistory {
  firstSeen: Map<number, number>; peak: Map<number, number>; lastCount: Map<number, number>;
  speciations: number[]; extinctions: number[]; // ticks
}

export interface EcoState {
  terrain: TerrainInfo;
  wetC: Uint8Array; wetF: Uint8Array; floorRowC: Int32Array;
  substrate: Int32Array; subMask: Float32Array; kernel: { dx: Int32Array; dy: Int32Array; w: Float64Array };
  er: Float64Array; erCap: number;
  pending: Pending;
  strains: Strains; spores: Spores;
  /** Ledger statistics: this ecology tick and cumulative, 16 channels (CONTRACT 9.7). */
  ledgerTick: Float64Array; ledgerTotal: Float64Array;
  history: MetricsHistory;
  /** Flow face fluxes (m^2/s) on the coarse grid, rebuilt on slow ticks. */
  uFace: Float64Array; vFace: Float64Array; psiC: Float64Array;
  /** Smoothed local floor depth per coarse column, for the terrain-following flow modes. */
  hFloor: Float64Array;
  /** Fine-grid face fluxes, interpolated from the coarse streamfunction. */
  uFaceF: Float64Array; vFaceF: Float64Array;
  nAgentsAtTick: number;
  capTaxTicks: number; ecoTicks: number;
  natureOn: boolean;
  /** 'additive' is the contract (9.6); 'multiplicative' is 04's old surcharge, kept for spike 3 only. */
  capTaxMode: 'additive' | 'multiplicative';
  yearOffset: number;
  rActiveTargetQ: number; // nominal reservoir size; active target = mTargetQ - this
  scratch: Map<string, Float64Array>;
  env: Env;
  /** Rock cells painted by each rift barrier, restored when it lapses. */
  barriers: Map<string, number[]>;
  mods: Mods;
  diag: { nan: number; refusedEndowments: number };
}

/** Environment scalars of the current slow tick. */
export interface Env {
  t: number; dayPhase: number; yearPhase: number; surfLight: number; tSurf: number;
  yTh: number; wTh: number; strat: number; ySurface: number;
}
/** Aggregated god-power modifiers of the current slow tick (04 §4.8 modifier stack). */
export interface Mods {
  tempOffset: number; lightMult: number; mutagen: number; muBoost: number; kzMult: number;
  flowMult: Float64Array; flowFlip: boolean; iceDrop: number; turbAdd: number;
  /** Regional effects: [x, y, r, value] (r < 0 means global). */
  deadZones: number[][]; blooms: number[][]; toxins: number[][]; mutagens: number[][];
}
export function newMods(): Mods {
  return {
    tempOffset: 0, lightMult: 1, mutagen: 1, muBoost: 1, kzMult: 1, flowMult: new Float64Array(8).fill(1),
    flowFlip: false, iceDrop: 0, turbAdd: 0, deadZones: [], blooms: [], toxins: [], mutagens: [],
  };
}

const states = new WeakMap<World, EcoState>();

export function getState(world: World): EcoState {
  const s = states.get(world);
  if (!s) throw new Error('ecosystem state missing: call ecosystem.initWorld first');
  return s;
}
export function hasState(world: World): boolean { return states.has(world); }
export function setState(world: World, s: EcoState): void { states.set(world, s); }

export function newStrains(cap = 4096): Strains {
  return {
    n: 0, live: new Uint8Array(cap), id: new Uint32Array(cap), parent: new Uint32Array(cap),
    bornTick: new Float64Array(cap), antigen: new Uint32Array(cap), adhesin: new Uint32Array(cap),
    beta: new Float32Array(cap), virulence: new Float32Array(cap), growth: new Float32Array(cap),
    envHalfLife: new Float32Array(cap), routes: new Uint32Array(cap), hostCount: new Uint32Array(cap),
    sporeLoad: new Float32Array(cap), nextId: 1, archive: [],
  };
}
export function newSpores(cap = 65536): Spores {
  return { n: 0, x: new Float64Array(cap), y: new Float64Array(cap), strain: new Uint32Array(cap), load: new Float32Array(cap) };
}
export function newPending(): Pending { return { births: [], deaths: [], restage: [], free: [], spawns: [] }; }
export const N_CHANNELS = LEDGER_CHANNELS.length;
export const CH = Object.fromEntries(LEDGER_CHANNELS.map((n, i) => [n, i])) as Record<(typeof LEDGER_CHANNELS)[number], number>;

/** A reusable scratch array of at least n doubles, zeroed. */
export function scratch(s: EcoState, key: string, n: number): Float64Array {
  let a = s.scratch.get(key);
  if (!a || a.length < n) { a = new Float64Array(n); s.scratch.set(key, a); } else a.fill(0, 0, n);
  return a;
}
