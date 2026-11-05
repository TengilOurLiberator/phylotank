/**
 * Mutation (01 §1.6, DESIGN R3, review R15, R22, CONTRACT 3.3, 6.8).
 *
 * - Self-adaptation first: MU_LOG, SIGMA and MU_STRUCT_RATIO take a log-normal-style step of
 *   META_RATE in x space (reflected at the bounds).
 * - Point mutations: Poisson(mu x nGenes), each picks one gene uniformly (traits, brain traits,
 *   module, link, regulatory, hidden-neuron, direct-synapse and CPPN genes) then one field.
 *   Brain genes share the per-gene rate, so a 30-gene brain sees about 0.15 perturbations per
 *   birth at the default rate, far below 03's 0.8 per connection (review R15).
 * - Structural events: Poisson(mu x MU_STRUCT_RATIO x nGenes), operator by weight.
 * - Repair, then the ceiling clamp for non-leviathans, then the 16 KB cap (an over-cap child is
 *   the parent unchanged).
 * The draw cursor is (stream MUTATION, tick, childId), so results do not depend on batch order.
 */
import {
  BRAIN_TRAITS, BRAIN_TRAIT_COUNT, DSYN_FLAG, GENOME_MAX_BYTES, KIND, KIND_COUNT, LINK_FLAG, LINK_RECORD,
  MODULE_FLAG, MODULE_RECORD, REG_AXIS, REG_PARAM_GATE, REG_RECORD, RNG_STREAM, TRAITS, TRAIT_COUNT,
  DIRECT_SYNAPSE_RECORD, HIDDEN_NEURON_RECORD, defaultRecord, encodeGenome, exp, hash32,
  type Draw, type Genome, type LinkGene, type ModuleGene, type MutationContext, type RegGene,
} from '../core/index.js';
import { DEEP_COPY_P, META_RATE, OP_WEIGHTS } from './constants.js';
import { BTI, SUBTYPE_COUNT, TI, cloneGenome, findModule, pow10, reflect01 } from './genes.js';
import { EVENT, InnovationRegistry, eventKey } from './registry.js';
import { repairInPlace } from './repair.js';
import { clampToCeiling } from './ceiling.js';
import { kindDefaults } from './kinds.js';

/** Traits and brain traits that point mutation may touch. */
const SELF_ADAPT = new Set([TI.MU_LOG, TI.SIGMA, TI.MU_STRUCT_RATIO]);
export const MUTABLE_TRAITS: readonly number[] = TRAITS.flatMap((s, i) => (s && i < TRAIT_COUNT && !SELF_ADAPT.has(i) ? [i] : []));
export const MUTABLE_BRAIN_TRAITS: readonly number[] = BRAIN_TRAITS.flatMap((s, i) => (s && i < BRAIN_TRAIT_COUNT && !s.immutable ? [i] : []));

/** Number of module-key slots copied when a duplicated module takes its synapses along. */
const KEY_SLOTS = 32;

// ---------------- RNG helpers ----------------
export function poisson(rng: Draw, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 60) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * rng.normal()));
  const L = exp(-lambda);
  let k = 0, p = 1;
  for (;;) { p *= rng.u01x53(); if (p <= L) return k; k++; }
}
const pick = <T>(rng: Draw, a: readonly T[]): T => a[rng.int(a.length)]!;

function stepU(q: number, qMax: number, sigma: number, rng: Draw, wrap = false): number {
  let x = q / qMax + sigma * rng.normal();
  if (wrap) { x -= Math.floor(x); } else x = reflect01(x);
  return Math.round(x * qMax);
}
function stepI8(q: number, sigma: number, rng: Draw): number {
  const x = reflect01((q + 128) / 255 + sigma * rng.normal());
  return Math.round(x * 255) - 128;
}
const clampI16 = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v)));

// ---------------- point mutation ----------------
type ModField = keyof ModuleGene;
const MOD_U16: ModField[] = ['length', 'width'];
const MOD_U8: ModField[] = ['span', 'taper', 'stiffness', 'lipidFraction', 'muscleFraction', 'gutFraction', 'armourCoverage',
  'glow', 'p1', 'p2', 'cpgPhase', 'cpgAmp', 'jointRange', 'allometry', 'p3', 'p4', 'p5', 'photoFraction'];
