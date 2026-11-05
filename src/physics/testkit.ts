/**
 * Hand-built bodies and worlds for physics tests and the spike benchmarks (genome.develop is
 * not available to physics tests yet). Not used by the sim path.
 */
import {
  allocWorld, KIND, LIFE, RngStreams, SEG_PER_AGENT, type EventSink, type Phenotype, type SimEvent, type StepContext,
  type World, type WorldConfig,
} from '../core/index.js';

export interface PartDef {
  parent: number;
  attachU: number;
  restAngle: number;
  length: number;
  radius: number;
  span?: number;
  kind?: number;
  organs?: number;
  muscleFrac?: number;
  lipidFrac?: number;
  armour?: number;
  youngsE?: number;
  damping?: number;
  limit?: number;
}

export function makePhenotype(parts: PartDef[]): Phenotype {
  const n = parts.length;
  const f32 = (): Float32Array => new Float32Array(n);
  const ph: Phenotype = {
    nParts: n, parent: new Int16Array(n), kind: new Uint8Array(n), subtype: new Uint8Array(n),
    moduleInnov: new Uint32Array(n), pathHash: new Uint32Array(n), dv: new Int8Array(n), organs: new Uint16Array(n),
    attachU: f32(), restAngle: f32(), limitLo: f32(), limitHi: f32(), length: f32(), radius: f32(), span: f32(),
    taper: f32(), muscleFrac: f32(), lipidFrac: f32(), armour: f32(), youngsE: f32(), damping: f32(),
    u: f32(), v: f32(), d: f32(), cpgPhase: f32(), cpgAmp: f32(), glow: f32(), hue: f32(), params: new Float32Array(n * 5),
    lengthM: 0, adultLengthM: 0, maturity: 1, massKg: 0, gutVolume: 0, gGut: 0,
    mouth: { filter: 0, scrape: 0, bite: 0, suction: 0, latch: 0, gape: 0, biteForce: 0, mesh: 0 },
    handlingSize: 0, buildCostKg: 0, organList: [],
  };
  let L = 0;
  parts.forEach((p, i) => {
    ph.parent[i] = p.parent; ph.attachU[i] = p.attachU; ph.restAngle[i] = p.restAngle;
    ph.length[i] = p.length; ph.radius[i] = p.radius; ph.span[i] = p.span ?? 2 * p.radius;
    ph.kind[i] = p.kind ?? KIND.SEGMENT; ph.organs[i] = p.organs ?? 0;
    ph.muscleFrac[i] = p.muscleFrac ?? 0.4; ph.lipidFrac[i] = p.lipidFrac ?? 0; ph.armour[i] = p.armour ?? 0;
    ph.youngsE[i] = p.youngsE ?? 3e5; ph.damping[i] = p.damping ?? 0.2;
    const lim = p.limit ?? 1.4;
    ph.limitLo[i] = p.restAngle - lim; ph.limitHi[i] = p.restAngle + lim;
    L += p.length;
  });
  ph.lengthM = L; ph.adultLengthM = L;
  return ph;
}

/**
 * A straight chain of `n` capsules pointing along the heading: the root is the head, every
 * later part hangs behind its parent (attached at the parent's base for the first child, then
 * at the parent's tip). `radius` may taper.
 */
export function chain(n: number, segLen: number, radius: (k: number) => number, extra: Partial<PartDef> = {}): PartDef[] {
  const out: PartDef[] = [];
  for (let k = 0; k < n; k++) {
    if (k === 0) out.push({ parent: -1, attachU: 0, restAngle: 0, length: segLen, radius: radius(0), ...extra });
    else out.push({ parent: k - 1, attachU: k === 1 ? -0.5 : 0.5, restAngle: k === 1 ? Math.PI : 0, length: segLen, radius: radius(k), ...extra });
  }
  return out;
}

const PI_F = 3.141592653589793;
/** Purcell's three-link swimmer: a central root with an arm at each end. */
export function purcell(l: number, r: number, a1: number, a2: number): PartDef[] {
  return [
    { parent: -1, attachU: 0, restAngle: 0, length: l, radius: r, limit: 3 },
    { parent: 0, attachU: 0.5, restAngle: a1, length: l, radius: r, limit: 3 },
    { parent: 0, attachU: -0.5, restAngle: PI_F + a2, length: l, radius: r, limit: 3 },
  ];
}

export interface TestWorld { world: World; ctx: StepContext; events: SimEvent[] }

export function makeWorld(over: Partial<WorldConfig> = {}): TestWorld {
  const world = allocWorld({ preset: 'small', seedLo: 1, seedHi: 2, backend: 'cpu', agentCap: 1024, ...over });
  const events: SimEvent[] = [];
  const sink: EventSink = { emit(ev) { events.push({ ...ev, t: world.g.tick, eid: 0, epoch: 0 } as SimEvent); } };
  const rng = new RngStreams(world.g.seedLo, world.g.seedHi);
  const ctx = { tick: 0, config: world.config, rng, events: sink } as StepContext;
  return { world, ctx, events };
}

