# src/ui: view shell, god window and designer

Owner: UI engineer. Design: [sections/07-ux.md](../../docs/sections/07-ux.md), as changed by DESIGN R3, R7, R8, R12, R22, R24, R26, R27, R29, R30 and [CONTRACT](../../docs/CONTRACT.md) §13, §14.2, §15.

## Responsibilities

- The view shell for every mode (`bootView`, in place): sim link choice, renderer, camera, frame cap, visibility handling. Still to do: host first with the dream-tank fallback after 2 s (DESIGN R31), VIEWPORT and ACK sending.
- God window (Preact with signals, uPlot, Canvas 2D; under 300 KB gzipped): powers palette from `PowerSpec` data with previews and hold-to-confirm for major powers (`isMajorPower`), countdowns for the 3 s and 1 s leads, inspector with the glass-body brain view, stats, timeline, bookmarks, rewind (epoch), the speed lease and the overnight "run at max until" lease.
- Designer: gene sliders generated from `TRAITS` and `BRAIN_TRAITS`, part editor, growth strip, test tank (a worker running the real sim), energy budget, warn-never-forbid validation, "Release as leviathan".
- Library and sharing: `.ptkg`, `PTK1.` strings, QR, fingerprints, import safety (07 §2.4, `sanitiseText`).
- Onboarding, accessibility, input (keyboard, gamepad, remote), English and Swedish, species naming.

## Interfaces

- Sends `GodCommand`s (CONTRACT 13) in COMMAND frames; receives COMMAND_RESULT, EVENT, STATS, INSPECT.
- Consumes: `core`, `genome`, `render`, `director`, `audio`, and only `sim/client`.

## Review findings to address

- **R20**: v0.1 ships to William only as a portable zip; the browser-only demo is the public front door.
- **R27**: rewind is in place with an epoch; stale commands are rejected.

## Acceptance tests

UX-T01 to T08, T20 to T27, T35 (v0.5); a release reaches the wallpaper and screensaver within 500 ms; onboarding under 10 s on the PC; axe-core clean; `npm run test:e2e` boots every mode page without errors.
