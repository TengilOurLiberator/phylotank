/**
 * The GPU physics backend: the full-tier integrator as a WGSL kernel (wgsl/physics.ts), behind
 * the same `loadBody`/`restage`/`step` interface as `src/physics`, with an async `step` (a GPU
 * readback cannot be synchronous; docs/contract-requests/gpu.md G1).
 *
 * What runs where in `step`:
 * - GPU: every live creature with segments that is not in a link island (the hot path).
 * - CPU (unchanged src/physics code): passive drifters, link islands (grabs and latches share a
 *   substep loop with their links, R6), watchdogs, contacts and bites, link pruning. These
 *   follow in the same order as `src/physics/index.ts`, so the CPU parts are bit-identical.
 *
 * `GpuPhysicsEngine` is also usable on its own with GPU-resident state (upload once, run many
 * ticks, read back once), which is what the benchmark measures.
 */
import {
  B0_KLEIBER, DT, E_A_EV, GRAVITY, K_BOLTZMANN_EV, KIND, KLEIBER_EXP, LIFE, NU_WATER, ORGAN, PI, RHO_WATER, T_REF_K, log,
  type Phenotype, type StepContext, type World,
} from '../core/index.js';
import { DEFAULT_OPTIONS, beginCreature, endCreature, substepCreature, substepCreatureEnd, type PhysicsOptions } from '../physics/solver.js';
import { loadBody, restage } from '../physics/body.js';
import { islands, linkState, pruneLinks, resetLinkForces, solveLinks } from '../physics/links.js';
import { stepContacts } from '../physics/contacts.js';
import { watch } from '../physics/watchdog.js';
import { workFor, type Work } from '../physics/work.js';
import { sampleFlow, stepDrifters, ISLAND_SUBSTEPS } from '../physics/index.js';
import {
  C_ADDED, CILIA_SLIP, ETA_CILIA, ETA_MUSCLE, GAUSS_XI, KAPPA_CILIA, KAPPA_ISO, MU_WATER, Q10_MUSCLE,
} from '../physics/constants.js';
import { BU, bindAll, computePipeline, dispatch, explicitLayout, readBuffer, type GpuContext } from './device.js';
import { CRI, CRO, PHYS_WG, PRIV_MAXS, SCRATCH_FIELDS, SDYN, SINT, SST, physicsWgsl } from './wgsl/physics.js';

const Q16 = 65536;

export function physConsts(): Parameters<typeof physicsWgsl>[0] {
  return {
    gravity: GRAVITY, rhoWater: RHO_WATER, nuWater: NU_WATER, muWater: MU_WATER, cAdded: C_ADDED, gaussXi: GAUSS_XI,
    kappaCilia: KAPPA_CILIA, ciliaSlip: CILIA_SLIP, etaCilia: ETA_CILIA, etaMuscle: ETA_MUSCLE, kappaIso: KAPPA_ISO,
    ln2Q10: log(Q10_MUSCLE), b0: B0_KLEIBER, eaOverK: E_A_EV / K_BOLTZMANN_EV, tRef: T_REF_K, kleiber: KLEIBER_EXP,
    kindFin: KIND.FIN, organCilia: ORGAN.CILIA, pi: PI,
  };
}

/** Options the kernel implements; anything else runs on the CPU path. */
export function gpuSupports(o: PhysicsOptions): boolean {
  return o.solver === 'tree' && !o.diagnostics && o.dt > 0;
}

export interface Buffers {
  crCap: number; segCap: number;
  params: GPUBuffer; cri: GPUBuffer; cro: GPUBuffer; sst: GPUBuffer; sint: GPUBuffer; sdyn: GPUBuffer; flow: GPUBuffer; scr: GPUBuffer;
  flowCells: number;
  /** The global scratch is allocated (some creature exceeds PRIV_MAXS segments, or forced). */
  scrFull: boolean;
  bind: GPUBindGroup;
}

/** Compact packing of the creatures handed to the GPU: creature c owns segments [base, base + n). */
export interface Packing { slots: Int32Array; base: Int32Array; nCr: number; nSeg: number }

export class GpuPhysicsEngine {
  private pipe: GPUComputePipeline | null = null;
  private bufs: Buffers | null = null;
  private packing: Packing | null = null;
  /** Host staging copies (reused). */
  private hCri = new Uint32Array(0); private hCro = new Uint32Array(0); private hSst = new Float32Array(0);
  private hSint = new Uint32Array(0); private hSdyn = new Float32Array(0);
  constructor(readonly gpu: GpuContext, readonly opts: PhysicsOptions = { ...DEFAULT_OPTIONS }) {}

