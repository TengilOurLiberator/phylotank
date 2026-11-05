/**
 * WGSL: the batched CTRNN brain tick (CONTRACT 8.3, src/brain/think.ts tickBrain), one kernel
 * per size class with its (N, I, K) baked in. `think` runs one thread per (brain, neuron):
 * the update is synchronous (Jacobi), every read is of `inputs`, `oPrev` and the phases from
 * before the tick, and new phases go to a separate lane. `commit` runs one thread per brain:
 * the NaN guard, then `oPrev := o` and the phase update. Exploration noise is Philox with the
 * CPU's counters, Box-Muller on the same 24-bit uniforms.
 *
 * Plastic brains and the act step stay on the CPU (src/gpu/brain.ts).
 */
import { PHILOX_WGSL } from './philox.js';

export const BRAIN_WG = 64;
/** Per brain header (u32 x 8): due, nIn, nNeu, entityLo, entityHi, exploration, fLow, fHigh (f32 bits). */
export const BH = { DUE: 0, NIN: 1, NNEU: 2, ELO: 3, EHI: 4, EXPL: 5, FLO: 6, FHI: 7, STRIDE: 8 } as const;
/** State lanes (f32, field-major over B x N). */
export const BST = { Y: 0, O: 1, OPREV: 2, PHASE: 3, PHASE_NEXT: 4, N: 5 } as const;

