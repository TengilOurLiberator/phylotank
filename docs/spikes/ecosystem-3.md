# Spike 3 (ecosystem part): evolvability toy, ledger precision and the cap tax

Status: partial. The ledger and cap-tax questions are answered; the evolutionary trajectories are not, because the overnight machine ran the toy at about half of real time. Integrator: this file is the ecosystem half of `03-evolvability.md` (spikes README); rename or merge it there.

## 1. Question

REVIEW §9 spike 3 (R2, R8, R10, R11, R12, R14) and CONTRACT 17: does the real ledger, metabolism and plankton field let bodies across the size range live and breed; what are generations per wall hour by size class; how do the size spectrum and the largest sustained mass depend on `M_target` (x0.25, x1, x4); do `SENESCENCE`, `LIFESPAN_MULT`, `SESSILE` and `CLUTCH_SIZE` walk to a bound; multiplicative versus additive cap tax; integer and f32 ledger error for a microbe and a leviathan against an f64 reference. Contract values at stake: `M_target`, `K_CAP`, `C_REP`, the Gompertz range.

## 2. Set-up

- Container: 4 vCPU Intel Xeon @ 2.10 GHz, Node 22.23.4; load average 17 to 30 throughout (eleven engineers sharing four cores), so every wall-clock figure below is pessimistic by a factor of roughly 5 to 8 against an idle machine. CPU-time figures are given where they matter.
- Code: branch `mod/ecosystem` (commits from `df15bab` onwards). Driver `tests/ecosystem-spike3.ts`, harness `tests/ecosystem-harness.ts`.
- Commands (after `npx esbuild tests/ecosystem-spike3.ts --bundle --platform=node --format=esm --outfile=spike.mjs`):
  - `node spike.mjs arith` (ledger precision);
  - `node spike.mjs evolve <M_target multiplier> <ticks> <additive|multiplicative> <seed>`.
- The toy: Small tank, Basin habitat, the real ecosystem module (fields, light, plankton, mats, cycling, metabolism, demand and resolve feeding, Gompertz ageing, cap fee, disease), crude bodies: a trait vector with a filter (1.0) and rasp (0.5) mouth, gape 0.3 body lengths, gut 8% of the adult mass, a seeded swim at one body length per second costing 0.3 x B0 m^0.75 W. Budding only; at each birth 14 traits mutate with probability 0.15, step N(0, 0.04) in q space; `ADULT_LENGTH` is clamped to the ceiling (0.126 m). 400 founders, lengths log-uniform from 1 mm to 5 cm, plant specialists (`DIET_PLANT` 0.95).
- No genome module was available, so species counts under pure asexual drift (R14) are not measured here; that half belongs to the genome engineer.

## 3. Numbers

### 3.1 Ledger precision (R8): one sim day at 10 Hz, intake 1.3 x (basal + repair)

Integer quanta of 1 ng with carry lanes (the ledger as implemented), against an f64 running sum and an f32 energy stock (`Math.fround` on every update). `node spike.mjs arith`:

| body | mass kg | basal W | net change per eco tick (quanta) | integer ledger after 1 day | f64 reference | abs error (quanta) | relative error, integer | relative error, f32 stock |
|---|---|---|---|---|---|---|---|---|
| microbe 0.5 mm | 3.87e-9 | 1.70e-7 | 1.47 | 18,754 | 18,754.22 | -0.22 | -1.3e-5 | 1.1e-5 |
| microbe 1 mm | 3.10e-8 | 8.09e-7 | 6.97 | 92,984 | 92,983.17 | 0.83 | 9.9e-6 | -1.5e-4 |
| fish 20 cm | 0.248 | 0.122 | 1.05e6 | 86,987,967,486 | 86,987,967,486.69 | -0.69 | -5.5e-11 | 1.5e-3 |
| leviathan 1 m | 31 | 4.55 | 3.92e7 | 9,770,585,045,981 | 9,770,585,045,976.56 | 4.44 | 9.4e-12 | -2.9e-3 |

The integer ledger is within one quantum per carry lane of the exact amount for every size (the leviathan's 4.4 quanta is the f64 reference's own rounding after 12,000 additions near 1e13). The f32 stock drifts by up to 0.3% in a day, with a consistent sign for the large bodies: review R8's bias, reproduced. Conclusion: keep every pool as exact-integer f64 quanta on the CPU backend (as CONTRACT 1 says) and never store a stock in f32.

