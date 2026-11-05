/** GPU field transport against src/ecosystem/transport.ts: integer fields exactly, f32 fields in a band. */
import { describe, expect, it } from 'vitest';
import { RngStreams } from '../src/core/index.js';
import { prepare, transportF, transportQ, type Grid, type TransportOpts } from '../src/ecosystem/transport.js';
import { GpuTransport } from '../src/gpu/transport.js';
import { gpuContext } from './gpu-helpers.js';

const gpu = await gpuContext();

/** A w x h grid with rock, random face fluxes, depth-varying kz and seeded quanta from 0 to ~1e13. */
function grid(w: number, h: number, seed: number, strength = 1): { g: Grid; o: TransportOpts; q: Float64Array; s: Float32Array } {
  const r = new RngStreams(seed, 3).stream(2); const b = new Uint32Array(4);
  const u = (i: number, k: number): number => { r.block(0, i, k, b); return b[0]! / 4294967296; };
  const wet = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) wet[i] = u(i, 0) < 0.08 || i >= w * (h - 1) && u(i, 1) < 0.5 ? 0 : 1;
  const uFace = new Float64Array((w + 1) * h); const vFace = new Float64Array(w * (h + 1));
  for (let i = 0; i < uFace.length; i++) uFace[i] = (u(i, 2) - 0.5) * 0.02 * strength;
  for (let i = 0; i < vFace.length; i++) vFace[i] = (u(i, 3) - 0.5) * 0.02 * strength;
  const kz = new Float64Array(h + 1); for (let i = 0; i <= h; i++) kz[i] = 1e-4 * (1 + i / h);
  const q = new Float64Array(w * h); const s = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!wet[i]) continue;
    const e = Math.floor(u(i, 4) * 13);
    q[i] = Math.floor(u(i, 5) * 10 ** e);
    s[i] = u(i, 6);
  }
  return { g: { w, h, cs: 0.25, wet, uFace, vFace }, o: { dt: 0.5, kh: 2e-3, kz, ws: 1e-3 }, q, s };
}

const sum = (a: Float64Array): number => a.reduce((x, y) => x + y, 0);

describe.skipIf(!gpu)('gpu field transport vs cpu', () => {
  it('transportQ is bit-identical, conserves mass and settles the same quanta', async () => {
    const gt = await new GpuTransport(gpu!).init();
    for (const [w, h, seed, strength] of [[128, 72, 1, 1], [256, 144, 2, 6], [64, 36, 3, 40]] as const) {
      const A = grid(w, h, seed, strength); const B = grid(w, h, seed, strength);
      const rng = new RngStreams(0x5eed1234, 0xbeef);
      const settleA = new Float64Array(w * h); const settleB = new Float64Array(w * h);
      const oA: TransportOpts = { ...A.o, settle: (i, m) => { settleA[i] = settleA[i]! + m; } };
      const pA = prepare(A.g, oA);
      const total0 = sum(A.q);
      transportQ(A.g, A.q, oA, rng, 4242, 11, pA);
      await gt.transportQ(B.g, B.q, rng, 4242, 11, pA, (i, m) => { settleB[i] = settleB[i]! + m; });
      let diff = 0;
      for (let i = 0; i < w * h; i++) if (A.q[i] !== B.q[i]) diff++;
      console.log(`transportQ ${w}x${h} sub ${pA.sub}: ${diff} cells differ, total ${total0}, settled ${sum(settleB)}`);
      expect(diff).toBe(0);
      expect(Array.from(settleB)).toEqual(Array.from(settleA));
      expect(sum(B.q) + sum(settleB)).toBe(total0);
      // without a settle sink the floor outflow stays put
      const C = grid(w, h, seed + 10, strength); const D = grid(w, h, seed + 10, strength);
      const pC = prepare(C.g, C.o);
      transportQ(C.g, C.q, C.o, rng, 7, 10, pC);
      await gt.transportQ(D.g, D.q, rng, 7, 10, pC);
      expect(Array.from(D.q)).toEqual(Array.from(C.q));
    }
  });

  it('transportF agrees within the f32 band', async () => {
    const gt = await new GpuTransport(gpu!).init();
    const A = grid(128, 72, 5, 6); const B = grid(128, 72, 5, 6);
    const p = prepare(A.g, A.o);
    transportF(A.g, A.s, A.o, p);
    await gt.transportF(B.g, B.s, p);
    let e = 0; let m = 0;
    for (let i = 0; i < A.s.length; i++) { e = Math.max(e, Math.abs(A.s[i]! - B.s[i]!)); m = Math.max(m, Math.abs(A.s[i]!)); }
    console.log('transportF max abs err', e, 'field max', m, 'sub', p.sub);
    expect(e).toBeLessThan(1e-6 * Math.max(1, m) * p.sub);
  });
});
