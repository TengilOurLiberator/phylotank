# 5. Architecture, persistence and platforms

This section decides where the simulation runs, how views see it, how the world survives reboots and crashes, and how Phylotank is packaged for Lively Wallpaper, the Windows screensaver, Google TV and the god-mode window. It confirms the brief's default architecture, with three refinements:

1. The host runtime is **Node.js with Dawn** (the `webgpu` npm package). It is not a headless browser.
2. A small **Rust shell** (Tauri v2) owns the Windows integration and supervises the host.
3. The sim core is **isomorphic**. The same TypeScript and WGSL run in the host, in a browser tab (standalone/demo mode) and on a pure-CPU reference backend used by the tests.

Population and memory figures here are planning budgets. The simulation and population sections own the final per-creature numbers. Where those sections set different figures, scale the budgets in this section linearly.

---

## 5.1 Decision: the simulation host

### 5.1.1 What actually costs time

The answer depends on where a tick spends its time. These are planning estimates; the phase 1 benchmark in 5.8 validates them.

| Per-creature cost per tick | Approximate size | Where it runs |
|---|---|---|
| Brain forward pass (about 1,500 synapses, f16 weights) | about 3 KB read, about 3k FLOP | GPU |
| Soft-body physics (about 16 nodes, 2 substeps) | about 0.5 KB read and write, about 2k FLOP | GPU |
| Senses through a spatial hash (about 32 neighbours) | about 1 KB read, about 2k FLOP | GPU |
| Births: mutation, crossover, growth recipe to body | about 50 µs each, only about 15 to 60 per tick | CPU worker |
| Speciation clustering, lineage bookkeeping | every 5 to 30 s, not every tick | CPU worker |
| Stream encoding, snapshots, compression | per client or per save | GPU pass plus CPU workers |

On an RTX 5090 (about 1.8 TB/s and about 105 TFLOPS FP32, from public specs and not measured here), memory bandwidth bounds the per-tick GPU work. A world of 1M creatures moves about 5 GB per tick, which takes about 3 ms in theory and 6 to 10 ms in practice. CPU-side host work grows with births, not with population, so it stays under 5 ms per tick even at 1M creatures. Because the WGSL kernels hold almost all of the cost, **the host language barely affects population.** It matters for development speed, packaging and testing.

### 5.1.2 Options compared

| Criterion | (a) TS on Node/Deno + Dawn | (b) Headless Chromium | (c) Rust + wgpu native, WASM fallback | (d) Sim in god window |
|---|---|---|---|---|
| Max creatures on a 5090 | ++ GPU-bound, the same WGSL as (c). GC and JS CPU-side cost are manageable with typed arrays | + the same kernels, but GPU-process IPC, background-throttling flags and less control over buffer limits | ++ best CPU side, the same GPU ceiling | + the same kernels, but competes with its own UI rendering |
| One persistent world for all views | ++ a long-lived process | + it still needs a sidecar for disk, sockets and tray, so two runtimes | ++ | -- the world only exists while the window is open. Chrome throttles hidden pages (rAF stops, timers clamp to at least 1 s, then to 1 per minute after about 5 minutes hidden) |
| Open source others can run | + `npx phylotank` on any OS with a prebuilt `dawn.node` | - Puppeteer pulls about 150 MB of Chromium, and headless WebGPU needs fragile flags | ++ one `cargo build` and a single 10 MB binary | ++ just a URL |
| Development speed | ++ one language for sim, views and editor. The creature editor reuses the growth code directly. Vite HMR | + the same language, but debugging happens through a headless page | - Rust sim plus TS views. The editor needs the growth code through WASM bindings. Slower iteration while tuning ecology | ++ |
| Testable in a GPU-less Linux container | + CPU reference backend, and Dawn on Mesa lavapipe (Vulkan on the CPU) | + SwiftShader in Chromium | ++ `cargo test`, and wgpu on lavapipe | + |
| Install footprint | about 70 MB (node.exe, bundle, dawn.node) | about 300 MB | about 10 MB | 0 |
| Main risk | the Dawn Node binding is younger than wgpu | throttling and flags change between Chrome releases | two-language overhead, and a smaller pool of alife contributors who know Rust | wrong product shape |

### 5.1.3 Choice: (a), with a staged path and a defined exit to (c)

**Pick (a): a TypeScript sim core hosted on Node.js (current LTS: Node 24, or 26 once it is LTS) using Dawn through the `webgpu` npm package.** Dawn's Node README says the npm `webgpu` package ships `dawn.node` prebuilt, built from `dawn-gpu/node-webgpu`, and the npm page lists Windows, Linux and macOS binaries ([Dawn node README](https://dawn.googlesource.com/dawn/+/e6d53ca5a4f9335e68bf64286ecd787ce82cc7e4/src/dawn/node/), [npm webgpu](https://www.npmjs.com/package/webgpu)). Reasons:

