# Director: design notes (phase 1)

Owner: director and audio engineer. Design: 06 §6.2, DESIGN R7, R18, R19, R30, CONTRACT §11 and §15. Spike: [director-1](../spikes/director-1.md).

## What is built

| File | Contents |
|---|---|
| `src/director/params.ts` | every 06 §6.2 table as data: type weights, recency, magnitude scales, shot sequences, holds, camera limits, per-mode profiles (wallpaper calm, reduced motion) |
| `src/director/storybook.ts` | events to stories: merge by key, area merge (20 m, 10 s), hunt to kill, giant promotion, notable births, last of species, bounded at 512 with eviction of ended then low-scoring stories |
| `src/director/exposure.ts` | exposure memory per entity, species, story type and region cell with the 30, 10, 4 and 3 min half-lives, lazily decayed, pruned incrementally |
| `src/director/motion.ts` | exact critically damped spring, smooth saturation, soft speed cap, the van Wijk and Nuij path with its peak rates, the trapezoid time warp |
| `src/director/director.ts` | scoring `S = W (1 + a ln(1 + m/m0)) A N V T Q`, seeded softmax over ln S (T = 0.15) among `S >= 0.6 S_best`, the 35% switch margin, interrupts, idle, diversity halving; shot framing (establish, track, push-in, reveal, aftermath, drift); the camera rig (springs, zoom paths, dips); captions |
| `src/director/drift.ts` | idle drift from the census heat map: waypoints every 20 to 40 s weighted `(emissive + 0.3 biomass)^0.7 (1 - region exposure)`, centripetal Catmull-Rom in (x, y, log height), a 90 s zoom breath, an OU wobble; 10% tight details |
| `src/director/captions.ts` | templates per story type, an original pseudo-Latin namer keyed by species id, caption boxes |
| `src/director/replay.ts` | seeded synthetic logs (quiet reef, predator boom, god session, mixed, edge cases, storm) and the replay harness |

Tests: `tests/director-properties.test.ts` (properties 1 to 9 over three seeds of five logs), `tests/director-cost.test.ts` (property 10), `tests/director-unit.test.ts` (springs, van Wijk path, scoring factors, StoryBook, captions, heat-map drift).

## How to use it (for src/ui)

```ts
const d = createDirector({ mode, tankW, tankH, viewWpx, viewHpx, seedLo, lCeilingM, reducedMotion });
d.setCensus({ species, heat, heatW: 64, heatH: 36, heatCh: 4 });   // on CENSUS
d.setSimTick(tick);                                                  // optional, from frame headers
const f = d.step(eventsSinceLastFrame, dtWallS);                     // every frame
renderer.render(now, f.camera);        // f.dim is the dip exposure (0.15 to 1) for the renderer
f.predicted                             // centre, zeta and lead (s) for VIEWPORT prefetch
f.caption, f.captionAlpha               // the lower third, side 'left' | 'right'
```

`update(events, dt, current)` and `caption()` implement the contract's `DirectorModule`. The wallpaper uses the same class with `mode: 'wallpaper'`: idle drift only (William's Q10). The exported `director` constant is still the phase-0 pass-through until the UI constructs one with the tank and view sizes.

## Decisions (made overnight, no one to ask)

