/**
 * Cross-engine determinism probe (README acceptance: the CPU reference tick is bit-identical
 * across Node and Chromium). Builds a small world of brained fish, runs sense and think, and
 * returns the state hash as hex. Run by tests/e2e/brain-crossengine.cjs in both engines.
 */
import { hashWorld, toHex64, floatToQ411, hash32, DSYN_FLAG, emptyGenome } from '../core/index.js';
import { brain } from './index.js';
import { FISH_INNOV, fishBody, spawnForTest, testCtx, testWorld } from './fixture.js';
import { IN, OUT, inputSlotCode, outputSlotCode } from './layout.js';

export function brainProbe(ticks = 300): string {
  const world = testWorld(64, 0x1234, 0x5678);
  const [w] = world.fields.coarse;
  for (let i = 0; i < world.fields.scent.length / 8; i++) world.fields.scent[i * 8] = ((i % w) * 0.013) % 1;
  world.fields.light.fill(0.4);
  for (let i = 0; i < 24; i++) {
    const ph = fishBody({ segments: 2 + (i % 5), fins: [1], eye: true, chemoMask: 0b10011, photophore: i % 3 === 0 });
    spawnForTest(world, i, ph, 4 + (i % 6) * 0.07, 4 + Math.floor(i / 6) * 0.05, 100 + i);
    world.cr.c.velX[i] = 0.01 * (i % 4);
    world.cr.c.glow[i] = 0.2 + 0.03 * i;
    world.cr.c.colour[i] = (0xff102030 + i * 0x00050709) >>> 0;
    const g = emptyGenome();
    g.rootModuleInnov = FISH_INNOV.HEAD;
    g.directSynapses.push({
      src: hash32(FISH_INNOV.HEAD, 0, inputSlotCode(IN.CHEMO_RATE, 0)),
      dst: hash32(FISH_INNOV.TRUNK, 0, outputSlotCode(OUT.MUSCLE, 0)), w: floatToQ411(0.8), flags: DSYN_FLAG.ENABLED, plasticity: 0,
    });
    brain.allocate(world, i, ph, g, testCtx(world, 0));
  }
  for (let t = 0; t < ticks; t++) {
    const ctx = testCtx(world, t);
    brain.sense(world, ctx);
    brain.think(world, ctx);
    // a crude stand-in for physics so the senses see motion: drift along the heading
    for (let i = 0; i < 24; i++) {
      world.cr.c.heading[i] = world.cr.c.heading[i]! + 0.05 * world.cr.c.out[i * 8 + OUT.CPG_TURN]!;
      world.cr.c.posX[i] = world.cr.c.posX[i]! + 0.002 * world.cr.c.out[i * 8 + OUT.CPG_AMP]!;
    }
  }
  return toHex64(hashWorld(world));
}
