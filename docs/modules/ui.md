# src/ui design notes (phase 1)

What exists, where it lives, and the decisions taken overnight without William. Design reference: [07-ux](../sections/07-ux.md); contract: CONTRACT 13, 14.2, 15.

## Layout of the code

| File | What |
|---|---|
| `src/ui/index.ts` | `bootView(mode)`: link choice, renderer, camera, frame cap; captions for screensaver and TV; hands the god page to `GodApp` |
| `src/ui/captions.ts` | `CaptionScheduler` (priority, hold, gap, 1 s fade in, 1.5 s fade out, 10 s staleness) and the DOM caption layer |
| `src/ui/i18n.ts` | English and Swedish messages, ICU subset (`{x}` and `plural`), `Intl` numbers, run-time switching |
| `src/ui/mock-sim.ts` | `MockSimLink`: a toy host behind `SimLink` speaking the real frames |
| `src/ui/god/client.ts` | `GodClient`: world state from frames only, commands with id and epoch, retries, speed lease renewal, CPU picking |
| `src/ui/god/powers.ts` | `PowerSpec` data for the core 12 and the casting state machine |
| `src/ui/god/app.ts` | the god window: top bar, rail and panels, inspector, timeline, minimap, viewport input, keyboard |
| `src/ui/god/inspector.ts`, `charts.ts`, `diversity.ts`, `styles.ts`, `wire.ts` | inspector tabs; Canvas 2D charts; diversity indices; CSS; local payload adapter |
| `src/ui/designer/model.ts` | the one-genome edit functions (sliders and part rules), undo history |
| `src/ui/designer/body.ts` | grown bodies for drawing (`genome.develop` when it lands, a local sketch until then), part picking |
| `src/ui/designer/budget.ts` | energy budget estimate and V01 to V14 validation |
| `src/ui/designer/templates.ts` | the seven templates plus Blank |
| `src/ui/designer/library.ts`, `qr.ts`, `designer.ts` | `.ptkg`, `PTK1.`, import safety, library; QR encoder; the designer view |

## Decisions

