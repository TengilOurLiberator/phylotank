/**
 * Energy budget readout and validation (07 §1.4, §1.5): an estimate from the grown body and the
 * traits, using the contract's equation shapes (Kleiber basal with Arrhenius temperature, repair
 * for lifespan, brain cost, Holling type II intake) with the CONTRACT 9 coefficients. Labelled an
 * estimate everywhere it is shown. Validation warns, never forbids: release stays enabled.
 */
import {
  B0_KLEIBER, J_MAX_BASAL, BRAIN_COST_NEURON_W, BRAIN_COST_SYNAPSE_W, BT, C_G, C_REP, DAY_S, E_A_EV, E_B, GENOME_FLAG_LEVIATHAN,
  K_BOLTZMANN_EV, KIND, KLEIBER_EXP, M_REF_1CM, MOUTH_SUBTYPE, T, T_REF_K, decodeQ, BRAIN_TRAITS, TRAITS,
  type Genome,
} from '../../core/index.js';
import type { GrownBody } from './body.js';

export const DENSITIES = { poor: 0.25, typical: 1, rich: 3 } as const;

export interface Budget {
  massKg: number;
  basalW: number; repairW: number; muscleW: number; brainW: number; organW: number; glowW: number; reproW: number;
  costW: number;
  income: { poor: number; typical: number; rich: number };
  assimilation: number; search: number;
  breakEven: number;          // relative food density where net = 0 (Infinity if never)
  starveS: number; matureS: number; breedEveryS: number; lifespanS: number; lifetimeOffspring: number;
  cruiseBLs: number;
}

const tr = (g: Genome, name: string) => decodeQ(g.traits[T[name]!]!, TRAITS[T[name]!]!);
const br = (g: Genome, name: string) => decodeQ(g.brainTraits[BT[name]!]!, BRAIN_TRAITS[BT[name]!]!);
function arrhenius(tempC: number): number { return Math.exp((E_A_EV / K_BOLTZMANN_EV) * (1 / T_REF_K - 1 / (tempC + 273.15))); }

/** What fraction of each food a mouth subtype can take (plant, meat, detritus). */
export const MOUTH_DIET: Record<number, [number, number, number]> = {
  [MOUTH_SUBTYPE.FILTER]: [1, 0.1, 0.6],
  [MOUTH_SUBTYPE.JAWS]: [0.2, 1, 0.3],
  [MOUTH_SUBTYPE.RASP]: [1, 0.2, 0.5],
  [MOUTH_SUBTYPE.PROBOSCIS]: [0, 1, 0],
  [MOUTH_SUBTYPE.SUCTION]: [0.3, 0.4, 1],
};

export function enzymes(g: Genome): [number, number, number] {
  const x1 = tr(g, 'DIET_PLANT'), x2 = tr(g, 'DIET_DETRITUS');
  return [x1 * (1 - x2), (1 - x1) * (1 - x2), x2];
}

export function basalW(massKg: number, g: Genome, tempC: number): number {
  return B0_KLEIBER * massKg ** KLEIBER_EXP * arrhenius(tempC) * (1 + 0.15 * tr(g, 'IMMUNE_INVEST')) * (1 + 0.04 * Math.max(0, tr(g, 'TEMP_TOLERANCE') - 3));
}

