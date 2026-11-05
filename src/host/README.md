# src/host: the sim host

Owner: host engineer. Design: [sections/05-architecture.md](../../docs/sections/05-architecture.md), as changed by DESIGN R6, R17, R18, R19, R20, R21, R22, R27, R29, R32 and [CONTRACT](../../docs/CONTRACT.md) §4.4, §12, §13, §14.1.

## Responsibilities

- Done in phase 1 (see [docs/modules/host.md](../../docs/modules/host.md)): static files from a manifest; Origin, Host and peer checks; localhost-only bind by default, LAN binding with token pairing; `/ws/v1` with HELLO/WELCOME, per-client interest management, the three LOD streams (BODY_ENTER/LEAVE/FRAME, DUST_FRAME, GLOW_FIELD), ENV, CENSUS, STATS, EVENT; flow control and freeze detection; god-command intake (validate, rate-limit, epoch check, lead time, journal, `god` events, `beforePower` snapshots, speed leases, manual snapshots, rewind); `.ptk` persistence with atomic writes and checksums, autosave and retention, chained migrations, crash recovery by journal replay with hash checks; throttle states behind an `OsProbe` interface; a journalled governor; host detectors (giant, record, endangered, extinction, massDeath, hunt, migration, school, carcass, frenzy); an optional Dawn loader and device manager; the CLI (`serve`, `inspect`, `replay`, `gpu-probe`, `--headless`).
- To do: releases and sim settings (contract request H2), the remaining detectors (outbreak, epidemicFront, bloomFront, newRole, novelty, speciation), lite snapshots and the GENO/SPEC/LINE sections, protocol 1.1 deltas, NEAR_POSE, INSPECT, FIELDS, GENOME_REQ, the Windows probes in the shell, mDNS.
- Later: the WebGPU backend through Dawn (spike 2 says viable, [host-2](../../docs/spikes/host-2.md)); the Tauri shell lives in `packaging/`.

## Interfaces

- Consumes: `core`, `genome`, `sim`. Serves `dist/`. Speaks only the CONTRACT 12 protocol.

## Review findings to address

- **R12**: the "night shift" lease; batched births.
- **R16**: governors at fixed tick boundaries, journalled.
- **R17**: spike 2 before any Dawn commitment; pace ticks by completion, not OS sleeps.
- **R19**: a power budget (NVML watts) as a throttle input; bursty ticks so clocks can drop.
- **R20**: no autostart or LAN binding in v0.1; portable zip.

## First tasks

Spike 2 (done: [docs/spikes/host-2.md](../../docs/spikes/host-2.md); Dawn on Node: `mapAsync` latency p50 and p99, timestamp resolution, sustained ticks with a per-tick readback, device-loss recovery, a 24-hour memory soak; lavapipe in CI; Deno as fallback) and spike 5 (GPU etiquette and power). Record in `docs/spikes/`.

## Acceptance tests

`tests/host.test.ts`; v0.2: 24-hour soak with a clean audit, kill-and-resume with matching journalled hashes, Yield within 6 s, wallpaper stream at most 3 MB/s; fuzzed `.ptk` reader never crashes.
