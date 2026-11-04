# src/ecosystem: habitat, ecosystem, the ledger and god powers

Owner: ecosystem engineer. Design: [sections/04-ecosystem.md](../../docs/sections/04-ecosystem.md), as changed by DESIGN R1, R2, R5, R7, R11, R13, R14, R15, R18, R26, R28 and [CONTRACT](../../docs/CONTRACT.md) §3, §5.4, §9, §13.

## Responsibilities

- Terrain generation (Basin), SDF and materials; light, temperature, oxygen, vent chemistry, turbidity; the flow (streamfunction modes, already in place: `flowAt`, `rebuildFlowGrid`, `stepSlow`); 8 scent channels; conservative transport with integer fluxes.
- Producers (phytoplankton field, mats), nutrient cycling, carcasses and detritus.
- **The ledger** (CONTRACT 9): integer transfers only, the bridge rule, absorption, burning, growth, catabolism, the exact audit (already in place: `audit`).
- Metabolism per creature (basal, repair, `powerW` and `brainW` burnt), feeding (demand, resolve, collect; Holling type II filters), ageing hazard, reproduction requests, the agent-cap fee, deaths and causes.
- Disease and pathogens, safety valves, the gene bank, metrics, god-power effects (`applyGodEvent`) and nature mode.

## Interfaces

- Implements `EcosystemModule`. Exports the contract formulas `agentCapFeeKg`, `ageingHazard`, `repairPowerW` (tested in `tests/ledger.test.ts`).
- Consumes: `core`, `genome` (trait decoding). Writes the field grids and the ledger columns; physics reads the flow from the grids.

## Review findings to address

- **R2**: `M_target` per preset (100, 400, 1,600 kg) and the leviathan endowment; spike 3 measures the sustained size spectrum.
- **R8**: never a float stock; carries for sub-quantum flows; exchange buffers in exact integers.
- **R10**: no free immortality (repair cost and the Gompertz hazard), Holling saturation and pumping cost for filters, per-offspring overhead.
- **R11**: the additive, absolute cap fee (CONTRACT 9.6), never the multiplicative surcharge.
- **R13**: hand tuning plus safety valves for v0.1; a reduced tuning model later.
- **R18**: a free dim baseline glow is drawn by the renderer; keep emission cost honest in the sim.
- Log the fraction of living biomass descended from immigrants in the last 30 days (review §4).

## First tasks

Spike 3 (evolvability toy, with genome): generations per wall hour by size class; size spectrum and largest sustained mass for `M_target` x0.25, x1, x4; trajectories of SENESCENCE, LIFESPAN_MULT, SESSILE and CLUTCH_SIZE; multiplicative versus additive cap tax; microbe and leviathan ledgers against an f64 reference. Record in `docs/spikes/03-evolvability.md`.

## Acceptance tests

04 §4.14; the audit is exact (integer equality) on every ecology tick for 10,000 ticks of a populated world; v0.1 acceptance 3 (8-hour run: population in band, at least 3 body plans, nutrient total exact).
