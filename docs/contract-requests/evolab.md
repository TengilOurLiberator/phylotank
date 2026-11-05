# Contract requests from evolab

evolab (`tools/evolab`) drives the real SimCore through `tools/evolab/adapters/simcore.ts`, using only contract surfaces. Three small additions would let the lab measure what spike 3 measures on the toy. None blocks anything; the adapter reports the missing inputs as "not available" today.

## 1. `WorldConfig.params`: balancing overrides for headless tuning (04 §4.11, review R13)

**What.** An optional map of named balancing parameters on `WorldConfig`, read by `ecosystem.initWorld` and the systems that use them, journalled in META so a run replays.

```ts
// src/core/types.ts, WorldConfig
/** Balancing overrides for tuning and lab runs (names as in 04 §4.10). Unknown names are an error. */
params?: Readonly<Record<string, number>>;
```

**Why.** The tuning harness (`tools/evolab/tune/`) runs Morris screening and CMA-ES over the 04 §4.10 parameter set (`tools/evolab/tune/space.ts`, `SIM_SPACE`). Today only `mTargetKg` can be passed into a real world, so the harness can tune the toy but not the sim.

## 2. Creature column `generation` (u32)

**What.** Append to `CREATURE_COLUMNS`: `{ name: 'generation', type: 'u32' }`, written by `sim` at birth as `max(parent generations) + 1` (founders and releases 0).

**Why.** Review R12 asks for "generations per wall hour by size class". The event stream carries parents, but a lab that samples the world cannot reconstruct depth without keeping the whole pedigree. One u32 per creature is cheap and also feeds the `record: 'generation'` detector event of CONTRACT 11.

## 3. Creature column `workJ` (f32): cumulative muscle mechanical work

**What.** Append `{ name: 'workJ', type: 'f32' }`, accumulated by physics as the sum over substeps of positive actuator work (the same quantity as the segment `work` column, summed per creature and over life).

**Why.** CONTRACT 10.3 requires exploit watchdogs that count muscle work as the input; the lab's degenerate-swimmer audit compares mechanical energy out (water-frame kinetic energy plus drag dissipation) with work in. Without `workJ` the adapter integrates `powerW` (a metabolic demand, so an upper bound on work), which makes the audit too lenient to catch modest injection. If physics also exposes cumulative drag dissipation per creature, the audit becomes exact; that is optional.
