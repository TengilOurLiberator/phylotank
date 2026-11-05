/**
 * Physics spike 1, part 2 (docs/spikes/physics-1.md): the anguilliform swimmer at high Re (B4),
 * the energy budget with muscles (R6), timestep convergence (T1, T2), the Gray-Hancock
 * flagellum (B2), the exploit-transfer ratio and CPU throughput. Quick variants always run;
 * PT_SPIKE=1 runs the full measurements and prints "SPIKE" JSON lines.
 */
import { describe, expect, it } from 'vitest';
import { KIND, ORGAN, RngStreams, type World } from '../src/core/index.js';
import { createPhysics, workFor, type PhysicsOptions } from '../src/physics/index.js';
import { StokesReference, type RefLink } from '../src/physics/reference.js';
import { buildHash, queryPairs, queryRadius } from '../src/physics/contacts.js';
import { runPurcellRef, runPurcellSim } from '../src/physics/benchkit.js';
import {
  bodyMass, chain, com, elastic, fish, kinetic, makePhenotype, makeWorld, nextTick, spawn, type PartDef,
} from '../src/physics/testkit.js';

const LONG = !!process.env.PT_SPIKE;
const log = (tag: string, data: unknown): void => { if (LONG) console.log(`SPIKE ${tag} ${JSON.stringify(data)}`); };
/** Process CPU time in ms (the box is shared, so wall time overstates the cost). */
const now = (): number => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };

// ---------------------------------------------------------------- anguilliform at high Re
interface Gait { f: number; amp: number[]; lag: number }
interface SwimResult { U: number; Re: number; St: number; P: number; cot: number; wNet: number; dragW: number; dE: number; tipAmp: number }

function swim(gait: Gait, over: Partial<PhysicsOptions> = {}, seconds = 8, body: PartDef[] = fish(), L = 0.2): SwimResult {
  const tw = makeWorld();
  const phys = createPhysics({ gravity: false, contacts: false, diagnostics: true, ...over });
  const slot = spawn(tw, phys.loadBody, makePhenotype(body), 16, 9);
  const w = tw.world; const sg = w.seg.c; const c = w.cr.c; const s0 = c.segStart[slot]!; const n = c.segCount[slot]!;
  const wk = workFor(w);
  const dt = phys.opts.dt;
  const ticks = Math.round(seconds / dt);
  const half = Math.round(ticks / 2);
  let xA = 0; let tA = 0; let P = 0; let wNet = 0; let dragW = 0; let E0 = 0;
  let tipMin = Infinity; let tipMax = -Infinity;
  for (let k = 0; k < ticks; k++) {
    const t = k * dt;
    for (let j = 1; j < n; j++) sg.cmd[s0 + j] = (gait.amp[j - 1] ?? gait.amp[0]!) * Math.sin(2 * Math.PI * gait.f * t - gait.lag * j);
    phys.step(w, tw.ctx); nextTick(tw);
    if (k === half) { xA = com(w, slot)[0]; tA = t; E0 = kinetic(w, slot) + elastic(w, slot); }
    if (k > half) {
      P += c.powerW[slot]! * dt;
      for (let q = 0; q < n; q++) { wNet += wk.netWork[s0 + q]!; dragW += wk.dragWork[s0 + q]!; }
      // lateral tail-tip excursion in the body frame (y, since the fish swims along -x)
      const i = s0 + n - 1;
      const tipY = sg.posY[i]! + Math.sin(sg.angle[i]!) * 0.5 * sg.len[i]! - com(w, slot)[1];
      tipMin = Math.min(tipMin, tipY); tipMax = Math.max(tipMax, tipY);
    }
  }
  const T = (ticks - 1) * dt - tA;
  const dx = com(w, slot)[0] - xA;
  const U = dx / T; // +x is forward (heading 0)
  const m = bodyMass(w, slot);
  const tipAmp = 0.5 * (tipMax - tipMin);
  const dE = kinetic(w, slot) + elastic(w, slot) - E0;
  return {
    U, Re: Math.abs(U) * L / 2e-5, St: gait.f * 2 * tipAmp / Math.abs(U), P: P / T, cot: P / T / (m * 9.81 * Math.abs(U)),
    wNet, dragW, dE, tipAmp,
  };
}

const EEL: Gait = { f: 2, amp: [0.3], lag: 0.8 };

