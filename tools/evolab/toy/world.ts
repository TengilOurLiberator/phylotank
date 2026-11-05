/**
 * The 2D evolvability toy (review spike 3), self-contained: its own genome (genome.ts), body and
 * drag (body.ts), plankton, detritus and carcass fields, an exact integer mass ledger in the
 * contract's 1 ng quanta with the bridge rule for energy (CONTRACT 9.1, 9.2), Kleiber basal
 * metabolism, the repair cost and Gompertz ageing (9.4), Holling type II feeding with a pumping cost
 * (9.5), budding with the per-offspring overhead and the additive cap fee (9.6), predation, and a
 * phenotype species registry (review R14).
 *
 * It is a sim, so it follows the determinism rules: Philox draws keyed by (stream, step, entity id),
 * dmath transcendentals, ascending slot order, lowest-free slot allocation, births committed at the
 * end of the step in parent slot order.
 */
import {
  B0_KLEIBER, C_G, C_REP, E_B, FAT_CAPACITY_0, M_REF_1CM, OVERHEAD_ABS_KG, OVERHEAD_FRACTION, Q_MASS, RNG_STREAM,
  DAY_S,
} from '../../../src/core/constants.js';
import { atan2, cbrt, cos, exp, LN2, pow, sin, TAU } from '../../../src/core/dmath.js';
import { RngStreams } from '../../../src/core/rng.js';
import { Cursor } from './cursor.js';
import {
  basalW, bodyMass, dragForce, dragSecant, frontalArea, MUSCLE_EFF, musclePowerW, propulsiveEfficiency, shapeCd,
  steadySpeed, type BodyParams,
} from './body.js';
import { ALL_GENES, decodeGene, encodeGene, GI, mutate, NG, PHENO_GENES, rmsDistance } from './genome.js';

// ---------------------------------------------------------------- configuration
export interface ToyPreset {
  name: string;
  widthM: number;
  heightM: number;
  cellM: number;
  agentCap: number;
  /** World nutrient mass (kg). */
  mTargetKg: number;
  lCeilingM: number;
}

/** Toy presets. `small` keeps the contract Small preset's mass per area (100 kg / 576 m^2). */
export const TOY_PRESETS: Readonly<Record<string, ToyPreset>> = {
  tiny: { name: 'tiny', widthM: 2, heightM: 1.125, cellM: 0.125, agentCap: 512, mTargetKg: 100 / 576 * 2.25, lCeilingM: 0.05 },
  small: { name: 'small', widthM: 6, heightM: 3.375, cellM: 0.25, agentCap: 2048, mTargetKg: 100 / 576 * 20.25, lCeilingM: 0.126 },
  medium: { name: 'medium', widthM: 8, heightM: 4.5, cellM: 0.25, agentCap: 4096, mTargetKg: 100 / 576 * 36, lCeilingM: 0.126 },
};

/** Balancing parameters (04 §4.10 names where they exist). All are tunable. */
export interface ToyParams {
  muMaxPerDay: number;     // plankton max growth, per sim day
  kNkgPerM2: number;       // half-saturation of nutrient uptake
  mPPerDay: number;        // plankton linear mortality
  mP2: number;             // plankton quadratic mortality, per (kg/m^2) per day
  iK: number;              // light half-saturation (surface light = 1)
  kW: number;              // light extinction per metre
  rDPerDay: number;        // detritus remineralisation
  carcassHalfDays: number; // carcass leaching half-life
  diffusion: number;       // field diffusivity, m^2/s
  jetMps: number;          // peak speed of the horizontal jet
  aMaxPlant: number;       // assimilation maxima (02 §2.6.5)
  aMaxMeat: number;
  aMaxDet: number;
  theta: number;           // enzyme exponent (9.3)
  b0Mult: number;          // basal metabolism multiplier
  cRep: number;            // repair cost coefficient (9.4)
  kCap: number;            // cap fee coefficient (9.6)
  catchRate: number;       // predation attempts per second at contact
  jMaxBasal: number;       // Holling ceiling, multiples of basal power (CONTRACT 9.5: 8)
  handlingS: number;       // handling time after a kill: 1 s + handlingS x 10 x prey/predator mass
  perGeneP: number;        // probability a gene mutates per birth
  mutagen: number;
}

export const DEFAULT_TOY_PARAMS: ToyParams = {
  muMaxPerDay: 1.5, kNkgPerM2: 0.02, mPPerDay: 0.05, mP2: 0.5, iK: 0.3, kW: 0.2, rDPerDay: 0.15,
  carcassHalfDays: 1.5, diffusion: 5e-3, jetMps: 0.12, aMaxPlant: 0.45, aMaxMeat: 0.8, aMaxDet: 0.3, theta: 1.3,
  b0Mult: 1, cRep: C_REP, kCap: 1, catchRate: 1, handlingS: 30, jMaxBasal: 8, perGeneP: 0.25, mutagen: 1,
};

export interface Founder {
  /** Trait values (decoded units). */
  traits: Partial<Record<keyof typeof GI, number>>;
  count: number;
  label: string;
}

/** Crude, deliberately poor swimmers: small fins, blunt bodies, little muscle. */
export const DEFAULT_FOUNDERS: readonly Founder[] = [
  { label: 'mote grazer', count: 160, traits: { length: 0.002, aspect: 0.45, finArea: 0.08, muscle: 0.12, cruise: 0.15, sprint: 0.6, wFood: 1, wFlee: 0.5, wHunt: 0, wWander: 0.5, filter: 0.9, dietPlant: 0.95, dietDetritus: 0.02, senescence: 0.5, lifespanMult: 4, sessile: 0.2, clutch: 2, birthFraction: 0.3, mutRate: 0.05 } },
  { label: 'small grazer', count: 60, traits: { length: 0.01, aspect: 0.45, finArea: 0.1, muscle: 0.15, cruise: 0.15, sprint: 0.7, wFood: 1, wFlee: 0.8, wHunt: 0, wWander: 0.4, filter: 0.7, dietPlant: 0.95, dietDetritus: 0.02, senescence: 0.5, lifespanMult: 4, sessile: 0.2, clutch: 2, birthFraction: 0.25, mutRate: 0.05 } },
  { label: 'scavenger', count: 40, traits: { length: 0.005, aspect: 0.4, finArea: 0.08, muscle: 0.12, cruise: 0.15, sprint: 0.5, wFood: 1, wFlee: 0.6, wHunt: 0, wWander: 0.5, filter: 0.2, dietPlant: 0.2, dietDetritus: 0.8, senescence: 0.5, lifespanMult: 4, sessile: 0.2, clutch: 2, birthFraction: 0.25, mutRate: 0.05 } },
  { label: 'hunter', count: 16, traits: { length: 0.025, aspect: 0.4, finArea: 0.12, muscle: 0.2, cruise: 0.15, sprint: 0.8, wFood: 0.2, wFlee: 0.3, wHunt: 1.5, wWander: 0.4, filter: 0.1, dietPlant: 0.05, dietDetritus: 0.05, senescence: 0.5, lifespanMult: 4, sessile: 0.2, clutch: 2, birthFraction: 0.2, mutRate: 0.05 } },
];

