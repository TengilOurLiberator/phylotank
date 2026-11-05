# Spike 4 (packaging part): Lively, WebView2 and the native wrappers, desk checks

Spike 4 (REVIEW §9, CONTRACT §17) is shared by render and packaging. Most of it needs William's Windows PC with Lively installed, which this container does not have. This report holds what can be measured here, in headless Chromium and with the Rust toolchain, and lists exactly what is still to be measured on the PC.

## 1. Question

- Can the Lively package run the standalone dream tank when Lively loads it from a local folder, and can it embed the host's page instead (review R24, DESIGN R31)?
- Do the screensaver and the tray shell build for Windows from this repository, and does the supervisor keep the real host alive (review R25)?
- Contract values that depend on it: none directly. The results shape the loader (`packaging/lively/loader.js`) and the screensaver's source order (`packaging/screensaver/src/source.rs`).

## 2. Set-up

- Container: Linux 6.18, Node v22.23.4, headless Chromium 153.0.8010.12 (Playwright 1.63.0), rustc 1.97.0 with the `x86_64-pc-windows-gnu` and `x86_64-pc-windows-msvc` targets added (no Windows linker, so `cargo check` and `cargo clippy` only).
- Commit: `e6d9b88` on `mod/packaging`, `dist/` from `npm run build`.
- Commands:
  - `NODE_PATH=$(npm root -g) node packaging/lively/check-file-origin.cjs` (each case in a fresh page);
  - `node packaging/lively/build-zip.mjs && NODE_PATH=$(npm root -g) node packaging/lively/check-package.cjs`;
  - `cd packaging && cargo test -p phylotank-tray -- --nocapture`;
  - `cd packaging && cargo clippy --workspace --all-targets --target x86_64-pc-windows-gnu -- -D warnings`, and `cargo check --workspace --target x86_64-pc-windows-msvc`.

## 3. Numbers

### 3.1 What a `file://` page can do in Chromium (proxy for a Lively web wallpaper)

| Case | Result |
|---|---|
| `dist/wallpaper.html` from `file://`, plain `new Worker('sim-worker.js')` | **fails**: `SecurityError: Failed to construct 'Worker': Script at 'file:///.../sim-worker.js' cannot be accessed from origin 'null'`; nothing renders |
| Same page with `worker-shim.js` (worker source from a classic script, started as a `blob:` worker; CSP `worker-src 'self' blob:`) | works: worker link, WebGL2 on, 43 DUST frames and 86 rendered frames in 3 s |
| `fetch(http://127.0.0.1:47615/health, {mode: 'no-cors'})` from `file://`, host down | rejects in 7 ms (`ERR_CONNECTION_REFUSED`) |
| Same, host up (phase-0 host answers 404) | resolves in 8 ms (opaque response), so a no-cors probe tells "listening" from "not listening" |
| `file://` loader with an iframe of `http://127.0.0.1:47615/wallpaper.html?lively=1` | works: socket link, WebGL2 on, 44 DUST frames, 89 rendered frames in 3 s; the host's `frame-ancestors 'self' file: null` allows it |
| `file://` loader with an iframe of the local `tank/wallpaper.html` (shim) | works: worker link, 44 DUST frames, 89 rendered frames in 3 s |

### 3.2 The built Lively package, end to end (`check-package.cjs`)

| Step | Result |
|---|---|
| Open `packaging/out/lively/index.html` from `file://`, host down | after 3 failed probes the loader mounts the built-in tank; 20 frames rendered from its blob worker **3.5 s** after load (2 s fallback plus iframe load plus about 0.7 s of frames) |
| Start the host while the built-in tank runs | the loader's retry schedule (1, 2, 4, 8 s, then 10 s) finds it and swaps to the host page; 20 frames rendered over the socket **6.3 s** after the host was spawned (the next probe was due at 7 s after load) |
| Page errors | none |

Zip: 11 files, 69 KiB (`phylotank-lively-0.0.1.zip`), loader, idle animation and built-in tank included.

### 3.3 Native wrappers

| Check | Result |
|---|---|
| `cargo clippy -D warnings`, `x86_64-pc-windows-gnu`, whole workspace (wry 0.57.1, tao 0.37.2, tray-icon 0.26.1, windows-sys 0.61.2) | clean |
| `cargo check`, `x86_64-pc-windows-msvc` | clean |
| Release cross-build, `x86_64-pc-windows-gnu`, MinGW-w64 GCC 13 linker (`opt-level = "s"`, LTO, stripped) | links: `phylotank-scr.exe` 722 KiB, `phylotank-tray.exe` 559 KiB, both GUI subsystem. The GNU build of the screensaver imports `WebView2Loader.dll` (webview2-com-sys links the loader statically only for MSVC), so CI and releases use the MSVC toolchain; a GNU build needs that DLL next to the `.scr` |
| `cargo test` on Linux (host-agnostic parts) | 37 tests pass: 17 common, 10 screensaver, 10 tray |
| Supervisor with the real host (Linux, Small world) | healthy **337 ms** after spawn; after `kill -9`, restarted and healthy again **385 ms** later (test policy: 20 ms backoff, 200 ms health polls; the shipped policy is 1 s, 5 s, 30 s, 120 s with 5 s polls) |

## 4. Decision

- **Lively package:** the loader stays at top level (`index.html`, `loader.js`), probes the host with a no-cors fetch, embeds the host page in an iframe when it answers, and otherwise embeds the zip's own `tank/wallpaper.html`, patched at build time to load the worker through `worker-shim.js`. This survives both a plain `file://` load (measured above) and a virtual-host mapping (where the shim does nothing).
- **Screensaver:** the bundled standalone views are served to WebView2 through wry's `phylotank` custom protocol (`http://phylotank.localhost/`), never from `file://`, so the worker loads; wry 0.57 registers the filter with `COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL` where the runtime supports it, which covers worker scripts.
- **Contract change:** none. Host and UI requests are in `docs/contract-requests/packaging.md`.

## 5. Still to measure on William's PC

1. Lively accepts `"Type": 1` as a web wallpaper (believed from Lively's `WallpaperType` enum: 0 app, 1 web, 2 web with audio; from memory, unverified).
2. How Lively loads a local web wallpaper (`file://` or a virtual host), and so whether the shim or the plain worker runs. `window.__phylotankLoader` and `window.__phylotank` in Lively's dev tools show it.
3. Whether `livelyPropertyListener` and `livelyWallpaperPlaybackChanged` are called as the loader expects, and how Lively pauses (suspending the WebView or hiding it).
4. Two monitors: frame time and GPU use with one instance per monitor at 4K.
5. WebGPU inside Lively's WebView2, top level and in the iframe (render's half of the spike).
6. The screensaver: whether Screen Saver Settings lists `phylotank.scr` outside System32 once `SCRNSAVE.EXE` points at it; whether a god window or a casting Chrome tab holds a wake lock that stops it; first-frame time with the host cold (the built-in tank shows at once, then the switch to the host page within 10 s); exit latency on a key press (target under 100 ms).
7. Binary sizes of the MSVC builds from the Windows CI job (the GNU cross-build above is under 1 MB each), and that they start on a clean Windows 10 with only the WebView2 runtime.
