/**
 * Pose (06 §6.1.5): forward kinematics over the parent-first node list, with the procedural
 * swim pose from the streamed stroke phase (L1 and L2) or the host's real joint angles
 * (NEAR_POSE, L0). Writes posed capsules relative to the creature centre, in metres.
 */
import { CAP, type Capsule, type RenderTemplate } from './template.js';

export interface PoseInput {
  lenM: number;
  heading: number;   // rad, world frame (x right, y down)
  phase: number;     // stroke phase, rad
  bend: number;      // -1..1, streamed body curvature
  /** Optional per-node joint angle offsets (NEAR_POSE), rad. */
  joints?: Float32Array | null;
}

export class PoseScratch {
  x = new Float64Array(64);
  y = new Float64Array(64);
  ang = new Float64Array(64);
  rs = new Float64Array(64);
  ensure(n: number): void {
    if (this.x.length >= n) return;
    this.x = new Float64Array(n); this.y = new Float64Array(n); this.ang = new Float64Array(n); this.rs = new Float64Array(n);
  }
}

/** Mirror factor so dorsal stays up when the creature faces left; smooth through vertical, which reads as a turn. */
export function mirrorFactor(heading: number, radial: boolean): number {
  if (radial) return 1;
  return Math.max(-1, Math.min(1, Math.cos(heading) * 3));
}

/** Pose all nodes into world-relative metres (relative to the creature centre). */
export function poseNodes(t: RenderTemplate, p: PoseInput, s: PoseScratch): void {
  const n = t.nodes.length;
  s.ensure(n);
  const { x, y, ang, rs } = s;
  for (let i = 0; i < n; i++) {
    const nd = t.nodes[i]!;
    let a = nd.angle + nd.amp * Math.sin(p.phase - nd.lag) + p.bend * nd.bendW * 0.12;
    if (p.joints && i < p.joints.length) a += p.joints[i]!;
    rs[i] = 1 + nd.pulse * Math.sin(p.phase);
    if (nd.parent < 0) { x[i] = 0; y[i] = 0; ang[i] = a; continue; }
    const q = nd.parent;
    ang[i] = ang[q]! + a;
    // jets: the bell contracts as it pulses, pulling the rim in
    const len = nd.len * (nd.pulse ? 1 - 0.5 * nd.pulse * Math.sin(p.phase) : 1);
    x[i] = x[q]! + len * Math.cos(ang[i]!);
    y[i] = y[q]! + len * Math.sin(ang[i]!);
  }
  const f = mirrorFactor(p.heading, t.radial);
  // facing left mirrors x as well, so the head leads: rotate by heading of a right-facing body
  const c = Math.cos(p.heading), sn = Math.sin(p.heading);
  const L = p.lenM;
  const cx = t.centre[0], cy = t.centre[1];
  for (let i = 0; i < n; i++) {
    const lx = x[i]! - cx, ly = (y[i]! - cy) * f;
    x[i] = (lx * c - ly * sn) * L;
    y[i] = (lx * sn + ly * c) * L;
  }
}

/** Floats per posed capsule in the capsule texture (2 RGBA texels). */
export const CAP_FLOATS = 8;
/** Capsules per row of the capsule texture (2048 texels wide). */
export const CAPS_PER_ROW = 1024;

/**
 * Append the posed capsules of `caps` to `out` at float offset `o`; returns the new offset.
 * Texel 0: ax ay bx by (m). Texel 1: ra, rb, s0 + 2 kind, s1 + 2 round(100 alpha).
 */
export function writeCapsules(caps: readonly Capsule[], t: RenderTemplate, s: PoseScratch, lenM: number, out: Float32Array, o: number): number {
  for (const c of caps) {
    const ra = c.ra * lenM * s.rs[c.a]!, rb = c.rb * lenM * s.rs[c.b]!;
    out[o] = s.x[c.a]!; out[o + 1] = s.y[c.a]!; out[o + 2] = s.x[c.b]!; out[o + 3] = s.y[c.b]!;
    out[o + 4] = ra; out[o + 5] = c.kind === CAP.EYE ? ra : rb;
    out[o + 6] = Math.min(1, Math.max(0, c.s0)) + 2 * c.kind;
    out[o + 7] = Math.min(1, Math.max(0, c.s1)) + 2 * Math.round(100 * Math.min(1, Math.max(0, c.alpha)));
    o += CAP_FLOATS;
  }
  void t;
  return o;
}

/** Local bounds (m) of a range of posed capsules, grown by `margin`. */
export function capsuleBounds(out: Float32Array, from: number, to: number, margin: number): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let o = from; o < to; o += CAP_FLOATS) {
    const r = Math.max(out[o + 4]!, out[o + 5]!);
    x0 = Math.min(x0, out[o]! - r, out[o + 2]! - r); x1 = Math.max(x1, out[o]! + r, out[o + 2]! + r);
    y0 = Math.min(y0, out[o + 1]! - r, out[o + 3]! - r); y1 = Math.max(y1, out[o + 1]! + r, out[o + 3]! + r);
  }
  return [x0 - margin, y0 - margin, x1 + margin, y1 + margin];
}