1. **Plain DOM, no framework.** A 40-line `h()` helper, an `Emitter`, and Canvas 2D for every chart. The whole app is 75 KB gzipped (spike ui-1). Preact, signals and uPlot (07 §0.3) were not needed; nothing was added to `package.json`.
2. **The god window runs on a mock by default.** `god.html` with no `?host=` and not served by the host uses `MockSimLink` in the page. `?sim=mock` gives the screensaver and TV the mock too (so captions can be seen); `?sim=worker` forces the dream-tank worker. Wallpaper, screensaver and TV keep the worker by default. The mock labels itself in the top bar ("mock sim") and in Settings.
3. **Captions.** Only events the director would show are captioned (hunt start, speciation, extinction, giant, god, release, school start, mass death, frenzy, outbreak start, bloom front, migration, new role), scored with `BASE_INTEREST`. Each caption is a whole template with the species name as a slot rendered in italics. A speed change produces one "Time is running Nx faster" caption (Q2: never fast-forward silently). The wallpaper never creates a caption element, so its DOM has no text (checked by `tests/ui-screens.e2e.cjs`).
4. **Speed and the overnight lease.** Buttons for pause, 0.25x, 1x, 4x, 16x and max (DESIGN R29). Anything but 1x is renewed every 10 s; the mock lapses it 30 s after the last renewal. "Run at max until…" sends `{speed:'max', until:{wallIso}, unattended:true}`, which the mock honours until the time passes even with the window gone; the top bar shows "Max until 07:00 (unattended)" with a Stop button while it runs, and a banner explains the lease for ordinary fast-forward.
5. **Powers.** The palette shows the core 12 (CONTRACT 13). Major (by core `isMajorPower`) needs a 1.2 s hold, with "Confirm without holding" as the accessible alternative and Enter-hold on the keyboard. The host takes the `beforePower` snapshot and returns `snapshotId`; if a result has none, the client takes one itself (still inside the 3 s lead). The countdown (3 s major, 1 s minor) pauses while the world is paused. A stale-epoch rejection says "World was rewound; power not cast." Species-targeted powers use a checkbox list; circle and point powers target by clicking the tank, with a live "In range" count from the dust frame.
6. **Inspector.** Picking is on the CPU from the last DUST_FRAME, with BODY_ENTER giving slot to entity (the mock streams every creature as a dust mote with the same slot). Brain view: inputs left, outputs right, hidden in the middle, dashed negative edges, thickness |w|, brightness from INSPECT; clicking a node starts a 20 s trace.
7. **Designer.** One genome in bytes; every edit is decode, change, canonical encode, so the two editors cannot drift. Sliders are generated from `TRAITS` and `BRAIN_TRAITS` by their schema group (hidden traits go to Advanced, so nothing heritable is hidden); brain groups carry "starting instinct, may evolve". The part editor edits rules: click a part to select the rule that grew it (all copies highlight), add parts from the palette to the selected rule, edit module fields and link fields, break out one copy, duplicate, delete. The growth strip scrubs maturity 0 to 1 and plays over 6 s. Diet has a barycentric triangle picker over the enzyme simplex, next to its two sliders.
8. **Bodies before `develop` exists.** `growBody` calls `genome.develop` and falls back to a local sketch of the body graph, labelled "sketch preview" on the canvas. The sketch is view-only.
9. **Test tank is a toy.** There is no sim test tank yet, so the panel animates the grown body and reports speeds from the budget model, labelled "toy model until the sim test tank lands". Honest numbers (07 §0.1) means it must be replaced, not tuned.
10. **Energy budget.** CONTRACT 9 shapes and coefficients (Kleiber 0.75 with Arrhenius, repair `C_REP`, brain `e_n`, `e_s`, Holling II with `J_max = 8B`, enzyme simplex, clutch overhead). Always labelled an estimate. Trade-off chips: central differences at ±5% of range over 13 lever loci, computed 250 ms after edits pause; the three largest show as "+10%: net −16%" and jump to their slider. Validation never disables Release; with an inviable issue the button reads "Release anyway".
11. **Templates.** Meadowlamp, Hushmaw, Sievebell, Tetherling, Ashpicker, Deepcrown and Motefly (Q9), plus Blank. Motefly is a 1.2 mm photosynthetic cilia mote (*Motilux errans*, original). `genome.template(id)` wins when it is implemented; these local ones are placeholders for the genome engineer's tuned versions.
12. **Release as leviathan.** A confirmed major action: hold or confirm in a dialog that explains the endowment; the UI sets `GENOME_FLAG_LEVIATHAN` in the genome and sends `asLeviathan: true`; the host snapshots first.
13. **Library.** Templates are read-only entries; designs, captures and imports live in this viewer's `localStorage` as `PTK1.` strings (the host library folder replaces it later). De-duplication by xxh64 content id; fingerprints are the SHA-256 prefix (xxh64 fallback where SubtleCrypto is missing). Imports from paste, drop or file go through size caps, CRC, strict CBOR, genome decode and `sanitiseText`, and always open in the designer first.
14. **QR codes** are encoded locally (byte mode, ECC L, versions 1 to 40) and shown only when the string is under 2,300 characters.
15. **Host first for the wallpaper.** `wallpaper.html` (the Lively page) uses `HostFirstLink`: the host socket first, the dream-tank worker after 2 s of silence, probes with 0.5, 1, 2, 4, then 10 s backoff, back to the host when it answers, back to the worker if the host goes silent for 5 s. `index.html` keeps the plain worker (the browser demo, and what the smoke test checks). Every view sends VIEWPORT when its camera moves (at most 10 Hz) and ACK at 2 Hz.
16. **Language** follows `navigator.language`, `?lang=` overrides, and Settings or the top-bar menu switches without a reload. The Swedish strings are a first pass for William to review.

## Tests

- `tests/ui.test.ts` (31 tests): i18n completeness and Swedish number format (UX-T37), caption cadence (UX-T31), slider round trip property test (UX-T01), single source (UX-T02), undo (UX-T03), rule vs instance and break out (UX-T04), budget scaling (UX-T06), validation fixtures (UX-T07), templates and string sizes (UX-T11), `.ptkg` round trip and hostile-input fuzz (UX-T10, T12), QR capacities, Reed-Solomon and BCH checks, diversity (UX-T28), and against the mock: major-power snapshot and lead (UX-T22), rewind and stale epoch (UX-T24), lease lapse and the unattended lease (UX-T23), release with the leviathan flag (UX-T21), the casting state machine, the host-first link with fake timers, and trade-off chips.
- `tests/ui-screens.e2e.cjs` (after `node scripts/build.mjs`): drives the god window in Chromium, writes `tests/artifacts/ui-*.png`, and checks that a major power snapshots, a leviathan release reaches the world, share and import round trip, captions appear in screensaver and TV, and the wallpaper has no text.

## Left for later

- Real host wiring beyond the link: the pairing token and the 1.5 s crossfade on switching streams. (While a real host is silent for 3 s the top bar says so and world-changing controls are disabled.)
- The sim test tank in a worker, measured readouts, V08 (overlap) and V10 (close to a living species).
- Food web, gene drift heatmap, phylogeny semantic zoom, stats ranges (1h, 1d, 30d, all).
- TV overlay and gamepad, onboarding and Founding Waters, rename species, knobs panel, pop-out panels, the "Describe view" live region, axe-core runs.
- Pseudo-locale `xx`.
