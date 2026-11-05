# Phylotank architecture

For contributors. This describes the code as it is on `main`, not as it is planned; where the plan differs it says so. The binding interface definitions are in [CONTRACT.md](CONTRACT.md) (where this file and the contract disagree, the contract wins). The design and its reasons are in [DESIGN.md](DESIGN.md) and the appendices in [sections/](sections/); each module's own decisions are in [modules/](modules/), its measurements in [spikes/](spikes/) and its proposed contract changes in [contract-requests/](contract-requests/).

Words outside computer science are in the [glossary](GLOSSARY.md).

## Contents

1. [The big picture](#1-the-big-picture)
2. [Module map](#2-module-map)
3. [World state](#3-world-state)
4. [The tick pipeline](#4-the-tick-pipeline)
5. [Data flow: from the sim to the screen and back](#5-data-flow-from-the-sim-to-the-screen-and-back)
6. [Determinism rules](#6-determinism-rules)
7. [Conservation: the mass and energy ledger](#7-conservation-the-mass-and-energy-ledger)
8. [Persistence and recovery](#8-persistence-and-recovery)
9. [How to add a gene](#9-how-to-add-a-gene)
10. [How to add a god power](#10-how-to-add-a-god-power)
11. [Where things stand](#11-where-things-stand)

---

## 1. The big picture

Phylotank is one TypeScript codebase that runs a deterministic, fixed-step simulation and draws it in a browser.

```
                    +------------------------------------------------------+
                    |  sim core (src/sim): one World, a fixed 1/30 s tick  |
                    |    genome -> develop -> physics, brain, ecosystem    |
                    +---------+--------------------------+-----------------+
                              |                          |
          in a Web Worker (dream tank)          in the Node host (src/host)
          src/sim/worker.ts + SimSession        HTTP + WebSocket on 127.0.0.1:47615,
                              |                 journal, snapshots, detectors, throttle
                              |                          |
                 postMessage(ArrayBuffer)          WebSocket /ws/v1 (binary)
                              |                          |
                              +------------+-------------+
                                           |  the same CONTRACT 12 frames
                                           v
                    +------------------------------------------------------+
                    |  views (web/*.html -> src/ui): wallpaper, screensaver,|
                    |  tv, god. Renderer (src/render), camera director      |
                    |  (src/director), ambience (src/audio)                 |
                    +------------------------------------------------------+
```

- **One world, many views.** The persistent world lives in the host on the user's PC. Every view is a web page that receives binary frames and renders them; only the god window may send commands. Without a host, a page runs a small world itself in a Web Worker (the "dream tank"), speaking exactly the same frames, so a view never knows which transport it has.
- **CPU reference backend.** All simulation runs on the CPU in plain TypeScript over typed arrays. It is bit-identical on every conforming JavaScript engine, which makes it the test oracle for the GPU backend planned later (WGSL through Dawn on Node; see [spikes/host-2.md](spikes/host-2.md)).
- **Native wrappers stay thin.** `packaging/` holds a Lively Wallpaper package, a Rust `.scr` screensaver and a Rust tray app that supervises the Node host. None of them contains simulation code.

## 2. Module map

Every directory under `src/` is a module with one owner and a README (`src/<module>/README.md`). A module may import only the modules in its "may import" column; [`tests/boundaries.test.ts`](../tests/boundaries.test.ts) enforces this, and only `src/host` may import `node:` built-ins.

| Module | What it owns | Key files | May import |
|---|---|---|---|
| `src/core` | the contract in code: shared types and interfaces, constants, deterministic maths, the Philox RNG, hashes, structure-of-arrays pools and column layouts, world allocation and the state hash, and every codec (genome format, CBOR, view protocol, `.ptk` container, `.ptkg`) | `types.ts`, `contract.ts`, `constants.ts`, `dmath.ts`, `rng.ts`, `hash.ts`, `soa.ts`, `layout.ts`, `world.ts`, `genome-schema.ts`, `genome-format.ts`, `protocol.ts`, `container.ts`, `ptkg.ts`, `cbor.ts` | nothing |
| `src/genome` | `GenomeModule`: development (genome to `Phenotype`), mutation, crossover, repair, distance, templates, species registry, phylogeny, innovation registry, genome store, names | `develop.ts`, `mutate.ts`, `crossover.ts`, `repair.ts`, `distance.ts`, `species.ts`, `templates.ts`, `names.ts`, `store.ts`, `registry.ts` | core |
| `src/physics` | `PhysicsModule`: bodies from the Phenotype, joints and muscles, drag and added mass, the exact tree joint solve, contacts, bites, grabs and latches, `powerW`, the exploit watchdog, swimmer cards | `segment-spec.ts`, `body.ts`, `solver.ts`, `tree.ts`, `contacts.ts`, `links.ts`, `watchdog.ts`, `card.ts` | core, genome |
| `src/brain` | `BrainModule`: the brain layout from the grown body, direct and CPPN wiring, class pools, perception (`sense`), the CTRNN and oscillator tick (`think`), the inspector frame, behaviour templates | `layout.ts`, `develop.ts`, `cppn.ts`, `pool.ts`, `sense.ts`, `think.ts`, `inspect.ts`, `templates.ts` | core, genome |
| `src/ecosystem` | `EcosystemModule`: terrain, flow, light, temperature, oxygen, scents, producers, nutrient cycling, metabolism, feeding, digestion, growth, reproduction requests, ageing, carcasses, disease, every god power's effect, nature mode, safety valves, metrics, the ledger and its audit | `terrain.ts`, `flow.ts`, `env.ts`, `transport.ts`, `producers.ts`, `metabolism.ts`, `disease.ts`, `god.ts`, `valves.ts`, `metrics.ts`, `ledger.ts` | core, genome |
| `src/sim` | `SimCore`: world creation, the tick pipeline, the journal, the birth and death commit, slot allocation and compaction, view frames, the protocol session, the wall-clock pacer and speed leases, the worker entry and the view-side links; local fallback modules | `index.ts`, `commit.ts`, `requests.ts`, `state.ts`, `store.ts`, `species.ts`, `persist.ts`, `frames.ts`, `session.ts`, `pacer.ts`, `worker.ts`, `client.ts`, `runner.ts`, `detectors.ts`, `fallback/` | core, genome, physics, brain, ecosystem |
| `src/render` | `RendererModule` in WebGL2: frame decoding, five LOD tiers, SDF bodies, glow, trails, bloom, tonemapping, dither, the three-layer flash defence, per-mode profiles | `index.ts`, `gl.ts`, `shaders.ts`, `lod.ts`, `pose.ts`, `template.ts`, `archetypes.ts`, `colour.ts`, `safety.ts` | core, genome |
| `src/director` | the camera director (StoryBook, scoring with exposure memory, shots, springs, van Wijk zoom paths, dips, caption text) and the idle drift | `director.ts`, `storybook.ts`, `exposure.ts`, `motion.ts`, `drift.ts`, `captions.ts`, `replay.ts` | core |
| `src/audio` | generative Web Audio ambience and a deterministic offline renderer for tests | `composer.ts`, `theory.ts`, `webaudio.ts`, `offline.ts` | core |
| `src/ui` | the view shell for every mode, captions, the god window, the designer, the library and sharing, localisation, the host-first link and an in-page mock sim | `index.ts`, `link.ts`, `mock-sim.ts`, `captions.ts`, `i18n.ts`, `god/`, `designer/` | core, genome, render, director, audio, `sim/client` only |
| `src/host` | the Node host: HTTP and WebSocket server, security and pairing, per-client interest and streaming, god-command intake, the journal, `.ptk` persistence, recovery, migrations, throttle states, the governor, detectors, the CLI | `main.ts`, `index.ts`, `world-host.ts`, `snapshot.ts`, `store.ts`, `interest.ts`, `commands.ts`, `security.ts`, `throttle.ts`, `scheduler.ts`, `detectors.ts`, `summary.ts`, `gpu.ts` | core, genome, sim |
| `web/` | the HTML entry pages and the bootstrap (`main.ts` reads the mode and calls `bootView`) | `index.html`, `wallpaper.html`, `screensaver.html`, `tv.html`, `god.html`, `main.ts` | ui, core |
| `site/` | the public GitHub Pages site: landing page, embedded demo, creature share page | `index.html`, `share.html`, `src/`, `build.mjs` | core, genome, ui |
| `packaging/` | Lively package, `.scr` screensaver and tray app (Rust), portable Windows zip, Android TV notes | `lively/`, `screensaver/`, `tray/`, `windows/` | none (build artefacts only) |
| `tools/` | `evolab` (headless evolution lab: toy and real-sim runs, detectors, PNG charts, Morris and CMA-ES tuning) and `integration` (scripts that run the real modules together) | `evolab/evolab.mjs`, `integration/run.mjs` | anything |
| `tests/` | cross-module tests: contract, determinism lint, boundaries, golden hashes, per-module suites, end-to-end browser checks | `*.test.ts`, `e2e/`, `core/` | anything |

The four simulation modules plug into the sim through the interfaces in [`src/core/contract.ts`](../src/core/contract.ts):

```ts
interface GenomeModule    { develop; mutate; crossover; repair; distance; template }
interface PhysicsModule   { loadBody; restage; step }
interface BrainModule     { layout; allocate; free; sense; think; rehydrate? }
interface EcosystemModule { initWorld; flowAt; stepEcology; stepSlow; applyGodEvent; audit }
interface SimCore         { create; step; hash }
```

`createSim(modules)` in `src/sim/index.ts` builds a `SimCore` from any set of these; a module left out is replaced by its stand-in in `src/sim/fallback/`, so modules can be swapped in one at a time.

## 3. World state

A `World` (`src/core/world.ts`) is plain data: a config, a preset, a globals record and typed-array pools.

- **Structure of arrays.** Each pool is one `ArrayBuffer` cut into one typed array per column, declared as data in `src/core/layout.ts` (`CREATURE_COLUMNS`, `SEGMENT_COLUMNS`, the brain pool columns, `FIELD_COLUMNS`). You read creature `k`'s heading as `world.cr.c.heading[k]`, and lane `j` of a multi-lane column as `world.cr.c.out[k * 8 + j]`. A GPU backend will map the same columns to storage buffers.
- **Pools.** `world.cr` (creatures), `world.seg` (body segments; a creature owns the contiguous range `[segStart, segStart + segCount)` in parent-first order, so segment `i` is part `i` of its Phenotype), `world.brains` (one pool per size class C0 to C4), and `world.fields` (coarse 0.25 m, fine 1/16 m and terrain grids, plus floor columns).
- **Slots.** Every pool loops `0 .. highWater` and skips slots whose `life` is `FREE`. Slots are allocated lowest-free-first; a reused slot bumps its `gen`. Entity ids are a separate, never-reused world counter.
- **Globals.** `world.g` holds `tick`, `epoch`, the seed, `nextEntityId`, `ySurface`, the geological reservoir, the conserved mass total, the brain rate divisor, live, carcass and egg counts, the active god-event modifiers and the flow-mode amplitudes.
- **Outside the SoA.** The genome store (content-addressed genome blobs), the species registry, the innovation registry, the request queues and the journal are JavaScript objects kept per world by `src/sim/state.ts`. `exportSimState` and `adoptWorld` save and restore them with a snapshot.
- **The state hash.** `hashWorld(world)` is xxh64 over the globals, every column of every pool in declared order (only the live range) and every field grid. `sim.hash` is exactly this; `stateDigest` additionally covers the non-SoA state.

## 4. The tick pipeline

One tick is `DT = 1/30 s` of sim time on every machine. Throttling changes how many ticks run per wall second, never `DT`. `src/sim/index.ts` runs, in this order:

```
0. journal       apply every journal entry due at this tick, in scheduling order:
                 god events (ecosystem.applyGodEvent, then a 'god' event),
                 governor decisions (brain rate divisor, population soft limit), releases
1. sense         brain.sense: write each brain's inputs from the world as it is now
2. think         brain.think: CTRNN and oscillator update, outputs to the creature 'out'
                 lanes and the segment 'cmd', 'cmd2' and 'cmd3' commands
2b. actuate      sim: NaN outputs become 0; every output and command is clamped to [-1, 1]
3. physics       physics.step: substeps (4, 8 or 16), joints, muscles, drag, contacts,
                 bites, grabs and latches; writes pose, velocities, powerW, work, touch
4. ecology       if tick % 3 == 0 (10 Hz): ecosystem.stepEcology (feeding, digestion,
                 metabolism, growth and restage, reproduction requests, ageing, deaths,
                 field reactions and transport), then commitBirthsAndDeaths
5. slow          if tick % 15 == 0 (2 Hz): ecosystem.stepSlow (flow modes, light, temperature)
6. advance       tick += 1; a hash checkpoint every 256 ticks when enabled
```

Notes that matter when you change any of it:

- **Births and deaths are batched.** Requests made during ticks `t-2 .. t` are committed at the end of ecology tick `t`: deaths first (in entity-id order), then empty carcasses freed, then births in `(parentEntityId, tick, requestIndex)` order. Each birth runs the genome operators (keyed by the child's new entity id), `develop`, `physics.loadBody` and `brain.allocate`, and pays its cost from the parent's reproductive reserve. A birth that would overflow the agent cap or a pool is deferred, never dropped. Details: [modules/sim.md](modules/sim.md).
- **Governors** (adaptive decisions that change results, such as the brain rate) may decide only on ticks with `tick % 300 == 0`, from measurements taken before that tick, and are journalled. Replay applies the journalled decision and never re-measures.
- **Detectors** (hunts, schools, giants, mass deaths and so on) run outside the step, in the host and in `src/sim/detectors.ts`. They read the world and never write it.
- **Ecology staggering.** Inside `stepEcology` and `stepSlow` the ecosystem spreads its 2 Hz field work over three phases on different ticks, so no single tick carries it all ([modules/ecosystem.md](modules/ecosystem.md), decision 1).

## 5. Data flow: from the sim to the screen and back

### 5.1 Pages and links

`web/main.ts` reads the mode from the page (`<html data-mode>`) or `?mode=` and calls `bootView(mode)` in `src/ui/index.ts`, which creates a canvas, the renderer, a sim link and a camera, then runs the frame loop at the mode's frame cap. The link is chosen by `chooseLink`:

1. `?host=ws://...` connects to that host.
2. A page served from the host's own port (47615) connects to `/ws/v1` on it.
3. `?sim=mock`, or the god page with no host, uses `MockSimLink`, a practice world inside the page.
4. `wallpaper.html` uses `HostFirstLink`: the local host first, the dream-tank worker after 2 s of silence, and back to the host when it answers.
5. Otherwise `WorkerLink` starts `sim-worker.js`, which runs a `SimSession` and a `Pacer` over the default sim.

### 5.2 Frames

Every link carries the binary frames of CONTRACT 12 (codecs in `src/core/protocol.ts`): an 8-byte header (type, flags, version, low 32 bits of the tick) and a payload.

| Direction | Frames |
|---|---|
| view to sim | HELLO (view mode, capabilities, viewport, god token), VIEWPORT (at most 10 Hz, when the camera moves), ACK (2 Hz), COMMAND (god commands, CBOR), GENOME_REQ |
| sim to view | WELCOME (tank, palette, species, scopes), BODY_ENTER and BODY_LEAVE (which creatures are drawn as bodies, with their genome keys), BODY_FRAME (10-byte quantised records per body), NEAR_POSE (joint angles for close-ups), DUST_FRAME (specks), GLOW_FIELD (the far haze), FIELDS (environment grids), ENV (day, year, light, surface), CENSUS (species counts, 1 Hz), EVENT (the event channel, CBOR), STATS and INSPECT (god scope), COMMAND_RESULT, GENOME |

Slots in BODY and DUST frames are stable per client, so the renderer interpolates each slot between frames. A view renders 150 to 250 ms behind the newest frame. Bodies are not sent as shapes: a view fetches the genome by its key and regrows the body locally with the same `develop()` the sim uses.

### 5.3 In the host

`src/host/main.ts` (the CLI) builds a `HostWorld` (`world-host.ts`), which loads or creates the world and recovers it from disk, then `startHost` (`index.ts`) serves the pages and `/ws/v1`. Per tick batch:

- `scheduler.ts` paces ticks by completion at the speed the throttle state and the current speed lease allow.
- `interest.ts` classifies creatures per client (projected size at least 4 px: body; 0.5 to 4 px: dust; smaller: glow), keeps stable slot maps and builds that client's frames. Flow control halves rates for a slow client.
- `detectors.ts` turns primitive events into derived ones (giant, record, endangered, extinction, mass death, hunt, migration, school, carcass, frenzy), at most 20 per second per client.
- `commands.ts` validates god commands field by field, rate-limits them, checks the epoch, converts the 3 s or 1 s lead into a fire tick at the achieved speed, takes a `beforePower` snapshot for major powers, and journals the command.
- `security.ts` binds to 127.0.0.1 unless `--lan`, checks the Host and Origin headers, and hands out scopes: loopback views get `view`; `god` needs the god token printed at start-up; paired LAN devices get `view`.

### 5.4 In the view

`src/render` decodes frames into GPU buffers and draws, per frame: the water background (depth light, shafts, the far haze), marine snow, SDF bodies into separate reflected and emitted buffers, specks and light organs, reprojected trails, bloom, then a composite with tonemapping and blue-noise dither, under the per-mode flash limits. `src/director` turns the event stream and census into a camera for the screensaver and TV; `drift.ts` gives the wallpaper its idle drift. `src/audio` maps the census and events onto the ambience. `src/ui/god` turns frames into the god window's state and sends commands with an id and the epoch it last saw.

## 6. Determinism rules

Phylotank replays exactly: same seed, same journal, same build gives the same state hash, on any machine and any JavaScript engine. Crash recovery, golden tests and bug reports all depend on it. The rules (CONTRACT 4.2) bind `src/core`, `src/genome`, `src/physics`, `src/brain`, `src/ecosystem` and `src/sim`:

1. **Time comes only from the tick.** No wall clock in sim code. Outside inputs (god commands, releases, governor decisions) enter only through the journal, stamped with the tick they apply to.
2. **No platform randomness.** Every random draw comes from `src/core/rng.ts`: Philox4x32-10, counter-based, keyed by the world seed and a stream id (`RNG_STREAM` in `constants.ts`), with the counter `(tick, subject, drawIndex)`. A typical draw is `ctx.rng.draw(RNG_STREAM.MUTATION, ctx.tick, childEntityId).u01()`. There is no shared mutable RNG state, so the order in which subjects draw does not matter. Stream ids of 100 and above are for views only and must never feed the sim.
3. **No platform transcendentals.** `Math.sin`, `cos`, `tan`, `exp`, `log`, `pow`, `atan`, `atan2`, `tanh`, `sinh`, `cosh`, `asin`, `acos`, `hypot`, `cbrt`, `expm1`, `log1p`, `log2` and `log10` differ between engines. Use `src/core/dmath.ts` (`exp`, `log`, `sin`, `cos`, `tan`, `atan`, `atan2`, `tanh`, `pow`, `sigmoid`, `wrapAngle`, `hypot2`), built only from exactly specified IEEE-754 operations.
4. **Fixed iteration order.** Process slots in ascending order. Any "nearest K" breaks ties by `(distance squared, slot)`. Every sort has a total-order comparator. Never iterate a `Map`, `Set` or object keys to produce sim results when their insertion order could depend on anything non-deterministic; maps for lookups are fine.
5. **Integer accumulators for scatter-adds.** Wherever a GPU would add in parallel (contact corrections, feeding demand, deposits), accumulate in fixed point or exact integers so the order of additions cannot change the result.
6. **Floats are stored deterministically.** Compute in f64, store to `Float32Array` where the column is f32; positions are f64 on the CPU backend.
7. **Governors decide on governor ticks only** and are journalled (section 4).

`tests/determinism-lint.test.ts` scans the sim directories for `Math.random`, `Date`, `performance.now`, timers, `crypto` randomness, the banned transcendentals and `.sort()` without a comparator. Three files that pace or transport the sim but never compute it are exempt: `src/sim/pacer.ts`, `src/sim/worker.ts` and `src/sim/client.ts`. The views (`render`, `director`, `audio`, `ui`) are not linted, but the director and audio are written as pure functions of their inputs and seeds so they can be tested by replay.

Determinism is checked, not assumed: the golden one-hour hash in `tests/sim-acceptance.test.ts`, golden template phenotypes in `tests/genome.test.ts`, same-seed runs in the per-module suites, and cross-engine checks in Node and Chromium (`tests/e2e/brain-crossengine.cjs`, `tests/genome-chromium.cjs`).

## 7. Conservation: the mass and energy ledger

Every conserved pool (dissolved nutrient, detritus, plankton, mats, sediment, cysts, the reservoir, and each creature's tissue, reserve, reproductive reserve and gut) is a whole number of quanta of `Q_MASS = 1e-12 kg`, held as exact integers in `Float64Array`. Matter moves only by `ledger.transfer` between pools; real-valued amounts become integers through per-creature carries. Energy is not stored at all: it is derived from mass, with a fixed energy factor per pool class times `E_B = 4,000 J/kg`, so it cannot drift. The world total changes only through logged `inject` and `remove` calls (god powers, leviathan endowments).

`ecosystem.audit(world)` checks the total by integer equality, every ecology tick in tests. If you add a pool or a flow, it must go through the ledger, and the audit must stay exact. CONTRACT 9 has the formulas: the bridge rule from food to reserve, Kleiber metabolism with an Arrhenius temperature factor, the cost of repair (lifespan is bought), Gompertz ageing, the per-offspring overhead and the agent-cap fee.

## 8. Persistence and recovery

- **Files.** A world is a directory of `.ptk` snapshots (a 64-byte header, a section table and sections such as `META`, `GLOB`, `CREA`, `SEGS`, `BRN0` to `BRN4`, `FLDS`, `EVTQ`, `SIMS`, each with its own xxh64) and journal files (`u32 length, u32 crc32, CBOR` records, flushed per record). Container code: `src/core/container.ts`; world encoding: `src/host/snapshot.ts`; directory and retention: `src/host/store.ts`.
- **Cadence.** Autosave every 10 minutes (6 kept), daily (7 kept), before every major power and every rewind (20 each, 7 days), on shutdown, and manual snapshots forever, within 10 GB.
- **Recovery.** On start the host loads the newest snapshot that verifies, then replays every later journal file of the same epoch, checking each journalled state hash, and stops at the first mismatch. Replay is exact only for the same build, which the header's `simHash` records.
- **Migrations.** `src/host/migrations.ts` holds a chain of schema migrations (empty at schema 1). Columns are matched by name, so adding a column is forward compatible.
- **Designs** are `.ptkg` containers (`src/core/ptkg.ts`): magic `PTK`, a CBOR `{meta, genome}` payload, CRC-32; or the same bytes as a `PTK1.` base64url string.

## 9. How to add a gene

Genes are data in the genome schema, so adding one is mostly a table edit plus the code that gives it meaning. A gene changes the contract, so it goes in one commit with the contract text and the contract test.

1. **Pick a slot.** Trait block v1 (`TRAT`) reserves indices 52 to 63 and 75 to 95; BrainTraits (`BTRT`) reserves 15, 25 to 31, 44 to 47 and 86 to 95. Never reuse or reorder an index: old genomes must still decode.
2. **Add the row** to `traitList` (or the brain trait list) in `src/core/genome-schema.ts` with `t(idx, 'NAME', min, max, scale, default, dist, group)`. `scale` is `lin`, `log` or `int`; `dist` says whether it counts in the species distance (look-only and neutral markers should not); `group` places its slider in the designer (`hidden` puts it under Advanced).
3. **Choose a neutral default.** Forward-compatibility rule 5: a new gene's default must leave every existing genome's phenotype and behaviour unchanged. Old genomes are padded with the default on read.
4. **Document it** in the trait table in [CONTRACT.md](CONTRACT.md) section 6.3 (or 6.7) and update `tests/contract.test.ts`, which checks the table against the schema and that every `T.*` and `BT.*` name used anywhere in `src` exists.
5. **Give it meaning** in the module that owns the effect, reading it by name: `trait(g, T.NAME!)` in `src/genome` (body and life history; add it to `TI` in `src/genome/genes.ts` if the genome module uses it often), the per-creature trait cache that `loadCreature` fills in `src/ecosystem/metabolism.ts` (feeding, metabolism, life history, health), `src/brain/traits.ts` (BrainTraits), or `src/render/colour.ts` for look genes. Only deterministic maths in sim code (section 6).
6. **Mutation and crossover** already cover every trait in x space (`q / 65535`), scaled by the creature's own `MU_LOG` and `SIGMA`. Mark a gene `immutable` only if a lineage must never change it (like `ENCODING`).
7. **The designer** generates its sliders from `TRAITS` and `BRAIN_TRAITS`, so the new gene appears in its group with no UI code. Add a translation key if its name needs a friendlier label.
8. **Test it**: a unit test for its effect; the golden template phenotypes in `tests/genome.test.ts` and the golden one-hour hash in `tests/sim-acceptance.test.ts` must not change (if they do, your default is not neutral).

A new **module field** or **part kind** works the same way, in the record layouts of `src/core/genome-schema.ts` (CONTRACT 6.4 to 6.6); new fields are appended, never inserted, and old records of the shorter size take the defaults.

## 10. How to add a god power

A power is an id, a rule for when it is major, an effect in the ecosystem and a spec in the god window.

1. **The id.** Add it to `POWER_IDS` in `src/core/types.ts`, and to `isMajorPower` if it can be major (anything that permanently changes the world, kills many creatures or cannot be undone except by rewind). Update the `PowerId` list and the major rules in CONTRACT 13. If nature mode may cast it, it belongs in `NATURE_POWERS`, which never holds a major power.
2. **The effect** goes in `src/ecosystem/god.ts`: an envelope (attack, sustain, release in sim seconds) for timed powers, the instant effect at the fire tick in the `applyGodEvent` switch, and any lasting modifier in the modifier switch (temperatures add, rates multiply, everything clamps to physical limits). Rules:
   - Draw randomness only from `RNG_STREAM.GOD`, keyed by the event's own seed.
   - Every gram it adds or removes goes through `inject` or `remove` in `src/ecosystem/ledger.ts` (and is logged as an event), or moves between pools by `transfer`; the audit must stay exact.
   - Creatures it spawns go through the sim's birth requests; creatures it kills become carcasses through the death requests, never by clearing slots.
   - Anything persistent (a terrain patch, a modifier) must be in the world state or `EVTQ`, so it survives a snapshot.
3. **Validation and lead time** need no change: `src/host/commands.ts` and `src/sim/session.ts` accept any id in `POWER_IDS`, apply the 3 s or 1 s lead from `isMajorPower`, and snapshot before major powers.
4. **The god window.** Add a `PowerSpec` to `POWER_SPECS` in `src/ui/god/powers.ts` (targeting, radius, how intensity maps to a shown effect, duration range, glyph) and its strings in `src/ui/i18n.ts`, in English and Swedish. The palette shows `PALETTE_POWERS`, currently the core 12.
5. **Views.** The `god` event reaches every view; the director scores it as a disaster and captions it. If the power has its own visual (a streak, a shimmer), it belongs in the renderer, respecting the wallpaper's gentle mode and the flash limits.
6. **Test it**: the effect and the exact audit in `tests/ecosystem.test.ts`; that it replays bit for bit from its seed; in `tests/ui.test.ts`, that it is major or minor as intended and that a major cast snapshots before its fire tick.

## 11. Where things stand

The modules are built and tested separately; the integration that wires them into one running sim is under way.

- `createSim()` with no arguments, which the dream tank and the host use, still runs the local fallbacks in `src/sim/fallback/` for genome, physics, brain and the creature life cycle: one-capsule budding creatures with an exact ledger. The real `src/genome`, `src/physics`, `src/brain` and `src/ecosystem` modules plug in through `createSim({ genome, physics, brain, ecosystem })` (see [modules/sim.md](modules/sim.md)); `node tools/integration/run.mjs tools/integration/try.ts` runs a world with the real genome, physics and brain modules.
- The golden one-hour hash belongs to the fallback modules and will be re-recorded when the real modules are swapped in.
- The god window runs against its in-page practice world by default; against a host it watches only, until it sends the god token.
- The screensaver and TV views do not yet feed events to the director.
- The GPU backend is a spike result, not code: everything runs on the CPU reference backend.

Each module's README lists what it has done and what is left.
