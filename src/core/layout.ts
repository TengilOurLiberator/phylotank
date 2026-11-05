/**
 * World-state column layouts (CONTRACT 5). These lists are the contract: names, types, lanes
 * and order. Adding a column is a contract change (append it; never reorder), and the .ptk
 * column sections match columns by name so older files still load.
 */
import type { ColumnSpec } from './soa.js';
import { BRAIN_CLASSES } from './constants.js';

export const NONE_U32 = 0xffffffff;

/** Creature `life` values. */
export const LIFE = { FREE: 0, ALIVE: 1, EGG: 2, CARCASS: 3 } as const;

/** Creature `flags` bits (CF_*). */
export const CF = {
  LEVIATHAN: 1 << 0, SESSILE_ATTACHED: 1 << 1, LATCHED: 1 << 2, MATING: 1 << 3, EATING: 1 << 4,
  HURT: 1 << 5, INFECTED: 1 << 6, JUVENILE: 1 << 7, FOUNDER: 1 << 8, FOUNDER_PROTECTED: 1 << 9,
  BUDDING: 1 << 10, FRAGMENT: 1 << 11, DESIGNED: 1 << 12,
} as const;

/** Organ flag bits (CONTRACT 7.2). */
export const ORGAN = {
  EYE: 1 << 0, CHEMO: 1 << 1, PHOTOPHORE: 1 << 2, CILIA: 1 << 3, JET: 1 << 4, BLADDER: 1 << 5,
  GUT: 1 << 6, GLAND: 1 << 7, CLAW: 1 << 8, MOUTH: 1 << 9, LATERAL_LINE: 1 << 10, TOUCH: 1 << 11,
  PAIRED: 1 << 12, HEAD: 1 << 13, SHELL: 1 << 14, PHOTOSYNTH: 1 << 15,
} as const;

/** Gut lanes in creature column `qGut`. */
export const GUT = { PLANT: 0, MEAT: 1, DETRITUS: 2 } as const;
/** Carry lanes in creature column `carry`. */
export const CARRY = { BURN: 0, INTAKE: 1, GROWTH: 2, EXCRETION: 3 } as const;
/** Diet EMA lanes in creature column `diet`. */
export const DIET = {
  PHYTO: 0, MAT: 1, PLANT_CREATURE: 2, DETRITUS: 3, CARCASS: 4, LIVE_PREY: 5, HOST: 6,
} as const;

export const CREATURE_COLUMNS = [
  { name: 'idLo', type: 'u32' },
  { name: 'idHi', type: 'u32' },
  { name: 'gen', type: 'u16' },
  { name: 'life', type: 'u8' },
  { name: 'flags', type: 'u32' },
  { name: 'species', type: 'u32' },
  { name: 'genome', type: 'u32', init: NONE_U32 },
  { name: 'birthTick', type: 'f64' },
  { name: 'posX', type: 'f64' },
  { name: 'posY', type: 'f64' },
  { name: 'velX', type: 'f32' },
  { name: 'velY', type: 'f32' },
  { name: 'heading', type: 'f32' },
  { name: 'angVel', type: 'f32' },
  { name: 'mirror', type: 'i8', init: 1 },
  { name: 'segStart', type: 'u32', init: NONE_U32 },
  { name: 'segCount', type: 'u16' },
  { name: 'tier', type: 'u8' },
  { name: 'nSub', type: 'u8', init: 4 },
  { name: 'length', type: 'f32' },
  { name: 'adultLength', type: 'f32' },
  { name: 'maturity', type: 'f32' },
  { name: 'stage', type: 'u16' },
  { name: 'massKg', type: 'f32' },
  { name: 'qTissue', type: 'f64' },
  { name: 'qReserve', type: 'f64' },
  { name: 'qRepro', type: 'f64' },
  { name: 'qGut', type: 'f64', lanes: 3 },
  { name: 'carry', type: 'f64', lanes: 4 },
  { name: 'anaerobic', type: 'f32', init: 1 },
  { name: 'health', type: 'f32', init: 1 },
  { name: 'lifespan', type: 'f32' },
  { name: 'tMature', type: 'f32' },
  { name: 'reproTimer', type: 'f32' },
  { name: 'tempC', type: 'f32' },
  { name: 'oxygen', type: 'f32', init: 1 },
  { name: 'powerW', type: 'f32' },
  { name: 'brainW', type: 'f32' },
  { name: 'brainClass', type: 'u8', init: 255 },
  { name: 'brainSlot', type: 'u32', init: NONE_U32 },
  { name: 'out', type: 'f32', lanes: 8 },
  { name: 'infStrain', type: 'u32', lanes: 2, init: NONE_U32 },
  { name: 'infLoad', type: 'f32', lanes: 2 },
  { name: 'immuneKey', type: 'u32' },
  { name: 'surfaceSig', type: 'u32' },
  { name: 'immuneMemory', type: 'u32' },
  { name: 'glow', type: 'f32' },
  { name: 'colour', type: 'u32' },
  { name: 'trophic', type: 'f32', init: 2 },
  { name: 'diet', type: 'f32', lanes: 7 },
  // appended in phase 2 (docs/contract-requests/APPLIED.md: EV2, EV3, P1)
  { name: 'generation', type: 'u32' },
  { name: 'workJ', type: 'f32' },
  { name: 'biteCooldown', type: 'f32' },
  { name: 'wdE0', type: 'f64', init: -1 },
  { name: 'wdIn', type: 'f64' },
  { name: 'wdTicks', type: 'u16' },
] as const satisfies readonly ColumnSpec[];

