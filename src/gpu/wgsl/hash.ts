/**
 * WGSL: the hierarchical spatial hash (02 §2.8, src/physics/contacts.ts buildHash), as a
 * counting sort: `hash_count` (level, cell and bucket per item; atomic count), an exclusive
 * scan of the counts (scan.ts), `hash_scatter` (atomic fill cursor), then `bucket_sort`, which
 * orders each bucket by item index. Items are numbered in ascending creature slot and segment
 * order, so the result is the CPU's `(bucket, slot)` order exactly (CONTRACT 4.2 rule 4),
 * not the nondeterministic arrival order of the atomics.
 *
 * Cells are computed from the creature's Q16.16 anchor in integer arithmetic plus the f32
 * offset (02 §2.7.6), so an item's cell differs from the CPU's f64 `floor(x / c_l)` only when
 * it lies within about 1e-7 cells of a boundary.
 */
export const HASH_WG = 256;

export function hashWgsl(physStrides: { sdynN: number; sstLen: number; sstRad: number; sdynVx: number; sdynVy: number; sdynW: number; croStride: number }): string {
  const s = physStrides;
  return /* wgsl */ `
struct HP { nItems: u32, mask: u32, segCap: u32, dt: f32 };
@group(0) @binding(0) var<uniform> H: HP;
@group(0) @binding(1) var<storage, read> itemCr: array<u32>;
@group(0) @binding(2) var<storage, read> cro: array<u32>;
@group(0) @binding(3) var<storage, read> sdyn: array<f32>;
@group(0) @binding(4) var<storage, read> sst: array<f32>;
@group(0) @binding(5) var<storage, read_write> itemKey: array<u32>;
@group(0) @binding(6) var<storage, read_write> itemCell: array<vec4i>;
@group(0) @binding(7) var<storage, read_write> cellCount: array<atomic<u32>>;

const NLEV: u32 = 8u;
fn levelSize(l: u32) -> f32 { return 0.001 * f32(1u << (2u * l)); }

// floor((a * 2^-16 + off) / c_l) with a >= 0 in Q16.16 metres: a * 1000 / 2^(16 + 2l) exactly in
// 64-bit integer arithmetic, then the remainder fraction plus off / c_l in f32.
fn cellCoord(a: i32, off: f32, l: u32) -> i32 {
  let au = u32(max(a, 0));
  let p0 = (au & 0xffffu) * 1000u;
  let p1 = (au >> 16u) * 1000u;
  let loW = p1 << 16u;
  let lo = loW + p0;
  let carry = select(0u, 1u, lo < loW);
  let hi = (p1 >> 16u) + carry;
  let sh = 16u + 2u * l;
  let q = (lo >> sh) | (hi << (32u - sh));
  let rem = lo & ((1u << sh) - 1u);
  let r = f32(rem) / f32(1u << sh);
  return i32(q) + i32(floor(r + off / levelSize(l)));
}

fn bucketOf(l: u32, ix: i32, iy: i32) -> u32 {
  return ((u32(ix) * 73856093u) ^ (u32(iy) * 19349663u) ^ (l * 83492791u)) & H.mask;
}

@compute @workgroup_size(${HASH_WG})
fn hash_count(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let g = gid.x + gid.y * nwg.x * ${HASH_WG}u;
  if (g >= H.nItems) { return; }
  let S = H.segCap;
  let len = sst[${s.sstLen}u * S + g]; let rad = sst[${s.sstRad}u * S + g];
  let vx = sdyn[${s.sdynVx}u * S + g]; let vy = sdyn[${s.sdynVy}u * S + g]; let w = sdyn[${s.sdynW}u * S + g];
  let v = sqrt(vx * vx + vy * vy) + abs(w) * 0.5 * len;
  let R = 0.5 * len + rad + 0.5 * v * H.dt;
  var l = 0u;
  while (l < NLEV - 1u && levelSize(l) < 2.0 * R) { l = l + 1u; }
  let c = itemCr[g];
  let ax = bitcast<i32>(cro[c * ${s.croStride}u]); let ay = bitcast<i32>(cro[c * ${s.croStride}u + 1u]);
  let ix = cellCoord(ax, sdyn[g], l); let iy = cellCoord(ay, sdyn[S + g], l);
  itemCell[g] = vec4i(ix, iy, i32(l), 0);
  let b = bucketOf(l, ix, iy);
  itemKey[g] = b;
  atomicAdd(&cellCount[b], 1u);
}
`;
}

/** Scatter and per-bucket ordering (separate module: different bindings). */
export const HASH_SCATTER_WGSL = /* wgsl */ `
struct HP { nItems: u32, mask: u32, segCap: u32, dt: f32 };
@group(0) @binding(0) var<uniform> H: HP;
@group(0) @binding(1) var<storage, read> itemKey: array<u32>;
@group(0) @binding(2) var<storage, read> cellStart: array<u32>;
@group(0) @binding(3) var<storage, read_write> cellFill: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> sorted: array<u32>;

@compute @workgroup_size(${HASH_WG})
fn hash_scatter(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let g = gid.x + gid.y * nwg.x * ${HASH_WG}u;
  if (g >= H.nItems) { return; }
  let b = itemKey[g];
  let slot = cellStart[b] + atomicAdd(&cellFill[b], 1u);
  sorted[slot] = g;
}
`;

export const BUCKET_SORT_WGSL = /* wgsl */ `
struct HP { nItems: u32, mask: u32, segCap: u32, dt: f32 };
@group(0) @binding(0) var<uniform> H: HP;
@group(0) @binding(1) var<storage, read> cellStart: array<u32>;
@group(0) @binding(2) var<storage, read_write> sorted: array<u32>;

// insertion sort of one bucket by item index (buckets hold a handful of items at load 0.5)
@compute @workgroup_size(${HASH_WG})
fn bucket_sort(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let b = gid.x + gid.y * nwg.x * ${HASH_WG}u;
  if (b > H.mask) { return; }
  let s0 = cellStart[b];
  var s1 = H.nItems;
  if (b < H.mask) { s1 = cellStart[b + 1u]; }
  for (var i = s0 + 1u; i < s1; i++) {
    let v = sorted[i];
    var j = i;
    while (j > s0 && sorted[j - 1u] > v) { sorted[j] = sorted[j - 1u]; j = j - 1u; }
    sorted[j] = v;
  }
}
`;
