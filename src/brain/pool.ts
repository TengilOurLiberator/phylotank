/**
 * Class pools (CONTRACT 5.3): allocation, writing a developed brain into its slot, freeing, and
 * the per-world brain-side state that is derived from genomes (rebuilt by `allocate` or
 * `rehydrate`, never journalled: see docs/modules/brain.md).
 */
import {
  BRAIN_CLASSES, DT, NONE_U32, T, TRAITS, C_G, FAT_CAPACITY_0, M_REF_1CM, OVERHEAD_FRACTION, Q_MASS, decodeQ,
  exp, mRef, clearSlot, type BrainPool, type ColumnSpec, type Genome, type Phenotype, type Pool, type World,
} from '../core/index.js';
import type { BrainSpec } from './develop.js';
import type { FullLayout } from './layout.js';

/** Derived, per-brain constants that sense and think need but the pool columns do not hold. */
export interface BrainStatic {
  creature: number;
  entityId: number;
  L: FullLayout;
  tau: Float64Array;
  exploration: number;
  sensorNoise: number;
  plastic: boolean;
  rules: Float64Array;
  ruleCh: Uint8Array;
  etaScale: number;
  tauForget: number;
  /** Body constants for internal inputs. */
  tempOpt: number;
  tempTol: number;
  fatCapacity: number;
  clutchCostQ: number;
  gutCapKg: number;
  /** Per motor: destination code (see think.ts) and part. */
  outDest: Uint8Array;
  outPart: Int16Array;
  /** Used synapse slots per neuron (rows are packed from k = 0; the rest is padding). */
  rowLen: Uint8Array;
}

export interface BrainWorldState {
  statics: (BrainStatic | undefined)[][];
  lastDiv: number;
  nanResets: number;
  /** BITE and LATCH commands per segment: the segment column `cmd3` (2 lanes, CONTRACT 5.2). */
  segAux: Float32Array;
}

const states = new WeakMap<World, BrainWorldState>();
export function brainState(world: World): BrainWorldState {
  let s = states.get(world);
  if (!s) {
    s = {
      statics: world.brains.map(() => []), lastDiv: world.g.brainDiv, nanResets: 0,
      segAux: world.seg.c.cmd3,
    };
    states.set(world, s);
  }
  return s;
}

export function alphaOf(tau: number, div: number): number { return 1 - exp((-div * DT) / tau); }

function traitValue(g: Genome, name: string): number {
  const idx = T[name]!;
  const q = idx < g.traits.length ? g.traits[idx]! : undefined;
  const spec = TRAITS[idx]!;
  return q === undefined ? spec.def : decodeQ(q, spec);
}

/** Clutch cost in quanta (CONTRACT 9.6, without the cap fee). */
export function clutchCostQ(g: Genome, adultLengthM: number): number {
  const n = Math.max(1, Math.round(traitValue(g, 'CLUTCH_SIZE')));
  const mo = mRef(adultLengthM * traitValue(g, 'BIRTH_FRACTION'));
  const per = mo * C_G + mo * FAT_CAPACITY_0 + OVERHEAD_FRACTION * mo + 1e-3 * M_REF_1CM;
  return (n * per) / Q_MASS;
}

export const DEST = { GLOBAL: 0, CMD: 1, CMD2: 2, BITE: 3, LATCH: 4 } as const;

/** Lowest free slot of a class pool, or -1. */
export function freeSlot(pool: BrainPool): number {
  const owner = pool.c.owner;
  for (let s = 0; s < pool.highWater; s++) if (owner[s] === NONE_U32) return s;
  return pool.highWater < pool.capacity ? pool.highWater : -1;
}