export function brainWgsl(N: number, I: number, K: number, kinds: { osc: number; noisyLo: number; modulator: number }, clamp: number, pi: number): string {
  return /* wgsl */ `
struct BP { nBrains: u32, tick: u32, dtb: f32, k0: u32, k1: u32, cap: u32, _a: u32, _b: u32 };
@group(0) @binding(0) var<uniform> Q: BP;
@group(0) @binding(1) var<storage, read> hdr: array<u32>;
@group(0) @binding(2) var<storage, read> inputs: array<f32>;
@group(0) @binding(3) var<storage, read_write> st: array<f32>;
@group(0) @binding(4) var<storage, read> stat: array<f32>;
@group(0) @binding(5) var<storage, read> nkr: array<u32>;
@group(0) @binding(6) var<storage, read> syn: array<u32>;
@group(0) @binding(7) var<storage, read_write> nanCount: array<atomic<u32>>;

const N: u32 = ${N}u; const I: u32 = ${I}u; const K: u32 = ${K}u;
const PI: f32 = ${pi}; const TAU: f32 = ${2 * pi};
const OSC: u32 = ${kinds.osc}u; const NOISY_LO: u32 = ${kinds.noisyLo}u; const MODULATOR: u32 = ${kinds.modulator}u;
const CLAMP: f32 = ${clamp}.0;
${PHILOX_WGSL}

fn L(f: u32, s: u32, i: u32) -> u32 { return f * Q.cap * N + s * N + i; }
fn sigm(x: f32) -> f32 { return 1.0 / (1.0 + exp(-x)); }
fn isNan(v: f32) -> bool { let b = bitcast<u32>(v); return (b & 0x7f800000u) == 0x7f800000u && (b & 0x007fffffu) != 0u; }

@compute @workgroup_size(${BRAIN_WG})
fn think(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let idx = gid.x + gid.y * nwg.x * ${BRAIN_WG}u;
  let s = idx / N; let i = idx % N;
  if (s >= Q.nBrains) { return; }
  let h = s * ${BH.STRIDE}u;
  if (hdr[h + ${BH.DUE}u] == 0u) { return; }
  let nIn = hdr[h + ${BH.NIN}u]; let nNeu = hdr[h + ${BH.NNEU}u];
  if (i >= nNeu) { return; }
  let bN = s * N; let bI = s * I; let bS = s * K * N;
  let fLow = bitcast<f32>(hdr[h + ${BH.FLO}u]); let fHigh = bitcast<f32>(hdr[h + ${BH.FHI}u]);
  let F = fLow + (fHigh - fLow) * sigm(4.0 * st[L(${BST.OPREV}u, s, 0u)]);
  let amp = sigm(4.0 * st[L(${BST.OPREV}u, s, 1u)]);
  var sum = 0.0;
  let nk = nkr[bN + i];
  let kind = nk & 255u; let rowLen = nk >> 8u;
  for (var k = 0u; k < rowLen; k++) {
    let at = bS + k * N + i;
    let j = syn[at];
    let wv = bitcast<f32>(syn[Q.cap * K * N + at]);
    var a = 0.0;
    if (j < nIn) { a = inputs[bI + j]; } else { a = st[L(${BST.OPREV}u, s, j - nIn)]; }
    sum = sum + wv * a;
  }
  let nb = Q.cap * N;
  if (kind == OSC) {
    let ph = st[L(${BST.PHASE}u, s, i)];
    var dphi = TAU * F + sum;
    let ob = (bN + i) * 12u;
    for (var q = 0u; q < 4u; q++) {
      let src = stat[3u * nb + ob + q * 3u];
      if (src < 0.0) { continue; }
      dphi = dphi + stat[3u * nb + ob + q * 3u + 1u] * sin(st[L(${BST.PHASE}u, s, u32(src))] - ph - stat[3u * nb + ob + q * 3u + 2u]);
    }
    var np = ph + Q.dtb * dphi;
    if (np > PI || np <= -PI) { np = np - TAU * floor((np + PI) / TAU); }
    st[L(${BST.PHASE_NEXT}u, s, i)] = np;
    st[L(${BST.O}u, s, i)] = amp * sin(np + stat[2u * nb + bN + i]);
  } else {
    var noise = 0.0;
    let expl = bitcast<f32>(hdr[h + ${BH.EXPL}u]);
    if (kind >= NOISY_LO && kind != MODULATOR && expl > 0.0) {
      let w = philox(vec4u(Q.tick, hdr[h + ${BH.ELO}u], hdr[h + ${BH.EHI}u], i / 4u), vec2u(Q.k0, Q.k1));
      let pair = (i % 4u) / 2u;
      var w1 = w.x; var w2 = w.y;
      if (pair == 1u) { w1 = w.z; w2 = w.w; }
      let u1 = 1.0 - f32(w1 >> 8u) * 5.9604644775390625e-8;
      let u2 = f32(w2 >> 8u) * 5.9604644775390625e-8;
      let r = sqrt(-2.0 * log(u1)) * expl;
      let t = TAU * u2;
      if ((i % 2u) == 0u) { noise = r * cos(t); } else { noise = r * sin(t); }
    }
    let y0 = st[L(${BST.Y}u, s, i)];
    let yi = clamp(y0 + stat[nb + bN + i] * (sum + noise - y0), -CLAMP, CLAMP);
    st[L(${BST.Y}u, s, i)] = yi;
    st[L(${BST.O}u, s, i)] = tanh(yi + stat[bN + i]);
    st[L(${BST.PHASE_NEXT}u, s, i)] = st[L(${BST.PHASE}u, s, i)];
  }
}

@compute @workgroup_size(${BRAIN_WG})
fn commit(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let s = gid.x + gid.y * nwg.x * ${BRAIN_WG}u;
  if (s >= Q.nBrains) { return; }
  let h = s * ${BH.STRIDE}u;
  if (hdr[h + ${BH.DUE}u] == 0u) { return; }
  let nNeu = hdr[h + ${BH.NNEU}u];
  var bad = false;
  for (var i = 0u; i < nNeu; i++) {
    if (isNan(st[L(${BST.O}u, s, i)]) || isNan(st[L(${BST.PHASE_NEXT}u, s, i)]) || isNan(st[L(${BST.Y}u, s, i)])) { bad = true; break; }
  }
  if (bad) {
    for (var i = 0u; i < N; i++) {
      st[L(${BST.Y}u, s, i)] = 0.0; st[L(${BST.O}u, s, i)] = 0.0; st[L(${BST.OPREV}u, s, i)] = 0.0; st[L(${BST.PHASE}u, s, i)] = 0.0;
    }
    atomicAdd(&nanCount[0], 1u);
    return;
  }
  for (var i = 0u; i < nNeu; i++) {
    st[L(${BST.OPREV}u, s, i)] = st[L(${BST.O}u, s, i)];
    st[L(${BST.PHASE}u, s, i)] = st[L(${BST.PHASE_NEXT}u, s, i)];
  }
}
`;
}
