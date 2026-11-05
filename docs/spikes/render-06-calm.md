# Spike 6: wallpaper calm recording (render)

Owner: render. Date: 2026-11-05. Status: run in headless Chromium with synthetic streams; the hour-long recording on William's desktop with spike 3's world is still to do.

## 1. Question

Are the wallpaper's slew constants, pulse clamps and luminance cap (CONTRACT 15: emission slew 300 ms, pulses at most 1 Hz and 0.5 Hz for saturated red, whole-screen luminance change at most 10% per second, day and night at 40%) calm enough, and do they hold when the brain output driving a creature's glow is adversarial? Review R18.

## 2. Set-up

- Playwright headless Chromium 153.0.8010.12, ANGLE on SwiftShader (CPU), 4 cores, Linux container. Branch `mod/render`.
- `node tests/render/calm.mjs 30`: renders 30 s of each scene at 192 x 108 with a fixed step of 1/15 s (pulses and slews are frame-rate independent), reading back every frame. Body frames stream at 15 Hz through the real protocol codecs (BODY_ENTER, BODY_FRAME, ENV).
- Scenes from `web/render-test.html`: `tank-mid` (a 12 m view at 17 m depth in the Default tank, about 45 creatures in view, tiers D and L2) and `lineup-deep` (nine heroes at 22 m, including a red-lure Hushmaw with a 1.2 s gene period, the worst case for the red clamp).
- "noisy": every creature's streamed glow byte is a random on/off value each body frame (a 15 Hz random brain output). "UNSAFE": the same with the profile limits removed (no slew, 30 Hz pulse limit, no luminance cap) for comparison.
- Metrics, all on displayed relative luminance (sRGB decoded), the first 2 s (start-up) excluded: whole-screen change per second (mean and max over 1 s steps); the largest frame-to-frame change expressed per second; the fraction of 32 x 18 tiles whose luminance changes more than 5% in a second (raw, and with a floor of 5% of the brightest tile, since raw relative change in near-black tiles is dominated by marine snow); mean displayed luminance; and the worst WCAG-style flash count per second in any of 32 regions, each normalised to the brightest region (stricter than WCAG's absolute 10%).

## 3. Numbers

| Scene, mode, input | Change per s, mean | Change per s, max | Frame change per s, max | Tiles > 5%/s (raw) | Tiles > 5%/s (floor) | Mean luminance | Worst flashes per s | Net engaged |
|---|---|---|---|---|---|---|---|---|
| tank-mid, wallpaper, calm | 0.0054 | 0.017 | 0.087 | 0.30 | 0.004 | 0.0032 | 0 | 0 |
| tank-mid, wallpaper, noisy | 0.022 | 0.081 | 0.36 | 0.31 | 0.008 | 0.0027 | 1 | 0 |
| tank-mid, wallpaper, noisy, UNSAFE | 0.082 | 0.24 | 4.6 | 0.34 | 0.019 | 0.0027 | 7 | 0 |
| lineup-deep, wallpaper, noisy | 0.031 | 0.090 | 0.37 | 0.66 | 0.045 | 0.017 | 1 | 0 |
| lineup-deep, wallpaper, noisy, UNSAFE | 0.19 | 0.71 | 15.5 | 0.72 | 0.090 | 0.018 | 7 | 0 |
| lineup-deep, screensaver, noisy | 0.051 | 0.15 | 0.70 | 0.72 | 0.070 | 0.021 | 2 | 0 |

An earlier run of the same script, before the per-creature direction lock in `stepEmission` existed (slew only), gave 2 (tank-mid) and 3 (lineup-deep) worst flashes per second on the wallpaper and 6 on the screensaver with noisy input. That is why the lock was added.

## 4. Decision

- No contract change: the CONTRACT 15 values hold. With the limits the wallpaper's whole-screen luminance never changed by more than 9% in a second (cap 10%), and no region flashed more than once per second (cap 1 Hz) even with a random 15 Hz brain output; the screensaver stayed at its 2 Hz and 25% caps. Without the limits the same input reaches 7 flashes per second and a 71% change in a second.
- Added to the renderer (commit on `mod/render`): `stepEmission`, a per-creature limiter that, on top of the profile slew, rate-limits a full swing to half the shortest pulse period and allows one reversal of direction per half period, so each creature makes at most `maxPulseHz` full cycles per second whatever the brain does.
- The runtime safety net never engaged in any run, as intended.
- Still to measure: the hour on William's desktop with spike 3's world, dust at 5 Hz with and without stable slots (the dust path interpolates per stable slot already), and the absolute WCAG verdict on a calibrated display.
