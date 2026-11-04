/**
 * Genome schema v1 (CONTRACT 6): the trait and BrainTraits tables, record field layouts and
 * section tags. The UI generates sliders from these tables (DESIGN R24), the codec reads and
 * writes records from them, and the genome module decodes values with `decodeQ`.
 */
import { exp, log } from './dmath.js';

export type Scale = 'lin' | 'log' | 'int';

export interface TraitSpec {
  readonly idx: number;
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly scale: Scale;
  readonly def: number;
  /** Counted in the species-distance trait term (look-only and neutral markers are not). */
  readonly dist: boolean;
  readonly group: string;
  /** Mutation never changes it (ENCODING). */
  readonly immutable?: boolean;
}

/** Decode a quantised value. `qMax` is 65535 for u16 traits and 255 for u8 module fields. */
export function decodeQ(q: number, s: { min: number; max: number; scale: Scale }, qMax = 65535): number {
  const x = q / qMax;
  if (s.scale === 'log') return s.min * exp(x * log(s.max / s.min));
  const v = s.min + x * (s.max - s.min);
  return s.scale === 'int' ? Math.round(v) : v;
}

/** Encode a value to the nearest quantised step. */
export function encodeQ(v: number, s: { min: number; max: number; scale: Scale }, qMax = 65535): number {
  const c = v < s.min ? s.min : v > s.max ? s.max : v;
  const x = s.scale === 'log' ? log(c / s.min) / log(s.max / s.min) : (c - s.min) / (s.max - s.min);
  return Math.round(x * qMax);
}

function t(idx: number, name: string, min: number, max: number, scale: Scale, def: number, dist: boolean, group: string): TraitSpec {
  return { idx, name, min, max, scale, def, dist, group };
}

export const TRAIT_COUNT = 96;

