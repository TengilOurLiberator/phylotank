/** src/brain unit and correctness tests (03 §3.14, CONTRACT 8). */
import { describe, expect, it } from 'vitest';
import {
  BRAIN_CLASSES, BT, BRAIN_TRAITS, DSYN_FLAG, DT, KIND, NEURON_KIND, NONE_U32, ORGAN, emptyGenome, encodeQ,
  exp, floatToQ411, hash32, hashWorld, type Genome,
} from '../src/core/index.js';
import { brain, brainCostW, buildLayout, developBrain, IN, OUT, brainState } from '../src/brain/index.js';
import { inputSlotCode, outputSlotCode } from '../src/brain/layout.js';
import { FISH_INNOV, fishBody, makePhenotype, spawnForTest, testCtx, testWorld } from '../src/brain/fixture.js';

function genome(set: Record<string, number> = {}): Genome {
  const g = emptyGenome();
  g.rootModuleInnov = FISH_INNOV.HEAD;
  for (const [k, v] of Object.entries(set)) g.brainTraits[BT[k]!] = encodeQ(v, BRAIN_TRAITS[BT[k]!]!);
  return g;
}

function step(world: ReturnType<typeof testWorld>, from: number, n: number): void {
  for (let t = from; t < from + n; t++) {
    const ctx = testCtx(world, t);
    brain.sense(world, ctx);
    brain.think(world, ctx);
  }
}

describe('layout (CONTRACT 8.1)', () => {
  const ph = fishBody({ segments: 4, fins: [1], eye: true, chemoMask: 0b10011 });
  const L = buildLayout(ph, genome());
  it('global inputs and outputs come first in contract order', () => {
    for (let k = 0; k < 18; k++) expect(L.inputs[k]).toMatchObject({ kind: k, part: -1 });
    for (let k = 0; k < 8; k++) expect(L.outputs[k]).toMatchObject({ kind: k, part: -1 });
  });
  it('neurons are motors, 6 drives, 2 modulators, oscillators, head, ganglia, in that order', () => {
    const kinds = Array.from(L.neuronKind);
    expect(kinds.slice(0, L.outputs.length).every((k) => k === NEURON_KIND.MOTOR)).toBe(true);
    expect(kinds.slice(L.base.drive, L.base.drive + 6).every((k) => k === NEURON_KIND.DRIVE)).toBe(true);
    expect(kinds.slice(L.base.mod, L.base.mod + 2).every((k) => k === NEURON_KIND.MODULATOR)).toBe(true);
    const order = kinds.filter((k, i) => i === 0 || k !== kinds[i - 1]);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    // 5 segments (head + 4 trunk) + 1 fin oscillator with the default genes
    expect(L.count.osc).toBe(6);
  });
  it('eye inputs are R x (C + 1), chemo level then rate per masked channel', () => {
    const eye = L.inputs.filter((c) => c.kind === IN.EYE);
    expect(eye.length).toBe(6 * 3); // spectral 0b00111111: blue and green
    const chemo = L.inputs.filter((c) => c.kind === IN.CHEMO_LEVEL || c.kind === IN.CHEMO_RATE).map((c) => [c.kind, c.slot]);
    expect(chemo).toEqual([[IN.CHEMO_LEVEL, 0], [IN.CHEMO_RATE, 0], [IN.CHEMO_LEVEL, 1], [IN.CHEMO_RATE, 1], [IN.CHEMO_LEVEL, 4], [IN.CHEMO_RATE, 4]]);
  });
  it('one muscle per non-root muscled part and per fin, fin pitch, three mouth motors', () => {
    const k = L.outputs.slice(8).map((c) => c.kind);
    expect(k.filter((x) => x === OUT.MUSCLE).length).toBe(5);
    expect(k.filter((x) => x === OUT.FIN_PITCH).length).toBe(1);
    expect(k.filter((x) => x === OUT.MOUTH_OPEN || x === OUT.BITE || x === OUT.LATCH).length).toBe(3);
  });
  it('stable ids: hash32(moduleInnov, pathHash, slot); unrelated parts keep their ids after a duplication', () => {
    const fin = L.outputs.find((c) => c.kind === OUT.FIN_PITCH)!;
    expect(fin.key).toBe(hash32(ph.moduleInnov[fin.part]!, ph.pathHash[fin.part]!, outputSlotCode(OUT.FIN_PITCH, 0)));
    const L2 = buildLayout(fishBody({ segments: 4, fins: [1], eye: true, chemoMask: 0b10011, duplicateFinOn: 2 }), genome());
    const keys2 = new Set(L2.outputs.map((c) => c.key));
    for (const c of L.outputs) expect(keys2.has(c.key)).toBe(true);
    expect(L.inputs[IN.ENERGY]!.key).toBe(hash32(FISH_INNOV.HEAD, 0, inputSlotCode(IN.ENERGY, 0)));
  });
  it('picks the smallest class that fits; a microbe with no actuator fits C0', () => {
    const microbe = makePhenotype([{ kind: KIND.SEGMENT, subtype: 1, parent: -1, moduleInnov: 1, pathHash: 7, u: 0.5 }]);
    const Lm = buildLayout(microbe, genome({ HEAD_HIDDEN: 0, HIDDEN_PER_SEGMENT: 0, OSC_PER_SEGMENT: -1 }));
    expect(Lm.nNeurons).toBe(16);
    expect(Lm.sizeClass).toBe(0);
    expect(L.sizeClass).toBe(2);
  });
});

