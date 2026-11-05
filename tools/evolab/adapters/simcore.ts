/**
 * Adapter: drive the real SimCore (src/sim) through the lab's engine interface. It uses only
 * contract surfaces: `sim.create/step`, `drainEvents`, `ecosystem.audit`, `ecosystem.flowAt`, and the
 * creature SoA columns of CONTRACT 5.1. It works today against the phase-0 skeleton (passive
 * motes) and picks up real creatures, births, deaths and the ledger as the modules land.
 *
 * What the SoA does not expose (genome traits beyond lifespan/maturity, generations, cumulative
 * muscle work) is reported as missing, and the detectors that need it say `available: false`.
 * Muscle work is integrated here from `powerW` (an upper bound on mechanical input, since powerW is
 * the metabolic demand), keyed by entity id.
 */
import {
  CF, DIET, DT, LIFE, PRESETS, type PresetName, type SimEvent, type World, type WorldConfig,
} from '../../../src/core/index.js';
import { ecosystem } from '../../../src/ecosystem/index.js';
import { drainEvents, sim } from '../../../src/sim/index.js';
import { ROLE_NAMES, type EvoEngine, type LabAudit, type LabEvent, type Observation } from '../engine.js';

export interface SimCoreEngineOptions {
  preset?: PresetName;
  seed?: number;
  /** Extra WorldConfig fields (agentCap, mTargetKg, skeletonMotes, ...). */
  config?: Partial<WorldConfig>;
}

const ROLE = Object.fromEntries(ROLE_NAMES.map((n, i) => [n, i])) as Record<(typeof ROLE_NAMES)[number], number>;

/** Role from the 7-lane diet EMA (04 §4.5 rules). */
export function roleFromDiet(diet: Float32Array, o: number): number {
  const phyto = diet[o + DIET.PHYTO]!, mat = diet[o + DIET.MAT]!, plant = diet[o + DIET.PLANT_CREATURE]!;
  const det = diet[o + DIET.DETRITUS]!, carc = diet[o + DIET.CARCASS]!, prey = diet[o + DIET.LIVE_PREY]!, host = diet[o + DIET.HOST]!;
  const tot = phyto + mat + plant + det + carc + prey + host;
  if (!(tot > 0)) return ROLE.none;
  if (host / tot > 0.5) return ROLE.parasite;
  if (prey / tot > 0.5) return ROLE.predator;
  if ((carc + det) / tot > 0.5) return ROLE.scavenger;
  if (phyto / tot > 0.6) return ROLE.filter;
  if ((mat + plant + phyto) / tot > 0.6) return ROLE.grazer;
  return ROLE.omnivore;
}

export class SimCoreEngine implements EvoEngine {
  readonly name = 'sim';
  readonly world: World;
  readonly dtS = DT;
  readonly agentCap: number;
  private readonly work = new Map<number, number>();
  private readonly flow = new Float64Array(2);
  private readonly cfg: WorldConfig;

  constructor(o: SimCoreEngineOptions = {}) {
    const seed = o.seed ?? 1;
    this.cfg = {
      preset: o.preset ?? 'small', seedLo: seed >>> 0, seedHi: Math.floor(seed / 4294967296) >>> 0, backend: 'cpu',
      ...(o.config ?? {}),
    };
    if (!PRESETS[this.cfg.preset]) throw new Error(`unknown preset ${this.cfg.preset}`);
    this.world = sim.create(this.cfg);
    this.agentCap = this.world.agentCap;
  }

  step(n: number): void {
    const w = this.world;
    const c = w.cr.c;
    for (let i = 0; i < n; i++) {
      sim.step(w);
      // integrate muscle work per entity (powerW is the active power this tick)
      for (let s = 0; s < w.cr.highWater; s++) {
        if (c.life[s] !== LIFE.ALIVE) continue;
        const p = c.powerW[s]!;
        if (p > 0) {
          const id = c.idLo[s]! + c.idHi[s]! * 4294967296;
          this.work.set(id, (this.work.get(id) ?? 0) + p * DT);
        }
      }
    }
  }

