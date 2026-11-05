/**
 * WGSL: the full-tier integrator, one thread per creature (src/physics/solver.ts and tree.ts,
 * 02 §2.7.1 to §2.7.3). Every substep: drag-augmented generalised mass with added mass and
 * the two-Gauss-point anisotropic drag, buoyancy, cilia, linearised muscles, the implicit
 * velocity solve, then the exact O(n) tree solve of all joints (Baraff) and the hard limits;
 * then walls, velocities from positions and muscle work. Once per tick: activation lag,
 * c_a(Re), the substep rule, the creature summary, `powerW`, and re-anchoring.
 *
 * Precision (02 §2.7.6): positions are f32 offsets from a per-creature Q16.16 anchor. All
 * arithmetic is f32 (WGSL has no f64); 3x3 inverses are Jacobi-scaled so the 1e-9 kg, 1e-17
 * kg m^2 blocks of a 0.5 mm microbe stay well inside the f32 range.
 *
 * Seven storage buffers (R23: at most 8 per stage). Arrays are field-major: field f of
 * segment i is at `f * P.segCap + i`.
 */
export const PHYS_WG = 64;

/** Static segment fields (f32), uploaded on load, restage and every command change. */
export const SST = {
  LEN: 0, RAD: 1, SPAN: 2, MASS: 3, INER: 4, ATT: 5, REST: 6, LO: 7, HI: 8, COMP: 9, DAMP: 10, TAUMAX: 11, OMEGA: 12,
  CMD: 13, CMD2: 14, DAMAGE: 15, D0: 16, MFRAC: 21, N: 22,
} as const;
/** Integer segment fields (u32): local parent (i32 bits), kind | organs << 8. */
export const SINT = { PARENT: 0, KIND: 1, N: 2 } as const;
/** Dynamic segment fields (f32). */
export const SDYN = { OX: 0, OY: 1, ANG: 2, VX: 3, VY: 4, W: 5, ACT: 6, WORK: 7, RESTPREV: 8, NETWORK: 9, N: 10 } as const;
/** Creature input record (u32 x 8): segBase, n, mirror (i32), length, tempC, massKg (f32 bits). */
export const CRI = { BASE: 0, N: 1, MIR: 2, LEN: 3, TEMP: 4, MASS: 5, STRIDE: 8 } as const;
/** Creature output record (u32 x 8): anchorX, anchorY (i32 Q16.16), velX, velY, heading, angVel, powerW (f32), nSub. */
export const CRO = { AX: 0, AY: 1, VX: 2, VY: 3, HEAD: 4, W: 5, POW: 6, NSUB: 7, STRIDE: 8 } as const;
/** Scratch fields per segment. */
const SCR_N = 70;
export const SCRATCH_FIELDS = SCR_N;

export interface PhysConsts {
  gravity: number; rhoWater: number; nuWater: number; muWater: number; cAdded: number; gaussXi: number;
  kappaCilia: number; ciliaSlip: number; etaCilia: number; etaMuscle: number; kappaIso: number; ln2Q10: number;
  b0: number; eaOverK: number; tRef: number; kleiber: number; kindFin: number; organCilia: number; pi: number;
}

const f = (x: number): string => {
  const s = String(x);
  return /[.eE]/.test(s) ? s : `${s}.0`;
};