export function computeBudget(g: Genome, body: GrownBody, tempC = 14): Budget {
  const L = Math.max(1e-4, body.adultLengthM);
  const m = body.massKg > 0 ? body.massKg : 31 * L ** 3;
  const B = basalW(m, g, tempC);
  const repairW = C_REP * B * (tr(g, 'LIFESPAN_MULT') - 1);
  const parts = body.parts;
  let finArea = 0, muscle = 0, eyes = 0, chemo = 0, photo = 0, cilia = 0, segs = 0, glowSum = 0;
  const mouths: number[] = [];
  for (const p of parts) {
    const len = Math.hypot(p.x1 - p.x0, p.y1 - p.y0);
    if (p.kind === KIND.FIN || p.kind === KIND.LIMB) finArea += len * (p.r0 + p.r1);
    if (p.kind === KIND.SEGMENT) segs++;
    if (p.kind === KIND.EYE) eyes++;
    if (p.kind === KIND.CHEMO) chemo++;
    if (p.kind === KIND.CILIA) cilia++;
    if (p.kind === KIND.MOUTH) mouths.push(p.subtype);
    if (p.kind === KIND.PHOTOPHORE) photo++;
    glowSum += p.glow;
  }
  for (const mo of g.modules) muscle += (mo.muscleFraction / 255) * 0.8;
  const muscleFrac = Math.min(0.8, muscle / Math.max(1, g.modules.length));
  const activity = br(g, 'ACTIVITY');
  const thrust = (finArea / (L * L) + 0.3 * cilia) * (0.4 + muscleFrac);
  const cruiseBLs = Math.max(0.05, Math.min(6, 2.2 * Math.sqrt(thrust) * (0.5 + activity)));
  // muscle: active power proportional to muscle mass and duty (sigma * strain rate, simplified)
  const muscleW = 0.6 * B * (muscleFrac / 0.3) * (0.3 + activity) * (cruiseBLs / 1.5);
  const nNeu = br(g, 'HEAD_HIDDEN') + segs * br(g, 'HIDDEN_PER_SEGMENT') + 8 + 6 + 2 + parts.length;
  const brainW = BRAIN_COST_NEURON_W * nNeu + BRAIN_COST_SYNAPSE_W * nNeu * 8;
  const organW = B * (0.04 * eyes + 0.02 * chemo);
  const glowW = B * 0.12 * tr(g, 'GLOW_BASE') * (0.3 + br(g, 'LIGHT_SHOW')) * Math.min(3, 0.3 + glowSum / Math.max(1, parts.length) + photo * 0.2);
  // reproduction, amortised over the brood interval
  const bf = tr(g, 'BIRTH_FRACTION');
  const mo = m * bf ** 3;
  const clutch = Math.round(tr(g, 'CLUTCH_SIZE'));
  const matureS = (0.5 * DAY_S * (m / M_REF_1CM) ** 0.25) / tr(g, 'GROWTH_RATE');
  const breedEveryS = Math.max(60, tr(g, 'BROOD_INTERVAL') * matureS);
  const clutchJ = clutch * (mo * C_G + mo * 0.3 + 0.15 * mo + 1e-3 * M_REF_1CM) * E_B;
  const reproW = clutchJ / breedEveryS;
  const costW = B + repairW + muscleW + brainW + organW + glowW + reproW;
  // income: Holling type II with J_max = 8 B (CONTRACT 9.5), assimilation from enzymes and mouth
  const e = enzymes(g);
  let assim = 0;
  for (const st of mouths) {
    const d = MOUTH_DIET[st] ?? [0, 0, 0];
    assim = Math.max(assim, 0.8 * (e[0] * d[0] * 0.6 / 0.6 + e[1] * d[1] + e[2] * d[2] * 0.5) ** 1.3);
  }
  const search = (0.6 + 0.35 * Math.min(4, eyes) + 0.3 * Math.min(2, chemo)) * (0.4 + 0.25 * cruiseBLs) * (mouths.some((s) => s === MOUTH_SUBTYPE.FILTER) ? 1.2 : 1);
  const photoW = (g.modules.reduce((s, x) => s + x.photoFraction / 255, 0) / Math.max(1, g.modules.length)) * 3 * B;
  const intake = (rho: number) => J_MAX_BASAL * B * assim * (search * rho) / (1 + search * rho) + photoW;
  const income = { poor: intake(DENSITIES.poor), typical: intake(DENSITIES.typical), rich: intake(DENSITIES.rich) };
  const need = costW - photoW;
  const x = need / Math.max(1e-30, J_MAX_BASAL * B * assim);
  const breakEven = need <= 0 ? 0 : x >= 1 ? Infinity : x / (search * (1 - x));
  const starveS = (tr(g, 'FAT_CAPACITY') * m * E_B) / costW;
  const lifespanS = tr(g, 'LIFESPAN_MULT') * matureS;
  const net = income.typical - costW;
  const lifetimeOffspring = net > 0 ? clutch * Math.max(0, (lifespanS - matureS) / breedEveryS) * Math.min(1, net / costW + 0.4) : 0;
  return {
    massKg: m, basalW: B, repairW, muscleW, brainW, organW, glowW, reproW, costW, income, assimilation: assim, search,
    breakEven, starveS, matureS, breedEveryS, lifespanS, lifetimeOffspring, cruiseBLs,
  };
}

// ---------------- Validation ----------------
export type Severity = 'info' | 'warning' | 'inviable';
export interface Issue { id: string; severity: Severity; focus?: { trait?: string; kind?: number } }
export interface ReleasePlan { count: number; asLeviathan: boolean }
export interface WorldInfo { tempMinC: number; tempMaxC: number; lCeilingM: number }
export const DEFAULT_WORLD: WorldInfo = { tempMinC: 4, tempMaxC: 22, lCeilingM: 0.126 };

