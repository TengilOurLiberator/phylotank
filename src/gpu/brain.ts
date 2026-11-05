/**
 * The GPU brain tick: `think` for every due, non-plastic brain of every size class runs as the
 * batched CTRNN kernel (wgsl/brain.ts); plastic brains (the ABCD rule) and the act step run on
 * the CPU with src/brain's own functions, so outputs reach `out`, `cmd` and `cmd2` exactly as
 * there. Same due rule as src/brain/think.ts: `(slot + tick) % brainDiv == 0`, alive, laid out.
 */
import {
  BRAIN_CLASSES, BRAIN_STATE_CLAMP, DT, LIFE, NEURON_KIND, NONE_U32, PI, RNG_STREAM, type StepContext, type World,
} from '../core/index.js';
import { actBrain, tickBrain } from '../brain/think.js';
import { brainState, recomputeAlphas } from '../brain/pool.js';
import { BU, bindAll, computePipeline, dispatch, explicitLayout, readBuffer, type GpuContext } from './device.js';
import { BH, BRAIN_WG, BST, brainWgsl } from './wgsl/brain.js';

interface ClassGpu {
  think: GPUComputePipeline; commit: GPUComputePipeline;
  cap: number;
  params: GPUBuffer; hdr: GPUBuffer; inputs: GPUBuffer; st: GPUBuffer; stat: GPUBuffer; nkr: GPUBuffer; syn: GPUBuffer; nan: GPUBuffer;
  bgThink: GPUBindGroup; bgCommit: GPUBindGroup;
}

export class GpuBrain {
  private cls: (ClassGpu | null)[] = [];
  private pipes: { think: GPUComputePipeline; commit: GPUComputePipeline }[] = [];
  /** Brains the GPU ticked last call, per class (tests). */
  lastGpuTicked = 0;
  constructor(readonly gpu: GpuContext) {}

  async init(): Promise<this> {
    const d = this.gpu.device;
    for (let c = 0; c < BRAIN_CLASSES.length; c++) {
      const { n, i, k } = BRAIN_CLASSES[c]!;
      const code = brainWgsl(n, i, k, { osc: NEURON_KIND.OSCILLATOR, noisyLo: NEURON_KIND.DRIVE, modulator: NEURON_KIND.MODULATOR }, BRAIN_STATE_CLAMP, PI);
      const layout = explicitLayout(d, ['uniform', 'read', 'read', 'rw', 'read', 'read', 'read', 'rw']);
      this.pipes.push({ think: await computePipeline(d, code, 'think', `brain.think.c${c}`, layout), commit: await computePipeline(d, code, 'commit', `brain.commit.c${c}`, layout) });
      this.cls.push(null);
    }
    return this;
  }

  private ensure(c: number, cap: number): ClassGpu {
    const have = this.cls[c];
    if (have && have.cap >= cap) return have;
    if (have) for (const b of [have.params, have.hdr, have.inputs, have.st, have.stat, have.nkr, have.syn, have.nan]) b.destroy();
    const { n: N, i: I, k: K } = BRAIN_CLASSES[c]!;
    const d = this.gpu.device;
    const B = Math.max(16, Math.ceil(cap * 1.25));
    const mk = (bytes: number): GPUBuffer => d.createBuffer({ size: Math.max(16, Math.ceil(bytes / 16) * 16), usage: BU.STORAGE | BU.COPY_DST | BU.COPY_SRC });
    const g = {
      think: this.pipes[c]!.think, commit: this.pipes[c]!.commit, cap: B,
      params: d.createBuffer({ size: 32, usage: BU.UNIFORM | BU.COPY_DST }),
      hdr: mk(B * BH.STRIDE * 4), inputs: mk(B * I * 4), st: mk(BST.N * B * N * 4), stat: mk((3 * B * N + B * N * 12) * 4),
      nkr: mk(B * N * 4), syn: mk(2 * B * K * N * 4), nan: mk(16),
    } as Omit<ClassGpu, 'bgThink' | 'bgCommit'> as ClassGpu;
    const bufs = [g.params, g.hdr, g.inputs, g.st, g.stat, g.nkr, g.syn, g.nan];
    g.bgThink = bindAll(d, g.think, bufs);
    g.bgCommit = bindAll(d, g.commit, bufs);
    this.cls[c] = g;
    return g;
  }

