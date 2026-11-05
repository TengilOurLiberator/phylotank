/**
 * Shared set-up for the GPU tests. The skip guard: when no WebGPU adapter exists (CI without
 * lavapipe, or no `webgpu` package) `gpuContext()` resolves to null and the GPU suites skip.
 *
 * Locally: `PT_WEBGPU` (or the default bench/local/dawn path) names the Dawn Node binding, and
 * `VK_ICD_FILENAMES` plus `LD_LIBRARY_PATH` point at lavapipe (docs/spikes/gpu-1.md).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { acquireGpu, type GpuContext } from '../src/gpu/device.js';

const DEFAULT_DAWN = join(__dirname, '..', 'bench', 'local', 'dawn', 'node_modules', 'webgpu', 'index.js');

let pending: Promise<GpuContext | null> | null = null;

export function gpuContext(): Promise<GpuContext | null> {
  if (!pending) {
    const module = process.env.PT_WEBGPU ?? (existsSync(DEFAULT_DAWN) ? DEFAULT_DAWN : undefined);
    // only try a real adapter when a Vulkan ICD is configured; otherwise Dawn may spend seconds probing
    pending = process.env.PT_GPU === '0' ? Promise.resolve(null) : acquireGpu(module ? { module } : {});
  }
  return pending;
}
