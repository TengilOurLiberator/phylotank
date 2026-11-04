# src/host: the sim host

Owner: host engineer. Design: [sections/05-architecture.md](../../docs/sections/05-architecture.md), as changed by DESIGN R6, R17, R18, R19, R20, R21, R22, R27, R29, R32 and [CONTRACT](../../docs/CONTRACT.md) §4.4, §12, §13, §14.1.

## Responsibilities

- Node host (`startHost`, in place): static files from a manifest, Origin and Host checks, `/ws/v1` with HELLO/WELCOME and the shared `SimSession`, capped inbound messages.
- To do: per-client interest management and LOD culling, BODY frames, flow control, tokens and scopes (view, god, paired LAN devices), the command pipeline (validate, schedule with lead time, journal, broadcast `god` events, `beforePower` snapshots), detectors (hunt, school, giant, outbreak and the rest of CONTRACT 11), persistence (`.ptk` writer and reader using `src/core/container.ts`, atomic writes, autosave cadence and retention, journal and replay), throttle states, governors (journalled, CONTRACT 4.4), the CLI (`serve`, `replay`, `bench`, `inspect`, `export`).
- Later: the WebGPU backend through Dawn if spike 2 passes; the Tauri shell lives in `packaging/`.

## Interfaces

- Consumes: `core`, `genome`, `sim`. Serves `dist/`. Speaks only the CONTRACT 12 protocol.

## Review findings to address

- **R12**: the "night shift" lease; batched births.
- **R16**: governors at fixed tick boundaries, journalled.
- **R17**: spike 2 before any Dawn commitment; pace ticks by completion, not OS sleeps.
- **R19**: a power budget (NVML watts) as a throttle input; bursty ticks so clocks can drop.
- **R20**: no autostart or LAN binding in v0.1; portable zip.

## First tasks

Spike 2 (Dawn on Node: `mapAsync` latency p50 and p99, timestamp resolution, sustained ticks with a per-tick readback, device-loss recovery, a 24-hour memory soak; lavapipe in CI; Deno as fallback) and spike 5 (GPU etiquette and power). Record in `docs/spikes/`.

## Acceptance tests

`tests/host.test.ts`; v0.2: 24-hour soak with a clean audit, kill-and-resume with matching journalled hashes, Yield within 6 s, wallpaper stream at most 3 MB/s; fuzzed `.ptk` reader never crashes.
