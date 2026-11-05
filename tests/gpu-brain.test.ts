/** GPU brain tick and Philox against the CPU (src/brain/think.ts, src/core/rng.ts). */
import { describe, expect, it } from 'vitest';
import { BRAIN_CLASSES, emptyGenome, philox4x32, RngStreams, type World } from '../src/core/index.js';
import { brain, brainState } from '../src/brain/index.js';
import { FISH_INNOV, fishBody, spawnForTest, testCtx, testWorld } from '../src/brain/fixture.js';
import { GpuBrain } from '../src/gpu/brain.js';
import { bindAll, BU, computePipeline, dispatch, readBuffer } from '../src/gpu/device.js';
import { PHILOX_TEST_WGSL } from '../src/gpu/wgsl/philox.js';
import { gpuContext } from './gpu-helpers.js';

const gpu = await gpuContext();

/** n fish of several sizes with randomised weights, biases and couplings, some exploring. */
function brainWorld(n: number): World {
  const world = testWorld(n + 8);
  const r = new RngStreams(99, 1).stream(1); const blk = new Uint32Array(4);
  const bodies = [fishBody({ segments: 3 }), fishBody({ segments: 5, fins: [1], eye: true, chemoMask: 0b10011 }), fishBody({ segments: 8, fins: [1, 4], eye: true, lateral: true, touch: true })];
  for (let i = 0; i < n; i++) {
    const ph = bodies[i % bodies.length]!;
    spawnForTest(world, i, ph, 1 + (i % 40) * 0.7, 1 + Math.floor(i / 40) * 0.6, i + 1);
    const g = emptyGenome(); g.rootModuleInnov = FISH_INNOV.HEAD;
    brain.allocate(world, i, ph, g, testCtx(world, 0));
  }
  const bs = brainState(world);
  for (let c = 0; c < world.brains.length; c++) {
    const p = world.brains[c]!.c; const { n: N, k: K } = BRAIN_CLASSES[c]!;
    for (let s = 0; s < world.brains[c]!.highWater; s++) {
      const st = bs.statics[c]![s];
      if (!st) continue;
      if (s % 3 === 0) st.exploration = 0.2;
      for (let i = 0; i < p.nNeu[s]!; i++) {
        r.block(c, s, i, blk);
        p.theta[s * N + i] = (blk[0]! / 4294967296 - 0.5) * 0.6;
        for (let k = 0; k < st.rowLen[i]!; k++) p.synW[s * K * N + k * N + i] = p.synW[s * K * N + k * N + i]! + ((blk[(k + 1) % 4]! >>> (k % 8)) / 4294967296 - 0.5) * 1.5;
      }
    }
  }
  return world;
}

function maxDiff(a: World, b: World): { o: number; y: number; phase: number; cmd: number; out: number; brains: number } {
  const r = { o: 0, y: 0, phase: 0, cmd: 0, out: 0, brains: 0 };
  for (let c = 0; c < a.brains.length; c++) {
    const pa = a.brains[c]!.c; const pb = b.brains[c]!.c;
    r.brains += a.brains[c]!.highWater;
    for (let q = 0; q < a.brains[c]!.highWater * BRAIN_CLASSES[c]!.n; q++) {
      r.o = Math.max(r.o, Math.abs(pa.o[q]! - pb.o[q]!)); r.y = Math.max(r.y, Math.abs(pa.y[q]! - pb.y[q]!));
      let d = pa.phase[q]! - pb.phase[q]!; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
      r.phase = Math.max(r.phase, Math.abs(d));
    }
  }
  for (let i = 0; i < a.seg.c.cmd.length; i++) r.cmd = Math.max(r.cmd, Math.abs(a.seg.c.cmd[i]! - b.seg.c.cmd[i]!), Math.abs(a.seg.c.cmd2[i]! - b.seg.c.cmd2[i]!));
  for (let i = 0; i < a.cr.c.out.length; i++) r.out = Math.max(r.out, Math.abs(a.cr.c.out[i]! - b.cr.c.out[i]!));
  return r;
}

describe.skipIf(!gpu)('gpu brain and rng vs cpu', () => {
  it('Philox4x32-10 words are identical to src/core/rng for 65,536 counters', async () => {
    const d = gpu!.device;
    const pipe = await computePipeline(d, PHILOX_TEST_WGSL, 'philox_test');
    const n = 65536;
    const params = d.createBuffer({ size: 32, usage: BU.UNIFORM | BU.COPY_DST });
    const key = [0x5eed1234 ^ 5, 0xbeef];
    d.queue.writeBuffer(params, 0, new Uint32Array([n, 123456789, 7, 3, key[0]! >>> 0, key[1]!, 0, 0]));
    const out = d.createBuffer({ size: n * 16, usage: BU.STORAGE | BU.COPY_SRC });
    dispatch(d, pipe, bindAll(d, pipe, [params, out]), n / 64);
    const got = new Uint32Array(await readBuffer(d, out, n * 16));
    const ref = new Uint32Array(4);
    let bad = 0;
    for (let i = 0; i < n; i++) {
      philox4x32(123456789, i, 7, 3, key[0]! >>> 0, key[1]!, ref);
      for (let k = 0; k < 4; k++) if (got[i * 4 + k] !== ref[k]) bad++;
    }
    expect(bad).toBe(0);
  });

  it('one brain tick: outputs, states and phases within the f32 band', async () => {
    const A = brainWorld(300); const B = brainWorld(300);
    const gb = await new GpuBrain(gpu!).init();
    for (const w of [A, B]) brain.sense(w, testCtx(w, 1));
    brain.think(A, testCtx(A, 1));
    await gb.think(B, testCtx(B, 1));
    const e = maxDiff(A, B);
    console.log('brain 1 tick', e, 'gpu ticked', gb.lastGpuTicked);
    expect(gb.lastGpuTicked).toBe(e.brains);
    expect(e.brains).toBeGreaterThan(50);
    expect(e.o).toBeLessThan(1e-5);
    expect(e.cmd).toBeLessThan(1e-5);
  });

  it('60 brain ticks with exploration noise stay inside the band', async () => {
    const A = brainWorld(300); const B = brainWorld(300);
    const gb = await new GpuBrain(gpu!).init();
    let e = maxDiff(A, B);
    for (let t = 1; t <= 60; t++) {
      for (const w of [A, B]) brain.sense(w, testCtx(w, t));
      brain.think(A, testCtx(A, t));
      await gb.think(B, testCtx(B, t));
      e = maxDiff(A, B);
    }
    console.log('brain 60 ticks', e);
    expect(e.o).toBeLessThan(1e-3);
    expect(brainState(B).nanResets).toBe(brainState(A).nanResets);
  });
});
