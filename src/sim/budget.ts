/**
 * The CPU budget table (review R4: one table, in milliseconds per wall second per throttle
 * state, and the population derived from it) and the governor helper that turns a measurement
 * into a journalled decision (CONTRACT 4.4, review R16).
 *
 * Measurements come from outside the step (the host or the worker times its ticks); the
 * decision is pure and is applied only through `schedule()` on a GOVERNOR_EVERY tick, so a
 * replay applies the same decision without re-measuring.
 */
import { GOVERNOR_EVERY, TICK_HZ } from '../core/index.js';
import type { GovernorDecision, JournalEntry } from './state.js';

export type ThrottleState = 'watching' | 'ambient' | 'background' | 'battery';

/** CPU milliseconds per wall second the sim may use at 1x, per throttle state (one core = 1000). */
export const CPU_BUDGET_MS_PER_S: Readonly<Record<ThrottleState, number>> = {
  watching: 350, ambient: 150, background: 100, battery: 60,
};

/**
 * Measured cost per agent per tick, microseconds, for the phase-1 pipeline with the fallback
 * modules (docs/spikes/sim-1.md): 0.45 on an idle 2.1 GHz Xeon core, 1.05 under a load
 * average of 12 on 4 cores. The default is the loaded figure. Re-measure after integration.
 */
export const US_PER_AGENT_TICK = 1.05;
/** Fixed cost per tick independent of the population (fields, flow, producers), microseconds. */
export const US_FIXED_PER_TICK = 120;

/** Largest population that fits a budget at a speed (ticks per wall second = 30 x speed). */
export function populationFor(budgetMsPerS: number, speedX = 1, usPerAgentTick = US_PER_AGENT_TICK, usFixed = US_FIXED_PER_TICK): number {
  const ticksPerS = TICK_HZ * speedX;
  const usPerTick = (budgetMsPerS * 1000) / ticksPerS;
  return Math.max(0, Math.floor((usPerTick - usFixed) / usPerAgentTick));
}

/** Measurements the host or worker collects between governor ticks. */
export interface GovernorInput {
  state: ThrottleState;
  /** Mean measured wall cost per tick over the last window, microseconds. */
  usPerTick: number;
  /** Mean live population over the same window. */
  meanAgents: number;
  /** Requested speed multiple (1 at 1x). */
  speedX: number;
  /** Agent capacity of the world. */
  agentCap: number;
}

/**
 * Decide the population soft limit for the next governor tick, with 10% hysteresis so the
 * limit does not chatter. Returns a journal entry for `schedule()`, or null for no change.
 */
export function governorEntry(nextTick: number, input: GovernorInput, current: number): JournalEntry | null {
  if (nextTick % GOVERNOR_EVERY !== 0) throw new Error('governor decisions belong on GOVERNOR_EVERY ticks');
  const perAgent = input.meanAgents > 0 ? Math.max(0.05, (input.usPerTick - US_FIXED_PER_TICK) / input.meanAgents) : US_PER_AGENT_TICK;
  const fit = Math.min(input.agentCap, populationFor(CPU_BUDGET_MS_PER_S[input.state], input.speedX, perAgent));
  const limit = fit >= input.agentCap ? 0 : fit;
  if (current !== 0 && limit !== 0 && Math.abs(limit - current) < 0.1 * current) return null;
  if (limit === current) return null;
  const decision: GovernorDecision = { popSoftLimit: limit };
  return { tick: nextTick, kind: 'governor', decision };
}
