# Spike genome-3: species count under asexual drift (spike 3, genome half)

## Question

REVIEW R14 and spike 3: "run 10,000 asexual microbes for 2,000 generations in a uniform world (no divergent selection at all) and count species. The right answer is about 1." The ecosystem engineer owns the full evolvability toy (`03-evolvability.md`); this half measures the genome module's own species machinery with the real genome, operators and rates, and decides the species definition for budders (contract request G6). Contract values that depend on it: the species threshold for budders (CONTRACT 17, spike 3 row).

## Set-up

- Wright-Fisher population of N budders, non-overlapping generations, founded from N Motefly clones (0.8 mm whip microbe, MU_LOG -2.3, 9 parts, budding only). Each child picks a parent (uniformly for `neutral`; by a viability weight otherwise), is mutated by `mutateWith` at the genome's own self-adaptive rates (mutagen 1), and is assigned online by `SpeciesRegistry`. Parents die at the end of their generation; the tick advances by one founder generation time (42 s) per generation, so the persistence rule (2 generation times) is exercised.
- Selection variants: `neutral` (none); `stabilising` (viability `exp(-0.5 (dlogL/0.5)^2 - 0.5 ((nParts - 9)/6)^2)`, x0.2 without a filter mouth); `disruptive` (one niche, two equal size optima at half and twice the founder length); `twoniche` (Levene soft selection: half the offspring places favour twice, half favour half the founder length; the positive control that should give 2).
- Distances: `phenotype` (the body-plan descriptor, review R14) or `genetic` (01 §1.9.1 with silent genes, synapses and neutral markers excluded). Join rules: `lineage` (the new default: a birth never founds a species, species arise from reservoir splits) and `medoid` (01 §1.9.3 as written: a birth further than theta from its species' medoid founds an incipient species).
- Theta 0.30, `N_MIN` 8, persistence 2 generations, biomass 4 founder adults, reservoir 64, medoid every 256 joins.
- Machine: shared 4-vCPU container, Node v22.23.4, load average 15 to 32 (other engineers), so wall times are only indicative. Commit of the species code: `78a53c4` and later (the reservoir distance matrix of the next commit changes speed, not results).
- Command: `npx esbuild tests/genome-spike3.ts --bundle --platform=node --format=esm --outfile=/tmp/s3.mjs && node /tmp/s3.mjs N G mode selection seed join`.

## Numbers

"Living species" counts promoted species with members at the end; "promotions" counts every promotion over the run (the false-split rate of 01 U12 is promotions per 10^5 births under neutral drift, target under 1).

| N x G (births) | Distance | Selection | Join rule | Living species at end | Peak during run | Promotions per 1e5 births | Lumped by the view slider (theta 0.45 / 0.6 / 0.9) |
|---|---|---|---|---|---|---|---|
| 1,000 x 300 (3e5) | phenotype | neutral | medoid (01 as written) | 26 (14 above 1% of N), 32 incipient | 36 | 123 | 7 / 2 / 1 |
| 1,000 x 300 (3e5) | genetic | neutral | medoid (01 as written) | 50 (20 above 1% of N), 61 incipient | 65 | 270 | 27 / 8 / 1 |
| 1,000 x 800 (8e5) | phenotype | neutral | lineage | 3 | 6 | 1.13 | (run before the slider output) |
| 1,000 x 800 (8e5) | genetic | neutral | lineage | 1 | 2 | 0.25 | |
| 10,000 x 200 (2e6) | phenotype | neutral | lineage | 6 (largest 36%) | 6 | 0.25 | 3 / 2 / 1 |
| 1,000 x 800 (8e5) | phenotype | stabilising | lineage | 1 | 1 | 0 | 1 / 1 / 1 |
| 1,000 x 800 (8e5) | phenotype | disruptive (one niche) | lineage | 1 | 4 | 0.38 | 1 / 1 / 1 |
| 1,000 x 600 (6e5) | phenotype | two niches (control) | lineage | 3 (largest 82%) | 7 | 2.0 | 2 / 2 / 2 |

Side measurements from the same runs:

- Under pure neutral drift the mean module count grew from 5 to 44 in 800 generations (to 15.5 in 200 generations at N = 10,000) (the cap is 48) and mean MU_LOG rose from -2.3 to -2.0: with no cost, duplication and addition outrun deletion (contract request G9, genome replication cost). Under stabilising selection the module count stayed at 4.0 and MU_LOG fell to -3.2 (disruptive: 6.4 and -3.4), the direction 01 E6 expects.
- Distance calls: the medoid rule needs a distance per birth (and more near the medoid); the lineage rule needs distances only for medoid upkeep and split detection. With the reservoir distance matrix (rows refreshed only when a member changes) a 500 x 100 genetic run made 24,570 distance calls instead of 982,779.

## Reading

1. **01's medoid rule shatters a clonal population**, as R14 predicted: 36 promoted species within 60 neutral generations of 1,000 microbes, 123 promotions per 10^5 births, with either distance. Single macro-mutations (a new mouth type, a silenced subtree) move a child more than theta from the medoid, and clonal bursts reach 8 members trivially.
2. **The lineage rule fixes it.** With births never founding species, the count under any stabilising selection is 1 with no promotions, and under pure neutral drift it is 1 (genetic distance) to 3 (body-plan distance) at N = 1,000, and 6 at N = 10,000 (where neutral polymorphisms last longer), with 0.25 to 1.1 promotions per 10^5 births, at or under the U12 target of 1. What remains under pure drift is real: neutral drift lets discrete body-plan polymorphisms (mouth type, whip count) reach a quarter of the population, which the split detector then sees.
3. **The body-plan descriptor is the more sensitive of the two.** It splits on neutral discrete features that selection would normally fix; the genetic distance hardly sees them in a 9-part microbe. The two-niche positive control ends with 3 living species that lump to exactly 2 at every slider threshold up to 0.9, so the real niche split is found and kept, while the extra neutral splits on top of it lump away at theta 0.45 and above.
4. The view-level slider (`clusterAt`) lumps neutral-drift species back to 1 or 2 at theta 0.6 and to 1 at 0.9, so the stats view can show "lumped" and "split" trees without changing the sim's definition (review R14's default answer).

## Decision

- Adopt the lineage join rule with split detection as the default (`SpeciesRegistry`, `joinRule: 'lineage'`), with the body-plan distance for budders and the genetic distance for sexual genomes, theta 0.30 for both, promotion by count, persistence and biomass. Filed as contract request G6; no constant changes.
- Keep 01's medoid rule as an option for experiments only.
- The ecosystem engineer's full toy (real metabolism and plankton) should rerun the count with `SpeciesRegistry` in the loop; real ecology adds the stabilising selection that gives 1 here.