const MOD_I8: ModField[] = ['hueOffset', 'jointRest'];
const MOD_FIELDS: ModField[] = [...MOD_U16, ...MOD_U8, ...MOD_I8];

function isBitField(kind: number, f: ModField): boolean {
  return (kind === KIND.EYE && f === 'p4') || (kind === KIND.CHEMO && (f === 'p2' || f === 'p3'));
}

function mutateModule(m: ModuleGene, sigma: number, rng: Draw): void {
  const f = pick(rng, MOD_FIELDS);
  const rec = m as unknown as Record<string, number>;
  if (isBitField(m.kind, f)) { rec[f] = (rec[f]! ^ (1 << rng.int(8))) & 0xff; return; }
  if (MOD_U16.includes(f)) rec[f] = stepU(rec[f]!, 65535, sigma, rng);
  else if (MOD_I8.includes(f)) rec[f] = stepI8(rec[f]!, sigma, rng);
  else rec[f] = stepU(rec[f]!, 255, sigma, rng, f === 'cpgPhase');
}
function mutateLink(l: LinkGene, sigma: number, rng: Draw): void {
  switch (rng.int(5)) {
    case 0: l.attachPos = stepU(l.attachPos, 255, sigma, rng); break;
    case 1: l.attachAngle = stepI8(l.attachAngle, 0.5 * sigma, rng); break;
    case 2: l.childScale = stepU(l.childScale, 255, sigma, rng); break;
    case 3: l.repeatScale = stepU(l.repeatScale, 255, sigma, rng); break;
    default: l.phaseStep = stepU(l.phaseStep, 255, sigma, rng, true); break;
  }
}
function mutateReg(r: RegGene, sigma: number, rng: Draw): void {
  switch (rng.int(3)) {
    case 0: r.centre = stepU(r.centre, 255, sigma, rng); break;
    case 1: r.width = stepU(r.width, 255, sigma, rng); break;
    default: r.amount = Math.max(-127, stepI8(r.amount, sigma, rng)); break;
  }
}
function perturbWeight(w: number, sigma: number, rng: Draw): number {
  return rng.u01() < 0.9 ? clampI16(w + sigma * 4 * 2048 * rng.normal()) : clampI16(2048 * rng.normal());
}

function pointMutation(g: Genome, sigma: number, rng: Draw): void {
  const nT = MUTABLE_TRAITS.length, nB = MUTABLE_BRAIN_TRAITS.length;
  const sizes = [nT, nB, g.modules.length, g.links.length, g.regs.length, g.hiddenNeurons.length,
    g.directSynapses.length, g.cppnNodes.length, g.cppnConns.length];
  let total = 0;
  for (const s of sizes) total += s;
  let k = rng.int(total);
  let pool = 0;
  while (k >= sizes[pool]!) { k -= sizes[pool]!; pool++; }
  switch (pool) {
    case 0: { const i = MUTABLE_TRAITS[k]!; g.traits[i] = stepU(g.traits[i]!, 65535, sigma, rng); break; }
    case 1: { const i = MUTABLE_BRAIN_TRAITS[k]!; g.brainTraits[i] = stepU(g.brainTraits[i]!, 65535, sigma, rng); break; }
    case 2: mutateModule(g.modules[k]!, sigma, rng); break;
    case 3: mutateLink(g.links[k]!, sigma, rng); break;
    case 4: mutateReg(g.regs[k]!, sigma, rng); break;
    case 5: {
      const n = g.hiddenNeurons[k]!;
      if (rng.bool()) n.tau = stepU(n.tau, 255, sigma, rng); else n.bias = perturbWeight(n.bias, sigma, rng);
      break;
    }
    case 6: {
      const s = g.directSynapses[k]!;
      if (rng.u01() < 0.8) s.w = perturbWeight(s.w, sigma, rng); else s.plasticity = Math.max(-127, stepI8(s.plasticity, sigma, rng));
      break;
    }
    case 7: { const n = g.cppnNodes[k]!; n.bias = perturbWeight(n.bias, sigma, rng); break; }
    default: { const c = g.cppnConns[k]!; c.w = perturbWeight(c.w, sigma, rng); break; }
  }
}

