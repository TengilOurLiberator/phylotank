/**
 * Bodies: mass properties, drag coefficients, joints and muscle caps from SegmentSpecs
 * (02 §2.2.3 to §2.2.5, §2.3.1), written into the segment pool by `loadBody` and `restage`.
 */
import {
  KIND, NONE_U32, PI, cbrt, log, wrapAngle, type Phenotype, type World,
} from '../core/index.js';
import { SC, sincos } from './sincos.js';
const cos = (a: number): number => { sincos(a); return SC.c; };
const sin = (a: number): number => { sincos(a); return SC.s; };
import {
  C_ADDED, MU_WATER, OMEGA_MAX_15C, RHO_ARMOUR, RHO_LIPID, RHO_TISSUE, SIGMA_MUSCLE, SIGMA_STRUCT,
} from './constants.js';
import { NU_WATER, RHO_WATER } from '../core/index.js';
import { toSegmentSpecs, type SegmentSpec } from './segment-spec.js';
import { workFor } from './work.js';
import { initBladders } from './organs.js';

/** Volume of a segment from its pool geometry (capsule of elliptic section, or plate). */
export function segVolume(plate: boolean, l: number, r: number, span: number): number {
  if (plate) return l * span * 2 * r;
  const ell = span > 0 ? span / (2 * r) : 1;
  return (PI * r * r * l + (4 / 3) * PI * r * r * r) * ell;
}

export function isPlate(kind: number): boolean { return kind === KIND.FIN; }

export function tissueDensity(lipid: number, armour: number): number {
  const fArm = 1 - (1 - armour) * (1 - armour);
  const fLip = Math.min(lipid, 1 - fArm);
  return (1 - fLip - fArm) * RHO_TISSUE + fLip * RHO_LIPID + fArm * RHO_ARMOUR;
}

export interface MassProps { m: number; I: number; V: number }

export function massProps(s: SegmentSpec): MassProps {
  const V = segVolume(s.plate, s.length, s.radius, s.span);
  const m = tissueDensity(s.lipidFrac, s.armour) * V;
  const l = s.length;
  const I = s.plate ? m * l * l / 12 : m * (l * l / 12 + s.radius * s.radius / 4);
  return { m, I, V };
}

/** Added mass: tangential, normal and rotational (02 §2.2.3). */
export function addedMass(plate: boolean, l: number, r: number, span: number): [number, number, number] {
  const s = span > 0 ? span : 2 * r;
  const man = C_ADDED * RHO_WATER * PI * (s / 2) * (s / 2) * l;
  const mat = 0.1 * RHO_WATER * PI * r * r * l;
  void plate;
  return [mat, man, man * l * l / 12];
}

/**
 * Drag coefficients `k_t1, k_n1, k_t15, k_t2, k_n2` (02 §2.3.1). `endCap` adds the nose and
 * tail pressure drag of a capsule at the root and at free tips.
 */
export function dragCoeffs(
  plate: boolean, l: number, r: number, span: number, endCap: boolean, out: Float32Array, o: number, run = 0,
): void {
  const mu = MU_WATER;
  const rho = RHO_WATER;
  let kt1: number; let kn1: number; let swet: number; let kt2: number; let kn2: number;
  if (plate) {
    const a = Math.sqrt(l * span / PI);
    kt1 = (32 / 3) * mu * a;
    kn1 = 16 * mu * a;
    swet = 2 * l * span;
    kt2 = 0.5 * rho * 0.004 * swet;
    kn2 = 0.5 * rho * 1.2 * l * span;
  } else {
    const ar = l / r;
    const lg = log(2 * Math.max(ar, 4));
    const ktS = 2 * PI * mu * l / (lg - 0.5);
    const knS = 4 * PI * mu * l / (lg + 0.5);
    const V = segVolume(false, l, r, span);
    const req = cbrt(3 * V / (4 * PI));
    const kSph = 6 * PI * mu * req;
    const wS = Math.min(1, ar / 4);
    kt1 = wS * ktS + (1 - wS) * kSph;
    kn1 = wS * knS + (1 - wS) * kSph;
    if (kn1 < kt1) kn1 = kt1;
    swet = 2 * PI * r * l;
    kt2 = 0.5 * rho * 0.004 * swet + (endCap ? 0.5 * rho * 0.1 * PI * r * r : 0);
    kn2 = 0.5 * rho * 1.1 * (span > 0 ? span : 2 * r) * l;
  }
  // Laminar skin friction (Blasius): the wall shear at distance x from the leading edge is
  // 0.332 rho U^1.5 sqrt(nu / x), so a segment covering [run, run + l] of the boundary layer
  // carries 0.664 rho sqrt(nu) (S_wet / l) (sqrt(run + l) - sqrt(run)). With run = 0 this is the
  // isolated-plate value 0.665 rho sqrt(nu / l) S_wet of 02 §2.3.1; the trailing segments of
  // a body continue their parent's boundary layer (spike physics-2, B4).
  const kt15 = 0.665 * rho * Math.sqrt(NU_WATER) * (swet / l) * (Math.sqrt(run + l) - Math.sqrt(run));
  out[o] = kt1; out[o + 1] = kn1; out[o + 2] = kt15; out[o + 3] = kt2; out[o + 4] = kn2;
}

