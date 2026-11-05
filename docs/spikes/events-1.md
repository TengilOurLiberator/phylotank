# Spike events-1: detector cost, detectors on a real-genome world, protocol 1.1 bandwidth

Date 2026-11-05, branch `mod/events`. Machine: the shared 4-core build container, with other engineers' jobs running (load average 11 to 19 throughout), so wall-clock numbers are pessimistic; the cost bench uses process CPU time, which other jobs disturb less. Every number below was measured by the commands named; none is estimated.

## 1. Detector cost per tick

`node events-bench.mjs staged` (bundle of `tests/events-bench.ts`): full tanks of fallback motes, with something for every detector to do (200 corpses of 5 cm, 600 infected, diets on everyone, all adults, a plankton patch added half way). The suite runs once per second of sim time (every 30 ticks); 100 runs after 20 of warm-up. CPU ms per run, and amortised per tick:

| Detector | Small, 4,000 | Default, 8,000 | Large, 8,000 |
|---|---|---|---|
| shared scan | 1.14 ms (38 us/tick) | 2.45 ms (82 us/tick) | 2.38 ms (79 us/tick) |
| carcass and frenzy | 0.23 (7.7) | 0.16 (5.3) | 0.10 (3.5) |
| migration | 0.006 (0.2) | 0.006 (0.2) | 0.009 (0.3) |
| bloom and bloomFront | 0.36 (11.9) | 1.39 (46.4) | 1.56 (52.1) |
| records | 0.17 (5.6) | 0.36 (11.9) | 0.34 (11.3) |
| novelty | 0.08 (2.8) | 0.15 (5.1) | 0.19 (6.4) |
| outbreak and epidemicFront | 0.22 (7.4) | 0.20 (6.6) | 0.20 (6.7) |
| newRole | 0.29 (9.7) | 0.64 (21.4) | 0.76 (25.3) |
| lineage | 0.004 (0.1) | 0.005 (0.2) | 0.006 (0.2) |
| **total** | **2.5 ms/run, 84 us/tick** | **5.4 ms/run, 179 us/tick** | **5.6 ms/run, 185 us/tick** |

Worst single runs (max): 6 ms (Small scan, a GC pause), 11 ms (Large newRole, once). The vitest version of this test (`tests/events.test.ts`, wall clock, same staging, 40 runs) gave 0.27 to 0.76 ms/tick on Small and 0.80 ms/tick on Default depending on the machine's load; it asserts under 2 ms/tick.

Before bounding the bloom sweep, Large cost 6.3 ms/run for bloom alone (one pass over 2.36 M fine cells); the sweep now sums at most one Default grid (589,824 cells) per run and judges the blocks once per full sweep (every 4 s on Large), which brought it to 1.56 ms/run.

What bounds each one: the scan is O(N) once for everyone; carcass work is capped at 256 candidates (biggest first), so the corpse-flood test (2,500 small corpses) costs a filter and a sort; novelty describes at most 32 new genomes per run against an archive of at most 512; outbreaks follow at most 64 (strain, host) pairs; species-keyed maps are capped (512 to 4,096).

## 2. On a world with the real genome module

`node events-bench.mjs 600` (and 1800): `createSim({ genome })` (real genome, fallback physics, brain and ecology), Small, 200 motefly, 40 meadowlamp, 20 hushmaw, 40 sievebell founders. First 10 minutes of sim time (18,000 ticks, 2,650 alive at the end):

- events: `lineage:founded` 12, `lineage:radiation` 1, `novelty` 6, `frenzy` 10 starts, 11 updates, 8 ends, `carcass:start` 1;
- novelty plans reported (the `plan` caption text): "14 parts, 6 eyes, 1 mouth"; "9 parts, 2 eyes"; "9 parts, 1 eye, 1 mouth, 1 shell"; "64 parts, 1 mouth"; "9 parts, 1 eye, 1 mouth, 6 photophore"; "11 parts, 2 eyes, 1 mouth, 5 lateral line, 2 paired" (species 2), all against an archive seeded by the founders;
- cost per run (wall, loaded): scan 0.76, carcass 0.09, migration 0.02, bloom 0.62, records 0.31, novelty 0.34, outbreak 0.26, newRole 0.74, lineage 0.02 ms, about 3.2 ms/run or 0.1 ms/tick.

Six novelty events in the first ten minutes is above the target of two an hour: a young world is full of new plans, and the threshold rose by only 10% per early event. It now rises by 25% (decision in docs/modules/events.md); see section 4 for the 30-minute run.

Records, migrations, blooms, outbreaks and new roles did not fire in this world, as expected: the fallback brain does not migrate, the fallback ecology has no disease and no predation, the producers do not form patches, and no size record holder changed by 5% after the warm-up. Their staged tests cover them (`tests/events.test.ts`).

## 3. Protocol 1.1 bandwidth, before and after

`tests/events-protocol.test.ts`, fallback world, Small, frames at 15 Hz, keyframe every 2 s:

| Stream | Bodies | 1.0 (keyframes only) | 1.1 (deltas) | Ratio |
|---|---|---|---|---|
| every live creature, whole tank then a slow pan, 30 s | 1,498 | 222.6 KB/s | 82.8 KB/s | 37.2% |
| host `InterestStream`, whole tank as bodies, 8 s | 600 | 89.4 KB/s | 30.4 KB/s | 34.0% |
| synthetic random walk (jittery headings, glow and bend changing every frame, slots leaving), 300 frames | 200 | | | under 75% (asserted) |

Per body per frame (1,498 bodies, 15 s, a scratch run with node zlib): keyframe 10.13 B, deflate-raw level 1 7.16 B; delta 3.59 B, deflated 2.32 B. 05 §5.3.4 estimated "about 3.5 B before zstd, about 2.5 B after". Slot classes in the 30 s run: 2,960 predicted, 648,670 residual, 0 full, 870 absent: the fallback brain changes heading by one to four 1.4-degree steps on most frames, so almost every body costs the mask byte, one byte of nibble position residuals and a heading byte. A still creature costs nothing but its two class bits (tested).

Every delta stream in the tests decodes to exactly the records of the parallel 1.0 keyframe stream (host and dream-tank session included), so a 1.1 view sees the same tank as a 1.0 view.

## 4. Thirty minutes on the real-genome world

See the end of this file (filled in from `node events-bench.mjs 1800` after the threshold change).
