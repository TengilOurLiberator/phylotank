/**
 * Decoded BrainTraits (CONTRACT 6.7) and the body traits the brain needs at development.
 * Pure helpers over the genome's quantised values.
 */
import { BRAIN_TRAITS, BT, DRIVES, T, TRAITS, decodeQ, type Genome } from '../core/index.js';

/** Decoded value of a BrainTraits entry by name (default when the block is short). */
export function bt(g: Genome, name: string): number {
  const idx = BT[name];
  if (idx === undefined) throw new Error(`unknown brain trait ${name}`);
  const spec = BRAIN_TRAITS[idx]!;
  const q = idx < g.brainTraits.length ? g.brainTraits[idx]! : undefined;
  return q === undefined ? spec.def : decodeQ(q, spec);
}

/** Decoded value of a body trait by name. */
export function trait(g: Genome, name: string): number {
  const idx = T[name];
  if (idx === undefined) throw new Error(`unknown trait ${name}`);
  const spec = TRAITS[idx]!;
  const q = idx < g.traits.length ? g.traits[idx]! : undefined;
  return q === undefined ? spec.def : decodeQ(q, spec);
}

export interface DriveParams { bias: number; tau: number; gain: number }

/** All brain traits the developer reads, decoded once per birth. */
export interface BrainTraitValues {
  encoding: number;
  headHidden: number;
  hiddenPerSegment: number;
  oscPerSegment: boolean;
  oscPerFin: boolean;
  fLow: number;
  fHigh: number;
  plasticityOn: boolean;
  etaScale: number;
  tauForget: number;
  sensorNoise: number;
  tauScale: number;
  gainVision: number;
  gainLateral: number;
  gainChemo: number;
  reflex: {
    swim: number; startle: number; graze: number; biteOnTaste: number; avoidWall: number;
    reproduce: number; hungerSeeks: number; fearFlees: number; innateGait: number;
  };
  boldness: number; activity: number; exploration: number; sociality: number; aggression: number;
  appetite: number; patience: number; chronotype: number; prefDepth: number; riskAversion: number;
  lightShow: number; individuality: number;
  /** 4 rules x (A, B, C, D), and the channel (0 m+, 1 m-, 2 constant). */
  rules: Float64Array;
  ruleCh: Uint8Array;
  drives: DriveParams[];
}

export function decodeBrainTraits(g: Genome): BrainTraitValues {
  const rules = new Float64Array(16);
  const ruleCh = new Uint8Array(4);
  for (let r = 0; r < 4; r++) {
    'ABCD'.split('').forEach((c, j) => { rules[r * 4 + j] = bt(g, `RULE${r}_${c}`); });
    ruleCh[r] = Math.max(0, Math.min(2, Math.round(bt(g, `RULE${r}_CH`))));
  }
  let fLow = bt(g, 'F_LOW');
  let fHigh = bt(g, 'F_HIGH');
  if (fHigh < fLow) { const t = fLow; fLow = fHigh; fHigh = t; }
  return {
    encoding: Math.round(bt(g, 'ENCODING')),
    headHidden: Math.max(0, Math.min(64, Math.round(bt(g, 'HEAD_HIDDEN')))),
    hiddenPerSegment: Math.max(0, Math.min(8, Math.round(bt(g, 'HIDDEN_PER_SEGMENT')))),
    oscPerSegment: bt(g, 'OSC_PER_SEGMENT') > 0,
    oscPerFin: bt(g, 'OSC_PER_FIN') > 0,
    fLow, fHigh,
    plasticityOn: bt(g, 'PLASTICITY_ON') > 0,
    etaScale: bt(g, 'ETA_SCALE'),
    tauForget: bt(g, 'TAU_FORGET'),
    sensorNoise: bt(g, 'SENSOR_NOISE'),
    tauScale: bt(g, 'TAU_SCALE'),
    gainVision: bt(g, 'GAIN_VISION'),
    gainLateral: bt(g, 'GAIN_LATERAL'),
    gainChemo: bt(g, 'GAIN_CHEMO'),
    reflex: {
      swim: bt(g, 'REFLEX_SWIM'), startle: bt(g, 'REFLEX_STARTLE'), graze: bt(g, 'REFLEX_GRAZE'),
      biteOnTaste: bt(g, 'REFLEX_BITE_ON_TASTE'), avoidWall: bt(g, 'REFLEX_AVOID_WALL'),
      reproduce: bt(g, 'REFLEX_REPRODUCE'), hungerSeeks: bt(g, 'REFLEX_HUNGER_SEEKS'),
      fearFlees: bt(g, 'REFLEX_FEAR_FLEES'), innateGait: bt(g, 'REFLEX_INNATE_GAIT'),
    },
    boldness: bt(g, 'BOLDNESS'), activity: bt(g, 'ACTIVITY'), exploration: bt(g, 'EXPLORATION'),
    sociality: bt(g, 'SOCIALITY'), aggression: bt(g, 'AGGRESSION'), appetite: bt(g, 'APPETITE'),
    patience: bt(g, 'PATIENCE'), chronotype: bt(g, 'CHRONOTYPE'), prefDepth: bt(g, 'PREF_DEPTH'),
    riskAversion: bt(g, 'RISK_AVERSION'), lightShow: bt(g, 'LIGHT_SHOW'), individuality: bt(g, 'INDIVIDUALITY'),
    rules, ruleCh,
    drives: DRIVES.map((d) => ({ bias: bt(g, `DRIVE_${d}_BIAS`), tau: bt(g, `DRIVE_${d}_TAU`), gain: bt(g, `DRIVE_${d}_GAIN`) })),
  };
}