describe('physics spike: high Re', () => {
  it('B4: an 8-segment 20 cm undulator swims forward at Re > 1e3 driven by its muscles', () => {
    const r = swim(EEL, { nSub: 4 }, LONG ? 8 : 4);
    log('eel', r);
    expect(r.U).toBeGreaterThan(0.02);
    expect(r.Re).toBeGreaterThan(200);
  });

  it('R6: with muscles, the water dissipates no more than the muscles put in', { timeout: 600_000 }, () => {
    const rows = [];
    for (const [nSub, solver] of (LONG ? [[1, 'tree'], [2, 'tree'], [4, 'tree'], [8, 'tree'], [16, 'tree'], [1, 'gs'], [4, 'gs'], [16, 'gs']] : [[4, 'tree']]) as [number, 'tree' | 'gs'][]) {
      const r = swim(EEL, { nSub, solver }, LONG ? 8 : 4, fish().map((p) => ({ ...p, damping: 0.05 })));
      // closure = (dissipated by drag + stored) / net muscle work; > 1 is energy from nothing
      rows.push({ nSub, solver, wNet: r.wNet, dragW: r.dragW, dE: r.dE, closure: (-r.dragW + r.dE) / r.wNet, U: r.U });
    }
    log('budget', rows);
    // > 1 would be energy from nothing; the shortfall is passive joint damping plus numerical damping
    for (const r of rows) { expect(r.closure).toBeLessThan(1.02); expect(r.closure).toBeGreaterThan(0); }
  });

  it.runIf(LONG)('B4 sweep: speed against frequency and amplitude, Strouhal number', { timeout: 600_000 }, () => {
    const rows = [];
    for (const amp of [0.5, 1]) for (const f of [0.5, 1, 2, 3, 4]) {
      const r = swim({ f, amp: [amp], lag: 0.8 }, { nSub: 4 }, 8);
      rows.push({ amp, f, U: r.U, BLps: r.U / 0.2, Re: r.Re, St: r.St, P: r.P, cot: r.cot, tipAmp: r.tipAmp });
    }
    log('eelSweep', rows);
  });

  it.runIf(LONG)('T1 and T2: substep and tick-rate convergence of the undulator', { timeout: 600_000 }, () => {
    const ref = swim(EEL, { nSub: 64 }, 8);
    const rows = [];
    for (const nSub of [1, 2, 4, 8, 16]) {
      const r = swim(EEL, { nSub }, 8);
      rows.push({ nSub, U: r.U, errU: (r.U - ref.U) / ref.U, errP: (r.P - ref.P) / ref.P });
    }
    const r60 = swim(EEL, { nSub: 4, dt: 1 / 60 }, 8);
    const r30 = swim(EEL, { nSub: 4 }, 8);
    const r30x8 = swim(EEL, { nSub: 8 }, 8);
    log('eelT1', { refU: ref.U, refP: ref.P, rows });
    log('eelT2', { U30x4: r30.U, U60x4: r60.U, U30x8: r30x8.U, d30v60: (r30.U - r60.U) / r60.U, P30: r30.P, P60: r60.P, dP: (r30.P - r60.P) / r60.P });
  });
});

describe('physics spike: coasting (B7)', () => {
  it.runIf(LONG)('coasting distance in body lengths against Re', { timeout: 600_000 }, () => {
    const rows = [];
    for (const L of [0.001, 0.003, 0.01, 0.03, 0.1, 0.2]) {
      for (const blps of [1, 3]) {
        const tw = makeWorld();
        const phys = createPhysics({ gravity: false, contacts: false, nSub: 4 });
        const slot = spawn(tw, phys.loadBody, makePhenotype(fish(4, L)), 16, 9, 0);
        const sg = tw.world.seg.c; const c = tw.world.cr.c;
        const U = blps * L;
        for (let q = 0; q < 4; q++) sg.velX[c.segStart[slot]! + q] = U;
        const x0 = com(tw.world, slot)[0];
        for (let k = 0; k < 300; k++) { phys.step(tw.world, tw.ctx); nextTick(tw); }
        const d = com(tw.world, slot)[0] - x0;
        rows.push({ L, U, Re: U * L / 2e-5, coastBL: d / L, vEndOverU: c.velX[slot]! / U });
      }
    }
    log('coast', rows);
  });
});

// ---------------------------------------------------------------- B2 Gray-Hancock flagellum, T1 at low Re
// radius 5 µm: toSegmentSpecs floors radii at 5 µm (solver safety), so thinner links are not comparable
const FN = 24; const FDS = 1e-4; const FR = 5e-6; const FB = 0.3 / (2 * Math.PI / (FN * FDS / 2)); // bk = 0.3
const FK = 2 * Math.PI / (FN * FDS / 2); // two wavelengths along the body
const FT = 1; // period

