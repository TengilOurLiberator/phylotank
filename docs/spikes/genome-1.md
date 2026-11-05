# Spike genome-1: development and operator cost, cross-engine identity

## Question

README first task 2: `develop` for Blank and Motefly, the restage cost (target 3 µs) and full develop (target 20 µs, 01 §1.4.6). Also the README acceptance "same genome gives a bit-identical Phenotype in Node and Chromium". Contract values that depend on it: none directly; the numbers feed the sim's birth budget (review R12) and `MAX_PARTS`.

## Set-up

- Machine: the shared phase-1 container, 4 vCPU Intel Xeon @ 2.10 GHz, Node v22.23.4, Chromium 153.0.8010.12 (Playwright, headless). Ten other engineers were running at the same time: the load average was 15 to 32 on 4 cores during the runs, so wall-clock timings were 2 to 4 times inflated. The benchmark therefore reports **process CPU time per call, best of three runs of 20,000 calls** (`process.cpuUsage`), which removes most of the scheduling noise but not cache and hyper-thread contention. Treat the numbers as upper bounds.
- Commit: `3aef064` (src/genome as committed in phase 1).
- Commands:
  - `npx esbuild tests/genome-bench.ts --bundle --platform=node --format=esm --outfile=/tmp/genome-bench.mjs && node /tmp/genome-bench.mjs`
  - `NODE_PATH=$(npm root -g) node tests/genome-chromium.cjs`

## Numbers

CPU time per call, µs (last run, load average 32):

| Operation | Parts | µs | Target |
|---|---|---|---|
| develop Blank | 1 | 6.9 | 20 |
| develop Motefly | 9 | 20.6 | 20 |
| develop Tetherling | 8 | 16.9 | 20 |
| develop Hushmaw | 10 | 21.6 | 20 |
| develop Meadowlamp | 11 | 30.8 | 20 |
| develop Ashpicker | 12 | 29.0 | 20 |
| develop Sievebell | 15 | 28.5 | 20 |
| develop Deepcrown | 19 | 38.1 | 20 |
| develop, evolved genome (47 modules, 29 links, 8 parts) | 8 | 21.2 | 20 |
| restage Blank (`Restager.phenotype`) | 1 | 2.8 | 3 |
| restage Motefly | 9 | 6.7 | 3 |
| restage Meadowlamp | 11 | 9.1 | 3 |
| restage Deepcrown | 19 | 16.9 | 3 |
| mutate Meadowlamp at the default rate | | 12.6 | 5 |
| mutate, evolved genome (rate genes drifted up) | | 99.4 | 5 |
| crossover Meadowlamp x evolved | | 69.7 | 10 |
| distance Meadowlamp vs evolved | | 11.6 | 1.5 |

An earlier run at load average 15 gave 14.6 to 39.1 µs for develop, 2.3 to 14.8 µs for restage, 11.9 µs for mutate and 11.0 µs for distance, so the table is stable to about 20%.

What the first version cost, and what changed it (same machine, wall clock, so only the ratios matter): develop Blank 33 µs and Deepcrown 92 µs, restage Deepcrown 49 µs. Scratch buffers instead of per-call arrays, 256-entry decode tables for the u8 log fields (built once with dmath), one `ArrayBuffer` per Phenotype holding every per-part array, decoding the trait block once per unfold, and caching the rest-angle trig on the unfolded body brought them down by 3 to 5 times. The remaining cost of `finish` is the organ list (one object per organ) and the f64 to f32 stores; a further 2 to 3 times would need a struct-of-arrays organ list, which changes `OrganSpec` (contract) and is not worth it before the sim measures its birth rate.

Cross-engine identity: a probe that develops every template at three maturities, then runs 300 mutate and crossover steps (mutation rate x6), hashing every genome, every phenotype (all typed arrays plus the scalars) and every distance, gave the same 64-bit digest in both engines:

```
node v22.23.4: feb5b0d74e77fcd0
chromium 153.0.8010.12: feb5b0d74e77fcd0
bit-identical
```

Side finding (bloat): the "evolved" genome above is Meadowlamp after 400 unselected births at 4x the default rate: 47 modules (the cap is 48) but only 8 expressed parts. Without selection, duplication and addition outrun deletion and silent genes pile up; spike genome-3 sees the same (5 to 44 modules in 800 neutral generations). 01's replication cost per genome byte is missing from the contract (contract request G9).

## Decision

- No contract change from the timings. At the review's 1,700 births per second, 40 µs per develop plus 15 µs per mutation is about 9% of one core; restages at about 50,000 per second would cost 0.5 to 0.8 cores at today's 10 to 17 µs, so the sim should restage only at the contract's 4% length steps and spread them across ticks.
- Cross-engine bit identity holds; `tests/genome-chromium.cjs` is the check to run in CI next to the e2e smoke test.
- Request G9 (replication cost) so that bloat is selected against.
