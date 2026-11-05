/**
 * The CPPN encoding (ENCODING = 1, DESIGN R3, 03 §3.6.2 and §3.6.3).
 *
 * A NEAT-style CPPN (CppnNodeGene, CppnConnGene with 64-bit hashed innovation ids) is queried
 * with the body coordinates and substrate types of a source and a target neuron. Outputs: w, leo
 * (link expression), eta, rule, nodeBias, nodeTau. Links are expressed when leo > 0 and fill the
 * free slots in canonical source order; nothing is ranked by |w| (review R15), so a small CPPN
 * change only flips the links whose leo crosses zero.
 *
 * Reserved CPPN node ids: inputs 1..38, outputs 39..44 (see docs/contract-requests/brain.md).
 */
import { PI, exp, log, sin, tanh, sigmoid, q411ToFloat, xxh64, type Genome } from '../core/index.js';
import { N_STYPE, type FullLayout } from './layout.js';
import type { BrainTraitValues } from './traits.js';

export const CPPN_N_IN = 38;
export const CPPN_N_OUT = 6;
export const CPPN_OUT = { W: 0, LEO: 1, ETA: 2, RULE: 3, NODE_BIAS: 4, NODE_TAU: 5 } as const;
export const CPPN_IN = {
  UA: 0, VA: 1, AVA: 2, DA: 3, TYPE_A: 4, UB: 16, VB: 17, AVB: 18, DB: 19, TYPE_B: 20, DU: 32, DV: 33, DIST: 34,
  SAME_SIDE: 35, SAME_ORGAN: 36, BIAS: 37,
} as const;
/** Node id of CPPN input i (0-based) and output o. */
export function cppnInputId(i: number): bigint { return BigInt(1 + i); }
export function cppnOutputId(o: number): bigint { return BigInt(1 + CPPN_N_IN + o); }
export const CANDIDATE_CAP = 128;

const hbuf = new Uint8Array(16);
const hview = new DataView(hbuf.buffer);
/** 64-bit hashed innovation id (DESIGN R16): connection hash64(from, to), split node hash64(conn, k). */
export function hash64(a: bigint, b: bigint): bigint {
  hview.setBigUint64(0, BigInt.asUintN(64, a), true);
  hview.setBigUint64(8, BigInt.asUintN(64, b), true);
  const h = xxh64(hbuf);
  // keep ids clear of the reserved input/output range
  return h < 64n ? h + 64n : h;
}

export interface CompiledCppn {
  nNodes: number;
  /** Per computed node (in evaluation order): value index, fn, bias, incoming (src value index, w). */
  order: Int32Array;
  fn: Uint8Array;
  bias: Float64Array;
  inStart: Int32Array;
  inSrc: Int32Array;
  inW: Float64Array;
  /** Value index of each output. */
  outIdx: Int32Array;
  nConns: number;
}

function act(fn: number, x: number): number {
  switch (fn) {
    case 0: return x > 8 ? 8 : x < -8 ? -8 : x;
    case 1: return tanh(x);
    case 2: return sin(x);
    case 3: return exp(-x * x);
    case 4: return x < 0 ? -x : x;
    case 5: return x > 0 ? 1 : 0;
    default: return tanh(x);
  }
}

/**
 * Compile the CPPN genes into an evaluation plan. Hidden and output nodes are evaluated in a
 * depth-first order from the outputs; a connection that would close a cycle is ignored, so the
 * plan is feed-forward and deterministic (ordered by innovation id).
 */
