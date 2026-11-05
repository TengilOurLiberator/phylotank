# Spike ui-2: onboarding time, accessibility audit, bundle size (second UI pass)

Measured on 2026-11-05 in the build container (headless Chromium from Playwright 1.63, software rendering), with `node tests/ui2-screens.e2e.cjs` against the in-page MockSimLink. Raw numbers are in `tests/artifacts/ui2-report.json` after a run.

## Onboarding: time to a living tank (UX-T33)

"Living" means at least 50 creatures in the dust stream; the welcome card follows 1.5 s later.

| CPU | Living tank | Welcome card |
|---|---|---|
| 1x | 1,739 ms | 2,785 ms |
| 4x throttle (CDP `Emulation.setCPUThrottlingRate`) | 2,730 ms | 3,560 ms |

A second full run gave 1,375 / 2,524 ms at 1x and 2,885 / 3,788 ms at 4x. Both runs are far inside the 10 s (PC) and 60 s (weak laptop) budgets of 07 §5.1. Caveat: the mock warms up 90 s of toy world in the page before its first frame; the real Founding Waters snapshot and the dream-tank worker will have their own load cost, which this does not measure. The keyboard-only tour (Enter, C, Target the view centre, Cast, Esc, D, Enter) and the skip path both pass.

## axe-core 4.14.0 (UX-T34)

Every god panel (none, map, powers, designer, library, stats, bookmarks, settings), in the normal and high-contrast themes, at 100% (1600x900) and 200% UI scale (2560x1440): 32 runs, plus the TV overlay.

| Before fixes | After fixes |
|---|---|
| `color-contrast` (serious): `--faint` #5f7d87 on #060d13 is 4.43:1, in the designer header and budget (normal theme, 100% and 200%) | fixed: `--faint` is #6f8c96 (about 5.4:1) |
| `region` (moderate) on every run: the WebGL canvas, the overlay canvas and the minimap were outside landmarks | fixed: the canvases sit in a `<main>`, the minimap is a labelled region |

After the fixes: zero violations of any impact in all 32 god runs and on the TV overlay (which had the same `region` finding, fixed the same way for the TV and screensaver pages; the wallpaper gets no extra DOM). Limits: axe reports text over the translucent panels with the live canvas behind as "incomplete" (it cannot compute the background), so those were checked by eye in the screenshots only; NVDA passes are still to do.

## Bundle

`dist/app.js` (all view modes, including the mock): 78,771 B gzipped at `c165539`, 103,169 B after this pass (gzip -9), against the 300 KB budget of 07 §0.3.
