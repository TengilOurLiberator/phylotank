import { describe, expect, it } from 'vitest';
import { GpuDeviceManager, loadDawn, type AdapterLike, type DeviceLike, type DeviceLostLike, type GpuLike } from '../src/host/gpu.js';

/** A fake WebGPU with Dawn's "adapter is consumed" rule and controllable device loss. */
function fakeGpu(): { gpu: GpuLike; lose: (reason: string) => void; adapters: number } {
  let loseCurrent: ((i: DeviceLostLike) => void) | null = null;
  const state = { adapters: 0 };
  const gpu: GpuLike = {
    async requestAdapter() {
      state.adapters++;
      let consumed = false;
      const a: AdapterLike = {
        features: new Set(['timestamp-query']), info: { vendor: 'fake', device: `gpu-${state.adapters}` },
        async requestDevice() {
          if (consumed) throw new Error('adapter is "consumed"');
          consumed = true;
          let res!: (i: DeviceLostLike) => void;
          const lost = new Promise<DeviceLostLike>((r) => { res = r; });
          loseCurrent = res;
          const d: DeviceLike = { lost, destroy: () => res({ reason: 'destroyed', message: '' }) };
          return d;
        },
      };
      return a;
    },
  };
  return { gpu, lose: (reason) => loseCurrent?.({ reason, message: 'boom' }), get adapters() { return state.adapters; } };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe('GPU device manager (spike 2 findings)', () => {
  it('recovers a lost device with a fresh adapter, and stops after repeated losses', async () => {
    const f = fakeGpu();
    const recovered: number[] = [];
    let t = 0;
    const m = new GpuDeviceManager(f.gpu, (d) => recovered.push(d.generation), () => t, 2);
    const first = await m.acquire();
    expect(first?.timestampQuery).toBe(true);
    f.lose('unknown'); await tick();
    expect(recovered).toEqual([2]);
    expect(f.adapters).toBe(2);
    t += 1000; f.lose('unknown'); await tick();
    expect(recovered).toEqual([2, 3]);
    t += 1000; f.lose('unknown'); await tick();
    expect(recovered).toEqual([2, 3]); // a third loss in 10 minutes: give up, fall back to the CPU
    expect(m.device).toBeNull();
  });
  it('does not recover from its own destroy()', async () => {
    const f = fakeGpu();
    const m = new GpuDeviceManager(f.gpu);
    await m.acquire();
    m.close(); await tick();
    expect(m.device).toBeNull();
    expect(f.adapters).toBe(1);
  });
  it('returns null when Dawn is not installed', async () => {
    expect(await loadDawn('/nonexistent-dir-for-test')).toBeNull();
  });
});
