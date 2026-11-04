/**
 * Shared types of the contract (CONTRACT 6 to 13). Pure type declarations plus a few enums.
 */
import type { PresetName } from './constants.js';

// ---------------- Genome (decoded, quantised values as stored) ----------------
export interface ModuleGene {
  innov: number; kind: number; subtype: number; flags: number; recursionLimit: number;
  length: number; width: number; span: number; taper: number; stiffness: number;
  lipidFraction: number; muscleFraction: number; gutFraction: number; armourCoverage: number;
  hueOffset: number; glow: number; p1: number; p2: number; cpgPhase: number; cpgAmp: number;
  jointRange: number; jointRest: number; allometry: number; p3: number; p4: number; p5: number;
  photoFraction: number;
  /** Bytes beyond the known record size, kept for forward compatibility. */
  ext?: Uint8Array;
}
export interface LinkGene {
  innov: number; fromInnov: number; toInnov: number; attachPos: number; attachAngle: number;
  repeat: number; symmetry: number; childScale: number; repeatScale: number; flags: number; phaseStep: number;
  ext?: Uint8Array;
}
export interface RegGene {
  innov: number; targetInnov: number; targetKind: number; axis: number; param: number; shape: number;
  centre: number; width: number; amount: number; flags: number;
  ext?: Uint8Array;
}
export interface CppnNodeGene { innov: bigint; fn: number; flags: number; bias: number; ext?: Uint8Array }
export interface CppnConnGene { innov: bigint; from: bigint; to: bigint; w: number; flags: number; ext?: Uint8Array }
export interface HiddenNeuronGene { innov: number; tau: number; flags: number; bias: number; ext?: Uint8Array }
export interface DirectSynapseGene { src: number; dst: number; w: number; flags: number; plasticity: number; ext?: Uint8Array }
export interface RawSection { tag: number; recordSize: number; sectionFlags: number; count: number; bytes: Uint8Array }

export interface Genome {
  formatVersion: number;
  flags: number;
  rootModuleInnov: number;
  /** Trait q values; at least TRAIT_COUNT entries (longer arrays keep newer traits). */
  traits: Uint16Array;
  immuneKey: number;
  surfaceSig: number;
  modules: ModuleGene[];
  links: LinkGene[];
  regs: RegGene[];
  brainTraits: Uint16Array;
  cppnNodes: CppnNodeGene[];
  cppnConns: CppnConnGene[];
  hiddenNeurons: HiddenNeuronGene[];
  directSynapses: DirectSynapseGene[];
  /** Unknown sections, kept verbatim (forward compatibility). */
  unknown: RawSection[];
}

// ---------------- Phenotype (CONTRACT 7) ----------------
export interface MouthDescriptor {
  filter: number; scrape: number; bite: number; suction: number; latch: number;
  gape: number; biteForce: number; mesh: number;
}
export type OrganKind =
  | 'eye' | 'chemo' | 'photophore' | 'cilia' | 'jet' | 'bladder' | 'gland' | 'claw' | 'mouth'
  | 'lateral' | 'touch' | 'gut' | 'head';
export interface OrganSpec { kind: OrganKind; part: number; u: number; v: number; d: number; params: number[] }

export interface Phenotype {
  nParts: number;
  parent: Int16Array; kind: Uint8Array; subtype: Uint8Array; moduleInnov: Uint32Array; pathHash: Uint32Array;
  dv: Int8Array; organs: Uint16Array;
  attachU: Float32Array; restAngle: Float32Array; limitLo: Float32Array; limitHi: Float32Array;
  length: Float32Array; radius: Float32Array; span: Float32Array; taper: Float32Array;
  muscleFrac: Float32Array; lipidFrac: Float32Array; armour: Float32Array; youngsE: Float32Array; damping: Float32Array;
  u: Float32Array; v: Float32Array; d: Float32Array;
  cpgPhase: Float32Array; cpgAmp: Float32Array; glow: Float32Array; hue: Float32Array;
  /** nParts x 5, decoded p1..p5. */
  params: Float32Array;
  lengthM: number; adultLengthM: number; maturity: number; massKg: number;
  gutVolume: number; gGut: number; mouth: MouthDescriptor; handlingSize: number; buildCostKg: number;
  organList: OrganSpec[];
}
export interface BirthEnv { depth01: number; tempC: number }
export interface DevelopOptions { maxParts: number; lCeilingM: number; editorPaths?: boolean }