  async init(): Promise<this> {
    const layout = explicitLayout(this.gpu.device, ['uniform', 'read', 'rw', 'read', 'read', 'rw', 'read', 'rw']);
    this.pipe = await computePipeline(this.gpu.device, physicsWgsl(physConsts()), 'integrate', 'physics.integrate', layout);
    return this;
  }

  /** Force the global-memory scratch for every creature (benchmarks compare the two layouts). */
  globalScratch = false;

  private ensure(crCap: number, segCap: number, flowCells: number, needScratch: boolean): Buffers {
    const b = this.bufs;
    if (b && b.crCap >= crCap && b.segCap >= segCap && b.flowCells >= flowCells && (!needScratch || b.scrFull)) return b;
    if (b) for (const k of ['params', 'cri', 'cro', 'sst', 'sint', 'sdyn', 'flow', 'scr'] as const) b[k].destroy();
    const d = this.gpu.device;
    const cc = Math.max(64, Math.ceil(crCap * 1.25));
    const sc = Math.max(256, Math.ceil(segCap * 1.25));
    const fc = Math.max(16, flowCells);
    const mk = (bytes: number): GPUBuffer => d.createBuffer({ size: Math.ceil(bytes / 16) * 16, usage: BU.STORAGE | BU.COPY_DST | BU.COPY_SRC });
    const params = d.createBuffer({ size: 64, usage: BU.UNIFORM | BU.COPY_DST });
    const nb = {
      crCap: cc, segCap: sc, flowCells: fc, params,
      cri: mk(cc * CRI.STRIDE * 4), cro: mk(cc * CRO.STRIDE * 4), sst: mk(sc * SST.N * 4), sint: mk(sc * SINT.N * 4),
      sdyn: mk(sc * SDYN.N * 4), flow: mk(fc * 2 * 4), scr: mk(needScratch ? sc * SCRATCH_FIELDS * 4 : 16), scrFull: needScratch,
    } as Omit<Buffers, 'bind'> as Buffers;
    nb.bind = bindAll(d, this.pipe!, [nb.params, nb.cri, nb.cro, nb.sst, nb.sint, nb.sdyn, nb.flow, nb.scr]);
    this.bufs = nb;
    this.hCri = new Uint32Array(cc * CRI.STRIDE); this.hCro = new Uint32Array(cc * CRO.STRIDE);
    this.hSst = new Float32Array(sc * SST.N); this.hSint = new Uint32Array(sc * SINT.N); this.hSdyn = new Float32Array(sc * SDYN.N);
    return nb;
  }

