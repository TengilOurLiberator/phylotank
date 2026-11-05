# Spike evolab-1: the 2D evolvability toy (review spike 3, first pass)

Owner: evolab (`tools/evolab`). This is the lab's first spike: a self-contained toy world, built while the real genome, physics and ecosystem modules are being written in parallel, and used to answer the review's core question with real runs. The ecosystem engineer's `03-evolvability.md` remains the report that decides contract values; these numbers are input to it.

## 1. Question

Review R12 and spike 3: **does anything interesting evolve within hours of simulated time, and how fast?** Concretely:

- generations per simulated hour by size class;
- swim-speed improvement over generations (a body that swims badly should improve where selection rewards swimming);
- diversity: species counts on the phenotype definition (the R14 fix) and on the full genotype including neutral markers;
- whether the exploits the review predicts appear: immortal blobs (R10), energy leaks (R6, R8), microbe flood (R11), degenerate swimmers (R6, R9);
- multiplicative against additive cap tax (R11), and the size spectrum for `M_target` x0.25, x1 and x4 (R2).

The contract values these numbers bear on are `C_REP` and the Gompertz range (CONTRACT 9.4), the Holling ceiling `J_max = 8 B / (f E_B)` and the pumping cost (9.5), `K_CAP` and the additive fee (9.6), `M_target` (3.2), and the species threshold for budders (genome).

## 2. Set-up