describe('trimming and caps (03 §3.14 test 7)', () => {
  it('an input-heavy body trims inputs only and keeps its ganglia and oscillators', () => {
    const ph = fishBody({ segments: 40, fins: [2, 5, 9], eye: true, chemoMask: 0xff });
    const L = buildLayout(ph, genome({ HIDDEN_PER_SEGMENT: 2 }));
    expect(L.nIn).toBeLessThanOrEqual(192);
    expect(L.count.gang).toBe(41 * 2);
    expect(L.count.osc).toBeGreaterThan(40);
    expect(L.trims.some((t) => t.startsWith('ganglia') || t.startsWith('oscillators'))).toBe(false);
    expect(L.trims.some((t) => t.startsWith('eye') || t.startsWith('part inputs'))).toBe(true);
  });
  it('random large bodies always fit a class and never reference an out-of-range source', () => {
    let seed = 12345;
    const rnd = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    for (let trial = 0; trial < 150; trial++) {
      const nSeg = 1 + Math.floor(rnd() * 40);
      const fins = Array.from({ length: Math.floor(rnd() * 20) }, () => Math.floor(rnd() * nSeg));
      const ph = fishBody({ segments: nSeg, fins, eye: rnd() < 0.7, chemoMask: Math.floor(rnd() * 256) });
      const g = genome({ HEAD_HIDDEN: Math.floor(rnd() * 65), HIDDEN_PER_SEGMENT: Math.floor(rnd() * 9) });
      const spec = developBrain(ph, g);
      const k = BRAIN_CLASSES[spec.cls]!;
      expect(spec.L.nNeurons).toBeLessThanOrEqual(k.n);
      expect(spec.L.nIn).toBeLessThanOrEqual(k.i);
      for (const row of spec.src) {
        expect(row.length).toBeLessThanOrEqual(k.k);
        for (const s of row) expect(s).toBeLessThan(spec.L.nIn + spec.L.nNeurons);
      }
    }
  });
});

describe('CTRNN and oscillators (03 §3.14 tests 1, 2)', () => {
  it('a neuron step response follows 1 - exp(-t/tau) within 1e-5', () => {
    for (const tau of [0.05, 1, 60]) {
      const world = testWorld();
      const ph = fishBody({ segments: 2 });
      spawnForTest(world, 0, ph);
      expect(brain.allocate(world, 0, ph, genome({ SENSOR_NOISE: 0, EXPLORATION: 0 }), testCtx(world, 0))).toBe(true);
      const c = world.cr.c.brainClass[0]!, s = world.cr.c.brainSlot[0]!;
      const { n: N, k: K } = BRAIN_CLASSES[c]!;
      const p = world.brains[c]!.c;
      const L = brainState(world).statics[c]![s]!.L;
      const h = L.base.head; // first head hidden neuron
      for (let k = 0; k < K; k++) { p.synSrc[s * K * N + k * N + h] = L.nIn + h; p.synW[s * K * N + k * N + h] = 0; }
      p.synSrc[s * K * N + h] = 0; // BIAS
      p.synW[s * K * N + h] = 1;
      brainState(world).statics[c]![s]!.rowLen[h] = 1;
      p.alpha[s * N + h] = 1 - exp(-DT / tau);
      p.theta[s * N + h] = 0;
      const ticks = Math.min(600, Math.round((3 * tau) / DT));
      step(world, 0, ticks);
      const expected = 1 - exp(-(ticks * DT) / tau);
      expect(Math.abs(p.y[s * N + h]! - expected)).toBeLessThan(1e-5);
    }
  });

  it('two coupled oscillators lock to their lag within 0.05 rad in 10 s (k >= 2)', () => {
    const world = testWorld();
    const ph = fishBody({ segments: 1, fins: [] });
    spawnForTest(world, 0, ph);
    brain.allocate(world, 0, ph, genome({ SENSOR_NOISE: 0, EXPLORATION: 0 }), testCtx(world, 0));
    const c = world.cr.c.brainClass[0]!, s = world.cr.c.brainSlot[0]!;
    const N = BRAIN_CLASSES[c]!.n;
    const p = world.brains[c]!.c;
    const L = brainState(world).statics[c]![s]!.L;
    expect(L.count.osc).toBe(2);
    const a = L.base.osc, b = a + 1;
    const lag = 0.7;
    // CONTRACT 8.3: k sin(phase[src] - phase - lag) settles at phase[src] - phase = lag
    p.osc.fill(-1, (s * N + a) * 12, (s * N + b + 1) * 12);
    for (let q = 0; q < 8; q++) p.osc[(s * N + a) * 12 + q * 3] = -1;
    p.osc.set([b, 3, lag], (s * N + a) * 12);
    p.osc.set([a, 3, -lag], (s * N + b) * 12);
    p.phase[s * N + a] = 2.5;
    p.phase[s * N + b] = -1;
    step(world, 0, 300);
    let d = p.phase[s * N + b]! - p.phase[s * N + a]!;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d <= -Math.PI) d += 2 * Math.PI;
    expect(Math.abs(d - lag)).toBeLessThan(0.05);
  });
});

