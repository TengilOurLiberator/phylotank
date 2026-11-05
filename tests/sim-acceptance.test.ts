/**
 * src/sim phase-1 acceptance: a headless run of 1 simulated hour (108,000 ticks) with budding
 * creatures, an exact ledger audit every second of sim time, and a deterministic hash.
 *
 * The golden hash was produced by a separate Node process (esbuild bundle of the same runner,
 * see docs/spikes/sim-1.md), so matching it here shows the run is deterministic across
 * processes and module loaders, not only within one. It is a property of the fallback modules:
 * when the integrator swaps in the real genome, physics, brain or ecosystem, the golden value
 * changes and must be re-recorded (one line below).
 */
import { describe, expect, it } from 'vitest';
import { runHeadless } from '../src/sim/runner.js';
import type { SimConfig } from '../src/sim/index.js';

const GOLDEN_1H = { hash: '13182824b969a68f', digest: 'e5ff2a312f372339' };

const config: SimConfig = {
  preset: 'small', seedLo: 7, seedHi: 1, backend: 'cpu', agentCap: 1024,
  founders: [{ template: 'motefly', count: 200 }],
};

// PT_FAST=1 skips this test (about 80 s alone, up to 5 min on a loaded machine) for quick local loops; CI runs it.
describe.skipIf(process.env.PT_FAST === '1')('sim acceptance: 1 simulated hour', () => {
  it('runs 108,000 ticks of budding creatures with an exact ledger and the golden hash', () => {
    const { summary } = runHeadless(config, { ticks: 108_000, auditEvery: 10 });
    // budding life actually happened, across generations, under the agent cap
    expect(summary.buds).toBeGreaterThan(500);
    expect(summary.sexBirths).toBe(0);
    expect(summary.maxGeneration).toBeGreaterThanOrEqual(3);
    expect(summary.live).toBeGreaterThan(100);
    expect(summary.peakLive).toBeLessThanOrEqual(1024);
    expect(Object.values(summary.deaths).reduce((a, b) => a + b, 0)).toBeGreaterThan(500);
    // the ledger: 3,600 audits at 1 Hz plus the final one, every one exact (integer equality)
    expect(summary.audits).toBe(3601);
    expect(summary.auditFailures).toEqual([]);
    // deterministic
    expect({ hash: summary.hash, digest: summary.digest }).toEqual(GOLDEN_1H);
  }, 1_200_000);
});