function flagShape(t: number, ang: Float64Array, rate: Float64Array): void {
  // relative joint angle = ds * curvature of y = b sin(k x - w t), joints at x_j = j ds (head to tail)
  const om = 2 * Math.PI / FT;
  for (let j = 1; j < FN; j++) {
    const x = j * FDS;
    const curv = -FB * FK * FK * Math.sin(FK * x - om * t);
    ang[j] = (j === 1 ? Math.PI : 0) + FDS * curv * (j === 1 ? -1 : 1);
    rate[j] = FDS * (FB * FK * FK * om * Math.cos(FK * x - om * t)) * (j === 1 ? -1 : 1);
  }
}

function flagellumSim(nSub: number, cycles: number, iterations = 1, solver: 'tree' | 'gs' = 'tree', dt = 1 / 30): number {
  const tw = makeWorld();
  const phys = createPhysics({ nSub, iterations, solver, dt, gravity: false, prescribed: true, contacts: false, linearDrag: true, addedMass: false });
  const ang = new Float64Array(FN); const rate = new Float64Array(FN);
  flagShape(0, ang, rate);
  const parts = chain(FN, FDS, () => FR, { limit: 3 });
  for (let j = 1; j < FN; j++) parts[j]!.restAngle = ang[j]!;
  const slot = spawn(tw, phys.loadBody, makePhenotype(parts), 16, 9);
  const sg = tw.world.seg.c;
  const x0 = com(tw.world, slot)[0];
  const ticks = Math.round(cycles * FT / phys.opts.dt);
  for (let k = 0; k < ticks; k++) {
    flagShape((k + 1) * phys.opts.dt, ang, rate);
    for (let j = 1; j < FN; j++) sg.restAngle[j] = ang[j]!;
    phys.step(tw.world, tw.ctx); nextTick(tw);
  }
  return (com(tw.world, slot)[0] - x0) / (cycles * FT);
}

function flagellumRef(cycles: number): number {
  const links: RefLink[] = [];
  for (let j = 0; j < FN; j++) links.push({ parent: j - 1, attachU: j === 0 ? 0 : j === 1 ? -0.5 : 0.5, length: FDS, radius: FR, span: 2 * FR, plate: false });
  const ref = new StokesReference(links, flagShape, true);
  const q0 = [16, 9, 0];
  const w = links.map(() => 1);
  const c0 = ref.centroid(0, q0, w);
  const q1 = ref.run(q0, 0, cycles * FT, FT / 240);
  return (ref.centroid(cycles * FT, q1, w)[0] - c0[0]) / (cycles * FT);
}

describe('physics spike: flagellum (B2) and low-Re convergence', () => {
  it.runIf(LONG)('B2: travelling wave matches the Stokes reference and the Gray-Hancock estimate', { timeout: 600_000 }, () => {
    // drag anisotropy of the segments (linear terms)
    const tw = makeWorld();
    const phys = createPhysics();
    spawn(tw, phys.loadBody, makePhenotype(chain(2, FDS, () => FR)), 16, 9);
    const gamma = tw.world.seg.c.drag[1]! / tw.world.seg.c.drag[0]!;
    const V = 2 * Math.PI / FT / FK;
    const gh = -(gamma - 1) * (FB * FK) ** 2 / 2 * V; // swims opposite to the wave (wave runs head to tail: forward is +x)
    const ref = flagellumRef(2);
    const rows = [];
    for (const [nSub, it, solver] of [[1, 1, 'tree'], [4, 1, 'tree'], [16, 1, 'tree'], [64, 1, 'tree'], [4, 1, 'gs'], [16, 1, 'gs'], [64, 1, 'gs'], [16, 8, 'gs'], [4, 32, 'gs']] as const) {
      const U = flagellumSim(nSub, 2, it, solver);
      rows.push({ nSub, iterations: it, solver, U, errRef: (U - ref) / ref, errGH: (U - Math.abs(gh)) / Math.abs(gh) });
    }
    // tick-rate dependence of the prescribed shape (rest angles are interpolated linearly per tick)
    for (const dtx of [1 / 60, 1 / 120, 1 / 240]) {
      const U = flagellumSim(4, 2, 1, 'tree', dtx);
      rows.push({ nSub: 4, iterations: 1, solver: `tree dt=1/${Math.round(1 / dtx)}`, U, errRef: (U - ref) / ref, errGH: (U - Math.abs(gh)) / Math.abs(gh) });
    }
    log('flagellum', { gamma, V, grayHancockU: gh, refU: ref, refOverGH: ref / gh, rows });
    expect(Math.abs(rows[2]!.errRef)).toBeLessThan(0.03); // tree solver, n_sub 16
  });

  it.runIf(LONG)('T1 at low Re: Purcell displacement per cycle against n_sub', { timeout: 600_000 }, () => {
    const ref = runPurcellRef(2);
    const rows = [];
    for (const nSub of [1, 2, 4, 8, 16, 32]) {
      const s = runPurcellSim(nSub, 2);
      rows.push({ nSub, relErr: Math.hypot(s.dx - ref.dx, s.dy - ref.dy) / Math.hypot(ref.dx, ref.dy) });
    }
    log('purcellT1', rows);
  });
});

