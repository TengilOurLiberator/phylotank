# Render module: design notes (phase 1)

Owner: render engineer. Design: 06 §6.1, CONTRACT 12 and 15. This file records what was built, the decisions taken overnight without William, and what is left.

## What is built

`src/render` implements `RendererModule` in WebGL2 (`createRenderer(canvas, mode)`), with the frame graph of 06 §6.1.2:

| # | Pass | Where | Notes |
|---|---|---|---|
| 1, 2 | Classify, cull, pose | CPU (`lod.ts`, `pose.ts`) | the WebGL2 path does these on the main thread for now, not a worker |
| 3 | Water background | `BG_FS`, half resolution | per-channel Beer-Lambert depth light (red lost first), surface mirror band, god rays, caustics, floor, the tier-D density splat and the host GLOW_FIELD |
| 4, 8 | Marine snow | `SNOW_VS/FS` | procedural, three parallax layers (far 0.5, creature plane 1.0, near 1.7 as soft out-of-focus discs), world-anchored per zoom octave and cross-faded between octaves, falling and drifting with the current |
| 5, 6 | Bodies | `BODY_VS/FS` | per-creature SDF of tapered capsules with smooth union; MRT into `body` (premultiplied albedo, "over") and `emit` (additive HDR) plus a trail source; never fused across creatures |
| 7 | Light organs, specks, dust | `SPRITE_VS/FS` | additive gaussians |
| 9 | Trails | `TRAIL_FS`, half resolution | ping-pong feedback, reprojected for camera pan and zoom, advected by the water current, frame-rate independent decay, cleared on a zoom jump of more than one octave |
| 10 | Bloom | dual filter, half resolution down to 1/32 or 1/64 | soft knee; 4 levels (wallpaper) to 6 (screensaver, god) |
| (net) | Luminance grid | `LUM_FS`, 64 x 36 | read back through a PBO with a fence (synchronous in tests) |
| 11 | Composite | `COMPOSITE_FS` | `bg * (1 - body.a) + body + emit + trail + bloom`, safety gain, exposure, Narkowicz ACES fit, sRGB, blue-noise dither |

Bodies (06 §6.1.5): coverage, thickness, edge and core alpha from genes, Fresnel-like rim, halo outside the body only, stripes along the chain coordinate, cellular spots, fins as see-through webs with rays (union alpha `max`), a gut SDF darkening the interior by up to 40%, eyes with a pupil and a specular dot, mottled glow when diseased, 20 s body fade and 10 to 30 s glow fade when dying. The body's own light also lights its pigment ("self-illumination"), which is what makes colour readable in the dark zone.

Detail tiers (06 §6.1.4, `lod.ts`): D, L3, L2, L1, L0 with the thresholds 0.75, 4, 28 and 110 px, +-15% hysteresis per instance, caps per profile (largest kept, a `SELECTED` subject never demoted), and a 250 ms blue-noise dissolve between tiers for SDF tiers (an intensity cross-fade for the additive tiers). L1 uses at most 8 macro capsules from chain simplification; L2 uses the 3 largest body capsules (see "Decisions"); L3 is one gaussian whose colour is the body's integrated emission colour; D is splatted bilinearly into a 256 x 144 view-space density texture.

Colour (06 §6.1.8, `colour.ts`): OKLCH to linear sRGB with chroma-reducing gamut mapping, the gene table exactly as written (body hue, chroma, lightness, opacity, the warped luminescence hue that keeps most of the gene range in blue to green, gain, pattern, trail gain).

Flash safety (06 §6.1.7, CONTRACT 15, `safety.ts`), by construction:
1. Every on-screen pulse period is clamped to at least `max(T_min, 1 / maxPulseHz)` (1 s wallpaper, 0.5 s elsewhere) and at most 12 s; pulses are duty-shaped raised cosines with duty clamped to 0.2 to 0.8 and depth capped (0.55 wallpaper, 0.8 elsewhere).
2. Saturated red (OKLCH hue 350 to 40 degrees with chroma above 0.15, or WCAG's red ratio of at least 0.8) gets a period of at least 2 s and 60% of the pulse depth.
3. Emission follows its streamed target through a first-order slew with the profile's time constant (300 ms wallpaper, 150 ms screensaver and TV, 100 ms god). The free dim baseline glow (William's Q5, `BASELINE_GLOW`) is added to every living creature's target, so a creature with no luminescence genes still glows faintly.
4. Whole-screen luminance change is capped per profile (10% per second wallpaper, 25% elsewhere) by an exposure limiter that also relaxes towards 1 at no more than 0.5 stops per second. The first 1.5 s after start-up track freely (the page appearing is one transition, not a flash).
5. The runtime net: a 64 x 36 grid of displayed luminance, a per-tile WCAG transition counter, and a per-tile `safetyGain` that ramps emission down by up to 70% over 300 ms when more than 10% of the screen has two or more transitions in a second, recovering over 3 s. It logs when it engages.

