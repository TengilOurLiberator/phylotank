/** The backend selector: CPU fallback without an adapter (always runs), GPU when one exists. */
import { describe, expect, it } from 'vitest';
import { createPhysics } from '../src/physics/index.js';
import { fish, makePhenotype, makeWorld, nextTick, setCmds, spawn } from '../src/physics/testkit.js';
import { cpuBackend, selectBackend } from '../src/gpu/index.js';
import { gpuContext } from './gpu-helpers.js';

const noAdapter = { requestAdapter: async () => null } as unknown as GPU;

describe('backend selector', () => {
  it('falls back to the CPU backend when no adapter exists', async () => {
    const b = await selectBackend({ gpu: noAdapter });
    expect(b.kind).toBe('cpu');
    expect(b.reason).toMatch(/no WebGPU adapter/);
    const forced = await selectBackend({ gpu: noAdapter, prefer: 'gpu' });
    expect(forced.kind).toBe('cpu');
    expect(forced.reason).toMatch(/CPU fallback/);
    expect((await selectBackend({ prefer: 'cpu' })).kind).toBe('cpu');
    expect((await selectBackend({ physics: { solver: 'gs' } })).reason).toMatch(/CPU solver/);
  });

  it('the CPU fallback steps exactly like src/physics', async () => {
    const mk = () => { const tw = makeWorld(); spawn(tw, createPhysics().loadBody, makePhenotype(fish()), 10, 8, 0.4); return tw; };
    const A = mk(); const B = mk();
    const ref = createPhysics();
    const be = cpuBackend('test');
    for (let t = 0; t < 20; t++) {
      for (const tw of [A, B]) setCmds(tw.world, 0, (k) => Math.sin(t * 0.3 - k));
      ref.step(A.world, A.ctx); await be.physics.step(B.world, B.ctx);
      nextTick(A); nextTick(B);
    }
    expect(Array.from(B.world.seg.c.posX.subarray(0, 8))).toEqual(Array.from(A.world.seg.c.posX.subarray(0, 8)));
  });

  it('selects the GPU when an adapter exists', async () => {
    const g = await gpuContext();
    if (!g) return; // skip guard: no adapter here
    const b = await selectBackend({ gpu: g.gpu });
    expect(b.kind).toBe('gpu');
    expect(b.reason).toMatch(/WebGPU adapter/);
  });
});
