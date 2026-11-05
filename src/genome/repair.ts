/**
 * Repair (01 §1.7.4): deterministic, runs after mutation and after crossover, and on import.
 *
 * 1. Sort every chromosome by innov (DSYN by (src, dst)) and drop duplicates, keeping the first.
 * 2. Make sure the root exists and is the only module with the ROOT flag; an empty genome gets
 *    the Blank head.
 * 3. Drop links whose endpoints are missing and regulatory genes whose explicit target is missing.
 * 4. Keep unreachable modules as silent genes (HAS_SILENT header flag).
 * 5. Clamp counts to the section caps, dropping the highest-innov silent genes first.
 * 6. Clamp enumerated fields into range (kind, subtype, symmetry, repeat, recursion limit) and
 *    pin the immutable ENCODING to 0 or 1.
 */
import {
  BRAIN_TRAITS, BRAIN_TRAIT_COUNT, CPPN_CONN_RECORD, CPPN_NODE_RECORD, DIRECT_SYNAPSE_RECORD, GENOME_FLAG_HAS_SILENT,
  HIDDEN_NEURON_RECORD, KIND_COUNT, LINK_RECORD, MODULE_FLAG, MODULE_RECORD, REG_RECORD, TRAITS, TRAIT_COUNT,
  defaultQ, type Genome,
} from '../core/index.js';
import { BTI, SUBTYPE_COUNT, cloneGenome, expressedSets } from './genes.js';
import { blankHead } from './blank.js';

function sortDedup<T extends { innov: number | bigint }>(list: T[]): T[] {
  const s = [...list].sort((a, b) => (a.innov < b.innov ? -1 : a.innov > b.innov ? 1 : 0));
  const out: T[] = [];
  for (const x of s) if (out.length === 0 || out[out.length - 1]!.innov !== x.innov) out.push(x);
  return out;
}

/** Drop the highest-innov entries beyond `cap`, preferring those not in `keep`. */
function capList<T extends { innov: number | bigint }>(list: T[], cap: number, keep: (x: T) => boolean): T[] {
  if (list.length <= cap) return list;
  let excess = list.length - cap;
  const drop = new Set<T>();
  for (let i = list.length - 1; i >= 0 && excess > 0; i--) if (!keep(list[i]!)) { drop.add(list[i]!); excess--; }
  for (let i = list.length - 1; i >= 0 && excess > 0; i--) if (!drop.has(list[i]!)) { drop.add(list[i]!); excess--; }
  return list.filter((x) => !drop.has(x));
}

export function repairInPlace(g: Genome): Genome {
  // traits: pad short blocks with defaults
  if (g.traits.length < TRAIT_COUNT) {
    const t = new Uint16Array(TRAIT_COUNT);
    for (let i = 0; i < TRAIT_COUNT; i++) t[i] = i < g.traits.length ? g.traits[i]! : defaultQ(TRAITS, i);
    g.traits = t;
  }
  if (g.brainTraits.length < BRAIN_TRAIT_COUNT) {
    const t = new Uint16Array(BRAIN_TRAIT_COUNT);
    for (let i = 0; i < BRAIN_TRAIT_COUNT; i++) t[i] = i < g.brainTraits.length ? g.brainTraits[i]! : defaultQ(BRAIN_TRAITS, i);
    g.brainTraits = t;
  }
  g.brainTraits[BTI.ENCODING] = g.brainTraits[BTI.ENCODING]! >= 32768 ? 65535 : 0;
  // 1. sort and dedup
  g.modules = sortDedup(g.modules);
  g.links = sortDedup(g.links);
  g.regs = sortDedup(g.regs);
  g.cppnNodes = sortDedup(g.cppnNodes);
  g.cppnConns = sortDedup(g.cppnConns);
  g.hiddenNeurons = sortDedup(g.hiddenNeurons);
  {
    const s = [...g.directSynapses].sort((a, b) => (a.src - b.src) || (a.dst - b.dst));
    const out: typeof s = [];
    for (const x of s) {
      const last = out[out.length - 1];
      if (!last || last.src !== x.src || last.dst !== x.dst) out.push(x);
    }
    g.directSynapses = out;
  }
  // 6. enumerated fields
  for (const m of g.modules) {
    if (m.kind >= KIND_COUNT) m.kind = m.kind % KIND_COUNT;
    if (m.subtype >= SUBTYPE_COUNT[m.kind]!) m.subtype = m.subtype % SUBTYPE_COUNT[m.kind]!;
    if (m.recursionLimit > 7) m.recursionLimit = 7;
  }
  for (const l of g.links) {
    if (l.repeat < 1) l.repeat = 1;
    if (l.repeat > 16) l.repeat = 16;
    if (l.symmetry > 2) l.symmetry = 0;
  }
  // 2. root
  if (g.modules.length === 0) { g.modules = [blankHead()]; g.rootModuleInnov = 1; }
  let root = g.modules.find((m) => m.innov === g.rootModuleInnov);
  if (!root) {
    root = g.modules.find((m) => (m.flags & MODULE_FLAG.ROOT) !== 0) ?? g.modules[0]!;
    g.rootModuleInnov = root.innov;
  }
  for (const m of g.modules) if (m !== root) m.flags &= ~MODULE_FLAG.ROOT;
  root.flags |= MODULE_FLAG.ROOT | MODULE_FLAG.ENABLED;
  // 3. dangling references
  const modSet = new Set(g.modules.map((m) => m.innov));
  g.links = g.links.filter((l) => modSet.has(l.fromInnov) && modSet.has(l.toInnov));
  g.regs = g.regs.filter((r) => r.targetInnov === 0 || modSet.has(r.targetInnov));
  // 5. caps, silent first
  let ex = expressedSets(g);
  const rootInnov = g.rootModuleInnov;
  g.modules = capList(g.modules, MODULE_RECORD.max, (m) => m.innov === rootInnov || ex.modules.has(m.innov));
  if (g.modules.length < MODULE_RECORD.max + 1) {
    const ms = new Set(g.modules.map((m) => m.innov));
    g.links = g.links.filter((l) => ms.has(l.fromInnov) && ms.has(l.toInnov));
    g.regs = g.regs.filter((r) => r.targetInnov === 0 || ms.has(r.targetInnov));
  }
  ex = expressedSets(g);
  g.links = capList(g.links, LINK_RECORD.max, (l) => ex.links.has(l.innov));
  g.regs = capList(g.regs, REG_RECORD.max, () => false);
  g.cppnNodes = capList(g.cppnNodes, CPPN_NODE_RECORD.max, () => false);
  g.cppnConns = capList(g.cppnConns, CPPN_CONN_RECORD.max, () => false);
  g.hiddenNeurons = capList(g.hiddenNeurons, HIDDEN_NEURON_RECORD.max, () => false);
  if (g.directSynapses.length > DIRECT_SYNAPSE_RECORD.max) g.directSynapses = g.directSynapses.slice(0, DIRECT_SYNAPSE_RECORD.max);
  // 4. silent flag
  ex = expressedSets(g);
  const silent = g.modules.some((m) => !ex.modules.has(m.innov)) || g.links.some((l) => !ex.links.has(l.innov));
  g.flags = silent ? g.flags | GENOME_FLAG_HAS_SILENT : g.flags & ~GENOME_FLAG_HAS_SILENT;
  return g;
}

/** GenomeModule.repair: returns a repaired copy. */
export function repair(g: Genome): Genome { return repairInPlace(cloneGenome(g)); }
