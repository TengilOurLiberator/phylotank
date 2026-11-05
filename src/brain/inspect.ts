/**
 * Inspector data (DESIGN R34): 10 Hz int8 activations for the whole brain plus up to 8 pinned
 * "scope" neurons as f32. Read-only; the host decides the rates.
 */
import { BRAIN_CLASSES, NONE_U32, type World } from '../core/index.js';
import { brainState } from './pool.js';

export interface InspectFrame {
  cls: number;
  nIn: number;
  nNeu: number;
  /** Inputs then neuron outputs, scaled to int8 (value * 127, clamped). */
  act: Int8Array;
  /** Pinned neuron outputs in f32 (at most 8). */
  scope: Float32Array;
  nanResets: number;
}

export function inspect(world: World, creature: number, pinned: readonly number[] = []): InspectFrame | null {
  const c = world.cr.c.brainClass[creature]!;
  const s = world.cr.c.brainSlot[creature]!;
  if (c === 255 || s === NONE_U32) return null;
  const { n: N, i: I } = BRAIN_CLASSES[c]!;
  const p = world.brains[c]!.c;
  const nIn = p.nIn[s]!, nNeu = p.nNeu[s]!;
  const act = new Int8Array(nIn + nNeu);
  const q = (v: number): number => Math.max(-127, Math.min(127, Math.round(v * 127)));
  for (let i = 0; i < nIn; i++) act[i] = q(p.inputs[s * I + i]!);
  for (let i = 0; i < nNeu; i++) act[nIn + i] = q(p.o[s * N + i]!);
  const scope = new Float32Array(Math.min(8, pinned.length));
  for (let k = 0; k < scope.length; k++) {
    const n = pinned[k]!;
    scope[k] = n >= 0 && n < nNeu ? p.o[s * N + n]! : 0;
  }
  return { cls: c, nIn, nNeu, act, scope, nanResets: brainState(world).nanResets };
}
