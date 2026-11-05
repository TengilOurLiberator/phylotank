/**
 * WGSL: exclusive prefix sum of u32 counts, reduce-then-scan over levels of 256 (02 §2.8.2:
 * no single-pass decoupled look-back, since WebGPU gives no forward-progress guarantee).
 * Integer addition, so the result is exact and independent of thread order.
 */
export const SCAN_WG = 256;

export const SCAN_WGSL = /* wgsl */ `
struct SP { n: u32, _a: u32, _b: u32, _c: u32 };
@group(0) @binding(0) var<uniform> Q: SP;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read_write> sums: array<u32>;
var<workgroup> tmp: array<u32, ${SCAN_WG}>;

@compute @workgroup_size(${SCAN_WG})
fn scan_block(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let blk = wid.x + wid.y * nwg.x;
  let i = blk * ${SCAN_WG}u + lid.x;
  var v = 0u;
  if (i < Q.n) { v = src[i]; }
  tmp[lid.x] = v;
  workgroupBarrier();
  for (var off = 1u; off < ${SCAN_WG}u; off = off * 2u) {
    var add = 0u;
    if (lid.x >= off) { add = tmp[lid.x - off]; }
    workgroupBarrier();
    tmp[lid.x] = tmp[lid.x] + add;
    workgroupBarrier();
  }
  if (i < Q.n) { dst[i] = tmp[lid.x] - v; }
  if (lid.x == ${SCAN_WG - 1}u) { sums[blk] = tmp[lid.x]; }
}
`;

export const SCAN_ADD_WGSL = /* wgsl */ `
struct SP { n: u32, _a: u32, _b: u32, _c: u32 };
@group(0) @binding(0) var<uniform> Q: SP;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@group(0) @binding(2) var<storage, read> offs: array<u32>;

@compute @workgroup_size(${SCAN_WG})
fn scan_add(@builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let blk = wid.x + wid.y * nwg.x;
  let i = blk * ${SCAN_WG}u + lid.x;
  if (i < Q.n) { dst[i] = dst[i] + offs[blk]; }
}
`;
