# src/genome: design notes (phase 1)

Owner: genome engineer. Design source: [01-genome](../sections/01-genome.md), reconciled by DESIGN §4 (R3, R4, R8, R10, R11, R12, R16, R17, R22, R23, R24) and [CONTRACT](../CONTRACT.md) §3.3, §6, §7. Decisions that touch the contract are filed in [contract-requests/genome.md](../contract-requests/genome.md) (G1 to G8). Measurements are in [spikes/genome-1.md](../spikes/genome-1.md) (benchmarks, cross-engine identity) and [spikes/genome-3.md](../spikes/genome-3.md) (species under drift).

## Files

| File | What |
|---|---|
| `index.ts` | `createGenomeModule(registry)` (the `GenomeModule`), the default `genome` instance, re-exports |
| `develop.ts` | `unfold` (graph expansion, AP/DV, non-maturity regulation), `finish` (maturity regulation, gating, size, absorption, cap, clamps, derived quantities), `develop`, `Restager` |
| `mutate.ts` | self-adaptation, point mutation over every gene pool, the 13 structural operators, `duplicateModule` keyed by paralog count |
| `crossover.ts` | merge walk by innovation id, structure from the bearer |
| `repair.ts` | the deterministic repair of 01 §1.7.4 |
| `distance.ts` | genetic distance and the body-plan descriptor distance |
| `species.ts` | `SpeciesRegistry`: online assignment, split detection, promotion, extinction, naming, the view-level `clusterAt` |
| `names.ts` | generated binomials and English/Swedish common names |
| `templates.ts` | the seven named templates plus Blank, with names |
| `registry.ts` | `InnovationRegistry` with the two-generation sliding window |
| `store.ts` | `GenomeStore`: content-addressed blobs, deterministic u32 handles |
| `life.ts` | `lifeHistory`: adult and birth length, growth constant, `tMature`, lifespan, clutch |
| `phylogeny.ts` | the pruned individual phylogeny with MRCA |
| `look.ts` | diet enzymes, the look block, the packed far-LOD colour |
| `ceiling.ts` | `clampToCeiling`, `expressedAdultLength`, `isLeviathan` |
| `kinds.ts`, `genes.ts`, `blank.ts`, `constants.ts` | builders from decoded values, decode helpers, Blank, tuning constants |

## Development

- **Unfolding.** BFS from the root over enabled links into enabled modules, links in innovation order. Up to 256 raw parts are unfolded (bounds work for adversarial genomes), then gated, absorbed and capped at `maxParts` in BFS order, so distal parts go first.
- **Repeat.** For SEGMENT and LIMB children a repeat builds a chain (copy r attaches to the tip of copy r-1, so "segments" are one gene). For other kinds the copies spread along the parent around `attachPos`. Radial symmetry spreads the copies at `attachAngle + 2 pi k / n`; mirror symmetry adds a ventral copy with the negated angle and `dv = -1` (a subtree inherits the side and mirrors its angles).
- **Recursion.** A module may appear at most `recursionLimit + 1` times on one path. A part is terminal when its own recursion is exhausted and it is not a mid-chain repeat copy; `terminalOnly` links fire only there (tails, flukes, lures). A self-link with `phaseWave` advances the innate-gait phase by `phaseStep` per recursion step as well as per repeat copy.
- **Root chain and AP.** The root and each first SEGMENT child attached near the parent's tip (attachPos at least 0.75, angle within 45 degrees, axial) form the root chain. AP is measured on the adult relative lengths; appendages take the AP of their attachment point.
- **Regulation.** See contract request G4. Non-maturity genes are applied in `unfold`, MATURITY genes in `finish`, so a restage applies them exactly and always equals a full develop.
- **Size.** `L = L0 + m (L_adult - L0)` with `L0 = BIRTH_FRACTION x L_adult` and `L_adult` clamped to the ceiling unless flagged. Per-part allometry multiplies relative lengths by `(L / L_adult)^(alpha - 1)`; then everything is scaled so the root chain spans exactly `L`. Global modifiers: G_FIN, G_EYE, G_MOUTH, G_SPIKE, G_PHOTOPHORE and G_LIMB_LENGTH scale their kind's length (and the eye, mouth and photophore size parameter), G_SLENDERNESS divides widths, G_TAPER narrows the root chain towards the tail, G_ARMOUR scales armour, G_GUT scales gut fraction, G_STIFFNESS scales Young's modulus.
- **Absorption.** EYE, CHEMO and PHOTOPHORE parts shorter than 2% of `L` become organ flags on their host and organList entries; their own children are dropped.
- **Clamps (01 §1.11.2).** Length at least 2% and radius at least 0.4% of `L`; a child lighter than 1/200 of its parent is thickened until the ratio holds. Clamps change the body, never reject it.
- **Derived.** Mass from the contract's capsule and plate volumes and densities; `gutVolume` from gut fractions; `gGut` = gut-bearing root-chain length (weighted by gut fraction over 0.7) over `L`; `handlingSize` = widest root-chain diameter plus twice the longest spike; `buildCostKg` = sum of part mass times `C_G` (neural 2.0 for eyes, armour 1.2 for the armoured fraction); the mouth descriptor by contract request G3; `organList` sorted by part then sequence.
- **Determinism.** Only `+ - * /`, `Math.sqrt/floor/round/abs/min/max` and `core/dmath`. Decode tables are built at load time with dmath. Node 22 and Chromium 153 give bit-identical phenotypes and mutants (`tests/genome-chromium.cjs`). Golden hashes of every template at three maturities are checked in (`tests/genome.test.ts`).

