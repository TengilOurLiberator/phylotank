/**
 * The SimCore the host runs. The product is the real pipeline (`sim`); host tests that check
 * persistence, journalling and streaming mechanics switch to the fast fallback set with
 * `useHostCore(fallbackSim)`, because the real modules cost about 0.2 ms per agent per tick on
 * the shared build machine. The real pipeline's snapshots are tested in tests/integration-real.
 */
import { sim, type SimCoreWithModules } from '../sim/index.js';

let current: SimCoreWithModules = sim;
export function useHostCore(core: SimCoreWithModules): void { current = core; }
export function hostCore(): SimCoreWithModules { return current; }