const traitList: TraitSpec[] = [
  t(0, 'ADULT_LENGTH', 0.0005, 1.0, 'log', 0.02, true, 'Size'),
  t(1, 'BIRTH_FRACTION', 0.04, 0.5, 'log', 0.2, true, 'Life'),
  t(2, 'GROWTH_RATE', 0.2, 5, 'log', 1, true, 'Life'),
  t(3, 'MATURITY_FRACTION', 0.3, 0.95, 'lin', 0.7, true, 'Life'),
  t(4, 'LIFESPAN_MULT', 1.5, 20, 'log', 4, true, 'Life'),
  t(5, 'SENESCENCE', 0, 1, 'lin', 0.5, true, 'Life'),
  t(6, 'CLUTCH_SIZE', 1, 64, 'log', 2, true, 'Life'),
  t(7, 'REPRO_RESERVE', 0.1, 0.9, 'lin', 0.5, true, 'Life'),
  t(8, 'SEX_PROB', 0, 1, 'lin', 0, true, 'Reproduction'),
  t(9, 'MATE_PATIENCE', 0.05, 5, 'log', 0.5, true, 'Reproduction'),
  t(10, 'FAT_CAPACITY', 0.05, 0.5, 'lin', 0.3, true, 'Life'),
  t(11, 'BROOD_INTERVAL', 0.05, 2, 'log', 0.3, true, 'Life'),
  t(12, 'IMMUNE_INVEST', 0, 1, 'lin', 0.2, true, 'Health'),
  t(13, 'O_CRIT', 0.05, 0.6, 'lin', 0.2, true, 'Habitat'),
  t(14, 'SHELL', 0, 1, 'lin', 0, true, 'Body'),
  t(15, 'SESSILE', 0, 1, 'lin', 0, true, 'Body'),
  t(16, 'MU_LOG', -4, -1, 'lin', -2.3, false, 'Mutation'),
  t(17, 'MU_STRUCT_RATIO', 0.02, 1, 'log', 0.2, false, 'Mutation'),
  t(18, 'SIGMA', 0.005, 0.2, 'log', 0.03, false, 'Mutation'),
  t(19, 'MUSCLE_STRENGTH', 1e5, 3e5, 'log', 2e5, true, 'Body'),
  t(20, 'DIET_PLANT', 0, 1, 'lin', 0.7, true, 'Diet'),
  t(21, 'DIET_DETRITUS', 0, 1, 'lin', 0.1, true, 'Diet'),
  t(22, 'TEMP_OPTIMUM', 2, 30, 'lin', 14, true, 'Habitat'),
  t(23, 'TEMP_TOLERANCE', 1, 15, 'log', 6, true, 'Habitat'),
  t(24, 'FAST_FIBRE', 0, 1, 'lin', 0, true, 'Body'),
  t(25, 'TOXICITY', 0, 1, 'lin', 0, true, 'Diet'),
  t(26, 'AEROBIC_SCOPE', 4, 15, 'log', 8, true, 'Body'),
  t(27, 'JOINT_DAMPING', 0.05, 0.5, 'log', 0.15, true, 'Body'),
  t(28, 'BODY_HUE', 0, 1, 'lin', 0.55, false, 'Look'),
  t(29, 'BODY_SAT', 0, 1, 'lin', 0.4, false, 'Look'),
  t(30, 'BODY_LUM', 0, 1, 'lin', 0.4, false, 'Look'),
  t(31, 'TRANSLUCENCY', 0, 1, 'lin', 0.6, false, 'Look'),
  t(32, 'GLOW_HUE', 0, 1, 'lin', 0.5, false, 'Look'),
  t(33, 'GLOW_BASE', 0, 1, 'lin', 0.3, false, 'Look'),
  t(34, 'PULSE_FREQ', 0.05, 4, 'log', 0.3, false, 'Look'),
  t(35, 'PULSE_SHAPE', 0, 1, 'lin', 0.5, false, 'Look'),
  t(36, 'PATTERN_KIND', 0, 1, 'lin', 0, false, 'Look'),
  t(37, 'PATTERN_FREQ', 0, 1, 'lin', 0.5, false, 'Look'),
  t(38, 'PATTERN_CONTRAST', 0, 1, 'lin', 0.2, false, 'Look'),
  t(39, 'TRAIL_LENGTH', 0, 1, 'lin', 0.5, false, 'Look'),
  t(40, 'ODOUR_A', 0, 1, 'lin', 0.5, false, 'hidden'),
  t(41, 'ODOUR_B', 0, 1, 'lin', 0.5, false, 'hidden'),
  t(42, 'ODOUR_C', 0, 1, 'lin', 0.5, false, 'hidden'),
  t(43, 'ODOUR_D', 0, 1, 'lin', 0.5, false, 'hidden'),
  t(44, 'PREF_GLOW_HUE', 0, 1, 'lin', 0.5, false, 'Mating'),
  t(45, 'PREF_HUE_WIDTH', 0.02, 0.5, 'log', 0.15, false, 'Mating'),
  t(46, 'PREF_SIZE_RATIO', 0.5, 2, 'log', 1, false, 'Mating'),
  t(47, 'PREF_PULSE', 0, 1, 'lin', 0.5, false, 'Mating'),
  t(48, 'PREF_ODOUR_WEIGHT', 0, 1, 'lin', 0.5, false, 'Mating'),
  t(49, 'CHOOSINESS', 0, 1, 'lin', 0.3, false, 'Mating'),
  t(50, 'CILIA_SPEED', 0, 1, 'lin', 0.5, true, 'Body'),
  t(51, 'ALARM_EMIT', 0, 1, 'lin', 0.2, true, 'Behaviour'),
  t(64, 'G_SLENDERNESS', 0.5, 2, 'log', 1, true, 'Shape'),
  t(65, 'G_FIN', 0.5, 2, 'log', 1, true, 'Shape'),
  t(66, 'G_EYE', 0.5, 2, 'log', 1, true, 'Shape'),
  t(67, 'G_MOUTH', 0.5, 2, 'log', 1, true, 'Shape'),
  t(68, 'G_SPIKE', 0.5, 2, 'log', 1, true, 'Shape'),
  t(69, 'G_ARMOUR', 0.5, 2, 'log', 1, true, 'Shape'),
  t(70, 'G_TAPER', 0.5, 2, 'log', 1, true, 'Shape'),
  t(71, 'G_STIFFNESS', 0.5, 2, 'log', 1, true, 'Shape'),
  t(72, 'G_PHOTOPHORE', 0.5, 2, 'log', 1, true, 'Shape'),
  t(73, 'G_GUT', 0.5, 2, 'log', 1, true, 'Shape'),
  t(74, 'G_LIMB_LENGTH', 0.5, 2, 'log', 1, true, 'Shape'),
];

/** Trait specs by index; reserved slots are undefined. */
export const TRAITS: readonly (TraitSpec | undefined)[] = (() => {
  const a: (TraitSpec | undefined)[] = new Array(TRAIT_COUNT).fill(undefined);
  for (const s of traitList) a[s.idx] = s;
  return a;
})();

