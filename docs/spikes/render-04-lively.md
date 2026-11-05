# Spike 4: Lively and WebView2 (render, with packaging)

Status: **not runnable in this environment**; partial evidence only. Owner: render. Date: 2026-11-05.

## 1. Question

Wallpaper delivery through Lively Wallpaper (web wallpaper type flag, iframe or direct page), whether WebGPU is available inside Lively's and the screensaver wrapper's embedded runtime, how Lively pauses the page, and whether each monitor gets its own client (review R24, R25). Contract values that depend on it: none directly; it decides whether the wallpaper runs the WebGPU or the WebGL2 path, and how `visibilitychange` pausing is relied on (CONTRACT 15).

## 2. Set-up

This overnight build runs in a Linux container with no Windows, no Lively, no WebView2 and no GPU. The only browser is Playwright's headless Chromium 153.0.8010.12 with ANGLE on SwiftShader (Vulkan 1.3, "SwiftShader Device (Subzero)"). Commit: the phase 1 render branch (`mod/render`).

## 3. Numbers (measured here)

| Probe | Result |
|---|---|
| `navigator.gpu` in headless Chromium 153 (no flags) | absent |
| WebGL2 context | yes; renderer string "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)" |
| `EXT_color_buffer_float`, `EXT_float_blend`, `OES_texture_float_linear` | all present (HDR `rgba16f` targets and `rgba32f` readback work) |
| `MAX_TEXTURE_SIZE` / `MAX_DRAW_BUFFERS` | 8192 / 8 |
| `MAX_UNIFORM_BLOCK_SIZE` / UBO offset alignment | 65536 / 256 |
| Full frame graph at 960 x 540 on SwiftShader (4 CPU cores) | about 0.7 s per frame for an almost empty view, 3 to 4 s with nine 260 px L0 heroes (the SDF body pass dominates). These are CPU-emulation numbers, useful only for test budgets, not for the 1.5 ms target. |

## 4. Decision

None yet. The WebGL2 path is complete and is what Lively will get until spike 4 runs on William's PC. What must be measured there, in order:
1. Lively's web wallpaper loads `wallpaper.html` directly (not in a cross-origin iframe) and keeps WebGL2 context creation working; record the type flag Lively writes.
2. `navigator.gpu.requestAdapter()` inside Lively and inside the `.scr` WebView2 host.
3. Whether Lively fires `visibilitychange` (or only suspends the process) when a fullscreen app runs; the UI loop already stops on `document.hidden`, and the renderer's own 30 fps accumulator stays correct after a long pause (it clamps the accumulated time).
4. Two monitors: one page per monitor means two renderers; measure GPU time of both at 4K with the wallpaper profile (render scale 0.5).