/**
 * Boundary-layer run length at the base of each segment: a capsule hung from an end of its
 * parent and roughly in line with it (within 30 degrees, either way round) continues the
 * parent's boundary layer; fins, side branches and the root start their own.
 */
export function boundaryRuns(specs: readonly SegmentSpec[]): Float64Array {
  const run = new Float64Array(specs.length);
  for (let k = 1; k < specs.length; k++) {
    const s = specs[k]!;
    const p = s.parent;
    if (p < 0 || s.plate || specs[p]!.plate) continue;
    const c = cos(s.restAngle);
    if (Math.abs(s.attachU) >= 0.45 && c * c > 0.75) run[k] = run[p]! + specs[p]!.length;
  }
  return run;
}

/** Write segment rows for creature `slot` from its phenotype. The segment range must be set. */
function writeSegments(
  world: World, slot: number, specs: SegmentSpec[], keepPose: boolean, subtypes?: ArrayLike<number>, partIdx?: ArrayLike<number>,
): void {
  const c = world.cr.c;
  const sg = world.seg.c;
  const s0 = c.segStart[slot]!;
  const n = specs.length;
  if (s0 === NONE_U32) throw new Error('physics.loadBody: segStart not set');
  if (s0 + n > world.seg.capacity) throw new Error('physics.loadBody: segment pool overflow');
  if (s0 + n > world.seg.highWater) world.seg.highWater = s0 + n;
  const wk = workFor(world);
  // mass rescaled to the ledger mass when the ecosystem has set one
  const props = specs.map(massProps);
  let mGeo = 0;
  for (const p of props) mGeo += p.m;
  const ledger = c.massKg[slot]!;
  const scale = ledger > 0 && mGeo > 0 ? ledger / mGeo : 1;
  const hasChild = new Uint8Array(n);
  for (let k = 1; k < n; k++) if (specs[k]!.parent >= 0) hasChild[specs[k]!.parent] = 1;
  const run = boundaryRuns(specs);
  for (let k = 0; k < n; k++) {
    const s = specs[k]!;
    const i = s0 + k;
    sg.owner[i] = slot;
    sg.parent[i] = s.parent;
    sg.kind[i] = s.kind;
    sg.organs[i] = s.organs;
    sg.len[i] = s.length; sg.radius[i] = s.radius; sg.span[i] = s.span;
    sg.mass[i] = props[k]!.m * scale;
    sg.inertia[i] = props[k]!.I * scale;
    sg.attachU[i] = s.attachU;
    sg.restAngle[i] = s.restAngle;
    sg.limitLo[i] = s.limitLo; sg.limitHi[i] = s.limitHi;
    wk.muscleFrac[i] = s.muscleFrac;
    wk.subtype[i] = subtypes ? subtypes[k]! : 0;
    wk.part[i] = partIdx ? partIdx[k]! : k;
    if (!keepPose || wk.restInit[i] === 0) { wk.restPrev[i] = s.restAngle; wk.restInit[i] = 1; }
    dragCoeffs(s.plate, s.length, s.radius, s.span, k === 0 || hasChild[k] === 0, sg.drag, i * 5, run[k]!);
    if (s.parent >= 0) {
      const p = specs[s.parent]!;
      const rMin = Math.min(p.radius, s.radius);
      const rJ = 0.5 * (p.radius + s.radius);
      const lJ = 0.5 * (p.length + s.length);
      const iBeam = PI * rMin * rMin * rMin * rMin / 4;
      const kp = s.youngsE * iBeam / lJ * (1 + 4 * s.armour);
      sg.compliance[i] = 1 / kp;
      sg.damping[i] = s.damping;
      const fMus = 0.5 * (s.muscleFrac + p.muscleFrac);
      const tMus = SIGMA_MUSCLE * fMus * PI * rJ * rJ * (0.5 * rJ);
      const tStr = SIGMA_STRUCT * (1 + 3 * s.armour) * PI * rMin * rMin * rMin / 4;
      sg.tauMax[i] = Math.min(tMus, tStr);
      sg.omegaMax[i] = OMEGA_MAX_15C;
    } else {
      sg.compliance[i] = 0; sg.damping[i] = 0; sg.tauMax[i] = 0; sg.omegaMax[i] = 0;
    }
  }
  if (keepPose) return;
  // initial pose: forward kinematics from the root at the creature pose
  const mir = c.mirror[slot]! < 0 ? -1 : 1;
  const ang = new Float64Array(n);
  ang[0] = Math.fround(wrapAngle(c.heading[slot]!));
  sg.posX[s0] = c.posX[slot]!; sg.posY[s0] = c.posY[slot]!;
  for (let k = 0; k < n; k++) {
    const i = s0 + k;
    const s = specs[k]!;
    if (k > 0) {
      const p = s.parent;
      const ip = s0 + p;
      const ap = ang[p]!;
      ang[k] = Math.fround(wrapAngle(ap + mir * s.restAngle));
      const ax = sg.posX[ip]! + cos(ap) * s.attachU * specs[p]!.length;
      const ay = sg.posY[ip]! + sin(ap) * s.attachU * specs[p]!.length;
      sg.posX[i] = ax + cos(ang[k]!) * 0.5 * s.length;
      sg.posY[i] = ay + sin(ang[k]!) * 0.5 * s.length;
    }
    sg.angle[i] = ang[k]!;
    sg.velX[i] = c.velX[slot]!; sg.velY[i] = c.velY[slot]!; sg.angVel[i] = 0;
    sg.cmd[i] = 0; sg.act[i] = 0; sg.cmd2[i] = 0; sg.work[i] = 0; sg.touch[i] = 0; sg.damage[i] = 0;
  }
}