export type TraitName = (typeof traitList)[number]['name'];
/** Trait index by name, e.g. T.ADULT_LENGTH. */
export const T: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(traitList.map((s) => [s.name, s.idx])),
);

// ---------------- BrainTraits ----------------
export const BRAIN_TRAIT_COUNT = 96;
const brainList: TraitSpec[] = [
  { idx: 0, name: 'ENCODING', min: 0, max: 1, scale: 'int', def: 0, dist: false, group: 'Brain', immutable: true },
  t(1, 'HEAD_HIDDEN', 0, 64, 'int', 8, true, 'Brain'),
  t(2, 'HIDDEN_PER_SEGMENT', 0, 8, 'int', 1, true, 'Brain'),
  t(3, 'OSC_PER_SEGMENT', -1, 1, 'lin', 0.5, true, 'Brain'),
  t(4, 'OSC_PER_FIN', -1, 1, 'lin', 0.5, true, 'Brain'),
  t(5, 'F_LOW', 0.1, 6, 'log', 0.5, true, 'Brain'),
  t(6, 'F_HIGH', 0.1, 6, 'log', 3, true, 'Brain'),
  t(7, 'PLASTICITY_ON', -1, 1, 'lin', -0.5, true, 'Brain'),
  t(8, 'ETA_SCALE', 0, 1, 'lin', 0.3, true, 'Brain'),
  t(9, 'TAU_FORGET', 10, 86400, 'log', 600, false, 'Brain'),
  t(10, 'SENSOR_NOISE', 0, 0.1, 'lin', 0.02, false, 'Brain'),
  t(11, 'TAU_SCALE', 0.25, 4, 'log', 1, true, 'Brain'),
  t(12, 'GAIN_VISION', 0.25, 4, 'log', 1, true, 'Senses'),
  t(13, 'GAIN_LATERAL', 0.25, 4, 'log', 1, true, 'Senses'),
  t(14, 'GAIN_CHEMO', 0.25, 4, 'log', 1, true, 'Senses'),
  t(16, 'REFLEX_SWIM', -2, 2, 'lin', 1, true, 'Instinct'),
  t(17, 'REFLEX_STARTLE', -2, 2, 'lin', 1, true, 'Instinct'),
  t(18, 'REFLEX_GRAZE', -2, 2, 'lin', 1, true, 'Instinct'),
  t(19, 'REFLEX_BITE_ON_TASTE', -2, 2, 'lin', 1, true, 'Instinct'),
  t(20, 'REFLEX_AVOID_WALL', -2, 2, 'lin', 1, true, 'Instinct'),
  t(21, 'REFLEX_REPRODUCE', -2, 2, 'lin', 1, true, 'Instinct'),
  t(22, 'REFLEX_HUNGER_SEEKS', -2, 2, 'lin', 1, true, 'Instinct'),
  t(23, 'REFLEX_FEAR_FLEES', -2, 2, 'lin', 1, true, 'Instinct'),
  t(24, 'REFLEX_INNATE_GAIT', -2, 2, 'lin', 1, true, 'Instinct'),
  t(32, 'BOLDNESS', -1, 1, 'lin', 0, true, 'Personality'),
  t(33, 'ACTIVITY', 0, 1, 'lin', 0.5, true, 'Personality'),
  t(34, 'EXPLORATION', 0, 0.3, 'lin', 0.05, true, 'Personality'),
  t(35, 'SOCIALITY', -1, 1, 'lin', 0, true, 'Personality'),
  t(36, 'AGGRESSION', -1, 1, 'lin', 0, true, 'Personality'),
  t(37, 'APPETITE', 0, 1, 'lin', 0.5, true, 'Personality'),
  t(38, 'PATIENCE', 0, 1, 'lin', 0.5, true, 'Personality'),
  t(39, 'CHRONOTYPE', -1, 1, 'lin', 0, true, 'Personality'),
  t(40, 'PREF_DEPTH', 0, 1, 'lin', 0.3, true, 'Personality'),
  t(41, 'RISK_AVERSION', 0, 1, 'lin', 0.5, true, 'Personality'),
  t(42, 'LIGHT_SHOW', 0, 1, 'lin', 0.3, true, 'Personality'),
  t(43, 'INDIVIDUALITY', 0, 0.3, 'lin', 0.05, false, 'Personality'),
];
for (let r = 0; r < 4; r++) {
  'ABCD'.split('').forEach((c, j) => brainList.push(t(48 + r * 4 + j, `RULE${r}_${c}`, -1, 1, 'lin', 0, false, 'Plasticity')));
  brainList.push(t(64 + r, `RULE${r}_CH`, 0, 2, 'int', 2, false, 'Plasticity'));
}
export const DRIVES = ['HUNGER', 'FEAR', 'LIBIDO', 'FATIGUE', 'AGGRESSION', 'SOCIALITY'] as const;
DRIVES.forEach((d, j) => {
  brainList.push(t(68 + j * 3, `DRIVE_${d}_BIAS`, -2, 2, 'lin', 0, true, 'Drives'));
  brainList.push(t(69 + j * 3, `DRIVE_${d}_TAU`, 0.5, 600, 'log', 10, true, 'Drives'));
  brainList.push(t(70 + j * 3, `DRIVE_${d}_GAIN`, 0.25, 4, 'log', 1, true, 'Drives'));
});

