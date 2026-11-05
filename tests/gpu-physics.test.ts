/**
 * GPU physics against the CPU backend (src/physics). The kernel is f32 with anchored
 * positions; the CPU is f64. Bands are documented in docs/modules/gpu.md §3.
 */
import { describe, expect, it } from 'vitest';
import { ORGAN, type World } from '../src/core/index.js';
import { createPhysics } from '../src/physics/index.js';
import { chain, fish, makePhenotype, makeWorld, nextTick, purcell, setCmds, spawn, type TestWorld } from '../src/physics/testkit.js';
import { GpuPhysicsEngine, createGpuPhysics } from '../src/gpu/physics.js';
import { genome, TEMPLATE_IDS } from '../src/genome/index.js';
import { gpuContext } from './gpu-helpers.js';

const gpu = await gpuContext();

/** A mixed scene: swimming fish, a cilia microbe, a Purcell swimmer, a passive chain, sinking and rising bodies. */
function scene(): TestWorld {
  const tw = makeWorld();
  const cpu = createPhysics({ contacts: false });
  const load = cpu.loadBody;
  spawn(tw, load, makePhenotype(fish()), 10, 8, 0.3);
  spawn(tw, load, makePhenotype(fish(6, 0.05)), 14, 6, -1.2);
  spawn(tw, load, makePhenotype(chain(3, 2e-4, () => 5e-5, { organs: ORGAN.CILIA })), 20, 9, 0.7);
  spawn(tw, load, makePhenotype(purcell(5e-4, 3e-5, 1, 1)), 16, 12, 0);
  spawn(tw, load, makePhenotype(chain(10, 0.02, (k) => 0.004 * (1 - 0.05 * k))), 6, 10, 2.0);
  spawn(tw, load, makePhenotype(fish(12, 0.6)), 24, 14, 3.0);
  // a gentle shear current so the flow sampler matters
  const f = tw.world.fields; const [w, h] = f.coarse;
  for (let iy = 0; iy < h; iy++) for (let ix = 0; ix < w; ix++) { f.flowU[iy * w + ix] = 0.01 * Math.sin(iy * 0.1); f.flowV[iy * w + ix] = 0.004 * Math.cos(ix * 0.07); }
  return tw;
}

function drive(w: World, tick: number): void {
  const c = w.cr.c;
  for (let s = 0; s < w.cr.highWater; s++) {
    setCmds(w, s, (k) => (s === 4 ? 0 : Math.sin(tick * 0.25 - k * 0.7 + s)));
    const s0 = c.segStart[s]!;
    if (s === 2) for (let k = 0; k < c.segCount[s]!; k++) w.seg.c.cmd2[s0 + k] = 0.8;
  }
}

interface Err { pos: number; ang: number; vel: number; act: number; nSubDiff: number; power: number; workJ: number }

function compare(a: World, b: World): Err {
  const e: Err = { pos: 0, ang: 0, vel: 0, act: 0, nSubDiff: 0, power: 0, workJ: 0 };
  const ca = a.cr.c; const cb = b.cr.c; const sa = a.seg.c; const sb = b.seg.c;
  for (let s = 0; s < a.cr.highWater; s++) {
    const s0 = ca.segStart[s]!; const n = ca.segCount[s]!;
    let L = 0; let vs = 1e-6;
    for (let k = 0; k < n; k++) { L += sa.len[s0 + k]!; vs = Math.max(vs, Math.hypot(sa.velX[s0 + k]!, sa.velY[s0 + k]!)); }
    for (let k = 0; k < n; k++) {
      const i = s0 + k;
      e.pos = Math.max(e.pos, Math.hypot(sa.posX[i]! - sb.posX[i]!, sa.posY[i]! - sb.posY[i]!) / L);
      let d = sa.angle[i]! - sb.angle[i]!; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
      e.ang = Math.max(e.ang, Math.abs(d));
      e.vel = Math.max(e.vel, Math.hypot(sa.velX[i]! - sb.velX[i]!, sa.velY[i]! - sb.velY[i]!) / vs);
      e.act = Math.max(e.act, Math.abs(sa.act[i]! - sb.act[i]!));
    }
    if (ca.nSub[s] !== cb.nSub[s]) e.nSubDiff++;
    const pw = Math.max(Math.abs(ca.powerW[s]!), 1e-12);
    e.power = Math.max(e.power, Math.abs(ca.powerW[s]! - cb.powerW[s]!) / pw);
    e.workJ = Math.max(e.workJ, Math.abs(ca.workJ[s]! - cb.workJ[s]!) / Math.max(Math.abs(ca.workJ[s]!), 1e-15));
  }
  return e;
}