/** Place a creature with a body; returns its slot. Segment ranges are slot * SEG_PER_AGENT. */
export function spawn(
  tw: TestWorld, load: (w: World, slot: number, ph: Phenotype) => void, ph: Phenotype,
  x: number, y: number, heading = 0, tempC = 15,
): number {
  const w = tw.world;
  const c = w.cr.c;
  const slot = w.cr.highWater++;
  c.life[slot] = LIFE.ALIVE;
  c.idLo[slot] = slot + 1;
  c.posX[slot] = x; c.posY[slot] = y; c.heading[slot] = heading; c.tempC[slot] = tempC;
  c.segStart[slot] = slot * SEG_PER_AGENT;
  if (ph.nParts > SEG_PER_AGENT && slot !== w.cr.highWater - 1) throw new Error('testkit: too many parts');
  load(w, slot, ph);
  return slot;
}

/** Advance the tick counter of a test context. */
export function nextTick(tw: TestWorld): void {
  tw.world.g.tick++;
  (tw.ctx as { tick: number }).tick = tw.world.g.tick;
}

/** Centre of mass of a creature. */
export function com(w: World, slot: number): [number, number] {
  const c = w.cr.c; const sg = w.seg.c;
  const s0 = c.segStart[slot]!;
  let m = 0; let x = 0; let y = 0;
  for (let k = 0; k < c.segCount[slot]!; k++) {
    const i = s0 + k;
    m += sg.mass[i]!; x += sg.mass[i]! * sg.posX[i]!; y += sg.mass[i]! * sg.posY[i]!;
  }
  return [x / m, y / m];
}

/** Kinetic energy (body mass only), optionally in the frame of the water velocity (ux, uy). */
export function kinetic(w: World, slot: number, ux = 0, uy = 0): number {
  const c = w.cr.c; const sg = w.seg.c;
  const s0 = c.segStart[slot]!;
  let E = 0;
  for (let k = 0; k < c.segCount[slot]!; k++) {
    const i = s0 + k;
    const vx = sg.velX[i]! - ux; const vy = sg.velY[i]! - uy;
    E += 0.5 * sg.mass[i]! * (vx * vx + vy * vy) + 0.5 * sg.inertia[i]! * sg.angVel[i]! * sg.angVel[i]!;
  }
  return E;
}

/** Kinetic energy including the added mass of the last substep (0.5 v^T M v + 0.5 I_eff w^2). */
export function kineticEff(w: World, slot: number, mm: Float64Array, ie: Float64Array): number {
  const c = w.cr.c; const sg = w.seg.c;
  const s0 = c.segStart[slot]!;
  let E = 0;
  for (let k = 0; k < c.segCount[slot]!; k++) {
    const i = s0 + k;
    const vx = sg.velX[i]!; const vy = sg.velY[i]!;
    E += 0.5 * (mm[i * 3]! * vx * vx + 2 * mm[i * 3 + 1]! * vx * vy + mm[i * 3 + 2]! * vy * vy) + 0.5 * ie[i]! * sg.angVel[i]! * sg.angVel[i]!;
  }
  return E;
}

/**
 * The 20 cm, 8-segment reference fish (tapered capsules). `depth` is the body depth (the
 * out-of-plane span) over the width: 1 is a round section (spike 1), 2 a laterally compressed
 * fish body as in most real swimmers (spike physics-2's B4 reference).
 */
export function fish(n = 8, len = 0.2, depth = 1): PartDef[] {
  const seg = len / n;
  // radius 6% of the body length at the head (12 mm for the 20 cm fish), tapering to 40%
  const parts = chain(n, seg, (k) => 0.06 * len * (1 - 0.6 * k / n), { muscleFrac: 0.5 });
  if (depth !== 1) for (const p of parts) p.span = depth * 2 * p.radius;
  return parts;
}

export function setCmds(w: World, slot: number, f: (k: number) => number): void {
  const c = w.cr.c; const sg = w.seg.c;
  const s0 = c.segStart[slot]!;
  for (let k = 1; k < c.segCount[slot]!; k++) sg.cmd[s0 + k] = f(k);
}

/** Total angular momentum about the centre of mass. */
export function angularMomentum(w: World, slot: number): number {
  const c = w.cr.c; const sg = w.seg.c; const s0 = c.segStart[slot]!;
  const [cx, cy] = com(w, slot);
  let Lz = 0;
  for (let k = 0; k < c.segCount[slot]!; k++) {
    const i = s0 + k;
    const rx = sg.posX[i]! - cx; const ry = sg.posY[i]! - cy;
    Lz += sg.mass[i]! * (rx * sg.velY[i]! - ry * sg.velX[i]!) + sg.inertia[i]! * sg.angVel[i]!;
  }
  return Lz;
}

/** Elastic energy stored in the passive bend springs. */
export function elastic(w: World, slot: number): number {
  const c = w.cr.c; const sg = w.seg.c; const s0 = c.segStart[slot]!;
  let E = 0;
  for (let k = 1; k < c.segCount[slot]!; k++) {
    const i = s0 + k; const p = s0 + sg.parent[i]!;
    let d = sg.angle[i]! - sg.angle[p]! - sg.restAngle[i]!;
    d = d - 2 * Math.PI * Math.floor((d + Math.PI) / (2 * Math.PI));
    if (sg.compliance[i]! > 0) E += 0.5 * d * d / sg.compliance[i]!;
  }
  return E;
}

/** Total mass of a creature's segments. */
export function bodyMass(w: World, slot: number): number {
  const c = w.cr.c; const s0 = c.segStart[slot]!;
  let m = 0;
  for (let k = 0; k < c.segCount[slot]!; k++) m += w.seg.c.mass[s0 + k]!;
  return m;
}