export interface ToyConfig {
  seed: number;
  preset: ToyPreset;
  dtS: number;
  params: ToyParams;
  founders: readonly Founder[];
  /** 'additive' = CONTRACT 9.6; 'multiplicative' = the old 04 §4.7 rule (review R11). */
  capTax: 'additive' | 'multiplicative';
  /** Emulate the pre-contract design: SENESCENCE 0 is immortal and long life is free (review R10). */
  freeImmortality: boolean;
  /** Deliberate physics bug for the detector tests: fins give more than 100% propulsive efficiency. */
  thrustBug: number;
  /** Deliberate ledger bug for the detector tests: quanta created per step without a transfer. */
  leakQPerStep: number;
  /** Species threshold, RMS distance in normalised gene units. */
  speciesTheta: number;
  /** Steps between field updates. */
  fieldEvery: number;
}

export function toyConfig(over: Partial<Omit<ToyConfig, 'params'>> & { params?: Partial<ToyParams> } = {}): ToyConfig {
  const preset = over.preset ?? TOY_PRESETS.small!;
  return {
    seed: over.seed ?? 1,
    preset,
    dtS: over.dtS ?? 0.5,
    params: { ...DEFAULT_TOY_PARAMS, ...(over.params ?? {}) },
    founders: over.founders ?? DEFAULT_FOUNDERS,
    capTax: over.capTax ?? 'additive',
    freeImmortality: over.freeImmortality ?? false,
    thrustBug: over.thrustBug ?? 0,
    leakQPerStep: over.leakQPerStep ?? 0,
    speciesTheta: over.speciesTheta ?? 0.12,
    fieldEvery: over.fieldEvery ?? 4,
  };
}

// ---------------------------------------------------------------- constants and codes
export const ROLE = { NONE: 0, PRODUCER: 1, FILTER: 2, GRAZER: 3, PREDATOR: 4, SCAVENGER: 5, PARASITE: 6, OMNIVORE: 7 } as const;
export const ROLE_NAMES = ['none', 'producer', 'filter', 'grazer', 'predator', 'scavenger', 'parasite', 'omnivore'] as const;
export type DeathCause = 'starvation' | 'predation' | 'age';
export interface ToyEvent {
  k: 'birth' | 'death';
  tS: number;
  id: number;
  species: number;
  lengthM: number;
  generation: number;
  cause?: DeathCause;
}

/** Decoded trait lanes cached per slot at birth. */
const T = {
  aspect: 0, fin: 1, muscle: 2, cruise: 3, sprint: 4, wFood: 5, wFlee: 6, wHunt: 7, wWander: 8, filter: 9,
  ePlant: 10, eMeat: 11, eDet: 12, sen: 13, lifeMult: 14, sessile: 15, clutch: 16, birthFrac: 17, lAdult: 18,
  mAdult: 19, vMax: 20, aPlant: 21, aMeat: 22, aDet: 23,
} as const;
const NT = 24;
/** Carry lanes (CONTRACT 9.1). */
const CL = { burn: 0, inP: 1, inD: 2, inC: 3, growth: 4, absP: 5, absM: 6, absD: 7 } as const;
const NCL = 8;
const F_PHYTO = 0.6;
const F_DET = 0.3;
const DIET_TAU_S = DAY_S;

// ---------------------------------------------------------------- the world
export class ToyWorld {
  readonly cfg: ToyConfig;
  readonly cap: number;
  readonly W: number;
  readonly H: number;
  readonly nx: number;
  readonly ny: number;
  readonly cellArea: number;
  readonly rng: RngStreams;
  step = 0;
  tS = 0;
  nextId = 1;
  liveCount = 0;
  highWater = 0;
  // creature columns
  readonly alive: Uint8Array;
  readonly id: Float64Array;
  readonly species: Uint32Array;
  readonly speciesG: Uint32Array;
  readonly gen: Uint32Array;
  readonly genes: Float64Array;
  readonly tr: Float64Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly hx: Float64Array;
  readonly hy: Float64Array;
  readonly v: Float64Array;
  readonly len: Float64Array;
  readonly lenTissue: Float64Array;
  readonly qTissue: Float64Array;
  readonly qReserve: Float64Array;
  readonly qRepro: Float64Array;
  readonly qGut: Float64Array;
  readonly carry: Float64Array;
  readonly birthT: Float64Array;
  readonly ageEff: Float64Array;
  readonly tMature: Float64Array;
  readonly lifespan: Float64Array;
  readonly maxTissue: Float64Array;
  readonly workIn: Float64Array;
  readonly workOut: Float64Array;
  readonly ke: Float64Array;
  readonly diet: Float64Array;
  readonly reproWait: Float64Array;
  readonly realSpeed: Float64Array;
  readonly handling: Float64Array;
  // fields (quanta per cell)
  readonly qN: Float64Array;
  readonly qP: Float64Array;
  readonly qD: Float64Array;
  readonly qC: Float64Array;
  private readonly fcarry: Float64Array;
  private readonly lightRow: Float64Array;
  private readonly flowRow: Float64Array;
  // spatial hash
  private readonly head: Int32Array;
  private readonly next: Int32Array;
  // ledger
  readonly mTotalQ: number;
  energy0 = 0;
  energyIn = 0;
  heat = 0;
  // species registries: representative vectors (EMA of members), parent ids
  readonly spRep: number[][] = [];
  readonly spParent: number[] = [];
  readonly spBorn: number[] = [];
  readonly spgRep: number[][] = [];
  // events
  events: ToyEvent[] = [];
  private births: number[] = [];
  private readonly lengthGeneMax: number;
  private nAgentsAtStart = 0;
  private readonly cursor: Cursor;
  private readonly hazK: Float64Array;
  private readonly hazG: Float64Array;

