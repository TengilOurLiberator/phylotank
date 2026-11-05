/**
 * GPU device management for a future WebGPU backend (05 §5.1.3, spike 2). The CPU backend stays
 * the default; nothing in the sim uses this yet. It encodes what spike 2 measured:
 *
 * - `webgpu` (Dawn) is optional: it is loaded at run time from a directory the user names and is
 *   not a dependency of the repo. Without a Vulkan, D3D12 or Metal driver `requestAdapter()`
 *   returns null and the host stays on the CPU.
 * - A GPUAdapter is consumed by its first `requestDevice()`, so every (re)acquire asks for a new
 *   adapter.
 * - Dawn quantises timestamps to about 65.5 µs unless `timestamp_quantization` is disabled.
 * - On `device.lost` the host recreates the device and resumes from its in-RAM snapshot plus the
 *   journal (05 §5.4.4 step 5); losses caused by our own `destroy()` are not recovered.
 */
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface AdapterInfoLike { vendor?: string; architecture?: string; device?: string; description?: string }
export interface DeviceLostLike { reason: string; message: string }
export interface DeviceLike { readonly lost: Promise<DeviceLostLike>; destroy(): void }
export interface AdapterLike {
  readonly features: ReadonlySet<string>;
  readonly info: AdapterInfoLike;
  requestDevice(desc?: { requiredFeatures?: string[] }): Promise<DeviceLike>;
}
export interface GpuLike { requestAdapter(opts?: { powerPreference?: 'high-performance' | 'low-power' }): Promise<AdapterLike | null> }

/** Dawn instance flags the host wants (spike 2 §3.4). */
export const DAWN_FLAGS: readonly string[] = ['disable-dawn-features=timestamp_quantization'];

/** Load Dawn's Node binding from `dir` (a folder with node_modules/webgpu). Null if absent or unusable. */
export async function loadDawn(dir: string, extraFlags: readonly string[] = []): Promise<GpuLike | null> {
  try {
    const req = createRequire(join(resolve(dir), 'package.json'));
    const mod = (await import(pathToFileURL(req.resolve('webgpu')).href)) as { create(flags: string[]): GpuLike; globals: Record<string, unknown> };
    Object.assign(globalThis, mod.globals);
    return mod.create([...DAWN_FLAGS, ...extraFlags]);
  } catch {
    return null;
  }
}

export interface ManagedDevice { device: DeviceLike; adapter: AdapterInfoLike; timestampQuery: boolean; generation: number }

/** Acquire a device and keep one: recreate it (with a fresh adapter) whenever it is lost. */
export class GpuDeviceManager {
  private current: ManagedDevice | null = null;
  private generation = 0;
  private closing = false;
  losses: DeviceLostLike[] = [];
  /** Recoveries attempted within the last window, to stop a crash loop (05 §5.4.4 step 6). */
  private recent: number[] = [];

  constructor(
    private readonly gpu: GpuLike,
    private readonly onRecovered: (d: ManagedDevice, lost: DeviceLostLike) => void = () => {},
    private readonly now: () => number = () => Date.now(),
    readonly maxLossesPer10Min = 3,
  ) {}

  get device(): ManagedDevice | null { return this.current; }

  async acquire(): Promise<ManagedDevice | null> {
    const adapter = await this.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const ts = adapter.features.has('timestamp-query');
    const device = await adapter.requestDevice({ requiredFeatures: ts ? ['timestamp-query'] : [] });
    const i = adapter.info; // native getters: copy the fields explicitly
    const info: AdapterInfoLike = { vendor: i.vendor ?? '', architecture: i.architecture ?? '', device: i.device ?? '', description: i.description ?? '' };
    const md: ManagedDevice = { device, adapter: info, timestampQuery: ts, generation: ++this.generation };
    this.current = md;
    void device.lost.then((info) => this.handleLost(md, info));
    return md;
  }

  private async handleLost(md: ManagedDevice, info: DeviceLostLike): Promise<void> {
    if (this.current !== md) return;
    this.current = null;
    this.losses.push(info);
    if (this.closing || info.reason === 'destroyed') return;
    const t = this.now();
    this.recent = this.recent.filter((x) => t - x < 600_000);
    this.recent.push(t);
    if (this.recent.length > this.maxLossesPer10Min) return; // give up: the host falls back to the CPU backend
    const next = await this.acquire();
    if (next) this.onRecovered(next, info);
  }

  close(): void {
    this.closing = true;
    this.current?.device.destroy();
    this.current = null;
  }
}
