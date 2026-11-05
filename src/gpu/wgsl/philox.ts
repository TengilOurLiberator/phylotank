/**
 * WGSL Philox4x32-10, word for word the src/core/rng.ts function (CONTRACT 4.1): the same
 * counter and key give the same four u32 words on the GPU as on the CPU (tested exactly).
 * WGSL has no 32x32 -> 64 multiply, so the high word is built from 16-bit halves.
 */
export const PHILOX_WGSL = /* wgsl */ `
fn mulhi32(a: u32, b: u32) -> u32 {
  let aLo = a & 0xffffu; let aHi = a >> 16u; let bLo = b & 0xffffu; let bHi = b >> 16u;
  let ll = aLo * bLo; let lh = aLo * bHi; let hl = aHi * bLo; let hh = aHi * bHi;
  let mid = (ll >> 16u) + (lh & 0xffffu) + (hl & 0xffffu);
  return hh + (lh >> 16u) + (hl >> 16u) + (mid >> 16u);
}
fn philox(c: vec4u, k: vec2u) -> vec4u {
  var x = c; var a = k.x; var b = k.y;
  for (var r = 0u; r < 10u; r++) {
    if (r > 0u) { a = a + 0x9e3779b9u; b = b + 0xbb67ae85u; }
    let hi0 = mulhi32(0xd2511f53u, x.x); let lo0 = 0xd2511f53u * x.x;
    let hi1 = mulhi32(0xcd9e8d57u, x.z); let lo1 = 0xcd9e8d57u * x.z;
    x = vec4u(hi1 ^ x.y ^ a, lo1, hi0 ^ x.w ^ b, lo0);
  }
  return x;
}
`;

/** A test kernel: out[i] = philox((tick, i, hi, draw), key) for i < n. */
export const PHILOX_TEST_WGSL = /* wgsl */ `
struct PP { n: u32, tick: u32, hi: u32, draw: u32, k0: u32, k1: u32, _a: u32, _b: u32 };
@group(0) @binding(0) var<uniform> Pp: PP;
@group(0) @binding(1) var<storage, read_write> outW: array<vec4u>;
${PHILOX_WGSL}
@compute @workgroup_size(64)
fn philox_test(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= Pp.n) { return; }
  outW[gid.x] = philox(vec4u(Pp.tick, gid.x, Pp.hi, Pp.draw), vec2u(Pp.k0, Pp.k1));
}
`;
