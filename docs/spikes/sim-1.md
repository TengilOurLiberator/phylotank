# Spike sim-1: cost of the tick pipeline, the birth commit and the hash (R4, R12)

## Question

The sim README asks src/sim to own the budget table (review R4: milliseconds per wall second per throttle state, with the population derived from it) and to batch births (R12). Before the real modules land, how much does the phase-1 pipeline cost per agent and per tick, how expensive is one birth at commit, and what do the state hash and the exact audit cost? Which contract values depend on it: none directly; it sets `src/sim/budget.ts` (`US_PER_AGENT_TICK`, `CPU_BUDGET_MS_PER_S`) and the advice on `HASH_EVERY` and audit cadence below.

## Set-up

- Machine: the shared overnight build container, 4 vCPU "Intel Xeon Processor @ 2.10GHz", Node v22.23.4. About ten other engineers were building and testing on the same 4 cores, so the load average was 11.5 to 12.6 during the measured runs. Every number below is therefore a contended figure; I give two runs where I have them.
- Code: branch `mod/sim` at commit `1ee5782` (the measured pipeline is unchanged after it), the local fallback modules (`src/sim/fallback`: one-capsule bodies, a reflex brain, the grazing life cycle) over the real phase-0 ecosystem (flow, initial endowment, audit).
- Command: an esbuild bundle of a small harness (`createSim` with each module method wrapped in a `performance.now()` timer), run as `node bench.mjs`. Small preset, CPU backend, Motefly-like 3 mm budders. 300 warm-up ticks, then 3,000 measured ticks.

## Numbers

### Per-tick cost by stage (ms per tick, mean over 3,000 ticks)

Run 1 (load average about 12):

| Agents live | ms/tick | ticks/s | sense | think | physics | ecology (incl. commit share) | slow (flow) | rest of step |
|---|---|---|---|---|---|---|---|---|
| 692 | 0.826 | 1,211 | 0.002 | 0.049 | 0.231 | 0.468 | 0.031 | 0.045 |
| 2,144 | 3.087 | 324 | 0.000 | 0.236 | 0.975 | 1.709 | 0.039 | 0.127 |
| 3,984 | 6.452 | 155 | 0.000 | 0.548 | 2.139 | 3.452 | 0.052 | 0.262 |

Run 2 (load average 11.5):

| Agents live | ms/tick | ticks/s | think | physics | ecology | slow |
|---|---|---|---|---|---|---|
| 692 | 0.999 | 1,001 | 0.073 | 0.296 | 0.539 | 0.038 |
| 2,144 | 2.080 | 481 | 0.164 | 0.699 | 1.092 | 0.031 |
| 3,984 | 4.206 | 238 | 0.354 | 1.446 | 2.213 | 0.028 |

- Per agent and tick: about 1.0 µs in the loaded run 2 (4.2 ms / 3,984), so `US_PER_AGENT_TICK = 1.05`. Earlier, at a lighter load, 200 agents ran at 0.37 ms per tick and the host's `--headless` run of 3,000 agents at 1.23 ms per tick (816 ticks/s), which is about 0.4 µs per agent and tick.
- Fixed cost per tick (no agents): 0.89 ms before the flow fix below, about 0.1 ms after it.
- **v0.1 acceptance 2** (2,000 agents at 30 ticks/s on at most 2 cores): 2,144 agents ran at 324 to 481 ticks/s on one contended core, 11x to 16x the requirement, with the fallback modules. The real physics, brains and feeding will cost more; the margin is what they may use.

### The flow rebuild

The phase-0 `ecosystem.stepSlow` evaluates five sine and cosine pairs per coarse cell: about 13 ms per slow tick on Small, 0.89 ms per tick averaged, which dominated an empty world. A separable rebuild (`rebuildFlowGridFast`: one sine and cosine per mode per row and per column, same operands and operation order) is bit-identical (checked in `tests/sim-pipeline.test.ts`) and costs about 0.4 ms per slow tick (0.03 ms per tick averaged), about 30x less. Offered to the ecosystem engineer.

### Birth commit

2,000 buds committed in one batch (1,000 parents, clutch 2): 171 to 204 ms, so **86 to 102 µs per birth** with the fallback genome (clone, 96 mutation draws, encode and xxh64 to intern, develop, segment and slot allocation, species check). At the observed 1x rates (a few births per ecology tick) that is under 1% of a core; at 16x with 30 births per second of sim time it is about 5%. R12's per-birth budget is therefore set by the real `develop` and `brain.allocate`, not by the commit itself.

### State hash and audit

| Operation | Small preset | Notes |
|---|---|---|
| `hashWorld` | 57 ms (light load), 67 to 151 ms (loaded) | dominated by the fine field grids (3 x 147,456 f64) and the SDF grid |
| `ecosystem.audit` | 0.85 to 4.7 ms | sums of every pool |

At `HASH_EVERY = 256` ticks the hash costs 57 to 150 ms per 8.5 s of 1x time (about 1% of a core), but at 16x it is 10% to 25% of the sim's time. I recommend that the host hashes on snapshots and on the journal cadence only at 1x, or hashes field grids incrementally; the sim records checkpoints only when `hashCheckpoints` is set.

### The 1-hour acceptance run

Small, seed (7, 1), agent cap 1,024, 200 Motefly founders, 108,000 ticks, an exact audit every 10 ecology ticks (3,601 audits):

| | Value |
|---|---|
| Wall time, standalone Node (esbuild bundle) | 78.3 s (46x real time, under load) |
| Wall time, inside vitest | 152 s |
| Births (all buds), deaths (all age) | 1,666 and 1,274 |
| Live at the end, peak live | 592 and 751 (under the cap; the additive fee holds it) |
| Deepest generation | 4 |
| Audit failures | 0 |
| State hash, digest | `13182824b969a68f`, `e5ff2a312f372339` (after restages moved into the commit; before that `a68d9439482f9bf9`, matched in both processes) |

An earlier variant without the cap (4,096) and without the mature-reproduction split crashed to 28 creatures after an hour because offspring never reached the reproduction threshold before dying of age; that failure is in the fallback life history, not the pipeline, and is fixed.

## Decision

- No contract change from these numbers.
- `src/sim/budget.ts` holds the budget table (CPU ms per wall second: watching 350, ambient 150, background 100, battery 60) and `populationFor`, which gives, at 1.05 µs per agent and tick: battery 1,790, background 3,060, ambient 4,647 and watching 10,996 agents at 1x (capped by the preset's CPU cap). `governorEntry` turns a measured cost into a journalled `popSoftLimit` decision on a `GOVERNOR_EVERY` tick.
- Re-measure after integration with the real modules, on William's PC rather than this shared container.
