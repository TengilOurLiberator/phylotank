/**
 * GPU field transport: `transportQ` (integer quanta, exact against src/ecosystem/transport.ts)
 * and `transportF` (f32 signal fields, within a band). The outflow fractions come from the
 * ecosystem's own `prepare` (computed once per 2 Hz pass on the CPU and shared by every field
 * on that grid), so the GPU reproduces the transport given the same fractions.
 */
import { RNG_STREAM, type RngStreams } from '../core/index.js';
import type { Prepared } from '../ecosystem/transport.js';
import { BU, bindAll, computePipeline, dispatch, explicitLayout, readBuffer, type GpuContext } from './device.js';
import { TRANSPORT_F_WGSL, TR_WG, transportQWgsl } from './wgsl/transport.js';

const TWO32 = 4294967296;
const GOLDEN = 0.6180339887498949;

function f64Bits(x: number): [number, number] {
  const u = new Uint32Array(new Float64Array([x]).buffer);
  return [u[0]!, u[1]!];
}

export class GpuTransport {
  private outflow!: GPUComputePipeline; private apply!: GPUComputePipeline; private tf!: GPUComputePipeline;
  constructor(readonly gpu: GpuContext) {}

  async init(): Promise<this> {
    const d = this.gpu.device;
    const layout = explicitLayout(d, ['uniform', 'read', 'rw', 'rw', 'rw']);
    const code = transportQWgsl(f64Bits(GOLDEN));
    this.outflow = await computePipeline(d, code, 'outflow', 'transport.outflow', layout);
    this.apply = await computePipeline(d, code, 'apply', 'transport.apply', layout);
    this.tf = await computePipeline(d, TRANSPORT_F_WGSL, 'transport_f', 'transport.f');
    return this;
  }

  /**
   * Same contract as `transportQ(g, q, o, rng, tick, tag, prep)`; settling mass is reported per
   * cell through `settle` (summed over the substeps; the CPU's sums are the same integers).
   */
  async transportQ(
    g: { w: number; h: number }, q: Float64Array, rng: RngStreams, tick: number, tag: number, prep: Prepared,
    settle?: (cell: number, q: number) => void,
  ): Promise<void> {
    const d = this.gpu.device; const n = g.w * g.h;
    const mk = (bytes: number): GPUBuffer => d.createBuffer({ size: Math.max(16, Math.ceil(bytes / 16) * 16), usage: BU.STORAGE | BU.COPY_DST | BU.COPY_SRC });
    const qU = new Uint32Array(n * 2);
    for (let i = 0; i < n; i++) { const v = q[i]!; qU[i * 2] = v % TWO32 >>> 0; qU[i * 2 + 1] = Math.floor(v / TWO32) >>> 0; }
    const frB = mk(n * 5 * 8); const qB = mk(n * 8); const outB = mk(n * 5 * 8); const stB = mk(n * 8);
    d.queue.writeBuffer(frB, 0, prep.fr.buffer, prep.fr.byteOffset, n * 5 * 8);
    d.queue.writeBuffer(qB, 0, qU);
    const params = d.createBuffer({ size: 32, usage: BU.UNIFORM | BU.COPY_DST });
    const st = rng.stream(RNG_STREAM.ECOLOGY);
    const bo = bindAll(d, this.outflow, [params, frB, qB, outB, stB]);
    const ba = bindAll(d, this.apply, [params, frB, qB, outB, stB]);
    const groups = Math.ceil(n / TR_WG);
    for (let k = 0; k < prep.sub; k++) {
      // Dither subject 2^52 + (tag * 64 + k) * 2^36 + block: high word 2^20 + (tag * 64 + k) * 16
      d.queue.writeBuffer(params, 0, new Uint32Array([g.w, g.h, tick >>> 0, (1048576 + (tag * 64 + k) * 16) >>> 0, st.k0, st.k1, settle ? 1 : 0, 0]));
      const e = d.createCommandEncoder();
      dispatch(d, this.outflow, bo, groups, e);
      dispatch(d, this.apply, ba, groups, e);
      d.queue.submit([e.finish()]);
    }
    const [qr, sr] = await Promise.all([readBuffer(d, qB, n * 8), readBuffer(d, stB, n * 8)]);
    const qo = new Uint32Array(qr); const so = new Uint32Array(sr);
    for (let i = 0; i < n; i++) q[i] = qo[i * 2]! + qo[i * 2 + 1]! * TWO32;
    if (settle) for (let i = 0; i < n; i++) { const m = so[i * 2]! + so[i * 2 + 1]! * TWO32; if (m > 0) settle(i, m); }
    for (const b of [frB, qB, outB, stB, params]) b.destroy();
  }

  /** Same contract as `transportF(g, q, o, prep, lane, lanes)` for a single-lane f32 field. */
  async transportF(g: { w: number; h: number }, q: Float32Array, prep: Prepared): Promise<void> {
    const d = this.gpu.device; const n = g.w * g.h;
    const mk = (bytes: number): GPUBuffer => d.createBuffer({ size: Math.max(16, Math.ceil(bytes / 16) * 16), usage: BU.STORAGE | BU.COPY_DST | BU.COPY_SRC });
    const frB = mk(n * 5 * 4); const aB = mk(n * 4); const bB = mk(n * 4);
    d.queue.writeBuffer(frB, 0, Float32Array.from(prep.fr.subarray(0, n * 5)));
    d.queue.writeBuffer(aB, 0, q.buffer, q.byteOffset, n * 4);
    const params = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
    d.queue.writeBuffer(params, 0, new Uint32Array([g.w, g.h, 1, 0]));
    const bAB = bindAll(d, this.tf, [params, frB, aB, bB]); const bBA = bindAll(d, this.tf, [params, frB, bB, aB]);
    const e = d.createCommandEncoder();
    for (let k = 0; k < prep.sub; k++) dispatch(d, this.tf, k % 2 === 0 ? bAB : bBA, Math.ceil(n / TR_WG), e);
    d.queue.submit([e.finish()]);
    const out = new Float32Array(await readBuffer(d, prep.sub % 2 === 1 ? bB : aB, n * 4));
    q.set(out.subarray(0, n));
    for (const b of [frB, aB, bB, params]) b.destroy();
  }
}
