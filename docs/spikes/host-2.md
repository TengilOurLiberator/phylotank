# Spike 2: Dawn on Node (host)

Owner: host. Review findings: R12, R17. Contract section 17 row 2.

## 1. Question

Can the host move its hot loops to WebGPU compute through Dawn's Node binding (the `webgpu` npm package), and what does that cost per tick? The answers decide:

- whether the host moves to GPU kernels at all (05 §5.1.3, stage S1);
- the readback latency behind the fixed 2-tick birth list (05 §5.5.1) and per-client stream readbacks (05 §5.3.3);
- the birth batching interval (R12);
- whether the duty-cap controller can trust `timestamp-query` (R17);
- whether `device.lost` recovery is clean, and whether memory is stable.

## 2. Set-up

| Item | Value |
|---|---|
| Machine | cloud container, 4 vCPU Intel Xeon @ 2.10 GHz, 15 GB RAM, **no GPU**, no `/dev/dri` |
| OS | Ubuntu 24.04.5, Linux 6.18 |
| Node | v22.23.4 |
| Package | `webgpu@0.6.2` (published 2026-10-02), prebuilt `dist/linux-x64/dawn.node`, 21.5 MB |
| Software Vulkan | Mesa 25.2.8 lavapipe (`llvmpipe`, LLVM 20.1.2, 256-bit), from the Ubuntu `mesa-vulkan-drivers` and `libllvm20` debs, unpacked into `bench/local/lvp/` (no system install) and selected with `VK_ICD_FILENAMES` and `LD_LIBRARY_PATH` |
| Script | `src/host/spikes/dawn-node.mjs` (committed); raw JSON in `bench/local/out/` (git-ignored) |

The webgpu package is **not** a dependency of the repo. It was installed into the git-ignored `bench/local/dawn/` only.

```sh
mkdir -p bench/local/dawn && cd bench/local/dawn && npm install webgpu@0.6.2 && cd -
export LD_LIBRARY_PATH=$PWD/bench/local/lvp/root/usr/lib/x86_64-linux-gnu VK_ICD_FILENAMES=$PWD/bench/local/lvp/lvp_local.json
node --expose-gc src/host/spikes/dawn-node.mjs --webgpu bench/local/dawn --agents 16384 --ticks 5000 --soak-s 600 --losses 30
node --expose-gc src/host/spikes/dawn-node.mjs --webgpu bench/local/dawn --agents 131072 --ticks 2000 --soak-s 30 --losses 10
node src/host/spikes/dawn-node.mjs --webgpu bench/local/dawn --backend null --ticks 5000 --soak-s 5 --losses 3
```

The toy tick is one compute pass: integrate N motes with a hashed noise force, write a per-agent u32 hash, and append about 1 in 4096 agents to a "birth list" through an atomic counter (1,024 entries, 4 KB). The readback is that list, copied to a `MAP_READ` buffer and mapped. This is the shape of the per-tick birth readback in 05 §5.5.1, not the real sim.

## 3. Numbers

### 3.1 Does it load?

| Configuration | Result |
|---|---|
| `import('webgpu')` on Linux x64, no GPU | **loads**, in 3.6 to 4.6 ms; 43 globals |
| default adapter, no Vulkan driver installed | `requestAdapter()` returns `null` (Vulkan: "Found no drivers"); OpenGL and OpenGLES backends: `null` |
| `forceFallbackAdapter: true` | `null`: the prebuilt binary has **no SwiftShader** fallback |
| `backend=null` | an adapter (`null-backend`, 25 features); it validates and "runs" commands but executes no shaders, so it measures only binding overhead |
| with lavapipe on the loader path | adapter `llvmpipe: Mesa 25.2.8 (LLVM 20.1.2)`, architecture `software`; 20 features including `timestamp-query`, `shader-f16`, `subgroups`; `maxBufferSize` 4 GiB, `maxStorageBufferBindingSize` 128 MiB |

