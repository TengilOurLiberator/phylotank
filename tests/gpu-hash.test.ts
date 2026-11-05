/** GPU spatial hash against src/physics buildHash: integer results, compared exactly. */
import { describe, expect, it } from 'vitest';
import { RngStreams } from '../src/core/index.js';
import { createPhysics } from '../src/physics/index.js';
import { buildHash } from '../src/physics/contacts.js';
import { chain, fish, makePhenotype, makeWorld, spawn, type TestWorld } from '../src/physics/testkit.js';
import { GpuPhysicsEngine } from '../src/gpu/physics.js';
import { GpuHash } from '../src/gpu/hash.js';
import { gpuContext } from './gpu-helpers.js';

const gpu = await gpuContext();

/** n creatures of mixed sizes (1 mm to 60 cm) at seeded positions, some crowded into a few cells. */
export function crowd(n: number, seed = 7): TestWorld {
  const tw = makeWorld({ agentCap: n + 8 });
  const cpu = createPhysics({ contacts: false });
  const rng = new RngStreams(seed, 0).stream(1);
  const blk = new Uint32Array(4);
  const shapes = [makePhenotype(fish()), makePhenotype(fish(6, 0.05)), makePhenotype(chain(3, 3e-4, () => 1e-4)), makePhenotype(fish(12, 0.6)), makePhenotype(chain(2, 1e-3, () => 2e-4))];
  const W = tw.world.preset.widthM; const H = tw.world.preset.heightM;
  for (let i = 0; i < n; i++) {
    rng.block(0, i, 0, blk);
    const u = (k: number): number => blk[k]! / 4294967296;
    const crowded = i % 5 === 0;
    const x = crowded ? 5 + u(0) * 0.01 : 1 + u(0) * (W - 2);
    const y = crowded ? 7 + u(1) * 0.01 : 1 + u(1) * (H - 2);
    const s = spawn(tw, cpu.loadBody, shapes[i % shapes.length]!, x, y, u(2) * 6.28);
    const c = tw.world.seg.c; const s0 = tw.world.cr.c.segStart[s]!;
    for (let k = 0; k < tw.world.cr.c.segCount[s]!; k++) { c.velX[s0 + k] = (u(3) - 0.5) * 0.2; c.velY[s0 + k] = (u(k % 4) - 0.5) * 0.1; }
  }
  return tw;
}

describe.skipIf(!gpu)('gpu spatial hash vs cpu', () => {
  it('cells, bucket table and (bucket, slot) order match buildHash exactly', async () => {
    const tw = crowd(3000);
    const w = tw.world;
    const eng = await new GpuPhysicsEngine(gpu!).init();
    const slots: number[] = [];
    for (let s = 0; s < w.cr.highWater; s++) if (w.cr.c.segCount[s]! > 0) slots.push(s);
    const pk = eng.upload(w, slots);
    const hash = await new GpuHash(gpu!, eng).init();
    hash.build(1 / 30);
    const g = await hash.read();
    const cpu = buildHash(w, undefined, 1 / 30);
    // compact item g -> segment slot
    const segOf = new Int32Array(pk.nSeg);
    for (let q = 0; q < pk.nCr; q++) {
      const s0 = w.cr.c.segStart[pk.slots[q]!]!; const n = w.cr.c.segCount[pk.slots[q]!]!;
      for (let k = 0; k < n; k++) segOf[pk.base[q]! + k] = s0 + k;
    }
    let cellMismatch = 0;
    for (let q = 0; q < pk.nSeg; q++) {
      const i = segOf[q]!;
      if (g.cell[q * 3] !== cpu.cx[i] || g.cell[q * 3 + 1] !== cpu.cy[i] || g.cell[q * 3 + 2] !== cpu.level[i]) cellMismatch++;
    }
    expect(cpu.n).toBe(pk.nSeg);
    expect(g.mask).toBe(cpu.mask);
    expect(cellMismatch).toBe(0);
    const T = cpu.mask + 1;
    expect(Array.from(g.start)).toEqual(Array.from(cpu.start.subarray(0, T + 1)));
    const gItems = Array.from(g.sorted, (q) => segOf[q]!);
    expect(gItems).toEqual(Array.from(cpu.items.subarray(0, cpu.n)));
    eng.destroy();
  });
});
