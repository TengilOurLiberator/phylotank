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
