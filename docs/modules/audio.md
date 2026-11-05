# Audio: design notes (phase 1)

Owner: director and audio engineer. Design: 06 §6.3 and §6.8.3, CONTRACT §15.

## What is built

| File | Contents |
|---|---|
| `src/audio/theory.ts` | modes Lydian to Phrygian with crossfade weights by darkness, a Markov chain over diatonic chords (favouring I, IV, vi, ii), minimal-movement voice leading, harmony by diversity (triads, add9, add7 and 9), leitmotifs of 3 to 5 notes from a species hash, mutated by one note at speciation |
| `src/audio/composer.ts` | the pure, seeded model of 06 §6.3.2: density from biomass (tau 60 s), harmonic richness from Shannon diversity, darkness up with tau 5 s and down with tau 10 min, mode, cutoff, detune, reverb, register and drone octave from darkness, night slows chords and darkens, season moves the tonic by fifths, camera depth sets the mix lowpass, zoom balances drone and micro layers, giants' strokes give thuds (at most 1 per 1.5 s, 30 to 70 Hz, gain by sqrt of screen area, 2nd harmonic), births a bell (at most 1 per 4 s), kills a lower, earlier chord, the featured species its motif once; at most 24 voices |
| `src/audio/webaudio.ts` | the Web Audio graph: soft PeriodicWave oscillators, pad lowpass, depth lowpass, generated stereo-noise reverb, FM bell, thud with pitch drop, limiter (DynamicsCompressor); all slow changes by `setTargetAtTime` |
| `src/audio/offline.ts` | a deterministic software renderer of the same notes (8 kHz mono, 12 dB/oct filters, soft limiter at -1 dBFS) and level and centroid meters, for tests in Node |
| `src/audio/index.ts` | `Ambience` (implements `AudioModule`), `SilentAudio`, `audioOnByDefault(mode)` |

Tests: `tests/audio.test.ts` (15): mode and harmony rules, motif mutation, voice leading, density mapping, darkness rise and ten-minute decay, thud spacing and pitch, voice cap, bell spacing, motif once per featured species, a 120 s render (no NaN, peak at most -1 dBFS, level between -45 and -15 dBFS RMS), bit-identical determinism, spectral centroid at least 30% lower after a crash and within 20% after 15 minutes, silence when muted, defaults per mode, and the graph against a fake AudioContext.

## Decisions

- **A1 Defaults**: off on the wallpaper and the screensaver, on for TV (CONTRACT 15 and William's Q10). `Ambience.start()` creates the AudioContext, so the UI must call it from a user gesture or with the host's autoplay flag (WebView2, Lively).
- **A2 Inputs**: `setMood` (the contract's coarse input) maps darkness and stress to darkness and `season` to the key. The richer inputs are adapter methods: `census()`, `events()`, `camera()` (see the contract request).
- **A3 Loudness** is checked as RMS in a band, not LUFS; the offline renderer has no K-weighting. The Web Audio limiter sits at -3 dB threshold, ratio 20.
- **A4 B_ref** (the 24 h median biomass) is approximated by a slow running mean (time constant about 2 h at 1 Hz census).
- **A5** The software renderer is a model of the graph, not a bit-exact copy; Web Audio's own offline rendering is left for a browser test (Playwright) later.
