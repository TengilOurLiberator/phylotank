/** src/brain: sensors, plasticity, CPPN properties and the governor divisor (03 §3.14 tests 6, 8, 9, 10). */
import { describe, expect, it } from 'vitest';
import {
  BRAIN_CLASSES, BRAIN_TRAITS, BT, DSYN_FLAG, KIND, ORGAN, emptyGenome, encodeQ, floatToQ411, hash32, packRGBA,
  type Genome, type World,
} from '../src/core/index.js';
import { brain, brainState, compileCppn, developBrain, hash64, IN, OUT, cppnInputId, cppnOutputId, CPPN_IN, CPPN_OUT } from '../src/brain/index.js';
import { inputSlotCode } from '../src/brain/layout.js';
import { etaOf } from '../src/brain/develop.js';
import { FISH_INNOV, fishBody, makePhenotype, spawnForTest, testCtx, testWorld } from '../src/brain/fixture.js';

function genome(set: Record<string, number> = {}): Genome {
  const g = emptyGenome();
  g.rootModuleInnov = FISH_INNOV.HEAD;
  for (const [k, v] of Object.entries({ SENSOR_NOISE: 0, EXPLORATION: 0, ...set })) g.brainTraits[BT[k]!] = encodeQ(v, BRAIN_TRAITS[BT[k]!]!);
  return g;
}

/** A head with one forward eye (v = 0), 160 degrees, 6 receptors, blue + green. */
function eyeBody(spectral = 0b00111111) {
  return makePhenotype(
    [{ kind: KIND.SEGMENT, subtype: 1, parent: -1, moduleInnov: 1, pathHash: 11, u: 0.5, organs: ORGAN.EYE }],
    [{ kind: 'eye', part: 0, u: 0.5, v: 0, d: 0, params: [0.01, 160, 6, spectral, 0.5] }],
  );
}

function inputsOf(world: World, slot: number): Float32Array {
  const c = world.cr.c.brainClass[slot]!, s = world.cr.c.brainSlot[slot]!;
  const I = BRAIN_CLASSES[c]!.i;
  return world.brains[c]!.c.inputs.subarray(s * I, s * I + I);
}

function place(world: World, slot: number, x: number, y: number, len: number, colour: number, glow: number): void {
  const ph = makePhenotype([{ kind: KIND.SEGMENT, parent: -1, moduleInnov: 9, pathHash: 9, u: 0.5 }], [], len);
  spawnForTest(world, slot, ph, x, y);
  world.cr.c.colour[slot] = colour;
  world.cr.c.glow[slot] = glow;
}

const BLUE = packRGBA(0, 0, 255);
const GREEN = packRGBA(0, 255, 0);
const RED = packRGBA(255, 0, 0);