export const SEGMENT_COLUMNS = [
  { name: 'owner', type: 'u32', init: NONE_U32 },
  { name: 'parent', type: 'i16', init: -1 },
  { name: 'kind', type: 'u8' },
  { name: 'organs', type: 'u16' },
  { name: 'posX', type: 'f64' },
  { name: 'posY', type: 'f64' },
  { name: 'angle', type: 'f32' },
  { name: 'velX', type: 'f32' },
  { name: 'velY', type: 'f32' },
  { name: 'angVel', type: 'f32' },
  { name: 'len', type: 'f32' },
  { name: 'radius', type: 'f32' },
  { name: 'span', type: 'f32' },
  { name: 'mass', type: 'f32' },
  { name: 'inertia', type: 'f32' },
  { name: 'attachU', type: 'f32' },
  { name: 'restAngle', type: 'f32' },
  { name: 'limitLo', type: 'f32' },
  { name: 'limitHi', type: 'f32' },
  { name: 'compliance', type: 'f32' },
  { name: 'damping', type: 'f32' },
  { name: 'tauMax', type: 'f32' },
  { name: 'omegaMax', type: 'f32' },
  { name: 'cmd', type: 'f32' },
  { name: 'act', type: 'f32' },
  { name: 'cmd2', type: 'f32' },
  { name: 'work', type: 'f32' },
  { name: 'touch', type: 'f32' },
  { name: 'damage', type: 'f32' },
  { name: 'drag', type: 'f32', lanes: 5 },
  { name: 'glow', type: 'f32' },
  // appended in phase 2 (docs/contract-requests/APPLIED.md: P1, P2 with B1)
  { name: 'cmd3', type: 'f32', lanes: 2 },
  { name: 'subtype', type: 'u8' },
  { name: 'muscleFrac', type: 'f32', init: 0.3 },
  { name: 'restPrev', type: 'f64' },
  { name: 'restInit', type: 'u8' },
  { name: 'biteArmed', type: 'u8' },
] as const satisfies readonly ColumnSpec[];

/** Column spec for one brain size class pool (CONTRACT 5.3). */
export function brainColumns(cls: number, plastic = true) {
  const { n, i, k } = BRAIN_CLASSES[cls]!;
  return [
    { name: 'owner', type: 'u32', init: NONE_U32 },
    { name: 'nIn', type: 'u16' },
    { name: 'nNeu', type: 'u16' },
    { name: 'inputs', type: 'f32', lanes: i },
    { name: 'y', type: 'f32', lanes: n },
    { name: 'o', type: 'f32', lanes: n },
    { name: 'oPrev', type: 'f32', lanes: n },
    { name: 'theta', type: 'f32', lanes: n },
    { name: 'alpha', type: 'f32', lanes: n },
    { name: 'phase', type: 'f32', lanes: n },
    { name: 'phaseOff', type: 'f32', lanes: n },
    { name: 'nKind', type: 'u8', lanes: n },
    { name: 'synSrc', type: 'u16', lanes: k * n },
    { name: 'synW', type: 'f32', lanes: k * n },
    { name: 'synDw', type: 'f32', lanes: plastic ? k * n : 1 },
    { name: 'synMeta', type: 'u8', lanes: k * n },
    { name: 'osc', type: 'f32', lanes: n * 12 },
    { name: 'fBand', type: 'f32', lanes: 2 },
  ] as const satisfies readonly ColumnSpec[];
}

/** Field grids: name, grid and type (CONTRACT 5.4). */
export type FieldGrid = 'coarse' | 'fine' | 'sdf' | 'floor';
export interface FieldSpec { readonly name: string; readonly grid: FieldGrid; readonly type: 'f64' | 'f32' | 'u8'; readonly lanes?: number }
export const FIELD_COLUMNS = [
  { name: 'qN', grid: 'coarse', type: 'f64' },
  { name: 'qD', grid: 'coarse', type: 'f64' },
  { name: 'qP', grid: 'fine', type: 'f64' },
  { name: 'qBphoto', grid: 'fine', type: 'f64' },
  { name: 'qBchemo', grid: 'fine', type: 'f64' },
  { name: 'qSed', grid: 'floor', type: 'f64' },
  { name: 'qCyst', grid: 'floor', type: 'f64' },
  { name: 'o2', grid: 'coarse', type: 'f32' },
  { name: 'sulphur', grid: 'coarse', type: 'f32' },
  { name: 'tAnom', grid: 'coarse', type: 'f32' },
  { name: 'turb', grid: 'coarse', type: 'f32' },
  { name: 'light', grid: 'coarse', type: 'f32' },
  { name: 'flowU', grid: 'coarse', type: 'f32' },
  { name: 'flowV', grid: 'coarse', type: 'f32' },
  { name: 'scent', grid: 'coarse', type: 'f32', lanes: 8 },
  { name: 'sdf', grid: 'sdf', type: 'f32' },
  { name: 'material', grid: 'sdf', type: 'u8' },
] as const satisfies readonly FieldSpec[];

/** Scent channel lanes. */
export const SCENT = { PLANT: 0, BLOOD: 1, TOXIN: 2, ALARM: 3, PHERO_A: 4, PHERO_B: 5, PHERO_C: 6, PHERO_D: 7 } as const;
/** Terrain material codes. */
export const MATERIAL = { WATER: 0, ROCK: 1, SAND: 2, MUD: 3, REEF: 4, VENT: 5, ICE: 6, CRATER_GLASS: 7 } as const;
