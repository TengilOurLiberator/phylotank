/**
 * WGSL: just enough software IEEE-754 binary64 for the integer transport to reproduce the CPU
 * bit for bit (WGSL has no f64). Values are non-negative, finite and normal (or zero), as every
 * quantity in `transportQ` is; f64 bits are `vec2u(lo, hi)` and u64 integers are `vec2u(lo, hi)`.
 * Operations: u64 add, subtract, compare, shifts; f64 multiply and add with round to nearest
 * even (the two roundings of `qi * x + dd`); `floor` to u64; u64 to f64; the exact `dd - 1`
 * for dd in [1, 2).
 */
export const F64_WGSL = /* wgsl */ `
fn add64(a: vec2u, b: vec2u) -> vec2u { let lo = a.x + b.x; return vec2u(lo, a.y + b.y + select(0u, 1u, lo < a.x)); }
fn sub64(a: vec2u, b: vec2u) -> vec2u { return vec2u(a.x - b.x, a.y - b.y - select(0u, 1u, a.x < b.x)); }
fn lt64(a: vec2u, b: vec2u) -> bool { return a.y < b.y || (a.y == b.y && a.x < b.x); }
fn isZero64(a: vec2u) -> bool { return a.x == 0u && a.y == 0u; }
fn shl64(a: vec2u, s: u32) -> vec2u {
  if (s == 0u) { return a; }
  if (s >= 64u) { return vec2u(0u, 0u); }
  if (s >= 32u) { return vec2u(0u, a.x << (s - 32u)); }
  return vec2u(a.x << s, (a.y << s) | (a.x >> (32u - s)));
}
fn shr64(a: vec2u, s: u32) -> vec2u {
  if (s == 0u) { return a; }
  if (s >= 64u) { return vec2u(0u, 0u); }
  if (s >= 32u) { return vec2u(a.y >> (s - 32u), 0u); }
  return vec2u((a.x >> s) | (a.y << (32u - s)), a.y >> s);
}
// bits shifted out by shr64(a, s) are nonzero
fn lostBits(a: vec2u, s: u32) -> bool {
  if (s == 0u) { return false; }
  if (s >= 64u) { return !isZero64(a); }
  let back = shl64(shr64(a, s), s);
  return back.x != a.x || back.y != a.y;
}
fn clz64(a: vec2u) -> u32 { if (a.y != 0u) { return countLeadingZeros(a.y); } return 32u + countLeadingZeros(a.x); }
fn mul32(a: u32, b: u32) -> vec2u {
  let aLo = a & 0xffffu; let aHi = a >> 16u; let bLo = b & 0xffffu; let bHi = b >> 16u;
  let ll = aLo * bLo; let lh = aLo * bHi; let hl = aHi * bLo; let hh = aHi * bHi;
  let mid = (ll >> 16u) + (lh & 0xffffu) + (hl & 0xffffu);
  return vec2u(a * b, hh + (lh >> 16u) + (hl >> 16u) + (mid >> 16u));
}

fn f64Exp(b: vec2u) -> u32 { return (b.y >> 20u) & 0x7ffu; }
fn f64Mant(b: vec2u) -> vec2u { return vec2u(b.x, (b.y & 0xfffffu) | 0x100000u); }
fn f64Pack(E: u32, M: vec2u) -> vec2u { return vec2u(M.x, (E << 20u) | (M.y & 0xfffffu)); }
fn f64IsZero(b: vec2u) -> bool { return b.x == 0u && (b.y & 0x7fffffffu) == 0u; }

// round M (with guard and sticky) to nearest even; returns the mantissa and an exponent carry
fn roundNE(M: vec2u, guard: bool, sticky: bool) -> vec3u {
  var m = M;
  if (guard && (sticky || (m.x & 1u) == 1u)) { m = add64(m, vec2u(1u, 0u)); }
  if ((m.y & 0x200000u) != 0u) { return vec3u(shr64(m, 1u), 1u); }
  return vec3u(m, 0u);
}

fn f64Mul(a: vec2u, b: vec2u) -> vec2u {
  if (f64IsZero(a) || f64IsZero(b)) { return vec2u(0u, 0u); }
  let ma = f64Mant(a); let mb = f64Mant(b);
  // 106-bit product in four limbs p0..p3
  let ll = mul32(ma.x, mb.x); let lh = mul32(ma.x, mb.y); let hl = mul32(ma.y, mb.x); let hh = mul32(ma.y, mb.y);
  var p0 = ll.x;
  var mid = add64(vec2u(ll.y, 0u), vec2u(lh.x, 0u));
  mid = add64(mid, vec2u(hl.x, 0u));
  let p1 = mid.x;
  var up = add64(vec2u(mid.y, 0u), vec2u(lh.y, 0u));
  up = add64(up, vec2u(hl.y, 0u));
  up = add64(up, hh);
  let p2 = up.x; let p3 = up.y;
  // leading bit is 104 or 105; shift right by s = 52 or 53
  var s = 52u; if ((p3 & 0x200u) != 0u) { s = 53u; }
  // M = bits [s, s + 53): from (p3:p2:p1) >> (s - 32)
  let t = s - 32u;
  let hi96 = vec2u(p2, p3);
  let M = vec2u((p1 >> t) | (p2 << (32u - t)), (p2 >> t) | (p3 << (32u - t)));
  let guard = ((p1 >> (t - 1u)) & 1u) == 1u;
  let below = (p1 & ((1u << (t - 1u)) - 1u)) != 0u || p0 != 0u;
  let r = roundNE(M, guard, below);
  let E = i32(f64Exp(a)) + i32(f64Exp(b)) - 1075 - 1075 + i32(s) + 1075 + i32(r.z);
  _ = hi96;
  return f64Pack(u32(E), r.xy);
}

fn f64Add(a0: vec2u, b0: vec2u) -> vec2u {
  if (f64IsZero(a0)) { return b0; }
  if (f64IsZero(b0)) { return a0; }
  var a = a0; var b = b0;
  if (f64Exp(b) > f64Exp(a)) { a = b0; b = a0; }
  var E = f64Exp(a);
  let A = shl64(f64Mant(a), 10u);
  let d = E - f64Exp(b);
  let Bf = shl64(f64Mant(b), 10u);
  var B = shr64(Bf, d);
  if (lostBits(Bf, d)) { B.x = B.x | 1u; }
  var S = add64(A, B);
  if ((S.y & 0x80000000u) != 0u) { let st = (S.x & 1u); S = shr64(S, 1u); S.x = S.x | st; E = E + 1u; }
  let M = shr64(S, 10u);
  let rbits = S.x & 0x3ffu;
  let r = roundNE(M, (rbits >> 9u) == 1u, (rbits & 0x1ffu) != 0u);
  return f64Pack(E + r.z, r.xy);
}

fn f64FloorU64(v: vec2u) -> vec2u {
  if (f64IsZero(v)) { return vec2u(0u, 0u); }
  let E = f64Exp(v);
  if (E < 1023u) { return vec2u(0u, 0u); }
  if (E >= 1075u) { return shl64(f64Mant(v), E - 1075u); }
  return shr64(f64Mant(v), 1075u - E);
}

fn u64ToF64(x: vec2u) -> vec2u {
  if (isZero64(x)) { return vec2u(0u, 0u); }
  let p = 63u - clz64(x);  // < 53 for every quanta count (MAX_WORLD_MASS is 2^53 quanta)
  return f64Pack(1023u + p, shl64(x, 52u - p));
}

fn f64Ge1(v: vec2u) -> bool { return v.y >= 0x3ff00000u; }
// exact v - 1 for v in [1, 2)
fn f64Sub1(v: vec2u) -> vec2u {
  let F = vec2u(v.x, v.y & 0xfffffu);
  if (isZero64(F)) { return vec2u(0u, 0u); }
  let p = 63u - clz64(F);
  return f64Pack(971u + p, shl64(F, 52u - p));
}
`;