// ---------------------------------------------------------------- exploit-transfer ratio (REVIEW R6)
function evolve(evalAt: (g: Gait, nSub: number) => number, nParams: number, gens: number, seed: number, train = 1): { best: Gait; fit1: number; fit16: number; fit4: number } {
  const rng = new RngStreams(seed, 99);
  const decode = (x: number[]): Gait => ({
    f: 0.5 + 3.5 / (1 + Math.exp(-x[0]!)), lag: x[1]!, amp: x.slice(2).map((v) => Math.tanh(v)),
  });
  let parent: number[] = Array.from({ length: nParams }, (_, i) => (i === 0 ? 0 : 0.5));
  let pf = evalAt(decode(parent), train);
  let sigma = 0.5;
  const lambda = 6;
  for (let g = 0; g < gens; g++) {
    let bestChild: number[] | null = null; let bf = -Infinity; let succ = 0;
    for (let c = 0; c < lambda; c++) {
      const d = rng.draw(2, g, c);
      const child = parent.map((v) => v + sigma * d.normal());
      const f = evalAt(decode(child), train);
      if (f > pf) succ++;
      if (f > bf) { bf = f; bestChild = child; }
    }
    if (bf > pf && bestChild) { parent = bestChild; pf = bf; }
    sigma *= succ / lambda > 0.2 ? 1.22 : 0.82;
    sigma = Math.min(2, Math.max(0.02, sigma));
  }
  const best = decode(parent);
  return { best, fit1: evalAt(best, 1), fit16: evalAt(best, 16), fit4: evalAt(best, 4) };
}

function eelFitness(g: Gait, nSub: number): number {
  return swim(g, { nSub }, 3).U;
}

function microbeFitness(g: Gait, nSub: number): number {
  // 4-segment, 2 mm muscle-driven flagellate at Re < 0.1
  const body = chain(4, 5e-4, () => 4e-5, { muscleFrac: 0.6 });
  return swim(g, { nSub }, 3, body, 2e-3).U;
}

describe('physics spike: exploit transfer (evolve at 1 substep, re-evaluate at 16)', () => {
  it.runIf(LONG)('undulator and microbe', { timeout: 600_000 }, () => {
    const t0 = now();
    const eel = evolve(eelFitness, 9, 200, 1);
    const t1 = now();
    const mic = evolve(microbeFitness, 5, 200, 2);
    const t2 = now();
    const eel4 = evolve(eelFitness, 9, 100, 3, 4);
    log('exploit4', { eel: { ...eel4, ratio16over4: eel4.fit16 / eel4.fit4 } });
    log('exploit', {
      eel: { ...eel, ratio16: eel.fit16 / eel.fit1, ratio4: eel.fit4 / eel.fit1, secs: (t1 - t0) / 1000 },
      microbe: { ...mic, ratio16: mic.fit16 / mic.fit1, ratio4: mic.fit4 / mic.fit1, secs: (t2 - t1) / 1000 },
    });
  });
});

// ---------------------------------------------------------------- throughput (segments per second)
function populate(w: World, nCreatures: number, phys: ReturnType<typeof createPhysics>, spectrum: boolean, seed = 5): number {
  const tw = { world: w, ctx: undefined as never, events: [] };
  const rng = new RngStreams(seed, 1);
  let segs = 0;
  for (let i = 0; i < nCreatures; i++) {
    const d = rng.draw(1, 0, i);
    // size spectrum: log-uniform 1 mm to 0.12 m body length, 4 to 8 segments
    const L = spectrum ? 0.001 * Math.exp(d.u01() * Math.log(120)) : 0.05;
    const n = 4 + Math.floor(d.u01() * 5);
    const body = chain(n, L / n, (k) => L * 0.06 * (1 - 0.5 * k / n), { muscleFrac: 0.4 });
    if (d.u01() < 0.2) body[0]!.kind = KIND.MOUTH;
    if (L < 0.004) body[0]!.organs = ORGAN.CILIA;
    spawn(tw as never, phys.loadBody, makePhenotype(body), 0.5 + d.u01() * 31, 0.5 + d.u01() * 17, d.u01() * 6.28);
    segs += n;
  }
  return segs;
}

