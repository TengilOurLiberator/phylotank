/**
 * Crossover (01 §1.7.3, 03 §3.6.4, CONTRACT 3.3): structure from the bearer, alleles from both,
 * aligned by innovation id with a merge walk.
 *
 * - Header flags (the leviathan flag included), the root and ENCODING come from the bearer.
 * - Traits and brain traits: per entry, A or B; with BLEND_P a blend at a random point between.
 * - Matching module and link genes: structural fields (kind, subtype, flags, recursion limit;
 *   from, to, repeat, symmetry, flags) from the bearer, numeric fields from either parent, field
 *   by field with BLEND_P, else the whole allele from one parent.
 * - Bearer-only genes are kept. Donor-only regulatory genes and synapses come in at 25%; a
 *   donor-only module comes in (at 15%) only with the donor link that attaches it to a module
 *   the child has. CPPN genes: matching from either, disjoint from the bearer (03 §3.6.4).
 * Then repair and the ceiling clamp.
 */
import {
  RNG_STREAM, type DirectSynapseGene, type Draw, type Genome, type LinkGene, type ModuleGene, type MutationContext,
} from '../core/index.js';
import { BLEND_P, DONOR_MODULE_P, DONOR_REG_P, DONOR_SYN_P } from './constants.js';
import { BTI, cloneGenome } from './genes.js';
import { repairInPlace } from './repair.js';
import { clampToCeiling } from './ceiling.js';

const MOD_STRUCT = new Set(['innov', 'kind', 'subtype', 'flags', 'recursionLimit', 'ext']);
const LINK_STRUCT = new Set(['innov', 'fromInnov', 'toInnov', 'repeat', 'symmetry', 'flags', 'ext']);

function mixRecord<T extends object>(a: T, b: T, structural: Set<string>, rng: Draw): T {
  const out = { ...a } as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const fieldwise = rng.u01() < BLEND_P;
  const whole = rng.bool();
  for (const k of Object.keys(out)) {
    if (structural.has(k)) continue;
    const from = fieldwise ? rng.bool() : whole;
    if (!from) out[k] = rb[k];
  }
  return out as T;
}

function mixBlock(a: Uint16Array, b: Uint16Array, rng: Draw, skip: number): Uint16Array {
  const n = Math.max(a.length, b.length);
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const qa = a[i] ?? b[i]!, qb = b[i] ?? a[i]!;
    if (i === skip) { out[i] = qa; continue; }
    if (rng.u01() < BLEND_P) out[i] = Math.round(qa + (qb - qa) * rng.u01());
    else out[i] = rng.bool() ? qa : qb;
  }
  return out;
}

function mergeWalk<T extends { innov: number | bigint }>(A: readonly T[], B: readonly T[],
  fn: (a: T | undefined, b: T | undefined) => void): void {
  const sa = [...A].sort((x, y) => (x.innov < y.innov ? -1 : x.innov > y.innov ? 1 : 0));
  const sb = [...B].sort((x, y) => (x.innov < y.innov ? -1 : x.innov > y.innov ? 1 : 0));
  let i = 0, j = 0;
  while (i < sa.length || j < sb.length) {
    const a = sa[i], b = sb[j];
    if (a && b && a.innov === b.innov) { fn(a, b); i++; j++; }
    else if (a && (!b || a.innov < b.innov)) { fn(a, undefined); i++; }
    else { fn(undefined, b); j++; }
  }
}

export function crossoverWith(A: Genome, B: Genome, ctx: MutationContext): Genome {
  const rng = ctx.rng.draw(RNG_STREAM.CROSSOVER, ctx.tick, ctx.childId);
  const c = cloneGenome(A);
  c.traits = mixBlock(A.traits, B.traits, rng, -1);
  c.brainTraits = mixBlock(A.brainTraits, B.brainTraits, rng, BTI.ENCODING);
  c.immuneKey = ((A.immuneKey & 0xffff0000) | (B.immuneKey & 0xffff)) >>> 0;
  c.surfaceSig = (rng.bool() ? A.surfaceSig : B.surfaceSig) >>> 0;
  const childMods = new Set(A.modules.map((m) => m.innov));
  const modules: ModuleGene[] = [];
  const donorOnlyMods = new Map<number, ModuleGene>();
  mergeWalk(A.modules, B.modules, (a, b) => {
    if (a && b) modules.push(mixRecord(a, b, MOD_STRUCT, rng));
    else if (a) modules.push({ ...a });
    else if (b) donorOnlyMods.set(b.innov, b);
  });
  const links: LinkGene[] = [];
  const donorOnlyLinks: LinkGene[] = [];
  mergeWalk(A.links, B.links, (a, b) => {
    if (a && b) links.push(mixRecord(a, b, LINK_STRUCT, rng));
    else if (a) links.push({ ...a });
    else if (b) donorOnlyLinks.push(b);
  });
  // donor modules arrive only with the link that attaches them to a module the child has
  for (const l of donorOnlyLinks) {
    const m = donorOnlyMods.get(l.toInnov);
    if (m && childMods.has(l.fromInnov) && !childMods.has(m.innov)) {
      if (rng.u01() < DONOR_MODULE_P) { modules.push({ ...m }); childMods.add(m.innov); links.push({ ...l }); }
    } else if (!m && childMods.has(l.fromInnov) && childMods.has(l.toInnov) && rng.u01() < DONOR_REG_P) {
      links.push({ ...l });
    }
  }
  c.modules = modules;
  c.links = links;
  const regs: typeof A.regs = [];
  mergeWalk(A.regs, B.regs, (a, b) => {
    if (a && b) regs.push({ ...(rng.bool() ? a : b) });
    else if (a) regs.push({ ...a });
    else if (b && rng.u01() < DONOR_REG_P) regs.push({ ...b });
  });
  c.regs = regs;
  const neurons: typeof A.hiddenNeurons = [];
  mergeWalk(A.hiddenNeurons, B.hiddenNeurons, (a, b) => {
    if (a && b) neurons.push({ ...(rng.bool() ? a : b) });
    else if (a) neurons.push({ ...a });
    else if (b && rng.u01() < DONOR_SYN_P) neurons.push({ ...b });
  });
  c.hiddenNeurons = neurons;
  // synapses aligned by (src, dst)
  const synKey = (s: DirectSynapseGene): number => s.src * 4294967296 + s.dst;
  const wrapSyn = (l: readonly DirectSynapseGene[]): { innov: number; s: DirectSynapseGene }[] => l.map((s) => ({ innov: synKey(s), s }));
  const syns: DirectSynapseGene[] = [];
  mergeWalk(wrapSyn(A.directSynapses), wrapSyn(B.directSynapses), (a, b) => {
    if (a && b) syns.push({ ...(rng.bool() ? a.s : b.s) });
    else if (a) syns.push({ ...a.s });
    else if (b && rng.u01() < DONOR_SYN_P) syns.push({ ...b.s });
  });
  c.directSynapses = syns;
  const nodes: typeof A.cppnNodes = [];
  mergeWalk(A.cppnNodes, B.cppnNodes, (a, b) => { if (a && b) nodes.push({ ...(rng.bool() ? a : b) }); else if (a) nodes.push({ ...a }); });
  c.cppnNodes = nodes;
  const conns: typeof A.cppnConns = [];
  mergeWalk(A.cppnConns, B.cppnConns, (a, b) => { if (a && b) conns.push({ ...(rng.bool() ? a : b) }); else if (a) conns.push({ ...a }); });
  c.cppnConns = conns;
  repairInPlace(c);
  clampToCeiling(c, ctx.lCeilingM);
  return c;
}