export function compileCppn(g: Genome): CompiledCppn {
  const ids = new Map<bigint, number>();
  for (let i = 0; i < CPPN_N_IN; i++) ids.set(cppnInputId(i), i);
  const nodeFn = new Map<bigint, { fn: number; bias: number }>();
  for (let o = 0; o < CPPN_N_OUT; o++) nodeFn.set(cppnOutputId(o), { fn: 1, bias: 0 });
  const nodes = g.cppnNodes.slice().sort((a, b) => (a.innov < b.innov ? -1 : a.innov > b.innov ? 1 : 0));
  for (const n of nodes) {
    if ((n.flags & 1) === 0 && !nodeFn.has(n.innov)) continue;
    if (ids.has(n.innov)) continue; // inputs have no function
    nodeFn.set(n.innov, { fn: n.fn, bias: q411ToFloat(n.bias) });
  }
  let next = CPPN_N_IN;
  const sortedIds = [...nodeFn.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const id of sortedIds) ids.set(id, next++);
  const nNodes = next;
  const incoming: { s: number; w: number }[][] = [];
  for (let i = 0; i < nNodes; i++) incoming.push([]);
  const conns = g.cppnConns.slice().sort((a, b) => (a.innov < b.innov ? -1 : a.innov > b.innov ? 1 : 0));
  let nConns = 0;
  for (const c of conns) {
    if ((c.flags & 1) === 0) continue;
    const s = ids.get(c.from), t = ids.get(c.to);
    if (s === undefined || t === undefined || t < CPPN_N_IN) continue;
    incoming[t]!.push({ s, w: q411ToFloat(c.w) });
    nConns++;
  }
  // depth-first post-order from the outputs; back edges dropped
  const state = new Uint8Array(nNodes); // 0 new, 1 on stack, 2 done
  for (let i = 0; i < CPPN_N_IN; i++) state[i] = 2;
  const order: number[] = [];
  const keep: { s: number; w: number }[][] = incoming.map(() => []);
  const visit = (v: number): void => {
    state[v] = 1;
    for (const e of incoming[v]!) {
      if (state[e.s] === 1) continue; // cycle: ignore this connection
      if (state[e.s] === 0) visit(e.s);
      keep[v]!.push(e);
    }
    state[v] = 2;
    order.push(v);
  };
  const outIdx = new Int32Array(CPPN_N_OUT);
  for (let o = 0; o < CPPN_N_OUT; o++) {
    const v = ids.get(cppnOutputId(o))!;
    outIdx[o] = v;
    if (state[v] === 0) visit(v);
  }
  const fnArr = new Uint8Array(order.length);
  const biasArr = new Float64Array(order.length);
  const inStart = new Int32Array(order.length + 1);
  const inSrc: number[] = [], inW: number[] = [];
  const idToGene = new Map<number, { fn: number; bias: number }>();
  for (const [id, v] of ids) { const f = nodeFn.get(id); if (f) idToGene.set(v, f); }
  order.forEach((v, k) => {
    const f = idToGene.get(v)!;
    fnArr[k] = f.fn; biasArr[k] = f.bias;
    inStart[k] = inSrc.length;
    for (const e of keep[v]!) { inSrc.push(e.s); inW.push(e.w); }
  });
  inStart[order.length] = inSrc.length;
  return {
    nNodes, order: Int32Array.from(order), fn: fnArr, bias: biasArr, inStart, inSrc: Int32Array.from(inSrc),
    inW: Float64Array.from(inW), outIdx, nConns,
  };
}

/** Evaluate: `vals` has nNodes entries with the inputs already in [0, 38); writes out[0..5]. */
export function evalCppn(c: CompiledCppn, vals: Float64Array, out: Float64Array): void {
  const n = c.order.length;
  for (let k = 0; k < n; k++) {
    let s = c.bias[k]!;
    for (let e = c.inStart[k]!; e < c.inStart[k + 1]!; e++) s += c.inW[e]! * vals[c.inSrc[e]!]!;
    vals[c.order[k]!] = act(c.fn[k]!, s);
  }
  for (let o = 0; o < CPPN_N_OUT; o++) out[o] = vals[c.outIdx[o]!]!;
}

interface WireCtx {
  src: number[][]; w: number[][]; meta: number[][]; K: number;
  theta: Float64Array; tau: Float64Array; osc: Float64Array; oscCount: Uint8Array; tv: BrainTraitValues;
}

/** Statistics from the last wiring, for the spike and the inspector. */
export interface CppnWireStats { queries: number; expressed: number; dropped: number }

