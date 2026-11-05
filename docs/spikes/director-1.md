# Director spike 1: tick cost, replay speed and camera limits on recorded synthetic logs

The director and audio modules have no reviewer spike (CONTRACT §17). This spike answers the questions their acceptance tests depend on (06 §6.8.2 property 10, DESIGN "Director tick 2 Hz, under 1 ms").

## 1. Question

- Does one director tick (score, select, plan) stay under 1 ms at p99 with the StoryBook full (512 stories)?
- Can the director replay hours of events in Node fast enough for property tests over many seeds?
- Do the design's motion numbers (06 §6.2.6) agree with each other? (They do not; see 4.)

No contract value depends on the answers; they set the director's own parameters (docs/modules/director.md, decisions D3 and D6).

## 2. Set-up

- Machine: the shared phase-1 build box, 4 vCPU Intel Xeon at 2.10 GHz, Node v22.23.4. Load average 23 to 28 during the run (eleven engineers testing at once), so wall-clock percentiles are unreliable; the tick numbers are **process CPU time** (`process.cpuUsage`), which excludes preemption but includes GC threads.
- Commit: `c9dd0b0` plus the working tree of this branch at 01:09 UTC.
- Logs: seeded synthetic logs from `src/director/replay.ts` (seed 1): quiet reef (2 h), predator boom (1 h), god session (30 min), mixed (2 h), and a storm of 2,000 events per second for 4 s (hunts, speciations and schools) that fills the book with live stories.
- Command: a bundle of `scratchpad/spike.ts` (esbuild, `--platform=node`) run with `node`. It replays each log at 30 fps (speed 1) and then times 1,000 `decide()` calls and 3,000 60 Hz frames on the full book.

## 3. Numbers

Replays (one 30 fps frame per 1/30 s of wall time, events fed by tick):

| Log | Events | Shots | Idle | Glide / zoom path / dip | Captions | CPU (s) | Faster than real time |
|---|---|---|---|---|---|---|---|
| quiet reef 2 h | 4,648 | 40 | 97% | 38 / 1 / 1 | 9 | 1.72 | 4,194x |
| predator boom 1 h | 50,789 | 461 | 23% | 421 / 25 / 15 | 39 | 1.05 | 3,445x |
| god session 30 min | 4,439 | 151 | 1% | 139 / 0 / 12 | 36 | 0.49 | 3,711x |
| mixed 2 h | 45,907 | 790 | 11% | 709 / 35 / 46 | 106 | 1.27 | 5,651x |

Director tick with the book full (509 live stories):

| Measure | p50 | p90 | p99 | max |
|---|---|---|---|---|
| `decide()` CPU time (ms) | 0.285 | 0.413 | 0.705 | 1.149 |
| `decide()` wall time (ms), loaded box | 0.285 | | 18.4 | |
| one 60 Hz frame, CPU (ms) | 0.002 | | 0.327 | |

Before two optimisations the same tick took 0.62 ms at p50 and 6 ms at p99 (CPU): scoring every story's van Wijk travel cost (0.36 ms alone for 512 stories) and allocating per-tick candidate objects (GC). The fix is a two-pass score: the cheap upper bound S0 (everything except travel, which is at most 1) for every story, then the travel factor only for the 64 best upper bounds in descending order, stopping at the 0.6 S_best cut (D6); and pooled candidate slots.

Audio: rendering 120 s of the ambience with the offline renderer at 8 kHz takes 1.75 s of CPU.

## 4. Decision

- **Tick cost**: inside budget (0.7 ms p99 CPU on this box). `tests/director-cost.test.ts` gates p50 < 1 ms and p99 < 3 ms of CPU time; the wall-clock p99 is not gated because the shared box makes it meaningless.
- **Replay speed**: 3,400x to 5,700x real time, so the ten properties run over three seeds of all logs in about a minute.
- **Motion numbers**: the 06 §6.2.6 zoom path at `rho = 1.4` and `V = 0.8 /s` pans at up to `V / rho = 0.57` screen widths/s and zooms at up to `rho V / ln 2 = 1.6` octaves/s, against steady limits of 0.25 screen widths/s and 0.35 octaves/s. Decision D3: zoom paths may run at 2x the steady speed limits and 4x the acceleration limits; each path's duration is the largest of `S / V`, 3 s, and the times its peak rates and accelerations need under those limits; a path whose clamped, velocity-carrying course breaks them is flattened (`rho` 1.4, 0.7, 0.35) or replaced by a dip or a glide. No contract change.