1. **The same shader compiler as the views.** Dawn's Tint compiles WGSL in the host and in Chrome, Edge and WebView2 (Lively, screensaver, god window). A kernel that runs in the host also runs in standalone browser mode, without a second compiler's quirks.
2. **One genome codebase.** The god window's part editor and gene sliders need the genome-to-body growth function for live preview. In (a) the editor imports the same module the host uses.
3. **Scale is not sacrificed.** See 5.1.1. The per-tick cost lives in WGSL, and WGSL ports unchanged to wgpu.
4. **A second runtime for free.** The host codes only against the standard WebGPU JS API (`navigator.gpu`-shaped, injected through a `GpuProvider`). Deno ships WebGPU built on wgpu ([Deno 1.39](https://deno.com/blog/v1.39)), and its typings left the unstable set in 2024. Whether it needs a flag in Deno 2 is **unverified**. A nightly CI job runs the host test suite on Deno, so a fatal Dawn binding problem would have a working fallback using a different WebGPU implementation.

**Rejected:**
- **(b)** It adds a 300 MB runtime and still needs a sidecar. Its only real advantage, identical runtime code, (a) already has through isomorphism. Headless Chromium is still used, but for view tests (5.8.3).
- **(d)** It fails "one persistent world". It survives as **standalone mode**: the GitHub Pages demo, and the zero-install way for strangers to try Phylotank. The world is small (5k to 20k creatures) and autosaved to IndexedDB.

**Staged path:**

| Stage | Contents | Exit criterion |
|---|---|---|
| S0 Prototype (in-page) | sim-core with the CPU backend, then sim-gpu, all inside one browser page with dev tools (mode d) | 10k creatures evolve, and the golden replay test passes |
| S1 Host MVP | Node + Dawn host, WebSocket streaming, `.ptk` persistence, wallpaper and god views in a normal browser | 24 h soak test without drift, crash recovery passes |
| S2 Windows integration | Tauri tray shell, Lively package, `.scr`, TV page, GPU etiquette | William uses it daily for 2 weeks |
| S3 Optional optimisation | Move hot CPU modules (development, speciation, snapshot codec) to Rust compiled to WASM, which runs in Node and the browser and keeps isomorphism | only if a trigger below fires |
| S4 Escape hatch | A native Rust + wgpu host reusing all WGSL and the protocol | only if a trigger below fires |

**Triggers for S3 or S4, measured at the target population on the 5090:** host CPU work above 8 ms per tick at p95 after profiling; GC pauses above 5 ms at p99 that cause missed ticks; or the Dawn Node binding being unbuildable or unmaintained for 3 months with Deno also unsuitable.

### 5.1.4 Population and resource budgets that follow

These planning targets assume about 5 KB of GPU memory per creature: 3 KB of genome (brain weights in f16, plus the body recipe), 1 KB of state, 1 KB of double buffer and indices.

| Machine and preset | Creatures | Plankton particles | VRAM | GPU time per tick | Sim speed 1x = 30 ticks/s |
|---|---|---|---|---|---|
| RTX 5090, **Default** | 250,000 | 4M | about 1.4 GB (cap 2 GB) | about 2 ms, so about 6% duty | yes, within the Ambient 15% cap |
| RTX 5090, **Big tank** | 1,000,000 | 8M | about 5.5 GB (cap 8 GB) | about 8 ms, so about 24% duty | yes in Watching. In Ambient it slows to about 0.6x |
| RTX 5090, **Unleashed** (manual) | up to 4M | 16M | about 22 GB | about 30 ms | about 1x at full duty. Not gentle; for experiments |
| Weak laptop (Iris Xe class, shared memory about 70 GB/s) | 10,000 to 20,000 | 500k | about 100 MB | about 3 ms | yes at 15 to 30 ticks/s |
| CPU fallback (4 workers, no WebGPU) | 2,000 to 5,000 | 100k | none | about 20 ms CPU | about 15 ticks/s |

WebGPU buffer limits shape the layout. The defaults are 256 MB for `maxBufferSize` and 128 MB for `maxStorageBufferBindingSize`. Genomes and state therefore live in **256 MB pages**, addressed as (page, offset). This runs unchanged on laptops at default limits. On the 5090 the host requests higher limits and uses fewer, larger pages.

---

## 5.2 Process model and the Windows start-up chain

### 5.2.1 Architecture diagram

```
 Windows user session (per user, not a service)
 +-----------------------------------------------------------------------------------+
 |                                                                                   |
 |  Phylotank.exe  (Tauri v2 shell, Rust, about 15 MB RAM)                           |
 |  +-----------------------------------------------------------------------------+  |
 |  | tray icon | god window (WebView2 -> http://127.0.0.1:47615/god)             |  |
 |  | OS probes: SHQueryUserNotificationState, foreground-window rect, NVML,      |  |
 |  |            power/battery, session lock, ComfyUI /queue (optional)           |  |
 |  | supervisor: spawn, health-check, restart with backoff                       |  |
 |  +-------------------------------+---------------------------------------------+  |
 |                                  | stdio, newline-delimited JSON (control only)   |
 |                                  v                                                |
 |  phylotank-host  (node.exe + host.mjs + dawn.node, 300 to 600 MB RAM)             |
 |  +-----------------------------------------------------------------------------+  |
 |  |  scheduler / throttle --> sim-gpu (WGSL) --> Dawn --> D3D12 --> RTX 5090     |  |
 |  |        |                     ^                                              |  |
 |  |        v                     | birth lists, readbacks (fixed 2-tick lag)    |  |
 |  |  workers: development | speciation | persistence (zstd, .ptk, journal,      |  |
 |  |           SQLite lineage) | per-client stream compression                   |  |
 |  |  stream server: GPU cull+quantise pass per client -> WS frames              |  |
 |  |  HTTP + WebSocket  127.0.0.1:47615   (LAN bind 0.0.0.0 only when enabled)   |  |
 |  +------+--------------+----------------+------------------+--------------------+  |
 |         | ws           | ws             | ws               | ws (LAN, token)       |
 |         v              v                v                  v                       |
 |  Lively Wallpaper  phylotank.scr     god window       Google TV / Chromecast      |
 |  (WebView2, loader (Rust + wry,      (Tauri or any    (Android TV WebView app,     |
 |   + iframe to      one WebView2      browser)          sideloaded browser, or a    |
 |   /wallpaper)      per monitor)                        Chrome tab cast from PC)    |
 |                                                                                   |
 |  %LOCALAPPDATA%\Phylotank\  worlds\  logs\  host.json  config.toml  WebView2\     |
 +-----------------------------------------------------------------------------------+
```

### 5.2.2 Why a tray app, not a Windows service

A service runs in Session 0. It cannot show a tray icon, cannot see the user's foreground window or fullscreen state, and has an awkward relationship with WDDM GPU scheduling for the interactive session. Phylotank is per-user by nature: the worlds live in the user profile and the views run in the user's desktop. So the design is a **per-user tray process** started at logon. No admin rights are needed anywhere. The installer is per-user NSIS, produced by the Tauri bundler.

The two-process split is deliberate. The shell is native, small and crash-proof, and does all Win32 work. The host is the TS sim. If the host crashes (a GPU device loss, an out-of-memory error, a bug), the shell restarts it, and the world resumes from the last snapshot plus the journal (5.4.4).

### 5.2.3 Start-up chain

1. **Logon.** `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Phylotank` = `"...\Phylotank.exe" --tray`, written by the Tauri autostart plugin and toggled in settings. The shell sleeps **20 s** after logon so it does not compete with the desktop's own start-up.
2. **Shell start.** Single-instance lock (a named mutex `Local\Phylotank`). It reads `%APPDATA%\Phylotank\config.toml` and loads or creates the tokens (5.9). It picks the port: 47615 by default (its IANA status is unverified), with the next free port on conflict. It writes `%LOCALAPPDATA%\Phylotank\host.json` = `{port, pid, startedAt, viewTokenLocal}` with a user-only ACL.
3. **Spawn the host** as a Tauri sidecar: `node.exe host.mjs --world <name> --port 47615 --state ambient`. The process gets `BELOW_NORMAL_PRIORITY_CLASS`, and EcoQoS through `SetProcessInformation(ProcessPowerThrottling)` while in the Background state.
4. **Host boot.** In order: open the world directory; verify the latest snapshot's checksums, falling back to the previous one on failure; apply migrations; replay the journal tail; request the adapter (`powerPreference: "high-performance"`) and the device with the needed limits; upload buffers; start the HTTP and WS server; tell the shell `{"ready": true, "tick": N}`. Target time from spawn to ready for the Default world: **under 4 s** (decompressing 230 MB takes about 1.2 s on 4 workers, uploading 1.4 GB takes under 0.2 s).
5. **Health.** The shell polls `GET /health` every 5 s. If the host exits or 3 polls fail, it restarts it after 1 s, 5 s, 30 s and then 120 s. After 5 crashes in 10 minutes it stops and shows a tray balloon with "Open log / Start in safe mode". Safe mode loads the previous snapshot with the CPU backend.
6. **Views attach independently.** Lively starts its own wallpaper at logon. Its loader shows a calm dark-water idle animation and retries the WebSocket with backoff (1, 2, 4, 8, then every 10 s) until the host answers. Views never start the host, except the screensaver (5.6), which starts the shell if it is absent.
7. **Shutdown.** The shell handles `WM_QUERYENDSESSION` and calls `ShutdownBlockReasonCreate("Saving your tank")`. It sends `{"cmd":"flush"}`, and the host writes a snapshot (about 1.5 s for the Default world). After 4 s the shell gives up, so it never blocks shutdown for long, and the journal still covers the gap (5.4.4).

### 5.2.4 GPU-sharing etiquette

William's 5090 also runs ComfyUI (PyTorch on CUDA, often 12 to 24 GB of VRAM) and games. Phylotank must be a polite guest. The shell measures the conditions and sends a **throttle state** to the host. The host enforces it with GPU timestamp queries: it measures GPU milliseconds per tick and sleeps between ticks to stay under the duty cap.

| State | Trigger (with hysteresis) | Sim speed | GPU duty cap | VRAM | Streaming |
|---|---|---|---|---|---|
| **Watching** | the god window, screensaver or a TV client is visible | 1x (30 ticks/s), user can set 0.25x to 4x | 35% | resident | full |
| **Ambient** | only the wallpaper is visible | 1x if it fits, otherwise it slows smoothly | 15% | resident | wallpaper budget |
| **Background** | no view visible (desktop covered, session locked, displays off) | 1x by default ("keeps evolving while you work"), configurable down to 0 | 10%, EcoQoS | resident | none |
| **Yield** | fullscreen app; another process using more than 30% GPU for 5 s; the ComfyUI queue is non-empty; or a listed process is running | 0 (frozen) by default, optional "trickle" of 0.1x at 2% | 2% or 0 | resident | stopped, except for the screensaver (below) |
| **Evicted** | Yield for more than 10 minutes, or free VRAM below 3 GB | 0 | 0 | snapshot taken to RAM and disk, GPU buffers destroyed | stopped |
| **Battery** | on battery power (laptops) | 0.25x | 5% | resident | reduced |

Detection details:
- **Fullscreen:** `SHQueryUserNotificationState` returns `QUNS_RUNNING_D3D_FULL_SCREEN`, `QUNS_BUSY` or `QUNS_PRESENTATION_MODE`. This misses borderless-windowed games, so the shell also checks whether the foreground window's rect equals its monitor rect and the window is not the shell, Explorer, or Phylotank's own window. It polls every 2 s, which is cheap.
- **Other GPU users:** NVML through the `nvml-wrapper` crate in the shell. `nvmlDeviceGetUtilizationRates`, `nvmlDeviceGetMemoryInfo`, and per-process utilisation where the driver exposes it, with our own host's PID excluded. On AMD or Intel the fallback is DXGI `QueryVideoMemoryInfo` plus fullscreen detection only.
- **ComfyUI:** an optional integration that is off by default. It polls `http://127.0.0.1:8188/queue` every 10 s. Running or pending items mean Yield. The endpoint path is from memory and must be verified.
- **Hysteresis:** the host enters Yield after 5 s of the trigger and leaves only after 30 s without it, so the tank does not flap during a game's loading screens.
- **Polite dispatches:** no single compute dispatch may exceed **2 ms** on the 5090 or 20 ms on a laptop. Long passes split into chunks, so a game's frame is never queued behind a long Phylotank job. This also keeps far below the Windows TDR limit (about 2 s), which would reset the device.
- **Eviction** saves VRAM for ComfyUI. It reads back the Default world's 1.4 GB to RAM (about 70 ms at 20 GB/s), destroys the GPU buffers, keeps the CPU copy, and re-uploads on resume.
- **Screensaver during Yield:** if ComfyUI is running a long overnight batch when the screensaver starts, the host runs "trickle" at 0.1x and 2% duty. The screensaver then shows a slowly moving but living tank instead of a frozen one.

Sim time never jumps to "catch up" after a pause. The world simply experiences less time. Wall-clock time never enters the simulation (5.5).

---

## 5.3 State streaming protocol

### 5.3.1 Transport: WebSocket now, WebTransport only if measured

- **WebSocket** with binary frames over HTTP/1.1, served by the host's own HTTP server (the `ws` package on Node).
- **WebTransport is not adopted.** It needs HTTP/3 with TLS, and Node had no stable HTTP/3 server when this was written (unverified for late 2026). Support in Android TV WebView builds is uncertain. Head-of-line blocking hardly matters on a LAN when the client interpolates with a 200 ms buffer.
- The framing is transport-agnostic, so a WebTransport datagram path can be added later. Trigger: TV clients on Wi-Fi showing more than 1% of frames late beyond the interpolation buffer.

### 5.3.2 Message set

Each WebSocket message carries one frame:

```
u8   type        // see table
u8   flags       // bit0 payload zstd-compressed, bit1 keyframe
u16  protoMinor  // protocol minor version; major is fixed by the URL path /ws/v1
u32  tick        // sim tick the data belongs to
...  payload
```

| Type | Direction | Encoding | Rate | Purpose |
|---|---|---|---|---|
| HELLO | C to S | CBOR | once | `{view: "wallpaper"\|"screensaver"\|"tv"\|"god", token?, caps: {maxBytesPerSec, maxBodies, maxDust, gpu: "webgpu"\|"webgl2"}, viewport}` |
| WELCOME | S to C | CBOR | once | world id, tick rate, habitat size, palette, species table, protocol schema hash, scopes granted |
| VIEWPORT | C to S | binary, 24 B | at most 10 Hz, on change | camera rect, zoom, device pixel size, `paused` flag |
| ACK | C to S | binary, 8 B | 2 Hz | last decoded tick (flow control and freeze detection) |
| BODY_ENTER | S to C | binary | on interest change | slot id plus a reference to the body descriptor (by 64-bit body hash). Sends the descriptor (about 180 B: up to 32 segments x 5 B plus a header) only if the client lacks it |
| BODY_FRAME | S to C | binary | 10 to 30 Hz | near-LOD records for all slots, keyframe or predictive delta |
| DUST_FRAME | S to C | binary | 5 to 10 Hz | far-LOD points, always a keyframe |
| GLOW_FIELD | S to C | u8 grid, zstd | 2 Hz | additive glow of everything below dust size |
| FIELDS | S to C | u8 grids, zstd | 0.5 Hz | light, temperature, nutrients, plankton density, current (256 x 128 per channel) |
| EVENT | S to C | CBOR | as they happen | births of note, hunts, deaths, speciation, god events, director cues, audio features |
| STATS | S to C | CBOR | 1 Hz, god window only | population, species, energy flows |
| COMMAND | C to S | CBOR, schema-validated | user-driven | god powers, spawns, edits (god scope only, 5.9) |

CBOR (or hand-packed binary) is used for low-rate messages, and hand-packed little-endian binary for high-rate entity frames. JSON is never used on the hot path.

### 5.3.3 Interest management and LOD

For each client the host keeps an **interest rect**: the viewport grown by 25%, plus the camera's predicted motion over the next 1 s. The screensaver and TV camera director runs **host-side**, because it needs global knowledge of events (see the camera section). For director-driven views the host therefore knows the camera path ahead of time, and prefetches bodies before a cut.

A GPU pass per client, run at that client's stream rate, culls every entity against the interest rect. It classifies each entity by its projected size on screen, in device pixels:

| Projected size | LOD | Sent as |
|---|---|---|
| 4 px or more | **body** | BODY_ENTER once, then BODY_FRAME records |
| 0.5 to 4 px | **dust** | DUST_FRAME point (5 B) |
| below 0.5 px, or over budget | **glow** | splatted into a 512 x 256 RGBA8 GLOW_FIELD texture on the GPU |

If the body budget (`caps.maxBodies`) is exceeded, entities are ranked by `log2(screen px) + 2*eventSalience + heroFlag`. The top N stay bodies and the rest drop to dust. The same ranking applies from dust to glow. Event salience comes from the director: the hunter and its prey in a hunt shot keep body LOD even when small.

The pass writes compact `(entityId, quantised record)` pairs into a staging buffer. The CPU maps entity ids to per-client **slots** (a `Map` of at most 10k entries, under 1 ms). Only these few hundred KB are read back. The full state, 1.4 GB for the Default world, is never read back for streaming.

### 5.3.4 Quantisation, and wire format equal to vertex format

**Body record, keyframe: 10 bytes, in dense slot order.** The slot index is implicit, and a presence bitmask of 1 bit per slot comes first.

| Field | Type | Resolution |
|---|---|---|
| x, y | u16, u16 | relative to the interest rect: 1/65536 of its width. On a 4K screen, about 13 sub-pixel steps per pixel |
| heading | u8 | 1.41 degrees |
| speed | u8 | log scale, used for extrapolation |
| swim phase | u8 | 1/256 of a stroke cycle. The view animates the soft body from the descriptor, the phase and the bend |
| bend | i8 | body curvature |
| glow | u8 | current bioluminescent intensity |
| flags | u8 | eating, mating, hurt, diseased, dying, budding, carrying a parasite, selected |

Scale and growth (a u8 log scale) and colour shifts change slowly, so they go in a separate low-rate "slow fields" block in the same frame, only for slots that changed.

**Predictive delta.** Positions move a lot per frame: a creature crossing the screen in 10 s moves about 440 quanta per 15 Hz frame. Plain deltas would therefore save nothing. Instead, both sides run the same integer **dead-reckoning** from the previous record (position plus speed times heading), and the delta carries the residual. Each slot has a 2-bit class: 0 means as predicted, 1 means i8 residuals for x, y and heading plus a phase delta, 2 means a full record, 3 means left. Smooth swimmers mostly fall in classes 0 and 1. The typical cost is **about 3.5 B per body per frame** before zstd, about 2.5 B after. Because WebSocket is reliable and ordered, the baseline is simply the previous frame: no per-packet acknowledgement is needed (compare Glenn Fiedler's UDP snapshot compression, [gafferongames.com/post/snapshot_compression](https://gafferongames.com/post/snapshot_compression/)). A keyframe is sent every 2 s, on a new client, and on resync.

**Dust record: 5 bytes,** an absolute u16 x, u16 y and a u8 palette index, sorted in Morton order so that zstd finds the correlated high bytes. Its layout is identical to the WebGL2 vertex attributes (`UNSIGNED_SHORT` normalised x and y, `UNSIGNED_BYTE` colour). The view therefore uploads the payload straight into a vertex buffer, with **no per-entity JavaScript**. The vertex shader interpolates between two buffered frames. Decoding 150k dust points costs only the `bufferSubData` of 750 KB.

**Interpolation.** Views buffer 2 to 3 frames and render 150 ms (god window) to 250 ms (wallpaper, TV) in the past. Latency does not matter for ambient views. A god command shows its effect within about 300 ms, which feels immediate.

**Descriptor cache.** Views keep an LRU of 50k body descriptors (about 9 MB), keyed by body hash, so a creature that leaves and comes back costs nothing. A camera pan revealing 500 new bodies per second costs about 90 KB/s of descriptors.

### 5.3.5 Bandwidth budgets

| View | Link | Bodies x Hz | Dust x Hz | Fields, glow, events | Raw | After zstd (level 1) |
|---|---|---|---|---|---|---|
| Wallpaper 4K, whole tank (Default world) | localhost | 2,000 x 15 | 150,000 x 5 | about 0.25 MB/s | about 4.0 MB/s | about 3 MB/s |
| Wallpaper zoomed in | localhost | 5,000 x 20 | 20,000 x 5 | about 0.1 MB/s | about 0.9 MB/s | about 0.6 MB/s |
| God window, regional view | localhost | 10,000 x 30 | 50,000 x 10 | about 0.3 MB/s | about 4.0 MB/s | about 3 MB/s |
| Screensaver, 2 monitors | localhost | 2 x 3,000 x 20 | 2 x 40,000 x 5 | about 0.3 MB/s | about 2.7 MB/s | about 2 MB/s |
| **TV direct over Wi-Fi** | LAN | 800 x 15 | 15,000 x 5 | about 0.06 MB/s | about 0.48 MB/s (3.8 Mbps) | **about 0.35 MB/s (2.8 Mbps)**, hard cap 8 Mbps |
| TV by Chrome tab cast | LAN | (video) | | | encoded video, about 5 to 10 Mbps (unverified) | |

Localhost numbers are far below what loopback and a WebView can absorb. The real limits are view CPU (under 2 ms per frame) and host encoding (under 1 ms per client per frame). Compression runs on a worker thread per client.

**Flow control.** The server watches each socket's buffered amount and the age of the last ACK. If more than 250 ms of data is queued, it halves that client's dust rate, then its body cap, then its body rate, and recovers by 10% per second. If no ACK arrives for 3 s, the client is treated as frozen (Lively may suspend a paused wallpaper's WebView). The server stops sending, and the client gets a keyframe when its ACKs resume. A view that sees a gap of more than 1 s in `performance.now()` drops its buffers and sends `VIEWPORT` with `resync`.

---

## 5.4 Persistence

### 5.4.1 World directory

```
%LOCALAPPDATA%\Phylotank\worlds\<world-name>\
  world.toml            name, seed, created, schemaVersion, habitat parameters, preset
  snapshots\
    auto-000000123456.ptk       rolling autosaves (tick number in the file name)
    daily-2026-11-04.ptk
    undo-000000130000-meteor.ptk  taken just before a god event
    pinned\...                  never evicted
  journal\
    000000123456.jnl    append-only commands since that snapshot
  lineage.sqlite        species and lineage history (WAL mode), queried by the god window
  thumb.png             latest 512 x 256 render, used by the screensaver preview and world list
```

On Linux and macOS the root is `$XDG_DATA_HOME/phylotank` or `~/Library/Application Support/Phylotank`.

### 5.4.2 Snapshot format `.ptk` (Phylotank world file)

This is a sectioned container. Columns are stored as structure-of-arrays, the same layout as the GPU buffers, which makes saving close to a memcpy and compresses well.

```
Header (64 B):
  magic    "PHYLOTNK"          8 B
  format   u32                 container version (1)
  schema   u32                 sim schema version (migrations key)
  flags    u32                 bit0 full-fidelity, bit1 lite/seed
  tick     u64
  nsect    u32
  simHash  u64                 hash of sim build (WGSL + sim-core), for replay validity
  reserved ...
  crc32    u32                 of the header
Section table (nsect x 40 B):
  fourcc  u32 | offset u64 | stored len u64 | raw len u64 | codec u8 | required u8 | xxh64 u64
Sections:
  META  CBOR: world params, RNG root seed, counters, app version, git hash
  GENO  genome store: forest of parent-diffs (below)
  CREA  creature columns, each column byte-shuffled then zstd
  BODY  soft-body node columns
  BRST  recurrent brain state (f16)
  PLNK  plankton and plant particles
  FLDS  environment fields (light, temperature, nutrients, currents, corpses)
  SPEC  species table and current clustering
  PARA  parasite and disease genomes and infections
  EVTQ  scheduled events (ongoing disasters, seasons)
  CAMR  director state (optional)
  THMB  PNG thumbnail (optional)
```

- **Codec:** zstd level 3, with byte shuffling (Blosc-style) of float columns before compression. Node's `node:zlib` gained zstd in 22.15 and 23.8 according to a third-party source ([h3-compression PR](https://github.com/CodeDredd/h3-compression/pull/21)); this is unverified against official release notes. Browsers decode with a small WASM or pure-JS zstd decoder for standalone mode and world import.
- **Genome store as a forest of diffs.** Almost every birth mutates something, so genomes are effectively unique per creature: about 3 KB each, or 750 MB raw for 250k creatures. Children differ from their parent in about 1 to 5% of genes. So the CPU-side genome store, which the host owns because births happen on CPU workers, keeps each genome as `(parentGenomeId, sparse diff)`. Every 16th generation along a chain is stored in full, which bounds reconstruction to 16 diffs. Average stored size is about 300 B per genome. The GPU holds materialised genomes. Saving genomes needs no GPU readback.
- **Sizes for the Default world (250k creatures, 4M plankton):** genomes about 75 MB, creature and body state about 250 MB raw (about 110 MB stored), plankton 64 MB raw (about 40 MB stored), fields about 2 MB. **Total about 230 MB per snapshot.** Big tank (1M creatures): about 900 MB.
- **Save cost:** the GPU-to-staging copy takes about 5 ms, the only moment the sim pauses. Readback takes about 20 ms. Compression takes about 1.2 s on 4 workers, writing about 0.3 s on NVMe. The sim keeps running during compression, because the copy is a consistent point-in-time image.

### 5.4.3 Autosave cadence and retention

| Kind | When | Kept |
|---|---|---|
| auto | every **10 minutes** of host running time (2 to 60, configurable) | last 6 (one hour) |
| daily | first autosave after local midnight | 7 |
| undo | immediately before any god disaster or mass edit ("undo the meteor") | 24 h, at most 20 |
| shutdown / evict | on a clean exit, Evicted state, or `flush` | replaces the newest auto |
| pinned | user action in the god window | forever |

Retention is capped at **10 GB** by default; the oldest unpinned snapshots are evicted first. About 18 snapshots of the Default world come to about 4 GB.

### 5.4.4 Crash safety

1. **Atomic writes.** Write `name.ptk.tmp`, flush and `FlushFileBuffers` (`fsync`), then rename over the target. Node's `fs.rename` uses `MoveFileExW` with replace on Windows. A torn file is never visible under its final name.
2. **Verify on load.** Check the header CRC and every section's xxh64. If any check fails, load the next older snapshot and report it in the tray.
3. **Journal.** Every input that can change the world is appended to `journal\<snapshotTick>.jnl` as `{tick, kind, CBOR payload}` and flushed per record: god commands, spawns, edits, rule changes. These are rare, so a flush per record is cheap. Every 256 ticks the journal also records a **state hash** (5.5.3).
4. **Recovery = snapshot + deterministic replay.** After a crash, power cut or GPU device loss, the host loads the last snapshot and replays the journal tail to the last journalled tick. On the same machine and build this reproduces the state that existed before the crash, verified by the journalled hashes. In the worst case, a hash mismatch or a different build, William loses at most 10 minutes of evolution, and never a god action without notice: unreplayable commands are listed for him.
5. **GPU device loss** (a driver update, TDR, a sleep or resume problem). The host handles `device.lost`, recreates the device, and runs step 4 from the in-RAM mirror of the last snapshot. It does not exit.
6. **Crash loops.** If loading the same snapshot crashes 3 times, the shell starts safe mode (previous snapshot, CPU backend) and keeps the crashing snapshot for a bug report.

### 5.4.5 Versioned migrations

- `schema` is a single integer that increments with any change to the layout or meaning of saved state.
- Migrations live in `packages/world-format/migrations/NNNN-description.ts`. Each is a pure function `(sections: SectionMap) => SectionMap` that moves `N` to `N+1`, applied in a chain on load. Old files are never rewritten in place; the next save is written in the latest version.
- **Genome migrations add genes with neutral defaults.** A new gene's default value must produce an identical phenotype, which a test checks: develop 1,000 bodies before and after, and compare them.
- **Forward compatibility:** sections flagged `required=0` are skipped by older readers. A required section the reader does not know produces "This world needs Phylotank at least x.y". It is never a crash.
- **Fixtures:** every release adds `fixtures/worlds/v<schema>.ptk`, a small world of 500 creatures. CI loads every fixture, migrates it, steps 100 ticks and checks the invariants.

### 5.4.6 Shareable world files

| File | Contents | Typical size | Fidelity |
|---|---|---|---|
| `.ptk` full | everything above | 230 MB (Default) | exact continuation, deterministic on the same build |
| `.ptk` lite (flag bit1) | genomes of living creatures, age, position, energy, species, fields, plankton density instead of particles. No body nodes or brain state: bodies regrow from the genome at their current age and settle within about 60 ticks | 30 to 80 MB | faithful but not bit-exact |
| `.ptkg` creature or species | one genome or a small founder set, plus name, author, licence (CC0 by default) and a thumbnail | 1 to 20 KB, can be base64 text | for sharing designs |

Shared files are **untrusted input**. Section 5.9 covers how the parser is hardened.

---

## 5.5 Determinism and replay

### 5.5.1 Rules

1. **Fixed timestep.** One tick is `dt = 1/30` s of sim time, with physics substeps inside it. Throttling changes ticks per wall second, never `dt`.
2. **Wall-clock time never enters the sim.** Day and night and seasons run on tick counts. Anything outside the sim (god commands, editor spawns, a future "sync the sun to local time" option) enters only through the journal, stamped with the tick it applies to.
3. **Counter-based RNG.** There is no shared RNG state. Every random draw is `philox4x32_10(key = worldSeed ^ streamId, counter = (tick, entityId, drawIndex))`, from Random123 ([Salmon et al. 2011](https://www.thesalmons.org/john/random123/papers/random123sc11.pdf)). The same function exists in WGSL and TS. Parallel GPU threads therefore draw the same numbers regardless of scheduling.
4. **No order-dependent float reductions.** WGSL has only integer atomics. Every scatter (forces, eating, nutrient deposits, corpse decay into plankton) accumulates in **fixed point `i32` or `i64` emulation**, where addition is associative, then converts back. Spatial hash cells are built by counting sort, and then sorted by `(cell, entityId)`, so neighbour order is stable.
5. **Deterministic births and deaths.** The GPU marks births and deaths per tick. The CPU receives the list with a **fixed latency of exactly 2 ticks**, never "whenever the readback lands". It processes the list in `parentId` order, assigns monotonic `u32` entity ids, and frees slots by prefix-sum compaction.
6. **Lint enforcement.** In `sim-core` and `sim-gpu`, an ESLint rule bans `Math.random`, `Date`, `performance.now`, timers, `crypto.getRandomValues`, and `Array.prototype.sort` without a comparator. A CI check bans `Math.sin`, `Math.exp` and similar in the CPU reference backend in favour of the project's own polynomial approximations, which match the WGSL ones.

### 5.5.2 What is guaranteed

| Scope | Guarantee |
|---|---|
| CPU reference backend, any machine | **bit-exact**. f32 is emulated with `Math.fround` after every operation. This is correctly rounded for add, sub, mul, div and sqrt, because a double has more than 2 x 24 + 2 bits |
| GPU backend, same GPU, same driver, same build | **bit-exact in practice**. This holds when rule 4 is followed and no kernel races; CI and the soak test verify it by running the same 10k ticks twice and comparing hashes |
| GPU across vendors or drivers, or GPU versus CPU | **not bit-exact** (FMA fusion and transcendental precision differ, which WGSL allows). Single-tick kernel outputs agree within tolerances. Long runs agree statistically (population curves, species counts), and the tests check exactly that |

### 5.5.3 Replay and debugging

- **Replay file** = a snapshot at tick T0 plus a journal. The CLI command `phylotank replay <world> --from <snapshot> --to <tick> [--verify] [--backend cpu|gpu]` runs it.
- **State hashes.** Every 256 ticks a GPU reduction computes a 64-bit hash per system buffer: each element is hashed with its index, and the results are combined by wrapping addition, which is order-independent. The hashes are journalled. `--verify` reports the **first divergent checkpoint and system**, and a bisect mode re-runs that 256-tick window and hashes every tick.
- **Rewind in the god window** loads an auto or undo snapshot and replays it to the chosen tick as a **new branch world** (`<name>~branch-2`). History is never overwritten. This doubles as "what if": replay the same history without the meteor.
- **Bug reports:** "Export replay" bundles the nearest snapshot, the journal, the logs and the system info into a zip. Nothing is uploaded (5.10).

Prior art: Avida's seeded, replayable runs ([github.com/devosoft/avida](https://github.com/devosoft/avida)) are the model for reproducible artificial-life experiments. ALIEN ([github.com/chrxh/alien](https://github.com/chrxh/alien)) shows that GPU-resident artificial life reaches millions of particles. Its CUDA dependency is exactly what WebGPU avoids here.

---

## 5.6 Platforms

### 5.6.1 Lively Wallpaper (web wallpaper)

A Lively wallpaper is a zip with `LivelyInfo.json` at its root, plus the files it names. `LivelyProperties.json` optionally defines a settings menu. Lively calls `livelyPropertyListener(name, val)` when a value changes, and once at load with the saved values ([Lively wiki: Application Wallpaper](https://github.com/rocksdanister/lively/wiki/Application-Wallpaper), [Web Guide IV: Interaction](https://github.com/lively-community/lively/wiki/Web-Guide-IV-:-Interaction)).

**Package `phylotank-lively-x.y.z.zip`:**

```
LivelyInfo.json
index.html          loader (about 6 KB, no dependencies)
idle.js             calm dark-water animation shown while the host is absent
LivelyProperties.json
thumbnail.jpg, preview.gif
```

```json
{
  "AppVersion": "1.0.0.0",
  "Title": "Phylotank",
  "Thumbnail": "thumbnail.jpg",
  "Preview": "preview.gif",
  "Desc": "Your evolving deep-sea tank. Needs the Phylotank host running.",
  "Author": "Phylotank contributors",
  "License": "Unlicense",
  "Contact": "https://github.com/TengilOurLiberator/phylotank",
  "Type": 1,
  "FileName": "index.html",
  "Arguments": null,
  "IsAbsolutePath": false
}
```

The wiki only shows `Type: 0` for applications. **`Type: 1` for web is unverified** and must be checked against Lively's `WallpaperType` enum before release.

**Loader behaviour:**
1. Read `host.json` values from `LivelyProperties` (port; default 47615).
2. Probe `http://127.0.0.1:<port>/health` every 5 s. Meanwhile show `idle.js`: dark gradient water, slow caustics, a few drifting motes, at 15 fps, and nothing else.
3. When the host answers, create a full-window `<iframe src="http://127.0.0.1:<port>/wallpaper?lively=1&monitor=<n>">` and fade it in over 2 s. `livelyPropertyListener` stays on the top-level loader and forwards settings by `postMessage`. Keeping the loader at top level guarantees that Lively's script calls reach it. The fallback, if the cross-origin iframe has trouble with GPU access or autoplay, is `location.replace` to the same URL, with the listener defined by the served page.
4. The served page is always the host's version, so the **Lively package never goes out of date with the host's protocol**. The package only changes when the loader changes.

**Properties exposed** (Lively renders the UI): detail level (Low, Medium, High), frame cap (24, 30 or 60, default 30), brightness, plankton density display, camera drift speed, "follow a lineage" (off by default), audio (off by default).

**Gentleness budget:** at most 30 fps, render scale 1.0, no MSAA, bloom at quarter resolution. Under **3% of a 5090** and under 150 MB of RAM for the WebView at 4K. Multi-monitor: in per-screen mode, each Lively instance is its own client with its own drifting camera. In span mode it is one wide camera.

**Pausing:** Lively pauses wallpapers when a fullscreen app runs (per the brief). Its exact mechanism for web wallpapers (suspending the WebView versus hiding it) is unverified, so the view tolerates both. A frozen page stops sending ACKs, and the server stops streaming to it (5.3.5). On resume it resyncs. The host does not rely on Lively: it detects fullscreen itself through the shell.

### 5.6.2 Windows screensaver (`phylotank.scr`)

**The contract** ([Microsoft: Screen Saver command-line arguments](https://support.microsoft.com/kb/182383), [Learn mirror](https://learn.microsoft.com/ko-kr/previous-versions/troubleshoot/windows/win32/screen-saver-command-line)):

| Invocation | Meaning | Phylotank behaviour |
|---|---|---|
| no arguments | Settings | open the shell's screensaver settings page |
| `/c` or `/c:<HWND>` | Settings, modal to the foreground window or the given HWND | same, positioned over the owner |
| `/p <HWND>` or `/p:<HWND>` | preview as a child of `<HWND>` (decimal), covering its client area | static thumbnail (below) |
| `/s` | run the screensaver | fullscreen view on every monitor |

The parser accepts `/` or `-`, any letter case, and `:` or a space before the HWND, and ignores unknown arguments. It has table-driven unit tests.

**The wrapper: Rust + `wry` with the `windows` crate**, about 3 MB, using the system WebView2 runtime that ships with Windows 10 (via updates) and Windows 11.
- **Why not C#/WebView2:** a self-contained .NET build is 60 MB or more, or it depends on an installed runtime.
- **Why not full Tauri:** its app framework, IPC and bundler are unnecessary for a single-purpose executable, and `/p` needs a child window of a foreign HWND. `wry::WebViewBuilder::build_as_child` takes any raw window handle (API name as of wry 0.4x; recheck on upgrade).
- **Why this works:** the repo already has a Rust toolchain for the shell.

**`/s` flow:**
1. Read `%LOCALAPPDATA%\Phylotank\host.json`. Call `GET /health` with a 200 ms timeout. If the host is down, launch `Phylotank.exe --background`; wait up to 5 s while the windows show solid black, which matches the water.
2. `EnumDisplayMonitors` creates one borderless, topmost, black window per monitor and hides the cursor.
3. Each window hosts a WebView2 (user data folder `%LOCALAPPDATA%\Phylotank\WebView2\scr`, kept separate to avoid lock conflicts with the shell) loading `/screensaver?monitor=i`. The primary monitor gets the director's hero shots. Secondary monitors get wide context shots of the same scene.
4. The page posts `ready` through wry IPC after the first good frame. The wrapper then fades the window from black to the view over 1 s.
5. **Exit on input**, by two independent paths:
   - **Raw Input** registered with `RIDEV_INPUTSINK` for mouse and keyboard, so input reaches the wrapper even though the WebView child has focus. This avoids low-level global hooks, which antivirus heuristics dislike.
   - Page listeners for `keydown`, `pointerdown`, `wheel` and `pointermove` posting `exit`.
   - Mouse movement counts only beyond **8 px** from the position at start, and is ignored entirely during the first **500 ms**, because Windows sends spurious `WM_MOUSEMOVE` messages at launch.
   - `WM_ACTIVATEAPP(false)`, `WM_CLOSE` and the display-change messages also exit.
   - Exit means closing the WebViews and exiting the process within 100 ms. The OS handles "On resume, display logon screen".
6. While the screensaver is connected, the host is in Watching (or trickle in Yield, 5.2.4). Audio follows the user's screensaver setting (default off; the TV is where audio defaults on).

**`/p <HWND>` (preview):** a WebView2 inside a 152 x 112 thumbnail is heavy and fragile, so the preview is GDI. It draws `thumb.png`, which the host refreshes every 2 s at `/thumbnail.png` while a preview is open, scaled into the child window. It polls `IsWindow(parent)` every 500 ms and exits when the parent dies. If the host is absent it draws the idle gradient.

**Installation without admin rights:** the per-user installer places `phylotank.scr` in the install directory and sets `HKCU\Control Panel\Desktop\SCRNSAVE.EXE` to its path, using the short path if needed. **Unverified:** whether the Screen Saver Settings drop-down lists a `.scr` outside System32 when it is the current one. If not, the installer offers an optional elevated copy to `%WINDIR%\System32`, and the README documents right-click, then "Install".

### 5.6.3 Google TV and Chromecast

Both routes are supported, because they serve different devices.

**Route A: cast a Chrome tab (v1, zero extra code; works on every Chromecast).**
- William opens `http://127.0.0.1:47615/tv?cast=1` in Chrome on the PC, then uses Cast, then "Cast tab". Chrome encodes the tab and the receiver decodes the video. Resolution is typically up to 1080p at 30 fps, and the bitrate is adaptive at roughly 5 to 10 Mbps (unverified). Tab audio comes along.
- **The cost:** dark gradients and pinpoint glows are a worst case for video codecs, producing banding, mosquito noise and smeared plankton. So `cast=1` mode renders for the codec:
  - fixed 1920 x 1080 at 30 fps;
  - glows 1.5x larger and softer;
  - about 50% fewer sub-pixel dust points;
  - 1 to 2 LSB of animated blue-noise dither to break up banding;
  - no thin trails under 2 px.
- The PC also spends a little GPU on rendering and encoding, which is negligible on a 5090.

**Route B: the TV renders the stream itself over the LAN (v1.x, the better picture).**
- Google TV has no preinstalled general-purpose browser. The PC host serves `/tv`; the TV needs something to open it:
  - **B1 (documented, no Phylotank code):** a sideloaded TV browser opening `http://<pc-name>.local:47615/tv`.
  - **B2 (recommended, about 300 lines of Kotlin, in `apps/tv-android`):** a tiny Android TV app. A fullscreen `WebView` with `mediaPlaybackRequiresUserGesture = false`, so audio can start. It finds the host by mDNS (`_phylotank._tcp`), runs the pairing flow (5.9), and handles the remote's D-pad: next shot, follow, audio on or off. It is sideloaded by ADB or "Downloader" at first; a Play Store listing is optional.
- **Hardware limits that shape the TV view.**
  - Chromecast with Google TV HD: Amlogic S805X2, quad Cortex-A35, Mali-G31 MP2, 1.5 GB RAM. The 4K model has 2 GB RAM ([CNX Software](https://www.cnx-software.com/2022/09/23/chromecast-with-google-tv-hd-amlogic-s805x2-cpu-av1-video/)).
  - The 2024 Google TV Streamer is faster (MediaTek, 4 GB RAM, from memory and unverified).
  - Mali-G31 is reported to support GLES 3.2 and Vulkan, but browser support on it has been patchy: Mozilla once disabled WebRender on Mali-G31 for broken rendering ([bug 1689947](https://bugzilla.mozilla.org/show_bug.cgi?id=1689947)).
  - **The TV view therefore targets WebGL2 only**, no WebGPU, with these limits: at most 800 bodies and 15k dust points; 1280 x 720 internal resolution upscaled to the panel; bloom at 1/4 resolution; 30 fps; under 400 MB of WebView memory. If frame time stays above 40 ms for 5 s, it steps down: 600 bodies, then 10k dust, then 960 x 540.
- **Rejected: a custom Cast Web Receiver.** It needs registration in the Google Cast developer console (a one-time fee). The receiver page must be HTTPS from a public origin. Connecting to `ws://192.168.x.x` from an HTTPS page is blocked as mixed content, and a LAN `wss://` needs a certificate the device trusts, which is impractical. Cast message channels are for control messages, not for 3 Mbps of state.

**Audio:** the TV defaults to on (brief). In route A audio is the PC tab's WebAudio, carried with the cast. In route B the TV generates audio locally from the EVENT and FIELDS features, so it costs no audio bandwidth.

### 5.6.4 The god-mode window: Tauri or browser

**Both, with one codebase.** The god window is a normal web page served at `/god`.
- **In any browser:** `http://127.0.0.1:47615/god` works on Windows, Linux and macOS. This is the open-source path, and the development path: Vite HMR, browser dev tools.
- **In the Tauri shell on Windows:** the tray item "Open Phylotank" opens the same URL in a Tauri `WebviewWindow` (WebView2, so WebGPU is available). It adds a native window with remembered position, a single instance, a global hotkey (default `Ctrl+Alt+P`), native notifications ("New species: *Lumenodon*"), and native open and save dialogs for `.ptk` and `.ptkg` files.
- **IPC exposure is minimal.** The remote origin `http://127.0.0.1:<port>` gets a Tauri v2 capability with exactly these commands: `open_file_dialog`, `save_file_dialog`, `reveal_in_explorer`, `notify`. Nothing else, and no shell execution.
- **Electron is rejected:** a second bundled Chromium (about 150 MB) adds nothing over WebView2.

---

## 5.7 Repository layout

A pnpm workspace monorepo with a Cargo workspace for the native parts.

```
phylotank/
  packages/                      TypeScript, ESM, strict
    sim-core/        isomorphic: schema, genome, growth (DNA -> body), systems, CPU reference backend,
                     philox RNG, fixed-point helpers. No DOM, no Node APIs.
    sim-gpu/         WGSL kernels + WebGPU backend; runs under Dawn (Node), wgpu (Deno), browsers
    protocol/        message schemas, quantisation, predictive delta codec, CBOR types, version table
    world-format/    .ptk/.ptkg reader and writer, migrations/, fixtures/, fuzz harness
    host/            Node entry: scheduler, throttle, HTTP/WS server, persistence, journal, CLI
                     (phylotank serve | replay | bench | inspect | export)
    render/          WebGL2 + WebGPU renderers shared by every view; LOD, bloom, trails
    views/           Vite multi-page app: wallpaper/, screensaver/, tv/, god/, standalone/
    editor/          gene sliders + part editor (imports sim-core growth for live preview)
    director/        camera director (host-side service + client shot playback)
    audio/           generative ambience (WebAudio)
  apps/
    shell/           Tauri v2 (Rust): tray, god window, sidecar supervision, OS probes, NVML
    scr/             Rust + wry screensaver wrapper -> phylotank.scr
    lively/          builds phylotank-lively-x.y.z.zip
    tv-android/      Kotlin Android TV WebView wrapper (stage S2+)
  tools/             golden-update, bench-report, world-inspector, licence-check
  docs/              design doc (moved here from claude-personal), ADRs (docs/adr/NNNN-*.md)
  fixtures/          small worlds per schema version, golden replay hashes
  .github/           workflows/, ISSUE_TEMPLATE/, PULL_REQUEST_TEMPLATE.md
  UNLICENSE  CONTRIBUTING.md  THIRD_PARTY_NOTICES.md  README.md
```

Dependency rule, enforced by `dependency-cruiser` in CI: `sim-core` depends on nothing. `sim-gpu` depends only on `sim-core`. `views`, `render` and `editor` never import `host`. `protocol` is shared by host and views. These rules keep standalone mode and the escape hatch to Rust possible.

---

## 5.8 Build, CI and testing

### 5.8.1 Toolchain

TypeScript 5.x (strict), pnpm, Vite for views, esbuild to bundle the host into one `host.mjs`, Vitest, fast-check for property tests, Playwright for views. Rust stable for `apps/shell` and `apps/scr`. The Tauri v2 bundler produces the NSIS per-user installer.

**Windows release artefacts:**
- `Phylotank-Setup-x.y.z.exe`, about 70 MB: the shell, `node.exe`, `host.mjs`, `dawn.node`, the views bundle and `phylotank.scr`.
- `phylotank-lively-x.y.z.zip`.
- Later, `phylotank-tv-x.y.z.apk`.

**Cross-platform:** the npm package `phylotank` (`npx phylotank serve`), plus the GitHub Pages standalone demo.

### 5.8.2 GitHub Actions workflows

| Workflow | Runner | Steps | Budget |
|---|---|---|---|
| `ci.yml` (push, PR) | ubuntu-latest | lint (ESLint with the determinism rules, Prettier), typecheck, dependency rules, unit and property tests on the **CPU backend**, protocol round-trip and fuzz (60 s), world-format fixture migrations, **golden replay** | under 8 min |
| `ci.yml` job `gpu-sw` | ubuntu-latest + `mesa-vulkan-drivers` (lavapipe) | host and sim-gpu tests on Dawn through software Vulkan: integer kernels **exact** against the CPU backend (hash grid, sort, births, RNG), float kernels within tolerance after 1 tick, a 2k-creature world for 300 ticks with invariants | under 10 min |
| `ci.yml` job `views` | ubuntu-latest | Playwright Chromium headless with `--use-angle=swiftshader` (WebGL2) and `--enable-unsafe-webgpu`: render recorded protocol streams, perceptual screenshot diffs (tolerance: SSIM at least 0.98), the decoder under a malformed-frame fuzz | under 6 min |
| `ci.yml` job `windows` | windows-latest | build the shell, scr and installer; `.scr` argument-parser tests; host smoke test on the CPU backend; whether Dawn can use the D3D12 WARP software adapter is **unverified**, so it is attempted and marked allowed-to-fail | under 15 min |
| `nightly.yml` | ubuntu-latest | 50k-tick CPU soak test (energy and nutrient conservation, no NaN, population bounds); host test suite under **Deno**; dependency licence audit (`license-checker`, `cargo deny`) | under 45 min |
| `release.yml` (tag `v*`) | windows-latest + ubuntu-latest | build all artefacts, attach them to a GitHub Release, publish to npm, deploy the Pages demo, generate `THIRD_PARTY_NOTICES.md` | |
| `bench` (manual, optional self-hosted runner on the 5090) | William's PC | `phylotank bench` at 100k, 250k and 1M: ticks per second, GPU ms per system, VRAM. Appends to `bench/results.jsonl`, and fails if the Default preset regresses by more than 10% | |

### 5.8.3 Test layers, each runnable in a GPU-less container

1. **Pure units:** genome encode and decode, growth determinism (same DNA gives the same body), quantisation error bounds (max position error at most half a quantum), migrations, the journal.
2. **Property tests:**
   - Mass and energy conservation per tick, within fixed-point epsilon. Corpses become plankton, and nothing appears from nothing.
   - The delta codec is lossless against keyframes.
   - The `.ptk` writer and reader round-trip exactly.
3. **Golden replay:** a 2,000-creature seed world runs 10,000 ticks on the CPU backend, and the hash must equal `fixtures/golden.json`. Changing it requires `pnpm golden:update` and a PR note explaining why.
4. **Software GPU:** Dawn on lavapipe (above). Chrome's own WebGPU testing uses similar software paths, but Dawn Node on lavapipe in CI is **unverified** and is the first spike of stage S1.
5. **Views:** Playwright plus SwiftShader, driven by recorded streams. No host is needed.
6. **On hardware only:** the bench, the 24 h soak test (state hash identical across 2 runs of 10k ticks), and GPU-etiquette tests (start a CUDA load and expect Yield within 6 s).

---

## 5.9 Security of a LAN-exposed server

**Threat model:** a home LAN with possibly untrusted devices on it, malicious web pages in William's own browser, and malicious shared world files. The assets to protect: the world, god powers, and the PC itself.

1. **Bind to `127.0.0.1` by default.** LAN serving is an explicit tray toggle, "Let my TV watch", which binds to `0.0.0.0`. It also accepts only peers from RFC 1918, link-local, or IPv6 ULA addresses, and advertises mDNS only while enabled.
2. **Browser-origin defence on localhost.** Browsers do not apply CORS to WebSockets, so any page William visits could otherwise connect to `ws://127.0.0.1:47615`.
   - The server checks the `Origin` header against an allow-list: its own origin (`http://127.0.0.1:<port>` and `http://localhost:<port>`), the Tauri origin (`http://tauri.localhost`), and `null`/`file://` only for the Lively loader's initial health probe.
   - It checks `Host` against `127.0.0.1:<port>`, `localhost:<port>` or the LAN IP, which defeats DNS rebinding.
   - HTTP responses carry `Content-Security-Policy: default-src 'self'; connect-src 'self'; frame-ancestors 'self' file: null` and no permissive CORS.
3. **Tokens and scopes.** Two 128-bit random tokens are stored in `%APPDATA%\Phylotank\secrets.toml`, readable only by the user:
   - `view` grants the streams. Localhost clients from allowed origins get it implicitly, so the wallpaper needs no configuration.
   - `god` grants COMMAND. The Tauri shell injects it into the god window. A browser god window gets it by opening the link that "Open in browser" prints, which carries the token in the URL fragment so it never reaches logs or Referer headers. It is then stored in `sessionStorage`.
   - **LAN clients get `view` only**, through pairing: the TV shows a 6-digit code, and the tray shows "Living-room TV wants to watch: code 482 913. Allow?". On approval the host issues a per-device view token, which the TV stores. Devices can be revoked in the god window. Pairing attempts are limited to 5 per minute. Plain HTTP on the LAN is accepted: a view token is low-value (it only lets someone watch fish). God over LAN is off and needs a second, warned toggle.
4. **Input limits.**
   - Inbound WebSocket messages are capped at 64 KB, and CBOR commands are schema-validated and rate-limited to 20 per second.
   - At most 16 clients, 8 of them from the LAN.
   - Static file serving comes from an embedded manifest, so path traversal is impossible.
   - Clients never send file paths: worlds are chosen by name from the server's list.
5. **World files are untrusted.**
   - Every length and offset is bounds-checked against the file size.
   - Per-section raw-size caps (8 GB in total, configurable) and decompression-ratio caps (at most 50:1) stop decompression bombs.
   - Genome values are clamped to gene ranges on load.
   - Files contain no code: no scripts, no WGSL, no URLs that are fetched.
   - A continuous fuzz target in `world-format` is run in nightly CI.
6. **No elevation:** everything is per-user. The optional System32 copy of the `.scr` is the only elevated step, and it is opt-in.

---

## 5.10 Telemetry

**None.** There are no analytics, no crash upload and no automatic update ping.
- **Outbound network:** the host and shell make no outbound connections except the opt-in "Check for updates" menu item, which fetches the GitHub Releases API once, only when the item is clicked.
- **Enforcement:** an ESLint rule bans `fetch`, `http.request` and similar outside `host/src/update-check.ts`. The README states the promise.
- **Logs** stay local: `%LOCALAPPDATA%\Phylotank\logs\`, 5 files of 10 MB, rotated. "Copy diagnostics" builds a zip for William to attach to an issue himself (5.5.3).

---

## 5.11 Licence and contribution basics

- **Licence:** the code is under the **Unlicense** (William's usual choice). All art, creature presets, sounds and documentation are under **CC0 1.0**, which has a stronger public-domain fallback for non-code works in jurisdictions that do not recognise dedication.
- **Third-party components** keep their own permissive licences, and their notices ship in `THIRD_PARTY_NOTICES.md`: Dawn and Tint (BSD-3-Clause), Node.js (MIT), Tauri and wry (MIT or Apache-2.0), zstd (BSD), ws (MIT), SQLite (public domain). CI rejects GPL or AGPL dependencies, because they would force copyleft terms on the distributed binaries.
- **CONTRIBUTING.md covers:**
  1. Setup: `pnpm i` then `pnpm dev` starts the host on the CPU backend and opens the god view. No GPU is needed to contribute.
  2. A dedication line: "By submitting a contribution you dedicate it to the public domain under the Unlicense, or CC0 1.0 for non-code." PR commits carry `Signed-off-by` (DCO) to record that.
  3. **Originality rule:** no assets, names, creature designs or code copied from existing games (Spore, The Bibites and others). The genre is fair game; their content is not.
  4. **Determinism rules** (5.5.1). A schema change needs a migration, a fixture and a golden update with a reason. Performance PRs need `phylotank bench` numbers.
  5. Architecture changes need an ADR in `docs/adr/`.
  6. Code of conduct: the Contributor Covenant.
  7. Issue templates for bugs (attach a replay zip), creature submissions (`.ptkg`) and ideas.

---

## 5.12 Failure modes at a glance

| Failure | Detection | Response |
|---|---|---|
| Host crash | shell sees the process exit | restart with backoff, resume from the snapshot plus journal replay |
| GPU device lost (driver update, TDR) | `device.lost` | recreate the device, resume from the in-RAM snapshot plus the journal |
| Corrupt snapshot | CRC or xxh64 mismatch | fall back to the next older snapshot, notify |
| Disk full | write error | keep running, retry every 10 min, tray warning, never delete pinned or the last good snapshot |
| VRAM pressure (ComfyUI) | NVML or DXGI budget | Yield, then Evicted |
| Port in use | bind error | next free port, written to `host.json` |
| Lively starts before the host | health probe fails | idle animation, retry |
| View frozen by Lively | ACK silence for 3 s | stop streaming, keyframe on resume |
| TV too slow | frame time above 40 ms for 5 s | step the LOD down |
| Malicious `.ptk` | parser bounds and caps | reject with a clear message |
| Replay divergence | journalled hash mismatch | report the first divergent checkpoint and system, offer bisect |

---

## 5.13 Open questions for William

1. **Default size versus gentleness.** Should the Default preset be 250k creatures at at most 15% GPU while the wallpaper runs, or would you rather default to Big tank (1M) and accept that it runs at about 0.6x speed as a wallpaper?
2. **While you game or run ComfyUI:** freeze the tank completely (the default here), or let it trickle at 0.1x so evolution never fully stops?
3. **Day and night:** purely sim-time (a "day" of about 20 minutes wall time at 1x), or synced to your real local time through journalled sun commands, so that the wallpaper's tank is dark at night?
4. **TV route:** is sideloading a small Phylotank Android TV app onto your Google TV acceptable (the better picture), or are tab casting and a sideloaded browser enough?
5. **Code signing:** ship unsigned (Windows SmartScreen will warn strangers) or apply for free open-source signing, for example through the SignPath Foundation (availability unverified)?
