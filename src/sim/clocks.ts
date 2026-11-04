/** Sim-time clocks in [0, 1) (CONTRACT 3.1). Tick counts only, never the wall clock. */
import { DAY_S, TICK_HZ, YEAR_DAYS, type World } from '../core/index.js';

export function dayPhase(world: World): number {
  const dayTicks = (world.config.dayS ?? DAY_S) * TICK_HZ;
  return (world.g.tick % dayTicks) / dayTicks;
}
export function yearPhase(world: World): number {
  const yearTicks = (world.config.dayS ?? DAY_S) * (world.config.yearDays ?? YEAR_DAYS) * TICK_HZ;
  return (world.g.tick % yearTicks) / yearTicks;
}