export function physicsWgsl(k: PhysConsts): string {
  return /* wgsl */ `
struct Params {
  dt: f32, W: f32, H: f32, top: f32,
  nCr: u32, segCap: u32, nSubFixed: u32, minSub: u32,
  flags: u32, gw: u32, gh: u32, cs: f32,
  _p0: u32, _p1: u32, _p2: u32, _p3: u32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> cri: array<u32>;
@group(0) @binding(2) var<storage, read_write> cro: array<u32>;
@group(0) @binding(3) var<storage, read> sst: array<f32>;
@group(0) @binding(4) var<storage, read> sint: array<u32>;
@group(0) @binding(5) var<storage, read_write> sdyn: array<f32>;
@group(0) @binding(6) var<storage, read> flow: array<f32>;
@group(0) @binding(7) var<storage, read_write> scr: array<f32>;

const FL_FLUID: u32 = 1u; const FL_GRAV: u32 = 2u; const FL_ADDED: u32 = 4u; const FL_WALLS: u32 = 8u;
const FL_LINEAR: u32 = 16u; const FL_PRESCRIBED: u32 = 32u; const FL_REANCHOR: u32 = 64u;
const PI: f32 = ${f(k.pi)}; const TAU: f32 = ${f(2 * k.pi)};
const GRAVITY: f32 = ${f(k.gravity)}; const RHO_W: f32 = ${f(k.rhoWater)}; const NU_W: f32 = ${f(k.nuWater)};
const MU_W: f32 = ${f(k.muWater)}; const C_ADDED: f32 = ${f(k.cAdded)}; const GAUSS_XI: f32 = ${f(k.gaussXi)};
const KAPPA_CILIA: f32 = ${f(k.kappaCilia)}; const CILIA_SLIP: f32 = ${f(k.ciliaSlip)}; const ETA_CILIA: f32 = ${f(k.etaCilia)};
const ETA_MUSCLE: f32 = ${f(k.etaMuscle)}; const KAPPA_ISO: f32 = ${f(k.kappaIso)}; const LN2_Q10: f32 = ${f(k.ln2Q10)};
const B0: f32 = ${f(k.b0)}; const EA_K: f32 = ${f(k.eaOverK)}; const T_REF: f32 = ${f(k.tRef)}; const KLEIBER: f32 = ${f(k.kleiber)};
const KIND_FIN: u32 = ${k.kindFin}u; const ORGAN_CILIA: u32 = ${k.organCilia}u;
const Q16: f32 = 65536.0; const Q16INV: f32 = 1.52587890625e-5;

// scratch fields
const TH: u32 = 0u; const VX: u32 = 1u; const VY: u32 = 2u; const WW: u32 = 3u; const XP: u32 = 4u; const YP: u32 = 5u;
const THP: u32 = 6u; const UX: u32 = 7u; const UY: u32 = 8u; const PHI: u32 = 9u; const AI: u32 = 10u; const AM: u32 = 16u;
const IE: u32 = 22u; const RHS: u32 = 23u; const TAUF: u32 = 26u; const CM: u32 = 27u; const TAUR: u32 = 28u;
const DB: u32 = 29u; const DJ: u32 = 38u; const JPA: u32 = 47u; const JPB: u32 = 48u; const JCC: u32 = 49u; const JCD: u32 = 50u;
const YB: u32 = 51u; const YJ: u32 = 54u; const XB: u32 = 57u; const XJ: u32 = 60u; const CJ: u32 = 63u; const DCB: u32 = 66u;

fn S(fi: u32, i: u32) -> f32 { return scr[fi * P.segCap + i]; }
fn setS(fi: u32, i: u32, v: f32) { scr[fi * P.segCap + i] = v; }
fn addS(fi: u32, i: u32, v: f32) { scr[fi * P.segCap + i] = scr[fi * P.segCap + i] + v; }
fn T(fi: u32, i: u32) -> f32 { return sst[fi * P.segCap + i]; }
fn D(fi: u32, i: u32) -> f32 { return sdyn[fi * P.segCap + i]; }
fn setD(fi: u32, i: u32, v: f32) { sdyn[fi * P.segCap + i] = v; }
fn addD(fi: u32, i: u32, v: f32) { sdyn[fi * P.segCap + i] = sdyn[fi * P.segCap + i] + v; }
fn parentOf(i: u32) -> i32 { return bitcast<i32>(sint[i]); }
fn kindOf(i: u32) -> u32 { return sint[P.segCap + i] & 255u; }
fn organsOf(i: u32) -> u32 { return sint[P.segCap + i] >> 8u; }

fn wrapAngle(a: f32) -> f32 {
  var r = a - TAU * floor((a + PI) / TAU);
  if (r <= -PI) { r = r + TAU; }
  if (r > PI) { r = r - TAU; }
  return r;
}

fn segVolume(plate: bool, l: f32, r: f32, span: f32) -> f32 {
  if (plate) { return l * span * 2.0 * r; }
  var ell = 1.0;
  if (span > 0.0) { ell = span / (2.0 * r); }
  return (PI * r * r * l + (4.0 / 3.0) * PI * r * r * r) * ell;
}

fn sampleFlow(x: f32, y: f32) -> vec2f {
  let w = P.gw; let h = P.gh;
  var gx = x / P.cs - 0.5; var gy = y / P.cs - 0.5;
  gx = clamp(gx, 0.0, f32(w) - 1.001); gy = clamp(gy, 0.0, f32(h) - 1.001);
  let ix = u32(floor(gx)); let iy = u32(floor(gy));
  let fx = gx - f32(ix); let fy = gy - f32(iy);
  let i00 = iy * w + ix; let nn = w * h;
  let u = (flow[i00] * (1.0 - fx) + flow[i00 + 1u] * fx) * (1.0 - fy) + (flow[i00 + w] * (1.0 - fx) + flow[i00 + w + 1u] * fx) * fy;
  let v = (flow[nn + i00] * (1.0 - fx) + flow[nn + i00 + 1u] * fx) * (1.0 - fy) + (flow[nn + i00 + w] * (1.0 - fx) + flow[nn + i00 + w + 1u] * fx) * fy;
  return vec2f(u, v);
}

// Jacobi-scaled general 3x3 inverse: inv(M) = S inv(S M S) S with S = diag(1 / sqrt(|m_kk|)).
fn inv3(m: array<f32, 9>) -> array<f32, 9> {
  let s0 = 1.0 / sqrt(max(abs(m[0]), 1e-37)); let s1 = 1.0 / sqrt(max(abs(m[4]), 1e-37)); let s2 = 1.0 / sqrt(max(abs(m[8]), 1e-37));
  let a = m[0] * s0 * s0; let b = m[1] * s0 * s1; let c = m[2] * s0 * s2;
  let d = m[3] * s1 * s0; let e = m[4] * s1 * s1; let ff = m[5] * s1 * s2;
  let g = m[6] * s2 * s0; let h = m[7] * s2 * s1; let i = m[8] * s2 * s2;
  let A = e * i - ff * h; let B = -(d * i - ff * g); let C = d * h - e * g;
  let r = 1.0 / (a * A + b * B + c * C);
  var o: array<f32, 9>;
  o[0] = A * r * s0 * s0; o[1] = -(b * i - c * h) * r * s0 * s1; o[2] = (b * ff - c * e) * r * s0 * s2;
  o[3] = B * r * s1 * s0; o[4] = (a * i - c * g) * r * s1 * s1; o[5] = -(a * ff - c * d) * r * s1 * s2;
  o[6] = C * r * s2 * s0; o[7] = -(a * h - b * g) * r * s2 * s1; o[8] = (a * e - b * d) * r * s2 * s2;
  return o;
}

fn ldm(fi: u32, i: u32) -> array<f32, 9> {
  var m: array<f32, 9>;
  for (var q = 0u; q < 9u; q++) { m[q] = S(fi + q, i); }
  return m;
}
fn stm(fi: u32, i: u32, m: array<f32, 9>) { for (var q = 0u; q < 9u; q++) { setS(fi + q, i, m[q]); } }

fn tauAct(L: f32) -> f32 { return clamp(0.05 * pow(max(L, 1e-6) / 0.1, 0.2), 0.03, 0.12); }
fn basalW(m: f32, tempC: f32) -> f32 {
  let Tk = tempC + 273.15;
  return B0 * pow(max(m, 1e-15), KLEIBER) * exp(EA_K * (1.0 / T_REF - 1.0 / Tk));
}

fn applyTorque(p: u32, i: u32, dl: f32) {
  addD(${'0u'}, p, -S(AI + 2u, p) * dl); addD(1u, p, -S(AI + 4u, p) * dl); addS(TH, p, -S(AI + 5u, p) * dl);
  addD(${'0u'}, i, S(AI + 2u, i) * dl); addD(1u, i, S(AI + 4u, i) * dl); addS(TH, i, S(AI + 5u, i) * dl);
}

fn solveTree(b: u32, n: u32, h: f32, mir: f32, frac: f32, prescribed: bool) {
  // assemble joint rows
  for (var k = 1u; k < n; k++) {
    let i = b + k; let p = b + u32(parentOf(i));
    let thp = S(TH, p); let thc = S(TH, i);
    let cp = cos(thp); let sp = sin(thp); let cc = cos(thc); let sc = sin(thc);
    let lp = T(${SST.ATT}u, i) * T(${SST.LEN}u, p); let lc = -0.5 * T(${SST.LEN}u, i);
    let rpx = lp * cp; let rpy = lp * sp; let rcx = lc * cc; let rcy = lc * sc;
    setS(JPA, i, -rpy); setS(JPB, i, rpx); setS(JCC, i, rcy); setS(JCD, i, -rcx);
    setS(CJ, i, D(0u, p) + rpx - D(0u, i) - rcx);
    setS(CJ + 1u, i, D(1u, p) + rpy - D(1u, i) - rcy);
    let restA = T(${SST.REST}u, i); let restB = D(${SDYN.RESTPREV}u, i);
    let rest = mir * (restB + wrapAngle(restA - restB) * frac);
    var Cb = wrapAngle(thc - thp - rest);
    var alpha = 0.0;
    let dC = (thc - S(THP, i)) - (thp - S(THP, p));
    setS(DCB, i, dC);
    if (!prescribed) {
      let comp = T(${SST.COMP}u, i);
      Cb = Cb - S(TAUF, i) * comp;
      let at = comp / (h * h);
      let kk = 1.0 / comp;
      let iep = S(IE, p); let iec = S(IE, i);
      let ie = iec * iep / (iec + iep);
      let beta = T(${SST.DAMP}u, i) * 2.0 * sqrt(kk * ie);
      let gamma = comp * (beta + S(CM, i)) / h;
      Cb = (Cb + gamma * dC) / (1.0 + gamma);
      alpha = at / (1.0 + gamma);
    }
    setS(CJ + 2u, i, Cb);
    for (var q = 0u; q < 9u; q++) { setS(DJ + q, i, 0.0); }
    setS(DJ + 8u, i, -alpha);
  }
  for (var k = 0u; k < n; k++) {
    let i = b + k;
    setS(DB, i, S(AM, i)); setS(DB + 1u, i, S(AM + 1u, i)); setS(DB + 2u, i, S(AM + 2u, i));
    setS(DB + 3u, i, S(AM + 1u, i)); setS(DB + 4u, i, S(AM + 3u, i)); setS(DB + 5u, i, S(AM + 4u, i));
    setS(DB + 6u, i, S(AM + 2u, i)); setS(DB + 7u, i, S(AM + 4u, i)); setS(DB + 8u, i, S(AM + 5u, i));
    setS(YB, i, 0.0); setS(YB + 1u, i, 0.0); setS(YB + 2u, i, 0.0);
  }
  // factor and forward substitution, leaves first
  for (var k = n - 1u; k >= 1u; k--) {
    let i = b + k; let p = b + u32(parentOf(i));
    let Bm = inv3(ldm(DB, i));
    stm(DB, i, Bm);
    let c = S(JCC, i); let d = S(JCD, i);
    let q00 = Bm[0] - 2.0 * c * Bm[2] + c * c * Bm[8];
    let q01 = Bm[1] - d * Bm[2] - c * Bm[5] + c * d * Bm[8];
    let q02 = -Bm[2] + c * Bm[8];
    let q11 = Bm[4] - 2.0 * d * Bm[5] + d * d * Bm[8];
    let q12 = -Bm[5] + d * Bm[8];
    var Dj = ldm(DJ, i);
    Dj[0] = Dj[0] - q00; Dj[1] = Dj[1] - q01; Dj[2] = Dj[2] - q02;
    Dj[3] = Dj[3] - q01; Dj[4] = Dj[4] - q11; Dj[5] = Dj[5] - q12;
    Dj[6] = Dj[6] - q02; Dj[7] = Dj[7] - q12; Dj[8] = Dj[8] - Bm[8];
    // y_J = C + Jc DBinv y_B, Jc = [[-1, 0, c], [0, -1, d], [0, 0, 1]]
    let yb0 = S(YB, i); let yb1 = S(YB + 1u, i); let yb2 = S(YB + 2u, i);
    let t0 = Bm[0] * yb0 + Bm[1] * yb1 + Bm[2] * yb2;
    let t1 = Bm[3] * yb0 + Bm[4] * yb1 + Bm[5] * yb2;
    let t2 = Bm[6] * yb0 + Bm[7] * yb1 + Bm[8] * yb2;
    let yj0 = S(CJ, i) - t0 + c * t2; let yj1 = S(CJ + 1u, i) - t1 + d * t2; let yj2 = S(CJ + 2u, i) + t2;
    setS(YJ, i, yj0); setS(YJ + 1u, i, yj1); setS(YJ + 2u, i, yj2);
    let G = inv3(Dj);
    stm(DJ, i, G);
    // parent body: D_B -= Jp^T DJinv Jp, Jp = [[1, 0, a], [0, 1, bb], [0, 0, -1]]
    let a = S(JPA, i); let bb = S(JPB, i);
    let e02 = a * G[0] + bb * G[1] - G[2];
    let e12 = a * G[1] + bb * G[4] - G[5];
    let e22 = a * a * G[0] + 2.0 * a * bb * G[1] - 2.0 * a * G[2] + bb * bb * G[4] - 2.0 * bb * G[5] + G[8];
    addS(DB, p, -G[0]); addS(DB + 1u, p, -G[1]); addS(DB + 2u, p, -e02);
    addS(DB + 3u, p, -G[1]); addS(DB + 4u, p, -G[4]); addS(DB + 5u, p, -e12);
    addS(DB + 6u, p, -e02); addS(DB + 7u, p, -e12); addS(DB + 8u, p, -e22);
    // y_B(parent) += Jp^T DJinv y_J
    let u0 = G[0] * yj0 + G[1] * yj1 + G[2] * yj2;
    let u1 = G[3] * yj0 + G[4] * yj1 + G[5] * yj2;
    let u2 = G[6] * yj0 + G[7] * yj1 + G[8] * yj2;
    addS(YB, p, u0); addS(YB + 1u, p, u1); addS(YB + 2u, p, a * u0 + bb * u1 - u2);
    if (k == 1u) { break; }
  }
  {
    let Bm = inv3(ldm(DB, b));
    stm(DB, b, Bm);
    let y0 = S(YB, b); let y1 = S(YB + 1u, b); let y2 = S(YB + 2u, b);
    setS(XB, b, Bm[0] * y0 + Bm[1] * y1 + Bm[2] * y2);
    setS(XB + 1u, b, Bm[3] * y0 + Bm[4] * y1 + Bm[5] * y2);
    setS(XB + 2u, b, Bm[6] * y0 + Bm[7] * y1 + Bm[8] * y2);
  }
  for (var k = 1u; k < n; k++) {
    let i = b + k; let p = b + u32(parentOf(i));
    let xp0 = S(XB, p); let xp1 = S(XB + 1u, p); let xp2 = S(XB + 2u, p);
    let a = S(JPA, i); let bb = S(JPB, i);
    let v0 = S(YJ, i) + xp0 + a * xp2;
    let v1 = S(YJ + 1u, i) + xp1 + bb * xp2;
    let v2 = S(YJ + 2u, i) - xp2;
    let G = ldm(DJ, i);
    let l0 = G[0] * v0 + G[1] * v1 + G[2] * v2;
    let l1 = G[3] * v0 + G[4] * v1 + G[5] * v2;
    let l2 = G[6] * v0 + G[7] * v1 + G[8] * v2;
    let c = S(JCC, i); let d = S(JCD, i);
    let w0 = S(YB, i) - l0; let w1 = S(YB + 1u, i) - l1; let w2 = S(YB + 2u, i) + c * l0 + d * l1 + l2;
    let Bm = ldm(DB, i);
    setS(XB, i, Bm[0] * w0 + Bm[1] * w1 + Bm[2] * w2);
    setS(XB + 1u, i, Bm[3] * w0 + Bm[4] * w1 + Bm[5] * w2);
    setS(XB + 2u, i, Bm[6] * w0 + Bm[7] * w1 + Bm[8] * w2);
  }
  for (var k = 0u; k < n; k++) {
    let i = b + k;
    addD(0u, i, S(XB, i)); addD(1u, i, S(XB + 1u, i)); addS(TH, i, S(XB + 2u, i));
  }
  if (!prescribed) {
    for (var k = 1u; k < n; k++) {
      let i = b + k; let p = b + u32(parentOf(i));
      let dCafter = S(DCB, i) + S(XB + 2u, i) - S(XB + 2u, p);
      setS(TAUR, i, S(TAUF, i) - S(CM, i) * dCafter / h);
    }
  }
}

fn solveLimit(i: u32, p: u32, mir: f32, frac: f32) {
  let restA = T(${SST.REST}u, i); let restB = D(${SDYN.RESTPREV}u, i);
  let rest = mir * (restB + wrapAngle(restA - restB) * frac);
  var lo = T(${SST.LO}u, i) - restA; var hi = T(${SST.HI}u, i) - restA;
  if (mir < 0.0) { let t = lo; lo = -hi; hi = -t; }
  if (!(lo < hi)) { return; }
  let d = wrapAngle(S(TH, i) - S(TH, p) - rest);
  var Cl = 0.0;
  if (d < lo) { Cl = d - lo; } else if (d > hi) { Cl = d - hi; }
  if (Cl == 0.0) { return; }
  let wB = S(AI + 5u, p) + S(AI + 5u, i);
  applyTorque(p, i, -Cl / wB);
}

@compute @workgroup_size(${PHYS_WG})
fn integrate(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let c = gid.x + gid.y * nwg.x * ${PHYS_WG}u;
  if (c >= P.nCr) { return; }
  let ci = c * ${CRI.STRIDE}u; let co = c * ${CRO.STRIDE}u;
  let b = cri[ci + ${CRI.BASE}u]; let n = cri[ci + ${CRI.N}u];
  var mir = 1.0; if (bitcast<i32>(cri[ci + ${CRI.MIR}u]) < 0) { mir = -1.0; }
  let crLen = bitcast<f32>(cri[ci + ${CRI.LEN}u]); let tempC = bitcast<f32>(cri[ci + ${CRI.TEMP}u]);
  let crMass = bitcast<f32>(cri[ci + ${CRI.MASS}u]);
  let ax = f32(bitcast<i32>(cro[co + ${CRO.AX}u])) * Q16INV; let ay = f32(bitcast<i32>(cro[co + ${CRO.AY}u])) * Q16INV;
  let fluid = (P.flags & FL_FLUID) != 0u; let grav = (P.flags & FL_GRAV) != 0u;
  let prescribed = (P.flags & FL_PRESCRIBED) != 0u; let lin = select(1.0, 0.0, (P.flags & FL_LINEAR) != 0u);
  let dt = P.dt;
  // ---- once per tick
  var mTot = 0.0; var lenTot = 0.0; var rMin = 3.0e38; var vMax = 0.0; var anyActive = false;
  for (var k = 0u; k < n; k++) {
    let i = b + k;
    setS(TH, i, D(${SDYN.ANG}u, i)); setS(VX, i, D(${SDYN.VX}u, i)); setS(VY, i, D(${SDYN.VY}u, i)); setS(WW, i, D(${SDYN.W}u, i));
    var u = vec2f(0.0, 0.0);
    if (fluid) { u = sampleFlow(ax + D(0u, i), ay + D(1u, i)); }
    setS(UX, i, u.x); setS(UY, i, u.y);
    var phi = 1.0;
    if (kindOf(i) == KIND_FIN) { phi = 1.0 - 0.8 * min(1.0, abs(T(${SST.CMD2}u, i))); }
    setS(PHI, i, phi);
    mTot = mTot + T(${SST.MASS}u, i);
    if (k == 0u || parentOf(i) >= 0) { lenTot = lenTot + T(${SST.LEN}u, i); }
    rMin = min(rMin, T(${SST.RAD}u, i));
    let dvx = D(${SDYN.VX}u, i) - u.x; let dvy = D(${SDYN.VY}u, i) - u.y;
    let sp = sqrt(dvx * dvx + dvy * dvy) + abs(D(${SDYN.W}u, i)) * 0.5 * T(${SST.LEN}u, i);
    vMax = max(vMax, sp);
    if (T(${SST.CMD}u, i) != 0.0 || D(${SDYN.ACT}u, i) != 0.0) { anyActive = true; }
    setD(${SDYN.NETWORK}u, i, 0.0); setD(${SDYN.WORK}u, i, 0.0);
  }
  var L = lenTot; if (crLen > 0.0) { L = crLen; }
  var ca = 0.0;
  if ((P.flags & FL_ADDED) != 0u && fluid) { let re = L * vMax / NU_W; ca = re / (re + 10.0); }
  let kAct = 1.0 - exp(-dt / tauAct(L));
  let q10 = exp(LN2_Q10 * (tempC - 15.0) / 10.0);
  for (var k = 1u; k < n; k++) {
    let i = b + k;
    let u = clamp(T(${SST.CMD}u, i), -1.0, 1.0);
    setD(${SDYN.ACT}u, i, D(${SDYN.ACT}u, i) + (u - D(${SDYN.ACT}u, i)) * kAct);
  }
  var nSub = P.nSubFixed;
  if (nSub == 0u) {
    let need = max(1.0, vMax * dt / (0.5 * rMin));
    nSub = 1u;
    while (f32(nSub) < need && nSub < 16u) { nSub = nSub * 2u; }
    var floorN = P.minSub; if (anyActive) { floorN = max(4u, P.minSub); }
    nSub = clamp(nSub, floorN, 16u);
  }
  let h = dt / f32(nSub);
  var ciliaP = 0.0;
  let wallR = P.W; let wallB = P.H; let top = P.top;
  for (var s = 0u; s < nSub; s++) {
    // ---- 1. drag-augmented mass, explicit forces
    for (var k = 0u; k < n; k++) {
      let i = b + k;
      let th = S(TH, i); let cs = cos(th); let sn = sin(th);
      let m = T(${SST.MASS}u, i); let l = T(${SST.LEN}u, i); let r = T(${SST.RAD}u, i); let span = T(${SST.SPAN}u, i);
      let plate = kindOf(i) == KIND_FIN;
      var M00 = m; var M01 = 0.0; var M11 = m; var Ie = T(${SST.INER}u, i);
      if (ca > 0.0) {
        var spn = 2.0 * r; if (span > 0.0) { spn = span; }
        let man = C_ADDED * RHO_W * PI * (spn / 2.0) * (spn / 2.0) * l;
        let mat = 0.1 * RHO_W * PI * r * r * l;
        let ia = man * l * l / 12.0;
        let at = ca * mat; let an = ca * man * S(PHI, i);
        M00 = M00 + at * cs * cs + an * sn * sn;
        M01 = M01 + (at - an) * cs * sn;
        M11 = M11 + at * sn * sn + an * cs * cs;
        Ie = Ie + ca * ia * S(PHI, i);
      }
      setS(IE, i, Ie);
      let v0 = S(VX, i); let v1 = S(VY, i); let om = S(WW, i);
      var a00 = M00; var a01 = M01; var a02 = 0.0; var a11 = M11; var a12 = 0.0; var a22 = Ie;
      var r0 = M00 * v0 + M01 * v1; var r1 = M01 * v0 + M11 * v1; var r2 = Ie * om;
      if (fluid) {
        let kt1 = T(${SST.D0}u, i); let kn1 = T(${SST.D0 + 1}u, i); let kt15 = T(${SST.D0 + 2}u, i) * lin;
        let kt2 = T(${SST.D0 + 3}u, i) * lin; let kn2 = T(${SST.D0 + 4}u, i) * S(PHI, i) * lin;
        let ux = S(UX, i); let uy = S(UY, i);
        let xi = GAUSS_XI * l;
        for (var g = -1.0; g <= 1.0; g = g + 2.0) {
          let rx = g * xi * cs; let ry = g * xi * sn;
          let relx = v0 - om * ry - ux; let rely = v1 + om * rx - uy;
          let vt = relx * cs + rely * sn; let vn = -relx * sn + rely * cs;
          let ct = 0.5 * (kt1 + kt15 * sqrt(abs(vt)) + kt2 * abs(vt));
          let cn = 0.5 * (kn1 + kn2 * abs(vn));
          let D00 = ct * cs * cs + cn * sn * sn; let D01 = (ct - cn) * cs * sn; let D11 = ct * sn * sn + cn * cs * cs;
          let d3x = -D00 * ry + D01 * rx; let d3y = -D01 * ry + D11 * rx;
          a00 = a00 + h * D00; a01 = a01 + h * D01; a11 = a11 + h * D11; a02 = a02 + h * d3x; a12 = a12 + h * d3y;
          a22 = a22 + h * (-ry * d3x + rx * d3y);
          let fux = D00 * ux + D01 * uy; let fuy = D01 * ux + D11 * uy;
          r0 = r0 + h * fux; r1 = r1 + h * fuy; r2 = r2 + h * (-ry * fux + rx * fuy);
        }
      }
      var fx = 0.0; var fy = 0.0;
      if (grav) { fy = fy + (m - RHO_W * segVolume(plate, l, r, span)) * GRAVITY; }
      if ((organsOf(i) & ORGAN_CILIA) != 0u) {
        let ac = clamp(T(${SST.CMD2}u, i), 0.0, 1.0);
        let F = ac * MU_W * KAPPA_CILIA * l * CILIA_SLIP;
        fx = fx + F * cs; fy = fy + F * sn;
        if (s == 0u) { ciliaP = ciliaP + F * CILIA_SLIP / ETA_CILIA; }
      }
      r0 = r0 + h * fx; r1 = r1 + h * fy;
      setS(AM, i, a00); setS(AM + 1u, i, a01); setS(AM + 2u, i, a02); setS(AM + 3u, i, a11); setS(AM + 4u, i, a12); setS(AM + 5u, i, a22);
      var mt: array<f32, 9>;
      mt[0] = a00; mt[1] = a01; mt[2] = a02; mt[3] = a01; mt[4] = a11; mt[5] = a12; mt[6] = a02; mt[7] = a12; mt[8] = a22;
      let iv = inv3(mt);
      // symmetrise (the CPU stores the upper triangle of the exact inverse)
      setS(AI, i, iv[0]); setS(AI + 1u, i, 0.5 * (iv[1] + iv[3])); setS(AI + 2u, i, 0.5 * (iv[2] + iv[6]));
      setS(AI + 3u, i, iv[4]); setS(AI + 4u, i, 0.5 * (iv[5] + iv[7])); setS(AI + 5u, i, iv[8]);
      setS(RHS, i, r0); setS(RHS + 1u, i, r1); setS(RHS + 2u, i, r2);
    }
    // ---- 2. muscles
    if (!prescribed) {
      for (var k = 1u; k < n; k++) {
        let i = b + k;
        let a = D(${SDYN.ACT}u, i);
        setS(TAUF, i, 0.0); setS(CM, i, 0.0); setS(TAUR, i, 0.0);
        if (a == 0.0 || T(${SST.TAUMAX}u, i) <= 0.0) { continue; }
        var dir = -1.0; if (a * mir > 0.0) { dir = 1.0; }
        let wMax = T(${SST.OMEGA}u, i) * q10;
        let amax = abs(a) * T(${SST.TAUMAX}u, i) * (1.0 - T(${SST.DAMAGE}u, i));
        setS(TAUF, i, dir * amax);
        setS(CM, i, amax / wMax);
      }
    }
    // ---- 3. implicit velocity solve and predict
    for (var k = 0u; k < n; k++) {
      let i = b + k;
      let r0 = S(RHS, i); let r1 = S(RHS + 1u, i); let r2 = S(RHS + 2u, i);
      let nvx = S(AI, i) * r0 + S(AI + 1u, i) * r1 + S(AI + 2u, i) * r2;
      let nvy = S(AI + 1u, i) * r0 + S(AI + 3u, i) * r1 + S(AI + 4u, i) * r2;
      let nw = S(AI + 2u, i) * r0 + S(AI + 4u, i) * r1 + S(AI + 5u, i) * r2;
      setS(VX, i, nvx); setS(VY, i, nvy); setS(WW, i, nw);
      setS(XP, i, D(0u, i)); setS(YP, i, D(1u, i)); setS(THP, i, S(TH, i));
      addD(0u, i, h * nvx); addD(1u, i, h * nvy); addS(TH, i, h * nw);
    }
    // ---- 4. joints: exact tree solve, then the hard limits
    let frac = f32(s + 1u) / f32(nSub);
    if (n > 1u) {
      solveTree(b, n, h, mir, frac, prescribed);
      for (var k = 1u; k < n; k++) { solveLimit(b + k, b + u32(parentOf(b + k)), mir, frac); }
    }
    // ---- 5. walls, velocities, work
    for (var k = 0u; k < n; k++) {
      let i = b + k;
      if ((P.flags & FL_WALLS) != 0u) {
        let r = T(${SST.RAD}u, i);
        let x = ax + D(0u, i); let y = ay + D(1u, i);
        if (x < r) { setD(0u, i, r - ax); } else if (x > wallR - r) { setD(0u, i, (wallR - r) - ax); }
        if (y < top + r) { setD(1u, i, (top + r) - ay); } else if (y > wallB - r) { setD(1u, i, (wallB - r) - ay); }
      }
      setS(VX, i, (D(0u, i) - S(XP, i)) / h); setS(VY, i, (D(1u, i) - S(YP, i)) / h); setS(WW, i, (S(TH, i) - S(THP, i)) / h);
    }
    if (!prescribed) {
      for (var k = 1u; k < n; k++) {
        let i = b + k; let p = b + u32(parentOf(i));
        let dRel = (S(TH, i) - S(THP, i)) - (S(TH, p) - S(THP, p));
        let dW = S(TAUR, i) * dRel;
        addD(${SDYN.NETWORK}u, i, dW);
        if (dW > 0.0) { addD(${SDYN.WORK}u, i, dW); }
      }
    }
  }
  // ---- store, summary, power
  var px = 0.0; var py = 0.0; var wPos = 0.0; var iso = 0.0;
  for (var k = 0u; k < n; k++) {
    let i = b + k;
    setD(${SDYN.ANG}u, i, wrapAngle(S(TH, i)));
    setD(${SDYN.VX}u, i, S(VX, i)); setD(${SDYN.VY}u, i, S(VY, i)); setD(${SDYN.W}u, i, S(WW, i));
    setD(${SDYN.RESTPREV}u, i, T(${SST.REST}u, i));
    px = px + T(${SST.MASS}u, i) * S(VX, i); py = py + T(${SST.MASS}u, i) * S(VY, i);
    if (k > 0u) {
      wPos = wPos + D(${SDYN.WORK}u, i);
      iso = iso + abs(D(${SDYN.ACT}u, i)) * T(${SST.MFRAC}u, i) * T(${SST.MASS}u, i);
    }
  }
  cro[co + ${CRO.VX}u] = bitcast<u32>(px / mTot); cro[co + ${CRO.VY}u] = bitcast<u32>(py / mTot);
  cro[co + ${CRO.HEAD}u] = bitcast<u32>(D(${SDYN.ANG}u, b)); cro[co + ${CRO.W}u] = bitcast<u32>(D(${SDYN.W}u, b));
  cro[co + ${CRO.NSUB}u] = nSub;
  var mBody = mTot; if (crMass > 0.0) { mBody = crMass; }
  var pIso = 0.0; if (iso > 0.0) { pIso = KAPPA_ISO * basalW(mBody, tempC) * iso / mTot; }
  cro[co + ${CRO.POW}u] = bitcast<u32>(wPos / ETA_MUSCLE / dt + pIso + ciliaP);
  // ---- re-anchor (02 §2.7.6): an exact multiple of the Q16 unit moves from the offsets to the anchor
  if ((P.flags & FL_REANCHOR) != 0u) {
    let sx = i32(round(D(0u, b) * Q16)); let sy = i32(round(D(1u, b) * Q16));
    if (sx != 0 || sy != 0) {
      cro[co + ${CRO.AX}u] = bitcast<u32>(bitcast<i32>(cro[co + ${CRO.AX}u]) + sx);
      cro[co + ${CRO.AY}u] = bitcast<u32>(bitcast<i32>(cro[co + ${CRO.AY}u]) + sy);
      let fx = f32(sx) * Q16INV; let fy = f32(sy) * Q16INV;
      for (var k = 0u; k < n; k++) { addD(0u, b + k, -fx); addD(1u, b + k, -fy); }
    }
  }
}
`;
}