export const BRAIN_TRAITS: readonly (TraitSpec | undefined)[] = (() => {
  const a: (TraitSpec | undefined)[] = new Array(BRAIN_TRAIT_COUNT).fill(undefined);
  for (const s of brainList) a[s.idx] = s;
  return a;
})();
export const BT: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(brainList.map((s) => [s.name, s.idx])),
);

/** Default q value for a trait slot (0 for reserved slots). */
export function defaultQ(table: readonly (TraitSpec | undefined)[], idx: number): number {
  const s = table[idx];
  return s ? encodeQ(s.def, s) : 0;
}

// ---------------- Module kinds and subtypes ----------------
export const KIND = {
  SEGMENT: 0, FIN: 1, LIMB: 2, MOUTH: 3, EYE: 4, CHEMO: 5, SPIKE: 6, PHOTOPHORE: 7,
  CILIA: 8, JET: 9, BLADDER: 10, GLAND: 11,
} as const;
export const KIND_COUNT = 12;
export const MOUTH_SUBTYPE = { FILTER: 0, JAWS: 1, RASP: 2, PROBOSCIS: 3, SUCTION: 4 } as const;
export const SEGMENT_SUBTYPE = { TRUNK: 0, HEAD: 1, BELL: 2 } as const;
export const MODULE_FLAG = { ENABLED: 1, ROOT: 2, PAIRED: 4, CLAW: 8 } as const;
export const LINK_FLAG = { ENABLED: 1, TERMINAL_ONLY: 2, PHASE_WAVE: 4 } as const;
export const SYMMETRY = { NONE: 0, MIRROR: 1, RADIAL: 2 } as const;
export const REG_AXIS = { AP: 0, DV: 1, MATURITY: 2, DEPTH_AT_BIRTH: 3 } as const;
export const REG_PARAM_GATE = 254;
export const DSYN_FLAG = { ENABLED: 1, MODULATORY: 2, PER_INSTANCE: 4 } as const;
export const CPPN_FN = { LIN: 0, TANH: 1, SIN: 2, GAUSS: 3, ABS: 4, STEP: 5 } as const;

// ---------------- Record layouts ----------------
export type FieldType = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'u64';
export interface FieldDef {
  readonly name: string;
  readonly off: number;
  readonly type: FieldType;
  /** Decoded range for quantised fields (documentation and UI). */
  readonly range?: { min: number; max: number; scale: Scale };
  readonly def?: number;
}
export interface RecordDef { readonly tag: string; readonly size: number; readonly max: number; readonly fields: readonly FieldDef[] }

const f = (name: string, off: number, type: FieldType, range?: FieldDef['range'], def?: number): FieldDef =>
  ({ name, off, type, ...(range ? { range } : {}), ...(def !== undefined ? { def } : {}) });