  /** Same contract as BrainModule.think, asynchronously. */
  async think(world: World, ctx: StepContext): Promise<void> {
    const bs = brainState(world);
    const div = world.g.brainDiv;
    if (div !== bs.lastDiv) recomputeAlphas(world);
    const tick = ctx.tick;
    const dtb = div * DT;
    const life = world.cr.c.life;
    const ns = ctx.rng.stream(RNG_STREAM.BRAIN_NOISE);
    const d = this.gpu.device;
    this.lastGpuTicked = 0;
    const work: { c: number; due: number[]; reads: Promise<[ArrayBuffer, ArrayBuffer]> }[] = [];
    const cpuDue: [number, number][] = [];
    for (let c = 0; c < world.brains.length; c++) {
      const pool = world.brains[c]!;
      const statics = bs.statics[c]!;
      const owner = pool.c.owner;
      const nB = pool.highWater;
      const due: number[] = [];
      for (let s = 0; s < nB; s++) {
        const cr = owner[s]!;
        if (cr === NONE_U32 || (cr + tick) % div !== 0 || life[cr] !== LIFE.ALIVE) continue;
        const st = statics[s];
        if (!st) continue;
        if (st.plastic && pool.c.synDw.length > 1) { cpuDue.push([c, s]); continue; }
        due.push(s);
      }
      if (due.length === 0) continue;
      const { n: N, i: I, k: K } = BRAIN_CLASSES[c]!;
      const g = this.ensure(c, nB);
      const B = g.cap;
      const p = pool.c;
      // header
      const hdr = new Uint32Array(nB * BH.STRIDE); const hf = new Float32Array(hdr.buffer);
      const nkr = new Uint32Array(nB * N);
      for (const s of due) {
        const st = statics[s]!;
        const o = s * BH.STRIDE;
        hdr[o + BH.DUE] = 1; hdr[o + BH.NIN] = p.nIn[s]!; hdr[o + BH.NNEU] = p.nNeu[s]!;
        hdr[o + BH.ELO] = st.entityId % 4294967296 >>> 0; hdr[o + BH.EHI] = Math.floor(st.entityId / 4294967296) >>> 0;
        hf[o + BH.EXPL] = st.exploration; hf[o + BH.FLO] = p.fBand[s * 2]!; hf[o + BH.FHI] = p.fBand[s * 2 + 1]!;
        for (let i = 0; i < N; i++) nkr[s * N + i] = p.nKind[s * N + i]! | ((i < st.rowLen.length ? st.rowLen[i]! : 0) << 8);
      }
      const q = d.queue;
      q.writeBuffer(g.hdr, 0, hdr);
      q.writeBuffer(g.inputs, 0, p.inputs.buffer, p.inputs.byteOffset, nB * I * 4);
      for (const [lane, col] of [[BST.Y, p.y], [BST.O, p.o], [BST.OPREV, p.oPrev], [BST.PHASE, p.phase]] as const) {
        q.writeBuffer(g.st, lane * B * N * 4, col.buffer, col.byteOffset, nB * N * 4);
      }
      q.writeBuffer(g.stat, 0, p.theta.buffer, p.theta.byteOffset, nB * N * 4);
      q.writeBuffer(g.stat, B * N * 4, p.alpha.buffer, p.alpha.byteOffset, nB * N * 4);
      q.writeBuffer(g.stat, 2 * B * N * 4, p.phaseOff.buffer, p.phaseOff.byteOffset, nB * N * 4);
      q.writeBuffer(g.stat, 3 * B * N * 4, p.osc.buffer, p.osc.byteOffset, nB * N * 12 * 4);
      q.writeBuffer(g.nkr, 0, nkr);
      const syn = new Uint32Array(nB * K * N); for (let a = 0; a < syn.length; a++) syn[a] = p.synSrc[a]!;
      q.writeBuffer(g.syn, 0, syn);
      q.writeBuffer(g.syn, B * K * N * 4, p.synW.buffer, p.synW.byteOffset, nB * K * N * 4);
      const pb = new ArrayBuffer(32); const pu = new Uint32Array(pb); const pf = new Float32Array(pb);
      pu[0] = nB; pu[1] = tick >>> 0; pf[2] = dtb; pu[3] = ns.k0; pu[4] = ns.k1; pu[5] = B;
      q.writeBuffer(g.params, 0, pb);
      q.writeBuffer(g.nan, 0, new Uint32Array(4));
      const enc = d.createCommandEncoder();
      dispatch(d, g.think, g.bgThink, Math.ceil((nB * N) / BRAIN_WG), enc);
      dispatch(d, g.commit, g.bgCommit, Math.ceil(nB / BRAIN_WG), enc);
      q.submit([enc.finish()]);
      this.lastGpuTicked += due.length;
      work.push({ c, due, reads: Promise.all([readBuffer(d, g.st, 4 * B * N * 4), readBuffer(d, g.nan, 4)]) });
    }
    // CPU side while the GPU works: plastic brains
    for (const [c, s] of cpuDue) tickBrain(world, c, s, bs.statics[c]![s]!, tick, dtb, ns.k0, ns.k1);
    for (const w of work) {
      const [stBuf, nanBuf] = await w.reads;
      const { n: N } = BRAIN_CLASSES[w.c]!;
      const B = this.cls[w.c]!.cap;
      const stv = new Float32Array(stBuf);
      const p = world.brains[w.c]!.c;
      for (const s of w.due) {
        for (let i = 0; i < N; i++) {
          p.y[s * N + i] = stv[BST.Y * B * N + s * N + i]!; p.o[s * N + i] = stv[BST.O * B * N + s * N + i]!;
          p.oPrev[s * N + i] = stv[BST.OPREV * B * N + s * N + i]!; p.phase[s * N + i] = stv[BST.PHASE * B * N + s * N + i]!;
        }
      }
      bs.nanResets += new Uint32Array(nanBuf)[0]!;
    }
    // act, in the CPU order (class, slot)
    for (let c = 0; c < world.brains.length; c++) {
      const pool = world.brains[c]!; const statics = bs.statics[c]!; const owner = pool.c.owner;
      for (let s = 0; s < pool.highWater; s++) {
        const cr = owner[s]!;
        if (cr === NONE_U32 || (cr + tick) % div !== 0 || life[cr] !== LIFE.ALIVE) continue;
        const st = statics[s];
        if (st) actBrain(world, c, s, st, dtb);
      }
    }
  }
}
