# src/render: the look

Owner: render engineer. Design: [sections/06-rendering.md](../../docs/sections/06-rendering.md) §6.1, as changed by DESIGN R1, R2, R20, R25, R33 and [CONTRACT](../../docs/CONTRACT.md) §12, §15.

## Responsibilities

- One renderer for every view: WebGL2 now (headless Chromium uses SwiftShader), WebGPU later behind `RendererModule`.
- Decode protocol frames into GPU buffers: DUST_FRAME (stable slots, per-slot interpolation, already in place), BODY_ENTER/BODY_FRAME, NEAR_POSE, GLOW_FIELD, FIELDS, ENV.
- Five LOD tiers, SDF bodies regrown locally with `genome.develop`, glow, reprojected trails, dual-filter bloom, filmic tonemapping, dither, the three-layer flash defence, per-mode profiles (`VIEW_PROFILES`).
- The free dim baseline glow for every creature (William's Q5), emission slew limits and the whole-screen luminance cap (review R18), day-night compression on the wallpaper.

## Interfaces

- Implements `RendererModule` (`createRenderer(canvas, mode)`); exposes `stats` for tests.
- Consumes: `core` (protocol, profiles), `genome` (`develop` for templates). Never imports `sim` or `host`.

## Review findings to address

- **R18**: stable slots (done in phase 0), slew-limited emission, luminance-change cap per profile, wallpaper day-night range 40%, severed parts fade over 30 s.
- **R21**: the cast sub-profile; spike 7 picks the TV route.
- **R24**: Lively unknowns (type flag, iframe or direct, pause, one client per monitor) in spike 4.

## First tasks

Spike 4 (Lively and WebView2, with packaging) and spike 6 (wallpaper calm recording: luminance change per second, fraction of screen changing more than 5% per second, mean emissive brightness over an hour). Record in `docs/spikes/`.

## Acceptance tests

06 §6.8.1 visual snapshot tests (SSIM at least 0.98 against goldens, from recorded streams); flash analyser zero WCAG 2.3.1 violations over 10 minutes (v0.1 acceptance 6); wallpaper at most 1.5 ms per frame at 4K on the 5090; `npm run test:e2e` stays green.

## Status (phase 1, 2026-11-05)

Built: the WebGL2 frame graph, SDF bodies, five LOD tiers, OKLCH colour from genes, trails, bloom, dither, the three-layer flash defence, per-mode settings and the wallpaper 30 fps cap. Design notes, decisions and what is left: [docs/modules/render.md](../../docs/modules/render.md). Spikes: [render-04-lively](../../docs/spikes/render-04-lively.md), [render-06-calm](../../docs/spikes/render-06-calm.md). Contract requests: [docs/contract-requests/render.md](../../docs/contract-requests/render.md).

Visual test page: `web/render-test.html` (bundle built by `node tests/render/harness.mjs`, which also writes `tests/artifacts/render-*.png`).
