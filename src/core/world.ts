/**
 * World-state allocation (CONTRACT 5): pools, brain class pools, field grids and globals.
 * Pure data; the systems that write it live in their modules.
 */
import {
  BRAIN_CLASSES, BRAIN_POOL_SHARE, PRESETS, Q_MASS, SEG_PER_AGENT, type TankPreset,
} from './constants.js';
import { encodeCanonicalGlobals } from './globals.js';
import { xxh64Parts } from './hash.js';
import {
  brainColumns, CREATURE_COLUMNS, FIELD_COLUMNS, SEGMENT_COLUMNS, type FieldGrid,
} from './layout.js';
import { allocPool, liveBytes, type AnyTypedArray, type ColumnSpec, type Pool } from './soa.js';
import type { GodEventScheduled, WorldConfig } from './types.js';

export type CreaturePool = Pool<typeof CREATURE_COLUMNS>;
export type SegmentPool = Pool<typeof SEGMENT_COLUMNS>;
export type BrainPool = Pool<ReturnType<typeof brainColumns>>;

export interface Fields {
  readonly coarse: readonly [number, number];
  readonly fine: readonly [number, number];
  readonly sdfGrid: readonly [number, number];
  readonly floorW: number;
  qN: Float64Array; qD: Float64Array; qP: Float64Array; qBphoto: Float64Array; qBchemo: Float64Array;
  qSed: Float64Array; qCyst: Float64Array;
  o2: Float32Array; sulphur: Float32Array; tAnom: Float32Array; turb: Float32Array; light: Float32Array;
  flowU: Float32Array; flowV: Float32Array; scent: Float32Array; sdf: Float32Array; material: Uint8Array;
}

export interface WorldGlobals {
  tick: number;
  epoch: number;
  seedLo: number;
  seedHi: number;
  nextEntityId: number;
  nextEventId: number;
  preset: TankPreset['name'];
  ySurface: number;
  qReservoir: number;
  mTotalQ: number;
  mTargetQ: number;
  brainDiv: 1 | 2 | 3;
  liveCount: number;
  carcassCount: number;
  eggCount: number;
  modifiers: GodEventScheduled[];
  /** Current flow mode amplitudes and their OU state (8 lanes). */
  flowModes: Float64Array;
}

export interface World {
  readonly config: Readonly<WorldConfig>;
  readonly preset: TankPreset;
  /** Agent capacity actually allocated. */
  readonly agentCap: number;
  readonly lCeilingM: number;
  readonly g: WorldGlobals;
  readonly cr: CreaturePool;
  readonly seg: SegmentPool;
  readonly brains: readonly BrainPool[];
  readonly fields: Fields;
}

function gridSize(f: Fields, grid: FieldGrid): number {
  switch (grid) {
    case 'coarse': return f.coarse[0] * f.coarse[1];
    case 'fine': return f.fine[0] * f.fine[1];
    case 'sdf': return f.sdfGrid[0] * f.sdfGrid[1];
    case 'floor': return f.floorW;
  }
}

export function allocFields(p: TankPreset): Fields {
  const base = { coarse: p.coarse, fine: p.fine, sdfGrid: p.sdf, floorW: p.coarse[0] } as Fields;
  const f = base as unknown as Record<string, AnyTypedArray>;
  for (const spec of FIELD_COLUMNS) {
    const n = gridSize(base, spec.grid) * ('lanes' in spec ? spec.lanes : 1);
    f[spec.name] = spec.type === 'f64' ? new Float64Array(n) : spec.type === 'f32' ? new Float32Array(n) : new Uint8Array(n);
  }
  return base;
}

export function allocWorld(config: WorldConfig): World {
  const preset = PRESETS[config.preset];
  const agentCap = config.agentCap ?? preset.cpuAgentCap;
  const cr = allocPool(CREATURE_COLUMNS, agentCap);
  const seg = allocPool(SEGMENT_COLUMNS, agentCap * SEG_PER_AGENT);
  const brains = BRAIN_CLASSES.map((_, c) =>
    allocPool(brainColumns(c), Math.max(16, Math.ceil(agentCap * BRAIN_POOL_SHARE[c]!))));
  const mTargetKg = config.mTargetKg ?? preset.mTargetKg;
  const lCeilingM = config.lCeilingM ?? preset.lCeilingM;
  const g: WorldGlobals = {
    tick: 0, epoch: 0, seedLo: config.seedLo >>> 0, seedHi: config.seedHi >>> 0, nextEntityId: 1, nextEventId: 1,
    preset: preset.name, ySurface: 0, qReservoir: 0, mTotalQ: 0, mTargetQ: Math.round(mTargetKg / Q_MASS),
    brainDiv: 1, liveCount: 0, carcassCount: 0, eggCount: 0, modifiers: [], flowModes: new Float64Array(8),
  };
  return { config, preset, agentCap, lCeilingM, g, cr, seg, brains, fields: allocFields(preset) };
}

/** Lowest free slot of a pool whose FREE marker is life == 0 (creatures) or owner == NONE. */
export function lowestFree(isFree: (slot: number) => boolean, highWater: number, capacity: number): number {
  for (let s = 0; s < highWater; s++) if (isFree(s)) return s;
  return highWater < capacity ? highWater : -1;
}

/**
 * State hash (CONTRACT 4.5): xxh64 chained over the canonical globals, every column of every
 * pool over [0, highWater), and every field grid, in declared order.
 */
export function hashWorld(w: World): bigint {
  let [h, l] = xxh64Parts(encodeCanonicalGlobals(w.g));
  const feed = (bytes: Uint8Array): void => { [h, l] = xxh64Parts(bytes, h, l); };
  const pools: Pool<readonly ColumnSpec[]>[] = [w.cr, w.seg, ...w.brains];
  for (const p of pools) for (const col of p.spec) feed(liveBytes(p, col.name));
  const f = w.fields as unknown as Record<string, AnyTypedArray>;
  for (const spec of FIELD_COLUMNS) {
    const a = f[spec.name]!;
    feed(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  }
  return (BigInt(h) << 32n) | BigInt(l);
}