So: the npm package loads in a GPU-less Linux container, but needs a Vulkan ICD (lavapipe) to do real work. CI needs `mesa-vulkan-drivers`, exactly as 05 §5.8.2 planned.

### 3.2 Integer kernel exactness

The GPU per-agent hash of `(tick, index)` matched the CPU implementation for **16,384 of 16,384** and **131,072 of 131,072** agents (0 mismatches), supporting 05 §5.5.2's plan of exact integer kernels against the CPU oracle.

### 3.3 `mapAsync` latency and ticks per second (lavapipe)

"Serial" waits for each tick's own readback before the next tick (the worst case of R12). "Lag 2" consumes tick t's list at tick t + 2 with three staging buffers (05 §5.5.1). Times in milliseconds.

| Agents | Mode | Ticks | mapAsync or wait p50 | p90 | p99 | max | Whole tick p50 / p99 | Ticks/s |
|---|---|---|---|---|---|---|---|---|
| 16,384 | serial | 5,000 | 0.126 | 0.167 | 0.602 | 26.7 | 0.177 / 0.736 | 4,421 |
| 16,384 | lag 2 | 5,000 | 0.071 | 0.100 | 0.282 | 21.4 | | 7,540 |
| 131,072 | serial | 2,000 | 0.686 | 0.970 | 5.764 | 29.3 | 0.755 / 6.745 | 976 |
| 131,072 | lag 2 | 2,000 | 0.607 | 0.842 | 4.515 | 23.9 | | 1,178 |
| 16,384 (null backend) | serial | 5,000 | 0.009 | 0.018 | 0.053 | 8.0 | 0.030 / 0.142 | 20,537 |
| 16,384 (null backend) | lag 2 | 5,000 | 0.001 | 0.012 | 0.036 | 12.1 | | 19,708 |

