/**
 * The engine interface the lab drives. Two implementations: the self-contained toy
 * (toy/engine.ts) and the real SimCore (adapters/simcore.ts). Everything the recorder and the
 * detectors need goes through `observe()`, `drainEvents()` and `audit()`, so they do not care which
 * world is underneath.
 */

/** Diet roles (04 §4.5 role inference). */
export const ROLE_NAMES = ['none', 'producer', 'filter', 'grazer', 'predator', 'scavenger', 'parasite', 'omnivore'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export interface Observation {
  tS: number;
  /** Living creatures (not eggs, not carcasses). */
  n: number;
  id: Float64Array;
  species: Uint32Array;
  lengthM: Float32Array;
  massKg: Float32Array;
  /** Swim speed in the local water frame, m/s. */
  speedMps: Float32Array;
  ageS: Float32Array;
  /** t_life (CONTRACT 9.4), s; 0 if unknown. */
  lifespanS: Float32Array;
  /** t_mature, s; 0 if unknown. */
  tMatureS: Float32Array;
  /** Index into ROLE_NAMES. */
  role: Uint8Array;
  sessile: Uint8Array;
  generation?: Uint32Array;
  /** Cumulative mechanical work put in by the creature's muscles, J. */
  workInJ?: Float32Array;
  /** Cumulative mechanical energy out (drag dissipation plus current kinetic energy), J. */
  workOutJ?: Float32Array;
  /** Potential swim speed at full effort (body property), m/s. */
  vMaxMps?: Float32Array;
  /** Genome traits in decoded units, by name, with their schema bounds. */
  traits: Record<string, Float32Array>;
  traitBounds: Record<string, readonly [number, number]>;
  /** Agents counted against the cap (live plus eggs plus carcasses). */
  agents: number;
  agentCap: number;
  /** Engine-specific scalar extras merged into the time series. */
  extra: Record<string, number>;
}

export interface LabEvent {
  k: 'birth' | 'death';
  tS: number;
  id: number;
  species: number;
  lengthM: number;
  generation?: number;
  cause?: string;
}

export interface LabAudit {
  /** Exact integer mass invariant holds. */
  ok: boolean;
  totalQ: number;
  expectedQ: number;
  /** Relative energy closure residual, if the engine tracks energy. */
  energyResidual?: number;
  pools: Record<string, number>;
}

export interface EvoEngine {
  readonly name: string;
  /** Simulated seconds per step. */
  readonly dtS: number;
  readonly agentCap: number;
  /** Advance `n` steps. */
  step(n: number): void;
  timeS(): number;
  observe(): Observation;
  drainEvents(): LabEvent[];
  audit(): LabAudit;
  /** Optional per-species extra series (for example a second species registry). */
  speciesCounts?(): Record<string, number>;
  /** A short description of the configuration for the run summary. */
  describe(): Record<string, unknown>;
}
