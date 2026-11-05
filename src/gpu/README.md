# src/gpu: the WebGPU compute backend

Owner: gpu engineer. Design notes: [docs/modules/gpu.md](../../docs/modules/gpu.md). Spike: [docs/spikes/gpu-1.md](../../docs/spikes/gpu-1.md). Contract requests: [docs/contract-requests/gpu.md](../../docs/contract-requests/gpu.md).

## Responsibilities

- Device acquisition (Dawn on Node through the npm `webgpu` package, `navigator.gpu`, or a given `GPU` object) and the backend selector `selectBackend()`, which falls back to the CPU backend when no adapter exists.
- WGSL kernels behind the same interfaces as the CPU backend: the full-tier physics integrator, the hierarchical spatial hash, the batched CTRNN brain tick, field transport; Philox4x32-10 and a software binary64 for exact integer work.
- Benchmarks (`bench.ts`, `bench-cli.ts`) for the 5090 go or no-go.

## Interfaces

- `selectBackend(opts): Promise<SimBackend>`, `cpuBackend(reason)`; `createGpuPhysics(gpu)` (an `AsyncPhysicsModule`), `GpuPhysicsEngine` (resident state), `GpuHash`, `GpuBrain.think(world, ctx)`, `GpuTransport.transportQ/transportF`.
- Consumes: core, physics (solver phases, bodies, links, contacts, watchdog), brain (`actBrain`, `tickBrain`, pools), ecosystem (`transport.ts` types and `prepare`).

## Status (phase 1)

- Tests (`tests/gpu-*.test.ts`, skip without an adapter; the selector tests always run): physics within the bands of docs/modules/gpu.md §3, resident ticks, hash exact, Philox exact, brains within band, software f64 exact on 65,536 cases, quanta transport bit-identical, f32 transport within band, selector fallback, device-loss recovery.
- Not done: contacts, perception, metabolism and `prepare` on the GPU; residency across modules; the reduced tier; automatic recovery inside a running host (the test shows the manual path).