/** Write a developed brain into slot s of class pool c. */
export function writeBrain(world: World, c: number, s: number, creature: number, spec: BrainSpec, st: BrainStatic): void {
  const pool = world.brains[c]!;
  const { n: N, i: I, k: K } = BRAIN_CLASSES[c]!;
  clearSlot(pool as unknown as Pool<readonly ColumnSpec[]>, s);
  const p = pool.c;
  const L = spec.L;
  const nN = L.nNeurons;
  p.owner[s] = creature;
  p.nIn[s] = L.nIn;
  p.nNeu[s] = nN;
  const bN = s * N;
  const div = world.g.brainDiv;
  for (let i = 0; i < nN; i++) {
    p.theta[bN + i] = spec.theta[i]!;
    p.alpha[bN + i] = alphaOf(spec.tau[i]!, div);
    p.phaseOff[bN + i] = spec.phaseOff[i]!;
    p.nKind[bN + i] = L.neuronKind[i]!;
    for (let q = 0; q < 12; q++) p.osc[(bN + i) * 12 + q] = spec.osc[i * 12 + q]!;
  }
  const bS = s * K * N;
  const plasticCols = p.synDw.length === pool.capacity * K * N;
  for (let i = 0; i < N; i++) {
    const own = L.nIn + i;
    const row = i < nN ? spec.src[i]! : [];
    for (let k = 0; k < K; k++) {
      const at = bS + k * N + i;
      if (k < row.length) {
        p.synSrc[at] = row[k]!;
        p.synW[at] = spec.w[i]![k]!;
        p.synMeta[at] = plasticCols ? spec.meta[i]![k]! : spec.meta[i]![k]! & ~4;
      } else {
        p.synSrc[at] = own;
        p.synW[at] = 0;
        p.synMeta[at] = 0;
      }
    }
  }
  p.fBand[s * 2] = spec.fLow;
  p.fBand[s * 2 + 1] = spec.fHigh;
  void I;
  if (s >= pool.highWater) pool.highWater = s + 1;
  const bs = brainState(world);
  bs.statics[c]![s] = st;
}

export function makeStatic(world: World, creature: number, ph: Phenotype, g: Genome, spec: BrainSpec): BrainStatic {
  const L = spec.L;
  const outDest = new Uint8Array(L.count.motor);
  const outPart = new Int16Array(L.count.motor);
  for (let j = 0; j < L.count.motor; j++) {
    const ch = L.outputs[j]!;
    outPart[j] = ch.part;
    outDest[j] = ch.part < 0 ? DEST.GLOBAL : ch.kind === 64 ? DEST.CMD : ch.kind === 67 ? DEST.BITE : ch.kind === 68 ? DEST.LATCH : DEST.CMD2;
  }
  const cr = world.cr.c;
  const entityId = cr.idLo[creature]! + cr.idHi[creature]! * 4294967296;
  return {
    creature, entityId, L, tau: spec.tau, exploration: spec.tv.exploration, sensorNoise: spec.tv.sensorNoise,
    plastic: spec.nPlastic > 0, rules: spec.tv.rules, ruleCh: spec.tv.ruleCh, etaScale: spec.tv.etaScale,
    tauForget: spec.tv.tauForget,
    tempOpt: traitValue(g, 'TEMP_OPTIMUM'), tempTol: traitValue(g, 'TEMP_TOLERANCE'),
    fatCapacity: traitValue(g, 'FAT_CAPACITY'), clutchCostQ: clutchCostQ(g, ph.adultLengthM || ph.lengthM),
    gutCapKg: Math.max(1e-15, ph.gutVolume * 1060),
    outDest, outPart, rowLen: Uint8Array.from(spec.src.map((r) => r.length)),
  };
}

/** Recompute every brain's leak when the governor changes brainDiv (CONTRACT 8.4). */
export function recomputeAlphas(world: World): void {
  const bs = brainState(world);
  const div = world.g.brainDiv;
  for (let c = 0; c < world.brains.length; c++) {
    const pool = world.brains[c]!;
    const N = BRAIN_CLASSES[c]!.n;
    for (let s = 0; s < pool.highWater; s++) {
      const st = bs.statics[c]![s];
      if (pool.c.owner[s] === NONE_U32 || !st) continue;
      for (let i = 0; i < pool.c.nNeu[s]!; i++) pool.c.alpha[s * N + i] = alphaOf(st.tau[i]!, div);
    }
  }
  bs.lastDiv = div;
}

export function freeBrain(world: World, creature: number): void {
  const cr = world.cr.c;
  const c = cr.brainClass[creature]!;
  const s = cr.brainSlot[creature]!;
  if (c !== 255 && s !== NONE_U32 && world.brains[c]) {
    const pool = world.brains[c]!;
    clearSlot(pool as unknown as Pool<readonly ColumnSpec[]>, s);
    brainState(world).statics[c]![s] = undefined;
  }
  cr.brainSlot[creature] = NONE_U32;
  cr.brainClass[creature] = 255;
  cr.brainW[creature] = 0;
}
