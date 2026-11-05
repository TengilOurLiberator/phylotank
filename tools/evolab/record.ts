/**
 * The recorder: turns engine observations and events into time series rows (one per sample),
 * per-species population rows, and per-size-class generation tracks.
 */
import type { EvoEngine, LabAudit, LabEvent, Observation } from './engine.js';
import { ROLE_NAMES } from './engine.js';
import { swimmerAudit } from './detectors.js';

export type Row = Record<string, number>;

/** Adult-length size classes for generations per hour (review R12). */
export const SIZE_CLASSES: readonly { name: string; maxM: number }[] = [
  { name: 'lt2mm', maxM: 0.002 }, { name: '2to5mm', maxM: 0.005 }, { name: '5to20mm', maxM: 0.02 },
  { name: '20to50mm', maxM: 0.05 }, { name: 'ge50mm', maxM: Infinity },
];

export interface SpeciesRow { tH: number; species: number; count: number; biomassKg: number; meanLengthMm: number }

function quantile(sorted: Float64Array | number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const i = Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1) + 0.5)));
  return sorted[i]!;
}
function sortedCopy(a: Float32Array): Float64Array {
  const c = Float64Array.from(a);
  c.sort();
  return c;
}

export class Recorder {
  readonly rows: Row[] = [];
  readonly speciesRows: SpeciesRow[] = [];
  /** Traits watched for exploits (review R10), with their bounds. */
  readonly traitNames: string[] = [];
  last: Observation | null = null;
  lastAudit: LabAudit | null = null;
  private pendingEvents: LabEvent[] = [];
  private lastT = 0;
  /** Seen species ids with at least 5 members, for speciation counting. */
  private readonly established = new Set<number>();

  constructor(readonly engine: EvoEngine) {}

  addEvents(ev: LabEvent[]): void { for (const e of ev) this.pendingEvents.push(e); }