export function countGenes(g: Genome): number {
  return MUTABLE_TRAITS.length + MUTABLE_BRAIN_TRAITS.length + g.modules.length + g.links.length + g.regs.length
    + g.hiddenNeurons.length + g.directSynapses.length + g.cppnNodes.length + g.cppnConns.length;
}

// ---------------- structural operators ----------------
export type OpName = keyof typeof OP_WEIGHTS;
const OP_NAMES = Object.keys(OP_WEIGHTS) as OpName[];

export function pickOperator(rng: Draw, direct: boolean): OpName {
  let total = 0;
  for (const n of OP_NAMES) if (direct || !n.startsWith('syn') && !n.startsWith('neuron')) total += OP_WEIGHTS[n];
  let x = rng.u01x53() * total;
  for (const n of OP_NAMES) {
    if (!direct && (n.startsWith('syn') || n.startsWith('neuron'))) continue;
    x -= OP_WEIGHTS[n];
    if (x < 0) return n;
  }
  return 'repeat';
}

function nonRootModules(g: Genome): ModuleGene[] { return g.modules.filter((m) => m.innov !== g.rootModuleInnov); }
const moduleKey = (innov: number, slot: number): number => hash32(innov, 0, slot);

function newLink(from: number, to: number, innov: number, attachPos: number, rng: Draw): LinkGene {
  const l = defaultRecord<LinkGene>(LINK_RECORD);
  l.innov = innov; l.fromInnov = from; l.toInnov = to; l.attachPos = attachPos;
  l.attachAngle = Math.round((rng.u01() - 0.5) * 128); l.repeat = 1; l.symmetry = 0;
  l.childScale = 170; l.repeatScale = 128; l.flags = LINK_FLAG.ENABLED;
  return l;
}

/** Paralog count of `src`: how many duplication ids keyed on it already exist in this genome (review R22). */
export function paralogCount(g: Genome, src: number, reg: InnovationRegistry): number {
  let j = 0;
  for (;;) {
    const id = reg.lookup(eventKey(EVENT.DUPLICATE, src, j, 0));
    if (id === undefined || !findModule(g, id)) return j;
    j++;
  }
}

/** Duplicate module `src` (and with deep=true its subtree); returns the new innov. Exported for tests. */
export function duplicateModule(g: Genome, srcInnov: number, reg: InnovationRegistry, rng: Draw, deep: boolean): number {
  const src = findModule(g, srcInnov);
  if (!src || g.modules.length >= MODULE_RECORD.max) return 0;
  const copyOne = (m: ModuleGene): ModuleGene => {
    const j = paralogCount(g, m.innov, reg);
    const c = { ...m, innov: reg.innovFor(eventKey(EVENT.DUPLICATE, m.innov, j, 0)) };
    c.flags &= ~MODULE_FLAG.ROOT;
    // a duplicated head becomes a trunk segment: the brain stays in the original head
    if (c.kind === KIND.SEGMENT && c.subtype === 1) c.subtype = 0;
    return c;
  };
  const map = new Map<number, number>();
  const order: ModuleGene[] = [src];
  if (deep) {
    // modules reachable from src through enabled links, in innov order, excluding src itself
    const seen = new Set([src.innov]);
    for (let i = 0; i < order.length; i++) {
      for (const l of g.links) if (l.fromInnov === order[i]!.innov && !seen.has(l.toInnov) && l.toInnov !== g.rootModuleInnov) {
        const m = findModule(g, l.toInnov);
        if (m) { seen.add(m.innov); order.push(m); }
      }
    }
  }
  const added: ModuleGene[] = [];
  for (const m of order) {
    if (g.modules.length + added.length >= MODULE_RECORD.max) break;
    const c = copyOne(m);
    if (findModule(g, c.innov)) continue;
    map.set(m.innov, c.innov);
    added.push(c);
  }
  const newSrc = map.get(src.innov);
  if (newSrc === undefined) return 0;
  g.modules.push(...added);
  // internal links of the copied subtree (self-links included)
  for (const l of [...g.links]) {
    const f = map.get(l.fromInnov), t = map.get(l.toInnov);
    if (f === undefined || t === undefined || g.links.length >= LINK_RECORD.max) continue;
    g.links.push({ ...l, innov: reg.innovFor(eventKey(EVENT.DUP_LINK, l.innov, f, t)), fromInnov: f, toInnov: t });
  }
  // attach the copy beside the original, from the same parent, at a nearby position
  const inLink = g.links.find((l) => l.toInnov === src.innov && l.fromInnov !== src.innov);
  if (g.links.length < LINK_RECORD.max) {
    if (inLink) {
      const nl = { ...inLink, innov: reg.innovFor(eventKey(EVENT.DUP_LINK, inLink.innov, inLink.fromInnov, newSrc)), toInnov: newSrc };
      nl.attachPos = Math.max(0, Math.min(255, inLink.attachPos + Math.round((rng.u01() - 0.5) * 64)));
      g.links.push(nl);
    } else {
      g.links.push(newLink(src.innov, newSrc, reg.innovFor(eventKey(EVENT.ADD_LINK, src.innov, newSrc, 0)), 255, rng));
    }
  }
  // synapses keyed by the module key follow the copy, so a duplicated organ arrives wired (review R15)
  const keyMap = new Map<number, number>();
  for (const [o, c] of map) for (let s = 0; s < KEY_SLOTS; s++) keyMap.set(moduleKey(o, s), moduleKey(c, s));
  const extra = [];
  for (const s of g.directSynapses) {
    if ((s.flags & DSYN_FLAG.PER_INSTANCE) !== 0) continue;
    const ns = keyMap.get(s.src), nd = keyMap.get(s.dst);
    if (ns === undefined && nd === undefined) continue;
    extra.push({ ...s, src: ns ?? s.src, dst: nd ?? s.dst });
  }
  for (const s of extra) if (g.directSynapses.length < DIRECT_SYNAPSE_RECORD.max) g.directSynapses.push(s);
  return newSrc;
}