describe('eyes (03 §3.14 test 10)', () => {
  const setup = (spectral?: number) => {
    const world = testWorld();
    const ph = eyeBody(spectral);
    spawnForTest(world, 0, ph, 10, 5);
    brain.allocate(world, 0, ph, genome(), testCtx(world, 0));
    return world;
  };
  const deg = Math.PI / 180;
  // receptor r covers bearings [-80 + r * 26.67, -80 + (r + 1) * 26.67) degrees; 30 degrees is receptor 4
  it('a glowing disc at bearing 30 degrees lands in receptor 4', () => {
    const world = setup();
    place(world, 1, 10 + 0.5 * Math.cos(30 * deg), 5 + 0.5 * Math.sin(30 * deg), 0.02, BLUE, 1);
    brain.sense(world, testCtx(world, 0));
    const inp = inputsOf(world, 0);
    const lanes = 3;
    for (let r = 0; r < 6; r++) {
      const blue = inp[18 + r * lanes]!, prox = inp[18 + r * lanes + 2]!;
      if (r === 4) { expect(blue).toBeGreaterThan(0.1); expect(prox).toBeGreaterThan(0); }
      else { expect(blue).toBe(0); expect(prox).toBe(0); }
    }
  });
  it('a nearer object occludes a farther one in the same receptor', () => {
    const world = setup();
    place(world, 1, 10 + 0.8 * Math.cos(30 * deg), 5 + 0.8 * Math.sin(30 * deg), 0.08, BLUE, 1);
    place(world, 2, 10 + 0.3 * Math.cos(30 * deg), 5 + 0.3 * Math.sin(30 * deg), 0.08, GREEN, 1);
    brain.sense(world, testCtx(world, 0));
    const inp = inputsOf(world, 0);
    expect(inp[18 + 4 * 3]!).toBe(0); // blue lane: the green one is in front
    expect(inp[18 + 4 * 3 + 1]!).toBeGreaterThan(0.1);
  });
  it('objects outside the field of view are invisible', () => {
    const world = setup();
    place(world, 1, 9.5, 5, 0.08, BLUE, 1);
    brain.sense(world, testCtx(world, 0));
    expect(Array.from(inputsOf(world, 0).subarray(18, 36)).every((v) => v === 0)).toBe(true);
  });
  it('red emission is invisible to a blue-green eye but seen by a red eye', () => {
    const world = setup();
    place(world, 1, 10.5, 5, 0.08, RED, 1);
    brain.sense(world, testCtx(world, 0));
    const inp = inputsOf(world, 0);
    // bearing 0 is the boundary of receptors 2 and 3: colour lanes stay 0, proximity sees the shape
    for (let r = 0; r < 6; r++) { expect(inp[18 + r * 3]!).toBe(0); expect(inp[18 + r * 3 + 1]!).toBe(0); }
    const w2 = setup(0b11000000);
    place(w2, 1, 10.5, 5, 0.08, RED, 1);
    brain.sense(w2, testCtx(w2, 0));
    const red = inputsOf(w2, 0);
    expect(Math.max(red[18 + 2 * 2]!, red[18 + 3 * 2]!)).toBeGreaterThan(0.1);
  });
});

describe('lateral line and smell', () => {
  it('lateral line falls off with distance and is deafened by own speed', () => {
    const measure = (dist: number, ownSpeed = 0): number => {
      const world = testWorld();
      const ph = fishBody({ segments: 1, eye: false, chemoMask: 0 });
      spawnForTest(world, 0, ph, 10, 5);
      world.cr.c.velX[0] = ownSpeed;
      brain.allocate(world, 0, ph, genome(), testCtx(world, 0));
      place(world, 1, 10, 5 - dist, 0.05, BLUE, 0);
      world.cr.c.velX[1] = 0.2 + ownSpeed;
      world.cr.c.massKg[1] = world.cr.c.massKg[0]!;
      brain.sense(world, testCtx(world, 0));
      const inp = inputsOf(world, 0);
      return Math.max(inp[18]!, inp[19]!);
    };
    const near = measure(0.04), far = measure(0.08);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
    expect(measure(0.04, 0.3)).toBeLessThan(near);
  });
  it('the smell rate is positive when swimming up a gradient', () => {
    const world = testWorld();
    const ph = fishBody({ segments: 1, chemoMask: 1 });
    spawnForTest(world, 0, ph, 10, 5);
    brain.allocate(world, 0, ph, genome(), testCtx(world, 0));
    const [w] = world.fields.coarse;
    for (let i = 0; i < world.fields.scent.length / 8; i++) world.fields.scent[i * 8] = (i % w) * 0.05;
    const rateIdx = (): number => {
      const L = brainState(world).statics[world.cr.c.brainClass[0]!]![world.cr.c.brainSlot[0]!]!.L;
      return L.inputs.findIndex((c) => c.kind === IN.CHEMO_RATE);
    };
    world.cr.c.velX[0] = 0.1;
    brain.sense(world, testCtx(world, 0));
    expect(inputsOf(world, 0)[rateIdx()]!).toBeGreaterThan(0);
    world.cr.c.velX[0] = -0.1;
    brain.sense(world, testCtx(world, 1));
    expect(inputsOf(world, 0)[rateIdx()]!).toBeLessThan(0);
  });
  it('sensor noise is deterministic and leaves BIAS at exactly 1', () => {
    const run = (): number[] => {
      const world = testWorld();
      const ph = fishBody({ segments: 2 });
      spawnForTest(world, 0, ph, 10, 5);
      brain.allocate(world, 0, ph, genome({ SENSOR_NOISE: 0.05 }), testCtx(world, 0));
      brain.sense(world, testCtx(world, 7));
      return Array.from(inputsOf(world, 0).subarray(0, 18));
    };
    const a = run(), b = run();
    expect(a).toEqual(b);
    expect(a[IN.BIAS]).toBe(1);
    expect(a[IN.HEALTH]).not.toBe(1);
  });
});