Reading: on lavapipe the readback round trip is dominated by the CPU rasteriser doing the compute, not by Node's event loop. The null backend bounds the binding's own overhead at about 10 µs p50 and 50 µs p99 per `mapAsync`, so the event loop is not the problem R12 feared. The fixed 2-tick lag gains 1.2 to 1.7x throughput over serial waits. Rare stalls of 20 to 30 ms appear in every configuration (likely GC or the container's scheduler; not attributed).

### 3.4 `timestamp-query` resolution (lavapipe, 300 passes each)

| Agents | Dawn toggles | Pass time p50 | p99 | Distinct values | Raw timestamp granularity (gcd) |
|---|---|---|---|---|---|
| 16,384 | default | 196,608 ns | 2,621,440 ns | 11 | **65,536 ns** |
| 16,384 | `disable-dawn-features=timestamp_quantization` | 169,017 ns | 1,048,784 ns | 300 | **1 ns** |
| 131,072 | default | 655,360 ns | 1,441,792 ns | 14 | 65,536 ns |
| 131,072 | quantisation disabled | 686,267 ns | 2,309,869 ns | 300 | 1 ns |

Dawn quantises timestamps to about **65.5 µs** by default, as R17 suspected. Passing `disable-dawn-features=timestamp_quantization` to `create()` removes it in the Node binding. A duty-cap controller working in milliseconds can live with 65 µs; sub-millisecond dispatch budgets ("no dispatch over 2 ms") want the toggle.

### 3.5 Device-loss recovery

| Agents | Cycles | Recovered | `lost` reason | `lost` resolves after `destroy()` p50 / max | New adapter, device, pipeline and first tick p50 / max | RSS growth over all cycles |
|---|---|---|---|---|---|---|
| 16,384 | 30 | 30 | `destroyed` | 1.4 / 4.2 ms | 12.7 / 284.8 ms | +52.3 MB (1.7 MB per cycle) |
| 131,072 | 10 | 10 | `destroyed` | 1.7 / 3.7 ms | 18.1 / 24.9 ms | +31.3 MB (3.1 MB per cycle) |

Findings:
- A `GPUAdapter` is **consumed** by its first `requestDevice()` (Dawn throws `OperationError: adapter is "consumed"`). Recovery must call `requestAdapter()` again; the first version of the spike failed exactly there.
- Recovery itself is quick and always worked. Only `destroy()`-induced loss was tested; a real driver reset (TDR) or sleep-resume cannot be produced in a container.
- RSS grew by about 1.7 to 3.1 MB per loss cycle even with `--expose-gc` and a forced GC at the end. That is a possible leak in the binding or in lavapipe; it is harmless for rare losses but should be re-measured on D3D12.

### 3.6 Memory soak (lavapipe, 16,384 agents, lag-2 ticks at full speed)

| Duration | Ticks | Ticks/s | RSS at 10 s | RSS at 600 s | Slope |
|---|---|---|---|---|---|
| 600 s | 4,092,156 | 6,820 | 270.6 MB | 272.7 MB | about 12.8 MB per hour (2.1 MB over 10 minutes) |

Heap used oscillated between 4 and 28 MB (normal GC sawtooth). 4.1 million ticks is about 38 hours of 1x sim time, so per tick there is no leak worth naming; the residual slope is within noise for a 10-minute run. **The 24-hour soak was not run** (time box); nor was a 24-hour soak at 1x pacing.

### 3.7 Timer granularity (R17, pacing)

On Linux Node: `setTimeout(1)` p50 1.17 ms, p99 4.1 ms (one outlier of 162 ms during the soak run); `setImmediate` p50 2 µs. The Windows figure (R17's 15.6 ms) still needs measuring on William's PC. The host's scheduler (`src/host/scheduler.ts`) paces by completion and drops backlog instead of relying on precise sleeps, so either granularity works.

### 3.8 Not measured here

- Dawn on Windows D3D12 with the RTX 5090 (prebuilt `win32-x64/dawn.node` exists in the package, 12.2 MB, with `dxcompiler.dll` and `d3dcompiler_47.dll` beside it): every number above is lavapipe on a 4-core VM and says nothing about the 5090.
- Spike 1's real kernels (the physics module owns them); requesting the 5090's maximum limits; D3D12 WARP in Windows CI.
- Deno: not installed in this container (`deno` absent; only `bun` is present, which has no WebGPU). The fallback remains untested.
- A 30 s soak on the null backend did not finish within 200 s, while 5 s runs did. Not investigated further; the null backend executes no shaders, so it is not a production path.

## 4. Decision

1. **Keep the CPU backend the default** for v0.x. It is the oracle, it is what every other module tests against, and nothing here is measured on the target GPU.
2. **Dawn on Node is viable as the GPU path** on the evidence available: it loads on Linux without a GPU, runs real compute on lavapipe, integer kernels are exact against the CPU, readback overhead from the binding is about 10 µs, `device.lost` recovery works, and there is no gross leak over 4 million ticks. Stage S1 may proceed **conditionally**; the go or no-go on Windows is a repeat of this script on William's PC (one command; see section 2).
3. **CI**: add `mesa-vulkan-drivers` to the `gpu-sw` job. Without an ICD, `requestAdapter()` returns `null` and there is no SwiftShader fallback in the npm build.
4. **Device loss**: the GPU backend must `requestAdapter()` again after a loss, never reuse the adapter.
5. **Timestamps**: create the instance with `disable-dawn-features=timestamp_quantization` for the duty-cap controller; otherwise assume 65.5 µs steps.
6. **Birth batching (R12)**: keep the fixed 2-tick lag. Readback latency is not the ceiling (on lavapipe the 2-tick lag ran 7,540 ticks/s at 16k agents, 250x real time); CPU-side development cost per birth will be. No contract change now; revisit the batching interval when spike 1's kernels run on the 5090.

Contract change proposed: **none**. The relevant constants (`ECO_EVERY`, the 2-tick lag in 05 §5.5.1) stand.
