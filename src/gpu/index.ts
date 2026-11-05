/**
 * src/gpu: the WebGPU compute backend (Dawn on Node in the host, `navigator.gpu` in a browser)
 * behind the same interfaces as the CPU backend, and the backend selector. See
 * docs/modules/gpu.md and docs/spikes/gpu-1.md.
 *
 * Kernels: the full-tier physics integrator (physics.ts), the spatial hash (hash.ts), the brain
 * tick (brain.ts), field transport (transport.ts). Integer state stays integer: the hash, the
 * Philox draws and the quanta transport are bit-identical to the CPU; float physics and brains
 * are f32 and agree within the bands in docs/modules/gpu.md §3.
 */
import type { StepContext, World } from '../core/index.js';
import { createPhysics, type PhysicsOptions } from '../physics/index.js';
import { brain } from '../brain/index.js';
import { acquireGpu, type AcquireOptions, type GpuContext } from './device.js';
import { createGpuPhysics, gpuSupports, type AsyncPhysicsModule } from './physics.js';
import { GpuBrain } from './brain.js';
import { GpuTransport } from './transport.js';

export { acquireGpu, type GpuContext, type AcquireOptions } from './device.js';
export { GpuPhysicsEngine, createGpuPhysics, type AsyncPhysicsModule } from './physics.js';
export { GpuHash, GpuScan } from './hash.js';
export { GpuBrain } from './brain.js';
export { GpuTransport } from './transport.js';

/** The async sim backend the host drives each tick (contract request G1). */
export interface SimBackend {
  readonly kind: 'gpu' | 'cpu';
  /** Why this backend was chosen (for the host log and the god window). */
  readonly reason: string;
  readonly gpu: GpuContext | null;
  readonly physics: AsyncPhysicsModule;
  think(world: World, ctx: StepContext): Promise<void>;
  /** The transport kernels, or null on the CPU backend (the ecosystem's own functions apply). */
  readonly transport: GpuTransport | null;
}

export interface SelectOptions extends AcquireOptions {
  /** 'auto' (default): GPU when an adapter exists, else CPU. 'cpu' forces the CPU backend. */
  prefer?: 'auto' | 'gpu' | 'cpu';
  physics?: Partial<PhysicsOptions>;
}

/** The CPU backend with the async shape (resolved promises around src/physics and src/brain). */
export function cpuBackend(reason: string, over: Partial<PhysicsOptions> = {}): SimBackend {
  const p = createPhysics(over);
  return {
    kind: 'cpu', reason, gpu: null, transport: null,
    physics: {
      kind: 'cpu',
      loadBody: (w, s, ph) => p.loadBody(w, s, ph),
      restage: (w, s, ph) => p.restage(w, s, ph),
      step: async (w, ctx) => { p.step(w, ctx); },
    },
    think: async (w, ctx) => { brain.think(w, ctx); },
  };
}

/**
 * Pick the backend: the GPU when an adapter exists and the requested physics options are ones
 * the kernels implement; otherwise the CPU backend, with the reason. Never throws for a missing
 * GPU; `prefer: 'gpu'` only changes the reason text, so CI without an adapter still runs.
 */
export async function selectBackend(opts: SelectOptions = {}): Promise<SimBackend> {
  const over = opts.physics ?? {};
  if (opts.prefer === 'cpu') return cpuBackend('cpu requested', over);
  if (!gpuSupports({ ...createPhysics().opts, ...over })) return cpuBackend('physics options need the CPU solver', over);
  const gpu = await acquireGpu(opts);
  if (!gpu) return cpuBackend(opts.prefer === 'gpu' ? 'gpu requested but no WebGPU adapter: CPU fallback' : 'no WebGPU adapter', over);
  try {
    const physics = await createGpuPhysics(gpu, over);
    const gb = await new GpuBrain(gpu).init();
    const transport = await new GpuTransport(gpu).init();
    const d = gpu.adapterInfo;
    return {
      kind: 'gpu', reason: `WebGPU adapter ${d.description || d.device || d.vendor} (${gpu.source})`, gpu, physics, transport,
      think: (w, ctx) => gb.think(w, ctx),
    };
  } catch (e) {
    gpu.device.destroy();
    return cpuBackend(`gpu pipelines failed (${String((e as Error).message ?? e).slice(0, 200)}): CPU fallback`, over);
  }
}
