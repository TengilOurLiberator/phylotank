/**
 * The GPU spatial hash over the segments the physics engine holds (in place, no upload):
 * count, scan, scatter, per-bucket order. The result equals src/physics/contacts.ts
 * `buildHash` exactly (start table and item order), given equal cells (see wgsl/hash.ts).
 */
import { BU, bindAll, computePipeline, dispatch, readBuffer, type GpuContext } from './device.js';
import type { GpuPhysicsEngine } from './physics.js';
import { CRO, SDYN, SST } from './wgsl/physics.js';
import { BUCKET_SORT_WGSL, HASH_SCATTER_WGSL, HASH_WG, hashWgsl } from './wgsl/hash.js';
import { SCAN_ADD_WGSL, SCAN_WG, SCAN_WGSL } from './wgsl/scan.js';

/** Multi-level exclusive scan of a u32 buffer of length n. */
export class GpuScan {
  private block!: GPUComputePipeline;
  private add!: GPUComputePipeline;
  private levels: { n: number; params: GPUBuffer; sums: GPUBuffer; scanned: GPUBuffer }[] = [];
  private n = -1;
  constructor(readonly gpu: GpuContext) {}
  async init(): Promise<this> {
    const d = this.gpu.device;
    this.block = await computePipeline(d, SCAN_WGSL, 'scan_block', 'scan.block');
    this.add = await computePipeline(d, SCAN_ADD_WGSL, 'scan_add', 'scan.add');
    return this;
  }
  private prepare(n: number): void {
    if (n === this.n) return;
    for (const l of this.levels) { l.params.destroy(); l.sums.destroy(); l.scanned.destroy(); }
    this.levels = [];
    const d = this.gpu.device;
    let m = n;
    for (;;) {
      const blocks = Math.ceil(m / SCAN_WG);
      const params = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
      d.queue.writeBuffer(params, 0, new Uint32Array([m, 0, 0, 0]));
      const mk = (k: number): GPUBuffer => d.createBuffer({ size: Math.max(16, k * 4), usage: BU.STORAGE | BU.COPY_DST | BU.COPY_SRC });
      this.levels.push({ n: m, params, sums: mk(blocks), scanned: mk(blocks) });
      if (blocks <= 1) break;
      m = blocks;
    }
    this.n = n;
  }
  /** dst := exclusive scan of src (both length n). */
  encode(enc: GPUCommandEncoder, src: GPUBuffer, dst: GPUBuffer, n: number): void {
    this.prepare(n);
    const d = this.gpu.device;
    // down: scan blocks of each level, collect block sums
    let s = src; let t = dst;
    for (const L of this.levels) {
      dispatch(d, this.block, bindAll(d, this.block, [L.params, s, t, L.sums]), Math.ceil(L.n / SCAN_WG), enc);
      s = L.sums; t = L.scanned;
    }
    // up: add scanned block offsets, coarsest first
    for (let k = this.levels.length - 2; k >= 0; k--) {
      const L = this.levels[k]!;
      const target = k === 0 ? dst : this.levels[k - 1]!.scanned;
      dispatch(d, this.add, bindAll(d, this.add, [L.params, target, L.scanned]), Math.ceil(L.n / SCAN_WG), enc);
    }
  }
}

export interface HashResult {
  /** Bucket start offsets, length T + 1 (CPU `SpatialHash.start` layout). */
  start: Uint32Array;
  /** Item order as compact segment indices (map with the physics packing). */
  sorted: Uint32Array;
  /** Per compact item: cx, cy, level. */
  cell: Int32Array;
  mask: number;
}

export class GpuHash {
  private count!: GPUComputePipeline; private scatter!: GPUComputePipeline; private sort!: GPUComputePipeline;
  private scan!: GpuScan;
  private T = 0; private cap = 0;
  private params!: GPUBuffer; private itemCr!: GPUBuffer; private itemKey!: GPUBuffer; private itemCell!: GPUBuffer;
  private cellCount!: GPUBuffer; private cellStart!: GPUBuffer; private cellFill!: GPUBuffer; private sorted!: GPUBuffer;
  private packedFor: unknown = null;
  constructor(readonly gpu: GpuContext, readonly phys: GpuPhysicsEngine) {}

