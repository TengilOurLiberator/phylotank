/** The toy world behind the lab's engine interface. */
import type { EvoEngine, LabAudit, LabEvent, Observation } from '../engine.js';
import { decodeGene, GENES, NG } from './genome.js';
import { toyConfig, ToyWorld, TOY_PRESETS, type ToyConfig, type ToyParams } from './world.js';

export interface ToyEngineOptions extends Partial<Omit<ToyConfig, 'preset' | 'params'>> {
  preset?: string;
  params?: Partial<ToyParams>;
  /** Override preset fields (for example mTargetKg for the R2 sweep). */
  presetOverride?: Partial<ToyConfig['preset']>;
}

export class ToyEngine implements EvoEngine {
  readonly name = 'toy';
  readonly world: ToyWorld;
  readonly dtS: number;
  readonly agentCap: number;

  constructor(opts: ToyEngineOptions = {}) {
    const base = TOY_PRESETS[opts.preset ?? 'small'];
    if (!base) throw new Error(`unknown toy preset ${opts.preset}; known: ${Object.keys(TOY_PRESETS).join(', ')}`);
    const preset = { ...base, ...(opts.presetOverride ?? {}) };
    const { preset: _p, presetOverride: _o, ...rest } = opts;
    void _p; void _o;
    this.world = new ToyWorld(toyConfig({ ...rest, preset }));
    this.dtS = this.world.cfg.dtS;
    this.agentCap = this.world.cap;
  }

  step(n: number): void { for (let i = 0; i < n; i++) this.world.stepOnce(); }
  timeS(): number { return this.world.tS; }

  observe(): Observation {
    const w = this.world;
    const n = w.liveCount;
    const id = new Float64Array(n), species = new Uint32Array(n), lengthM = new Float32Array(n), massKg = new Float32Array(n);
    const speedMps = new Float32Array(n), ageS = new Float32Array(n), lifespanS = new Float32Array(n), tMatureS = new Float32Array(n);
    const role = new Uint8Array(n), sessile = new Uint8Array(n), generation = new Uint32Array(n);
    const workInJ = new Float32Array(n), workOutJ = new Float32Array(n), vMaxMps = new Float32Array(n);
    const traits: Record<string, Float32Array> = {};
    const traitBounds: Record<string, readonly [number, number]> = {};
    for (const g of GENES) { traits[g.name] = new Float32Array(n); traitBounds[g.name] = [g.lo, g.hi]; }
    const tArr = GENES.map((g) => traits[g.name]!);
    let k = 0;
    for (let s = 0; s < w.highWater; s++) {
      if (!w.alive[s]) continue;
      id[k] = w.id[s]!; species[k] = w.species[s]!; lengthM[k] = w.len[s]!; massKg[k] = w.massKg(s);
      speedMps[k] = w.realSpeed[s]!; ageS[k] = w.tS - w.birthT[s]!; lifespanS[k] = w.lifespan[s]!; tMatureS[k] = w.tMature[s]!;
      role[k] = w.role(s); sessile[k] = w.traitOf(s, 'sessile') > 0 ? 1 : 0; generation[k] = w.gen[s]!;
      workInJ[k] = w.workIn[s]!; workOutJ[k] = w.workOut[s]! + w.ke[s]!; vMaxMps[k] = w.traitOf(s, 'vMax');
      for (let i = 0; i < NG; i++) tArr[i]![k] = decodeGene(i, w.genes[s * NG + i]!);
      k++;
    }
    const f = w.fieldKg();
    let speciesG = 0;
    const cnt = new Map<number, number>();
    for (let s = 0; s < w.highWater; s++) if (w.alive[s]) cnt.set(w.speciesG[s]!, (cnt.get(w.speciesG[s]!) ?? 0) + 1);
    for (const v of cnt.values()) if (v >= 5) speciesG++;
    return {
      tS: w.tS, n, id, species, lengthM, massKg, speedMps, ageS, lifespanS, tMatureS, role, sessile, generation,
      workInJ, workOutJ, vMaxMps, traits, traitBounds, agents: w.liveCount, agentCap: w.cap,
      extra: {
        phytoKg: f.phyto, dissolvedKg: f.dissolved, detritusKg: f.detritus, carcassKg: f.carcass,
        speciesGenotype: speciesG, speciesEver: w.spRep.length,
      },
    };
  }

  drainEvents(): LabEvent[] {
    const e = this.world.events;
    this.world.events = [];
    return e;
  }

  audit(): LabAudit { return this.world.audit(); }

  describe(): Record<string, unknown> {
    const c = this.world.cfg;
    return {
      engine: 'toy', seed: c.seed, preset: c.preset, dtS: c.dtS, capTax: c.capTax, freeImmortality: c.freeImmortality,
      thrustBug: c.thrustBug, leakQPerStep: c.leakQPerStep, speciesTheta: c.speciesTheta, params: c.params,
      founders: c.founders.map((f) => ({ label: f.label, count: f.count })),
    };
  }
}
