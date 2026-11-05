/** The WGSL software binary64 (src/gpu/wgsl/f64.ts) against JS doubles, bit for bit. */
import { describe, expect, it } from 'vitest';
import { RngStreams } from '../src/core/index.js';
import { BU, bindAll, computePipeline, dispatch, readBuffer } from '../src/gpu/device.js';
import { F64_TEST_WGSL } from '../src/gpu/wgsl/f64.js';
import { gpuContext } from './gpu-helpers.js';

const gpu = await gpuContext();

describe.skipIf(!gpu)('software f64 on the GPU', () => {
  it('multiply, add and floor match IEEE binary64 round-to-nearest-even', async () => {
    const r = new RngStreams(17, 4).stream(3); const b = new Uint32Array(4);
    const n = 1 << 16;
    const a = new Float64Array(n); const c = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      r.block(0, i, 0, b);
      const u = b[0]! / 4294967296; const v = b[1]! / 4294967296;
      const kind = i % 4;
      if (kind === 0) { a[i] = Math.floor(u * 2 ** (b[2]! % 53)); c[i] = v * 0.8; } // quanta x fraction
      else if (kind === 1) { a[i] = u * 2 ** ((b[2]! % 80) - 40); c[i] = v * 2 ** ((b[3]! % 80) - 40); } // wide exponents
      else if (kind === 2) { a[i] = (b[2]! >>> 8) / 16777216; c[i] = 0.6180339887498949; } // dither + golden
      else { a[i] = Math.floor(u * 2 ** 40) + 0.5; c[i] = 2 ** -((b[3]! % 30)); } // halfway cases for floor and add
    }
    const inp = new Uint32Array(n * 4);
    const ab = new Uint32Array(a.buffer); const cb = new Uint32Array(c.buffer);
    for (let i = 0; i < n; i++) { inp[i * 4] = ab[i * 2]!; inp[i * 4 + 1] = ab[i * 2 + 1]!; inp[i * 4 + 2] = cb[i * 2]!; inp[i * 4 + 3] = cb[i * 2 + 1]!; }
    const d = gpu!.device;
    const pipe = await computePipeline(d, F64_TEST_WGSL, 'f64_test');
    const ib = d.createBuffer({ size: n * 16, usage: BU.STORAGE | BU.COPY_DST }); d.queue.writeBuffer(ib, 0, inp);
    const ob = d.createBuffer({ size: n * 16, usage: BU.STORAGE | BU.COPY_SRC });
    const fb = d.createBuffer({ size: n * 8, usage: BU.STORAGE | BU.COPY_SRC });
    dispatch(d, pipe, bindAll(d, pipe, [ib, ob, fb]), n / 64);
    const out = new Uint32Array(await readBuffer(d, ob, n * 16)); const fl = new Uint32Array(await readBuffer(d, fb, n * 8));
    const ref = new Float64Array(2); const rb = new Uint32Array(ref.buffer);
    let bad = 0;
    for (let i = 0; i < n; i++) {
      ref[0] = a[i]! * c[i]!; ref[1] = a[i]! + c[i]!;
      if (out[i * 4] !== rb[0] || out[i * 4 + 1] !== rb[1] || out[i * 4 + 2] !== rb[2] || out[i * 4 + 3] !== rb[3]) bad++;
      const f = Math.floor(a[i]!);
      if (fl[i * 2]! + fl[i * 2 + 1]! * 4294967296 !== f) bad++;
    }
    expect(bad).toBe(0);
  });
});
