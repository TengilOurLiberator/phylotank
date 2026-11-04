# src/director: the camera director

Owner: director and audio engineer (shared with `src/audio`). Design: [sections/06-rendering.md](../../docs/sections/06-rendering.md) §6.2, as changed by DESIGN R7, R19, R30 and [CONTRACT](../../docs/CONTRACT.md) §11, §15.

## Responsibilities

- Runs in the view as a pure function of the event log, the census and the seed (DESIGN R19): StoryBook, scoring with exposure memory, shot types, critically damped springs, van Wijk and Nuij zoom paths, dips to dark, captions (TV 6 s hold at least 25 s apart, screensaver 5 s at least 45 s apart, wallpaper never).
- Idle drift for the wallpaper (William's Q10; `idleDrift` is in place).
- Sends its predicted viewport (VIEWPORT `leadS`) so the host prefetches.

## Interfaces

- Implements `DirectorModule`; consumes `SimEvent` (CONTRACT 11) and CENSUS frames. Imports `core` only. Uses deterministic maths so recorded logs replay identically.

## Review findings to address

- **R18**: director speed limits and no restless motion on calm profiles; `prefers-reduced-motion`.
- Giant thresholds are relative to the ceiling (`G_REL = 0.6`, CONTRACT 3.3), never 2 m.

## Acceptance tests

06 §6.2 director property tests 1 to 10 on three recorded logs; every god event on screen by its fire tick in at least 99% of cases (v0.3).