// ---------------- Brain (CONTRACT 8) ----------------
export const INPUT_GLOBAL = [
  'BIAS', 'ENERGY', 'GUT', 'HEALTH', 'PAIN', 'AGE', 'MATURE', 'REPRO_LOAD', 'TEMPERATURE', 'DEPTH',
  'LIGHT', 'SPEED', 'DAY_SIN', 'DAY_COS', 'SEASON_SIN', 'SEASON_COS', 'FATIGUE', 'ITCH',
] as const;
export const INPUT_PART = [
  'EYE', 'LATERAL', 'TOUCH', 'CHEMO_LEVEL', 'CHEMO_RATE', 'TASTE_NUTRITION', 'TASTE_TOXIN', 'HOLDING',
  'PROPRIO', 'GLAND_FULL',
] as const;
export const OUTPUT_GLOBAL = [
  'CPG_FREQ', 'CPG_AMP', 'CPG_TURN', 'MATE', 'LAY_BUD', 'EMIT_INTENSITY', 'EMIT_HUE', 'ROLL',
] as const;
export const OUTPUT_PART = [
  'MUSCLE', 'FIN_PITCH', 'MOUTH_OPEN', 'BITE', 'LATCH', 'PHOTO_INTENSITY', 'CILIA_DRIVE', 'JET_DRIVE',
  'BLADDER_DRIVE', 'GLAND_RELEASE', 'GRIP',
] as const;
/** Channel kind code: global kinds are their index; part kinds are 64 + index. */
export const PART_KIND_BASE = 64;
export const NEURON_KIND = {
  MOTOR: 0, DRIVE: 1, MODULATOR: 2, OSCILLATOR: 3, HIDDEN_HEAD: 4, HIDDEN_GANGLION: 5, HIDDEN_DIRECT: 6,
} as const;

export interface IOChannel { kind: number; part: number; slot: number; key: number }
export interface BrainLayout {
  inputs: IOChannel[];
  outputs: IOChannel[];
  nNeurons: number;
  neuronKind: Uint8Array;
  neuronKey: Uint32Array;
  sizeClass: 0 | 1 | 2 | 3 | 4;
}

// ---------------- Ledger ----------------
export interface LedgerAudit {
  ok: boolean;
  totalQ: number;
  expectedQ: number;
  pools: Record<string, number>;
}

// ---------------- World config ----------------
export interface WorldConfig {
  preset: PresetName;
  seedLo: number;
  seedHi: number;
  backend: 'cpu';
  /** Agent capacity; defaults to the preset's CPU-backend cap. */
  agentCap?: number;
  maxParts?: number;
  /** Overrides of the preset (tuning, tests). */
  mTargetKg?: number;
  lCeilingM?: number;
  dayS?: number;
  yearDays?: number;
  /** Phase-0 skeleton: number of passive motes to seed. */
  skeletonMotes?: number;
}

