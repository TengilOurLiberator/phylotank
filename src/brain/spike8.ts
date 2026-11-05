/**
 * Spike 8 harness (README "First tasks"; review R15): direct versus CPPN encoding on a toy
 * swim-and-forage task, with forced duplications (brains E2) and the distribution of fitness
 * effects of single mutations (genome E8). Deterministic; the timing runner is
 * tests/brain-spike8.test.ts. Results: docs/spikes/brain-8.md.
 *
 * Toy kinematics (not physics): thrust is the travelling-wave signed area of adjacent trunk
 * muscle commands, c_i * dc_{i+1}/dt - c_{i+1} * dc_i/dt (positive when the wave runs head to
 * tail), plus fin stroke times pitch; turning rate follows the mean trunk bend. Units are body
 * lengths (BL) and seconds. Food is one item at a time; plant smell is log(1 + 5 exp(-d / 8)).
 */
import {
  BRAIN_CLASSES, BRAIN_TRAITS, BT, CPPN_FN, DT, KIND, RngStreams, cos, emptyGenome, encodeQ, exp, floatToQ411,
  hash32, log, q411ToFloat, sin, type CppnConnGene, type Draw, type Genome, type Phenotype, type World,
} from '../core/index.js';
import { cppnInputId, cppnOutputId, CPPN_N_IN, CPPN_N_OUT, hash64 } from './cppn.js';
import { developBrain, type BrainSpec } from './develop.js';
import { FISH_INNOV, fishBody, spawnForTest, testWorld } from './fixture.js';
import { IN } from './layout.js';
import { brainState } from './pool.js';
import { actBrain, tickBrain } from './think.js';
import { install } from './index.js';

export type Encoding = 'direct' | 'cppn';
export interface Geno { g: Genome; phaseStep: number; cpgAmp: number; enc: Encoding }
export interface BodyVariant { dupTrunk?: number; dupFin?: number }

export const N_TRUNK = 5;
export const FINS = [1];
export const TRIAL_S = 40;

const MUTABLE_BT = [
  'REFLEX_SWIM', 'REFLEX_GRAZE', 'REFLEX_INNATE_GAIT', 'REFLEX_HUNGER_SEEKS', 'ACTIVITY', 'F_LOW', 'F_HIGH',
  'TAU_SCALE', 'GAIN_CHEMO',
] as const;

export function setBT(g: Genome, name: string, v: number): void {
  const i = BT[name]!;
  g.brainTraits[i] = encodeQ(v, BRAIN_TRAITS[i]!);
}

export function baseGenome(enc: Encoding): Geno {
  const g = emptyGenome();
  g.rootModuleInnov = FISH_INNOV.HEAD;
  setBT(g, 'ENCODING', enc === 'cppn' ? 1 : 0);
  setBT(g, 'EXPLORATION', 0);
  setBT(g, 'SENSOR_NOISE', 0);
  setBT(g, 'HEAD_HIDDEN', 4);
  if (enc === 'cppn') {
    // minimal CPPN: bias -> leo at -1 expresses nothing, so generation 0 equals the reflex-only brain
    g.cppnConns.push({ innov: hash64(cppnInputId(37), cppnOutputId(1)), from: cppnInputId(37), to: cppnOutputId(1), w: floatToQ411(-1), flags: 1 });
  }
  return { g, phaseStep: -0.6, cpgAmp: 0.5, enc };
}

export function bodyOf(x: Geno, v: BodyVariant = {}): Phenotype {
  return fishBody({
    segments: N_TRUNK, fins: FINS, phaseStep: x.phaseStep, cpgAmp: x.cpgAmp, chemoMask: 1, eye: false,
    lateral: false, touch: false, mouth: false,
    ...(v.dupTrunk !== undefined ? { duplicateTrunk: v.dupTrunk } : {}),
    ...(v.dupFin !== undefined ? { duplicateFinOn: v.dupFin } : {}),
  });
}