describe('development (03 §3.14 tests 5, 9)', () => {
  it('a duplicated fin arrives wired: its muscle has the original fin muscle incoming weights', () => {
    const g = genome();
    // a module-keyed DSYN gene: plant smell level -> fin muscle (every fin instance)
    g.directSynapses.push({
      src: hash32(FISH_INNOV.HEAD, 0, inputSlotCode(IN.CHEMO_LEVEL, 0)),
      dst: hash32(FISH_INNOV.FIN, 0, outputSlotCode(OUT.MUSCLE, 0)), w: floatToQ411(1.25), flags: DSYN_FLAG.ENABLED, plasticity: 0,
    });
    const pha = fishBody({ segments: 4, fins: [1] }), phb = fishBody({ segments: 4, fins: [1], duplicateFinOn: 1 });
    const a = developBrain(pha, g);
    const b = developBrain(phb, g);
    const finMuscles = (s: typeof a, ph: typeof pha): number[] => s.L.outputs.map((ch, j) => ({ ch, j }))
      .filter((x) => x.ch.kind === OUT.MUSCLE && ph.kind[x.ch.part] === KIND.FIN).map((x) => x.j);
    const fa = finMuscles(a, pha), fb = finMuscles(b, phb);
    expect(fa.length).toBe(1);
    expect(fb.length).toBe(2);
    const sig = (s: typeof a, j: number): string => s.src[j]!.map((x, k) => `${srcKey(s, x)}:${s.w[j]![k]!.toFixed(6)}`).join(',');
    expect(sig(b, fb[0]!)).toBe(sig(a, fa[0]!));
    expect(sig(b, fb[1]!)).toBe(sig(a, fa[0]!));
    expect(a.w[fa[0]!]!).toContain(1.25);
  });

  it('per-instance DSYN genes reach only their instance', () => {
    const ph = fishBody({ segments: 3 });
    const g = genome();
    g.directSynapses.push({
      src: hash32(FISH_INNOV.HEAD, 0, inputSlotCode(IN.ENERGY, 0)),
      dst: hash32(FISH_INNOV.TRUNK, ph.pathHash[2]!, outputSlotCode(OUT.MUSCLE, 0)), w: floatToQ411(-0.5),
      flags: DSYN_FLAG.ENABLED | DSYN_FLAG.PER_INSTANCE, plasticity: 0,
    });
    const s = developBrain(ph, g);
    const withGene = s.L.outputs.map((ch, j) => j).filter((j) => s.w[j]!.includes(-0.5));
    expect(withGene.length).toBe(1);
    expect(s.L.outputs[withGene[0]!]!.part).toBe(2);
  });

  it('development is deterministic and the CPPN encoding wires extra links', () => {
    const ph = fishBody({ segments: 4, fins: [1], eye: true });
    const g = genome({ ENCODING: 1 });
    g.cppnConns.push({ innov: 1000n, from: 38n, to: 40n, w: floatToQ411(2), flags: 1 }); // bias -> leo
    g.cppnConns.push({ innov: 1001n, from: 17n, to: 39n, w: floatToQ411(1), flags: 1 }); // u_b -> w
    const a = developBrain(ph, g), b = developBrain(ph, g);
    expect(a.nSyn).toBe(b.nSyn);
    expect(a.src).toEqual(b.src);
    const direct = developBrain(ph, genome());
    expect(a.nSyn).toBeGreaterThan(direct.nSyn);
  });
});

function srcKey(s: ReturnType<typeof developBrain>, x: number): string {
  return x < s.L.nIn ? `i${s.L.inputs[x]!.key}` : `n${s.L.neuModKey[x - s.L.nIn]}`;
}