  timeS(): number { return this.world.g.tick * DT; }

  observe(): Observation {
    const w = this.world;
    const c = w.cr.c;
    let n = 0;
    for (let s = 0; s < w.cr.highWater; s++) if (c.life[s] === LIFE.ALIVE) n++;
    const id = new Float64Array(n), species = new Uint32Array(n), lengthM = new Float32Array(n), massKg = new Float32Array(n);
    const speedMps = new Float32Array(n), ageS = new Float32Array(n), lifespanS = new Float32Array(n), tMatureS = new Float32Array(n);
    const role = new Uint8Array(n), sessile = new Uint8Array(n);
    const workInJ = new Float32Array(n), workOutJ = new Float32Array(n);
    const adultLength = new Float32Array(n), lifespanMult = new Float32Array(n);
    let k = 0;
    const live = new Set<number>();
    for (let s = 0; s < w.cr.highWater; s++) {
      if (c.life[s] !== LIFE.ALIVE) continue;
      const eid = c.idLo[s]! + c.idHi[s]! * 4294967296;
      live.add(eid);
      id[k] = eid;
      species[k] = c.species[s]!;
      lengthM[k] = c.length[s]!;
      const m = c.massKg[s]!;
      massKg[k] = m;
      ecosystem.flowAt(w, c.posX[s]!, c.posY[s]!, this.flow);
      const vx = c.velX[s]! - this.flow[0]!, vy = c.velY[s]! - this.flow[1]!;
      const v = Math.sqrt(vx * vx + vy * vy);
      speedMps[k] = v;
      ageS[k] = (w.g.tick - c.birthTick[s]!) * DT;
      lifespanS[k] = c.lifespan[s]!;
      tMatureS[k] = c.tMature[s]!;
      lifespanMult[k] = c.tMature[s]! > 0 ? c.lifespan[s]! / c.tMature[s]! : NaN;
      role[k] = roleFromDiet(c.diet, s * 7);
      sessile[k] = (c.flags[s]! & CF.SESSILE_ATTACHED) !== 0 ? 1 : 0;
      workInJ[k] = this.work.get(eid) ?? 0;
      workOutJ[k] = m > 0 ? 0.5 * m * v * v : 0; // kinetic energy only; drag dissipation is not exposed
      adultLength[k] = c.adultLength[s]!;
      k++;
    }
    for (const key of [...this.work.keys()]) if (!live.has(key)) this.work.delete(key);
    const anyBodies = massKg.some((m) => m > 0);
    return {
      tS: this.timeS(), n, id, species, lengthM, massKg, speedMps, ageS, lifespanS, tMatureS, role, sessile,
      // without bodies (phase-0 motes) there is no muscle, so the swimmer audit is not meaningful
      ...(anyBodies ? { workInJ, workOutJ } : {}),
      traits: { length: adultLength, lifespanMult },
      traitBounds: { length: [0.0005, 1], lifespanMult: [1, 20] },
      agents: w.g.liveCount + w.g.eggCount + w.g.carcassCount,
      agentCap: w.agentCap,
      extra: { tick: w.g.tick, eggs: w.g.eggCount, carcasses: w.g.carcassCount },
    };
  }

  drainEvents(): LabEvent[] {
    const out: LabEvent[] = [];
    for (const e of drainEvents(this.world) as SimEvent[]) {
      if (e.k === 'birth') out.push({ k: 'birth', tS: e.t * DT, id: e.id, species: e.species, lengthM: e.size });
      else if (e.k === 'death') out.push({ k: 'death', tS: e.t * DT, id: e.id, species: e.species, lengthM: e.size, cause: e.cause });
    }
    return out;
  }

  audit(): LabAudit {
    const a = ecosystem.audit(this.world);
    return { ok: a.ok, totalQ: a.totalQ, expectedQ: a.expectedQ, pools: a.pools };
  }

  describe(): Record<string, unknown> {
    return { engine: 'sim', config: this.cfg, agentCap: this.agentCap };
  }
}