export function loadBody(world: World, slot: number, ph: Phenotype): void {
  const specs = toSegmentSpecs(ph);
  world.cr.c.segCount[slot] = specs.length;
  world.cr.c.length[slot] = ph.lengthM;
  writeSegments(world, slot, specs, false, ph.subtype);
  initBladders(world, workFor(world), slot);
}

/**
 * Restage after growth: new geometry, mass and joints, same pose of the root, joint angles
 * kept (the rest angles move smoothly through the substep interpolation).
 */
export function restage(world: World, slot: number, ph: Phenotype): void {
  const c = world.cr.c;
  let specs = toSegmentSpecs(ph);
  let parts: number[] | null = null;
  let subtypes: ArrayLike<number> = ph.subtype;
  if (specs.length > c.segCount[slot]! && c.segCount[slot]! > 0) {
    // the creature lost parts (severing): keep only the parts its segments still are
    const wk = workFor(world);
    const s0 = c.segStart[slot]!;
    parts = [];
    for (let k = 0; k < c.segCount[slot]!; k++) parts.push(wk.part[s0 + k]!);
    const pruned = pruneSpecs(specs, parts);
    if (pruned) { specs = pruned; subtypes = parts.map((p) => ph.subtype[p]!); } else parts = null;
  }
  if (specs.length !== c.segCount[slot]) { loadBody(world, slot, ph); return; }
  c.length[slot] = parts ? specs.reduce((a, s) => a + s.length, 0) : ph.lengthM;
  writeSegments(world, slot, specs, true, subtypes, parts ?? undefined);
  // re-seat children on their parents with the new lengths, keeping world angles
  const sg = world.seg.c;
  const s0 = c.segStart[slot]!;
  for (let k = 1; k < specs.length; k++) {
    const i = s0 + k;
    const ip = s0 + specs[k]!.parent;
    const ap = sg.angle[ip]!;
    const ac = sg.angle[i]!;
    const ax = sg.posX[ip]! + cos(ap) * sg.attachU[i]! * sg.len[ip]!;
    const ay = sg.posY[ip]! + sin(ap) * sg.attachU[i]! * sg.len[ip]!;
    sg.posX[i] = ax + cos(ac) * 0.5 * sg.len[i]!;
    sg.posY[i] = ay + sin(ac) * 0.5 * sg.len[i]!;
  }
}

/**
 * The specs of the listed Phenotype parts only, parents re-indexed; null if the list is not a
 * parent-first subtree containing the root (then the body is reloaded whole).
 */
export function pruneSpecs(specs: readonly SegmentSpec[], parts: readonly number[]): SegmentSpec[] | null {
  const at = new Map<number, number>();
  const out: SegmentSpec[] = [];
  for (let k = 0; k < parts.length; k++) {
    const s = specs[parts[k]!];
    if (!s) return null;
    const p = s.parent < 0 ? -1 : at.get(s.parent);
    if (p === undefined || (k === 0) !== (p === -1)) return null;
    at.set(parts[k]!, k);
    out.push({ ...s, parent: p });
  }
  return out;
}