  /** Upload the given creatures (state, statics and the flow grid). */
  upload(world: World, slots: ArrayLike<number>, wk: Work = workFor(world)): Packing {
    const c = world.cr.c; const sg = world.seg.c;
    const nCr = slots.length;
    let nSeg = 0;
    let big = this.globalScratch;
    for (let q = 0; q < nCr; q++) { const n = c.segCount[slots[q]!]!; nSeg += n; if (n > PRIV_MAXS) big = true; }
    const [gw, gh] = world.fields.coarse;
    const b = this.ensure(nCr, nSeg, gw * gh, big);
    const S = b.segCap;
    const pk: Packing = { slots: Int32Array.from(slots), base: new Int32Array(nCr), nCr, nSeg };
    const cri = this.hCri; const cro = this.hCro; const sst = this.hSst; const sint = this.hSint; const sdyn = this.hSdyn;
    const crf = new Float32Array(cri.buffer); const crof = new Float32Array(cro.buffer); const cri32 = new Int32Array(cri.buffer); const cro32 = new Int32Array(cro.buffer);
    let g = 0;
    for (let q = 0; q < nCr; q++) {
      const s = slots[q]!;
      const s0 = c.segStart[s]!; const n = c.segCount[s]!;
      pk.base[q] = g;
      const o = q * CRI.STRIDE;
      cri[o + CRI.BASE] = g; cri[o + CRI.N] = n; cri32[o + CRI.MIR] = c.mirror[s]! < 0 ? -1 : 1;
      crf[o + CRI.LEN] = c.length[s]!; crf[o + CRI.TEMP] = c.tempC[s]!; crf[o + CRI.MASS] = c.massKg[s]!;
      const ax = Math.round(sg.posX[s0]! * Q16); const ay = Math.round(sg.posY[s0]! * Q16);
      const oo = q * CRO.STRIDE;
      cro32[oo + CRO.AX] = ax; cro32[oo + CRO.AY] = ay;
      const axm = ax / Q16; const aym = ay / Q16;
      for (let k = 0; k < n; k++, g++) {
        const i = s0 + k;
        if (wk.restInit[i] === 0) { wk.restPrev[i] = sg.restAngle[i]!; wk.restInit[i] = 1; }
        sst[SST.LEN * S + g] = sg.len[i]!; sst[SST.RAD * S + g] = sg.radius[i]!; sst[SST.SPAN * S + g] = sg.span[i]!;
        sst[SST.MASS * S + g] = sg.mass[i]!; sst[SST.INER * S + g] = sg.inertia[i]!; sst[SST.ATT * S + g] = sg.attachU[i]!;
        sst[SST.REST * S + g] = sg.restAngle[i]!; sst[SST.LO * S + g] = sg.limitLo[i]!; sst[SST.HI * S + g] = sg.limitHi[i]!;
        sst[SST.COMP * S + g] = sg.compliance[i]!; sst[SST.DAMP * S + g] = sg.damping[i]!; sst[SST.TAUMAX * S + g] = sg.tauMax[i]!;
        sst[SST.OMEGA * S + g] = sg.omegaMax[i]!; sst[SST.CMD * S + g] = sg.cmd[i]!; sst[SST.CMD2 * S + g] = sg.cmd2[i]!;
        sst[SST.DAMAGE * S + g] = sg.damage[i]!;
        for (let d = 0; d < 5; d++) sst[(SST.D0 + d) * S + g] = sg.drag[i * 5 + d]!;
        sst[SST.MFRAC * S + g] = wk.muscleFrac[i]!;
        sint[SINT.PARENT * S + g] = sg.parent[i]! >>> 0;
        sint[SINT.KIND * S + g] = (sg.kind[i]! & 255) | (sg.organs[i]! << 8);
        sdyn[SDYN.OX * S + g] = sg.posX[i]! - axm; sdyn[SDYN.OY * S + g] = sg.posY[i]! - aym;
        sdyn[SDYN.ANG * S + g] = sg.angle[i]!; sdyn[SDYN.VX * S + g] = sg.velX[i]!; sdyn[SDYN.VY * S + g] = sg.velY[i]!;
        sdyn[SDYN.W * S + g] = sg.angVel[i]!; sdyn[SDYN.ACT * S + g] = sg.act[i]!; sdyn[SDYN.WORK * S + g] = 0;
        sdyn[SDYN.RESTPREV * S + g] = wk.restPrev[i]!; sdyn[SDYN.NETWORK * S + g] = 0;
      }
      void crof;
    }
    const q = this.gpu.device.queue;
    q.writeBuffer(b.cri, 0, cri.buffer, 0, Math.max(16, nCr * CRI.STRIDE * 4));
    q.writeBuffer(b.cro, 0, cro.buffer, 0, Math.max(16, nCr * CRO.STRIDE * 4));
    q.writeBuffer(b.sst, 0, sst.buffer, 0, sst.byteLength);
    q.writeBuffer(b.sint, 0, sint.buffer, 0, sint.byteLength);
    q.writeBuffer(b.sdyn, 0, sdyn.buffer, 0, sdyn.byteLength);
    const fl = new Float32Array(gw * gh * 2);
    fl.set(world.fields.flowU.subarray(0, gw * gh), 0); fl.set(world.fields.flowV.subarray(0, gw * gh), gw * gh);
    q.writeBuffer(b.flow, 0, fl.buffer, 0, fl.byteLength);
    this.writeParams(world, nCr);
    this.packing = pk;
    return pk;
  }

  /** Re-upload only the per-tick brain commands (resident mode). */
  uploadCommands(world: World): void {
    const pk = this.packing!; const b = this.bufs!; const S = b.segCap; const sg = world.seg.c; const c = world.cr.c;
    const sst = this.hSst;
    for (let q = 0; q < pk.nCr; q++) {
      const s0 = c.segStart[pk.slots[q]!]!; const g0 = pk.base[q]!;
      for (let k = 0; k < c.segCount[pk.slots[q]!]!; k++) { sst[SST.CMD * S + g0 + k] = sg.cmd[s0 + k]!; sst[SST.CMD2 * S + g0 + k] = sg.cmd2[s0 + k]!; }
    }
    this.gpu.device.queue.writeBuffer(b.sst, SST.CMD * S * 4, sst.buffer, SST.CMD * S * 4, 2 * S * 4);
  }