  sample(): Row {
    const e = this.engine;
    this.addEvents(e.drainEvents());
    const o = e.observe();
    const a = e.audit();
    this.last = o;
    this.lastAudit = a;
    const r: Row = {};
    const tS = o.tS;
    r.tS = tS;
    r.tH = tS / 3600;
    r.pop = o.n;
    r.agents = o.agents;
    r.capFill = o.agentCap > 0 ? o.agents / o.agentCap : 0;
    let bio = 0;
    for (let i = 0; i < o.n; i++) bio += o.massKg[i]!;
    r.biomassKg = bio;
    // species
    const counts = new Map<number, { n: number; kg: number; len: number }>();
    for (let i = 0; i < o.n; i++) {
      const sp = o.species[i]!;
      let c = counts.get(sp);
      if (!c) { c = { n: 0, kg: 0, len: 0 }; counts.set(sp, c); }
      c.n++; c.kg += o.massKg[i]!; c.len += o.lengthM[i]!;
    }
    let S = 0, newSp = 0, H = 0, simpson = 0;
    const ids = [...counts.keys()].sort((x, y) => x - y);
    for (const sp of ids) {
      const c = counts.get(sp)!;
      if (c.n >= 5) {
        S++;
        if (!this.established.has(sp)) { this.established.add(sp); if (this.rows.length > 0) newSp++; }
      }
      const p = c.n / Math.max(1, o.n);
      if (p > 0) { H -= p * Math.log(p); simpson += p * p; }
      this.speciesRows.push({ tH: r.tH, species: sp, count: c.n, biomassKg: c.kg, meanLengthMm: (c.len / c.n) * 1000 });
    }
    r.species = S;
    r.speciesAny = counts.size;
    r.speciations = newSp;
    r.hill1 = Math.exp(H);
    r.hill2 = simpson > 0 ? 1 / simpson : 0;
    // swim speed (water frame) and potential speed
    const sp = sortedCopy(o.speedMps);
    let vs = 0, bl = 0, nMob = 0;
    for (let i = 0; i < o.n; i++) {
      if (o.sessile[i]) continue;
      vs += o.speedMps[i]!; bl += o.speedMps[i]! / Math.max(o.lengthM[i]!, 1e-9); nMob++;
    }
    r.speedMean = nMob ? vs / nMob : NaN;
    r.speedP90 = quantile(sp, 0.9);
    r.speedBlMean = nMob ? bl / nMob : NaN;
    if (o.vMaxMps) {
      let vm = 0, vmb = 0;
      for (let i = 0; i < o.n; i++) { vm += o.vMaxMps[i]!; vmb += o.vMaxMps[i]! / Math.max(o.lengthM[i]!, 1e-9); }
      r.vMaxMean = o.n ? vm / o.n : NaN;
      r.vMaxBlMean = o.n ? vmb / o.n : NaN;
      r.vMaxP90 = quantile(sortedCopy(o.vMaxMps), 0.9);
    }
    // size
    const len = sortedCopy(o.lengthM);
    let lsum = 0, mmax = 0;
    for (let i = 0; i < o.n; i++) { lsum += o.lengthM[i]!; if (o.massKg[i]! > mmax) mmax = o.massKg[i]!; }
    r.lengthMeanMm = o.n ? (lsum / o.n) * 1000 : NaN;
    r.lengthMedianMm = quantile(len, 0.5) * 1000;
    r.lengthMaxMm = o.n ? len[len.length - 1]! * 1000 : NaN;
    r.massMaxKg = mmax;
    // roles
    const roles = new Array<number>(ROLE_NAMES.length).fill(0);
    for (let i = 0; i < o.n; i++) roles[o.role[i]!]!++;
    ROLE_NAMES.forEach((nm, i) => { r[`role_${nm}`] = roles[i]!; });
    r.rolesOccupied = roles.slice(1).filter((c) => c >= 5).length;
    let sess = 0;
    for (let i = 0; i < o.n; i++) sess += o.sessile[i]!;
    r.sessileFrac = o.n ? sess / o.n : 0;
    // generations
    if (o.generation) {
      let g = 0, gmax = 0;
      for (let i = 0; i < o.n; i++) { g += o.generation[i]!; if (o.generation[i]! > gmax) gmax = o.generation[i]!; }
      r.genMean = o.n ? g / o.n : NaN;
      r.genMax = gmax;
      const adult = o.traits.length;
      for (const c of SIZE_CLASSES) { r[`gen_${c.name}`] = NaN; r[`n_${c.name}`] = 0; }
      const acc = SIZE_CLASSES.map(() => [0, 0]);
      for (let i = 0; i < o.n; i++) {
        const L = adult ? adult[i]! : o.lengthM[i]!;
        const k = SIZE_CLASSES.findIndex((c) => L < c.maxM);
        acc[k]![0]! += o.generation[i]!; acc[k]![1]!++;
      }
      SIZE_CLASSES.forEach((c, k) => {
        r[`n_${c.name}`] = acc[k]![1]!;
        r[`gen_${c.name}`] = acc[k]![1]! ? acc[k]![0]! / acc[k]![1]! : NaN;
      });
    }
    // traits (means)
    for (const [nm, arr] of Object.entries(o.traits)) {
      let m = 0;
      for (let i = 0; i < o.n; i++) m += arr[i]!;
      r[`trait_${nm}`] = o.n ? m / o.n : NaN;
    }
    // ages
    let maxAgeRel = 0;
    for (let i = 0; i < o.n; i++) if (o.lifespanS[i]! > 0) maxAgeRel = Math.max(maxAgeRel, o.ageS[i]! / o.lifespanS[i]!);
    r.maxAgeOverLifespan = maxAgeRel;
    const sw = swimmerAudit(o);
    r.swimFlagged = sw.flagged;
    r.swimWorstRatio = sw.worstRatio;
    // births and deaths since the last sample
    let births = 0, deaths = 0;
    const causes: Record<string, number> = {};
    for (const ev of this.pendingEvents) {
      if (ev.k === 'birth') births++;
      else { deaths++; const c = ev.cause ?? 'unknown'; causes[c] = (causes[c] ?? 0) + 1; }
    }
    this.pendingEvents = [];
    r.births = births;
    r.deaths = deaths;
    for (const c of ['starvation', 'predation', 'age', 'disease', 'parasite', 'disaster', 'hypoxia']) r[`deaths_${c}`] = causes[c] ?? 0;
    r.dtS = tS - this.lastT;
    this.lastT = tS;
    // ledger
    r.ledgerOk = a.ok ? 1 : 0;
    r.ledgerDiffQ = a.totalQ - a.expectedQ;
    r.energyResidual = a.energyResidual ?? NaN;
    for (const [k, v] of Object.entries(o.extra)) r[k] = v;
    this.rows.push(r);
    return r;
  }
}
