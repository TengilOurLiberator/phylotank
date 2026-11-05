# src/gpu: the WebGPU compute backend (design notes)

Owner: gpu engineer, phase 1 (2026-11-05). Measurements: [docs/spikes/gpu-1.md](../spikes/gpu-1.md). Contract requests: [docs/contract-requests/gpu.md](../contract-requests/gpu.md).

## 1. What it is

The hot paths of the sim as WGSL compute kernels, behind the same interfaces as the CPU backend, for William's "as many creatures as possible" on the RTX 5090 (Dawn on Node in the host, `navigator.gpu` in a browser). The CPU backend stays the default and the oracle (host-2 §4); `selectBackend()` picks the GPU when an adapter exists and falls back to the CPU otherwise.

| File | Kernel or role | Equivalence with the CPU |
|---|---|---|
| `device.ts` | adapter and device acquisition (given GPU object, `navigator.gpu`, the Dawn Node binding from `PT_WEBGPU` or `import('webgpu')`), buffer helpers, explicit layouts | n/a |
| `wgsl/physics.ts`, `physics.ts` | full-tier integrator, one thread per creature: drag-augmented generalised mass with added mass and two-Gauss-point anisotropic drag, buoyancy, cilia, linearised muscles, implicit velocity solve, exact O(n) tree joint solve (Baraff), hard limits, walls, work, `powerW`, re-anchoring | f32 band (§3.1) |
| `wgsl/hash.ts`, `wgsl/scan.ts`, `hash.ts` | hierarchical spatial hash: count, multi-level exclusive scan, scatter, per-bucket order | exact (§3.2) |
| `wgsl/brain.ts`, `brain.ts` | batched CTRNN brain tick per size class: synapse sums, leaky integration, oscillators with couplings, Philox exploration noise, NaN guard, `oPrev := o` | f32 band (§3.3) |
| `wgsl/philox.ts` | Philox4x32-10 | exact |
| `wgsl/f64.ts`, `wgsl/transport.ts`, `transport.ts` | conservative transport: integer quanta fields with software binary64 for the CPU's two roundings; f32 signal fields | quanta exact, signals f32 band (§3.4) |
| `index.ts` | `selectBackend()`, `cpuBackend()`, the `SimBackend` shape | n/a |
| `bench.ts`, `bench-cli.ts` | benchmarks for the spike | n/a |

## 2. What runs where in one physics step

`createGpuPhysics(gpu).step(world, ctx)` follows `src/physics/index.ts` step for step:

1. passive drifters: CPU (`stepDrifters`, unchanged);
2. every live creature with segments that is not in a link island: **GPU**, one dispatch; upload of its columns, readback of positions, angles, velocities, `act`, `work`, the creature summary, `nSub`, `powerW`, plus `workJ` accumulated on readback;
3. link islands (grabs and latches solve their links inside the shared substep loop, R6): CPU, with the physics module's own phase functions;
4. watchdogs, contacts and bites, link pruning: CPU, in the same slot order.

Creatures do not interact inside step 2, so the order of the GPU threads does not matter. The CPU parts are bit-identical to the CPU backend. `GpuPhysicsEngine` can also keep the state resident (upload once, `run(k)` ticks, read back once), which is how the benchmark measures the kernel; with `uploadCommands()` only the brain commands go up each tick.

Options the kernel does not implement (`solver: 'gs'`, `diagnostics: true`) make `selectBackend()` return the CPU backend with that reason.

### 2.1 Layout and limits

