# UI spike 1: budgets for the designer, sharing and the god bundle

The UI README names no reviewer spike, so this one measures the numbers the UI design (07 §7) promises and that the rest of the UI work depends on. Measured on 2026-11-05 in the build container (4 cores, Node 22, headless Chromium with SwiftShader). The machine was shared with about ten other engineers and showed a load average of about 32 during the run, so every timing below is pessimistic, probably by 3 to 8 times.

## Method

`docs/spikes` numbers come from a throwaway script bundled with esbuild that imports the real UI modules (`src/ui/designer/*`, `src/ui/mock-sim.ts`) and times each call over 2,000 runs after 20 warm-up runs. Bundle size is `gzip -9` of `dist/app.js` from `node scripts/build.mjs`.

## Results

| Template | Genome bytes | `PTK1.` chars | QR version (ECC L) | Parts (sketch) | Grow, µs | Budget + validate, µs | Import, µs |
|---|---|---|---|---|---|---|---|
| Meadowlamp | 776 | 1,221 | 25 | 11 | 169 | 102 | 399 |
| Hushmaw | 828 | 1,297 | 26 | 10 | 216 | 56 | 635 |
| Sievebell | 672 | 1,087 | 23 | 15 | 222 | 84 | 428 |
| Tetherling | 724 | 1,155 | 24 | 7 | 40 | 59 | 481 |
| Ashpicker | 724 | 1,156 | 24 | 11 | 61 | 23 | 202 |
| Deepcrown | 880 | 1,364 | 26 | 23 | 128 | 36 | 497 |
| Motefly | 620 | 1,011 | 23 | 4 | 16 | 100 | 264 |
| Blank | 516 | 869 | 21 | 1 | 4 | 10 | 293 |

Other numbers:

- One slider edit (decode, set one locus, canonical re-encode): 97 µs.
- QR encode of a 1.2 K character string, all eight masks scored: 34 ms (runs only when the share dialog opens).
- God window bundle (`dist/app.js`, everything: renderer, mock sim, god window, designer, QR): 223 KB minified, **75 KB gzipped**, against the 300 KB gzipped budget (07 §0.3) for the god UI alone.
- Mock sim warm-up of 240 sim seconds with about 1,300 agents: 3.7 s under that load. Cut to 90 sim seconds for page start.

## What this decides

- **Strings stay uncompressed for now.** Every template's `PTK1.` string is between 869 and 1,364 characters without deflate, under the 2,300-byte QR limit of 07 §2.3 and the 3,000-character cap of UX-T11. `src/core/ptkg.ts` takes a synchronous `Deflate`; the browser's `CompressionStream` is asynchronous, so the UI writes flag 0 (uncompressed) payloads and rejects compressed imports with a clear reason. A small synchronous inflate (or an async variant of `decodePtkg`) is a contract request; evolved genomes near the 16 KB cap will need it.
- **No framework.** Plain DOM with a 40-line `h()` helper keeps the whole app at 75 KB gzipped, so Preact and uPlot (07 §0.3) were not needed for v0.5; Canvas 2D draws every chart.
- **Per-edit work is far inside budget.** Grow plus budget plus validation is at most about 0.3 ms per edit even under load, against 07 §7's "develop < 5 ms on a weak laptop", so the designer recomputes everything on every slider input event.
- **Headless frame rate is the limit for browser tests.** Under this load SwiftShader rendered about 9 frames per second, so the mock sim's frame cadences follow wall time (1 Hz stats, about 15 Hz dust) rather than counting pumps, and the UI e2e script polls for results instead of fixed waits.