Profiles (06 §6.1.9, `settingsFor`): render scale (wallpaper 0.5 at 4K, 0.75 at 1440p, 1.0 at 1080p), bloom levels, trail time constant (0.6 s wallpaper to 1.2 s TV), snow density (half on the wallpaper), caps, and the cast sub-profile (static dither, 2 px minimum speck, half the snow, black lifted by 2/255, longer trails) behind `options.cast`. The wallpaper is capped at 30 fps by an accumulator inside `render()` that locks to integer divisors of the refresh rate, and is "gentle": 85% emission gain, fewer bloom levels, shorter trails, stricter pulse limits, and day and night compressed to 40% of the sim's range when ENV frames arrive.

Stream: DUST_FRAME (stable slots, interpolated), BODY_ENTER, BODY_LEAVE, BODY_FRAME (per-slot interpolation one interval behind, at most 200 ms extrapolation, then frozen), NEAR_POSE (joint offsets for L0), GLOW_FIELD, FIELDS (mean flow drives snow and trails; turbidity), ENV (day light), WELCOME (tank, palette).

## Decisions taken overnight

- **L2 is a three-capsule SDF, not an atlas impostor.** At 4 to 28 px a three-capsule SDF costs about as much as an atlas sample, needs no atlas management, and shares every shading rule with L1, so zooming never changes the look. The atlas (`morphKey`, 64 x 64 cells) stays the plan if profiling on the laptop says otherwise.
- **Chunking only above 32 capsules.** For bodies of up to 32 capsules one quad that evaluates every capsule once is cheaper than overlapping 8-capsule chunks each evaluating their neighbours. Bigger bodies use the chunk-and-owner rule of 06 §6.1.5 unchanged.
- **Capsules live in an RGBA32F texture** (two texels each) and neighbour lists in an R32F texture, because WebGL2 has no storage buffers.
- **The caustic texture is generated at start-up** by one shader pass (a tileable water caustic), and two layers scroll in different directions and combine with `min`, as 06 §6.1.6 describes.
- **Blue noise is generated at start-up** by void and cluster (64 x 64, about 0.4 s in Node, cached), so the repo ships no binary asset.
- **Depth scale.** Depth light uses `y * 36 / tankHeight`, so every preset spans the same light zones as the Default tank (R33). Twilight starts at about 8 m and the scene is lit almost only by bioluminescence below about 20 m in the Default tank.
- **Facing left mirrors, it does not rotate.** A side-view body that turns left is mirrored so its dorsal side stays up; through vertical the mirror factor passes smoothly through zero, which reads as a turn. Radial bodies (Sievebell) are never mirrored.
- **Templates.** `genome.develop` is a stub on this branch, so `archetypes.ts` hand-authors the seven starter templates plus Blank (and a red-lure Hushmaw for the safety tests) from 07 §1.6. `templateFromPhenotype` converts a real Phenotype, and `setTemplateSource` is the seam for it (contract request 4).

## Tests

- Unit: `tests/render-colour.test.ts`, `tests/render-safety.test.ts` (including ten minutes of random organ genes in every profile against the WCAG analyser), `tests/render-lod.test.ts`, `tests/render-template.test.ts`.
- Pixel snapshots: `tests/render-snapshot.test.ts` renders four scenes at 384 x 216 in headless Chromium (SwiftShader) and compares with `tests/render-goldens/*.png` by SSIM (at least 0.98); it also checks that no pixel is pure black and runs the flash analyser over a rendered wallpaper sequence with a red lure. Skipped when Playwright is not installed. `UPDATE_GOLDENS=1 npx vitest run tests/render-snapshot.test.ts` rewrites the goldens.
- Visual review: `node tests/render/harness.mjs [scene...]` writes `tests/artifacts/render-<scene>.png` at 960 x 540 from `web/render-test.html`.
- Spike 6: `node tests/render/calm.mjs [seconds]`.

## Left for later

- WebGPU backend; GPU-driven culling; worker-side classify and pose.
- The impostor atlas (if L2 SDF proves too slow on the laptop).
- Adaptive quality (the PI controller on GPU time).
- The bloom ceiling of "at most 25% lift of mean luminance" is enforced only indirectly (bloom strength is modest and the luminance limiter covers whole-screen change); a direct measurement from the luminance grid is a small follow-up.
- Severed parts (no protocol record for them yet), parasites drawn attached to host nodes, cilia ribbons for microbes.
- `prefers-reduced-motion` (shorter trails) belongs to the UI shell that owns the camera; the renderer exposes `settings.trailTau`.
