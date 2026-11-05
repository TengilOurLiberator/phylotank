# Lively Wallpaper package

`node packaging/lively/build-zip.mjs` (after `npm run build`) writes `packaging/out/phylotank-lively-<version>.zip` and the same files unpacked in `packaging/out/lively/`.

| File | Role |
|---|---|
| `LivelyInfo.json` | metadata; `"Type": 1` (web) and `"FileName": "index.html"`; `AppVersion` comes from `package.json` |
| `LivelyProperties.json` | Lively's settings panel: **Tank** (automatic, host only, built-in only) and **Host port** |
| `index.html`, `loader.js` | the loader, at top level so Lively's script calls reach it |
| `idle.js` | calm dark-water animation while nothing else is ready (`packaging/shared/idle.js`) |
| `tank/` | the standalone dream tank: `dist/wallpaper.html` patched to start its worker from a `blob:` URL (`worker-shim.js`, `sim-worker-inline.js`), because Chromium refuses `new Worker()` from `file://` |
| `thumbnail.png` | drawn by the build script |

Loader behaviour: show the idle water; probe `http://127.0.0.1:<port>/health` (no-cors fetch, any answer counts); host answers within 2 s: embed `http://127.0.0.1:<port>/wallpaper.html?lively=1` and fade it in; otherwise embed `tank/wallpaper.html`. Keep probing (1, 2, 4, 8 s, then every 10 s) and swap to the host when it appears; go back to the built-in tank after 3 missed checks. `window.__phylotankLoader` shows the state.

Checks: `tests/packaging.test.ts` (state machine, zip, page patch) and `check-package.cjs` (the built folder from `file://` in headless Chromium: fallback, then swap to a live host). `check-file-origin.cjs` is the spike-4 desk experiment ([docs/spikes/packaging-4.md](../../docs/spikes/packaging-4.md)).

**Unverified until spike 4 runs on William's PC:** that Lively takes `"Type": 1` as a web wallpaper; whether it loads the folder from `file://` or a virtual host (the shim covers `file://`; over http it does nothing); the names and payloads of `livelyPropertyListener` and `livelyWallpaperPlaybackChanged`; how it pauses; whether workers and WebGPU run inside its WebView2 at top level and in the cross-origin iframe; and the cost of one instance per monitor.