export function validate(g: Genome, body: GrownBody, b: Budget, plan: ReleasePlan = { count: 20, asLeviathan: false }, world: WorldInfo = DEFAULT_WORLD): Issue[] {
  const out: Issue[] = [];
  const kinds = new Set(body.parts.map((p) => p.kind));
  if (!kinds.has(KIND.MOUTH)) out.push({ id: 'V14', severity: 'inviable', focus: { kind: KIND.MOUTH } });
  else if (b.assimilation < 0.02) out.push({ id: 'V03', severity: 'inviable', focus: { trait: 'DIET_PLANT' } });
  if (b.income.rich < b.costW) out.push({ id: 'V01', severity: 'inviable' });
  else if (b.income.typical < b.costW) out.push({ id: 'V02', severity: 'warning' });
  const hasThrust = kinds.has(KIND.FIN) || kinds.has(KIND.LIMB) || kinds.has(KIND.CILIA) || kinds.has(KIND.JET) || body.parts.filter((p) => p.kind === KIND.SEGMENT).length > 2;
  const filter = body.parts.some((p) => p.kind === KIND.MOUTH && (p.subtype === MOUTH_SUBTYPE.FILTER || p.subtype === MOUTH_SUBTYPE.PROBOSCIS));
  if (!hasThrust && !filter) out.push({ id: 'V04', severity: 'warning', focus: { kind: KIND.FIN } });
  if (tr(g, 'SEX_PROB') > 0.95 && plan.count < 2) out.push({ id: 'V05', severity: 'inviable', focus: { trait: 'SEX_PROB' } });
  if (tr(g, 'REPRO_RESERVE') * tr(g, 'FAT_CAPACITY') < 0.3 * tr(g, 'BIRTH_FRACTION') ** 3 * Math.round(tr(g, 'CLUTCH_SIZE')) * 1.85)
    out.push({ id: 'V06', severity: 'inviable', focus: { trait: 'CLUTCH_SIZE' } });
  const senses = kinds.has(KIND.EYE) || kinds.has(KIND.CHEMO) || body.parts.some((p) => p.kind === KIND.SEGMENT);
  if (!senses) out.push({ id: 'V07', severity: 'warning' });
  const opt = tr(g, 'TEMP_OPTIMUM'), tol = tr(g, 'TEMP_TOLERANCE');
  if (opt + tol < world.tempMinC || opt - tol > world.tempMaxC) out.push({ id: 'V09', severity: 'inviable', focus: { trait: 'TEMP_OPTIMUM' } });
  if (10 ** tr(g, 'MU_LOG') > 0.05) out.push({ id: 'V11', severity: 'warning', focus: { trait: 'MU_LOG' } });
  if (tr(g, 'PULSE_FREQ') > 2 && tr(g, 'GLOW_BASE') > 0.2) out.push({ id: 'V12', severity: 'info', focus: { trait: 'PULSE_FREQ' } });
  const leviathan = plan.asLeviathan || (g.flags & GENOME_FLAG_LEVIATHAN) !== 0;
  if (!leviathan && tr(g, 'ADULT_LENGTH') > world.lCeilingM) out.push({ id: 'V13', severity: 'info', focus: { trait: 'ADULT_LENGTH' } });
  return out;
}
export const anyInviable = (issues: readonly Issue[]): boolean => issues.some((i) => i.severity === 'inviable');

/** Loci the trade-off chips consider (07 §1.4): the big levers of the budget. */
export const TRADEOFF_LOCI: readonly ['T' | 'B', string][] = [
  ['T', 'ADULT_LENGTH'], ['T', 'GROWTH_RATE'], ['T', 'LIFESPAN_MULT'], ['T', 'CLUTCH_SIZE'], ['T', 'FAT_CAPACITY'], ['T', 'IMMUNE_INVEST'],
  ['T', 'DIET_PLANT'], ['T', 'DIET_DETRITUS'], ['T', 'GLOW_BASE'], ['T', 'TEMP_TOLERANCE'], ['B', 'ACTIVITY'], ['B', 'HEAD_HIDDEN'], ['B', 'LIGHT_SHOW'],
];
export interface Tradeoff { table: 'T' | 'B'; name: string; dNetPct: number }
/**
 * Central finite differences of net energy at typical density for each locus, at +/-5% of its
 * range in x space; the three with the largest effect, as "+10%" chips.
 */
export function tradeoffs(g: Genome, grow: (g: Genome) => GrownBody, top = 3): Tradeoff[] {
  const net = (gg: Genome) => { const b = computeBudget(gg, grow(gg)); return b.income.typical - b.costW; };
  const base = net(g);
  const scale = Math.max(1e-30, Math.abs(computeBudget(g, grow(g)).costW));
  const out: Tradeoff[] = [];
  for (const [table, name] of TRADEOFF_LOCI) {
    const arr = table === 'T' ? 'traits' : 'brainTraits';
    const idx = (table === 'T' ? T : BT)[name]!;
    const q = g[arr][idx]!;
    const step = Math.round(0.05 * 65535);
    const at = (dq: number) => { const c = { ...g, [arr]: g[arr].slice() } as Genome; c[arr][idx] = Math.max(0, Math.min(65535, q + dq)); return net(c); };
    const d = (at(step) - at(-step)) / scale; // per 10% of range
    if (Number.isFinite(d)) out.push({ table, name, dNetPct: d * 100 });
  }
  void base;
  return out.sort((a, b) => Math.abs(b.dNetPct) - Math.abs(a.dNetPct)).slice(0, top);
}