function cloneGenome(g: Genome): Genome {
  return {
    ...g, traits: g.traits.slice(), brainTraits: g.brainTraits.slice(), modules: g.modules.map((m) => ({ ...m })),
    links: g.links.map((l) => ({ ...l })), regs: g.regs.map((r) => ({ ...r })), cppnNodes: g.cppnNodes.map((n) => ({ ...n })),
    cppnConns: g.cppnConns.map((c) => ({ ...c })), hiddenNeurons: g.hiddenNeurons.map((h) => ({ ...h })),
    directSynapses: g.directSynapses.map((d) => ({ ...d })), unknown: g.unknown,
  };
}
export function cloneGeno(x: Geno): Geno { return { ...x, g: cloneGenome(x.g) }; }

// ---------------- evaluation ----------------
interface Arena { world: World; ph: Phenotype; spec: BrainSpec }

/** Optionally zero every inbound synapse of the motors of the parts in `unwire` (the E2 control). */
export function buildArena(x: Geno, v: BodyVariant = {}, unwire: number[] = []): Arena {
  const world = testWorld(4);
  const ph = bodyOf(x, v);
  const spec = developBrain(ph, x.g);
  for (let j = 0; j < spec.L.count.motor; j++) {
    if (!unwire.includes(spec.L.outputs[j]!.part)) continue;
    spec.src[j] = []; spec.w[j] = []; spec.meta[j] = [];
  }
  spawnForTest(world, 0, ph, 10, 5, 1);
  if (!install(world, 0, ph, x.g, spec)) throw new Error('no brain slot');
  return { world, ph, spec };
}

/** Index of the new part a duplication adds (for the unwired control). */
export function newPartOf(x: Geno, v: BodyVariant): number {
  const ph = bodyOf(x, v);
  if (v.dupTrunk !== undefined) return 1 + N_TRUNK; // the extra trunk copy is the last trunk part
  for (let p = ph.nParts - 1; p >= 0; p--) if (ph.kind[p] === KIND.FIN) return p;
  return -1;
}

export function trialFood(seed: number, k: number): [number, number] {
  const r = new RngStreams(seed, 77).draw(200, k, 1);
  const a = r.u01() * 2 * Math.PI;
  const d = 5 + r.u01() * 7;
  return [d * cos(a), d * sin(a)];
}

export function evaluate(x: Geno, trials: number[], v: BodyVariant = {}, unwire: number[] = []): number {
  let total = 0;
  for (const t of trials) total += runTrial(buildArena(x, v, unwire), t);
  return total / trials.length;
}