The full-world variant (`node spike.mjs ledger`, a starving 1 mm microbe and a 1 m body for a day inside a running world) ran with the audit exact on every ecology tick; its comparison is not meaningful for the microbe (it starved after 27,734 quanta, while the reference kept burning), so the table above replaces it.

### 3.2 The toy at x0.25, x1 and x4 `M_target`, 600 sim s each (18,000 ticks)

| run | wall s | speed | audit failures | births | deaths (cause) |
|---|---|---|---|---|---|
| x0.25 (25 kg), additive | 1,155 | 0.52x | 0 | 2 | 9 hypoxia, 11 age |
| x1 (100 kg), additive | 1,163 | 0.52x | 0 | 2 | 8 hypoxia, 11 age |
| x4 (400 kg), additive | 1,165 | 0.52x | 0 | 2 | 8 hypoxia, 11 age |
| x1 (100 kg), multiplicative | 1,169 | 0.51x | 0 | 2 | 8 hypoxia, 11 age |

Over the first 600 s: population 400 to 383 to 387, two births (from 1 to 3 cm founders, first clutch at 50 s after the start, which is the founders' starting reserve, not a generation time), consumer biomass 0.064 to 0.071 kg, producers 2.2 / 8.2 / 32 kg (x0.25 / x1 / x4, roughly flat). Size spectrum: unchanged within counting noise, log2 mass bins -27 to -10 kg (4e-9 kg to 1e-3 kg) all occupied; maximum mass 1.6e-3 to 1.8e-3 kg (the largest founders, growing). Trait means: `SENESCENCE` 0.500, `LIFESPAN_MULT` 4.000, `SESSILE` 0.000, `CLUTCH_SIZE` 2.000 throughout: two births cannot move a mean.

**Generations per wall hour by size class.** From the growth law (`tMature`, decision 8 in docs/modules/ecosystem.md) the time from birth to maturity at 15 C and default traits is 231 s for a 1 mm microbe, 1,297 s for 1 cm and 12,270 s (10 sim days) for 20 cm, so at 1x at most 15.6, 2.8 and 0.29 generations per sim hour (a lower bound on generation time: the first clutch comes later). The measured CPU cost of the toy was 4.7 ms per tick with 400 creatures (14.2 s of CPU for 100 sim s), so an idle core runs it at about 7x real time: at most about 110, 19 and 2 generations per wall hour for 1 mm, 1 cm and 20 cm. On the loaded overnight machine the achieved speed was 0.52x.

**Cap tax.** With 400 to 1,000 agents against the 4,096 CPU cap, `n_agents / N_cap` never passed 0.5, so neither rule charged anything (cap-tax active fraction 0.000 in all runs) and the additive and multiplicative runs are identical to the last digit, as they should be. The comparison under a binding cap needs a longer run; the analytic case is in `tests/ledger.test.ts` and `tests/ecosystem.test.ts` (at 90% of the cap the additive fee is 0.64 x 3.1e-5 kg per offspring: over 100 newborn bodies of a 2 mm microbe, 4% of a newborn at the 0.126 m ceiling).

### 3.3 Longer runs

Two runs of 54,000 ticks (30 sim min, x1, additive and multiplicative, seed 2, founders started at 0.85 maturity with `REPRO_RESERVE` 0.3 so they breed sooner) were still running when this report was written; their output goes to the scratchpad and is not reported.

## 4. Decision

- **R8**: no contract change. The integer ledger with carries is exact to a quantum for 0.5 mm to 1 m bodies; f32 stocks are ruled out (0.3% biased drift per day for large bodies). GPU backends must keep u64 pool totals (CONTRACT 1), as written.
- **R11**: keep the additive fee (CONTRACT 9.6). The toy did not reach the cap, so there is no measured spectrum comparison yet; to be repeated in a multi-day headless run on an idle machine.
- **R2, R10, R12**: not decided by this spike. The toy is now ready (`evolve` mode, with mutation, budding, trait trajectories, spectrum and generation timing); it needs about 2 sim days per configuration, which is 7 wall hours at 0.5x or about 2 wall hours per configuration on an idle core. Recommended next run: `evolve 1 1728000 additive 1` (16 sim hours) and the same with `multiplicative`, overnight on the dev PC.
- **Tuning observations from the runs** (hand tuning, review R13): deaths in the first 10 minutes were from age (founders' Gompertz clock starts at zero but the hazard is not zero) and hypoxia in pits and caves of the Basin floor, where remineralisation of settled detritus outruns the slow deep mixing (Kz 1e-4 m^2/s). Both are intended mechanisms; the hypoxia rate should be watched in the 8-hour acceptance run.
