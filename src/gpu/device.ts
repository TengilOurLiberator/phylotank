/**
 * Adapter and device acquisition for the WebGPU compute backend, and the backend selector.
 *
 * Sources, in order: an explicit `GPU` object; `navigator.gpu` (browsers, Deno); the Dawn Node
 * binding (the npm `webgpu` package) loaded from `opts.module`, then the `PT_WEBGPU`
 * environment variable (a path to the package's `index.js`), then a bare `import('webgpu')`.
 * The package is not a dependency of the repo (docs/spikes/host-2.md); when none of these
 * yields an adapter, the selector returns the CPU backend.
 *
 * A `GPUAdapter` is consumed by its first `requestDevice()` (host-2 §3.5), so recovery after a
 * device loss always calls `acquireGpu` again.
 */

/** WebGPU usage and map-mode bits (the TS dom lib types the interfaces but not these values). */
export const BU = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128,
  INDIRECT: 256, QUERY_RESOLVE: 512,
} as const;
export const MAP_READ = 1;

export interface GpuContext {
  readonly device: GPUDevice;
  readonly adapterInfo: { vendor: string; architecture: string; device: string; description: string };
  /** Where the GPU object came from. */
  readonly source: 'given' | 'navigator' | 'dawn-node';
  readonly limits: { maxStorageBuffersPerShaderStage: number; maxStorageBufferBindingSize: number; maxComputeWorkgroupsPerDimension: number };
  /** Resolves when the device is lost (reason string). */
  readonly lost: Promise<string>;
  /** The GPU object itself: Dawn tears its instance down when this is collected, so keep it. */
  readonly gpu: GPU;
}

export interface AcquireOptions {
  /** A GPU object to use directly (tests, browsers that hand one in). */
  gpu?: GPU;
  /** Path or module specifier of the Dawn Node binding (`.../node_modules/webgpu/index.js`). */
  module?: string;
  /** Extra Dawn `create()` flags, for example `disable-dawn-features=timestamp_quantization`. */
  dawnFlags?: string[];
  powerPreference?: GPUPowerPreference;
}

interface DawnModule { create(flags: string[]): GPU; globals: Record<string, unknown> }

function envPath(): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env?.PT_WEBGPU;
}

async function loadDawn(spec: string): Promise<DawnModule | null> {
  try {
    const url = spec.startsWith('/') ? `file://${spec}` : spec;
    const mod = (await import(/* @vite-ignore */ url)) as Partial<DawnModule>;
    if (typeof mod.create !== 'function') return null;
    // the binding's globals (GPUBufferUsage and friends) are expected on globalThis by some code
    if (mod.globals) for (const [k, v] of Object.entries(mod.globals)) if (!(k in globalThis)) (globalThis as Record<string, unknown>)[k] = v;
    return mod as DawnModule;
  } catch {
    return null;
  }
}

async function gpuSources(opts: AcquireOptions): Promise<{ gpu: GPU; source: GpuContext['source'] }[]> {
  const out: { gpu: GPU; source: GpuContext['source'] }[] = [];
  if (opts.gpu) out.push({ gpu: opts.gpu, source: 'given' });
  const nav = (globalThis as { navigator?: { gpu?: GPU } }).navigator;
  if (nav?.gpu) out.push({ gpu: nav.gpu, source: 'navigator' });
  const specs = [opts.module, envPath(), 'webgpu'].filter((s): s is string => !!s);
  for (const s of specs) {
    const m = await loadDawn(s);
    if (m) { out.push({ gpu: m.create(opts.dawnFlags ?? []), source: 'dawn-node' }); break; }
  }
  return out;
}

