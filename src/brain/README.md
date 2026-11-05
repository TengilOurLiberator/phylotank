# src/brain: brains, senses and behaviour

Owner: brain engineer. Design: [sections/03-brains.md](../../docs/sections/03-brains.md), as changed by DESIGN R3, R4, R9, R13, R16, R34 and [CONTRACT](../../docs/CONTRACT.md) §5.3, §6.7, §8.

## Responsibilities

- `layout(phenotype, genome)`: the canonical, ordered I/O channels and neuron list (CONTRACT 8.1), stable ids, size class and trimming.
- Development: the **direct** encoding (reflexes, innate gait, oscillators, `DSYN` genes keyed by module keys) first, then the **CPPN** encoding (DESIGN R3) behind `ENCODING = 1`.
- Class pools (allocate, free), `sense` (eyes, lateral line, smell, touch, taste, internal and clock inputs, noise from stream SENSOR_NOISE), `think` (the synchronous CTRNN and oscillator tick of CONTRACT 8.3), writing outputs to `out`, `cmd` and `cmd2`, and `brainW`.
- Behaviour templates matching the body templates; behaviour classifier and inspector data (10 Hz int8 plus 8 scope neurons, DESIGN R34).

## Interfaces

- Implements `BrainModule`. Exports `sizeClassFor` and `brainCostW` already.
- Consumes: `core`, `genome` (Phenotype, organ list). Reads world state for perception; writes only brain pools and the output columns.

## Review findings to address

- **R5** (microbe fog): perception queries only levels whose items subtend more than a minimum angle; smaller things are the density field. Budget in cell visits.
- **R15**: direct encoding is the v0.1 default; the CPPN is an experiment decided by spike 8. Keep mutational load low; avoid the top-K-by-|w| discontinuity (prefer LEO thresholds with fixed slot order).
- **R16**: neighbour order `(cell, slot)`, nearest-K ties by `(distance squared, slot)`; the governor's brain divisor comes only from the journal.
- **R18**: emission outputs are smoothed by the renderer, but avoid emission policies that flicker by construction (hysteresis on triggers).
- Brain cost inconsistency: 03 asks for both "a 16-neuron microbe pays 3% of basal" and "Glimmerkin pays 15 to 20%", which absolute costs cannot both meet; the contract's initial values favour the microbe figure. Tune with the ecosystem engineer and record the result.

## First tasks

Spike 8 (encoding shoot-out): brains E2 (forced duplications) and genome E8 (distribution of fitness effects) for both encodings, plus development time per birth in JS. Record in `docs/spikes/08-brain-encoding.md`.

## Acceptance tests

03 §3.14 (reflex-only generation 0 survives, E1; duplicated organs wired in their first generation, E2); the CPU reference tick is bit-identical across Node and Chromium; a C4 brain ticks in under the budget of 03 §3.9.6 on the CPU.

## Status (phase 1)

Implemented and tested: `layout` (CONTRACT 8.1, keys, trimming), the direct encoding (default) and the CPPN encoding behind `ENCODING = 1`, class pools with overflow to larger classes, `sense` (internal and clock inputs, three-band eyes with occlusion, lateral line, smell level and rate, touch, taste, proprioception, sensor noise), `think` (Jacobi CTRNN, oscillators, ABCD plasticity, NaN guard, trigger hysteresis), `rehydrate`, the inspector frame, behaviour templates and a behaviour classifier. Notes: [docs/modules/brain.md](../../docs/modules/brain.md). Contract requests: [docs/contract-requests/brain.md](../../docs/contract-requests/brain.md). Spike 8: [docs/spikes/brain-8.md](../../docs/spikes/brain-8.md). Cross-engine check: `node tests/e2e/brain-crossengine.cjs` (Node and Chromium give the same hash).
