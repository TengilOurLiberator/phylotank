/**
 * WGSL: conservative field transport (CONTRACT 5.4, src/ecosystem/transport.ts) in gather
 * form. Integer fields (quanta, u64 per cell): `outflow` computes each donor cell's five
 * integer outflows exactly as `transportQ` does (same dither, same golden-ratio rotation, same
 * f64 roundings through wgsl/f64.ts, same caps), and `apply` moves them: every cell subtracts
 * what it sent and adds what its four neighbours sent it, and settling mass is collected per
 * cell. Integer arithmetic throughout, so the result equals the CPU's bit for bit and mass is
 * conserved exactly. Signal fields (f32): `transportF` in f32 with the same fractions.
 */
import { F64_WGSL } from './f64.js';
import { PHILOX_WGSL } from './philox.js';

export const TR_WG = 256;

export function transportQWgsl(golden: [number, number]): string {
  return /* wgsl */ `
struct TP { w: u32, h: u32, tick: u32, hiSubject: u32, k0: u32, k1: u32, settle: u32, _a: u32 };
@group(0) @binding(0) var<uniform> P: TP;
@group(0) @binding(1) var<storage, read> fr: array<vec2u>;
@group(0) @binding(2) var<storage, read_write> q: array<vec2u>;
@group(0) @binding(3) var<storage, read_write> outQ: array<vec2u>;
@group(0) @binding(4) var<storage, read_write> settled: array<vec2u>;
${PHILOX_WGSL}
${F64_WGSL}
const GOLDEN: vec2u = vec2u(${golden[0]}u, ${golden[1]}u);

fn fmix32(h0: u32) -> u32 {
  var h = h0;
  h = h ^ (h >> 16u); h = h * 0x85ebca6bu;
  h = h ^ (h >> 13u); h = h * 0xc2b2ae35u;
  h = h ^ (h >> 16u);
  return h;
}

@compute @workgroup_size(${TR_WG})
fn outflow(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.x + gid.y * nwg.x * ${TR_WG}u;
  let n = P.w * P.h;
  if (i >= n) { return; }
  for (var f = 0u; f < 5u; f++) { outQ[i * 5u + f] = vec2u(0u, 0u); }
  let qi = q[i];
  if (isZero64(qi)) { return; }
  let qf = u64ToF64(qi);
  let word = philox(vec4u(P.tick, i >> 10u, P.hiSubject, 0u), vec2u(P.k0, P.k1)).x;
  let d24 = fmix32(word + i * 0x9e3779b9u) >> 8u;
  // dd = d24 * 2^-24 exactly
  var dd = u64ToF64(vec2u(d24, 0u));
  if (!f64IsZero(dd)) { dd.y = dd.y - (24u << 20u); }
  var rem = qi;
  for (var f = 0u; f < 5u; f++) {
    let x = fr[i * 5u + f];
    dd = f64Add(dd, GOLDEN);
    if (f64Ge1(dd)) { dd = f64Sub1(dd); }
    if (f64IsZero(x)) { continue; }
    var m = f64FloorU64(f64Add(f64Mul(qf, x), dd));
    if (lt64(rem, m)) { m = rem; }
    if (isZero64(m)) { continue; }
    if (f == 4u && P.settle == 0u) { continue; }
    rem = sub64(rem, m);
    outQ[i * 5u + f] = m;
    if (isZero64(rem)) { break; }
  }
}

@compute @workgroup_size(${TR_WG})
fn apply(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.x + gid.y * nwg.x * ${TR_WG}u;
  let w = P.w; let n = w * P.h;
  if (i >= n) { return; }
  let ix = i % w; let iy = i / w;
  var v = q[i];
  for (var f = 0u; f < 4u; f++) { v = sub64(v, outQ[i * 5u + f]); }
  let st = outQ[i * 5u + 4u];
  v = sub64(v, st);
  settled[i] = add64(settled[i], st);
  if (ix > 0u) { v = add64(v, outQ[(i - 1u) * 5u + 1u]); }
  if (ix + 1u < w) { v = add64(v, outQ[(i + 1u) * 5u + 0u]); }
  if (iy > 0u) { v = add64(v, outQ[(i - w) * 5u + 3u]); }
  if (iy + 1u < P.h) { v = add64(v, outQ[(i + w) * 5u + 2u]); }
  q[i] = v;
}
`;
}

/** f32 signal fields: one substep of the gather form of `transportF` (no settling). */
export const TRANSPORT_F_WGSL = /* wgsl */ `
struct TF { w: u32, h: u32, lanes: u32, lane: u32 };
@group(0) @binding(0) var<uniform> P: TF;
@group(0) @binding(1) var<storage, read> fr: array<f32>;
@group(0) @binding(2) var<storage, read> src: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;

@compute @workgroup_size(${TR_WG})
fn transport_f(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = gid.x + gid.y * nwg.x * ${TR_WG}u;
  let w = P.w; let n = w * P.h;
  if (i >= n) { return; }
  let ix = i % w; let iy = i / w;
  let qi = src[i];
  var v = qi - qi * (fr[i * 5u] + fr[i * 5u + 1u] + fr[i * 5u + 2u] + fr[i * 5u + 3u]);
  if (ix > 0u) { v = v + src[i - 1u] * fr[(i - 1u) * 5u + 1u]; }
  if (ix + 1u < w) { v = v + src[i + 1u] * fr[(i + 1u) * 5u]; }
  if (iy > 0u) { v = v + src[i - w] * fr[(i - w) * 5u + 3u]; }
  if (iy + 1u < P.h) { v = v + src[i + w] * fr[(i + w) * 5u + 2u]; }
  dst[i] = v;
}
`;