// ---------------- Events (CONTRACT 11) ----------------
export type Id = number;
export type V2 = [number, number];
export interface EventBase { k: string; t: number; eid: number; epoch: number }
export type DeathCause = 'predation' | 'starvation' | 'age' | 'disease' | 'parasite' | 'disaster' | 'hypoxia';
export type Phase3 = 'start' | 'update' | 'end';
export type SimEvent = EventBase & (
  | { k: 'birth'; id: Id; parents: Id[]; species: number; pos: V2; size: number; mode: 'bud' | 'sex' }
  | { k: 'death'; id: Id; species: number; pos: V2; size: number; cause: DeathCause; killer?: Id }
  | { k: 'bite'; attacker: Id; target: Id; pos: V2; dmg: number }
  | { k: 'mate'; a: Id; b: Id; pos: V2 }
  | { k: 'infect'; host: Id; strain: number; pos: V2 }
  | { k: 'speciation'; parent: number; child: number; founders: Id[]; pos: V2 }
  | { k: 'extinction'; species: number; lastId: Id; pos: V2 }
  | { k: 'god'; cmdId: string; power: PowerId; author: 'god' | 'nature'; tFire: number; pos: V2; radius: number; strength: number; major: boolean }
  | { k: 'release'; cmdId: string; species: number; count: number; pos: V2; leviathan: boolean }
  | { k: 'reseed'; reason: 'extinction' | 'diversity' | 'immigration'; species: number[] }
  | { k: 'hunt'; phase: Phase3; pred: Id; prey: Id; pos: V2; outcome?: 'kill' | 'escape' }
  | { k: 'school'; phase: Phase3; species: number; n: number; centroid: V2; radius: number; polarisation: number; sample: Id[] }
  | { k: 'giant'; id: Id; species: number; size: number; percentile: number }
  | { k: 'record'; kind: 'size' | 'age' | 'speed' | 'depth' | 'generation' | 'offspring'; id: Id; value: number; prev: number }
  | { k: 'endangered'; species: number; remaining: number; ids: Id[] }
  | { k: 'outbreak'; phase: Phase3; strain: number; host: number; prevalence: number; growth: number; centroid: V2; radius: number }
  | { k: 'massDeath'; centroid: V2; radius: number; deaths: number; z: number }
  | { k: 'carcass'; id: Id; size: number; pos: V2; scavengers: number }
  | { k: 'frenzy'; carcass: Id; n: number; pos: V2 }
  | { k: 'epidemicFront'; species: number; strain: number; pos: V2; radius: number }
  | { k: 'migration'; species: number; direction: 'up' | 'down'; fraction: number }
  | { k: 'bloomFront'; pos: V2; radius: number; strength: number }
  | { k: 'newRole'; species: number; role: string; trophic: number }
  | { k: 'novelty'; id: Id; species: number; morphCluster: number; distance: number }
);
export type SimEventKind = SimEvent['k'];
/** Director base interest scores (04 §4.9), seeded into the director's weights. */
export const BASE_INTEREST: Partial<Record<SimEventKind | 'kill' | 'swarm', number>> = {
  hunt: 0.4, kill: 0.6, birth: 0.4, speciation: 0.8, newRole: 0.9, extinction: 0.7, massDeath: 0.8,
  swarm: 0.5, school: 0.5, giant: 0.6, god: 1.0, frenzy: 0.7, epidemicFront: 0.6, migration: 0.4,
  bloomFront: 0.3, outbreak: 0.6, carcass: 0.5, novelty: 0.5, record: 0.5, endangered: 0.5,
};

export interface EventSink { emit(ev: Omit<SimEvent, 'eid' | 'epoch' | 't'> & { k: SimEventKind }): void }

// ---------------- God commands (CONTRACT 13) ----------------
export const POWER_IDS = [
  'bloom', 'marineSnow', 'vent', 'coldSnap', 'heatwave', 'plague', 'meteor', 'currentShift', 'longNight',
  'mutagen', 'toxinLeak', 'cull', 'bless', 'nutrientFlood', 'iceAge', 'predatorFlood', 'storm', 'whaleFall',
  'riftBarrier', 'deadZone', 'earthquake', 'seasons',
] as const;
export type PowerId = (typeof POWER_IDS)[number];
export const CORE_POWERS: readonly PowerId[] = [
  'bloom', 'vent', 'coldSnap', 'heatwave', 'plague', 'meteor', 'currentShift', 'longNight', 'mutagen',
  'cull', 'bless', 'nutrientFlood',
];
export const NATURE_POWERS: readonly PowerId[] = ['coldSnap', 'heatwave', 'currentShift', 'storm', 'bloom'];
export const NATURE_MAX_MAGNITUDE = 0.4;

/** Whether a cast is a major power (hold to confirm, automatic snapshot, 3 s lead). */
export function isMajorPower(power: PowerId, intensity: number): boolean {
  switch (power) {
    case 'plague': case 'meteor': case 'cull': case 'iceAge': case 'predatorFlood':
    case 'riftBarrier': case 'earthquake':
      return true;
    case 'coldSnap': case 'heatwave': case 'nutrientFlood': return intensity > 0.5;
    case 'longNight': return intensity > 0.7;
    case 'toxinLeak': return intensity > 0.3;
    default: return false;
  }
}