function opRepeat(g: Genome, rng: Draw): void {
  if (g.links.length === 0) return;
  const l = pick(rng, g.links);
  l.repeat = Math.max(1, Math.min(16, l.repeat + (rng.bool() ? 1 : -1)));
}
function opDeleteModule(g: Genome, rng: Draw): void {
  const c = nonRootModules(g);
  if (c.length === 0) return;
  const m = pick(rng, c);
  g.modules = g.modules.filter((x) => x !== m);
  g.links = g.links.filter((l) => l.fromInnov !== m.innov && l.toInnov !== m.innov);
  g.regs = g.regs.filter((r) => r.targetInnov !== m.innov);
}
function opAddModule(g: Genome, rng: Draw, reg: InnovationRegistry): void {
  if (g.modules.length >= MODULE_RECORD.max || g.links.length >= LINK_RECORD.max) return;
  const parent = pick(rng, g.modules);
  const kind = rng.int(KIND_COUNT);
  const subtype = rng.int(SUBTYPE_COUNT[kind]!);
  const innov = reg.innovFor(eventKey(EVENT.ADD_MODULE, parent.innov, kind, subtype));
  if (findModule(g, innov)) return;
  const m = kindDefaults(kind, subtype);
  m.innov = innov;
  g.modules.push(m);
  g.links.push(newLink(parent.innov, innov, reg.innovFor(eventKey(EVENT.ADD_LINK, parent.innov, innov, 0)), rng.int(256), rng));
}
function opRewire(g: Genome, rng: Draw): void {
  if (g.links.length === 0) return;
  const l = pick(rng, g.links);
  const r = rng.int(3);
  if (r === 2 || g.modules.length < 2) {
    l.attachPos = Math.max(0, Math.min(255, l.attachPos + Math.round((rng.u01() * 2 - 1) * 51)));
    return;
  }
  const m = pick(rng, g.modules);
  if (r === 0) l.fromInnov = m.innov;
  else if (m.innov !== g.rootModuleInnov) l.toInnov = m.innov;
}
function opSymmetry(g: Genome, rng: Draw): void {
  if (g.links.length === 0) return;
  const l = pick(rng, g.links);
  l.symmetry = (l.symmetry + 1) % 3;
}
function opKind(g: Genome, rng: Draw): void {
  const c = nonRootModules(g);
  if (c.length === 0) return;
  const m = pick(rng, c);
  if (rng.bool()) {
    m.subtype = (m.subtype + 1 + rng.int(Math.max(1, SUBTYPE_COUNT[m.kind]! - 1))) % SUBTYPE_COUNT[m.kind]!;
  } else {
    m.kind = rng.int(KIND_COUNT);
    m.subtype = rng.int(SUBTYPE_COUNT[m.kind]!);
  }
}
function opToggle(g: Genome, rng: Draw): void {
  const c = nonRootModules(g);
  if (c.length > 0 && (g.links.length === 0 || rng.bool())) { const m = pick(rng, c); m.flags ^= MODULE_FLAG.ENABLED; return; }
  if (g.links.length > 0) { const l = pick(rng, g.links); l.flags ^= LINK_FLAG.ENABLED; }
}
const REG_PARAMS = [8, 10, 12, 13, 16, 17, 18, 20, 21, 24, 25, 26];
function opReg(g: Genome, rng: Draw, reg: InnovationRegistry): void {
  if (g.regs.length > 0 && (g.regs.length >= REG_RECORD.max || rng.bool())) {
    const r = pick(rng, g.regs);
    g.regs = g.regs.filter((x) => x !== r);
    return;
  }
  const target = pick(rng, g.modules);
  const axisR = rng.u01();
  const axis = axisR < 0.45 ? REG_AXIS.AP : axisR < 0.7 ? REG_AXIS.DV : axisR < 0.95 ? REG_AXIS.MATURITY : REG_AXIS.DEPTH_AT_BIRTH;
  const param = rng.u01() < 0.2 ? REG_PARAM_GATE : pick(rng, REG_PARAMS);
  const innov = reg.innovFor(eventKey(EVENT.ADD_REG, target.innov, axis, param));
  if (g.regs.some((r) => r.innov === innov)) return;
  const r = defaultRecord<RegGene>(REG_RECORD);
  r.innov = innov; r.targetInnov = target.innov; r.targetKind = 255; r.axis = axis; r.param = param;
  r.shape = rng.int(4); r.centre = rng.int(256); r.width = 64 + rng.int(192);
  r.amount = param === REG_PARAM_GATE ? (rng.bool() ? 64 : -64) : Math.round(25 * rng.normal());
  r.flags = 1;
  g.regs.push(r);
}