describe('plasticity (03 §3.14 test 9)', () => {
  const plasticGenome = (on: number): Genome => {
    const g = genome({ PLASTICITY_ON: on, ETA_SCALE: 1, RULE0_A: 1, RULE0_B: 0, RULE0_C: 0, RULE0_D: 0, RULE0_CH: 2 });
    // BIAS -> first head hidden neuron, plastic with rule 0 and eta code 15 (0.1)
    g.directSynapses.push({
      src: hash32(FISH_INNOV.HEAD, 0, inputSlotCode(IN.BIAS, 0)), dst: hash32(FISH_INNOV.HEAD, 0, 0x20200),
      w: floatToQ411(0.5), flags: DSYN_FLAG.ENABLED, plasticity: (15 << 2) | 0,
    });
    return g;
  };
  it('the ABCD rule gives dw = eta * m * A * post * pre on hand-set values', () => {
    const world = testWorld();
    const ph = fishBody({ segments: 1 });
    spawnForTest(world, 0, ph, 10, 5);
    brain.allocate(world, 0, ph, plasticGenome(0.5), testCtx(world, 0));
    const c = world.cr.c.brainClass[0]!, s = world.cr.c.brainSlot[0]!;
    const { n: N, k: K } = BRAIN_CLASSES[c]!;
    const st = brainState(world).statics[c]![s]!;
    expect(st.plastic).toBe(true);
    const h = st.L.base.head;
    const p = world.brains[c]!.c;
    const at = s * K * N + 0 * N + h;
    expect(p.synMeta[at]! & 4).toBe(4);
    brain.sense(world, testCtx(world, 0));
    brain.think(world, testCtx(world, 0));
    const post = p.o[s * N + h]!;
    // B, C, D decode to 1.5e-5 rather than 0 (u16 quantisation of [-1, 1]), hence the tolerance
    expect(Math.abs(p.synDw[at]! - etaOf(15) * 1 * post * 1)).toBeLessThan(1e-5);
    expect(Math.abs(p.synW[at]! + p.synDw[at]!)).toBeLessThanOrEqual(4);
  });
  it('with PLASTICITY_ON <= 0 nothing is plastic and no weight changes', () => {
    const world = testWorld();
    const ph = fishBody({ segments: 1 });
    spawnForTest(world, 0, ph, 10, 5);
    brain.allocate(world, 0, ph, plasticGenome(-0.5), testCtx(world, 0));
    const c = world.cr.c.brainClass[0]!;
    for (let t = 0; t < 30; t++) { brain.sense(world, testCtx(world, t)); brain.think(world, testCtx(world, t)); }
    expect(Array.from(world.brains[c]!.c.synDw).every((v) => v === 0)).toBe(true);
  });
  it('10,000 updates of 1e-4 accumulate in f32', () => {
    const a = new Float32Array(1);
    for (let i = 0; i < 10_000; i++) a[0] = a[0]! + 1e-4;
    expect(a[0]).toBeCloseTo(1, 3);
  });
});