export type Target =
  | { kind: 'global' }
  | { kind: 'point'; pos: V2 }
  | { kind: 'circle'; pos: V2; radius: number }
  | { kind: 'depthBand'; y0: number; y1: number }
  | { kind: 'stroke'; points: V2[] }
  | { kind: 'species'; species: number[] }
  | { kind: 'creature'; entity: Id };

export type Speed = 0 | 0.25 | 1 | 4 | 16 | 'max';
export interface CommandBase { id: string; epoch: number }
export type GodCommand = CommandBase & (
  | { t: 'cast'; power: PowerId; target: Target; intensity: number; duration?: number; seed: number }
  | { t: 'release'; ptkg?: Uint8Array; libraryId?: string; pos: V2; count: number; asLeviathan: boolean; founderProtection: boolean }
  | { t: 'speed'; speed: Speed; until?: { tick?: number; wallIso?: string }; unattended?: boolean }
  | { t: 'select'; entity: Id; pin: boolean }
  | { t: 'snapshot'; label: string }
  | { t: 'rewind'; snapshotId: string }
  | { t: 'bookmark'; label: string; pos: V2; zoom: number }
  | { t: 'setting'; key: string; value: number | string | boolean }
);
export interface CommandResult { id: string; ok: boolean; reason?: string; eventId?: number; fireTick?: number; snapshotId?: string }

export interface GodEventScheduled {
  cmdId: string; power: PowerId; target: Target; intensity: number; duration: number; seed: number;
  issuedTick: number; fireTick: number; author: 'god' | 'nature';
  envelope: { attack: number; sustain: number; release: number };
}

// ---------------- View modes (CONTRACT 15) ----------------
export type ViewMode = 'wallpaper' | 'screensaver' | 'tv' | 'god';
export interface ViewProfile {
  mode: ViewMode;
  fpsCap: number;
  captions: null | { holdS: number; minGapS: number };
  audioDefault: boolean;
  camera: 'idleDrift' | 'director' | 'user';
  emissionSlewS: number;
  maxPulseHz: number;
  maxRedPulseHz: number;
  maxLumaChangePerS: number;
  dayNightRange: number;
  gentleGodVisuals: boolean;
  scope: 'view' | 'god';
}
export const VIEW_PROFILES: Readonly<Record<ViewMode, ViewProfile>> = {
  wallpaper: {
    mode: 'wallpaper', fpsCap: 30, captions: null, audioDefault: false, camera: 'idleDrift',
    emissionSlewS: 0.3, maxPulseHz: 1, maxRedPulseHz: 0.5, maxLumaChangePerS: 0.1, dayNightRange: 0.4,
    gentleGodVisuals: true, scope: 'view',
  },
  screensaver: {
    mode: 'screensaver', fpsCap: 60, captions: { holdS: 5, minGapS: 45 }, audioDefault: false, camera: 'director',
    emissionSlewS: 0.15, maxPulseHz: 2, maxRedPulseHz: 0.5, maxLumaChangePerS: 0.25, dayNightRange: 1,
    gentleGodVisuals: false, scope: 'view',
  },
  tv: {
    mode: 'tv', fpsCap: 30, captions: { holdS: 6, minGapS: 25 }, audioDefault: true, camera: 'director',
    emissionSlewS: 0.15, maxPulseHz: 2, maxRedPulseHz: 0.5, maxLumaChangePerS: 0.25, dayNightRange: 1,
    gentleGodVisuals: false, scope: 'view',
  },
  god: {
    mode: 'god', fpsCap: 0, captions: null, audioDefault: false, camera: 'user',
    emissionSlewS: 0.1, maxPulseHz: 2, maxRedPulseHz: 0.5, maxLumaChangePerS: 0.25, dayNightRange: 1,
    gentleGodVisuals: false, scope: 'god',
  },
};