// brain operators (direct encoding, CONTRACT 6.7)
function neuronKeys(g: Genome): number[] {
  const keys: number[] = [];
  for (const m of g.modules) for (let s = 0; s < 4; s++) keys.push(moduleKey(m.innov, s));
  for (const n of g.hiddenNeurons) keys.push(hash32(n.innov, 0, 0xff));
  return keys;
}
function opSynAdd(g: Genome, rng: Draw): void {
  if (g.directSynapses.length >= DIRECT_SYNAPSE_RECORD.max) return;
  const keys = neuronKeys(g);
  const src = pick(rng, keys), dst = pick(rng, keys);
  if (g.directSynapses.some((s) => s.src === src && s.dst === dst)) return;
  g.directSynapses.push({ src, dst, w: clampI16(2048 * rng.normal()), flags: DSYN_FLAG.ENABLED, plasticity: 0 });
}
function opNeuronAdd(g: Genome, rng: Draw, reg: InnovationRegistry): void {
  const en = g.directSynapses.filter((s) => (s.flags & DSYN_FLAG.ENABLED) !== 0);
  if (en.length === 0 || g.hiddenNeurons.length >= HIDDEN_NEURON_RECORD.max || g.directSynapses.length + 2 > DIRECT_SYNAPSE_RECORD.max) return;
  const s = pick(rng, en);
  const innov = reg.innovFor(eventKey(EVENT.ADD_NEURON, s.src, s.dst, 0));
  if (g.hiddenNeurons.some((n) => n.innov === innov)) return;
  g.hiddenNeurons.push({ innov, tau: 128, flags: 1, bias: 0 });
  const key = hash32(innov, 0, 0xff);
  s.flags &= ~DSYN_FLAG.ENABLED;
  g.directSynapses.push({ src: s.src, dst: key, w: 2048, flags: DSYN_FLAG.ENABLED, plasticity: 0 });
  g.directSynapses.push({ src: key, dst: s.dst, w: s.w, flags: DSYN_FLAG.ENABLED, plasticity: 0 });
}
function opSynDelete(g: Genome, rng: Draw): void {
  if (g.directSynapses.length === 0) return;
  const s = pick(rng, g.directSynapses);
  if (rng.bool()) g.directSynapses = g.directSynapses.filter((x) => x !== s); else s.flags ^= DSYN_FLAG.ENABLED;
}
function opNeuronDelete(g: Genome, rng: Draw): void {
  const used = new Set<number>();
  for (const s of g.directSynapses) { used.add(s.src); used.add(s.dst); }
  const free = g.hiddenNeurons.filter((n) => !used.has(hash32(n.innov, 0, 0xff)));
  if (free.length === 0) return;
  const n = pick(rng, free);
  g.hiddenNeurons = g.hiddenNeurons.filter((x) => x !== n);
}

