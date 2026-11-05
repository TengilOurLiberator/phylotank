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

`node events-bench.mjs 1800`: `createSim({ genome })` (the real genome module; fallback physics, brain and ecology), Small, founders 200 motefly, 40 meadowlamp, 20 hushmaw and 40 sievebell, 30 minutes of sim time (54,000 ticks, 2,167 alive at the end), with the final detector rules:

| Events in 30 sim minutes | Count |
|---|---|
| `lineage` founded, radiation, extinct, lineEnded | 29, 3, 9, 1 |
| `novelty` | 6 (all in the first 10 minutes) |
| `carcass` start, update, end | 18, 69, 4 |
| `frenzy` start, update, end | 89, 121, 84 |
| record, migration, bloom, outbreak, newRole | 0 |

Novelty plans reported, as their `plan` caption text: "14 parts, 6 eyes, 1 mouth"; "9 parts, 2 eyes"; "64 parts, 1 mouth"; "9 parts, 1 eye, 1 mouth, 6 photophore"; "11 parts, 2 eyes, 1 mouth, 5 lateral line, 2 paired" (species 2); "64 parts, 1 eye, 1 mouth, 20 jet" (organ names are now pluralised properly). The founders fill the archive first, so these are plans that mutation made. Six in the first ten minutes and none in the next twenty: a young world is full of new plans, the threshold rose with each early event (by 25% now; 10% in the first trial, which gave the same six) and then held.

Cost per run in this world (wall clock, loaded machine): scan 0.39, carcass 0.13, migration 0.01, bloom 0.38, records 0.15, novelty 0.15, outbreak 0.04, newRole 0.08, lineage 0.03 ms: 1.4 ms per run, 46 us per tick, against a sim step of 4.3 to 6.2 ms per tick.

Frenzies were tuned on this world. The first rule (crowd of 5 within max(0.2 m, 5 lengths), 3x the tank mean density, corpse at least min(0.1 L_ceiling, 4 x median adult)) gave 119 starts and 112 ends in 30 minutes: crowds at the threshold flapped. Two runs below half before an end, a 60 s cooldown per corpse and a corpse of at least max(0.05 L_ceiling, 4 x median adult) gave 100; comparing with the density of the surrounding ring instead of the tank mean gave 89. Nothing in this world eats carcasses (the fallback ecology lets them decay), and no module writes the `diet` columns yet, so these are crowds, not feeding: the final rule also requires three meat eaters among the crowd once any creature has a diet recorded, which would remove all of them. The director should weight `frenzy` by `feeding` until the ecosystem writes diets.

Records, migrations, blooms, outbreaks and new roles did not fire here, as expected: the fallback brain does not migrate, the fallback ecology has no disease, no predation and no diet EMA, the producers do not form patches, and no record holder was beaten by 5% after the warm-up. Their staged tests cover them (`tests/events.test.ts`).

## 3. Protocol 1.1 bandwidth, before and after

`tests/events-protocol.test.ts`, fallback world, Small, frames at 15 Hz, keyframe every 2 s:

| Stream | Bodies | 1.0 (keyframes only) | 1.1 (deltas) | Ratio |
|---|---|---|---|---|
| every live creature, whole tank then a slow pan, 30 s | 1,498 | 222.6 KB/s | 82.8 KB/s | 37.2% |
| host `InterestStream`, whole tank as bodies, 8 s | 600 | 89.4 KB/s | 30.4 KB/s | 34.0% |
| synthetic random walk (jittery headings, glow and bend changing every frame, slots leaving), 300 frames | 200 | | | under 75% (asserted) |

Per body per frame (1,498 bodies, 15 s, a scratch run with node zlib): keyframe 10.13 B, deflate-raw level 1 7.16 B; delta 3.59 B, deflated 2.32 B. 05 §5.3.4 estimated "about 3.5 B before zstd, about 2.5 B after". Slot classes in the 30 s run: 2,960 predicted, 648,670 residual, 0 full, 870 absent: the fallback brain changes heading by one to four 1.4-degree steps on most frames, so almost every body costs the mask byte, one byte of nibble position residuals and a heading byte. A still creature costs nothing but its two class bits (tested).

Every delta stream in the tests decodes to exactly the records of the parallel 1.0 keyframe stream (host and dream-tank session included), so a 1.1 view sees the same tank as a 1.0 view.

## 4. What this changes

- The detectors are cheap enough to run on the host's main thread at the CPU-backend cap: under 0.2 ms per tick of sim at 8,192 creatures on every preset.
- The 3 MB/s wallpaper budget (05 §5.3.5) has room for bodies: at 3.6 B per body per frame, 2,000 bodies at 15 Hz is about 105 KB/s before compression, against about 300 KB/s as keyframes.
- Two detectors wait on other modules for real data: `newRole` and the frenzy feeder rule need the ecosystem to write the `diet` EMA; outbreaks and epidemic fronts need disease. Both are tested on staged worlds.
