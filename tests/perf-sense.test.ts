/**
 * perf: the culled neighbour gather in brain sense gives the same inputs as gathering the whole
 * search box, on a crowded tank with creatures pushed onto and past the walls.
 */
import { describe, expect, it } from 'vitest';
import { type WorldConfig } from '../src/core/index.js';
import { sense, senseTuning } from '../src/brain/sense.js';
import { contextFor, sim } from '../src/sim/index.js';

describe('perf: brain sense gather culling', { timeout: 300_000 }, () => {
  it('reads the same inputs with and without culling', () => {
    const w = sim.create({
      preset: 'small', seedLo: 77, seedHi: 3, backend: 'cpu', agentCap: 1500,
      founders: [
        { template: 'motefly', count: 500, zone: 'surface' }, { template: 'meadowlamp', count: 120, zone: 'shelf' },
        { template: 'hushmaw', count: 40 }, { template: 'deepcrown', count: 10 }, { template: 'tetherling', count: 40 },
      ],
    } as unknown as WorldConfig);
    for (let i = 0; i < 20; i++) sim.step(w);
    const c = w.cr.c;
    const W = w.preset.widthM, H = w.preset.heightM;
    // push some creatures onto and past the walls (positions the grid clamps into edge cells)
    for (let s = 0; s < w.cr.highWater; s += 7) {
      const m = s % 4;
      if (m === 0) c.posX[s] = -0.05 - (s % 5) * 0.01;
      else if (m === 1) c.posX[s] = W + 0.02 + (s % 3) * 0.01;
      else if (m === 2) c.posY[s] = H + 0.03;
      else c.posY[s] = -0.02;
    }
    let compared = 0;
    for (let t = 0; t < 3; t++) {
      const ctx = contextFor(w);
      const phases = w.brains.map((p) => p.c.phase.slice());
      senseTuning.cullGather = true;
      sense(w, ctx);
      const a = w.brains.map((p) => p.c.inputs.slice());
      w.brains.forEach((p, k) => p.c.phase.set(phases[k]!));
      senseTuning.cullGather = false;
      sense(w, ctx);
      senseTuning.cullGather = true;
      w.brains.forEach((p, k) => {
        const b = p.c.inputs;
        let diff = 0;
        for (let i = 0; i < b.length; i++) if (!Object.is(a[k]![i], b[i])) diff++;
        expect(diff).toBe(0);
        compared += b.length;
      });
      w.g.tick++;
    }
    expect(compared).toBeGreaterThan(1000);
  });
});
