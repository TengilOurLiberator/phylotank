# Spike gpu-1: WebGPU kernels on lavapipe, and what they suggest for the RTX 5090

Owner: gpu. Date: 2026-11-05, phase 1. Design notes: [docs/modules/gpu.md](../modules/gpu.md). Script: `src/gpu/bench.ts` and `src/gpu/bench-cli.ts`; raw JSON in the git-ignored `bench/local/out/gpu-bench-{1,2}.json`.

## 1. Question

How many agents per tick do the WGSL kernels (physics integrate, spatial hash, brain think, field transport) handle, measured on the only adapter available here (lavapipe), and what is an honest method for estimating the same on William's RTX 5090?

## 2. Set-up

| Item | Value |
|---|---|
| Machine | cloud container, 4 vCPU Intel Xeon @ 2.10 GHz, no GPU (as host-2) |
| Load | **shared with other agents' jobs: load average 17 to 21 during both runs** (4 vCPUs), so every number below is from a machine giving this process perhaps a quarter of its cores, and run-to-run variation is up to 2x |
| Adapter | Dawn (`webgpu@0.6.2`, Node 22) on Mesa 25.2.8 lavapipe (llvmpipe, LLVM 20.1.2, 256-bit), copied from `/home/user/pt-host/bench/local/` into `bench/local/` |
| Limits | `maxStorageBuffersPerShaderStage` 8, `maxStorageBufferBindingSize` 128 MiB |
| Physics scene | n fish, 8 segments, 20 cm, held sinusoidal muscle commands, Large tank, no contacts; average substeps 4.0 (5.4 for the 16k and 64k scenes, which start differently spaced) |
| Brain scene | synthetic pools, every brain due, full synapse rows, every neuron exploring |
| Transport scene | all-wet grid, sinusoidal face fluxes, quanta to 1e9 per cell |

```sh
npx esbuild src/gpu/bench-cli.ts --bundle --platform=node --format=esm --outfile=bench/local/gpu-bench.mjs
export LD_LIBRARY_PATH=$PWD/bench/local/lvp/root/usr/lib/x86_64-linux-gnu VK_ICD_FILENAMES=$PWD/bench/local/lvp/lvp_local.json
PT_WEBGPU=$PWD/bench/local/dawn/node_modules/webgpu/index.js node bench/local/gpu-bench.mjs --out bench/local/out/gpu-bench-1.json
```

Timing is wall clock around `queue.submit` plus `onSubmittedWorkDone`, over 5 to 20 ticks after two warm-up ticks (GPU-resident state, nothing read back), except "round trip", which is the full `AsyncPhysicsModule.step` (upload from the World columns, kernel, readback, CPU watchdogs).

## 3. Numbers (two runs, minutes apart)

### 3.1 Device microbenchmarks

| | Run 1 | Run 2 |
|---|---|---|
| `copyBufferToBuffer`, 128 MiB, read + write | 2.87 GB/s | 2.67 GB/s |
| multiply-add chains, 65,536 threads | 2.39 GFLOP/s | 1.49 GFLOP/s |

The microbenchmark uses `x * a + b`; a first version with `fma()` gave 1.66 GFLOP/s, the same order.

### 3.2 Physics integrate (8-segment fish)

| Fish | Segments | GPU ms/tick, run 1 / run 2 | Fish per ms | CPU backend ms/tick (1 thread), run 1 / 2 | GPU vs CPU | Round trip ms/tick, run 1 / 2 |
|---|---|---|---|---|---|---|
| 256 | 2,048 | 9.0 / 9.1 | 28 | 34 / 101 | 3.8x / 11x | 19 / 17 |
| 1,024 | 8,192 | 33 / 37 | 28 to 31 | 156 / 267 | 4.7x / 7.3x | 75 / 100 |
| 4,096 | 32,768 | 114 / 261 | 16 to 36 | 672 / 1,093 | 5.9x / 4.2x | 331 / 472 |
| 16,384 | 131,072 | 806 / 1,165 | 14 to 20 | | | 1,139 / 1,793 |
| 65,536 | 524,288 | 3,222 / 4,264 | 15 to 20 | | | |

Throughput: 0.5 to 1.15 million segment-substeps per second. On this loaded VM about 1,000 eight-segment fish fit a 33 ms (30 Hz) tick on lavapipe. The round trip through the World columns costs 1x to 2x the kernel itself, which on a discrete GPU behind PCIe will be much worse: residency (state staying on the GPU between modules) is the next step, not faster kernels.