  constructor(cfg: ToyConfig) {
    this.cfg = cfg;
    const p = cfg.preset;
    this.cap = p.agentCap;
    this.W = p.widthM;
    this.H = p.heightM;
    this.nx = Math.round(p.widthM / p.cellM);
    this.ny = Math.round(p.heightM / p.cellM);
    this.cellArea = p.cellM * p.cellM;
    this.rng = new RngStreams(cfg.seed >>> 0, Math.floor(cfg.seed / 4294967296) >>> 0);
    const n = this.cap;
    this.alive = new Uint8Array(n);
    this.id = new Float64Array(n);
    this.species = new Uint32Array(n);
    this.speciesG = new Uint32Array(n);
    this.gen = new Uint32Array(n);
    this.genes = new Float64Array(n * NG);
    this.tr = new Float64Array(n * NT);
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.hx = new Float64Array(n);
    this.hy = new Float64Array(n);
    this.v = new Float64Array(n);
    this.len = new Float64Array(n);
    this.lenTissue = new Float64Array(n);
    this.qTissue = new Float64Array(n);
    this.qReserve = new Float64Array(n);
    this.qRepro = new Float64Array(n);
    this.qGut = new Float64Array(n * 3);
    this.carry = new Float64Array(n * NCL);
    this.birthT = new Float64Array(n);
    this.ageEff = new Float64Array(n);
    this.tMature = new Float64Array(n);
    this.lifespan = new Float64Array(n);
    this.maxTissue = new Float64Array(n);
    this.workIn = new Float64Array(n);
    this.workOut = new Float64Array(n);
    this.ke = new Float64Array(n);
    this.diet = new Float64Array(n * 3);
    this.reproWait = new Float64Array(n);
    this.realSpeed = new Float64Array(n);
    this.handling = new Float64Array(n);
    const nc = this.nx * this.ny;
    this.qN = new Float64Array(nc);
    this.qP = new Float64Array(nc);
    this.qD = new Float64Array(nc);
    this.qC = new Float64Array(nc);
    this.fcarry = new Float64Array(nc * 4);
    this.lightRow = new Float64Array(this.ny);
    this.flowRow = new Float64Array(this.ny);
    this.head = new Int32Array(nc);
    this.next = new Int32Array(n);
    this.lengthGeneMax = encodeGene(GI.length, p.lCeilingM);
    this.cursor = new Cursor(this.rng.stream(RNG_STREAM.PHYSICS));
    this.hazK = new Float64Array(n);
    this.hazG = new Float64Array(n);
    for (let iy = 0; iy < this.ny; iy++) {
      const yc = (iy + 0.5) * p.cellM;
      const yj = this.H / 3;
      const s = 0.35;
      this.flowRow[iy] = 0.005 + cfg.params.jetMps * exp(-((yc - yj) / s) * ((yc - yj) / s));
    }
    this.mTotalQ = Math.round(p.mTargetKg / Q_MASS);
    this.init();
  }

