/** Canonical encoding of the globals record (CONTRACT 5.6), used by the state hash and GLOB section. */
import { cborDecode, cborEncode, type CborValue } from './cbor.js';
import type { WorldGlobals } from './world.js';

export function encodeCanonicalGlobals(g: WorldGlobals): Uint8Array {
  // Fixed key order: the CBOR encoder preserves insertion order.
  const v: Record<string, CborValue> = {
    tick: g.tick, epoch: g.epoch, seedLo: g.seedLo, seedHi: g.seedHi, nextEntityId: g.nextEntityId,
    nextEventId: g.nextEventId, preset: g.preset, ySurface: g.ySurface, qReservoir: g.qReservoir,
    mTotalQ: g.mTotalQ, mTargetQ: g.mTargetQ, brainDiv: g.brainDiv, liveCount: g.liveCount,
    carcassCount: g.carcassCount, eggCount: g.eggCount,
    modifiers: g.modifiers as unknown as CborValue,
    flowModes: new Uint8Array(g.flowModes.buffer, g.flowModes.byteOffset, g.flowModes.byteLength),
  };
  return cborEncode(v);
}

export function decodeGlobals(bytes: Uint8Array): WorldGlobals {
  const v = cborDecode(bytes, { maxDepth: 16 }) as Record<string, CborValue>;
  const fm = v.flowModes as Uint8Array;
  const flowModes = new Float64Array(8);
  flowModes.set(new Float64Array(fm.slice().buffer, 0, Math.min(8, fm.byteLength / 8)));
  return {
    tick: v.tick as number, epoch: v.epoch as number, seedLo: v.seedLo as number, seedHi: v.seedHi as number,
    nextEntityId: v.nextEntityId as number, nextEventId: v.nextEventId as number,
    preset: v.preset as WorldGlobals['preset'], ySurface: v.ySurface as number, qReservoir: v.qReservoir as number,
    mTotalQ: v.mTotalQ as number, mTargetQ: v.mTargetQ as number, brainDiv: v.brainDiv as 1 | 2 | 3,
    liveCount: v.liveCount as number, carcassCount: v.carcassCount as number, eggCount: v.eggCount as number,
    modifiers: v.modifiers as unknown as WorldGlobals['modifiers'], flowModes,
  };
}