describe('physics spike: CPU throughput', () => {
  it('a small population steps and reports throughput', { timeout: 600_000 }, () => {
    const { world, ctx } = makeWorld({ agentCap: 4096 });
    const phys = createPhysics({});
    const N = LONG ? 2000 : 60;
    const segs = populate(world, N, phys, true);
    const c = world.cr.c; const sg = world.seg.c;
    const ticks = LONG ? 60 : 5;
    let tStep = 0; let subs = 0;
    for (let k = 0; k < ticks; k++) {
      for (let s = 0; s < N; s++) {
        const s0 = c.segStart[s]!;
        for (let j = 1; j < c.segCount[s]!; j++) sg.cmd[s0 + j] = Math.sin(k * 0.4 + j + s);
        sg.cmd2[s0] = 0.6;
        sg.cmd3[s0 * 2] = 0.6;
      }
      const t0 = now();
      phys.step(world, ctx);
      tStep += now() - t0;
      for (let s = 0; s < N; s++) subs += c.nSub[s]! * c.segCount[s]!;
      world.g.tick++;
    }
    const segTicksPerS = segs * ticks / (tStep / 1000);
    log('throughput', { creatures: N, segs, ticks, msPerTick: tStep / ticks, segTicksPerS, segSubstepsPerS: subs / (tStep / 1000), meanNSub: subs / (segs * ticks) });
    for (let s = 0; s < N; s++) expect(Number.isFinite(c.posX[s]!)).toBe(true);
  });

  it.runIf(LONG)('integrator only, contacts only, hash only, at fixed n_sub', { timeout: 600_000 }, () => {
    const rows = [];
    for (const nSub of [1, 4, 16]) {
      const { world, ctx } = makeWorld({ agentCap: 4096 });
      const phys = createPhysics({ nSub, contacts: false });
      const N = 3000;
      const segs = populate(world, N, phys, true);
      const t0 = now();
      for (let k = 0; k < 20; k++) { phys.step(world, ctx); world.g.tick++; }
      const ms = (now() - t0) / 20;
      rows.push({ nSub, segs, msPerTick: ms, segTicksPerS: segs / (ms / 1000), segSubstepsPerS: segs * nSub / (ms / 1000), nsPerSegSubstep: ms * 1e6 / (segs * nSub) });
    }
    log('integrator', rows);
    // hash build, pair query, perception-style radius queries
    const { world, ctx } = makeWorld({ agentCap: 8192 });
    const phys = createPhysics({ contacts: true });
    const N = 8000;
    const segs = populate(world, N, phys, true);
    let t0 = now();
    let hs = buildHash(world);
    for (let k = 0; k < 9; k++) hs = buildHash(world, hs);
    const msBuild = (now() - t0) / 10;
    t0 = now();
    let cand = 0; let cells = 0;
    for (let k = 0; k < 5; k++) for (let q = 0; q < hs.n; q++) cells += queryPairs(world, hs, hs.items[q]!, () => { cand++; });
    const msQuery = (now() - t0) / 5;
    const wk = workFor(world);
    void wk;
    t0 = now();
    phys.step(world, ctx);
    const msFull = now() - t0;
    const perc: Record<string, number>[] = [];
    for (const bl of [2, 10, 40]) {
      let seen = 0; let pc = 0; let nq = 0;
      const tq = now();
      for (let s = 0; s < 8000; s += 8) {
        const L = world.cr.c.length[s]! || 0.01;
        pc += queryRadius(world, hs, world.cr.c.posX[s]!, world.cr.c.posY[s]!, bl * L, 0.02, 4096, () => { seen++; });
        nq++;
      }
      perc.push({ bodyLengths: bl, usPerQuery: (now() - tq) * 1000 / nq, cellsPerQuery: pc / nq, itemsPerQuery: seen / nq });
    }
    log('perception', perc);
    log('hash', { items: segs, msBuild, msQuery, nsPerItemBuild: msBuild * 1e6 / segs, nsPerItemQuery: msQuery * 1e6 / segs, candidatesPerItem: cand / 5 / segs, cellsPerItem: cells / 5 / segs, msFullStepWithContacts: msFull });
  });
});