  // -------------------------------------------------------------- initialisation
  private init(): void {
    const cfg = this.cfg;
    let used = 0;
    const d = this.rng.draw(RNG_STREAM.WORLDGEN, 0, 0);
    for (const f of cfg.founders) {
      const g = new Float64Array(NG).fill(0.5);
      for (const [k, v] of Object.entries(f.traits)) g[GI[k as keyof typeof GI]] = encodeGene(GI[k as keyof typeof GI], v!);
      // neutral markers start identical within a founder group
      if (g[GI.length]! > this.lengthGeneMax) g[GI.length] = this.lengthGeneMax;
      const sp = this.newSpecies(this.spRep, this.spParent, g, 0, 0xffffffff);
      const spg = this.newSpecies(this.spgRep, null, g, 0, 0);
      for (let i = 0; i < f.count; i++) {
        const s = this.alloc();
        if (s < 0) break;
        this.genes.set(g, s * NG);
        this.decodeTraits(s);
        const mA = this.tr[s * NT + T.mAdult]!;
        const m0 = mA * (0.3 + 0.7 * d.u01());
        const qT = Math.max(1, Math.floor(m0 / Q_MASS));
        const qR = Math.floor(qT * FAT_CAPACITY_0);
        this.qTissue[s] = qT;
        this.qReserve[s] = qR;
        used += qT + qR;
        this.species[s] = sp;
        this.speciesG[s] = spg;
        this.place(s, d.u01() * this.W, (0.05 + 0.6 * d.u01()) * this.H, d.u01() * TAU, 0);
        this.birthT[s] = -d.u01() * this.tMature[s]!;
        this.ageEff[s] = -this.birthT[s]!;
      }
    }
    if (used > this.mTotalQ * 0.5) throw new Error('founders exceed half the world mass');
    // fields: 25% phytoplankton in the lit upper third, 15% detritus, the rest dissolved
    const rest = this.mTotalQ - used;
    const nc = this.nx * this.ny;
    const upper = Math.max(1, Math.floor(this.ny / 3));
    const qPTot = Math.floor(rest * 0.25);
    const qDTot = Math.floor(rest * 0.15);
    let placed = 0;
    for (let iy = 0; iy < this.ny; iy++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const c = iy * this.nx + ix;
        const p = iy < upper ? Math.floor(qPTot / (upper * this.nx)) : 0;
        const dd = Math.floor(qDTot / nc);
        this.qP[c] = p;
        this.qD[c] = dd;
        placed += p + dd;
      }
    }
    const nEach = Math.floor((rest - placed) / nc);
    for (let c = 0; c < nc; c++) { this.qN[c] = nEach; placed += nEach; }
    this.qN[0]! += rest - placed;
    this.energy0 = this.energyStock();
  }

  private place(s: number, x: number, y: number, h: number, v: number): void {
    this.x[s] = x; this.y[s] = Math.min(this.H - 1e-6, Math.max(1e-6, y)); this.hx[s] = cos(h); this.hy[s] = sin(h); this.v[s] = v;
    this.updateLength(s);
    this.maxTissue[s] = this.qTissue[s]!;
  }

  private alloc(): number {
    let s = -1;
    for (let i = 0; i < this.highWater; i++) if (this.alive[i] === 0) { s = i; break; }
    if (s < 0) { if (this.highWater >= this.cap) return -1; s = this.highWater++; }
    this.alive[s] = 1;
    this.id[s] = this.nextId++;
    this.liveCount++;
    this.qTissue[s] = 0; this.qReserve[s] = 0; this.qRepro[s] = 0;
    this.qGut[s * 3] = 0; this.qGut[s * 3 + 1] = 0; this.qGut[s * 3 + 2] = 0;
    this.carry.fill(0, s * NCL, s * NCL + NCL);
    this.diet.fill(0, s * 3, s * 3 + 3);
    this.workIn[s] = 0; this.workOut[s] = 0; this.ke[s] = 0; this.reproWait[s] = 0; this.ageEff[s] = 0;
    this.gen[s] = 0; this.birthT[s] = this.tS; this.realSpeed[s] = 0; this.handling[s] = 0;
    return s;
  }

  private decodeTraits(s: number): void {
    const g = this.genes;
    const o = s * NG;
    const t = this.tr;
    const b = s * NT;
    const prm = this.cfg.params;
    t[b + T.aspect] = decodeGene(GI.aspect, g[o + GI.aspect]!);
    t[b + T.fin] = decodeGene(GI.finArea, g[o + GI.finArea]!);
    t[b + T.muscle] = decodeGene(GI.muscle, g[o + GI.muscle]!);
    t[b + T.cruise] = decodeGene(GI.cruise, g[o + GI.cruise]!);
    t[b + T.sprint] = decodeGene(GI.sprint, g[o + GI.sprint]!);
    t[b + T.wFood] = decodeGene(GI.wFood, g[o + GI.wFood]!);
    t[b + T.wFlee] = decodeGene(GI.wFlee, g[o + GI.wFlee]!);
    t[b + T.wHunt] = decodeGene(GI.wHunt, g[o + GI.wHunt]!);
    t[b + T.wWander] = decodeGene(GI.wWander, g[o + GI.wWander]!);
    t[b + T.filter] = decodeGene(GI.filter, g[o + GI.filter]!);
    const x1 = decodeGene(GI.dietPlant, g[o + GI.dietPlant]!);
    const x2 = decodeGene(GI.dietDetritus, g[o + GI.dietDetritus]!);
    const eP = x1 * (1 - x2);
    const eM = (1 - x1) * (1 - x2);
    const eD = x2;
    t[b + T.ePlant] = eP; t[b + T.eMeat] = eM; t[b + T.eDet] = eD;
    t[b + T.aPlant] = prm.aMaxPlant * (eP > 0 ? pow(eP, prm.theta) : 0);
    t[b + T.aMeat] = prm.aMaxMeat * (eM > 0 ? pow(eM, prm.theta) : 0);
    t[b + T.aDet] = prm.aMaxDet * (eD > 0 ? pow(eD, prm.theta) : 0);
    t[b + T.sen] = decodeGene(GI.senescence, g[o + GI.senescence]!);
    t[b + T.lifeMult] = decodeGene(GI.lifespanMult, g[o + GI.lifespanMult]!);
    t[b + T.sessile] = decodeGene(GI.sessile, g[o + GI.sessile]!) > 0.5 ? 1 : 0;
    t[b + T.clutch] = Math.max(1, Math.round(decodeGene(GI.clutch, g[o + GI.clutch]!)));
    t[b + T.birthFrac] = decodeGene(GI.birthFraction, g[o + GI.birthFraction]!);
    const lA = Math.min(decodeGene(GI.length, g[o + GI.length]!), this.cfg.preset.lCeilingM);
    t[b + T.lAdult] = lA;
    const body: BodyParams = { lengthM: lA, aspect: t[b + T.aspect]!, finArea: t[b + T.fin]!, muscle: t[b + T.muscle]! };
    const mA = bodyMass(body);
    t[b + T.mAdult] = mA;
    t[b + T.vMax] = t[b + T.sessile] ? 0 : steadySpeed(body, 1);
    // maturity reference clock: growth from birth mass to adult plus filling the first clutch, at a
    // net surplus of one basal power (dm/dt = B0 m^0.75 / (E_B C_G)); lifespan = LIFESPAN_MULT x that
    const k1 = (B0_KLEIBER * prm.b0Mult) / (E_B * C_G);
    const bf = t[b + T.birthFrac]!;
    const qA = Math.sqrt(Math.sqrt(mA));
    const growS = (4 * (qA - qA * Math.sqrt(Math.sqrt(bf)))) / k1;
    const clutchKg = t[b + T.clutch]! * bf * mA * (C_G + FAT_CAPACITY_0 + OVERHEAD_FRACTION);
    const tm = growS + clutchKg / (k1 * qA * qA * qA);
    this.tMature[s] = tm;
    this.lifespan[s] = t[b + T.lifeMult]! * tm;
    const G = 0.5 + 7.5 * t[b + T.sen]!;
    this.hazG[s] = G / this.lifespan[s]!;
    this.hazK[s] = (G / this.lifespan[s]!) / (exp(G) - 1) * (this.cfg.freeImmortality ? t[b + T.sen]! : 1);
  }

  private updateLength(s: number): void {
    const mA = this.tr[s * NT + T.mAdult]!;
    const f = Math.min(1, (this.qTissue[s]! * Q_MASS) / mA);
    this.len[s] = this.tr[s * NT + T.lAdult]! * cbrt(Math.max(f, 1e-6));
    this.lenTissue[s] = this.qTissue[s]!;
  }

  private newSpecies(reps: number[][], parents: number[] | null, g: Float64Array, off: number, parent: number): number {
    reps.push(Array.from(g.subarray(off, off + NG)));
    if (parents) { parents.push(parent); this.spBorn.push(this.tS); }
    return reps.length - 1;
  }

  // -------------------------------------------------------------- ledger helpers
  /** Book the energy side of a transfer of q quanta between classes (CONTRACT 9.2). */
  private book(q: number, fFrom: number, fTo: number): void {
    if (fFrom > fTo) this.heat += (fFrom - fTo) * q;
    else if (fTo > fFrom) this.energyIn += (fTo - fFrom) * q;
  }

  energyStock(): number {
    let e = 0;
    const nc = this.nx * this.ny;
    for (let c = 0; c < nc; c++) e += F_PHYTO * this.qP[c]! + F_DET * this.qD[c]! + this.qC[c]!;
    for (let s = 0; s < this.highWater; s++) {
      if (!this.alive[s]) continue;
      e += this.qTissue[s]! + this.qReserve[s]! + this.qRepro[s]! + F_PHYTO * this.qGut[s * 3]! + this.qGut[s * 3 + 1]! + F_DET * this.qGut[s * 3 + 2]!;
    }
    return e;
  }

  /** The exact mass audit (integer equality) plus the energy closure residual (relative). */
  audit(): { ok: boolean; totalQ: number; expectedQ: number; energyResidual: number; pools: Record<string, number> } {
    let n = 0, p = 0, d = 0, c = 0;
    const nc = this.nx * this.ny;
    for (let i = 0; i < nc; i++) { n += this.qN[i]!; p += this.qP[i]!; d += this.qD[i]!; c += this.qC[i]!; }
    let tis = 0, res = 0, rep = 0, gut = 0;
    for (let s = 0; s < this.highWater; s++) {
      if (!this.alive[s]) continue;
      tis += this.qTissue[s]!; res += this.qReserve[s]!; rep += this.qRepro[s]!;
      gut += this.qGut[s * 3]! + this.qGut[s * 3 + 1]! + this.qGut[s * 3 + 2]!;
    }
    const total = n + p + d + c + tis + res + rep + gut;
    const e = this.energyStock();
    const residual = (e - this.energy0 - (this.energyIn - this.heat)) / Math.max(1, this.energy0);
    return {
      ok: total === this.mTotalQ, totalQ: total, expectedQ: this.mTotalQ, energyResidual: residual,
      pools: { dissolved: n, phyto: p, detritus: d, carcass: c, tissue: tis, reserve: res, repro: rep, gut },
    };
  }

  // -------------------------------------------------------------- the step
  stepOnce(): void {
    const cfg = this.cfg;
    const prm = cfg.params;
    const dt = cfg.dtS;
    const nx = this.nx, ny = this.ny, cm = cfg.preset.cellM;
    const t = this.tr;
    // light by row (day-night)
    const day = 0.25 + 0.75 * Math.max(0, sin((TAU * this.tS) / DAY_S));
    for (let iy = 0; iy < ny; iy++) this.lightRow[iy] = day * exp(-prm.kW * (iy + 0.5) * cm);
    // spatial hash in ascending slot order (each cell list is in descending slot order; scans are exhaustive)
    this.head.fill(-1);
    for (let s = 0; s < this.highWater; s++) {
      if (!this.alive[s]) continue;
      const c = this.cellOf(s);
      this.next[s] = this.head[c]!;
      this.head[c] = s;
    }
    this.nAgentsAtStart = this.liveCount;
    const capFrac = this.nAgentsAtStart / this.cap;
    this.births.length = 0;
    const dietK = dt / DIET_TAU_S;
    const QE = Q_MASS * E_B;

    for (let s = 0; s < this.highWater; s++) {
      if (!this.alive[s]) continue;
      const b = s * NT;
      const sessile = t[b + T.sessile]! > 0;
      const L = this.len[s]!;
      const mKg = (this.qTissue[s]! + this.qReserve[s]! + this.qRepro[s]! + this.qGut[s * 3]! + this.qGut[s * 3 + 1]! + this.qGut[s * 3 + 2]!) * Q_MASS;
      const ix = this.ixOf(s), iy = this.iyOf(s);
      const c = iy * nx + ix;
      const d = this.cursor.reset(this.step, this.id[s]!);
      const B = basalW(mKg) * prm.b0Mult;
      const gutTot = this.qGut[s * 3]! + this.qGut[s * 3 + 1]! + this.qGut[s * 3 + 2]!;
      const gutCapQ = (0.15 * mKg) / Q_MASS;
      const gutRoom = Math.max(0, gutCapQ - gutTot);
      let effort = 0;
      let threat = -1;
      let prey = -1;
      // ---- senses and steering
      if (!sessile) {
        const ePl = t[b + T.ePlant]!, eMe = t[b + T.eMeat]!, eDe = t[b + T.eDet]!;
        const xl = iy * nx + (ix === 0 ? nx - 1 : ix - 1);
        const xr = iy * nx + (ix === nx - 1 ? 0 : ix + 1);
        const yu = (iy === 0 ? iy : iy - 1) * nx + ix;
        const yd = (iy === ny - 1 ? iy : iy + 1) * nx + ix;
        const qP = this.qP, qD = this.qD, qC = this.qC;
        const f0 = ePl * qP[c]! + eDe * qD[c]! + eMe * qC[c]! + 1;
        let gx = (ePl * (qP[xr]! - qP[xl]!) + eDe * (qD[xr]! - qD[xl]!) + eMe * (qC[xr]! - qC[xl]!)) / f0;
        let gy = (ePl * (qP[yd]! - qP[yu]!) + eDe * (qD[yd]! - qD[yu]!) + eMe * (qC[yd]! - qC[yu]!)) / f0;
        const gl = Math.sqrt(gx * gx + gy * gy);
        if (gl > 1) { gx /= gl; gy /= gl; }
        // neighbours
        const r = Math.min(cm, 8 * L + 0.02);
        const r2 = r * r;
        let bestT = r2, bestP = r2;
        if (this.handling[s]! > 0) this.handling[s]! -= dt;
        const canHunt = eMe > 0.25 && t[b + T.filter]! < 0.75 && this.handling[s]! <= 0 && gutTot < 0.5 * gutCapQ;
        for (let oy = -1; oy <= 1; oy++) {
          const jy = iy + oy;
          if (jy < 0 || jy >= ny) continue;
          for (let ox = -1; ox <= 1; ox++) {
            let jx = ix + ox;
            if (jx < 0) jx += nx; else if (jx >= nx) jx -= nx;
            for (let o = this.head[jy * nx + jx]!; o >= 0; o = this.next[o]!) {
              if (o === s || !this.alive[o]) continue;
              let dx = this.x[o]! - this.x[s]!;
              if (dx > this.W / 2) dx -= this.W; else if (dx < -this.W / 2) dx += this.W;
              const dy = this.y[o]! - this.y[s]!;
              const dd = dx * dx + dy * dy;
              const Lo = this.len[o]!;
              const ob = o * NT;
              if (dd < bestT && L <= 0.6 * Lo && t[ob + T.eMeat]! > 0.25 && t[ob + T.filter]! < 0.75) { bestT = dd; threat = o; }
              if (canHunt && dd < bestP && Lo <= 0.6 * L && (dd < bestP || (dd === bestP && o < prey))) { bestP = dd; prey = o; }
            }
          }
        }
        let dx = t[b + T.wFood]! * gx;
        let dy = t[b + T.wFood]! * gy;
        if (threat >= 0) {
          let tx = this.x[threat]! - this.x[s]!;
          if (tx > this.W / 2) tx -= this.W; else if (tx < -this.W / 2) tx += this.W;
          const ty = this.y[threat]! - this.y[s]!;
          const tl = Math.sqrt(tx * tx + ty * ty) + 1e-12;
          dx -= (t[b + T.wFlee]! * tx) / tl;
          dy -= (t[b + T.wFlee]! * ty) / tl;
        }
        if (prey >= 0) {
          let px = this.x[prey]! - this.x[s]!;
          if (px > this.W / 2) px -= this.W; else if (px < -this.W / 2) px += this.W;
          const py = this.y[prey]! - this.y[s]!;
          const pl = Math.sqrt(px * px + py * py) + 1e-12;
          dx += (t[b + T.wHunt]! * px) / pl;
          dy += (t[b + T.wHunt]! * py) / pl;
        }
        const ww = t[b + T.wWander]!;
        const hx = this.hx[s]!, hy = this.hy[s]!;
        dx += ww * (2 * d.u01() - 1) + 0.5 * hx;
        dy += ww * (2 * d.u01() - 1) + 0.5 * hy;
        // turn towards (dx, dy) by at most 3 rad/s: rotate the heading vector by a small angle
        const turn = atan2(hx * dy - hy * dx, hx * dx + hy * dy);
        const maxTurn = 3 * dt;
        const a = Math.max(-maxTurn, Math.min(maxTurn, turn));
        const a2 = a * a;
        const ca = 1 - a2 / 2 + (a2 * a2) / 24;
        const sa = a * (1 - a2 / 6 + (a2 * a2) / 120);
        let nhx = hx * ca - hy * sa;
        let nhy = hx * sa + hy * ca;
        const hl = Math.sqrt(nhx * nhx + nhy * nhy);
        nhx /= hl; nhy /= hl;
        this.hx[s] = nhx; this.hy[s] = nhy;
        const urgent = (threat >= 0 && t[b + T.wFlee]! > 0) || (prey >= 0 && t[b + T.wHunt]! > 0);
        effort = urgent ? Math.max(t[b + T.sprint]!, t[b + T.cruise]!) : t[b + T.cruise]!;
        if (this.qReserve[s]! <= 0) effort *= 0.3;
      }
      // ---- swimming (semi-implicit, provably dissipative: see body.ts)
      const body: BodyParams = { lengthM: L, aspect: t[b + T.aspect]!, finArea: t[b + T.fin]!, muscle: t[b + T.muscle]! };
      const area = frontalArea(body);
      const cs = shapeCd(body.aspect);
      let pMech = 0;
      if (!sessile) {
        pMech = musclePowerW(body, mKg) * effort;
        const v0 = this.v[s]!;
        let eta = propulsiveEfficiency(body, v0);
        if (cfg.thrustBug > 0) eta *= 1 + cfg.thrustBug * 8 * body.finArea * body.finArea * body.finArea * body.finArea;
        // power-limited thrust evaluated at the new speed: (M/dt)(v1 - v0) = eta P / v1 - c v1, so the
        // thrust work per step is exactly eta P dt and the step can never inject energy
        const M = mKg * 1.2;
        const cd = dragSecant(body, v0, area, cs);
        const a = M / dt + cd;
        const bq = (M / dt) * v0;
        const v1 = (bq + Math.sqrt(bq * bq + 4 * a * eta * pMech)) / (2 * a);
        this.v[s] = v1;
        this.workIn[s]! += pMech * dt;
        this.workOut[s]! += cd * v1 * v1 * dt;
        this.ke[s] = 0.5 * M * v1 * v1;
        const flow = this.flowRow[iy]!;
        let nxp = this.x[s]! + (this.hx[s]! * v1 + flow) * dt;
        let nyp = this.y[s]! + this.hy[s]! * v1 * dt;
        if (nxp < 0) nxp += this.W; else if (nxp >= this.W) nxp -= this.W;
        if (nyp < 0) { nyp = -nyp; this.hy[s] = -this.hy[s]!; }
        if (nyp >= this.H) { nyp = 2 * this.H - nyp - 1e-9; this.hy[s] = -this.hy[s]!; }
        this.x[s] = nxp; this.y[s] = nyp;
        this.realSpeed[s] = v1;
      }
      // ---- feeding: Holling type II (CONTRACT 9.5) into the gut lanes
      const w = body.aspect * L;
      const flowHere = this.flowRow[iy]!;
      const vRel = (sessile ? flowHere : this.v[s]!) + 0.2 * L;
      const sweep = w * vRel; // m^2 per s
      const filt = t[b + T.filter]!;
      const ePl = t[b + T.ePlant]!, eMe = t[b + T.eMeat]!, eDe = t[b + T.eDet]!;
      const jP = filt * sweep * (this.qP[c]! * Q_MASS / this.cellArea) * (ePl + 0.1);
      const jD = (1 - filt) * sweep * (this.qD[c]! * Q_MASS / this.cellArea) * (eDe + 0.1);
      const jC = (1 - filt) * sweep * (this.qC[c]! * Q_MASS / this.cellArea) * (eMe + 0.1);
      const jRaw = jP + jD + jC;
      if (jRaw > 0 && gutRoom > 0) {
        const fBar = (jP * F_PHYTO + jD * F_DET + jC) / jRaw;
        const jMax = (prm.jMaxBasal * B) / (fBar * E_B);
        const j = jRaw / (1 + jRaw / jMax);
        const scale = Math.min(1, (gutRoom * Q_MASS) / (j * dt));
        const k = (j * dt * scale) / jRaw / Q_MASS;
        const cb = s * NCL;
        const qp = this.quant(jP * k, cb + CL.inP, this.qP[c]!);
        const qd = this.quant(jD * k, cb + CL.inD, this.qD[c]!);
        const qc = this.quant(jC * k, cb + CL.inC, this.qC[c]!);
        this.qP[c]! -= qp; this.qGut[s * 3]! += qp;
        this.qD[c]! -= qd; this.qGut[s * 3 + 2]! += qd;
        this.qC[c]! -= qc; this.qGut[s * 3 + 1]! += qc;
        const dg = s * 3;
        this.diet[dg]! += (qp - this.diet[dg]!) * dietK;
        this.diet[dg + 2]! += (qd + qc - this.diet[dg + 2]!) * dietK;
      } else {
        this.diet[s * 3]! -= this.diet[s * 3]! * dietK;
        this.diet[s * 3 + 2]! -= this.diet[s * 3 + 2]! * dietK;
      }
      // ---- predation
      let preyQ = 0;
      if (prey >= 0 && this.alive[prey] && gutRoom > 0) {
        let px = this.x[prey]! - this.x[s]!;
        if (px > this.W / 2) px -= this.W; else if (px < -this.W / 2) px += this.W;
        const py = this.y[prey]! - this.y[s]!;
        const reach = 0.75 * L + 0.5 * this.len[prey]!;
        if (px * px + py * py <= reach * reach) {
          const vp = t[b + T.vMax]! * t[b + T.sprint]!;
          const vq = t[prey * NT + T.vMax]! * t[prey * NT + T.sprint]!;
          const adv = Math.max(0, Math.min(1, 0.2 + 0.8 * (vp - vq) / (vp + vq + 1e-12)));
          const pc = Math.min(0.9, prm.catchRate * dt * (1 - filt) * eMe * adv);
          if (d.u01() < pc) {
            const mq = this.massKg(prey);
            preyQ = this.kill(prey, 'predation', s, gutRoom);
            this.handling[s] = 1 + (prm.handlingS * 10 * mq) / mKg;
          }
        }
      }
      this.diet[s * 3 + 1]! += (preyQ - this.diet[s * 3 + 1]!) * dietK;
      // ---- absorption (CONTRACT 9.2)
      // gut throughput scales with metabolism: a full gut empties in 50 m / B seconds
      const tauGut = (50 * mKg) / B;
      const absF = Math.min(1, dt / tauGut);
      let gain = 0;
      gain += this.absorb(s, 0, F_PHYTO, t[b + T.aPlant]!, absF, c, CL.absP);
      gain += this.absorb(s, 1, 1, t[b + T.aMeat]!, absF, c, CL.absM);
      gain += this.absorb(s, 2, F_DET, t[b + T.aDet]!, absF, c, CL.absD);
      // ---- burning: basal, repair, muscle, pumping, holdfast; SDA 10% of reserve gain
      const starving = this.qReserve[s]! <= 0;
      const repairW = cfg.freeImmortality || starving ? 0 : prm.cRep * B * (t[b + T.lifeMult]! - 1);
      const pumpW = 0.25 * B * filt; // 0.5 B filter mouthOpen, mouth open half the time
      const holdW = sessile ? (0.5 * dragForce(body, flowHere, area, cs) * flowHere) / MUSCLE_EFF : 0;
      const burnW = B + repairW + pMech / MUSCLE_EFF + pumpW + holdW;
      const demand = this.quantFree(burnW * dt / QE + 0.1 * gain, s * NCL + CL.burn);
      if (this.qReserve[s]! >= demand) {
        this.qReserve[s]! -= demand; this.qN[c]! += demand; this.book(demand, 1, 0);
      } else {
        const r0 = this.qReserve[s]!;
        this.qReserve[s] = 0; this.qN[c]! += r0; this.book(r0, 1, 0);
        const need = Math.min(this.qTissue[s]!, Math.ceil((demand - r0) / 0.8));
        this.qTissue[s]! -= need; this.qN[c]! += need; this.book(need, 1, 0);
      }
      if (this.qTissue[s]! < 0.5 * this.maxTissue[s]! || this.qTissue[s]! <= 0) { this.kill(s, 'starvation', -1, 0); continue; }
      // ---- growth and reproductive allocation
      const qT = this.qTissue[s]!;
      const target = FAT_CAPACITY_0 * qT;
      const mAq = t[b + T.mAdult]! / Q_MASS;
      if (this.qReserve[s]! > target) {
        const surplus = this.qReserve[s]! - target;
        const rate = (3 * B) / (E_B * C_G) / Q_MASS * dt;
        if (qT < 0.97 * mAq) {
          const dm = this.quantFree(Math.min(surplus / C_G, rate, mAq - qT), s * NCL + CL.growth);
          const heat = Math.floor(0.4 * dm);
          if (dm + heat <= this.qReserve[s]!) {
            this.qReserve[s]! -= dm + heat; this.qTissue[s]! += dm; this.qN[c]! += heat; this.book(heat, 1, 0);
            if (this.qTissue[s]! > this.maxTissue[s]!) this.maxTissue[s] = this.qTissue[s]!;
            if (this.qTissue[s]! > this.lenTissue[s]! * 1.02) this.updateLength(s);
          }
        } else {
          const dm = Math.floor(Math.min(surplus, rate * C_G));
          this.qReserve[s]! -= dm; this.qRepro[s]! += dm;
        }
      }
      // ---- ageing (Gompertz, CONTRACT 9.4)
      this.ageEff[s]! += starving ? 3 * dt : dt;
      // evaluated on field steps with the accumulated interval (deterministic, cheaper)
      if (this.step % cfg.fieldEvery === 0) {
        const h = this.hazK[s]! * exp(this.hazG[s]! * this.ageEff[s]!);
        const hd = h * dt * cfg.fieldEvery;
        if (h > 0 && d.u01() < 1 - exp(-hd)) { this.kill(s, 'age', -1, 0); continue; }
      }
      // ---- reproduction request (CONTRACT 9.6)
      if (this.qRepro[s]! > 0) {
        this.reproWait[s]! += dt;
        const n = t[b + T.clutch]!;
        const cost = this.offspringCostQ(s, capFrac);
        const k = Math.floor(this.qRepro[s]! / cost);
        if (k >= 1 && (k >= n || this.reproWait[s]! > this.tMature[s]!)) this.births.push(s, Math.min(k, n));
      }
    }
    // ---- commit births in parent slot order
    for (let i = 0; i < this.births.length; i += 2) this.bud(this.births[i]!, this.births[i + 1]!, capFrac);
    // ---- deliberate leak (detector tests only)
    if (cfg.leakQPerStep > 0) for (let s = 0; s < this.highWater; s++) if (this.alive[s]) { this.qReserve[s]! += cfg.leakQPerStep; break; }
    // ---- fields
    if (this.step % cfg.fieldEvery === 0) this.stepFields(dt * cfg.fieldEvery);
    this.step++;
    this.tS = this.step * dt;
  }

  /** Real amount to integer quanta with a carry, capped by what the source holds. */
  private quant(a: number, lane: number, avail: number): number {
    const v = a + this.carry[lane]!;
    let q = Math.floor(v);
    this.carry[lane] = v - q;
    if (q > avail) { q = avail; this.carry[lane] = 0; }
    return q < 0 ? 0 : q;
  }
  private quantFree(a: number, lane: number): number {
    const v = a + this.carry[lane]!;
    const q = Math.floor(v);
    this.carry[lane] = v - q;
    return q < 0 ? 0 : q;
  }

  private absorb(s: number, lane: number, f: number, a: number, absF: number, c: number, cl: number): number {
    const g = this.qGut[s * 3 + lane]!;
    if (g <= 0) return 0;
    const F = Math.min(g, this.quantFree(g * absF, s * NCL + cl));
    if (F <= 0) return 0;
    const toRes = Math.floor(f * a * F);
    const toN = Math.floor((1 - f) * a * F);
    const toD = F - toRes - toN;
    this.qGut[s * 3 + lane]! -= F;
    this.qReserve[s]! += toRes; this.book(toRes, f, 1);
    this.qN[c]! += toN; this.book(toN, f, 0);
    this.qD[c]! += toD; this.book(toD, f, F_DET);
    return toRes;
  }

  private offspringCostQ(s: number, capFrac: number): number {
    const t = this.tr;
    const b = s * NT;
    const mo = t[b + T.birthFrac]! * t[b + T.mAdult]!;
    const base = mo * C_G + mo * FAT_CAPACITY_0 + OVERHEAD_FRACTION * mo + OVERHEAD_ABS_KG;
    let kg: number;
    if (this.cfg.capTax === 'additive') {
      const sc = Math.max(0, Math.min(1, (capFrac - 0.5) / 0.5));
      kg = base + this.cfg.params.kCap * M_REF_1CM * sc * sc;
    } else {
      const r = capFrac * capFrac; const r4 = r * r;
      kg = base * (1 + 2 * r4 * r4);
    }
    return Math.ceil(kg / Q_MASS);
  }

  private bud(p: number, n: number, capFrac: number): void {
    const t = this.tr;
    const pb = p * NT;
    const c = this.cellOf(p);
    const moQ = Math.max(1, Math.floor((t[pb + T.birthFrac]! * t[pb + T.mAdult]!) / Q_MASS));
    const costQ = this.offspringCostQ(p, capFrac);
    for (let i = 0; i < n; i++) {
      if (this.liveCount >= this.cap || this.qRepro[p]! < costQ) return; // deferred, never dropped
      const s = this.alloc();
      if (s < 0) return;
      const id = this.id[s]!;
      const dm = this.rng.draw(RNG_STREAM.MUTATION, this.step, id);
      mutate(this.genes, p * NG, this.genes, s * NG, dm, {
        perGeneP: this.cfg.params.perGeneP, lengthGeneMax: this.lengthGeneMax, mutagen: this.cfg.params.mutagen,
      });
      this.decodeTraits(s);
      const resQ = Math.floor(moQ * FAT_CAPACITY_0);
      const heatQ = costQ - moQ - resQ;
      this.qRepro[p]! -= costQ;
      this.qTissue[s] = moQ;
      this.qReserve[s] = resQ;
      this.qN[c]! += heatQ; this.book(heatQ, 1, 0);
      this.gen[s] = this.gen[p]! + 1;
      const db = this.rng.draw(RNG_STREAM.BIRTH, this.step, id);
      const a = db.u01() * TAU;
      const off = this.len[p]!;
      let nx = this.x[p]! + off * cos(a);
      if (nx < 0) nx += this.W; else if (nx >= this.W) nx -= this.W;
      this.place(s, nx, this.y[p]! + off * sin(a), db.u01() * TAU, 0);
      this.assignSpecies(p, s);
      this.events.push({ k: 'birth', tS: this.tS, id, species: this.species[s]!, lengthM: this.len[s]!, generation: this.gen[s]! });
    }
    this.reproWait[p] = 0;
  }

  private assignSpecies(p: number, s: number): void {
    const theta = this.cfg.speciesTheta;
    const reg = (reps: number[][], parents: number[] | null, sp: number, idx: readonly number[]): number => {
      const rep = reps[sp]!;
      let sum = 0;
      for (const i of idx) { const dd = this.genes[s * NG + i]! - rep[i]!; sum += dd * dd; }
      if (Math.sqrt(sum / idx.length) > theta) {
        return this.newSpecies(reps, parents, this.genes, s * NG, sp);
      }
      for (let i = 0; i < NG; i++) rep[i]! += (this.genes[s * NG + i]! - rep[i]!) * 0.02;
      return sp;
    };
    this.species[s] = reg(this.spRep, this.spParent, this.species[p]!, PHENO_GENES);
    this.speciesG[s] = reg(this.spgRep, null, this.speciesG[p]!, ALL_GENES);
  }

  /** Kill a creature; predation moves up to `room` quanta of its body into the killer's meat gut. */
  private kill(s: number, cause: DeathCause, killer: number, room: number): number {
    const c = this.cellOf(s);
    let body = this.qTissue[s]! + this.qReserve[s]! + this.qRepro[s]! + this.qGut[s * 3 + 1]!;
    let eaten = 0;
    if (killer >= 0) {
      eaten = Math.min(body, Math.floor(room));
      this.qGut[killer * 3 + 1]! += eaten;
      body -= eaten;
    }
    this.qC[c]! += body;
    const other = this.qGut[s * 3]! + this.qGut[s * 3 + 2]!;
    this.book(this.qGut[s * 3]!, F_PHYTO, F_DET);
    this.qD[c]! += other;
    this.qTissue[s] = 0; this.qReserve[s] = 0; this.qRepro[s] = 0;
    this.qGut[s * 3] = 0; this.qGut[s * 3 + 1] = 0; this.qGut[s * 3 + 2] = 0;
    this.alive[s] = 0;
    this.liveCount--;
    this.events.push({ k: 'death', tS: this.tS, id: this.id[s]!, species: this.species[s]!, lengthM: this.len[s]!, generation: this.gen[s]!, cause });
    return eaten;
  }

  private stepFields(dtF: number): void {
    const prm = this.cfg.params;
    const nx = this.nx, ny = this.ny;
    const perDay = dtF / DAY_S;
    const kN = prm.kNkgPerM2 * this.cellArea / Q_MASS;
    const seedP = 1e-6 / Q_MASS * this.cellArea;
    const mP2 = prm.mP2 * Q_MASS / this.cellArea;
    const fc = this.fcarry;
    const leak = (LN2 / prm.carcassHalfDays) * perDay;
    for (let iy = 0; iy < ny; iy++) {
      const I = this.lightRow[iy]!;
      const lim = I / (I + prm.iK);
      for (let ix = 0; ix < nx; ix++) {
        const c = iy * nx + ix;
        const N = this.qN[c]!, P = this.qP[c]!;
        // photosynthesis N -> P (the only energy input)
        let v = prm.muMaxPerDay * perDay * lim * (N / (N + kN)) * (P + seedP) + fc[c * 4]!;
        let q = Math.floor(v); fc[c * 4] = v - q;
        if (q > N) { q = N; fc[c * 4] = 0; }
        this.qN[c] = N - q; this.qP[c] = P + q; this.book(q, 0, F_PHYTO);
        // mortality P -> D
        const P1 = this.qP[c]!;
        v = (prm.mPPerDay * perDay + mP2 * P1 * perDay) * P1 + fc[c * 4 + 1]!;
        q = Math.floor(v); fc[c * 4 + 1] = v - q;
        if (q > P1) { q = P1; fc[c * 4 + 1] = 0; }
        this.qP[c] = P1 - q; this.qD[c]! += q; this.book(q, F_PHYTO, F_DET);
        // remineralisation D -> N
        const D = this.qD[c]!;
        v = prm.rDPerDay * perDay * D + fc[c * 4 + 2]!;
        q = Math.floor(v); fc[c * 4 + 2] = v - q;
        if (q > D) { q = D; fc[c * 4 + 2] = 0; }
        this.qD[c] = D - q; this.qN[c]! += q; this.book(q, F_DET, 0);
        // carcass leaching C -> D
        const C = this.qC[c]!;
        v = leak * C + fc[c * 4 + 3]!;
        q = Math.floor(v); fc[c * 4 + 3] = v - q;
        if (q > C) { q = C; fc[c * 4 + 3] = 0; }
        this.qC[c] = C - q; this.qD[c]! += q; this.book(q, 1, F_DET);
      }
    }
    // conservative integer diffusion of N, P, D (half-step exchanges with right and lower neighbours)
    const k = Math.min(0.2, (prm.diffusion * dtF) / (this.cfg.preset.cellM * this.cfg.preset.cellM));
    for (const f of [this.qN, this.qP, this.qD]) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const c = iy * nx + ix;
          const r = iy * nx + (ix === nx - 1 ? 0 : ix + 1);
          let q = Math.trunc(k * (f[c]! - f[r]!));
          f[c]! -= q; f[r]! += q;
          if (iy < ny - 1) {
            const dn = c + nx;
            q = Math.trunc(k * (f[c]! - f[dn]!));
            f[c]! -= q; f[dn]! += q;
          }
        }
      }
    }
  }

  private ixOf(s: number): number { return Math.min(this.nx - 1, Math.max(0, Math.floor(this.x[s]! / this.cfg.preset.cellM))); }
  private iyOf(s: number): number { return Math.min(this.ny - 1, Math.max(0, Math.floor(this.y[s]! / this.cfg.preset.cellM))); }
  private cellOf(s: number): number { return this.iyOf(s) * this.nx + this.ixOf(s); }

  // -------------------------------------------------------------- read-out helpers
  traitOf(s: number, lane: keyof typeof T): number { return this.tr[s * NT + T[lane]]!; }
  massKg(s: number): number {
    return (this.qTissue[s]! + this.qReserve[s]! + this.qRepro[s]! + this.qGut[s * 3]! + this.qGut[s * 3 + 1]! + this.qGut[s * 3 + 2]!) * Q_MASS;
  }
  role(s: number): number {
    const a = this.diet[s * 3]!, p = this.diet[s * 3 + 1]!, sc = this.diet[s * 3 + 2]!;
    const tot = a + p + sc;
    if (tot <= 0) return ROLE.NONE;
    if (a / tot > 0.6) return this.tr[s * NT + T.filter]! >= 0.5 ? ROLE.FILTER : ROLE.GRAZER;
    if (p / tot > 0.5) return ROLE.PREDATOR;
    if (sc / tot > 0.5) return ROLE.SCAVENGER;
    return ROLE.OMNIVORE;
  }
  fieldKg(): { dissolved: number; phyto: number; detritus: number; carcass: number } {
    let n = 0, p = 0, d = 0, c = 0;
    for (let i = 0; i < this.qN.length; i++) { n += this.qN[i]!; p += this.qP[i]!; d += this.qD[i]!; c += this.qC[i]!; }
    return { dissolved: n * Q_MASS, phyto: p * Q_MASS, detritus: d * Q_MASS, carcass: c * Q_MASS };
  }
}