export const lastStats = { meanSpeed: 0, meanThrust: 0, meanBend: 0, eaten: 0, dEnd: 0, freq: 0 };
export function runTrial(a: Arena, seed: number): number {
  const { world, ph, spec } = a;
  const c = world.cr.c.brainClass[0]!, s = world.cr.c.brainSlot[0]!;
  const st = brainState(world).statics[c]![s]!;
  const I = BRAIN_CLASSES[c]!.i;
  const inp = world.brains[c]!.c.inputs;
  const L = spec.L;
  const chem = L.chemos[0]!;
  const trunk: number[] = [];
  const fins: number[] = [];
  for (let p = 0; p < ph.nParts; p++) {
    if (ph.kind[p] === KIND.SEGMENT && ph.parent[p]! >= 0) trunk.push(p);
    if (ph.kind[p] === KIND.FIN) fins.push(p);
  }
  // trunk parts in chain order (the duplicate is appended but sits after its original)
  trunk.sort((p, q) => ph.u[p]! - ph.u[q]!);
  const seg = world.seg.c;
  const s0 = world.cr.c.segStart[0]!;
  const prev = new Float64Array(ph.nParts);
  let x = 0, y = 0, h = 0, v = 0;
  let k = 0;
  let [fx, fy] = trialFood(seed, k);
  let lastLevel = 0;
  let eaten = 0;
  let effort = 0;
  const d0 = Math.sqrt(fx * fx + fy * fy);
  const ticks = Math.round(TRIAL_S / DT);
  const tickZero = seed * 100_000;
  for (let t = 0; t < ticks; t++) {
    const dx = fx - x, dy = fy - y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const level = log(1 + 5 * exp(-d / 8));
    const rate = t === 0 ? 0 : Math.max(-1, Math.min(1, (5 * (level - lastLevel)) / DT));
    lastLevel = level;
    const bI = s * I;
    inp[bI + IN.BIAS] = 1;
    inp[bI + IN.ENERGY] = 0.5;
    inp[bI + IN.GUT] = 0.2;
    inp[bI + IN.HEALTH] = 1;
    inp[bI + IN.MATURE] = 1;
    inp[bI + chem.base] = level;
    inp[bI + chem.base + 1] = rate;
    tickBrain(world, c, s, st, tickZero + t, DT, 1, 2);
    actBrain(world, c, s, st, DT);
    // kinematics
    let thrust = 0, bend = 0;
    for (let i = 0; i < trunk.length; i++) {
      const p = trunk[i]!;
      const cp = seg.cmd[s0 + p]!;
      bend += cp;
      effort += cp * cp * DT;
      if (i + 1 < trunk.length) {
        const q = trunk[i + 1]!;
        const cq = seg.cmd[s0 + q]!;
        thrust += (cp * (cq - prev[q]!) - cq * (cp - prev[p]!)) / DT;
      }
    }
    for (const p of fins) {
      const cs = seg.cmd[s0 + p]!;
      thrust += -((cs - prev[p]!) / DT) * seg.cmd2[s0 + p]! * 0.5;
      effort += cs * cs * DT;
    }
    for (const p of trunk) prev[p] = seg.cmd[s0 + p]!;
    for (const p of fins) prev[p] = seg.cmd[s0 + p]!;
    bend /= Math.max(1, trunk.length);
    lastStats.meanSpeed += v / ticks; lastStats.meanThrust += thrust / ticks; lastStats.meanBend += Math.abs(bend) / ticks;
    v += (0.15 * thrust - 1.0 * v) * DT;
    if (v < -0.3) v = -0.3;
    h += 3 * bend * DT;
    x += v * cos(h) * DT;
    y += v * sin(h) * DT;
    if (d < 2) {
      eaten++;
      const [nx, ny] = trialFood(seed, ++k);
      fx = x + nx; fy = y + ny;
    }
  }
  const dEnd = Math.sqrt((fx - x) * (fx - x) + (fy - y) * (fy - y));
  lastStats.eaten = eaten; lastStats.dEnd = dEnd;
  const nextD = k === 0 ? d0 : 8.5;
  return eaten + 0.5 * Math.max(-1, 1 - dEnd / nextD) - 0.001 * effort;
}

// ---------------- mutation operators (spike-local; src/genome owns the real ones) ----------------
function normal(r: Draw): number { return r.normal(); }

function sourceKeys(x: Geno): number[] {
  const L = developBrain(bodyOf(x), x.g).L;
  const keys = new Set<number>();
  for (let i = 0; i < L.nIn; i++) keys.add(L.inModKey[i]!);
  for (let n = 0; n < L.nNeurons; n++) keys.add(L.neuModKey[n]!);
  return [...keys].sort((a, b) => a - b);
}
function destKeys(x: Geno): number[] {
  const L = developBrain(bodyOf(x), x.g).L;
  const keys = new Set<number>();
  for (let n = 0; n < L.nNeurons; n++) if (n < L.base.osc || n >= L.base.osc + L.count.osc) keys.add(L.neuModKey[n]!);
  return [...keys].sort((a, b) => a - b);
}