/** Acquire a device, or null when no source yields an adapter. Never throws. */
export async function acquireGpu(opts: AcquireOptions = {}): Promise<GpuContext | null> {
  for (const { gpu, source } of await gpuSources(opts)) {
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: opts.powerPreference ?? 'high-performance' });
      if (!adapter) continue;
      const al = adapter.limits;
      // ask for the adapter's storage limits (R23 still holds: every pipeline here fits 8 per stage)
      const device = await adapter.requestDevice({
        requiredLimits: {
          maxStorageBufferBindingSize: al.maxStorageBufferBindingSize,
          maxBufferSize: al.maxBufferSize,
          maxComputeWorkgroupsPerDimension: al.maxComputeWorkgroupsPerDimension,
        },
      });
      const info = (adapter as { info?: GPUAdapterInfo }).info;
      const lost = device.lost.then((l) => `${l.reason}: ${l.message}`);
      return {
        device, source, lost, gpu,
        adapterInfo: {
          vendor: info?.vendor ?? '', architecture: info?.architecture ?? '', device: info?.device ?? '', description: info?.description ?? '',
        },
        limits: {
          maxStorageBuffersPerShaderStage: device.limits.maxStorageBuffersPerShaderStage,
          maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
          maxComputeWorkgroupsPerDimension: device.limits.maxComputeWorkgroupsPerDimension,
        },
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** Create a storage buffer, optionally initialised from data. */
export function storage(device: GPUDevice, bytes: number, data?: ArrayBufferView, extra = 0): GPUBuffer {
  const size = Math.max(16, Math.ceil(bytes / 16) * 16);
  const b = device.createBuffer({ size, usage: BU.STORAGE | BU.COPY_DST | BU.COPY_SRC | extra });
  if (data) device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, Math.ceil(data.byteLength / 4) * 4);
  return b;
}

/** Read `bytes` from a buffer (copies through a MAP_READ staging buffer). */
export async function readBuffer(device: GPUDevice, src: GPUBuffer, bytes: number, offset = 0): Promise<ArrayBuffer> {
  const size = Math.max(16, Math.ceil(bytes / 4) * 4);
  const st = device.createBuffer({ size, usage: BU.MAP_READ | BU.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(src, offset, st, 0, size);
  device.queue.submit([enc.finish()]);
  await st.mapAsync(MAP_READ);
  const out = st.getMappedRange().slice(0, bytes);
  st.unmap();
  st.destroy();
  return out;
}

export type BindKind = 'uniform' | 'read' | 'rw';

/** An explicit layout, so several entry points of one module can share one bind group. */
export function explicitLayout(device: GPUDevice, kinds: readonly BindKind[]): GPUPipelineLayout {
  const bgl = device.createBindGroupLayout({
    entries: kinds.map((k, binding) => ({
      binding, visibility: 4 /* COMPUTE */,
      buffer: { type: k === 'uniform' ? 'uniform' : k === 'read' ? 'read-only-storage' : 'storage' },
    })),
  });
  return device.createPipelineLayout({ bindGroupLayouts: [bgl] });
}

/** Compile a compute pipeline and fail loudly with the WGSL compiler's messages. */
export async function computePipeline(device: GPUDevice, code: string, entry: string, label = entry, layout?: GPUPipelineLayout): Promise<GPUComputePipeline> {
  const module = device.createShaderModule({ code, label });
  const info = await module.getCompilationInfo();
  const errs = info.messages.filter((m) => m.type === 'error');
  if (errs.length) throw new Error(`WGSL ${label}: ${errs.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
  device.pushErrorScope('validation');
  const p = device.createComputePipeline({ layout: layout ?? 'auto', compute: { module, entryPoint: entry }, label });
  const e = await device.popErrorScope();
  if (e) throw new Error(`pipeline ${label}: ${e.message}`);
  return p;
}

/** Bind buffers 0..n-1 of group 0 in order. */
export function bindAll(device: GPUDevice, pipe: GPUComputePipeline, bufs: GPUBuffer[]): GPUBindGroup {
  return device.createBindGroup({
    layout: pipe.getBindGroupLayout(0),
    entries: bufs.map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
}

export function dispatch(device: GPUDevice, pipe: GPUComputePipeline, bg: GPUBindGroup, groups: number, enc?: GPUCommandEncoder): void {
  const e = enc ?? device.createCommandEncoder();
  const pass = e.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, bg);
  // split large dispatches over y (65,535 groups per dimension by default)
  const gx = Math.min(groups, 65535);
  const gy = Math.ceil(groups / 65535);
  if (groups > 0) pass.dispatchWorkgroups(gx, gy);
  pass.end();
  if (!enc) device.queue.submit([e.finish()]);
}
