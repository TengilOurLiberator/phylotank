# Contract requests: what the integrator applied

Phase 2 (integration, 2026-11-05 night). One line per request: **applied**, **partly**, **deferred** or **declined**, with the reason. Request ids are the ones in each module's file; evolab's are numbered EV1 to EV3 here so they do not clash with the ecosystem's E1 to E7.

## Applied in round 1 (02:40 CET)

| Request | Decision |
|---|---|
| P1 persistent physics state | **Applied.** Segment columns `muscleFrac` (init 0.3), `restPrev` (f64, so results stay bit-identical to the WeakMap version), `restInit`, `biteArmed`; creature columns `biteCooldown`, `wdE0` (init -1), `wdIn`, `wdTicks`. Physics' Work and contact state now point at the columns, so compaction moves them and snapshots carry them (the WeakMap arrays were also misaligned after a segment compaction). |
| P2 and B1 mouth and grip channels | **Applied, unified.** One segment column `cmd3` f32 x2: on MOUTH parts lane 0 BITE, lane 1 LATCH (brain's two-lane form); GRIP on CLAW parts stays on `cmd2` (no clash: claws have no other `cmd2` drive). Physics' bite reads `cmd3[2i]`, latch `cmd3[2i+1]`. Plus segment column `subtype` (u8). The sim's actuate stage clamps `cmd3`. |
| B2 `BrainModule.rehydrate` | **Applied** as an optional member (modules with no derived state may omit it; the fallback brain implements it). The sim calls it for every living creature in `adoptWorld` after a snapshot load. |
| EV2 `generation` column | **Applied.** u32, written by the sim at birth as `1 + max(parent generations)`. |
| EV3 `workJ` column | **Applied.** f32, physics adds the creature's positive muscle work every tick. |
| G9 genome replication cost | **Applied** with the proposed `KAPPA_DNA = 2.6e-14 kg` per byte, added to the per-offspring overhead (burnt, so mass is conserved). To be tuned with the ecosystem. |
| S2 genome store, S1 request queues (snapshot side) | **Partly.** No core interface yet; instead the sim now saves and restores its non-SoA state (genome store, species registry, request queues, counters, the per-world innovation registry) through `exportSimState` / `adoptWorld`, written by the host as the `.ptk` section `SIMS`. Moving the types into core is deferred: nothing outside the sim needs them yet. |
| G2 innovation registry per world | **Partly.** `SimModules.genomeFor(savedRegistry?)` builds one genome module per world (and from the saved registry on a load) instead of a field in `MutationContext`. |
| S6 releases through the journal | **Applied** in the host: journal record kind `release`, replayed on recovery. |
| H (host) `--memory` for tests | **Applied** in `tests/e2e/smoke.cjs`. |

## Deferred or declined so far

| Request | Decision |
|---|---|
| P4, P5 wording | **Deferred** (no behaviour change). |
| P6 diagnostic hooks | **Deferred**; the free functions stay. |
| B3 to B7 | **Deferred** (documentation and pool-size tuning; B7's C0 size is a balance question). |
| B8 brain cost halving | **Deferred** until the ecosystem balance runs (see docs/spikes/integration-1.md). |
| G1, G3, G4, G6, G7, G8 conventions | **Deferred** to the contract text; the module behaviour is already as proposed. |
| G5 Deepcrown flagged | **Accepted** as implemented in genome; the UI and host must confirm a leviathan release. |
| EV1 `WorldConfig.params` | Pending round 2. |

| director §3 CENSUS heat channels | **Applied** 2026-11-06: `heat` is now `0 visible life (count of creatures at least L_ceiling / 32 long), 1 emissive (glow x length of those), 2 activity (live count x 8), 3 carcasses x 16`, channels 0 and 1 normalised to 255 per frame. Only the view's director reads it (src/host/summary.ts builds its own). |