export function applyOperator(op: OpName, g: Genome, rng: Draw, reg: InnovationRegistry): void {
  switch (op) {
    case 'repeat': opRepeat(g, rng); break;
    case 'duplicate': {
      const c = nonRootModules(g);
      const src = c.length > 0 ? pick(rng, c) : g.modules[0];
      if (src) duplicateModule(g, src.innov, reg, rng, rng.u01() < DEEP_COPY_P);
      break;
    }
    case 'deleteModule': opDeleteModule(g, rng); break;
    case 'addModule': opAddModule(g, rng, reg); break;
    case 'rewire': opRewire(g, rng); break;
    case 'symmetry': opSymmetry(g, rng); break;
    case 'kind': opKind(g, rng); break;
    case 'toggle': opToggle(g, rng); break;
    case 'reg': opReg(g, rng, reg); break;
    case 'synAdd': opSynAdd(g, rng); break;
    case 'neuronAdd': opNeuronAdd(g, rng, reg); break;
    case 'synDelete': opSynDelete(g, rng); break;
    case 'neuronDelete': opNeuronDelete(g, rng); break;
  }
}

export interface MutateStats { points: number; structural: number; ops: OpName[] }

/** mutate (CONTRACT 10.2), with the registry made explicit. `stats` is filled when given (tests). */
export function mutateWith(parent: Genome, ctx: MutationContext, reg: InnovationRegistry, stats?: MutateStats): Genome {
  reg.noteBirth();
  const rng = ctx.rng.draw(RNG_STREAM.MUTATION, ctx.tick, ctx.childId);
  const g = cloneGenome(parent);
  for (const i of [TI.MU_LOG, TI.SIGMA, TI.MU_STRUCT_RATIO]) {
    g.traits[i] = Math.round(reflect01(g.traits[i]! / 65535 + META_RATE * rng.normal()) * 65535);
  }
  const muLog = -4 + (g.traits[TI.MU_LOG]! / 65535) * 3;
  const mu = Math.min(1, pow10(muLog) * (ctx.mutagen > 0 ? ctx.mutagen : 1));
  const sigma = 0.005 * exp((g.traits[TI.SIGMA]! / 65535) * 3.6888794541139363); // 0.005..0.2 log
  const ratio = 0.02 * exp((g.traits[TI.MU_STRUCT_RATIO]! / 65535) * 3.912023005428146); // 0.02..1 log
  const nGenes = countGenes(g);
  const nPoint = poisson(rng, mu * nGenes);
  for (let k = 0; k < nPoint; k++) pointMutation(g, sigma, rng);
  const nStruct = poisson(rng, mu * ratio * nGenes);
  const direct = g.brainTraits[BTI.ENCODING]! < 32768;
  const ops: OpName[] = [];
  for (let k = 0; k < nStruct; k++) { const op = pickOperator(rng, direct); ops.push(op); applyOperator(op, g, rng, reg); }
  if (stats) { stats.points = nPoint; stats.structural = nStruct; stats.ops = ops; }
  repairInPlace(g);
  clampToCeiling(g, ctx.lCeilingM);
  try {
    if (encodeGenome(g).length > GENOME_MAX_BYTES) return cloneGenome(parent);
  } catch { return cloneGenome(parent); }
  return g;
}
