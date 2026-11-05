/**
 * Spike 8 runner (docs/spikes/brain-8.md). Skipped unless SPIKE8=1; SPIKE8_OUT names a JSON file
 * for the raw results. Timing uses performance.now, which is fine here (not sim code).
 */
import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import {
  baseGenome, bodyOf, buildArena, dfe, evaluate, evolve, lastStats, newPartOf, randomDirect, runTrial, type Encoding, type Geno,
} from '../src/brain/spike8.js';
import { developBrain, install, tickBrain, brainState, buildLayout } from '../src/brain/index.js';
import { fishBody, makePhenotype, spawnForTest, testCtx, testWorld } from '../src/brain/fixture.js';
import { brain } from '../src/brain/index.js';
import { BRAIN_CLASSES, DT, KIND } from '../src/core/index.js';

const ON = process.env.SPIKE8 === '1';
const MODE = process.env.SPIKE8_MODE ?? 'full';
const lines: string[] = [];
function log(...a: unknown[]): void { lines.push(a.join(' ')); writeFileSync(process.env.SPIKE8_LOG ?? '/dev/null', lines.join('\n') + '\n'); }

describe.skipIf(!ON)('spike 8', () => {
  it('calibrate', () => {
    if (MODE !== 'calib') return;
    for (const seed of [1, 2, 3]) {
      Object.assign(lastStats, { meanSpeed: 0, meanThrust: 0, meanBend: 0 });
      const f = runTrial(buildArena(baseGenome('direct')), seed);
      log('trial', seed, f.toFixed(3), JSON.stringify(lastStats));
    }
    const t0 = performance.now();
    log('direct base', evaluate(baseGenome('direct'), [1, 2, 3]), (performance.now() - t0).toFixed(0), 'ms');
    log('cppn base', evaluate(baseGenome('cppn'), [1, 2, 3]));
    for (let i = 0; i < 5; i++) log('random', evaluate(randomDirect(i, 30), [1, 2, 3]).toFixed(3));
    const t1 = performance.now();
    const r = evolve('direct', 1, 16, 5, [1, 2, 3]);
    log('evo', r.bestFit.map((x) => x.toFixed(2)).join(' '), (performance.now() - t1).toFixed(0), 'ms');
    void writeFileSync;
  }, 600_000);

  it('full', () => {
    if (MODE !== 'full') return;
    const seeds = (process.env.SPIKE8_SEEDS ?? '1,2,3').split(',').map(Number);
    const POP = Number(process.env.SPIKE8_POP ?? 24), GENS = Number(process.env.SPIKE8_GENS ?? 30);
    const train = [1, 2, 3, 4], test = [101, 102, 103, 104, 105, 106, 107, 108];
    const out: Record<string, unknown> = { POP, GENS, seeds, train, test };
    const median = (a: number[]): number => { const b = a.slice().sort((x, y) => x - y); return b.length % 2 ? b[b.length >> 1]! : (b[b.length / 2 - 1]! + b[b.length / 2]!) / 2; };
    // E1 (toy): reflex-only versus random direct brains
    const reflex = evaluate(baseGenome('direct'), test);
    const randoms = Array.from({ length: 20 }, (_, i) => evaluate(randomDirect(1000 + i, 30), test));
    out.e1 = { reflex, randomMedian: median(randoms), randomBetterThanReflex: randoms.filter((r) => r > reflex).length, nRandom: randoms.length };
    log('E1 reflex', reflex.toFixed(3), 'random median', median(randoms).toFixed(3), 'random > reflex', randoms.filter((r) => r > reflex).length, '/ 20');
    const runs: Record<string, unknown>[] = [];
    const bests: Record<Encoding, Geno[]> = { direct: [], cppn: [] };
    for (const enc of ['direct', 'cppn'] as Encoding[]) {
      for (const seed of seeds) {
        const t0 = performance.now();
        const r = evolve(enc, seed, POP, GENS, train);
        const wall = performance.now() - t0;
        const x = r.best;
        bests[enc].push(x);
        const base = evaluate(x, test);
        const dt = { dupTrunk: 2 }, df = { dupFin: 1 };
        const e2 = {
          base,
          dupTrunk: evaluate(x, test, dt), dupTrunkUnwired: evaluate(x, test, dt, [newPartOf(x, dt)]),
          dupFin: evaluate(x, test, df), dupFinUnwired: evaluate(x, test, df, [newPartOf(x, df)]),
        };
        const d = dfe(x, Number(process.env.SPIKE8_DFE ?? 150), test.slice(0, 4), seed);
        const cat = {
          lethal: d.rel.filter((v) => v < -0.5).length / d.rel.length,
          deleterious: d.rel.filter((v) => v >= -0.5 && v < -0.02).length / d.rel.length,
          neutral: d.rel.filter((v) => v >= -0.02 && v <= 0.02).length / d.rel.length,
          beneficial: d.rel.filter((v) => v > 0.02).length / d.rel.length,
          mean: d.rel.reduce((a, b) => a + b, 0) / d.rel.length, median: median(d.rel),
        };
        const byOp: Record<string, { n: number; mean: number; neutral: number }> = {};
        d.ops.forEach((op, i) => {
          const o = (byOp[op] ??= { n: 0, mean: 0, neutral: 0 });
          o.n++; o.mean += d.rel[i]!; if (Math.abs(d.rel[i]!) <= 0.02) o.neutral++;
        });
        for (const o of Object.values(byOp)) { o.mean /= o.n; o.neutral /= o.n; }
        const spec = developBrain(bodyOf(x), x.g);
        const run = {
          enc, seed, wallS: wall / 1000, curve: r.bestFit, trainFinal: r.bestFit[r.bestFit.length - 1], test: base, e2, dfe: cat, byOp,
          nSyn: spec.nSyn, nDsyn: x.g.directSynapses.length, nCppnConns: x.g.cppnConns.length, nCppnNodes: x.g.cppnNodes.length,
          phaseStep: x.phaseStep, cpgAmp: x.cpgAmp,
        };
        runs.push(run);
        log(enc, seed, 'train', (run.trainFinal as number).toFixed(3), 'test', base.toFixed(3), 'curve', r.bestFit.filter((_, i) => i % 5 === 0).map((v) => v.toFixed(2)).join(' '),
          'E2', JSON.stringify(Object.fromEntries(Object.entries(e2).map(([k, v]) => [k, +v.toFixed(3)]))),
          'DFE', JSON.stringify(Object.fromEntries(Object.entries(cat).map(([k, v]) => [k, +v.toFixed(3)]))), 'wall', (wall / 1000).toFixed(1), 's');
      }
    }
    out.runs = runs;
    // development time per birth
    const bodies = {
      microbe: makePhenotype([{ kind: KIND.SEGMENT, subtype: 1, parent: -1, moduleInnov: 1, pathHash: 7, u: 0.5 }]),
      fish: bodyOf(bests.direct[0]!),
      big: fishBody({ segments: 30, fins: [2, 5, 9, 14, 20, 25], eye: true, chemoMask: 0b10011 }),
    };
    const dev: Record<string, Record<string, number>> = {};
    for (const [name, ph] of Object.entries(bodies)) {
      dev[name] = {};
      for (const enc of ['direct', 'cppn'] as Encoding[]) {
        const g = bests[enc][0]!.g;
        for (let i = 0; i < 20; i++) developBrain(ph, g);
        const n = name === 'big' ? 100 : 400;
        const t0 = performance.now();
        for (let i = 0; i < n; i++) developBrain(ph, g);
        dev[name]![enc] = ((performance.now() - t0) / n) * 1000;
        const t1 = performance.now();
        for (let i = 0; i < n; i++) buildLayout(ph, g);
        dev[name]![`${enc}Layout`] = ((performance.now() - t1) / n) * 1000;
        const sp = developBrain(ph, g);
        dev[name]![`${enc}Class`] = sp.cls;
        dev[name]![`${enc}Neurons`] = sp.L.nNeurons;
        dev[name]![`${enc}Inputs`] = sp.L.nIn;
      }
    }
    out.devMicros = dev;
    log('dev us/birth', JSON.stringify(dev));
    // think cost: one C4 brain tick, and sense + think for a crowd of fish
    {
      const world = testWorld(64);
      const ph = fishBody({ segments: 60, fins: [2, 5, 9, 14, 20, 25, 30, 40], eye: true, chemoMask: 0xff });
      spawnForTest(world, 0, ph, 10, 5, 1);
      const sp = developBrain(ph, bests.cppn[0]!.g);
      install(world, 0, ph, bests.cppn[0]!.g, sp);
      const c = world.cr.c.brainClass[0]!, s = world.cr.c.brainSlot[0]!;
      const st = brainState(world).statics[c]![s]!;
      for (let i = 0; i < 200; i++) tickBrain(world, c, s, st, i, DT, 1, 2);
      const n = 5000;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) tickBrain(world, c, s, st, i, DT, 1, 2);
      const us = ((performance.now() - t0) / n) * 1000;
      const slots = BRAIN_CLASSES[c]!.k * sp.L.nNeurons;
      out.c4Tick = { cls: c, neurons: sp.L.nNeurons, inputs: sp.L.nIn, synapseSlots: slots, usPerTick: us, msynPerS: slots / us };
      log('C4 tick', JSON.stringify(out.c4Tick));
    }
    {
      const nFish = 1000;
      const world = testWorld(2048);
      const ph = fishBody({ segments: 5, fins: [1], eye: true, chemoMask: 0b10011 });
      const g = bests.direct[0]!.g;
      for (let i = 0; i < nFish; i++) {
        spawnForTest(world, i, ph, 1 + (i % 50) * 0.6, 1 + Math.floor(i / 50) * 0.8, i + 1);
        world.cr.c.glow[i] = 0.4; world.cr.c.colour[i] = 0xff80c0ff;
        brain.allocate(world, i, ph, g, testCtx(world, 0));
      }
      for (let t = 0; t < 5; t++) { const ctx = testCtx(world, t); brain.sense(world, ctx); brain.think(world, ctx); }
      const T = 60;
      let tSense = 0, tThink = 0;
      for (let t = 5; t < 5 + T; t++) {
        const ctx = testCtx(world, t);
        const a = performance.now(); brain.sense(world, ctx); const b = performance.now(); brain.think(world, ctx); const e = performance.now();
        tSense += b - a; tThink += e - b;
      }
      out.crowd = { nFish, cls: world.cr.c.brainClass[0], senseMsPerTick: tSense / T, thinkMsPerTick: tThink / T };
      log('crowd', JSON.stringify(out.crowd));
    }
    if (process.env.SPIKE8_OUT) writeFileSync(process.env.SPIKE8_OUT, JSON.stringify(out, null, 1));
  }, 7_200_000);
});