- Seven storage buffers plus one uniform per pipeline (R23: at most 8 storage buffers per stage). Field-major arrays: field `f` of compact segment `g` is at `f * segCap + g`.
- Creatures are packed compactly in ascending slot order; segment `k` of creature `q` is `base[q] + k`. This order is what makes the hash exactly the CPU's `(bucket, slot)` order.
- Positions: an i32 Q16.16 anchor per creature plus f32 offsets per segment (02 §2.7.6). Re-anchoring at the end of each tick moves an exact multiple of 2^-16 m from the offsets to the anchor. Readback writes `anchor * 2^-16 + offset` into the f64 columns.
- Scratch: creatures of at most 16 segments keep the 70 working fields in private memory; larger creatures use a global scratch buffer (allocated only when one exists). Private scratch was 1.7x to 3.9x faster on lavapipe (spike §3.2).
- 3x3 inverses are Jacobi-scaled (`inv(M) = S inv(SMS) S`, `S = diag(|m_kk|^-1/2)`), so a 0.5 mm Purcell link (1e-9 kg, 1e-17 kg m^2) stays far from f32 underflow.
- Binding-size limit: lavapipe reports `maxStorageBufferBindingSize` 128 MiB. The global scratch (280 B per segment) would cap an engine at about 380,000 segments; with private scratch the largest buffer is `sst` (88 B per segment), about 1.2 million segments per engine with the 25% growth headroom. Larger worlds need two engines (or a split of `sst`).

### 2.2 Differences from the CPU integrator, by design

- f32 everywhere (WGSL has no f64): `sin`, `cos`, `exp`, `pow`, `log`, `tanh` are the platform's f32 functions, not `core/dmath`. This is allowed off the CPU path (02 §2.7.7: across GPUs and against the CPU, results agree statistically).
- The CPU's end-of-tick child shift (which compensates the f64 to f32 angle rounding) is not needed: GPU angles are f32 throughout, so storing them rounds nothing.
- The drag-work diagnostic (`diagnostics: true`) and the Gauss-Seidel solver are CPU-only.

## 3. Equivalence bands, and why

Bands are set at 10 to 100 times the largest error measured on the test scenes, and far below any physically meaningful scale. f32 unit roundoff is `u = 2^-24 = 6e-8`.

### 3.1 Physics (`tests/gpu-physics.test.ts`)

Scene: two fish (20 cm and 5 cm), a 0.6 m 12-segment fish, a three-segment cilia microbe (0.6 mm), a Purcell swimmer (0.5 mm links, Re about 1e-4), a passive 10-segment chain, in a sheared current, with sinusoidal commands.

| Quantity | Measured after 1 tick | Band, 1 tick | Measured after 60 ticks | Band, 60 ticks |
|---|---|---|---|---|
| segment position error / body length | 9.2e-8 | 1e-5 | 1.25e-5 | 1e-3 |
| segment angle error, rad | 4.8e-7 | 1e-4 | 1.75e-5 | (not banded) |
| substep count differences | 0 | 0 | 0 | (not banded) |