  private writeParams(world: World, nCr: number): void {
    const o = this.opts; const b = this.bufs!;
    const [gw, gh] = world.fields.coarse;
    const buf = new ArrayBuffer(64); const f = new Float32Array(buf); const u = new Uint32Array(buf);
    f[0] = o.dt; f[1] = world.preset.widthM; f[2] = world.preset.heightM; f[3] = world.g.ySurface;
    u[4] = nCr; u[5] = b.segCap; u[6] = o.nSub > 0 ? o.nSub : 0; u[7] = o.minSub;
    u[8] = (o.fluid ? 1 : 0) | (o.gravity ? 2 : 0) | (o.addedMass ? 4 : 0) | (o.walls ? 8 : 0) | (o.linearDrag ? 16 : 0) | (o.prescribed ? 32 : 0) | 64 | (this.globalScratch ? 128 : 0);
    u[9] = gw; u[10] = gh; f[11] = world.preset.widthM / gw;
    this.gpu.device.queue.writeBuffer(b.params, 0, buf);
  }

  /** Encode `ticks` integrator dispatches (state stays on the GPU between them). */
  run(ticks = 1, enc?: GPUCommandEncoder): void {
    const pk = this.packing!; const b = this.bufs!;
    const d = this.gpu.device;
    const e = enc ?? d.createCommandEncoder();
    const groups = Math.ceil(pk.nCr / PHYS_WG);
    for (let t = 0; t < ticks; t++) dispatch(d, this.pipe!, b.bind, groups, e);
    if (!enc) d.queue.submit([e.finish()]);
  }

  /** Wait for the queue (benchmarks). */
  async idle(): Promise<void> { await this.gpu.device.queue.onSubmittedWorkDone(); }

  /** Read the state back into the world's columns; returns per-segment net muscle work into wk.netWork. */
  async download(world: World, wk: Work = workFor(world)): Promise<void> {
    const pk = this.packing!; const b = this.bufs!; const S = b.segCap;
    const d = this.gpu.device;
    const [dynBuf, croBuf] = await Promise.all([
      readBuffer(d, b.sdyn, S * SDYN.N * 4), readBuffer(d, b.cro, Math.max(16, pk.nCr * CRO.STRIDE * 4)),
    ]);
    const dyn = new Float32Array(dynBuf); const cro = new Uint32Array(croBuf); const crof = new Float32Array(croBuf); const cro32 = new Int32Array(croBuf);
    const c = world.cr.c; const sg = world.seg.c;
    for (let q = 0; q < pk.nCr; q++) {
      const s = pk.slots[q]!; const s0 = c.segStart[s]!; const n = c.segCount[s]!; const g0 = pk.base[q]!;
      const oo = q * CRO.STRIDE;
      const axm = cro32[oo + CRO.AX]! / Q16; const aym = cro32[oo + CRO.AY]! / Q16;
      let wPos = 0;
      for (let k = 0; k < n; k++) {
        const i = s0 + k; const g = g0 + k;
        sg.posX[i] = axm + dyn[SDYN.OX * S + g]!; sg.posY[i] = aym + dyn[SDYN.OY * S + g]!;
        sg.angle[i] = dyn[SDYN.ANG * S + g]!; sg.velX[i] = dyn[SDYN.VX * S + g]!; sg.velY[i] = dyn[SDYN.VY * S + g]!;
        sg.angVel[i] = dyn[SDYN.W * S + g]!; sg.act[i] = dyn[SDYN.ACT * S + g]!; sg.work[i] = dyn[SDYN.WORK * S + g]!;
        wk.restPrev[i] = sg.restAngle[i]!; wk.netWork[i] = dyn[SDYN.NETWORK * S + g]!; wk.dragWork[i] = 0;
        if (k > 0) wPos += sg.work[i]!;
      }
      c.workJ[s] = c.workJ[s]! + wPos; // cumulative positive muscle work, as src/physics endCreature
      c.posX[s] = sg.posX[s0]!; c.posY[s] = sg.posY[s0]!;
      c.velX[s] = crof[oo + CRO.VX]!; c.velY[s] = crof[oo + CRO.VY]!;
      c.heading[s] = crof[oo + CRO.HEAD]!; c.angVel[s] = crof[oo + CRO.W]!;
      c.nSub[s] = cro[oo + CRO.NSUB]!; c.powerW[s] = crof[oo + CRO.POW]!;
    }
  }

  /** The live buffers and packing (the hash and brain kernels read the physics state in place). */
  get state(): { bufs: Buffers; packing: Packing } | null { return this.bufs && this.packing ? { bufs: this.bufs, packing: this.packing } : null; }