describe('CPPN properties (03 §3.14 tests 6, 8)', () => {
  it('a CPPN that reads only |v| gives mirror-equal weights to left and right fins', () => {
    const parts = [
      { kind: KIND.SEGMENT, subtype: 1, parent: -1, moduleInnov: 1, pathHash: 1, u: 0.1, organs: ORGAN.LATERAL_LINE | ORGAN.TOUCH },
      { kind: KIND.SEGMENT, parent: 0, moduleInnov: 2, pathHash: 2, u: 0.5, organs: ORGAN.LATERAL_LINE | ORGAN.TOUCH, muscleFrac: 0.4 },
      { kind: KIND.FIN, parent: 1, moduleInnov: 3, pathHash: 3, u: 0.5, v: 0.6, dv: 1 },
      { kind: KIND.FIN, parent: 1, moduleInnov: 3, pathHash: 4, u: 0.5, v: -0.6, dv: -1 },
    ];
    const ph = makePhenotype(parts);
    const g = genome({ ENCODING: 1 });
    const conn = (from: number, to: number, w: number) => ({ innov: hash64(cppnInputId(from), cppnOutputId(to)), from: cppnInputId(from), to: cppnOutputId(to), w: floatToQ411(w), flags: 1 });
    g.cppnConns.push(conn(CPPN_IN.AVA, CPPN_OUT.W, 1.5), conn(CPPN_IN.AVB, CPPN_OUT.W, -0.7), conn(CPPN_IN.BIAS, CPPN_OUT.LEO, 1), conn(CPPN_IN.UA, CPPN_OUT.W, 0.9));
    const spec = developBrain(ph, g);
    const pitch = spec.L.outputs.map((c, j) => ({ c, j })).filter((x) => x.c.kind === OUT.FIN_PITCH).map((x) => x.j);
    expect(pitch.length).toBe(2);
    const [l, r] = pitch as [number, number];
    expect(spec.src[l]!.length).toBeGreaterThan(spec.nReflex[l]!);
    // same sources (sorted by unified index differ only in part-local neurons) and equal weights
    const glob = (j: number) => spec.src[j]!.map((s, k) => ({ s, w: spec.w[j]![k]! })).filter((x) => x.s < spec.L.nIn && spec.L.inputs[x.s]!.part < 0);
    expect(glob(l).map((x) => x.w)).toEqual(glob(r).map((x) => x.w));
  });
  it('innovation ids: the same structural mutation gets the same id; a cycle is ignored', () => {
    expect(hash64(5n, 9n)).toBe(hash64(5n, 9n));
    expect(hash64(5n, 9n)).not.toBe(hash64(9n, 5n));
    const g = genome({ ENCODING: 1 });
    const h = hash64(1n, 2n);
    g.cppnNodes.push({ innov: h, fn: 1, flags: 1, bias: 0 });
    g.cppnConns.push({ innov: 1n << 40n, from: cppnInputId(0), to: h, w: floatToQ411(1), flags: 1 });
    g.cppnConns.push({ innov: 2n << 40n, from: h, to: cppnOutputId(0), w: floatToQ411(1), flags: 1 });
    g.cppnConns.push({ innov: 3n << 40n, from: cppnOutputId(0), to: h, w: floatToQ411(1), flags: 1 });
    const c = compileCppn(g);
    expect(c.order.length).toBeGreaterThan(0);
    expect(c.inSrc.length).toBe(2);
  });
});

describe('brain rate divisor (CONTRACT 8.4)', () => {
  it('with brainDiv 2 a brain ticks on alternate ticks and its alpha follows dt_b', () => {
    const world = testWorld();
    const ph = fishBody({ segments: 2 });
    spawnForTest(world, 0, ph, 10, 5);
    brain.allocate(world, 0, ph, genome(), testCtx(world, 0));
    const c = world.cr.c.brainClass[0]!, s = world.cr.c.brainSlot[0]!;
    const N = BRAIN_CLASSES[c]!.n;
    const p = world.brains[c]!.c;
    const a1 = p.alpha[s * N + 0]!;
    world.g.brainDiv = 2;
    brain.think(world, testCtx(world, 1)); // (0 + 1) % 2 != 0: skipped, but alpha recomputed
    const a2 = p.alpha[s * N + 0]!;
    expect(a2).toBeGreaterThan(a1);
    expect(Math.abs((1 - a2) - (1 - a1) * (1 - a1))).toBeLessThan(1e-6);
    const before = Array.from(p.oPrev.subarray(s * N, s * N + N));
    brain.think(world, testCtx(world, 1));
    expect(Array.from(p.oPrev.subarray(s * N, s * N + N))).toEqual(before);
    brain.sense(world, testCtx(world, 2));
    brain.think(world, testCtx(world, 2));
    expect(Array.from(p.oPrev.subarray(s * N, s * N + N))).not.toEqual(before);
  });
});