/** One mutation event. Returns its operator name. */
export function mutateOnce(x: Geno, r: Draw): string {
  const u = r.u01();
  if (u < 0.25) {
    const name = MUTABLE_BT[r.int(MUTABLE_BT.length)]!;
    const i = BT[name]!;
    const spec = BRAIN_TRAITS[i]!;
    const q = g16(x.g.brainTraits[i]! + normal(r) * 0.05 * 65535);
    void spec;
    x.g.brainTraits[i] = q;
    return 'trait';
  }
  if (u < 0.35) {
    if (r.bool()) x.phaseStep = Math.max(-Math.PI, Math.min(Math.PI, x.phaseStep + normal(r) * 0.2));
    else x.cpgAmp = Math.max(0, Math.min(1, x.cpgAmp + normal(r) * 0.1));
    return 'body';
  }
  return x.enc === 'direct' ? mutateDirect(x, r, (u - 0.35) / 0.65) : mutateCppn(x, r, (u - 0.35) / 0.65);
}

function g16(v: number): number { return Math.max(0, Math.min(65535, Math.round(v))); }

function mutateDirect(x: Geno, r: Draw, u: number): string {
  const ds = x.g.directSynapses;
  if (ds.length > 0 && u < 0.55) {
    const d = ds[r.int(ds.length)]!;
    d.w = floatToQ411(Math.max(-4, Math.min(4, q411ToFloat(d.w) + normal(r) * 0.4)));
    return 'dsyn-weight';
  }
  if (ds.length > 0 && u < 0.62) { ds.splice(r.int(ds.length), 1); return 'dsyn-remove'; }
  if (ds.length >= 64) return 'none';
  const src = sourceKeys(x), dst = destKeys(x);
  ds.push({ src: src[r.int(src.length)]!, dst: dst[r.int(dst.length)]!, w: floatToQ411(normal(r) * 1), flags: 1, plasticity: 0 });
  return 'dsyn-add';
}

const HIDDEN_FNS = [CPPN_FN.TANH, CPPN_FN.SIN, CPPN_FN.GAUSS, CPPN_FN.ABS, CPPN_FN.LIN];

function mutateCppn(x: Geno, r: Draw, u: number): string {
  const g = x.g;
  const conns = g.cppnConns;
  if (u < 0.55) {
    const c = conns[r.int(conns.length)]!;
    c.w = floatToQ411(Math.max(-8, Math.min(8, q411ToFloat(c.w) + normal(r) * 0.4)));
    return 'cppn-weight';
  }
  if (u < 0.75 && conns.length < 192) {
    const nodes = [...Array.from({ length: CPPN_N_IN }, (_, i) => cppnInputId(i)), ...g.cppnNodes.map((n) => n.innov)];
    const targets = [...Array.from({ length: CPPN_N_OUT }, (_, o) => cppnOutputId(o)), ...g.cppnNodes.map((n) => n.innov)];
    const from = nodes[r.int(nodes.length)]!, to = targets[r.int(targets.length)]!;
    const innov = hash64(from, to);
    if (from !== to && !conns.some((c) => c.innov === innov)) {
      conns.push({ innov, from, to, w: floatToQ411(normal(r) * 1), flags: 1 });
      return 'cppn-add-conn';
    }
    return 'none';
  }
  if (u < 0.85 && g.cppnNodes.length < 32) {
    const c = conns[r.int(conns.length)]!;
    const k = BigInt(g.cppnNodes.filter((n) => n.innov === hash64(c.innov, 0n)).length);
    const id = hash64(c.innov, k);
    if (g.cppnNodes.some((n) => n.innov === id)) return 'none';
    c.flags = 0;
    g.cppnNodes.push({ innov: id, fn: HIDDEN_FNS[r.int(HIDDEN_FNS.length)]!, flags: 1, bias: 0 });
    const a: CppnConnGene = { innov: hash64(c.from, id), from: c.from, to: id, w: floatToQ411(1), flags: 1 };
    const b: CppnConnGene = { innov: hash64(id, c.to), from: id, to: c.to, w: c.w, flags: 1 };
    conns.push(a, b);
    return 'cppn-add-node';
  }
  if (u < 0.92) { const c = conns[r.int(conns.length)]!; c.flags ^= 1; return 'cppn-toggle'; }
  if (g.cppnNodes.length > 0) {
    const n = g.cppnNodes[r.int(g.cppnNodes.length)]!;
    n.fn = HIDDEN_FNS[r.int(HIDDEN_FNS.length)]!;
    return 'cppn-fn';
  }
  return 'none';
}