  destroy(): void {
    const b = this.bufs;
    if (b) for (const k of ['params', 'cri', 'cro', 'sst', 'sint', 'sdyn', 'flow', 'scr'] as const) b[k].destroy();
    this.bufs = null;
  }
}

/** The async physics module shape a GPU backend can offer (contract request G1). */
export interface AsyncPhysicsModule {
  readonly kind: 'gpu' | 'cpu';
  loadBody(world: World, slot: number, ph: Phenotype): void;
  restage(world: World, slot: number, ph: Phenotype): void;
  step(world: World, ctx: StepContext): Promise<void>;
}

const flowTmp = new Float64Array(2);

/** Sample the start-of-tick flow at every segment of a creature into wk.ux/uy (the watchdog reads them). */
function sampleSegFlow(world: World, slot: number, wk: Work, fluid: boolean): void {
  const c = world.cr.c; const sg = world.seg.c;
  const s0 = c.segStart[slot]!; const n = c.segCount[slot]!;
  for (let k = 0; k < n; k++) {
    const i = s0 + k;
    if (fluid) { sampleFlow(world, sg.posX[i]!, sg.posY[i]!, flowTmp); wk.ux[i] = flowTmp[0]!; wk.uy[i] = flowTmp[1]!; } else { wk.ux[i] = 0; wk.uy[i] = 0; }
  }
}

function stepIsland(world: World, members: readonly number[], wk: Work, opts: PhysicsOptions): void {
  const flowAt = (x: number, y: number, out: Float64Array): void => sampleFlow(world, x, y, out);
  const cts = members.map((m) => beginCreature(world, m, wk, opts, flowAt, Math.max(ISLAND_SUBSTEPS, opts.nSub)));
  const nSub = cts[0]!.nSub;
  for (let s = 0; s < nSub; s++) {
    for (const ct of cts) substepCreature(world, ct, wk, opts, s);
    solveLinks(world, wk, members, cts[0]!.h);
    for (const ct of cts) substepCreatureEnd(world, ct, wk, opts, s);
  }
  for (const ct of cts) {
    endCreature(world, ct, wk, opts);
    if (opts.watchdog) watch(world, ct.slot, wk, opts.dt, opts.gravity);
  }
}

/** Build the GPU physics module on an acquired device. */
export async function createGpuPhysics(gpu: GpuContext, over: Partial<PhysicsOptions> = {}): Promise<AsyncPhysicsModule & { readonly engine: GpuPhysicsEngine; readonly opts: PhysicsOptions }> {
  const opts: PhysicsOptions = { ...DEFAULT_OPTIONS, ...over };
  if (!gpuSupports(opts)) throw new Error('gpu physics: options need the CPU backend (solver gs or diagnostics)');
  const engine = await new GpuPhysicsEngine(gpu, opts).init();
  return {
    kind: 'gpu', engine, opts,
    loadBody(world, slot, ph) { loadBody(world, slot, ph); },
    restage(world, slot, ph) { restage(world, slot, ph); },
    async step(world, ctx) {
      stepDrifters(world, ctx);
      const c = world.cr.c;
      const wk = workFor(world);
      resetLinkForces(world);
      const isl = linkState(world).links.length > 0 ? islands(world) : null;
      const rootOf = new Map<number, number>();
      if (isl) for (const [r, ms] of isl) for (const m of ms) rootOf.set(m, r);
      const gpuSlots: number[] = [];
      for (let s = 0; s < world.cr.highWater; s++) {
        const life = c.life[s];
        if ((life !== LIFE.ALIVE && life !== LIFE.CARCASS) || c.segCount[s] === 0) continue;
        if (rootOf.has(s)) continue;
        gpuSlots.push(s);
        if (opts.watchdog) sampleSegFlow(world, s, wk, opts.fluid);
      }
      if (gpuSlots.length) {
        engine.upload(world, gpuSlots, wk);
        engine.run(1);
        await engine.download(world, wk);
      }
      // islands and watchdogs in ascending slot order, as the CPU module interleaves them
      let gi = 0;
      for (let s = 0; s < world.cr.highWater; s++) {
        const root = rootOf.get(s);
        if (root !== undefined) { if (root === s) stepIsland(world, isl!.get(root)!, wk, opts); continue; }
        if (gi < gpuSlots.length && gpuSlots[gi] === s) {
          gi++;
          if (opts.watchdog) watch(world, s, wk, opts.dt, opts.gravity);
        }
      }
      if (opts.contacts) stepContacts(world, ctx, wk, opts);
      pruneLinks(world);
    },
  };
}

export { DT };