describe('runtime (CONTRACT 8.3)', () => {
  it('ticks are deterministic: two worlds give the same hash', () => {
    const run = (): bigint => {
      const world = testWorld();
      for (let i = 0; i < 6; i++) {
        const ph = fishBody({ segments: 3 + i, fins: [1], eye: true });
        spawnForTest(world, i, ph, 5 + i * 0.3, 5 + i * 0.1);
        world.cr.c.glow[i] = 0.5;
        world.cr.c.colour[i] = 0xffffffff;
        brain.allocate(world, i, ph, genome(), testCtx(world, 0));
      }
      step(world, 0, 200);
      return hashWorld(world);
    };
    expect(run()).toBe(run());
  });

  it('writes muscles: the innate gait makes a travelling wave on cmd', () => {
    const world = testWorld();
    const ph = fishBody({ segments: 4, phaseStep: 0.9 });
    spawnForTest(world, 0, ph);
    brain.allocate(world, 0, ph, genome({ SENSOR_NOISE: 0, EXPLORATION: 0 }), testCtx(world, 0));
    let peak = 0;
    for (let t = 0; t < 120; t++) {
      step(world, t, 1);
      peak = Math.max(peak, Math.abs(world.seg.c.cmd[1]!));
    }
    expect(peak).toBeGreaterThan(0.3);
    expect(world.cr.c.brainW[0]).toBeGreaterThan(0);
  });

  it('MATE has hysteresis: on above 0.5, off below 0.2', () => {
    const world = testWorld();
    const ph = fishBody({ segments: 2 });
    spawnForTest(world, 0, ph);
    brain.allocate(world, 0, ph, genome({ SENSOR_NOISE: 0, EXPLORATION: 0 }), testCtx(world, 0));
    const c = world.cr.c.brainClass[0]!, s = world.cr.c.brainSlot[0]!;
    const N = BRAIN_CLASSES[c]!.n;
    const p = world.brains[c]!.c;
    const st = brainState(world).statics[c]![s]!;
    const setMate = (v: number): void => {
      p.theta[s * N + OUT.MATE] = Math.atanh(v);
      p.alpha[s * N + OUT.MATE] = 1;
      for (let k = 0; k < BRAIN_CLASSES[c]!.k; k++) p.synW[s * BRAIN_CLASSES[c]!.k * N + k * N + OUT.MATE] = 0;
    };
    const tick = (): number => { step(world, 0, 1); return world.cr.c.out[OUT.MATE]!; };
    void st;
    setMate(0.4); expect(tick()).toBe(0);
    setMate(0.6); expect(tick()).toBe(1);
    setMate(0.3); expect(tick()).toBe(1);
    setMate(0.1); expect(tick()).toBe(0);
  });

  it('NaN in a brain resets its state and counts a diagnostic', () => {
    const world = testWorld();
    const ph = fishBody({ segments: 2 });
    spawnForTest(world, 0, ph);
    brain.allocate(world, 0, ph, genome(), testCtx(world, 0));
    const c = world.cr.c.brainClass[0]!, s = world.cr.c.brainSlot[0]!;
    const N = BRAIN_CLASSES[c]!.n;
    world.brains[c]!.c.y[s * N + 9] = NaN;
    step(world, 0, 1);
    expect(brainState(world).nanResets).toBe(1);
    expect(Array.from(world.brains[c]!.c.y.subarray(s * N, s * N + N)).every((v) => v === 0)).toBe(true);
  });

  it('free returns the slot; a full class overflows to the next larger one', () => {
    const world = testWorld(32);
    const ph = fishBody({ segments: 2 });
    const own = developBrain(ph, genome()).cls;
    const cap = world.brains[own]!.capacity;
    const cls: number[] = [];
    for (let i = 0; i <= cap; i++) {
      spawnForTest(world, i, ph, 3 + i * 0.5, 3);
      expect(brain.allocate(world, i, ph, genome(), testCtx(world, 0))).toBe(true);
      cls.push(world.cr.c.brainClass[i]!);
    }
    expect(cls.filter((c) => c === own).length).toBe(cap);
    expect(cls[cap]).toBe(own + 1);
    brain.free(world, 3);
    expect(world.cr.c.brainSlot[3]).toBe(NONE_U32);
    spawnForTest(world, 3, ph, 3, 3);
    brain.allocate(world, 3, ph, genome(), testCtx(world, 0));
    expect(world.cr.c.brainSlot[3]).toBe(3);
  });

  it('brain cost follows CONTRACT 8.5', () => {
    const spec = developBrain(fishBody({ segments: 3 }), genome());
    expect(brainCostW(spec.L.nNeurons, spec.nSyn, spec.nPlastic)).toBeCloseTo(2e-9 * spec.L.nNeurons + 2e-10 * spec.nSyn, 15);
  });
});

void ORGAN;