/** Steady mutation: 1 event, plus a second with probability 0.5. */
export function mutate(x: Geno, r: Draw): Geno {
  const y = cloneGeno(x);
  mutateOnce(y, r);
  if (r.bool()) mutateOnce(y, r);
  return y;
}

export interface EvoResult { best: Geno; bestFit: number[]; meanFit: number[] }

/** Truncation selection with elitism, deterministic from `seed`. */
export function evolve(enc: Encoding, seed: number, pop: number, gens: number, trials: number[]): EvoResult {
  const rng = new RngStreams(seed, 8);
  let popl: Geno[] = [];
  const base = baseGenome(enc);
  for (let i = 0; i < pop; i++) popl.push(i === 0 ? base : mutate(base, rng.draw(2, 0, i)));
  const bestFit: number[] = [], meanFit: number[] = [];
  let fits = popl.map((x) => evaluate(x, trials));
  for (let gen = 0; gen < gens; gen++) {
    const order = popl.map((_, i) => i).sort((a, b) => fits[b]! - fits[a]! || a - b);
    bestFit.push(fits[order[0]!]!);
    meanFit.push(fits.reduce((a, b) => a + b, 0) / fits.length);
    const elite = order.slice(0, Math.max(2, pop >> 2)).map((i) => popl[i]!);
    const eliteFit = order.slice(0, elite.length).map((i) => fits[i]!);
    const next: Geno[] = [...elite];
    const nextFit: number[] = [...eliteFit];
    let k = 0;
    while (next.length < pop) {
      const r = rng.draw(2, gen + 1, k++);
      const parent = elite[r.int(elite.length)]!;
      const child = mutate(parent, r);
      next.push(child);
      nextFit.push(evaluate(child, trials));
    }
    popl = next; fits = nextFit;
  }
  const order = popl.map((_, i) => i).sort((a, b) => fits[b]! - fits[a]! || a - b);
  bestFit.push(fits[order[0]!]!);
  return { best: popl[order[0]!]!, bestFit, meanFit };
}

/** Distribution of fitness effects of single mutation events (genome E8). */
export function dfe(x: Geno, n: number, trials: number[], seed: number): { rel: number[]; ops: string[] } {
  const f0 = evaluate(x, trials);
  const rel: number[] = [], ops: string[] = [];
  const rng = new RngStreams(seed, 9);
  for (let i = 0; i < n; i++) {
    const y = cloneGeno(x);
    const op = mutateOnce(y, rng.draw(3, 0, i));
    const f = evaluate(y, trials);
    rel.push((f - f0) / Math.max(1e-9, Math.abs(f0)));
    ops.push(op);
  }
  return { rel, ops };
}

/** A random direct brain (E1 control): n random DSYN genes of weight N(0, 2). */
export function randomDirect(seed: number, n: number): Geno {
  const x = baseGenome('direct');
  const r = new RngStreams(seed, 10).draw(4, 0, 0);
  const src = sourceKeys(x), dst = destKeys(x);
  for (let i = 0; i < n; i++) {
    x.g.directSynapses.push({ src: src[r.int(src.length)]!, dst: dst[r.int(dst.length)]!, w: floatToQ411(r.normal() * 2), flags: 1, plasticity: 0 });
  }
  // and random reflex gains
  for (const name of MUTABLE_BT) x.g.brainTraits[BT[name]!] = r.int(65536);
  return x;
}

export { hash32 };