export function wireCppn(g: Genome, L: FullLayout, c: WireCtx): CppnWireStats {
  const cp = compileCppn(g);
  const stats: CppnWireStats = { queries: 0, expressed: 0, dropped: 0 };
  if (cp.nConns === 0) return stats;
  const vals = new Float64Array(cp.nNodes);
  const out = new Float64Array(CPPN_N_OUT);
  const nIn = L.nIn;
  const nSrc = nIn + L.nNeurons;
  const sU = new Float64Array(nSrc), sV = new Float64Array(nSrc), sD = new Float64Array(nSrc);
  const sT = new Uint8Array(nSrc), sP = new Int16Array(nSrc);
  for (let i = 0; i < nIn; i++) { sU[i] = L.inU[i]!; sV[i] = L.inV[i]!; sD[i] = L.inD[i]!; sT[i] = L.inType[i]!; sP[i] = L.inputs[i]!.part; }
  for (let n = 0; n < L.nNeurons; n++) {
    const s = nIn + n;
    sU[s] = L.neuU[n]!; sV[s] = L.neuV[n]!; sD[s] = L.neuD[n]!; sT[s] = L.neuType[n]!; sP[s] = L.neuPart[n]!;
  }
  const query = (a: number, b: number, node: boolean): void => {
    vals.fill(0, 0, CPPN_N_IN);
    const ua = sU[a]!, va = sV[a]!, da = sD[a]!, ub = sU[b]!, vb = sV[b]!, db = sD[b]!;
    vals[CPPN_IN.UA] = ua; vals[CPPN_IN.VA] = va; vals[CPPN_IN.AVA] = va < 0 ? -va : va; vals[CPPN_IN.DA] = da;
    vals[CPPN_IN.TYPE_A + sT[a]!] = 1;
    vals[CPPN_IN.UB] = ub; vals[CPPN_IN.VB] = vb; vals[CPPN_IN.AVB] = vb < 0 ? -vb : vb; vals[CPPN_IN.DB] = db;
    vals[CPPN_IN.TYPE_B + sT[b]!] = 1;
    const du = ub - ua, dv = vb - va;
    vals[CPPN_IN.DU] = du; vals[CPPN_IN.DV] = dv; vals[CPPN_IN.DIST] = Math.sqrt(du * du + dv * dv);
    vals[CPPN_IN.SAME_SIDE] = va * vb > 0 ? 1 : va * vb < 0 ? -1 : 0;
    vals[CPPN_IN.SAME_ORGAN] = node ? 2 : sP[a] === sP[b] && sP[a]! >= 0 ? 1 : 0;
    vals[CPPN_IN.BIAS] = 1;
    evalCppn(cp, vals, out);
    stats.queries++;
  };
  void N_STYPE;

  // node queries: bias and time constant of hidden neurons
  for (let n = L.base.head; n < L.nNeurons; n++) {
    const s = nIn + n;
    query(s, s, true);
    c.theta[n] = c.theta[n]! + 2 * out[CPPN_OUT.NODE_BIAS]!;
    c.tau[n] = 0.05 * exp(((out[CPPN_OUT.NODE_TAU]! + 1) / 2) * log(2400));
  }
  // oscillator pair queries refine existing couplings: k = 10 sigmoid(w), lag = pi tanh(eta)
  for (let i = 0; i < L.count.osc; i++) {
    const n = L.base.osc + i;
    for (let j = 0; j < c.oscCount[n]!; j++) {
      const o = (n * 4 + j) * 3;
      query(nIn + c.osc[o]!, nIn + n, false);
      c.osc[o + 1] = 10 * sigmoid(out[CPPN_OUT.W]!);
      c.osc[o + 2] = PI * tanh(out[CPPN_OUT.ETA]!);
    }
  }
  // connection queries
  const cand: number[] = [];
  for (let b = 0; b < L.nNeurons; b++) {
    if (b >= L.base.osc && b < L.base.osc + L.count.osc) continue; // oscillators take couplings, not links
    const row = c.src[b]!;
    if (row.length >= c.K) continue;
    const sb = nIn + b;
    const ub = sU[sb]!, pb = sP[sb]!;
    cand.length = 0;
    for (let a = 0; a < nSrc; a++) {
      const pa = sP[a]!;
      const du = sU[a]! - ub;
      if (pa < 0 || (pa === pb) || (du <= 0.25 && du >= -0.25)) cand.push(a);
    }
    const stride = cand.length > CANDIDATE_CAP ? Math.ceil(cand.length / CANDIDATE_CAP) : 1;
    for (let ci = 0; ci < cand.length && row.length < c.K; ci += stride) {
      const a = cand[ci]!;
      if (row.includes(a)) continue;
      query(a, sb, false);
      if (out[CPPN_OUT.LEO]! <= 0) continue;
      let wt = 3 * out[CPPN_OUT.W]!;
      if (wt > 4) wt = 4; else if (wt < -4) wt = -4;
      let m = 0;
      if (c.tv.plasticityOn && out[CPPN_OUT.ETA]! > 0) {
        const rule = Math.min(3, Math.floor(((out[CPPN_OUT.RULE]! + 1) / 2) * 4));
        m = (rule & 3) | 4 | ((Math.min(15, Math.floor(out[CPPN_OUT.ETA]! * 16)) & 15) << 3);
      }
      row.push(a); c.w[b]!.push(wt); c.meta[b]!.push(m);
      stats.expressed++;
    }
  }
  return stats;
}