## Mutation

- Self-adaptation first: MU_LOG, SIGMA and MU_STRUCT_RATIO step by `0.02 N(0,1)` in x space, reflected.
- Point mutations: `Poisson(mu x nGenes)` with `mu = 10^MU_LOG x mutagen`, each on one gene picked uniformly over traits, brain traits (ENCODING excluded), modules, links, regulatory genes, hidden neurons, direct synapses and CPPN genes, then one field. Steps are `SIGMA x N(0,1)` in x space (half for attach angles), phases wrap, bit fields (eye spectra, chemo masks) flip one bit, weights take `4 SIGMA` in weight units with a 10% reset to `N(0,1)`. Brain genes share the per-gene rate (review R15): at the default about 0.005 perturbations per synapse per birth.
- Structural events: `Poisson(mu x MU_STRUCT_RATIO x nGenes)` (01 §1.6.3's 0.25 per birth at the defaults), operators by the weights of 01 §1.6.2; with ENCODING 1 the direct-synapse operators are skipped (the CPPN structural operators are later work).
- **Duplication (review R22).** The new id is `innovFor(DUPLICATE, src, paralogCount)` where `paralogCount` counts duplication ids of `src` already in the genome, so a second duplication gets a new id and the same event in two lineages gets the same id. 30% deep-copy the subtree. A duplicated head becomes a trunk. Direct synapses keyed by the module key of a copied module are copied to the new module key, so the copy arrives wired.
- Then repair, the ceiling clamp (non-leviathans) and the 16 KB cap (computed arithmetically by `encodedSize`, which a test checks against the encoder).
- Draws come from stream MUTATION at `(tick, childId)`, so results do not depend on batch order. The registry is the only state; it rotates its window every 100,000 births.

## Crossover

Matching genes: structural fields from the bearer, numeric fields from either parent (20% field by field, else the whole allele). Traits: either parent, or with 20% a blend between. Bearer-only genes stay; donor-only regulatory genes, hidden neurons and synapses come in at 25%; a donor module comes in at 15%, only with the donor link that attaches it to a module the child has. Header flags, the root and ENCODING come from the bearer, so a leviathan flag follows the bearer (CONTRACT 3.3). `crossover(A, A) == A` byte for byte.

## Distance and species

- Genetic distance: `1.0 (1 - J) + 0.5 matching + 2.0 traits`, J over expressed modules and links and enabled regulatory genes, CPPN genes at weight 0.5; silent genes, direct synapses and every trait not marked `dist` (look, mating, ODOUR markers, mutation-rate genes) are excluded (review R14).
- Body-plan distance (budders): part counts per kind (`log2(1 + n) / 4`, absorbed organs counted), mouth weights, diet enzymes, log size and sessility of the developed adult. Weights: plan sum / 3, mouth sum / 2, diet sum / 2, 2 x size, 0.5 x sessility. Theta is 0.30 for both.
- `SpeciesRegistry` (host-side, contract request G6): the lineage rule by default. Promotion needs 8 members, 2 founder generation times and 4 founder adults of living biomass. Medoids are recomputed from a 64-member reservoir every 256 joins. Naming happens at promotion (genus inherited when the medoid is within 3 theta of the parent's founder). `rename()` sets `namedBy: 'user'`, which the generator never overwrites. `clusterAt(theta)` is the display slider.

## Templates

| Template | Binomial | Size | Body (expressed adult parts) | Notable genes |
|---|---|---|---|---|
| Meadowlamp | *Pratilux tondens* | 1 cm | 5 segments (wave), rasp mouth, 2 cup eyes, 2 paired pectoral fins (one pair by an AP gate), ribbon tail | plant 0.85, clutch 6, sex 0.3, MU_LOG -2.52, sociality 0.6 |
| Hushmaw | *Tacitostoma insidians* | 5 cm | 3 thick segments, jaws gape 2x head width, stalked lure (limb plus lure photophore), tiny paired fins, fluke, lens eyes | meat 0.9, fast fibre 0.8, clutch 3, aggression 0.7, patience 0.9 |
| Sievebell | *Cribrocampana lenta* | 3 cm | bell, 6 radial filter mouths, ring of 6 photophores, jet, absorbed chemo pit, no eyes | plant 0.7, detritus 0.3, translucency 0.85 |
| Tetherling | *Haerentula furtiva* | 2 mm | 2 segments, proboscis (latch), mirrored hook spikes, mirrored antennae, cilia patch, no glow | meat 1.0, clutch 32, sex 0.1, MU_LOG -2.22, boldness 0.9 |
| Ashpicker | *Cineralegus sedulus* | 2 cm | 7 segments, suction scoop, 4-joint tentacle tail, high lateral line | detritus 0.85, G_GUT 1.6, optimum 4 °C, depth 0.85 |
| Deepcrown | *Bathycorona patiens* | 25 cm (leviathan flag) | 9 tapering segments, jaws plus filter, large paired pectorals, fluke, 6 crown spikes, lens eyes | growth 0.2, lifespan x20 (about 190 h), clutch 1, glow pulse 0.1 Hz |
| Motefly | *Flagellux minima* | 0.8 mm | one cell, 6-joint whip with a travelling wave, eye spot (absorbed), filter mouth | plant 0.9, budding only, 2 hidden neurons |
| Blank | | 2 cm | one head segment | defaults |

Each template has its own reserved innovation block (100 apart), so forks of one template interbreed and different templates do not share homology. The BrainTraits hold the behaviour template's reflex gains and personality; `src/brain` builds the wiring.

## Known gaps and later work

- CPPN genomes (ENCODING 1) get add-connection, split-node, toggle and change-function operators with 64-bit hashed ids, but only between CPPN node ids already in the genome: the CPPN input and output node ids are the brain module's to define.
- Species reconcile does the merge step (medoids within theta / 2, hybrid success from the caller); the stratified resample and leader re-clustering of 01 §1.9.4 steps 1 to 3 are not done (the lineage rule makes them less needed).
- The pruned individual phylogeny (`Phylogeny`: births, pruning on death, MRCA, unary-chain compaction) is here; the species tree is the `SpeciesRecord` parent links. The parent-diff forest for `.ptk` is host work; `GenomeStore.entries()` is the hook.
- Names: no bundled real-genus list (07 §6.4's GBIF check); the blocklist is a short built-in one.
- Performance: see spike genome-1; full develop is 15 to 40 µs and a restage 2 to 15 µs of CPU, above the 20 and 3 µs targets for the larger templates.
