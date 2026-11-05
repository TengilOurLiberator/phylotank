/**
 * Phenotype fixtures for brain tests and the spike harness. Until `genome.develop` lands these
 * stand in for grown bodies (a local adapter, PHASE1 brief). They follow CONTRACT 7.1 shapes.
 */
import {
  KIND, LIFE, ORGAN, RngStreams, allocWorld, hash32, type OrganSpec, type Phenotype, type StepContext, type World,
} from '../core/index.js';

export interface PartDesc {
  kind: number; subtype?: number; parent: number; moduleInnov: number; pathHash: number;
  u: number; v?: number; d?: number; dv?: number; organs?: number; muscleFrac?: number;
  cpgPhase?: number; cpgAmp?: number; limitLo?: number; limitHi?: number; params?: number[]; length?: number;
}

export function makePhenotype(parts: PartDesc[], organList: OrganSpec[] = [], lengthM = 0.05): Phenotype {
  const n = parts.length;
  const f32 = (fn: (p: PartDesc) => number): Float32Array => Float32Array.from(parts.map(fn));
  const params = new Float32Array(n * 5);
  parts.forEach((p, i) => (p.params ?? []).forEach((v, j) => { params[i * 5 + j] = v; }));
  return {
    nParts: n,
    parent: Int16Array.from(parts.map((p) => p.parent)),
    kind: Uint8Array.from(parts.map((p) => p.kind)),
    subtype: Uint8Array.from(parts.map((p) => p.subtype ?? 0)),
    moduleInnov: Uint32Array.from(parts.map((p) => p.moduleInnov)),
    pathHash: Uint32Array.from(parts.map((p) => p.pathHash)),
    dv: Int8Array.from(parts.map((p) => p.dv ?? 0)),
    organs: Uint16Array.from(parts.map((p) => p.organs ?? 0)),
    attachU: f32(() => 0.5), restAngle: f32(() => 0),
    limitLo: f32((p) => p.limitLo ?? (p.parent >= 0 ? -0.8 : 0)), limitHi: f32((p) => p.limitHi ?? (p.parent >= 0 ? 0.8 : 0)),
    length: f32((p) => p.length ?? lengthM / n), radius: f32(() => lengthM / 20), span: f32(() => lengthM / 10),
    taper: f32(() => 1),
    muscleFrac: f32((p) => p.muscleFrac ?? (p.kind === KIND.SEGMENT && p.parent >= 0 ? 0.4 : 0)),
    lipidFrac: f32(() => 0), armour: f32(() => 0), youngsE: f32(() => 3e5), damping: f32(() => 0.15),
    u: f32((p) => p.u), v: f32((p) => p.v ?? 0), d: f32((p) => p.d ?? 0),
    cpgPhase: f32((p) => p.cpgPhase ?? 0), cpgAmp: f32((p) => p.cpgAmp ?? 0), glow: f32(() => 0.3), hue: f32(() => 0.5),
    params,
    lengthM, adultLengthM: lengthM, maturity: 1, massKg: 31 * lengthM * lengthM * lengthM * 0.1,
    gutVolume: 1e-7, gGut: 0.5,
    mouth: { filter: 0, scrape: 0, bite: 1, suction: 0, latch: 0, gape: 0.5, biteForce: 1, mesh: 0 },
    handlingSize: lengthM / 10, buildCostKg: 0, organList,
  };
}

export interface FishOptions {
  /** Trunk segments behind the head (module innov 2, one module repeated). */
  segments: number;
  /** Trunk indices (0-based) carrying a paired fin (module innov 3). */
  fins?: number[];
  /** Phase step of the innate travelling wave per trunk segment, rad. */
  phaseStep?: number;
  cpgAmp?: number;
  eye?: boolean;
  /** Chemo channel mask of the head nose (0 = no nose). */
  chemoMask?: number;
  mouth?: boolean;
  lateral?: boolean;
  touch?: boolean;
  photophore?: boolean;
  lengthM?: number;
  /** Extra copies of trunk segment k (forced duplication); default none. */
  duplicateTrunk?: number;
  /** Extra copy of the fin on trunk k (forced duplication). */
  duplicateFinOn?: number;
}

export const FISH_INNOV = { HEAD: 1, TRUNK: 2, FIN: 3, NOSE: 4, MOUTH: 5, EYE: 6, PHOTO: 7 } as const;

/**
 * A fish-like body: head, a repeated trunk module with an innate travelling wave, paired fins,
 * and absorbed organs on the head (nose, eye). Body coordinates are renormalised to the actual
 * number of parts, so a duplication shifts every part's u as `develop` would.
 */