A second scene grows one adult of each of the 8 genome templates with `genome.develop` (fins, cilia, mouths, the templates' own joint limits and stiffnesses) and drives `cmd` and `cmd2` for 60 ticks: position error 1.8e-5 body lengths, angle 8.5e-5 rad, no substep differences, inside the same 60-tick band. A third runs the scene 30 ticks GPU-resident (re-anchoring and the rest history on the GPU, one download): 2.0e-6 body lengths.

Reasoning: one tick is 4 to 16 substeps of a direct solve whose rounding is a few `u` per operation, amplified by the conditioning of the drag-augmented system (largest for the low-Re swimmers); 1e-5 body lengths is 160 `u` and 100 times the measurement. Over 60 ticks the swimming gait is a driven, dissipative system, so errors grow roughly linearly (1.25e-5 after 60 ticks, about 2e-7 per tick); 1e-3 body lengths is 80 times the measurement and still below a hash cell or a contact margin. Longer runs diverge as any chaotic system does and are compared statistically, not per segment. Equal substep counts matter because `nSub` changes the discretisation: a mismatch would be a logic error, not rounding.

### 3.2 Spatial hash (`tests/gpu-hash.test.ts`)

Exact: cells, levels, buckets, the start table (length T + 1) and the item order, for 3,000 creatures (18,600 segments, a fifth of them crowded into a 1 cm square, so buckets hold many items and the multi-level scan runs two levels). The cell of an item is computed from the Q16.16 anchor in 64-bit integer arithmetic (`a * 1000 / 2^(16 + 2l)`) plus the f32 offset over the cell size, so it can differ from the CPU's f64 `floor(x / c_l)` only within about 1e-7 cells of a boundary; none did. The atomics' arrival order is erased by `bucket_sort`, which orders each bucket by item index.

### 3.3 Brains (`tests/gpu-brain.test.ts`)

Philox4x32-10: identical words for 65,536 counters. The brain tick, 69 brains of three body plans with randomised weights and biases, a third of them exploring (Philox noise):

| Quantity | Measured, 1 tick | Band | Measured, 60 ticks | Band |
|---|---|---|---|---|
| neuron output `o` | 1.2e-7 | 1e-5 | 5.0e-6 | 1e-3 |
| muscle commands `cmd`, `cmd2` | 9.6e-8 | 1e-5 | 5.0e-6 | (follows `o`) |
| NaN resets | equal | equal | equal | equal |

`tanh` and `sin` in f32 differ from `core/dmath` by a few `u`; the state is bounded (|y| <= 8, |o| <= 1) and leaky, so errors stay small. Plastic brains (ABCD rule) run on the CPU path inside `GpuBrain.think`.

### 3.4 Transport (`tests/gpu-transport.test.ts`)

`transportQ`: **bit-identical** on three grids (128 x 72, 256 x 144, 64 x 36 with 1, 3 and 14 substeps), quanta from 0 to 1e13 per cell, with and without a settle sink; settled quanta per cell equal; total mass conserved exactly. Each outflow is `floor(qi * x + dd)` with the same two binary64 roundings as the CPU, done in WGSL integer arithmetic (`wgsl/f64.ts`); the dither is the same Philox word and `fmix32`, the golden-ratio rotation is the same binary64 addition. `transportF` (f32 signal fields): max absolute error 3.6e-7 on a field of magnitude 2 after 3 substeps; band `1e-6 * max(1, |q|) * sub`.

The outflow fractions come from the ecosystem's own `prepare` (once per 2 Hz pass on the CPU, shared by every field on that grid), so the GPU reproduces the transport given the same fractions. Porting `prepare` needs a software f64 divide; not done.

## 4. The selector and the skip guard

`selectBackend({ prefer, physics, module, gpu })`: `'cpu'` forces the CPU; otherwise the GPU when an adapter exists and the options are supported, else the CPU with the reason (`no WebGPU adapter`, `gpu requested but no WebGPU adapter: CPU fallback`, `physics options need the CPU solver`, or a pipeline failure). It never throws for a missing GPU.

Tests use `tests/gpu-helpers.ts`: `gpuContext()` resolves to null when no adapter exists (no `webgpu` package, or no Vulkan ICD), and the GPU suites `describe.skipIf(!gpu)`. `PT_GPU=0` forces the skip. The selector's fallback tests always run, with a fake GPU object whose `requestAdapter` returns null.

Running the GPU tests locally (lavapipe, as in docs/spikes/host-2.md, files copied into the git-ignored `bench/local/`):

```sh
export LD_LIBRARY_PATH=$PWD/bench/local/lvp/root/usr/lib/x86_64-linux-gnu VK_ICD_FILENAMES=$PWD/bench/local/lvp/lvp_local.json
npx vitest run tests/gpu
```

## 5. Lessons

- Dawn's Node binding tears down its instance when the `GPU` object from `create()` is garbage-collected, even while a device made from it is alive; the next call aborts the process (`std::system_error`, or a futex error). `GpuContext` keeps the `GPU` object.
- `active` is a reserved word in WGSL.
- `layout: 'auto'` drops bindings an entry point does not use, so two entry points sharing one bind group need an explicit layout (`explicitLayout`).

## 6. Not done, next

- Device loss: `GpuContext.lost` resolves with the reason; `tests/gpu-select.test.ts` shows recovery by a fresh `selectBackend()` (a new adapter; the old one is consumed) and a re-upload from the World on the next step. Nothing yet does this automatically inside a running host.
- Contacts on the GPU (find, Jacobi solve with i32 accumulators), perception queries on the hash, metabolism, `prepare` on the GPU, the reduced tier.
- Residency across modules: the brain kernel writes `cmd` into the physics buffers, physics feeds the hash in place (done), the ecosystem reads `powerW`. Today each module round-trips through the World columns, which costs more than the kernels on lavapipe (spike §3.2).
- Workgroup-per-batch integrate (02 §2.10.1) for big creatures, instead of one thread per creature.
