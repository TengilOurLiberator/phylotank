# src/physics: bodies, fluid and contacts

Owner: physics engineer. Design: [sections/02-physics.md](../../docs/sections/02-physics.md), as changed by DESIGN R1, R2, R5, R8, R9, R10 and [CONTRACT](../../docs/CONTRACT.md) §2, §5.1, §5.2, §7, §10.3.

## Responsibilities

- `toSegmentSpecs(Phenotype)` and `loadBody`/`restage` into the segment pool; mass properties rescaled to the ledger mass.
- The full-tier XPBD integrator: muscles (activation lag, Hill curve, torque caps), implicit anisotropic drag against the local water velocity (`sampleFlow` reads the `flowU`/`flowV` grids), buoyancy, cilia, jets, bladders, roll (`mirror`).
- Spatial hash (ordered by `(cell, slot)`), contacts, terrain, bites, grabs, latches, rams, severing, corpses as physics bodies.
- Per tick: `powerW` (muscle work over efficiency, isometric cost, organs, filter pumping), segment `work` and `touch`, events (`bite`).
- Exploit watchdogs.

## Interfaces

- Implements `PhysicsModule`. Reads segment `cmd`/`cmd2` and creature `out` written by the brain; writes positions, velocities, `act`, `work`, `touch`, `damage`, `powerW`.
- Consumes: `core`, `genome` (types and `develop` only). Never imports ecosystem: the flow arrives through the field grids.

## Review findings to address

- **R5**: per-workgroup contact append on GPU later; on CPU, cap neighbour search by cells visited, not objects found.
- **R6**: at least 4 substeps for any creature with an active muscle; cross-creature links solved inside the substep loop; contact correction velocity capped, residual kinetic energy charged as heat.
- **R7**: no reduced tier in v0.x. If one is added later, the gait descriptor includes inter-joint phase and the card key changes at 5% in drag, mass or muscle section.
- **R9**: watchdogs measure kinetic energy in the local water frame and count current drag work as an input. Unit test: a passive microbe in the strongest plume for 60 s triggers nothing.
- **R23**: when porting to WGSL, every pipeline must compile at the default 8 storage buffers per stage.

## First tasks

Spike 1 (XPBD swimmer and microbenchmarks): B2, B4, T1 at `n_sub` 1, 2, 4, 16; the exploit-transfer ratio (evolve at 1 substep, re-evaluate at 16, must be at least 0.8); hash and perception query costs. Record in `docs/spikes/01-xpbd.md`.

## Acceptance tests

02 §2.13: conservation C1 to C5 (with the ecosystem ledger), known swimmers B1 to B7, timestep convergence T1 to T5 (T2 now compares 30 Hz with substeps against 60 Hz), the R9 plume test, and the skeleton drifter behaviour in `tests/sim.test.ts` until real bodies replace it.

## Status (end of phase 1)

- Spike 1 done: [docs/spikes/physics-1.md](../../docs/spikes/physics-1.md) (named `physics-1` per the phase brief's ownership rule). Design notes: [docs/modules/physics.md](../../docs/modules/physics.md). Contract requests: [docs/contract-requests/physics.md](../../docs/contract-requests/physics.md).
- Tests: `tests/physics.test.ts` (bodies, water, R9, contacts, rams, bites, hash I1, determinism I2), `tests/physics-links.test.ts`, `tests/physics-card.test.ts`, `tests/physics-spike.test.ts` and `tests/physics-bench.test.ts` (quick variants in `npm test`; `PT_SPIKE=1` runs the measurements).
- Met: B1, B3, B5, T1 (B3, B4), C1 centre of mass, passive energy monotone, no energy from nothing with muscles, exploit transfer at the 4-substep floor (0.97), R9 plume, I1, I2 (same run). Open: B2 against Gray-Hancock (-17%; the integrator matches the resistive-force reference to 0.7%), B4 Strouhal, C1 angular momentum, B6, B7, C2 to C6, T3 to T6, L1 to L3, snapshot-exact restore (contract request P1).