/** One adult of every genome template, grown by genome.develop (fins, cilia, jets, mouths, real limits). */
function templateScene(): TestWorld {
  const tw = makeWorld();
  const cpu = createPhysics({ contacts: false });
  TEMPLATE_IDS.forEach((id, k) => {
    const ph = genome.develop(genome.template(id), 1, { depth01: 0.5, tempC: 12 }, { maxParts: 12, lCeilingM: 2 });
    if (ph.nParts === 0) return;
    spawn(tw, cpu.loadBody, ph, 4 + 3.5 * k, 6 + (k % 3) * 3, 0.4 * k, 12);
  });
  return tw;
}

describe.skipIf(!gpu)('gpu physics vs cpu', () => {
  it('genome templates grown by develop(): 60 ticks inside the bands', async () => {
    const A = templateScene(); const B = templateScene();
    const cpu = createPhysics({ contacts: false });
    const g = await createGpuPhysics(gpu!, { contacts: false });
    let e = compare(A.world, B.world);
    for (let t = 0; t < 60; t++) {
      for (const w of [A.world, B.world]) {
        drive(w, t);
        const c = w.cr.c;
        for (let s = 0; s < w.cr.highWater; s++) for (let k = 0; k < c.segCount[s]!; k++) w.seg.c.cmd2[c.segStart[s]! + k] = 0.5 + 0.5 * Math.sin(t * 0.2 + k);
      }
      cpu.step(A.world, A.ctx); await g.step(B.world, B.ctx);
      nextTick(A); nextTick(B);
      e = compare(A.world, B.world);
    }
    console.log('templates 60 ticks', A.world.cr.highWater, 'creatures', e);
    expect(A.world.cr.highWater).toBeGreaterThan(4);
    expect(e.pos).toBeLessThan(1e-3);
    expect(e.nSubDiff).toBe(0);
  });

  it('one tick from the same state agrees within the f32 bands', async () => {
    const A = scene(); const B = scene();
    const cpu = createPhysics({ contacts: false });
    const g = await createGpuPhysics(gpu!, { contacts: false });
    drive(A.world, 0); drive(B.world, 0);
    cpu.step(A.world, A.ctx); await g.step(B.world, B.ctx);
    const e = compare(A.world, B.world);
    console.log('1 tick', e);
    expect(e.nSubDiff).toBe(0);
    expect(e.pos).toBeLessThan(1e-5);
    expect(e.ang).toBeLessThan(1e-4);
  });

  it('60 ticks of swimming stay inside the bands', async () => {
    const A = scene(); const B = scene();
    const cpu = createPhysics({ contacts: false });
    const g = await createGpuPhysics(gpu!, { contacts: false });
    let worst: Err | null = null;
    for (let t = 0; t < 60; t++) {
      drive(A.world, t); drive(B.world, t);
      cpu.step(A.world, A.ctx); await g.step(B.world, B.ctx);
      nextTick(A); nextTick(B);
      worst = compare(A.world, B.world);
    }
    console.log('60 ticks', worst);
    expect(worst!.pos).toBeLessThan(1e-3);
    expect(worst!.workJ).toBeLessThan(1e-2);
  });

  it('GPU-resident ticks (re-anchoring, rest history on the GPU) track the CPU', async () => {
    const A = scene(); const B = scene();
    drive(A.world, 3); drive(B.world, 3); // held commands
    const cpu = createPhysics({ contacts: false, watchdog: false });
    const eng = await new GpuPhysicsEngine(gpu!, cpu.opts).init();
    const slots = Array.from({ length: B.world.cr.highWater }, (_, s) => s);
    eng.upload(B.world, slots);
    eng.run(30);
    await eng.download(B.world);
    for (let t = 0; t < 30; t++) { cpu.step(A.world, A.ctx); nextTick(A); }
    const e = compare(A.world, B.world);
    console.log('resident 30 ticks', e);
    expect(e.pos).toBeLessThan(1e-3);
    expect(e.nSubDiff).toBe(0);
    eng.destroy();
  });
});