- Machine: the shared build container, 4 vCPU Intel Xeon at 2.10 GHz, 15 GB RAM. During the runs the load average was 20 to 35 from about 11 parallel engineers, so **wall times are pessimistic** (an unloaded profile ran about 4x faster).
- Node v22.23.4. esbuild bundles the CLI (`tools/evolab/evolab.mjs`). Toy code as of commit `56b5324` (runs A to G) and `19bea68` (run P, which adds the size-free swim index to the live series; the other runs' swim index is computed afterwards from the recorded trait means, see 3.2).
- Commands (all with `--preset small --sample 120`, toy step 0.5 s):

| Run | Command flags | Sim hours | What it tests |
|---|---|---|---|
| A | `--seed 1` | 8 | baseline, contract costs |
| B | `--seed 2` | 8 | baseline, second seed |
| C | `--seed 1 --free-immortality` | 12 | pre-contract ageing: SENESCENCE 0 is immortal, repair is free (R10) |
| D | `--seed 1 --cap-tax multiplicative` | 12 | the old 04 §4.7 cap surcharge instead of the additive fee (R11) |
| G1 | `--seed 1 --m-target-kg 0.879` | 12 | `M_target` x0.25 (R2) |
| G4 | `--seed 1 --m-target-kg 14.06` | 8 | `M_target` x4 (R2) |
| P | `--seed 1 --param handlingS=5` | 8 | predators with short handling times |

Plus detector checks on the `tiny` preset: `--leak 1` (a ledger bypass of 1 quantum per step), `--thrust-bug 3` (propulsive efficiency above 1 for large fins), and a clean 2-hour run. Every run writes `series.csv`, `species.csv`, `summary.json` and PNG charts (population by species, species count, swim speed, swim index, body length, diet roles, births and deaths, ledger, generations, life-history traits) to `tools/evolab/runs/<name>/` (ignored by git; rerun the command to regenerate). The summaries of every run, the tuning result and six charts are kept in `tools/evolab/results/evolab-1/`.

### The toy (deliberately crude, real contract constants)

- **World**: `small` toy preset, 6 x 3.375 m (16:9), 0.25 m field cells, agent cap 2,048, `M_target` 3.516 kg, which is the contract Small preset's mass per area (100 kg over 576 m²). Light falls off with depth (k_w 0.2 /m) with a day-night cycle of `DAY_S` = 1,200 s; a horizontal jet of 0.12 m/s at a third of the depth; plankton P grows on dissolved N (μ_max 1.5 /day, K_N, linear and quadratic mortality to detritus), detritus remineralises, carcasses leach; conservative integer diffusion.
- **Ledger**: every pool is an integer count of 1 ng quanta in exact f64 (CONTRACT 9.1), all flows are transfers with carries, energy is derived from mass by the bridge rule (9.2, f = 0, 0.3, 0.6, 1). The mass audit is integer equality.
- **Genome**: 22 real genes (adult length on a log scale, aspect, fin area, muscle fraction, cruise and sprint effort, four steering weights, filter-vs-bite mouth, the 9.3 enzyme simplex, SENESCENCE, LIFESPAN_MULT, SESSILE, CLUTCH_SIZE, BIRTH_FRACTION, a mutation-rate gene, three neutral odour markers). Point mutation with probability 0.25 per gene per birth, Gaussian with the genome's own σ; the length gene is clamped to the ceiling.
- **Body and swimming**: ellipse of length L and width aspect x L in the 2.5D model; drag `0.5 ρ v² A (24/Re + c_shape)`, so microbes swim in the viscous regime; thrust power `η(fins, Re) x P_muscle x effort` with muscle power scaled to basal (an aerobic scope of 6 at the reference muscle fraction), solved implicitly so a step can never inject energy.
- **Metabolism and life history**: Kleiber basal `0.3 m^0.75` W, repair `C_REP B (LIFESPAN_MULT - 1)`, Gompertz ageing with `G = 0.5 + 7.5 SENESCENCE` (9.4), Holling type II intake with `J_max = 8 B / (f E_B)` and pumping `0.5 B filter mouthOpen` (9.5), assimilation `a_max e^1.3` with a_max 0.45, 0.8, 0.3, growth at `C_G` 1.4, starvation catabolism at 0.8, budding with the per-offspring overhead and the additive cap fee (9.6). Births commit at the end of the step in parent slot order.
- **Species**: two registries. Phenotype species use body plan and diet genes only (the R14 fix); genotype species use every gene including the neutral markers. A newborn more than 0.12 RMS (normalised units) from its parent species' running centroid founds a new species; the count is species with at least 5 living members (04 §4.9).
- **Founders**: 160 mote grazers (2 mm), 60 small grazers (1 cm), 40 scavengers (5 mm) and 16 hunters (2.5 cm), all deliberately poor swimmers (fin area 0.08 to 0.12, blunt aspect 0.4 to 0.45, little muscle).

## 3. Numbers

All runs: the mass audit was exact (integer equality) at every one of the 2,047 samples, and the energy closure residual stayed below 5e-9 of the initial energy stock (floating-point summation only). Numbers are from `summary.json` and `series.csv` of each run; "end" means the mean over the last 20% of the run unless stated.

### 3.1 Throughput and generations

| Run | Sim h | Wall s | Speed-up (x real time) | Mean live agents | Agent-steps per wall s | Mean generation at end | Deepest lineage |
|---|---|---|---|---|---|---|---|
| A | 8 | 1,196 | 24 | 1,324 | 64k | 10.1 | 15 |
| B | 8 | 1,192 | 24 | 1,288 | 62k | 9.3 | 15 |
| C | 12 | 864 | 50 | 1,213 | 121k | 18.4 | 24 |
| D | 12 | 1,467 | 29 | 1,977 | 116k | 19.1 | 26 |
| G1 | 12 | 1,025 | 42 | 1,118 | 94k | 18.0 | 24 |
| G4 | 8 | 1,247 | 23 | 1,564 | 72k | 8.1 | 13 |
| P | 8 | 472 | 61 | 1,324 | 162k | 10.1 | 15 |

The machine was shared (load 20 to 35 on 4 cores); an unloaded profile of the same code ran about 600k agent-steps per second, so a 2,000-agent toy world should run at about 150x real time on one free core.

**Generations per simulated hour by adult-length class** (mean generation of the living class divided by elapsed hours; founders are generation 0):

| Run | < 2 mm | 2 to 5 mm | 5 to 20 mm | 20 to 50 mm |
|---|---|---|---|---|
| A | 1.34 | 1.18 | 1.12 | (extinct) |
| B | 1.33 | 1.13 | 1.12 | (extinct) |
| C | 1.57 | 1.31 | 1.11 | (extinct) |
| D | 1.60 | 1.47 | 1.37 | (extinct) |
| G1 | 1.52 | 1.42 | 1.33 | (extinct) |
| G4 | 1.16 | 1.01 | 0.75 | (extinct) |

So a 1 to 2 mm budder breeds about **every 40 minutes** of simulated time under the contract's energetics, not every 1 to 2 minutes as the review estimated for microbes (R2, R12). The limit is the Holling ceiling: `J_max = 8 B / (f E_B)` with plant assimilation `0.45 e^1.3` gives at most about 3.3 B of reserve gain, of which basal, repair (0.15 B), cruising and pumping take about 2 B, leaving a net surplus near 1 B for growth and budding (`C_G` 1.4 plus the 0.3 starting reserve and the 0.15 overhead per offspring).

### 3.2 Swimming

The potential swim speed in m/s *fell* in every run (for example D: 0.119 to 0.055 m/s), because the population shrank towards 1 to 2 mm bodies; body lengths per second rose (A 33 to 44, D 33 to 47). Neither is a fair measure of better swimming, so the lab reports a **size-free swim index**: potential speed at full effort divided by that of a reference design (aspect 0.4, fin area 0.1, muscle 0.15) at the same adult length. For runs A to G4 it is computed afterwards from the population-mean body traits at 2 mm; run P also records the live per-creature index (0.86 at the start, 0.945 averaged over its last 1.6 hours), which tracks it.

| Run | Index at 0 h | 1 h | 4 h | 8 h | 12 h | Gain | Per generation | Fin area 0 h to end | Aspect | Cruise effort |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.864 | 0.790 | 0.830 | 1.011 | | +17% | 1.6% | 0.087 to 0.178 | 0.44 to 0.42 | 0.15 to 0.087 |
| B | 0.864 | 0.806 | 0.830 | 1.015 | | +17% | 1.8% | 0.087 to 0.158 | 0.44 to 0.44 | 0.15 to 0.099 |
| C | 0.864 | 0.801 | 0.832 | 0.942 | 1.053 | +22% | 1.1% | 0.087 to 0.147 | 0.44 to 0.33 | 0.15 to 0.118 |
| D | 0.864 | 0.786 | 0.843 | 0.987 | 1.081 | +25% | 1.2% | 0.087 to 0.186 | 0.44 to 0.39 | 0.15 to 0.070 |
| G1 | 0.864 | 0.793 | 0.830 | 1.084 | 1.078 | +25% | 1.2% | 0.087 to 0.143 | 0.44 to 0.40 | 0.15 to 0.094 |
| G4 | 0.864 | 0.800 | 0.820 | 0.873 | | +1% | 0.1% | 0.087 to 0.127 | 0.44 to 0.46 | 0.15 to 0.082 |

Read: for the first 2 to 4 hours the index *drops* (the larger founder kinds, which had more muscle, die out and the motes take over), then it rises at about 4 to 6% per simulated hour once the population is a single filter-feeding lineage; fin area roughly doubles and cruising effort halves. Selection is for **cheaper swimming at the same speed** (efficiency), not for faster swimming: realised speeds stay at 1.5 to 3 cm/s. In the rich world G4 the plankton was never limiting for long and there was almost no improvement. A clean 2-hour `tiny` run shows the same early dip (0.86 to 0.80).

### 3.3 Size, roles and diversity

| Run | Median length 0 h to end (mm) | Longest alive at end (mm) | Consumer biomass, mean (g) | Mean cap fill | Phenotype species S, end | Genotype species, end | Species ever founded | Roles with at least 5 members |
|---|---|---|---|---|---|---|---|---|
| A | 1.95 to 2.10 | 7.0 | 16.4 | 0.65 | 2.0 | 1.8 | 14 | 1 (filter) |
| B | 1.94 to 2.45 | 6.2 | 17.6 | 0.63 | 1.0 | 1.0 | 7 | 1 |
| C | 1.95 to 1.19 | 3.1 | 11.6 | 0.59 | 3.4 | 1.4 | 77 | 1 |
| D | 1.95 to 1.13 | 7.0 | 14.4 | 0.97 | 3.8 | 2.7 | 62 | 1 |
| G1 (x0.25) | 1.95 to 1.57 | 4.1 | 2.1 | 0.55 | 1.4 | 6.4 (13 at 12 h) | 181 | 1 |
| G4 (x4) | 1.95 to 2.76 | 8.7 | 76.1 | 0.76 | 1.0 | 1.0 | 5 | 1 |

- **Every run collapsed to one ecological role within hours**: phytoplankton filter feeders of 1 to 3 mm. The 5 mm scavengers were extinct by 8 to 10 minutes and the 2.5 cm hunters by 10 to 16 minutes in every run; the 1 cm grazer species held on for 3 to 8 hours. Brief scavenger and omnivore episodes (up to 160 creatures in G4 at 6 h) followed plankton crashes and did not persist.
- **Hunters starve before handling matters**: run P (handling time 5 s instead of 30 s) produced a `series.csv` byte-identical to A's. In A, B, C, D and P there were only 2 or 3 kills, all in the first minutes; sprint costs (about 7 B while a prey is in sight) and prey a thousandth of their own mass starve the hunters before handling time comes into play. (G1 logged 109 predation deaths, from short-lived omnivore offshoots; G4 none.)
- **Size (R2)**: nothing larger than 9 mm survived anywhere within 8 to 12 hours, and the median shrank under the cap pressure of D. `M_target` x4 raised consumer biomass 4.6 times and the largest survivor from 7 to 9 mm; x0.25 cut biomass 8 times and the largest to 4 mm. The size spectrum is set by generation speed and the founders here, not by the mass budget, at this time scale.
- **Species (R14)**: with only body-plan and diet genes, S stays at 1 to 4. With neutral markers included (genotype registry), the lean world G1 split into 13 "species" by 12 hours while its phenotype count was 2, and G1 founded 181 species over the run. This confirms the review: neutral genes in the distance inflate species counts under asexual drift, and the phenotype definition is the right one for budders.

### 3.4 Exploit detectors

| Run | Immortal blobs | Energy leaks | Microbe flood | Degenerate swimmers |
|---|---|---|---|---|
| A, B, G4, P (contract costs) | clear | clear | clear (flood condition in 0 to 10% of samples) | clear (worst out/in 0.28) |
| C (free immortality) | **fired at 7.9 h**: sessile share 0 to 99.6% between 6.5 and 10 h, LIFESPAN_MULT 4.0 to 6.6 | clear | clear | clear |
| D (multiplicative cap tax) | clear | clear | **fired at 1.0 h**, 100% of samples: cap full throughout, 99.8% of agents under 5 mm, median 1.11 mm, CLUTCH_SIZE 2.0 to 4.3 | clear |
| G1 (M_target x0.25) | **fired at 8.2 h**: sessile share 0 to 98% between 7 and 10 h | clear | clear | clear |
| tiny `--leak 1` | n/a (too short) | **fired at the first sample**: +3,600 quanta | clear | n/a |
| tiny `--thrust-bug 3` | clear | clear | clear | clear in 2 h (the bug needs fin area near 1; fins reached 0.09) |
| unit test: thrust bug with finny founders | | | | **fired**: out/in about 10 |

- **Immortal blobs (R10)**: with the pre-contract ageing (C), SENESCENCE did *not* walk to 0 within 12 hours (0.50 to 0.60) and LIFESPAN_MULT rose only to 6.6, far from 20: at 18 generations the trait drift is too slow to see the predicted walk. What did appear is the other half of R10, **the sessile filter blob**: in C and, importantly, also in the lean contract-cost world G1, attached filter feeders swept the population (sessile share above 98%), their potential swimming speed fell to zero, and LIFESPAN_MULT crept up. The contract's Holling ceiling and pumping cost did not prevent it where plankton was scarce. Caveat: the toy does not advect plankton, so a jet gives an attached filter feeder a free relative speed without depleting its water; the real sim's transport should make this less favourable, and the detector will tell.
- **Microbe flood (R11)**: the multiplicative surcharge filled the cap within the first hour and held it there for 12 hours, shrinking the median body to 1.1 mm and doubling clutch size; the additive fee (A, B) met the flood condition (cap above 90% and more than 80% of agents under 5 mm) in 0 to 10% of samples and the median at 2 to 2.5 mm. This is the review's prediction, measured.
- **Energy leaks**: none in any run; the deliberate bypass is caught on the first sample.
- **Degenerate swimmers**: the detector found a real bug in the toy's first integrator: thrust evaluated at the old speed let a microbe reach terminal speed in one step with up to 75 times the muscle work. It was fixed by solving the power-limited thrust implicitly at the new speed, which provably dissipates; afterwards the worst ratio of mechanical energy out to muscle work in was 0.28 in every run.

### 3.5 Tuning harness (skeleton check)

`evolab tune --preset tiny --hours 0.5 --seeds 1 --morris-r 2 --top 4 --cma-gens 3 --cma-pop 6`: 53 evaluations. Morris mu* over the 16 toy parameters: `b0Mult` 1.34, `jMaxBasal` 1.29, `aMaxPlant` 1.24, `theta` 0.06, everything else 0.01 or less (half-hour runs are too short for plankton, cycling, carcass and predation parameters to matter). CMA-ES over the top 4 raised the robust score from 0.89 to 0.99 in 3 generations, pushing `b0Mult` to its lower bound 0.3. The bands are easy to meet in half an hour; this run checks the machinery, not a tuned value.

## 4. Answer to the core question

**Within hours of simulated time, ecology happens and efficiency evolves, but nothing new evolves.** Measured on a crude toy with the contract's real metabolic constants:

1. **Pace**: 1 to 2 mm budders manage about 1.2 to 1.6 generations per simulated hour (a generation is about 40 minutes); 5 to 20 mm 0.75 to 1.4. Twelve hours is about 18 generations on average and 24 to 26 along the deepest lineage. The review's 1 to 2 minute microbe generation does not hold under the contract's Holling ceiling and assimilation.
2. **Swimming**: deliberately poor swimmers improve their size-free swim index by 17 to 25% over 8 to 12 hours, about 1.1 to 1.8% per generation, by growing fins (fin area about x2) and slimming; the gain buys cheaper cruising, not higher speed. It starts only after 2 to 4 hours, once the founder mix has collapsed to one lineage.
3. **Diversity**: low and falling. Every world became a single filter-feeding role within hours; predators and scavengers went extinct in minutes. Phenotype species stay at 1 to 4.
4. **Exploits**: the two the review feared most for the cap and the size spectrum appear quickly where the old rules apply: the multiplicative cap tax floods the cap with microbes within 1 hour; free ageing plus jets produce sessile filter blobs by about 8 hours, and so does a lean world under the contract's own rules. Energy leaks: none, and the detector catches a bypass at once.

For William's first week at 1x this means visible blooms and crashes, slow improvement in how microbes swim, and very little new form; the "Founding Waters" pre-evolved start (review R2) is necessary, and so is a food web that keeps predators alive from the first minutes.

## 5. Decision and proposals

No contract change is applied from this spike; it is a toy. Proposals, for the ecosystem engineer's `03-evolvability.md` and the integrator:

1. **Generation time**: decide whether 40 minutes per microbe generation at 1x is acceptable. If not, the cheapest lever is the Holling ceiling factor (`J_max` multiple of basal, 8 in CONTRACT 9.5) or `a_max.plant`; Morris ranks those two plus basal cost as the only influential parameters at the hour scale.
2. **Predators and scavengers need a viable start**: in this toy a 2.5 cm hunter on 2 mm prey cannot cover its sprint cost, and a pure detritivore with `a_max.det` 0.3 on food of `f` 0.3 cannot cover basal plus pumping. Templates (or the first tuning bands) should check that each founder role can break even on the food actually present.
3. **Sessile filter blobs**: watch for them in the real sim; if plankton transport does not remove the advantage, add a settlement cost or make filter intake deplete the upstream water.
4. **Keep the additive cap fee** (CONTRACT 9.6): measured here to prevent the flood that the multiplicative rule causes within an hour.
5. **Species for budders on the phenotype**: confirmed (3.3).
6. **Contract requests** filed in `docs/contract-requests/evolab.md`: a `WorldConfig.params` override map (so the tuning harness can drive the real sim), and creature columns `generation` and `workJ` (so the lab can measure generations and audit swimmers on the real SimCore).

What is next for the lab: run the same battery against the real SimCore through `tools/evolab/adapters/simcore.ts` as soon as bodies and the ledger land (the adapter already runs the phase-0 skeleton, test `tests/evolab-simcore.test.ts`), and longer toy runs (48 to 100 hours, several seeds) on an idle machine to see whether LIFESPAN_MULT and SENESCENCE walk to their bounds over 50 to 150 generations.
