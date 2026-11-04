# src/audio: generative ambience

Owner: director and audio engineer (shared with `src/director`). Design: [sections/06-rendering.md](../../docs/sections/06-rendering.md) §6.3 and [CONTRACT](../../docs/CONTRACT.md) §15.

## Responsibilities

Generative WebAudio with no samples: drone, pads, low thuds for giants' strokes, soft bells for births, darkness after disasters decaying over ten minutes, seasonal key, species leitmotifs that mutate at speciation. Off on the wallpaper and screensaver by default, on for TV, a toggle in the god window.

## Interfaces

Implements `AudioModule` (`start`, `stop`, `setMood`); mood scalars come from the census and events (04 §4.9: activity, richness, stress, recent disaster). Imports `core` only. Phase 0 is `SilentAudio`.

## Review findings to address

None directly; respect autoplay rules in WebView2 (needs a user gesture or a wrapper flag; part of spike 4).

## Acceptance tests

06 §6.8.3 offline-render tests (OfflineAudioContext): loudness bounds, no clipping, darkness raises the Phrygian weight, silence when muted.