Private versus global scratch (same scenes, run 2; run 1 had unequal tick counts): 256 fish 9.1 vs 5.0 ms, 1,024 fish 37 vs 58 ms, 4,096 fish 261 vs 231 ms. An earlier quick run (unequal tick counts again, and this branch's own test suite running alongside) gave 4.7 vs 18.3 ms (256 fish) and 77 vs 135 ms (2,048). **Unresolved under this load**; private stays the default because on NVIDIA thread-local memory is interleaved across a warp (coalesced), while the global layout is strided by creature, and it removes the 280 B per segment buffer that would cap one engine at about 380,000 segments. The 5090 run decides (`globalScratch` is a switch).

### 3.3 Spatial hash build (count, three-level scan, scatter, bucket sort)

| Items | ms, run 1 / run 2 |
|---|---|
| 2,048 | 1.8 / 1.4 |
| 8,192 | 5.7 / 6.6 |
| 32,768 | 26 / 44 |
| 131,072 | 88 / 120 |
| 524,288 | 442 / 640 |

### 3.4 Brain think (synthetic, all due)

| Class (N x K) | Brains | ms/tick, run 1 / run 2 | Brains per ms | Synapses per s |
|---|---|---|---|---|
| C0 (16 x 8) | 4,096 | 8.1 / 12.7 | 322 to 504 | 4.1e7 to 6.5e7 |
| C0 | 32,768 | 78 / 124 | 265 to 423 | 3.4e7 to 5.4e7 |
| C2 (64 x 16) | 4,096 | 57 / 95 | 43 to 72 | 4.4e7 to 7.4e7 |
| C4 (256 x 16) | 512 | 23 / 29 | 17 to 22 | 7.1e7 to 9.1e7 |

### 3.5 Field transport, integer quanta (bit-identical to the CPU)

| Cells | GPU ms per substep, run 1 / 2 | CPU ms per substep (1 thread), run 1 / 2 |
|---|---|---|
| 36,864 (Default coarse) | 6.7 / 12.9 | 7.3 / 8.8 |
| 589,824 (Default fine) | 163 / 222 | 80 / 69 |
| 2,359,296 (Large fine) | 646 / 780 | 220 / 277 |

On lavapipe the GPU transport is 2x to 3x **slower** than the CPU: the software binary64 (`wgsl/f64.ts`) turns each outflow into a few hundred integer operations, which a CPU rasteriser runs poorly. On a real GPU integer throughput is about half the f32 rate, so this is the kernel that most needs measuring there, and the first candidate for a cheaper exact scheme (a contract change to fixed-point fractions would make it a few integer multiplies).

### 3.6 Exactness (from the tests, `npm test` with lavapipe)

Hash, Philox and quanta transport: bit-identical. Physics and brains: inside the bands of docs/modules/gpu.md §3 (largest measured error 1.25e-5 body lengths after 60 ticks; brain outputs 5e-6 after 60 ticks).

## 4. Extrapolation to the RTX 5090 (an estimate, not a measurement)

Nothing here ran on a GPU. Two methods, which roughly agree; both are stated so that the 5090 run can falsify them.

**Method A, roofline from counted traffic.** A count of the kernel source gives about 280 scratch and state accesses (1.1 KB) and about 500 flops per segment per substep, plus a few `sin`, `cos` and `sqrt`. The RTX 5090 has 1.79 TB/s of DRAM bandwidth and about 105 TFLOP/s f32 (vendor figures). Compute would allow about 2e11 segment-substeps per second at peak; even at 10% it is not the limit. If the private scratch spills to DRAM (likely: 4.5 KB per thread) at 60% of peak bandwidth, the kernel does about **1e9 segment-substeps per second**. Caches could make that 3x better and uncoalesced or amplified traffic 3x worse: range 3e8 to 3e9.

**Method B, lavapipe scaled by measured bandwidth.** The kernel ran at 0.5e6 to 1.15e6 segment-substeps per second against a measured lavapipe copy bandwidth of 2.7 to 2.9 GB/s. Scaling by 1,790 / 2.8 = 640 gives 3e8 to 7e8 per second. (Scaling by the f32 throughput ratio instead, about 50,000x, would give 3e10 to 6e10; method A says the memory system cannot feed that, so it is an upper bound only.)

**Estimate.** About 1e9 segment-substeps per second on the 5090 (range 3e8 to 3e9). An 8-segment fish at 4 to 5.4 substeps is 32 to 43 segment-substeps per tick, so:

| Budget per tick | Eight-segment fish (central) | Range |
|---|---|---|
| 4 ms (02 §2.12's physics share) | about 100,000 | 30,000 to 350,000 |
| 33 ms (the whole 30 Hz tick, physics only) | about 850,000 | 250,000 to 2.9 million |

The same methods for the other kernels: C0 brains about 2e5 to 5e5 per ms (method A: about 2.1 KB of traffic per brain; method B: 265 to 500 per ms x 640), so the DESIGN budget of 300,000 brains is about 1 ms; the hash about 0.5 to 1 ms for 524,288 items (method B; atomics and the bucket sort may do worse); transport of the Large fine grid (2.4 million cells) about 1 to 4 ms per substep (method B, very uncertain because lavapipe is compute-bound on the integer emulation).

What is **not** in these numbers: contacts (still on the CPU), metabolism, perception, the per-tick upload and readback through the World columns (which the round trip shows dominating already on lavapipe), Dawn's per-dispatch overhead (host-2 bounds the binding at about 10 µs per `mapAsync`), and occupancy effects of 1 thread per creature (100,000 fish is 100,000 threads, about 40% of the 5090's resident-thread capacity, which is enough to hide latency only if registers are not the limit).

**The go or no-go is one command on William's PC** (the npm `webgpu` package ships `win32-x64/dawn.node`; no Vulkan variables needed): the bench line in §2 with `PT_WEBGPU` pointing at that install. It prints the same JSON, including the microbenchmarks, so method B can be recalibrated and method A checked.

## 5. Decisions

1. Keep the CPU backend the default world setting (host-2 §4; `WorldConfig.backend` stays `'cpu'` until contract request G2). `selectBackend()` with `'auto'` takes the GPU when an adapter exists and falls back to the CPU with a reason otherwise.
2. Keep integer state exact on the GPU: the hash, Philox and the quanta transport are bit-identical, so the ledger audit stays exact whichever backend runs. Float physics and brains are banded (contract request G5).
3. Next work, in order of measured cost: residency across modules (the round trip already costs more than the kernel), contacts on the GPU, then a fixed-point transport fraction if the 5090 confirms that the software f64 is the slow kernel.
