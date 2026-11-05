/**
 * Interest metrics (04 §4.9): diversity (richness, Hill numbers by abundance and biomass,
 * evenness), trophic structure (biomass by TL bin, maximum TL, roles), speciation and
 * extinction rates from the species presence history, the size spectrum, disease prevalence,
 * the immigrant-descended biomass fraction (review §4) and the budget. Statistics only: never
 * read by the sim.
 */
import { DAY_S, DIET, DT, exp, LIFE, log, Q_MASS, type World } from '../core/index.js';
import { ER, ER_LANES, type EcoState } from './state.js';

function sq(x: number): number { return x * x; }

export const ROLES = ['producer', 'filter', 'grazer', 'predator', 'scavenger', 'parasite', 'omnivore'] as const;
export type Role = (typeof ROLES)[number];

/** Hill numbers of order 0, 1, 2 and Pielou evenness for a list of abundances (Hill 1973, Jost 2006). */
export function hill(values: readonly number[]): { d0: number; d1: number; d2: number; evenness: number; shannon: number } {
  const pos = values.filter((v) => v > 0);
  const tot = pos.reduce((a, b) => a + b, 0);
  if (pos.length === 0 || tot <= 0) return { d0: 0, d1: 0, d2: 0, evenness: 0, shannon: 0 };
  let H = 0, simp = 0;
  for (const v of pos) { const p = v / tot; H -= p * log(p); simp += p * p; }
  return { d0: pos.length, d1: exp(H), d2: 1 / simp, evenness: pos.length > 1 ? H / log(pos.length) : 0, shannon: H };
}

/** Role of a diet vector (04 §4.5 role table). */
export function roleOf(diet: ArrayLike<number>, photoShare: number, hasFilter: boolean): Role {
  if (photoShare > 0.5) return 'producer';
  let tot = 0;
  for (let k = 0; k < 7; k++) tot += diet[k]!;
  if (tot <= 0) return 'omnivore';
  const p = (k: number): number => diet[k]! / tot;
  if (hasFilter && p(DIET.PHYTO) + p(DIET.DETRITUS) > 0.6) return 'filter';
  if (p(DIET.MAT) + p(DIET.PLANT_CREATURE) + (hasFilter ? 0 : p(DIET.PHYTO)) > 0.6) return 'grazer';
  if (p(DIET.LIVE_PREY) > 0.5) return 'predator';
  if (p(DIET.CARCASS) + p(DIET.DETRITUS) > 0.5) return 'scavenger';
  if (p(DIET.HOST) > 0.5) return 'parasite';
  return 'omnivore';
}

/** Trophic levels of a food web by iteration: TL_i = 1 + sum_j w_ij TL_j (Levine 1980). */
export function trophicLevels(w: readonly (readonly number[])[], iters = 200): number[] {
  const n = w.length;
  let tl = new Array<number>(n).fill(1);
  for (let it = 0; it < iters; it++) {
    const next = tl.map((_, i) => {
      const row = w[i]!;
      const tot = row.reduce((a, b) => a + b, 0);
      return tot <= 0 ? 1 : 1 + row.reduce((a, x, j) => a + (x / tot) * tl[j]!, 0);
    });
    tl = next;
  }
  return tl;
}

export interface EcoMetrics {
  tick: number; day: number;
  population: number; carcasses: number;
  richness: number; hillAbundance: ReturnType<typeof hill>; hillBiomass: ReturnType<typeof hill>;
  tlBiomassKg: number[]; maxTL: number; roles: Record<Role, number>; rolesOccupied: number;
  speciationPerDay: number; extinctionPerDay: number; netDiversification: number;
  sizeSpectrum: { log2MassBins: number[]; counts: number[]; biomassKg: number[]; slope: number; maxMassKg: number };
  prevalence: number; strains: number; spores: number;
  immigrantBiomassFraction: number;
  pools: { nKg: number; producersKg: number; detritusKg: number; consumersKg: number; carcassKg: number; reservoirKg: number };
  producerConsumerRatio: number; o2Min: number; hypoxicFraction: number; capTaxFraction: number;
}

