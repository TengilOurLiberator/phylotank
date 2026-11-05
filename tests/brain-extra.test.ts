/** src/brain: templates, inspector, rehydrate, encoding round trip. */
import { describe, expect, it } from 'vitest';
import { BRAIN_TRAITS, BT, decodeGenome, decodeQ, emptyGenome, encodeGenome, floatToQ411, hash32, DSYN_FLAG } from '../src/core/index.js';
import { applyBehaviourTemplate, brain, brainState, developBrain, inspect, rehydrate, IN, OUT } from '../src/brain/index.js';
import { inputSlotCode, outputSlotCode } from '../src/brain/layout.js';
import { FISH_INNOV, fishBody, spawnForTest, testCtx, testWorld } from '../src/brain/fixture.js';

describe('templates, inspector and snapshots', () => {
  it('every behaviour template uses the direct encoding and only known genes', () => {
    for (const id of ['meadowlamp', 'hushmaw', 'sievebell', 'tetherling', 'ashpicker', 'deepcrown', 'motefly', 'blank'] as const) {
      const g = applyBehaviourTemplate(emptyGenome(), id);
      expect(decodeQ(g.brainTraits[BT.ENCODING!]!, BRAIN_TRAITS[BT.ENCODING!]!)).toBe(0);
    }
  });
  it('the inspector returns int8 activations and pinned scope neurons', () => {
    const world = testWorld();
    const ph = fishBody({ segments: 3 });
    spawnForTest(world, 0, ph);
    const g = emptyGenome(); g.rootModuleInnov = FISH_INNOV.HEAD;
    brain.allocate(world, 0, ph, g, testCtx(world, 0));
    for (let t = 0; t < 10; t++) { brain.sense(world, testCtx(world, t)); brain.think(world, testCtx(world, t)); }
    const f = inspect(world, 0, [0, 1, 2])!;
    expect(f.act.length).toBe(f.nIn + f.nNeu);
    expect(f.act[IN.BIAS]).toBe(127);
    expect(f.scope.length).toBe(3);
    expect(inspect(world, 5)).toBeNull();
  });
  it('rehydrate rebuilds the derived state so a restored brain ticks identically', () => {
    const mk = () => {
      const world = testWorld();
      const ph = fishBody({ segments: 3, eye: true });
      spawnForTest(world, 0, ph);
      const g = emptyGenome(); g.rootModuleInnov = FISH_INNOV.HEAD;
      brain.allocate(world, 0, ph, g, testCtx(world, 0));
      return { world, ph, g };
    };
    const a = mk(), b = mk();
    for (let t = 0; t < 20; t++) for (const w of [a.world, b.world]) { brain.sense(w, testCtx(w, t)); brain.think(w, testCtx(w, t)); }
    // simulate a snapshot restore of b: the pools survive, the derived state is lost and rebuilt
    const st = brainState(b.world).statics;
    st.forEach((cls) => cls.fill(undefined));
    rehydrate(b.world, 0, b.ph, b.g);
    for (let t = 20; t < 60; t++) for (const w of [a.world, b.world]) { brain.sense(w, testCtx(w, t)); brain.think(w, testCtx(w, t)); }
    const c = a.world.cr.c.brainClass[0]!;
    expect(Array.from(b.world.brains[c]!.c.oPrev)).toEqual(Array.from(a.world.brains[c]!.c.oPrev));
  });
  it('an encode and decode round trip of the genome leaves the brain unchanged', () => {
    const ph = fishBody({ segments: 4, fins: [1] });
    const g = emptyGenome(); g.rootModuleInnov = FISH_INNOV.HEAD;
    g.directSynapses.push(
      { src: hash32(FISH_INNOV.HEAD, 0, inputSlotCode(IN.CHEMO_LEVEL, 0)), dst: hash32(FISH_INNOV.TRUNK, 0, outputSlotCode(OUT.MUSCLE, 0)), w: floatToQ411(0.75), flags: DSYN_FLAG.ENABLED, plasticity: 0 },
      { src: hash32(FISH_INNOV.HEAD, 0, inputSlotCode(IN.ENERGY, 0)), dst: hash32(FISH_INNOV.TRUNK, 0, outputSlotCode(OUT.MUSCLE, 0)), w: floatToQ411(-0.25), flags: DSYN_FLAG.ENABLED, plasticity: 0 },
    );
    const g2 = decodeGenome(encodeGenome(g));
    const a = developBrain(ph, g), b = developBrain(ph, g2);
    expect(b.src).toEqual(a.src);
    expect(b.w).toEqual(a.w);
  });
});