  async init(): Promise<this> {
    const d = this.gpu.device;
    this.count = await computePipeline(d, hashWgsl({ sdynN: SDYN.N, sstLen: SST.LEN, sstRad: SST.RAD, sdynVx: SDYN.VX, sdynVy: SDYN.VY, sdynW: SDYN.W, croStride: CRO.STRIDE }), 'hash_count', 'hash.count');
    this.scatter = await computePipeline(d, HASH_SCATTER_WGSL, 'hash_scatter', 'hash.scatter');
    this.sort = await computePipeline(d, BUCKET_SORT_WGSL, 'bucket_sort', 'hash.sort');
    this.scan = await new GpuScan(this.gpu).init();
    this.params = d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });
    return this;
  }

  private ensure(nItems: number, T: number): void {
    const d = this.gpu.device;
    const mk = (k: number): GPUBuffer => d.createBuffer({ size: Math.max(16, k), usage: BU.STORAGE | BU.COPY_DST | BU.COPY_SRC });
    if (nItems > this.cap) {
      for (const b of [this.itemCr, this.itemKey, this.itemCell, this.sorted]) b?.destroy();
      this.cap = Math.ceil(nItems * 1.25) + 16;
      this.itemCr = mk(this.cap * 4); this.itemKey = mk(this.cap * 4); this.itemCell = mk(this.cap * 16); this.sorted = mk(this.cap * 4);
      this.packedFor = null;
    }
    if (T !== this.T) {
      for (const b of [this.cellCount, this.cellStart, this.cellFill]) b?.destroy();
      this.T = T;
      this.cellCount = mk(T * 4); this.cellStart = mk(T * 4); this.cellFill = mk(T * 4);
    }
  }

  /** Encode a full build over the engine's current segments. */
  build(dt = 1 / 30, enc?: GPUCommandEncoder): { nItems: number; T: number } {
    const st = this.phys.state;
    if (!st) throw new Error('gpu hash: physics engine holds no state');
    const { bufs, packing } = st;
    const n = packing.nSeg;
    let T = 16;
    while (T < 2 * n) T *= 2;
    this.ensure(n, T);
    const d = this.gpu.device;
    if (this.packedFor !== packing) {
      const own = new Uint32Array(Math.max(4, n));
      for (let q = 0; q < packing.nCr; q++) {
        const b0 = packing.base[q]!; const b1 = q + 1 < packing.nCr ? packing.base[q + 1]! : n;
        own.fill(q, b0, b1);
      }
      d.queue.writeBuffer(this.itemCr, 0, own);
      this.packedFor = packing;
    }
    const pb = new ArrayBuffer(16); const pu = new Uint32Array(pb); const pf = new Float32Array(pb);
    pu[0] = n; pu[1] = T - 1; pu[2] = bufs.segCap; pf[3] = dt;
    d.queue.writeBuffer(this.params, 0, pb);
    const e = enc ?? d.createCommandEncoder();
    e.clearBuffer(this.cellCount, 0, T * 4);
    e.clearBuffer(this.cellFill, 0, T * 4);
    const groups = Math.ceil(n / HASH_WG);
    dispatch(d, this.count, bindAll(d, this.count, [this.params, this.itemCr, bufs.cro, bufs.sdyn, bufs.sst, this.itemKey, this.itemCell, this.cellCount]), groups, e);
    this.scan.encode(e, this.cellCount, this.cellStart, T);
    dispatch(d, this.scatter, bindAll(d, this.scatter, [this.params, this.itemKey, this.cellStart, this.cellFill, this.sorted]), groups, e);
    dispatch(d, this.sort, bindAll(d, this.sort, [this.params, this.cellStart, this.sorted]), Math.ceil(T / HASH_WG), e);
    if (!enc) d.queue.submit([e.finish()]);
    return { nItems: n, T };
  }

  async read(): Promise<HashResult> {
    const st = this.phys.state!;
    const n = st.packing.nSeg; const T = this.T;
    const d = this.gpu.device;
    const [s, so, ce] = await Promise.all([
      readBuffer(d, this.cellStart, T * 4), readBuffer(d, this.sorted, Math.max(4, n * 4)), readBuffer(d, this.itemCell, Math.max(16, n * 16)),
    ]);
    const start = new Uint32Array(T + 1); start.set(new Uint32Array(s)); start[T] = n;
    const c4 = new Int32Array(ce); const cell = new Int32Array(n * 3);
    for (let g = 0; g < n; g++) { cell[g * 3] = c4[g * 4]!; cell[g * 3 + 1] = c4[g * 4 + 1]!; cell[g * 3 + 2] = c4[g * 4 + 2]!; }
    return { start, sorted: new Uint32Array(so).slice(0, n), cell, mask: T - 1 };
  }
}