export const MODULE_RECORD: RecordDef = {
  tag: 'MODL', size: 32, max: 48, fields: [
    f('innov', 0, 'u32'), f('kind', 4, 'u8'), f('subtype', 5, 'u8'), f('flags', 6, 'u8', undefined, 1),
    f('recursionLimit', 7, 'u8'),
    f('length', 8, 'u16', { min: 0.05, max: 4, scale: 'log' }), f('width', 10, 'u16', { min: 0.05, max: 2, scale: 'log' }),
    f('span', 12, 'u8', { min: 0.5, max: 8, scale: 'log' }), f('taper', 13, 'u8', { min: 0, max: 1, scale: 'lin' }),
    f('stiffness', 14, 'u8', { min: 0.1, max: 10, scale: 'log' }), f('lipidFraction', 15, 'u8', { min: 0, max: 0.6, scale: 'lin' }),
    f('muscleFraction', 16, 'u8', { min: 0, max: 0.8, scale: 'lin' }), f('gutFraction', 17, 'u8', { min: 0, max: 0.7, scale: 'lin' }),
    f('armourCoverage', 18, 'u8', { min: 0, max: 1, scale: 'lin' }), f('hueOffset', 19, 'i8'),
    f('glow', 20, 'u8', { min: 0, max: 1, scale: 'lin' }), f('p1', 21, 'u8'), f('p2', 22, 'u8'),
    f('cpgPhase', 23, 'u8'), f('cpgAmp', 24, 'u8'), f('jointRange', 25, 'u8'), f('jointRest', 26, 'i8'),
    f('allometry', 27, 'u8', undefined, 128), f('p3', 28, 'u8'), f('p4', 29, 'u8'), f('p5', 30, 'u8'),
    f('photoFraction', 31, 'u8'),
  ],
};
export const LINK_RECORD: RecordDef = {
  tag: 'LINK', size: 20, max: 64, fields: [
    f('innov', 0, 'u32'), f('fromInnov', 4, 'u32'), f('toInnov', 8, 'u32'), f('attachPos', 12, 'u8'),
    f('attachAngle', 13, 'i8'), f('repeat', 14, 'u8', undefined, 1), f('symmetry', 15, 'u8'),
    f('childScale', 16, 'u8', { min: 0.25, max: 2, scale: 'log' }), f('repeatScale', 17, 'u8', { min: 0.7, max: 1.3, scale: 'log' }),
    f('flags', 18, 'u8', undefined, 1), f('phaseStep', 19, 'u8'),
  ],
};
export const REG_RECORD: RecordDef = {
  tag: 'REGU', size: 16, max: 32, fields: [
    f('innov', 0, 'u32'), f('targetInnov', 4, 'u32'), f('targetKind', 8, 'u8', undefined, 255), f('axis', 9, 'u8'),
    f('param', 10, 'u8'), f('shape', 11, 'u8'), f('centre', 12, 'u8'), f('width', 13, 'u8'), f('amount', 14, 'i8'),
    f('flags', 15, 'u8', undefined, 1),
  ],
};
export const CPPN_NODE_RECORD: RecordDef = {
  tag: 'CPPN', size: 16, max: 64, fields: [
    f('innov', 0, 'u64'), f('fn', 8, 'u8'), f('flags', 9, 'u8', undefined, 1), f('bias', 10, 'i16'),
  ],
};
export const CPPN_CONN_RECORD: RecordDef = {
  tag: 'CPPC', size: 32, max: 192, fields: [
    f('innov', 0, 'u64'), f('from', 8, 'u64'), f('to', 16, 'u64'), f('w', 24, 'i16'), f('flags', 26, 'u8', undefined, 1),
  ],
};
export const HIDDEN_NEURON_RECORD: RecordDef = {
  tag: 'DNEU', size: 8, max: 64, fields: [
    f('innov', 0, 'u32'), f('tau', 4, 'u8'), f('flags', 5, 'u8', undefined, 1), f('bias', 6, 'i16'),
  ],
};
export const DIRECT_SYNAPSE_RECORD: RecordDef = {
  tag: 'DSYN', size: 12, max: 256, fields: [
    f('src', 0, 'u32'), f('dst', 4, 'u32'), f('w', 8, 'i16'), f('flags', 10, 'u8', undefined, 1), f('plasticity', 11, 'i8'),
  ],
};

/** Section tags in canonical order (CONTRACT 6.2). */
export const SECTION_ORDER = ['TRAT', 'KEYS', 'MODL', 'LINK', 'REGU', 'BTRT', 'CPPN', 'CPPC', 'DNEU', 'DSYN'] as const;
export type SectionTag = (typeof SECTION_ORDER)[number];

/** Encode four ASCII characters as the LE u32 tag. */
export function fourcc(s: string): number {
  return (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;
}
export function fourccToString(n: number): string {
  return String.fromCharCode(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

/** Q4.11 fixed point for weights and biases. */
export function q411ToFloat(q: number): number { return q / 2048; }
export function floatToQ411(v: number): number { return Math.max(-32768, Math.min(32767, Math.round(v * 2048))); }