/** Compute the ecosystem metrics (every METRICS_EVERY ticks; any tick is fine). */
export function computeMetrics(world: World, s: EcoState): EcoMetrics {
  const c = world.cr.c;
  const tick = world.g.tick;
  const count = new Map<number, number>(), bio = new Map<number, number>(), tlSum = new Map<number, number>();
  const tlBins = [0, 0, 0, 0, 0];
  const roles = Object.fromEntries(ROLES.map((r) => [r, 0])) as Record<Role, number>;
  const binsLo = -30, nBins = 30;
  const sizeCounts = new Array<number>(nBins).fill(0), sizeBio = new Array<number>(nBins).fill(0);
  let pop = 0, carcasses = 0, infected = 0, consumerKg = 0, carcassKg = 0, immKg = 0, liveKg = 0, maxMass = 0;
  const imWindow = 30 * DAY_S / DT;
  for (let sl = 0; sl < world.cr.highWater; sl++) {
    const life = c.life[sl]!;
    if (life === LIFE.FREE) continue;
    const q = c.qTissue[sl]! + c.qReserve[sl]! + c.qRepro[sl]! + c.qGut[sl * 3]! + c.qGut[sl * 3 + 1]! + c.qGut[sl * 3 + 2]!;
    const kg = q * Q_MASS;
    if (life === LIFE.CARCASS) { carcasses++; carcassKg += kg; continue; }
    if (life !== LIFE.ALIVE) continue;
    pop++; liveKg += kg;
    const sp = c.species[sl]!;
    count.set(sp, (count.get(sp) ?? 0) + 1);
    bio.set(sp, (bio.get(sp) ?? 0) + kg);
    tlSum.set(sp, (tlSum.get(sp) ?? 0) + c.trophic[sl]!);
    const tl = c.trophic[sl]!;
    const tb = Math.min(4, Math.max(0, Math.floor(tl + 0.5) - 1));
    tlBins[tb] = tlBins[tb]! + kg;
    const o = sl * ER_LANES;
    const loaded = sl < s.erCap && s.er[o + ER.LOADED] === 1;
    const photoRate = loaded ? (s.er[o + ER.PHOTO_EMA]! * Q_MASS) / 0.1 : 0;
    let dietTot = 0;
    for (let k = 0; k < 7; k++) dietTot += c.diet[sl * 7 + k]!;
    const role = roleOf(c.diet.subarray(sl * 7, sl * 7 + 7), photoRate / (photoRate + dietTot + 1e-30), loaded && s.er[o + ER.FILTER]! > 0);
    roles[role]++;
    if (role !== 'producer') consumerKg += kg;
    if (kg > 0) {
      const b = Math.floor(log(kg) / log(2)) - binsLo;
      if (b >= 0 && b < nBins) { sizeCounts[b] = sizeCounts[b]! + 1; sizeBio[b] = sizeBio[b]! + kg; }
      if (kg > maxMass) maxMass = kg;
    }
    if (c.infStrain[sl * 2] !== 0xffffffff || c.infStrain[sl * 2 + 1] !== 0xffffffff) infected++;
    if (loaded && tick - s.er[o + ER.IMMIGRANT_TICK]! < imWindow) immKg += kg;
  }
  // species history: first sighting is a speciation, a drop to zero after a peak >= 5 is an extinction
  const h = s.history;
  const ids = [...count.keys()].sort((a, b) => a - b);
  for (const sp of ids) {
    if (!h.firstSeen.has(sp)) { h.firstSeen.set(sp, tick); if (h.firstSeen.size > 1 || tick > 0) h.speciations.push(tick); }
    h.peak.set(sp, Math.max(h.peak.get(sp) ?? 0, count.get(sp)!));
  }
  const prev = [...h.lastCount.keys()].sort((a, b) => a - b);
  for (const sp of prev) if (!count.has(sp) && (h.peak.get(sp) ?? 0) >= 5) h.extinctions.push(tick);
  h.lastCount = new Map(ids.map((sp) => [sp, count.get(sp)!]));
  const window = 5 * DAY_S / DT;
  const recent = (a: number[]): number => a.filter((t) => tick - t <= window).length;
  const days = Math.min(5, Math.max(tick * DT / DAY_S, 1e-9));
  const specRate = recent(h.speciations) / days, extRate = recent(h.extinctions) / days;
  // size spectrum slope: least squares of log biomass against log2 mass over occupied bins
  const xs: number[] = [], ys: number[] = [];
  sizeBio.forEach((b, k) => { if (b > 0) { xs.push(k + binsLo); ys.push(log(b)); } });
  let slope = 0;
  if (xs.length >= 2) {
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0, sxx = 0;
    for (let k = 0; k < xs.length; k++) { sxy += (xs[k]! - mx) * (ys[k]! - my); sxx += sq(xs[k]! - mx); }
    slope = sxx > 0 ? sxy / sxx : 0;
  }
  const abund = ids.map((sp) => count.get(sp)!), biom = ids.map((sp) => bio.get(sp)!);
  let maxTL = 0;
  for (const sp of ids) if (count.get(sp)! >= 10) maxTL = Math.max(maxTL, tlSum.get(sp)! / count.get(sp)!);
  const f = world.fields;
  const sum = (a: Float64Array): number => { let t = 0; for (let k = 0; k < a.length; k++) t += a[k]!; return t; };
  const producersKg = (sum(f.qP) + sum(f.qBphoto) + sum(f.qBchemo)) * Q_MASS;
  let o2Min = Infinity, hyp = 0, wet = 0;
  for (let k = 0; k < f.o2.length; k++) if (s.wetC[k]) { wet++; o2Min = Math.min(o2Min, f.o2[k]!); if (f.o2[k]! < 0.2) hyp++; }
  return {
    tick, day: (tick * DT) / DAY_S, population: pop, carcasses,
    richness: abund.filter((n) => n >= 5).length, hillAbundance: hill(abund), hillBiomass: hill(biom),
    tlBiomassKg: tlBins, maxTL, roles, rolesOccupied: ROLES.filter((r) => roles[r] > 0).length,
    speciationPerDay: specRate, extinctionPerDay: extRate, netDiversification: specRate - extRate,
    sizeSpectrum: { log2MassBins: sizeCounts.map((_, k) => k + binsLo), counts: sizeCounts, biomassKg: sizeBio, slope, maxMassKg: maxMass },
    prevalence: pop > 0 ? infected / pop : 0,
    strains: Array.from(s.strains.live.subarray(0, s.strains.n)).reduce((a, b) => a + b, 0), spores: s.spores.n,
    immigrantBiomassFraction: liveKg > 0 ? immKg / liveKg : 0,
    pools: {
      nKg: sum(f.qN) * Q_MASS, producersKg, detritusKg: (sum(f.qD) + sum(f.qSed) + sum(f.qCyst)) * Q_MASS,
      consumersKg: consumerKg, carcassKg, reservoirKg: world.g.qReservoir * Q_MASS,
    },
    producerConsumerRatio: consumerKg > 0 ? producersKg / consumerKg : Infinity,
    o2Min: wet > 0 ? o2Min : 1, hypoxicFraction: wet > 0 ? hyp / wet : 0,
    capTaxFraction: s.ecoTicks > 0 ? s.capTaxTicks / s.ecoTicks : 0,
  };
}
