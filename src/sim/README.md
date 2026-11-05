# src/sim: orchestration and the step loop

Owner: sim engineer. Design: [sections/05-architecture.md](../../docs/sections/05-architecture.md) §5.5 and [CONTRACT](../../docs/CONTRACT.md) §4, §9.6, §10, §12.

## Responsibilities

- `sim.create(config)`, `sim.step(world)`, `sim.hash(world)`: the tick pipeline of CONTRACT 10.1, in that order.
- The journal (`schedule`): god events at their fire tick and governor decisions, applied at the start of their tick.
- Birth and death commit (CONTRACT 9.6): batched on ecology ticks in `(parentEntityId, requestIndex)` order; slot allocation lowest-free-first (`allocCreature`); compaction of segment ranges.
- View frames from world state (`frames.ts`), the protocol session shared by the worker and the host (`session.ts`).
- The browser worker entry (`worker.ts`), the wall-clock pacer (`pacer.ts`, the only file that may read the clock), and the view-side links (`client.ts`, the only file `src/ui` may import).
- Phase 0 contains the skeleton: passive glowing motes (no mass, no body, no brain) so every other layer can be built and tested end to end. Replace it, do not grow it.

## Interfaces

- Implements `SimCore`; orchestrates `GenomeModule`, `PhysicsModule`, `BrainModule`, `EcosystemModule`.
- Consumes: `core`, `genome`, `physics`, `brain`, `ecosystem`. Consumed by `host` and (only `client.ts`) by `ui`.

## Review findings to address

- **R12**: births batched at a fixed interval; development off the main thread later (WASM or GPU) without changing results.
- **R16**: governors decide only on `GOVERNOR_EVERY` ticks and are journalled; every list consumed on the CPU is sorted with a total order.
- **R4**: own the budget table in GPU (or CPU) milliseconds per wall second per throttle state, measured, and derive the population from it.

## Acceptance tests

`tests/sim.test.ts` (determinism, Node runnability, ledger exactness, stable dust slots); v0.1 acceptance 4 (same seed, 10,000 ticks, two runs: identical hash) as a golden-replay fixture once real creatures exist; a 2,000-agent world at 30 ticks per second on at most 2 cores (v0.1 acceptance 2).

## Status (phase 1)

The phase-0 motes are gone. `createSim(modules)` runs the CONTRACT 10.1 pipeline over the contract interfaces, with local fallbacks in `fallback/` for the modules still being built; budding (and sexual) creatures eat, grow, breed and die with an exact ledger. See [docs/modules/sim.md](../../docs/modules/sim.md) for the design notes and how to swap in the real modules, [docs/spikes/sim-1.md](../../docs/spikes/sim-1.md) for measured costs, and [docs/contract-requests/sim.md](../../docs/contract-requests/sim.md) for the queue, store and species interfaces the contract is missing.
