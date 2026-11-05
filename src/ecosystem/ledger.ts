/**
 * The mass ledger (CONTRACT 9): contract formulas, integer transfers with channel statistics,
 * deterministic dithering for field quantisation, inject and remove, and the exact audit.
 * Pure functions plus helpers over the world's pools; deterministic math only.
 */
import {
  C_REP, exp, fmix32, K_CAP, LIFE, M_REF_1CM, RNG_STREAM, type LedgerAudit, type RngStreams, type World,
} from '../core/index.js';
import { CH, getState, hasState } from './state.js';

/** Additive, absolute agent-cap fee per offspring in kg (CONTRACT 9.6, fixes review R11). */
export function agentCapFeeKg(nAgents: number, nCap: number): number {
  const s0 = (nAgents / nCap - 0.5) / 0.5;
  const s = s0 < 0 ? 0 : s0 > 1 ? 1 : s0;
  return K_CAP * M_REF_1CM * s * s;
}

/** Repair power of the disposable-soma rule (CONTRACT 9.4), W. */
export function repairPowerW(basalW: number, lifespanMult: number): number {
  return C_REP * basalW * (lifespanMult - 1);
}

/**
 * Gompertz ageing hazard per second, normalised so the cumulative hazard at t_life is 1
 * (CONTRACT 9.4, fixes review R10). `senescence` is the decoded trait in [0, 1].
 */
export function ageingHazard(ageS: number, lifeS: number, senescence: number): number {
  const G = 0.5 + 7.5 * senescence;
  return (G / lifeS) * exp((G * ageS) / lifeS) / (exp(G) - 1);
}

/**
 * Deterministic dither source for field quantisation (CONTRACT 5.4: "a deterministic dither
 * from the ECOLOGY stream keyed by face index"). One Philox block of the ECOLOGY stream seeds
 * each run of 1024 items; within a run, item i takes fmix32(seed + i * golden), so random
 * access is cheap and the result depends only on (seed, tick, tag, i). Subjects live above
 * 2^52 so they never collide with entity ids on the ECOLOGY stream.
 */
export class Dither {
  private readonly buf = new Uint32Array(4);
  private block = -1;
  private word = 0;
  private readonly subjectBase: number;
  constructor(private readonly rng: RngStreams, private readonly tick: number, tag: number) {
    this.subjectBase = 2 ** 52 + tag * 2 ** 36;
  }
  /** Dither for item i, uniform on [0, 1) with 24 bits. */
  at(i: number): number {
    const b = i >>> 10;
    if (b !== this.block) { this.rng.stream(RNG_STREAM.ECOLOGY).block(this.tick, this.subjectBase + b, 0, this.buf); this.block = b; this.word = this.buf[0]!; }
    return (fmix32((this.word + Math.imul(i, 0x9e3779b9)) >>> 0) >>> 8) * (1 / 16777216);
  }
}

/** floor(a + d) for a real amount a >= 0 and dither d in [0, 1): unbiased integer quanta. */
export function qRound(a: number, d: number): number {
  return a <= 0 ? 0 : Math.floor(a + d);
}

/** Book `q` quanta on a statistics channel (CONTRACT 9.7). Statistics only, never stocks. */
export function book(world: World, channel: number, q: number): void {
  if (q === 0 || !hasState(world)) return;
  const s = getState(world);
  s.ledgerTick[channel] = s.ledgerTick[channel]! + q;
  s.ledgerTotal[channel] = s.ledgerTotal[channel]! + q;
}

/**
 * book() for a caller that already holds the world's EcoState: the same two additions without
 * the two WeakMap lookups (hot per-cell loops).
 */
export function bookS(s: { ledgerTick: Float64Array; ledgerTotal: Float64Array }, channel: number, q: number): void {
  if (q === 0) return;
  s.ledgerTick[channel] = s.ledgerTick[channel]! + q;
  s.ledgerTotal[channel] = s.ledgerTotal[channel]! + q;
}

/**
 * Move up to q quanta between two pool cells (any Float64Array pools), capped by what the
 * source holds. Returns the amount moved. The only way pools change (CONTRACT 9.1).
 */
export function transfer(
  from: Float64Array, fi: number, to: Float64Array, ti: number, q: number, world?: World, channel = -1,
): number {
  const have = from[fi]!;
  const m = q > have ? have : q;
  if (m <= 0) return 0;
  from[fi] = have - m;
  to[ti] = to[ti]! + m;
  if (world && channel >= 0) book(world, channel, m);
  return m;
}

/** Bring mass in from outside the world (god powers, endowments). Changes M_total. */
export function inject(world: World, to: Float64Array, ti: number, q: number): number {
  const qi = Math.floor(q);
  if (qi <= 0) return 0;
  to[ti] = to[ti]! + qi;
  world.g.mTotalQ += qi;
  book(world, CH.godInjection, qi);
  return qi;
}

/** Take mass out of the world (god powers). Capped by the pool. Changes M_total. */
export function remove(world: World, from: Float64Array, fi: number, q: number): number {
  const m = Math.min(Math.floor(q), from[fi]!);
  if (m <= 0) return 0;
  from[fi] = from[fi]! - m;
  world.g.mTotalQ -= m;
  book(world, CH.godInjection, -m);
  return m;
}

function sumF64(a: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return s;
}

/** The exact audit (CONTRACT 9.1): integer equality, never a tolerance. */
export function audit(world: World): LedgerAudit {
  const f = world.fields;
  const cr = world.cr.c;
  const pools: Record<string, number> = {
    qN: sumF64(f.qN), qD: sumF64(f.qD), qP: sumF64(f.qP), qBphoto: sumF64(f.qBphoto), qBchemo: sumF64(f.qBchemo),
    qSed: sumF64(f.qSed), qCyst: sumF64(f.qCyst), qReservoir: world.g.qReservoir, creatures: 0,
  };
  let c = 0;
  let integral = true;
  for (let s = 0; s < world.cr.highWater; s++) {
    if (cr.life[s] === LIFE.FREE) continue;
    const t = cr.qTissue[s]! + cr.qReserve[s]! + cr.qRepro[s]! + cr.qGut[s * 3]! + cr.qGut[s * 3 + 1]! + cr.qGut[s * 3 + 2]!;
    if (!Number.isInteger(t)) integral = false;
    c += t;
  }
  pools.creatures = c;
  let total = 0;
  for (const k of Object.keys(pools)) {
    const v = pools[k]!;
    if (!Number.isInteger(v) || v < 0) integral = false;
    total += v;
  }
  return { ok: integral && total === world.g.mTotalQ && Number.isSafeInteger(total), totalQ: total, expectedQ: world.g.mTotalQ, pools };
}