export function fishBody(o: FishOptions): Phenotype {
  const nTrunk = o.segments + (o.duplicateTrunk !== undefined ? 1 : 0);
  const step = o.phaseStep ?? 0.9;
  const amp = o.cpgAmp ?? 0.8;
  const parts: PartDesc[] = [];
  const headOrgans = (o.lateral ?? true ? ORGAN.LATERAL_LINE : 0) | (o.touch ?? true ? ORGAN.TOUCH : 0) | ORGAN.HEAD
    | ((o.chemoMask ?? 1) ? ORGAN.CHEMO : 0) | (o.eye ? ORGAN.EYE : 0) | (o.photophore ? ORGAN.PHOTOPHORE : 0);
  parts.push({ kind: KIND.SEGMENT, subtype: 1, parent: -1, moduleInnov: FISH_INNOV.HEAD, pathHash: hash32(1, 0, 0), u: 0.05, organs: headOrgans });
  const trunkIdx: number[] = [];
  for (let t = 0; t < nTrunk; t++) {
    // the duplicated copy sits right after the original and continues the wave
    const parent = t === 0 ? 0 : trunkIdx[t - 1]!;
    trunkIdx.push(parts.length);
    parts.push({
      kind: KIND.SEGMENT, parent, moduleInnov: FISH_INNOV.TRUNK, pathHash: hash32(FISH_INNOV.TRUNK, t + 1, 0),
      u: (t + 1.5) / (nTrunk + 1), organs: ORGAN.LATERAL_LINE | ORGAN.TOUCH, cpgPhase: t * step, cpgAmp: amp,
    });
  }
  const finsOn = [...(o.fins ?? [])];
  if (o.duplicateFinOn !== undefined) finsOn.push(o.duplicateFinOn);
  let finCopy = 0;
  for (const tk of finsOn) {
    const t = Math.min(tk, nTrunk - 1);
    const host = trunkIdx[t]!;
    parts.push({
      kind: KIND.FIN, parent: host, moduleInnov: FISH_INNOV.FIN, pathHash: hash32(FISH_INNOV.FIN, t + 1, finCopy++),
      u: parts[host]!.u, v: -0.6, d: 0.5, dv: 0, organs: ORGAN.PAIRED, cpgPhase: t * step + 0.5 * Math.PI, cpgAmp: amp,
    });
  }
  if (o.mouth ?? true) parts.push({ kind: KIND.MOUTH, subtype: 1, parent: 0, moduleInnov: FISH_INNOV.MOUTH, pathHash: hash32(5, 0, 0), u: 0, organs: ORGAN.MOUTH, muscleFrac: 0 });
  // keep BFS order (parents first): sort by depth then insertion
  const organList: OrganSpec[] = [];
  if (o.chemoMask ?? 1) organList.push({ kind: 'chemo', part: 0, u: 0.02, v: 0, d: 0, params: [0.1, o.chemoMask ?? 1, 0, 0, 0] });
  if (o.eye) organList.push({ kind: 'eye', part: 0, u: 0.03, v: 0.3, d: 0, params: [0.01, 160, 6, 0b00111111, 0.5] });
  return makePhenotype(parts, organList, o.lengthM ?? 0.05);
}


export function testWorld(agentCap = 64, seedLo = 1, seedHi = 2): World {
  return allocWorld({ preset: 'small', seedLo, seedHi, backend: 'cpu', agentCap });
}
export function testCtx(world: World, tick: number): StepContext {
  return { tick, config: world.config, rng: rngFor(world), events: { emit() {} } };
}
const rngs = new WeakMap<World, RngStreams>();
function rngFor(world: World): RngStreams {
  let r = rngs.get(world);
  if (!r) { r = new RngStreams(world.g.seedLo, world.g.seedHi); rngs.set(world, r); }
  return r;
}

/** Make slot a live creature with this body laid out along +x (what sim + physics would do). */
export function spawnForTest(world: World, slot: number, ph: Phenotype, x = 10, y = 5, entityId = slot + 1): void {
  const c = world.cr.c;
  c.life[slot] = LIFE.ALIVE;
  c.idLo[slot] = entityId >>> 0;
  c.idHi[slot] = 0;
  c.posX[slot] = x; c.posY[slot] = y;
  c.length[slot] = ph.lengthM; c.adultLength[slot] = ph.adultLengthM; c.maturity[slot] = 1;
  c.massKg[slot] = ph.massKg; c.health[slot] = 1; c.lifespan[slot] = 1e5; c.tempC[slot] = 14;
  c.segStart[slot] = slot * 12; c.segCount[slot] = Math.min(12, ph.nParts);
  for (let p = 0; p < Math.min(12, ph.nParts); p++) {
    const sg = slot * 12 + p;
    world.seg.c.owner[sg] = slot;
    world.seg.c.parent[sg] = ph.parent[p]!;
    world.seg.c.posX[sg] = x - ph.u[p]! * ph.lengthM;
    world.seg.c.posY[sg] = y;
    world.seg.c.radius[sg] = ph.radius[p]!;
    world.seg.c.limitLo[sg] = ph.limitLo[p]!;
    world.seg.c.limitHi[sg] = ph.limitHi[p]!;
  }
  if (slot >= world.cr.highWater) world.cr.highWater = slot + 1;
  if (slot * 12 + 12 > world.seg.highWater) world.seg.highWater = slot * 12 + 12;
  // open water: positive distance to rock everywhere
  if (world.fields.sdf[0] === 0) world.fields.sdf.fill(10);
}