- **D1 Clocks.** Recency `A` uses sim seconds (event ticks / 30, synced forward by the newest tick or `setSimTick`). Holds, exposure, the repeat window, captions, dips and diversity use wall seconds, because they are about what a viewer sees.
- **D2 Region cells** are `min(32 m, tank width / 4)`: 32 m cells on the Small tank would be one cell, and region exposure then multiplies every story by the same `exp(-2.6)` at steady state.
- **D3 Zoom-path limits.** 06's path numbers (rho 1.4, V 0.8 /s) contradict its steady limits (see the spike). Paths may run at 2x the speed limits and 4x the acceleration limits; their duration comes from the peak rates; a path whose clamped course (with the carried velocity) breaks those limits is flattened (rho 0.7, 0.35) or becomes a dip or glide. A path in flight is re-planned from its current state, carrying its velocity as a decaying offset `v0 t e^(-t/1.5)`, so there is no jerk.
- **D4 Disasters** are exempt from novelty, travel and the diversity halving: property 2 requires every god event filmed.
- **D5 Hard repeat guard.** Besides exposure, a primary subject that was featured in the last 15 min is not a candidate (unless lastOfSpecies or disaster), so property 1 holds by construction.
- **D6 Bounded scoring.** Two passes: the upper bound S0 for every story; the travel factor only for the top 64 upper bounds, in order, until the 0.6 S_best cut. Stories idle past 12 tau are skipped and pruned.
- **D7 God dips break the dip spacing.** A dip taken to catch a god event may follow another at any time (it may start while the previous one fades in); every other dip keeps 20 s apart (2 min on the wallpaper). With a 3 s lead and a camera zoomed six octaves in, nothing else reaches the event in time.
- **D8 God events always cut in** while they are pending (any score, before the 2 s rule): the director moves at once. A second god event during an establishing shot of the first joins it: the shot frames both and re-plans the move.
- **D9 Soft habitat walls.** Pan and zoom approach the habitat edges and the zoom range along braking curves (counting the walls closing while zooming out), and targets are clamped for the wider of the current and target view, so the hard clamp almost never engages.
- **D10 Captions.** Subjects are framed above the lower third whenever captions are on; a caption starts 2 s after the shot settles, at least `minGapS` after the previous start, never twice running for one species, on the side away from the subject, and fades out early if the subject swims under it.
- **D11 Notable births and matings.** First birth of a species created by speciation, a giant's offspring, or a boom (10 births of a species in a 20 m cell within 20 s). Matings count when both partners are at least `0.1 L_ceiling` (a stand-in for "L1 or larger", which depends on zoom).
- **D12 Giants** are `G_REL L_ceiling` and above (CONTRACT 3.3), plus whatever the `giant` detector reports; a hunt with a giant becomes `giantKill`.
- **D13 Calm profiles (R18).** Wallpaper: 0.08 screen widths/s, 0.12 octaves/s, glides only, no captions, idle drift only unless `calmDirector` (then W x 0.5 except disasters, holds x 2.25, about 45 s). `reducedMotion` (`prefers-reduced-motion`) applies the same limits in any mode and turns off the wobble and zoom breath.
- **D14 Visibility V** implements only "expected remaining duration shorter than the hold" (0.5 for ended stories). Luminance and crowding need render data: `observe()` takes on-screen bodies with prominence for exposure; a visibility hook is a contract request.
- **D15** The diversity rule needs at least 120 s of featured time in its 20 min window before it acts.
- **D16 Tracking dead zone**: the track target is held until the desired target moves more than 7.5% of the screen width from it (a 15% zone).

## Wired into the views (2026-11-06)

- `src/ui/index.ts` builds one `Director` per view (not god) on the first CENSUS, with `startSettled: true`, feeds it EVENT frames, the census heat (box-blurred over 5 x 5 cells by `directorHeat`) and `renderer.locate` as the locator. The phase-0 `PassThroughDirector` and whole-tank `idleDrift` are only used before the first census.
- **D17 Drift zoom tied to the size ceiling.** Visible height from 3 to 30 `L_ceiling` (0.4 m to 3.8 m on Small), tight details at 0.3 to 0.7 of the lower bound. The old fixed 3 m floor showed every founder (1 to 5 cm) under the stream's 6 px body cutoff, so the wallpaper was empty water.
- **D18 `startSettled`.** Live views open on the first waypoint's framing instead of gliding in from the whole tank (a 2.5 octave glide at the wallpaper's 0.12 octaves/s takes 20 s). The framing is computed twice because `finishTarget` clamps the centre for the wider of the current and target views.

## Not done yet

- Golden shot lists for the three real recorded logs and the diff report (the logs do not exist until the host detectors run); the synthetic logs stand in.
- Lateral reveal (pan from dark water); the scale reveal is implemented.
- Multi-monitor wide context for secondary screens.
- The director replay viewer page.
