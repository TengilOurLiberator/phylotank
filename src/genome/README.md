# src/genome: genome, development and evolution

Owner: genome engineer. Design: [sections/01-genome.md](../../docs/sections/01-genome.md), as changed by DESIGN §4 (R3, R4, R8, R10, R11, R12, R16, R17, R22, R23, R24) and [CONTRACT](../../docs/CONTRACT.md) §3.3, §6, §7.

## Responsibilities

- `develop(genome, maturity, env, opts) -> Phenotype` (CONTRACT 7): BFS unfolding of the body graph, regulators, global modifiers, allometry, von Bertalanffy length, the size-ceiling clamp, small organs absorbed as flags, derived quantities (mass, gut, mouth descriptor, handling size, build cost, organ list). Pure, deterministic, used by the sim, the host and the views.
- `mutate`, `crossover` (structure from the bearer), `repair`, `distance`, the innovation registry with paralog-keyed duplication, templates (the seven named ones plus Blank, each with a matching behaviour template from `src/brain`), species assignment and the phylogeny, the genome store (content-addressed blobs; parent-diff forest for `.ptk`).
- The format itself is in `src/core/genome-format.ts` and is contract; extend it only through the contract.

## Interfaces

- Implements `GenomeModule` (`src/core/contract.ts`). Exports `blankGenome`, `expressedAdultLength`, `clampToCeiling` already.
- Consumes: `core` only.
- Consumed by: physics (`Phenotype` types), brain (`Phenotype`, organ list), ecosystem (traits), sim (births), render (`develop` for templates), ui (designer).

## Review findings to address

- **R2**: the ceiling clamp and the leviathan flag (CONTRACT 3.3) in mutation, crossover and `develop`.
- **R10**: clutch per-offspring overhead is in the ledger, but `CLUTCH_SIZE` and `BIRTH_FRACTION` decoding must feed it exactly.
- **R14**: species for budders on the expressed phenotype (body-plan descriptor and diet), silent and neutral genes excluded, promotion by biomass as well as count; the view-level threshold slider is the default answer.
- **R15**: support both brain encodings in the genome (`ENCODING` immutable; `DSYN` genes keyed by module keys so duplicates arrive wired); brain mutation rates scaled by `MU_LOG`, and far below 0.8 perturbations per connection.
- **R22**: duplication keyed by `(src, paralogCount)`; a unit test duplicates one module three times and expects three copies.

## First tasks

1. Spike 3 with the ecosystem engineer (evolvability toy): species count under pure asexual drift must be about 1.
2. `develop` for Blank and Motefly; restage cost benchmark (target 3 µs; full develop 20 µs).

## Acceptance tests

01 §1.14 unit and property tests; genome E1, E2, E5, E9 (v0.4); same genome gives a bit-identical Phenotype in Node and Chromium; `develop` of every template under 64 parts; a new gene's default leaves 1,000 developed bodies unchanged.

## Phase 1 status (2026-11-05)

Implemented and tested (`tests/genome.test.ts`, 57 tests): `develop` with restage, mutation (point, structural, paralog-keyed duplication, self-adaptive rates, direct and CPPN brain genes), crossover with repair, genetic and body-plan distance, `SpeciesRegistry` (lineage rule with split detection, promotion by count, persistence and biomass, reconcile, naming), `Phylogeny`, `GenomeStore` with a parent-diff codec, the seven templates plus Blank, generated binomials, life-history and look readers, instance paths for the editor. Design notes: [docs/modules/genome.md](../../docs/modules/genome.md); contract requests: [docs/contract-requests/genome.md](../../docs/contract-requests/genome.md); spikes: [genome-1](../../docs/spikes/genome-1.md), [genome-3](../../docs/spikes/genome-3.md). Node versus Chromium identity: `NODE_PATH=$(npm root -g) node tests/genome-chromium.cjs`.

Integration: create one module per world with `createGenomeModule(registry)` and save `registry.save()` with snapshots; `breed(mod, bearer, donor, ctx)` runs the operators in contract order; `lifeHistory(g, lCeilingM)` gives `tMature`, lifespan and clutch; `packedColour(g)` fills the `colour` column. A Phenotype's typed arrays share one ArrayBuffer.
