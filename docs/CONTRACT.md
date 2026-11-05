# Phylotank interface contract (v0.x)

Status: binding from phase 0, 2026-11-05. Owner: lead engineer (`src/core`).

This is the single source of truth for every interface that crosses a module boundary. Where it disagrees with [DESIGN.md](DESIGN.md) or an appendix in [sections/](sections/), **this document wins**; where it is silent, DESIGN.md applies. It resolves review blockers R1 (one contract) and R2 (the leviathan path) in sections 3.3 and 9, and the majors that touch shared state (R8, R10, R11, R16, R21, R26) in the sections named against them.

Every number here has a matching constant in `src/core/constants.ts` (or a schema table in `src/core/genome-schema.ts`, `src/core/layout.ts`, `src/core/protocol.ts`). The test `tests/contract.test.ts` checks that the two agree for the values marked with a dagger (†). Changing any of them is a contract change: edit this file, the constant, and the test in one commit, and say why in the message.

Conventions in this document: "q" means a quantised integer field; "LE" means little-endian; `u8, i8, u16, i16, u32, i32, u64, f32, f64` are the usual machine types; ranges are inclusive.

---

## 0. Contents

1. Units and the mass quantum
2. Coordinates, angles and the body frame
3. Time, tank presets and the size ceiling
4. Randomness and determinism rules
5. World state: the structure-of-arrays layout
6. Genome binary format v1
7. The developed body (Phenotype)
8. Brains: I/O channels, runtime layout and the brain tick
9. The mass and energy ledger, the bridge rule, ageing, reproduction and the agent-cap tax
10. The tick pipeline and system interfaces
11. Events
12. Sim-to-view protocol v1 (binary frames)
13. God commands
14. File formats: `.ptk` worlds and `.ptkg` designs
15. View modes
16. Module boundaries and ownership
17. Spikes and how their results change this contract

---

## 1. Units and the mass quantum

- **SI everywhere** in the sim: metres, kilograms, seconds, joules, watts, newtons, radians. Temperatures are stored in °C and converted to kelvin (`T + 273.15`) only inside the Arrhenius factor.
- **Mass quantum `Q_MASS = 1e-12 kg` (1 ng)** †. Every conserved mass pool (fields, creature tissue, reserves, guts, carcasses, eggs, sediment, reservoir) is an integer number of quanta.
  - On the CPU backend quanta are held in `Float64Array` as exact integers. Integers below `2^53` are exact in f64, so the world total must stay below `2^53` quanta, about **9,007 kg** (`MAX_WORLD_MASS_KG`) †. The Large preset with leviathan endowments stays far below that (section 3.3).
  - On a GPU backend (later), totals are u64 emulated as two u32 words, accumulated with `atomicAdd` on the low word and a carry into the high word when the returned old value plus the addend wraps. Addition is commutative, so the result is order-independent. Per-creature per-tick deltas may be i32 in units scaled to that creature's mass (review R8), but every pool total is a u64 of `Q_MASS`.
  - Why 1 ng and not the 1e-10 kg of DESIGN R14: the smallest adult (0.5 mm, about 4 µg) eating at its doubling rate gains about 0.13 quanta of 1e-10 kg per ecology tick, which rounds to zero (review R8). At 1 ng it gains about 13 quanta and the carry (section 9.1) handles the rest.
- **Display unit "mu"** = the mass of the 1 cm isometric reference body, `M_REF_1CM = 3.1e-5 kg` †. Never used in sim arithmetic.
- **Reference body mass** (for thresholds, not physics): `m_ref(L) = 31 kg * (L / 1 m)^3` †. A 0.5 mm body is about 3.9e-9 kg, 20 cm is 0.25 kg, 1 m is 31 kg.
- **Energy** is joules, but every energy stock is *derived from mass* (section 9.2), so energy is conserved exactly by construction.
- Fields that are signals, not matter (scent channels, light, temperature anomaly, turbidity, oxygen, vent sulphur) are f32 in their own units and are not in the mass ledger.

## 2. Coordinates, angles and the body frame

- **World axes**: x to the right, **y downwards**, y = 0 at the nominal water surface. The live surface is `world.ySurface` (an ice age lowers the water, so `ySurface > 0`). The tank spans `0 <= x <= W`, `0 <= y <= H` (section 3.2).
- **Angles**: radians, positive from +x towards +y, which is **clockwise on screen**. A heading of 0 faces +x. Angles are wrapped to `(-pi, pi]` when stored.
- **Body frame** (DESIGN R8): `u` from 0 (snout) to 1 (tail tip) along the main axis; `v` in-plane from -1 (ventral) to +1 (dorsal); `d` along a limb from 0 (base) to 1 (tip). For a creature with heading `h` and mirror sign `s` (+1 or -1), the forward unit vector is `f = (cos h, sin h)` and the dorsal unit vector is `n = s * (sin h, -cos h)`. With `h = 0, s = +1`, dorsal points up the screen (-y). A creature turning round can either swim upside down or perform a **roll** (`s := -s`), which is the global `ROLL` brain output (section 8.2); physics owns the roll mechanics.
- **Paired lateral appendages** are one physics part with doubled span (module flag `PAIRED`), drawn as a near copy and a dimmer, slightly offset far copy.
- **Out of plane**: every part has a span `h` (metres) out of the plane. Mass and fluid forces use it; this is the "2.5D" model, so mass scales as length cubed.
- **Screen space** (views only): the camera maps world metres to device pixels with zoom `zeta = log2(pixels per metre)`. The whole Default tank across 3840 px is `zeta = log2(3840/64) ≈ 5.9`.

## 3. Time, tank presets and the size ceiling

### 3.1 Clocks

| Constant | Value | Notes |
|---|---|---|
| `TICK_HZ` † | 30 | one sim tick is `DT = 1/30 s` on every machine (DESIGN R9) |
| `DT` † | 1/30 s | throttling changes ticks per wall second, never `DT` |
| `ECO_EVERY` † | 3 | ecology runs on ticks with `tick % 3 == 0` (10 Hz, `DT_ECO = 0.1 s`) |
| `SLOW_EVERY` † | 15 | flow, light, temperature on `tick % 15 == 0` (2 Hz) |
| `CENSUS_EVERY` | 30 | census and stats, 1 Hz |
| `METRICS_EVERY` | 1800 | ecosystem metrics, every 60 sim s |
| `HASH_EVERY` † | 256 | state hash journalled every 256 ticks |
| `GOVERNOR_EVERY` † | 300 | governors may change decisions only on these ticks (section 4.4) |
| `DAY_S` † | 1200 | sim day (36,000 ticks) |
| `YEAR_DAYS` † | 20 | sim year |
| brain rate | 30 Hz | brains tick every sim tick; the governor may set a divisor of 2 or 3 (section 8.4) |
| physics substeps | 4 to 16 | per creature, at least 4 when any muscle is active (review R6, section 10.3) |

`tick` is a non-negative integer held in a JS number (exact to 2^53). It is a u64 in files and events; high-rate wire frames carry its low 32 bits (section 12.1).

### 3.2 Tank presets (DESIGN R1, R6)

All presets are 16:9. Grids are row-major with `index = iy * w + ix`, y down.

| Preset | Tank W x H (m) | Coarse grid (0.25 m) | Fine grid (1/16 m) | Terrain SDF (0.125 m) | Agent cap `N_max` | CPU-backend cap | `M_target` (kg) | Size ceiling `L_ceiling` |
|---|---|---|---|---|---|---|---|---|
| Small | 32 x 18 | 128 x 72 | 512 x 288 | 256 x 144 | 16,384 | 4,096 | 100 | 0.126 m |
| Default | 64 x 36 | 256 x 144 | 1024 x 576 | 512 x 288 | 131,072 | 8,192 | 400 | 0.2 m |
| Large | 128 x 72 | 512 x 288 | 2048 x 1152 | 1024 x 576 | 262,144 | 8,192 | 1,600 | 0.317 m |

- Segment pool capacity is `SEG_PER_AGENT = 12` † times the agent capacity; a birth that would overflow either pool is deferred (section 9.6).
- `M_target` replaces the 2e6 mu of 04 §4.10 (which is 62 kg). It is sized so that 10 adults at the ceiling hold under 1% of the world mass while the producer base is 50 to 100 times larger (review R2). The tuning range is x0.25 to x4.
- The browser "dream tank" (v0.1 standalone) uses Small on the CPU backend with the 4,096 cap.

### 3.3 The size ceiling and leviathans (resolves review R2)

William's answer (DESIGN §10): relative giants of about 20 cm on the Default budget, plus leviathans he designs and releases, refined by evolution afterwards.

- **Schema range.** The genome trait `ADULT_LENGTH` keeps the range **0.5 mm to 1 m** (log scale) in format v1 (`L_MIN = 0.0005`, `L_MAX = 1.0`) †. This is the 2,000x span; the ceiling below is a world parameter, not a schema change.
- **Evolved ceiling.** `L_ceiling = 0.20 m * (M_target / 400 kg)^(1/3)` (table above). For a genome **without** the leviathan flag:
  - mutation and crossover clamp the stored `ADULT_LENGTH` q so the decoded value is at most `L_ceiling`;
  - `develop()` clamps the expressed adult length to `L_ceiling` (this covers imported genomes; the import UI lists the clamp as a warning).
- **Leviathan flag** = genome header flag bit 3 (`GENOME_FLAG_LEVIATHAN`). It is set only by an explicit god-window release with "Release as leviathan" confirmed (a major action: hold to confirm plus an automatic snapshot). Flagged genomes may mutate `ADULT_LENGTH` anywhere in the schema range. The flag is inherited by budding, and in sexual reproduction from the bearer (the parent whose structure the child takes, 01 §1.7.3).
- **Endowment.** A leviathan release brings its own food web: it adds `K_ENDOW * n * m_adult` of nutrient mass (`K_ENDOW = 8`) † from outside the world into the dissolved pool `N`, and raises `M_target` by the same amount, both logged as a god event. The world refuses (with a reason, never a crash) an endowment that would take `M_total` above `0.8 * MAX_WORLD_MASS_KG`.
- **Thresholds are relative to the ceiling.** "Giant" for the director and stats: length at least `0.6 * L_ceiling` (`G_REL = 0.6`) or above the 99.5th percentile of adult lengths. Physics' "always full tier" threshold is `0.5 * L_ceiling`. Leviathans (flagged) are always giants.
- **Pace.** Kleiber exponent 0.75 everywhere (William's Q2). The "run at max until ..." lease (section 13) is the only way the world runs fast unattended; it is never silent.

## 4. Randomness and determinism rules

### 4.1 RNG

- **Philox4x32-10** (Random123), counter-based, identical in TS and later in WGSL. There is no shared mutable RNG state anywhere in the sim.
- **Key** = `[seedLo ^ streamId, seedHi]` where the world seed is a u64 `(seedHi, seedLo)`. **Counter** = `[tick >>> 0, subjectLo, subjectHi, drawIndex]`. `subject` is the entity id (or a cell index, or 0 for world-level draws), `drawIndex` counts 4-word blocks drawn by that subject in that tick for that stream. One call returns 4 u32 words.
- Conversions (in `src/core/rng.ts`): `u01(w) = (w >>> 8) * 2^-24` (24-bit, in [0, 1)); `u01_53(w0, w1)` for f64; `normal()` by Box-Muller using the deterministic math of 4.3.
- **Stream ids** (`RNG_STREAM` in `constants.ts`) †: 1 WORLDGEN, 2 MUTATION, 3 CROSSOVER, 4 BIRTH, 5 BRAIN_NOISE, 6 SENSOR_NOISE, 7 DEVELOPMENT, 8 PHYSICS, 9 ECOLOGY, 10 AGEING, 11 DISEASE, 12 GOD, 13 NATURE, 14 SPECIES, 15 GOVERNOR, 16 SKELETON. Ids 100 and above are view-only (render, director, audio) and must never feed the sim.
- The counter's tick field wraps after 2^32 ticks (about 4.5 years at 30 Hz); a world older than that changes its seed epoch (`seedHi ^= epochOfWrap`), recorded in META.

### 4.2 Determinism rules (binding for `src/core`, `genome`, `physics`, `brain`, `ecosystem`, `sim`)

1. Fixed `DT`; wall-clock time never enters a sim function. Inputs from outside (god commands, governor decisions, releases) enter only through the journal, stamped with the tick they apply to.
2. No `Math.random`, `Date`, `performance.now`, timers, `crypto.getRandomValues`, or iteration over `Map`/`Set`/object keys whose insertion order depends on non-deterministic events, in sim code. `tests/determinism-lint.test.ts` enforces the banned identifiers.
3. **No platform transcendental functions in sim code**: `Math.sin, cos, tan, exp, log, pow, atan, atan2, tanh, sinh, cosh, asin, acos, hypot, cbrt, expm1, log1p, log2, log10` are banned. Use `src/core/dmath.ts`, built only from IEEE-754 `+ - * /`, `Math.sqrt`, `Math.floor`, `Math.abs`, `Math.min`, `Math.max`, `Math.round`, `Math.trunc`, `Math.sign`, `Math.fround`, which are exactly specified. This makes the CPU backend bit-identical on every conforming JS engine (Node, Chrome, WebView2, Android WebView).
4. **Iteration order**: entities are processed in ascending slot index. Slots are allocated lowest-free-first. Neighbour lists (spatial hash) are ordered by `(cellKey, slot)`; any "nearest K" selection breaks ties by `(distance squared, slot)`. Sorting uses `Array.prototype.sort` with a total-order comparator only (V8's sort is stable).
5. **Scatter-adds use integer accumulators** wherever a GPU would parallelise them (contact corrections, feeding demand, deposits): fixed-point in `Int32Array` or exact-integer `Float64Array`, so the CPU result is the one a GPU port must reproduce. Position corrections: units of `2^-20` m; impulses: units of `2^-16 * m_seg * 1 m/s` (02 §2.7.7).
6. **Births and deaths** requested during a tick are committed at the end of the next ecology tick in `(parentEntityId, requestIndex)` order (section 9.6). Entity ids come from the world counter `nextEntityId` and are never reused.
7. **Float storage**: values computed in f64 and stored into `Float32Array` round deterministically. Positions are f64 on the CPU backend (section 5).
8. Hash maps used for lookups are fine; hash maps iterated to produce sim results are not.

### 4.3 Deterministic math (`src/core/dmath.ts`)

Exports `exp, log, sin, cos, tan, atan, atan2, tanh, pow, sigmoid, wrapAngle, hypot2`, plus `PI, TAU, LN2`. Accuracy target: relative error under 1e-14 on the reduced ranges, about 1e-12 for `|x| < 1e4` in trig. These are not required to equal `Math.*`; they are required to be the same on every engine, which they are by construction.

### 4.4 Governors (review R16)

Any adaptive decision that changes sim results (brain rate divisor, substep policy, population soft limits, budget mode) is made only on ticks with `tick % GOVERNOR_EVERY == 0`, from measurements taken before that tick, and is written to the journal as `{kind: 'governor', tick, decision}`. Replay applies the journalled decision, never re-measures. Render-side and stream-side governors (frame rate, LOD caps, bitrate) are free, since they never change the sim.

### 4.5 State hash

`hashWorld(world)` = xxh64 over, in order: the globals record (section 5.6) encoded canonically, then every SoA column of every pool in the declared column order (only the live range `[0, highWater)`), then every field grid. Journalled every `HASH_EVERY` ticks. The golden-replay test compares it bit for bit.

## 5. World state: the structure-of-arrays layout

The CPU backend holds state in TypedArrays, one array per column, allocated from one `ArrayBuffer` per pool by `allocPool(spec, capacity)` in `src/core/soa.ts`. Column names, types and lane counts are declared as data in `src/core/layout.ts`; this section lists them. A GPU backend maps the same columns (same names, same slot indices) to storage buffers, packing several columns into 16-byte-aligned structs by access pattern (02 §2.9); the column list is the contract, the packing is the backend's business. Exceptions on GPU: `posX/posY` become an i32 Q16.16 anchor per creature plus f32 offsets per segment (02 §2.7.6), and quanta become u64-as-two-u32.

Slot `0` of every pool is valid (there is no null slot); "none" is encoded as `0xFFFFFFFF` in u32 references and `-1` in signed ones. `highWater` is one past the highest slot ever used, so loops run `0..highWater` and skip slots whose `life == FREE`.

Type codes used below: `f64, f32, u32, i32, u16, i16, u8, i8`. "xN" means N lanes stored contiguously per slot (`array[slot * N + lane]`).

### 5.1 Creature pool (`CREATURE_COLUMNS`, capacity = agent capacity)

| Column | Type | Meaning | Writer |
|---|---|---|---|
| `idLo`, `idHi` | u32 | entity id (u64, also exposed as a JS number) | sim |
| `gen` | u16 | slot generation, +1 on every reuse | sim |
| `life` | u8 | 0 FREE, 1 ALIVE, 2 EGG, 3 CARCASS | sim, ecosystem |
| `flags` | u32 | `CF_*` bits: 0 LEVIATHAN, 1 SESSILE_ATTACHED, 2 LATCHED, 3 MATING, 4 EATING, 5 HURT, 6 INFECTED, 7 JUVENILE, 8 FOUNDER, 9 FOUNDER_PROTECTED, 10 BUDDING, 11 FRAGMENT, 12 DESIGNED | various |
| `species` | u32 | species id | genome (via sim) |
| `genome` | u32 | handle into the host genome store (section 6.8) | sim |
| `birthTick` | f64 | tick of birth (eggs: of laying) | sim |
| `posX`, `posY` | f64 | root segment centre, world metres | physics |
| `velX`, `velY` | f32 | centre-of-mass velocity, m/s | physics |
| `heading` | f32 | root segment angle, rad | physics |
| `angVel` | f32 | rad/s | physics |
| `mirror` | i8 | +1 or -1 (section 2) | physics |
| `segStart` | u32 | first segment slot | sim |
| `segCount` | u16 | number of segments | sim |
| `tier` | u8 | 0 full, 1 reduced (reserved; v0.x is always 0) | physics |
| `nSub` | u8 | substeps this tick (4, 8 or 16) | physics |
| `length` | f32 | current body length, m | ecosystem (growth) |
| `adultLength` | f32 | expressed adult length after the ceiling clamp | sim |
| `maturity` | f32 | 0 birth to 1 adult | ecosystem |
| `stage` | u16 | growth stage index (restage at each 4% length change) | ecosystem |
| `massKg` | f32 | cached total mass, derived from the ledger columns | ecosystem |
| `qTissue` | f64 | structural tissue, quanta | ecosystem |
| `qReserve` | f64 | energy reserve, quanta (energy = q * Q_MASS * E_B) | ecosystem |
| `qRepro` | f64 | reproductive reserve, quanta | ecosystem |
| `qGut` | f64 x3 | gut contents: lane 0 plant, 1 meat, 2 detritus | ecosystem |
| `carry` | f64 x4 | fractional carries in [0, 1): lane 0 burn, 1 intake, 2 growth, 3 excretion (section 9.1) | ecosystem |
| `anaerobic` | f32 | A / A_max, 0 to 1 | ecosystem |
| `health` | f32 | 0 dead to 1 whole | physics, ecosystem |
| `lifespan` | f32 | `t_life` in sim seconds (section 9.4) | sim |
| `tMature` | f32 | time to maturity in sim seconds | sim |
| `reproTimer` | f32 | seconds until the next clutch is allowed | ecosystem |
| `tempC` | f32 | local water temperature | ecosystem |
| `oxygen` | f32 | local O2, 1 = saturation | ecosystem |
| `powerW` | f32 | active power demanded this tick: muscles, cilia, jets, bladder, light organs | physics |
| `brainW` | f32 | brain running cost, constant per brain (section 8.5) | brain |
| `brainClass` | u8 | 0 to 4 (C0 to C4), 255 none | brain |
| `brainSlot` | u32 | slot in the class pool, `0xFFFFFFFF` none | brain |
| `out` | f32 x8 | global brain outputs in channel order (section 8.2) | brain |
| `infStrain` | u32 x2 | infection slots, `0xFFFFFFFF` empty | ecosystem |
| `infLoad` | f32 x2 | load 0 to 1 | ecosystem |
| `immuneKey`, `surfaceSig`, `immuneMemory` | u32 | disease keys (from the genome KEYS section; memory acquired) | sim, ecosystem |
| `glow` | f32 | current whole-body emission 0 to 1, after the brain and the baseline glow | ecosystem |
| `colour` | u32 | packed RGBA8 body colour for far LOD (from the look traits) | sim |
| `trophic` | f32 | trophic level EMA | ecosystem |
| `diet` | f32 x7 | intake EMA: phyto, mat, plantCreature, detritus, carcass, livePrey, host | ecosystem |
| `generation` | u32 | 0 for founders and releases, else `1 + max(parent generations)` (phase 2, request EV2) | sim |
| `workJ` | f32 | cumulative positive muscle work over life, J (phase 2, request EV3) | physics |
| `biteCooldown` | f32 | s until the next bite (phase 2, request P1) | physics |
| `wdE0`, `wdIn` | f64 | exploit watchdog: water-frame energy at window start (-1 unset), work in during the window, J (P1) | physics |
| `wdTicks` | u16 | watchdog ticks into the window (P1) | physics |
| `brainStage` | f64 | maturity of the phenotype the brain was built from, so a snapshot load rebuilds the same brain (B2) | sim |
| `birthY` | f64 | depth at birth, m: the `DEPTH_AT_BIRTH` axis of every later develop (restage, rehydrate) | sim |

### 5.2 Segment pool (`SEGMENT_COLUMNS`, capacity = `SEG_PER_AGENT` x agent capacity)

A creature owns the contiguous range `[segStart, segStart + segCount)` in parent-first (BFS) order, so segment `k` of a creature is part `k` of its Phenotype (section 7). Re-staging may move a creature's range (the sim compacts on births).

| Column | Type | Meaning | Writer |
|---|---|---|---|
| `owner` | u32 | creature slot | sim |
| `parent` | i16 | local parent index, -1 for the root | sim |
| `kind` | u8 | part kind (section 6.4) | sim |
| `organs` | u16 | organ flags (section 7.2) | sim |
| `posX`, `posY` | f64 | segment centre, world metres | physics |
| `angle` | f32 | world angle of the segment axis, rad | physics |
| `velX`, `velY`, `angVel` | f32 | | physics |
| `len`, `radius`, `span` | f32 | geometry at the current stage, m | physics (from Phenotype) |
| `mass`, `inertia` | f32 | kg, kg m^2 (rescaled so the creature's segment masses sum to its ledger mass) | physics |
| `attachU` | f32 | attachment point on the parent, -0.5 to 0.5 of its length | physics |
| `restAngle`, `limitLo`, `limitHi` | f32 | joint, rad, relative to the parent | physics |
| `compliance`, `damping` | f32 | XPBD bend compliance (1/k), damping ratio | physics |
| `tauMax`, `omegaMax` | f32 | muscle torque cap N m, max shortening rate rad/s | physics |
| `cmd` | f32 | muscle command u in [-1, 1] from the brain (0 if no muscle channel) | brain |
| `act` | f32 | muscle activation a after the lag | physics |
| `cmd2` | f32 | second channel: fin pitch, or the organ drive (cilia, jet, bladder, gland, grip, photophore intensity) | brain |
| `work` | f32 | positive muscle work this tick, J | physics |
| `touch` | f32 | contact force magnitude this tick, N | physics |
| `damage` | f32 | 0 to 1 | physics |
| `drag` | f32 x5 | `k_t1, k_n1, k_t15, k_t2, k_n2` (02 §2.7.2) | physics |
| `glow` | f32 | current photophore emission 0 to 1 | ecosystem |
| `cmd3` | f32 x2 | MOUTH parts: lane 0 BITE (jaws, rasp), lane 1 LATCH (proboscis, suction); unused elsewhere (phase 2, requests P2 and B1). GRIP on CLAW parts stays on `cmd2` | brain |
| `subtype` | u8 | the Phenotype's part subtype (mouth kind) (P2) | physics (from Phenotype) |
| `muscleFrac` | f32 | muscle fraction of the part, isometric cost `m_mus = muscleFrac x mass`, init 0.3 (P1) | physics (from Phenotype) |
| `restPrev` | f64 | rest angle at the end of the last tick, restage blends from it (P1) | physics |
| `restInit`, `biteArmed` | u8 | restPrev valid; bite hysteresis armed (P1) | physics |

### 5.3 Brain pools (one per size class, section 8.3)

Per class `c` with limits `(N_c, I_c, K_c)` and capacity `B_c`:

| Column | Type | Shape | Meaning |
|---|---|---|---|
| `owner` | u32 | B | creature slot, `0xFFFFFFFF` free |
| `nIn`, `nNeu` | u16 | B | used inputs and neurons |
| `inputs` | f32 | B x I | input values written by `sense` |
| `y` | f32 | B x N | neuron state |
| `o` | f32 | B x N | neuron output this tick |
| `oPrev` | f32 | B x N | output last tick |
| `theta`, `alpha` | f32 | B x N | bias; leak `1 - exp(-dt_brain / tau)` |
| `phase`, `phaseOff` | f32 | B x N | oscillator phase and innate-gait offset (0 for non-oscillators) |
| `nKind` | u8 | B x N | neuron kind (section 8.3) |
| `synSrc` | u16 | B x K x N | source index, **slot-major** `[brain][k][neuron]` |
| `synW` | f32 | B x K x N | weight (f16-packed on GPU) |
| `synDw` | f32 | B x K x N | plastic delta (allocated only for plastic pools) |
| `synMeta` | u8 | B x K x N | bits 0-1 rule, bit 2 plastic, bits 3-6 eta code |
| `osc` | f32 | B x N x 4 x 3 | oscillator couplings `(srcNeuron, k, lag)` x 4 |
| `fBand` | f32 | B x 2 | oscillator band `fLow, fHigh`, Hz |

Default capacities as a fraction of the agent capacity: C0 60%, C1 25%, C2 12%, C3 4%, C4 1% (and at least 16 each). A class that is full sends a brain to the next larger class; if all are full the birth is deferred.

### 5.4 Field grids (`FIELD_COLUMNS`)

Coarse grid `w x h` (0.25 m), fine grid `4w x 4h` (1/16 m), SDF grid `2w x 2h` (0.125 m), floor columns `w`.

| Field | Grid | Type | Meaning |
|---|---|---|---|
| `qN` | coarse | f64 | dissolved nutrient, quanta per cell |
| `qD` | coarse | f64 | suspended detritus, quanta per cell |
| `qP` | fine | f64 | phytoplankton, quanta per cell |
| `qBphoto`, `qBchemo` | fine | f64 | benthic mats, quanta per cell |
| `qSed`, `qCyst` | floor | f64 | sediment and dormant cysts per floor column |
| `o2` | coarse | f32 | 1 = saturation at 15 °C |
| `sulphur` | coarse | f32 | vent chemistry (energy only) |
| `tAnom` | coarse | f32 | temperature anomaly, °C |
| `turb` | coarse | f32 | turbidity |
| `light` | coarse | f32 | photosynthetic light 0 to 1 |
| `flowU`, `flowV` | coarse | f32 | water velocity, m/s, at cell centres |
| `scent` | coarse | f32 x8 | channels 0 plant, 1 blood/meat, 2 toxin, 3 alarm, 4 to 7 pheromones A to D |
| `sdf` | SDF | f32 | signed distance to rock, m (negative inside rock) |
| `material` | SDF | u8 | 0 water, 1 rock, 2 sand, 3 mud, 4 reef, 5 vent, 6 ice, 7 crater glass |

Transport is conservative: every flux between two cells is quantised to integer quanta (the real flux plus a deterministic dither from the ECOLOGY stream keyed by face index) and applied antisymmetrically, so mass moves without loss.

### 5.5 Other pools

- **Spores** (pathogen particles, later): capacity 65,536; columns `posX, posY: f64`, `strain: u32`, `load: f32`.
- **Strains**: capacity 4,096; the 04 §4.6 `Strain` record as columns.
- The genome store, species registry, lineage, gene bank and journal are host-side JS structures (section 6.8, 16), not SoA.

### 5.6 Globals record (`WorldGlobals`)

`tick` (number), `epoch` (u32, +1 on every rewind), `seedLo`, `seedHi` (u32), `nextEntityId` (number), `preset`, `ySurface` (m), `qReservoir` (f64, geological reservoir), `mTotalQ` (f64, the conserved total in quanta), `mTargetQ` (f64), `brainDiv` (1, 2 or 3), `liveCount`, `carcassCount`, `eggCount` (u32), `modifiers` (active god-event envelopes, section 13), `flowModes` (f32 x8, current mode amplitudes and their OU state).

## 6. Genome binary format v1

Owner of the format: `src/core/genome-format.ts` (codec) and `src/core/genome-schema.ts` (tables). Owner of the meaning (development, mutation, crossover, distance): `src/genome`.

### 6.1 Container

All multi-byte fields are LE. A genome is a 32-byte header followed by **tagged sections**. Hard cap 16 KB (`GENOME_MAX_BYTES = 16384`) †; typical 1.5 to 4 KB.

**Header (32 B)**

| Off | Type | Field | Notes |
|---|---|---|---|
| 0 | u32 | magic | bytes `P T G 1` (0x31475450) |
| 4 | u16 | formatVersion | 1 |
| 6 | u16 | flags | bit0 DESIGNED, bit1 EDITED, bit2 HAS_SILENT, bit3 LEVIATHAN (section 3.3); others 0 and preserved |
| 8 | u16 | nSections | |
| 10 | u16 | headerSize | 32; a reader skips to `headerSize` (forward compatibility) |
| 12 | u32 | totalLength | bytes including the header |
| 16 | u32 | rootModuleInnov | innovation id of the root module (the head segment) |
| 20 | u32 | crc32 | CRC-32 (IEEE) over the whole genome with this field set to 0 |
| 24 | u32 | reserved0 | 0 |
| 28 | u32 | reserved1 | 0 |

**Section (12 B header, then records)**

| Off | Type | Field |
|---|---|---|
| 0 | u32 | tag (four ASCII bytes, read as LE u32) |
| 4 | u16 | recordSize in bytes |
| 6 | u16 | sectionFlags (0 in v1) |
| 8 | u32 | count |
| 12 | count x recordSize | records, then zero padding to a 4-byte boundary |

**Forward-compatibility rules** (tested in `tests/genome-format.test.ts`):
1. Unknown section tags are kept verbatim and re-emitted after the known sections in their original relative order.
2. If `recordSize` is larger than the size this reader knows, each record's known prefix is decoded and the extra bytes are kept per record and re-emitted.
3. If `recordSize` is smaller (an older writer), missing fields take schema defaults.
4. Trait and BrainTrait blocks shorter than this reader's table are padded with defaults; longer ones keep the extra values.
5. A new gene's default must produce an identical phenotype (05 §5.4.5). New fields are appended, never inserted.

**Canonical form.** The encoder writes the known sections in the order of the table in 6.2, records sorted by innovation id ascending (CPPN genes by u64 innov), with no duplicates. `canonicalBytes(g)` = `encode(decode(bytes))`. The content key is `xxh64(canonicalBytes)` (seed 0); the user-facing fingerprint is the first 8 bytes of SHA-256 over the canonical bytes, shown as `3fa9-12c0-88e1-04bd` (DESIGN R22).

### 6.2 Sections in v1

| Tag | Record | Size | Max count | Content |
|---|---|---|---|---|
| `TRAT` | u16 | 2 | 96 in v1 | trait block, fixed index (6.3) |
| `KEYS` | u32 | 4 | 2 | `immuneKey`, `surfaceSig` |
| `MODL` | ModuleGene | 32 | 48 | body graph nodes (6.4) |
| `LINK` | LinkGene | 20 | 64 | body graph edges (6.5) |
| `REGU` | RegGene | 16 | 32 | Hox-like regulators (6.6) |
| `BTRT` | u16 | 2 | 96 in v1 | BrainTraits block (6.7) |
| `CPPN` | CppnNodeGene | 16 | 64 | CPPN nodes |
| `CPPC` | CppnConnGene | 32 | 192 | CPPN connections |
| `DNEU` | HiddenNeuronGene | 8 | 64 | direct-encoded hidden neurons |
| `DSYN` | DirectSynapseGene | 12 | 256 | direct synapses and CPPN overrides |

All sections are optional on read (defaults apply); the encoder always writes `TRAT`, `KEYS`, `MODL`, `LINK`, `BTRT`, and the rest when non-empty. With every section at its cap a genome is 14,624 bytes, under the 16 KB cap.

**Quantisation.** A u16 trait `q` has `x = q / 65535`; a u8 field has `x = q / 255`. `lin: v = min + x (max - min)`; `log: v = min * (max / min)^x`; `int: v = round(lin)`. Mutation works in x space (01 §1.6.1).

### 6.3 Trait block v1 (`TRAT`, u16 per trait)

Default values below are decoded values; the schema stores them as q. "Dist" marks traits counted in the species distance trait term (look-only and neutral markers are excluded, review R14).

| Idx | Name | Min | Max | Scale | Default | Dist |
|---|---|---|---|---|---|---|
| 0 | ADULT_LENGTH (m; clamped by section 3.3) | 0.0005 | 1.0 | log | 0.02 | yes |
| 1 | BIRTH_FRACTION (newborn length / adult) | 0.04 | 0.5 | log | 0.2 | yes |
| 2 | GROWTH_RATE | 0.2 | 5 | log | 1 | yes |
| 3 | MATURITY_FRACTION | 0.3 | 0.95 | lin | 0.7 | yes |
| 4 | LIFESPAN_MULT (x time to maturity; costs repair, 9.4) | 1.5 | 20 | log | 4 | yes |
| 5 | SENESCENCE (Gompertz sharpness, 9.4) | 0 | 1 | lin | 0.5 | yes |
| 6 | CLUTCH_SIZE | 1 | 64 | log (rounded) | 2 | yes |
| 7 | REPRO_RESERVE | 0.1 | 0.9 | lin | 0.5 | yes |
| 8 | SEX_PROB | 0 | 1 | lin | 0 | yes |
| 9 | MATE_PATIENCE (x t_mature) | 0.05 | 5 | log | 0.5 | yes |
| 10 | FAT_CAPACITY (reserve capacity, fraction of body mass) | 0.05 | 0.5 | lin | 0.3 | yes |
| 11 | BROOD_INTERVAL (x t_mature) | 0.05 | 2 | log | 0.3 | yes |
| 12 | IMMUNE_INVEST | 0 | 1 | lin | 0.2 | yes |
| 13 | O_CRIT (hypoxia tolerance) | 0.05 | 0.6 | lin | 0.2 | yes |
| 14 | SHELL (calcifying shell) | 0 | 1 | lin | 0 | yes |
| 15 | SESSILE (expressed when > 0.5) | 0 | 1 | lin | 0 | yes |
| 16 | MU_LOG (log10 per-gene point mutation chance) | -4 | -1 | lin | -2.3 | no |
| 17 | MU_STRUCT_RATIO | 0.02 | 1 | log | 0.2 | no |
| 18 | SIGMA (point step in x space) | 0.005 | 0.2 | log | 0.03 | no |
| 19 | MUSCLE_STRENGTH (sigma_mus, Pa) | 1e5 | 3e5 | log | 2e5 | yes |
| 20 | DIET_PLANT (enzyme simplex, 9.3) | 0 | 1 | lin | 0.7 | yes |
| 21 | DIET_DETRITUS | 0 | 1 | lin | 0.1 | yes |
| 22 | TEMP_OPTIMUM (°C) | 2 | 30 | lin | 14 | yes |
| 23 | TEMP_TOLERANCE (°C) | 1 | 15 | log | 6 | yes |
| 24 | FAST_FIBRE | 0 | 1 | lin | 0 | yes |
| 25 | TOXICITY | 0 | 1 | lin | 0 | yes |
| 26 | AEROBIC_SCOPE | 4 | 15 | log | 8 | yes |
| 27 | JOINT_DAMPING (zeta) | 0.05 | 0.5 | log | 0.15 | yes |
| 28 to 31 | BODY_HUE, BODY_SAT, BODY_LUM, TRANSLUCENCY | 0 | 1 | lin | 0.55, 0.4, 0.4, 0.6 | no |
| 32 | GLOW_HUE | 0 | 1 | lin | 0.5 | no |
| 33 | GLOW_BASE | 0 | 1 | lin | 0.3 | no |
| 34 | PULSE_FREQ (Hz; screen clamp per view, 15) | 0.05 | 4 | log | 0.3 | no |
| 35 | PULSE_SHAPE | 0 | 1 | lin | 0.5 | no |
| 36 to 38 | PATTERN_KIND (4 bins), PATTERN_FREQ, PATTERN_CONTRAST | 0 | 1 | lin | 0, 0.5, 0.2 | no |
| 39 | TRAIL_LENGTH (renderer only) | 0 | 1 | lin | 0.5 | no |
| 40 to 43 | ODOUR_A, ODOUR_B, ODOUR_C, ODOUR_D (pheromone emission and mate odour) | 0 | 1 | lin | 0.5 | no |
| 44 | PREF_GLOW_HUE (circular) | 0 | 1 | lin | 0.5 | no |
| 45 | PREF_HUE_WIDTH | 0.02 | 0.5 | log | 0.15 | no |
| 46 | PREF_SIZE_RATIO | 0.5 | 2 | log | 1 | no |
| 47 | PREF_PULSE | 0 | 1 | lin | 0.5 | no |
| 48 | PREF_ODOUR_WEIGHT | 0 | 1 | lin | 0.5 | no |
| 49 | CHOOSINESS (01 acceptance threshold) | 0 | 1 | lin | 0.3 | no |
| 50 | CILIA_SPEED | 0 | 1 | lin | 0.5 | yes |
| 51 | ALARM_EMIT | 0 | 1 | lin | 0.2 | yes |
| 52 to 63 | reserved | | | | 0 | |
| 64 | G_SLENDERNESS | 0.5 | 2 | log | 1 | yes |
| 65 to 69 | G_FIN, G_EYE, G_MOUTH, G_SPIKE, G_ARMOUR | 0.5 | 2 | log | 1 | yes |
| 70 | G_TAPER | 0.5 | 2 | log | 1 | yes |
| 71 | G_STIFFNESS | 0.5 | 2 | log | 1 | yes |
| 72 to 74 | G_PHOTOPHORE, G_GUT, G_LIMB_LENGTH | 0.5 | 2 | log | 1 | yes |
| 75 to 95 | reserved | | | | 0 | |

Retired relative to 01 (DESIGN R3, R10, R11): DIET, CARRION_TOLERANCE, DENSITY_BIAS, CPG_BASE_FREQ, BRAIN_TAU_SCALE, EXPLORATION_NOISE, GAIN_*, PLASTICITY_RATE. Behaviour genes live in BrainTraits (6.7).

### 6.4 ModuleGene (`MODL`, 32 B): one part type

| Off | Type | Field | Decoded |
|---|---|---|---|
| 0 | u32 | innov | historical marking |
| 4 | u8 | kind | 0 SEGMENT, 1 FIN, 2 LIMB, 3 MOUTH, 4 EYE, 5 CHEMO, 6 SPIKE, 7 PHOTOPHORE, 8 CILIA, 9 JET, 10 BLADDER, 11 GLAND |
| 5 | u8 | subtype | table below |
| 6 | u8 | flags | bit0 enabled, bit1 root, bit2 PAIRED (lateral pair, doubled span), bit3 CLAW (jointed limb tip that grips) |
| 7 | u8 | recursionLimit | 0 to 7 |
| 8 | u16 | length | log 0.05 to 4 x the parent's reference length |
| 10 | u16 | width | log aspect 0.05 to 2 (width / length) |
| 12 | u8 | span | log 0.5 to 8 (out-of-plane depth / width) |
| 13 | u8 | taper | 0 to 1, tip width / base width |
| 14 | u8 | stiffness | log 0.1 to 10; Young's modulus `E = 3e5 Pa x stiffness x G_STIFFNESS` (DESIGN R10) |
| 15 | u8 | lipidFraction | 0 to 0.6 (density 920 kg/m^3) |
| 16 | u8 | muscleFraction | 0 to 0.8 |
| 17 | u8 | gutFraction | SEGMENT only, 0 to 0.7 of volume |
| 18 | u8 | armourCoverage | 0 to 1 |
| 19 | i8 | hueOffset | -0.5 to 0.5 added to BODY_HUE |
| 20 | u8 | glow | resting surface glow 0 to 1 |
| 21 to 22 | u8 | p1, p2 | kind-specific (below) |
| 23 | u8 | cpgPhase | innate-gait phase 0 to 2 pi (DESIGN R4) |
| 24 | u8 | cpgAmp | innate-gait amplitude 0 to 1 (weight of the swim reflex into this part's muscle) |
| 25 | u8 | jointRange | 0 to 170 degrees |
| 26 | i8 | jointRest | -90 to 90 degrees |
| 27 | u8 | allometry | exponent 0.5 to 1.5 (128 is 1.0) |
| 28 to 30 | u8 | p3, p4, p5 | kind-specific (below) |
| 31 | u8 | photoFraction | photosynthetic tissue fraction 0 to 1 |

| Kind | Subtypes | p1 | p2 | p3 | p4 | p5 |
|---|---|---|---|---|---|---|
| SEGMENT | 0 trunk, 1 head (holds the brain), 2 bell | lateral-line density | touch density | | | |
| FIN | 0 paddle, 1 fringe, 2 fluke | ray stiffness | | | | |
| LIMB | 0 jointed, 1 tentacle, 2 whip | tip stickiness | | | | |
| MOUTH | 0 FILTER, 1 JAWS, 2 RASP, 3 PROBOSCIS, 4 SUCTION (DESIGN R12) | gape (x head width) | mesh (filter) | bite cooldown | latch strength | |
| EYE | 0 cup, 1 lens | radius | field of view 10 to 360 degrees | receptor count 1 to 16 | spectral: bits 0-2 blue, 3-5 green, 6-7 red | acuity vs sensitivity |
| CHEMO | 0 pit, 1 antenna, 2 barbel | antenna length | channel mask (8 scent channels) | pheromone tuning, 2 bits x 4 | | |
| SPIKE | 0 straight, 1 hooked | length | | | | |
| PHOTOPHORE | 0 spot, 1 strip, 2 lure | size | pulse multiplier | | | |
| CILIA | 0 patch | coverage | beat speed | | | |
| JET | 0 bell | bell volume (0 to 0.3 of body volume) | | | | |
| BLADDER | 0 gas | volume | rigid fraction | | | |
| GLAND | 0 toxin, 1 ink | volume | | | | |

`brainChannel` and `channelSign` from 01 are retired (DESIGN R4); `density` is replaced by `lipidFraction` (DESIGN R10).

### 6.5 LinkGene (`LINK`, 20 B): "attach child type to parent type"

| Off | Type | Field |
|---|---|---|
| 0 | u32 | innov |
| 4 | u32 | fromInnov (parent module) |
| 8 | u32 | toInnov (child module; may equal fromInnov for recursion) |
| 12 | u8 | attachPos (0 base to 255 tip of the parent) |
| 13 | i8 | attachAngle (-180 to 180 degrees, 1.41 degree steps) |
| 14 | u8 | repeat (1 to 16 copies in series) |
| 15 | u8 | symmetry: 0 none, 1 mirror (dorsal-ventral, DESIGN R8), 2 radial |
| 16 | u8 | childScale (log 0.25 to 2) |
| 17 | u8 | repeatScale (log 0.7 to 1.3) |
| 18 | u8 | flags: bit0 enabled, bit1 terminalOnly, bit2 phaseWave |
| 19 | u8 | phaseStep (0 to 2 pi per repeat) |

### 6.6 RegGene (`REGU`, 16 B)

| Off | Type | Field |
|---|---|---|
| 0 | u32 | innov |
| 4 | u32 | targetInnov (0 = every module of targetKind) |
| 8 | u8 | targetKind (255 = every kind) |
| 9 | u8 | axis: 0 AP, 1 DV (was SIDE), 2 MATURITY, 3 DEPTH_AT_BIRTH |
| 10 | u8 | param: ModuleGene byte offset to modulate, or 254 = gate expression |
| 11 | u8 | shape: 0 gaussian, 1 rising sigmoid, 2 falling sigmoid, 3 band |
| 12 | u8 | centre 0 to 1 |
| 13 | u8 | width 0.01 to 1 |
| 14 | i8 | amount: log factor -1 to 1, or the sign of gating |
| 15 | u8 | flags: bit0 enabled |

### 6.7 BrainTraits v1 (`BTRT`, u16 per entry) and the brain genes

`ENCODING` selects how the substrate (section 8.1) is wired: **0 = direct** (reflexes, innate gait, oscillators and `DSYN` genes; the v0.1 default, review R15), **1 = CPPN** (DESIGN R3: the CPPN wires the substrate, `DSYN` genes act as overrides). It is immutable under mutation; a lineage keeps its encoding. Spike 8 decides which encoding new templates use (section 17).

| Idx | Name | Min | Max | Scale | Default |
|---|---|---|---|---|---|
| 0 | ENCODING | 0 | 1 | int, immutable | 0 |
| 1 | HEAD_HIDDEN | 0 | 64 | int | 8 |
| 2 | HIDDEN_PER_SEGMENT | 0 | 8 | int | 1 |
| 3, 4 | OSC_PER_SEGMENT, OSC_PER_FIN (on when > 0) | -1 | 1 | lin | 0.5 |
| 5, 6 | F_LOW, F_HIGH (Hz) | 0.1 | 6 | log | 0.5, 3 |
| 7 | PLASTICITY_ON (on when > 0) | -1 | 1 | lin | -0.5 |
| 8 | ETA_SCALE | 0 | 1 | lin | 0.3 |
| 9 | TAU_FORGET (s) | 10 | 86400 | log | 600 |
| 10 | SENSOR_NOISE | 0 | 0.1 | lin | 0.02 |
| 11 | TAU_SCALE | 0.25 | 4 | log | 1 |
| 12 to 14 | GAIN_VISION, GAIN_LATERAL, GAIN_CHEMO | 0.25 | 4 | log | 1 |
| 15 | reserved | | | | |
| 16 to 24 | REFLEX_SWIM, _STARTLE, _GRAZE, _BITE_ON_TASTE, _AVOID_WALL, _REPRODUCE, _HUNGER_SEEKS, _FEAR_FLEES, _INNATE_GAIT | -2 | 2 | lin | 1 |
| 25 to 31 | reserved | | | | |
| 32 | BOLDNESS | -1 | 1 | lin | 0 |
| 33 | ACTIVITY | 0 | 1 | lin | 0.5 |
| 34 | EXPLORATION | 0 | 0.3 | lin | 0.05 |
| 35 | SOCIALITY | -1 | 1 | lin | 0 |
| 36 | AGGRESSION | -1 | 1 | lin | 0 |
| 37 | APPETITE | 0 | 1 | lin | 0.5 |
| 38 | PATIENCE | 0 | 1 | lin | 0.5 |
| 39 | CHRONOTYPE | -1 | 1 | lin | 0 |
| 40 | PREF_DEPTH | 0 | 1 | lin | 0.3 |
| 41 | RISK_AVERSION | 0 | 1 | lin | 0.5 |
| 42 | LIGHT_SHOW | 0 | 1 | lin | 0.3 |
| 43 | INDIVIDUALITY | 0 | 0.3 | lin | 0.05 |
| 44 to 47 | reserved | | | | |
| 48 to 63 | RULE0_A .. RULE3_D (4 rules x A, B, C, D) | -1 | 1 | lin | 0 |
| 64 to 67 | RULE0_CH .. RULE3_CH (0 m+, 1 m-, 2 constant) | 0 | 2 | int | 2 |
| 68 to 85 | DRIVE_{HUNGER, FEAR, LIBIDO, FATIGUE, AGGRESSION, SOCIALITY} x {BIAS (-2..2 lin, 0), TAU (0.5..600 s log, 10), GAIN (0.25..4 log, 1)} | | | | |
| 86 to 95 | reserved | | | | |

**CppnNodeGene (16 B)**: `u64 innov`, `u8 fn` (0 lin, 1 tanh, 2 sin, 3 gauss, 4 abs, 5 step), `u8 flags` (bit0 enabled), `i16 bias` (Q4.11), `u32 reserved`.
**CppnConnGene (32 B)**: `u64 innov`, `u64 from`, `u64 to`, `i16 w` (Q4.11), `u8 flags` (bit0 enabled), `u8 reserved`, `u32 reserved`. CPPN innovation ids are 64-bit hashes without a registry (DESIGN R16): connection `hash64(from, to)`, node from splitting `c` `hash64(c, k)` with `k` the number of earlier splits of `c` in this genome.
**HiddenNeuronGene (8 B)**: `u32 innov`, `u8 tau` (log 50 ms to 120 s), `u8 flags` (bit0 enabled), `i16 bias` (Q4.11). Its neuron key is `hash32(innov, 0, 0xFF)`.
**DirectSynapseGene (12 B)**: `u32 src` (neuron key), `u32 dst` (neuron key), `i16 w` (Q4.11), `u8 flags` (bit0 enabled, bit1 modulatory, bit2 per-instance), `i8 plasticity`. A key is a **module key** `hash32(moduleInnov, 0, slot)` that applies to every instance of that module (so a duplicated fin arrives wired, which is the benefit the review wanted from fixed slots), or, with bit2, an **instance key** `hash32(moduleInnov, instancePathHash, slot)`. `hash32` is defined in `src/core/hash.ts` (murmur3 finaliser chain).

### 6.8 Innovation ids and the genome store

- Body and regulatory genes use the world registry (01 §1.3.7) with u32 ids; ids 1 to 4,095 are reserved for templates. **Duplication is keyed by `(srcInnov, paralogCount)`** where `paralogCount` counts existing copies of `src` in this genome, so a second duplication gets a new id instead of being dropped by repair (review R22). The registry window is 100,000 births; compaction runs when `next` passes 2^31, with the overflow estimate recomputed at the default 0.25 structural events per birth.
- The host genome store holds immutable blobs keyed by xxh64 in RAM; snapshots store a parent-diff forest (DESIGN R17). The creature column `genome` is a u32 handle into this store. GPU backends never see genomes.

## 7. The developed body (Phenotype)

`develop(genome, maturity, env) -> Phenotype` is pure and deterministic (owner `src/genome`; it runs in the sim, the host and the views). Physics reads it through `toSegmentSpecs()` (owner `src/physics`). The view regrows bodies with the same function (DESIGN R20).

### 7.1 Interface (`src/core/types.ts`)

```ts
interface Phenotype {
  nParts: number;                 // 1..MAX_PARTS (64; 32 on a laptop-host world) †
  // per part, parent-first BFS order; typed arrays of length nParts
  parent: Int16Array;             // -1 for the root
  kind: Uint8Array;               // ModuleGene kind
  subtype: Uint8Array;
  moduleInnov: Uint32Array;
  pathHash: Uint32Array;          // instance path hash (stable neuron ids)
  dv: Int8Array;                  // -1 ventral copy, 0 axial, +1 dorsal copy
  organs: Uint16Array;            // organ flags (7.2), including absorbed small organs
  attachU: Float32Array;          // on the parent, -0.5..0.5 of its length
  restAngle: Float32Array;        // rad, relative to the parent
  limitLo: Float32Array; limitHi: Float32Array;
  length: Float32Array; radius: Float32Array; span: Float32Array; taper: Float32Array; // m
  muscleFrac: Float32Array; lipidFrac: Float32Array; armour: Float32Array;
  youngsE: Float32Array;          // Pa
  damping: Float32Array;          // zeta
  u: Float32Array; v: Float32Array; d: Float32Array;   // body-frame coordinates of the part centre
  cpgPhase: Float32Array; cpgAmp: Float32Array;        // innate gait
  glow: Float32Array; hue: Float32Array;
  params: Float32Array;           // nParts x 5, decoded p1..p5
  // per body
  lengthM: number;                // current body length (root chain)
  adultLengthM: number;           // expressed, after the ceiling clamp
  maturity: number;
  massKg: number;                 // geometric mass at this stage
  gutVolume: number; gGut: number;   // m^3; gut length / body length in 0..1 (DESIGN R11)
  mouth: MouthDescriptor;         // 04 §4.5, from the MOUTH parts (DESIGN R12)
  handlingSize: number;           // body width + 2 x spike length
  buildCostKg: number;            // reserve mass needed to build this body from nothing (9.5)
  organList: OrganSpec[];         // for brain development (8.1)
}
interface OrganSpec { kind: OrganKind; part: number; u: number; v: number; d: number; params: number[] }
```

### 7.2 Organ flags (`ORGAN` bits, u16)

0 EYE, 1 CHEMO, 2 PHOTOPHORE, 3 CILIA, 4 JET, 5 BLADDER, 6 GUT, 7 GLAND, 8 CLAW, 9 MOUTH, 10 LATERAL_LINE, 11 TOUCH, 12 PAIRED, 13 HEAD (holds the brain), 14 SHELL, 15 PHOTOSYNTH.

EYE, CHEMO and PHOTOPHORE parts shorter than 2% of body length become organ flags on their host segment (DESIGN R10) and do not occupy a part; they still appear in `organList`.

### 7.3 Rules

- At most 64 parts (`MAX_PARTS`), BFS from the root, so when capped the distal parts go first. Development is O(parts + regGenes x parts).
- Growth: von Bertalanffy on a size-scaled clock (01 §1.4.4) with `KLEIBER_EXP = 0.75` †; a restage happens at each 4% change in length.
- Masses: capsule `V = pi r^2 l + 4/3 pi r^3`, `rho = (1 - f_lip - f_arm) 1060 + f_lip 920 + f_arm 2000` kg/m^3; fin plates `V = l s t` (02 §2.2.3).
- No design rules: a badly placed fin is legal. Only solver-safety clamps apply (01 §1.11.2).

## 8. Brains: I/O channels, runtime layout and the brain tick

Owner: `src/brain`. The substrate is the grown body (DESIGN §3.3): each organ contributes neurons.

### 8.1 Layout: `brain.layout(phenotype, genome) -> BrainLayout`

Deterministic, canonical ordering. Inputs come first in the source index space, then neurons.

**Inputs.** First the global block (always present, fixed indices) †:

| Index | Input | Encoding |
|---|---|---|
| 0 | BIAS | 1 |
| 1 | ENERGY | reserve / reserve capacity |
| 2 | GUT | fullness 0 to 1 |
| 3 | HEALTH | 0 to 1 |
| 4 | PAIN | `clamp(-dHealth/dt * 1 s, 0, 1)` |
| 5 | AGE | age / lifespan |
| 6 | MATURE | 0 or 1 |
| 7 | REPRO_LOAD | qRepro / clutch cost |
| 8 | TEMPERATURE | (T - TEMP_OPTIMUM) / TEMP_TOLERANCE, clamped to [-1, 1] |
| 9 | DEPTH | (y - ySurface) / H |
| 10 | LIGHT | local light 0 to 1 |
| 11 | SPEED | `tanh(|v_rel water| / (1 body length/s))` |
| 12 | DAY_SIN | sin of the day clock |
| 13 | DAY_COS | cos of the day clock |
| 14 | SEASON_SIN | sin of the year clock |
| 15 | SEASON_COS | cos of the year clock |
| 16 | FATIGUE | `1 - A / A_max` |
| 17 | ITCH | fraction of segments with a latched parasite |

Then, for each part in phenotype order, that part's inputs in this kind order, then slot order: EYE receptors (`R x (C + 1)`: per receptor the C sensitive colour bands then proximity), LATERAL (2: dorsal, ventral), TOUCH (2: dorsal, ventral), CHEMO level then rate per channel in the mask (ascending channel), TASTE_NUTRITION, TASTE_TOXIN, HOLDING (mouths), PROPRIO (joint angle, every non-root part with a joint), GLAND_FULL.

**Outputs.** First the global block (fixed indices; mirrored in creature column `out`) †:

| Index | Output | Range and effect |
|---|---|---|
| 0 | CPG_FREQ | -1..1 to `F = fLow + (fHigh - fLow) sigmoid(4 x)` |
| 1 | CPG_AMP | oscillator amplitude `sigmoid(4 x)` |
| 2 | CPG_TURN | turn signal added to muscles by `v` |
| 3 | MATE | willingness (trigger: on above 0.5, off below 0.2) |
| 4 | LAY_BUD | release a clutch when the reserve is full |
| 5 | EMIT_INTENSITY | whole-body emission above the baseline glow |
| 6 | EMIT_HUE | hue shift, at most 0.15 of the palette range |
| 7 | ROLL | roll over (`mirror := -mirror`), trigger with a 2 s cooldown |

Then, per part in phenotype order: MUSCLE (every non-root part with `muscleFrac > 0` or kind FIN) writes segment `cmd`; FIN_PITCH (FIN) writes `cmd2`; MOUTH_OPEN, BITE, LATCH (each MOUTH, in that order; LATCH only acts for PROBOSCIS and SUCTION mouths; MOUTH_OPEN writes `cmd2`, BITE and LATCH write `cmd3` lanes 0 and 1); then exactly one of PHOTO_INTENSITY, CILIA_DRIVE, JET_DRIVE, BLADDER_DRIVE, GLAND_RELEASE, GRIP when the part has that organ, writing `cmd2`.

```ts
interface IOChannel { kind: number; part: number /* -1 global */; slot: number; key: number /* stable id */ }
interface BrainLayout {
  inputs: IOChannel[];  outputs: IOChannel[];
  nNeurons: number;     neuronKind: Uint8Array;  neuronKey: Uint32Array;
  sizeClass: 0 | 1 | 2 | 3 | 4;
}
```

**Neurons**, in this order: one MOTOR neuron per output channel (motor `j` drives output `j`), the 6 DRIVE neurons (hunger, fear, libido, fatigue, aggression, sociality), the 2 MODULATOR neurons (pleasure, pain), OSCILLATOR neurons (by part order: one per segment if OSC_PER_SEGMENT, one per fin if OSC_PER_FIN), HEAD hidden (HEAD_HIDDEN), GANGLION hidden (HIDDEN_PER_SEGMENT per segment, by part), DIRECT hidden (DNEU genes by innov). Neuron kinds (u8) †: 0 MOTOR, 1 DRIVE, 2 MODULATOR, 3 OSCILLATOR, 4 HIDDEN_HEAD, 5 HIDDEN_GANGLION, 6 HIDDEN_DIRECT.

**Stable ids** = `hash32(moduleInnov, pathHash, slot)` (DESIGN R3); globals use `moduleInnov = rootModuleInnov`. A synapse source index is `inputIndex` for inputs and `nIn + neuronIndex` for neurons.

### 8.2 Size classes (03 §3.9.2) †

| Class | N max | I max | K (fan-in) |
|---|---|---|---|
| C0 | 16 | 32 | 8 |
| C1 | 32 | 64 | 8 |
| C2 | 64 | 96 | 16 |
| C3 | 128 | 160 | 16 |
| C4 | 256 | 192 | 16 |

A brain takes the smallest class where both N and I fit; if none fits, trim deterministically in this order: head hidden beyond 64, ganglion hidden from the tail forward, then merge eye receptors pairwise. Unused synapse slots are `src = own index, w = 0`.

### 8.3 The brain tick (canonical CPU reference; a GPU kernel must match)

Every sim tick for every brained creature whose `(slot + tick) % brainDiv == 0`, with `dt_b = brainDiv * DT`:

1. **sense** (`brain.sense`): write `inputs` from the world state as it is at the start of the tick, add sensor noise `N(0, SENSOR_NOISE)` from stream SENSOR_NOISE (counter subject = entity id, drawIndex = input index / 4).
2. **think** (`brain.think`), synchronous (Jacobi) update; all reads use `inputs` and `oPrev`:
   - for each neuron `i` in index order: `s = sum_{k=0..K-1} synW[k][i] * act(synSrc[k][i])` in increasing `k`, where `act(j) = inputs[j]` for `j < nIn`, else `oPrev[j - nIn]`;
   - non-oscillators: `y += alpha * (s + noise - y)`, clamp `y` to [-8, 8], `o = tanh(y + theta)` (noise `N(0, EXPLORATION)` for hidden and drive neurons only);
   - oscillators: `phase += dt_b * (2 pi F + s + sum_c k_c sin(phase[src_c] - phase - lag_c))` with F from `oPrev` of the CPG_FREQ motor, `o = Amp * sin(phase + phaseOff)`, Amp from the CPG_AMP motor;
   - any NaN resets that brain's `y`, `o` and `phase` to 0 and counts a diagnostic;
   - then `oPrev := o`.
3. **act**: output channel `j` takes `o[j]` (a motor neuron) and writes it to its destination (`out` lanes for globals, segment `cmd`, `cmd2` or `cmd3` for per-part). Outputs hold between brain ticks (zero-order hold).

Reflexes (03 §3.8.2) and the innate gait are synapses placed first in each neuron's slot list, scaled by their BrainTraits gains. Learned weights (`synDw`) are never inherited.

### 8.4 Brain rate

`brainDiv` is 1 (30 Hz) by default; the governor may set 2 or 3 only on governor ticks, journalled (section 4.4). `alpha` is recomputed for every brain when `brainDiv` changes.

### 8.5 Brain cost

`P_brain = e_n N + e_s S + e_p P` W, with `e_n = 2e-9`, `e_s = 2e-10`, `e_p = 1e-9` (initial values, tuned by `src/brain` with `src/ecosystem`), N non-input neurons, S non-padding synapses, P plastic synapses. Written once to `brainW`. Absolute, not proportional to body metabolism.

## 9. The mass and energy ledger

Owner: `src/ecosystem` (`ledger.ts`, `metabolism.ts`); physics supplies `powerW` and `work`, brains supply `brainW`. This section fixes DESIGN R5 (the bridge rule), review R8 (ranges), R10 (immortal blobs, jet blobs, clutch swarms) and R11 (the microbe flood).

### 9.1 Quanta, transfers and carries

- Every conserved pool is an integer count of `Q_MASS`. A **transfer** moves an integer number of quanta from one pool to another; there is no other way to change a pool. `ledger.transfer(from, to, q, channel)` is the only API, and it records the channel for the heat and flow statistics.
- A real-valued desired amount `a` (in quanta, computed in f64) becomes an integer with the creature's carry for that purpose: `t = a + carry[lane]; q = floor(t); carry[lane] = t - q`. Carries are bookkeeping, not mass. Transfers out of a pool are capped at what the pool holds; field exchange uses demand, resolve and collect (04 §4.4) with integer demands.
- The world invariant, checked exactly (integer equality, not a tolerance) by `ledger.audit()` on every ecology tick in tests and every 100 ecology ticks in production:

```
M_total = sum(qN) + sum(qD) + sum(qP) + sum(qBphoto) + sum(qBchemo) + sum(qSed) + sum(qCyst)
        + qReservoir + sum over creatures, eggs and carcasses (qTissue + qReserve + qRepro + qGut[0..2])
```

- `M_total` changes only through `ledger.inject(q, reason)` and `ledger.remove(q, reason)`, used by god powers and leviathan endowments and logged as events.

### 9.2 Energy is derived from mass (the bridge rule, exact)

Each pool class has an energy factor `f` (joules per kilogram of pool mass, in units of `E_B = 4000 J/kg` †):

| Pool | f | Pool | f |
|---|---|---|---|
| dissolved N, reservoir | 0 | tissue, reserve, repro, eggs, carcasses | 1.0 |
| phytoplankton P, mats, plant gut | 0.6 | meat gut | 1.0 |
| detritus D, sediment, cysts, detritus gut | 0.3 | | |

Energy stock = `sum(q * Q_MASS * f * E_B)`. Because energy is a function of the mass ledger, it cannot drift. Every transfer between classes with different `f` books heat (if `f` falls) or an energy input (if `f` rises: only photosynthesis and chemosynthesis may raise it). The rules:

- **Ingestion** moves food from a field or prey into the matching gut lane (same `f`, no heat).
- **Absorption** of `F` quanta from gut lane `k`: assimilation `a_k = a_max,k(g_gut) * e_k^1.3` (DESIGN R11: `a_max` from physics' gut table 02 §2.6.5, enzymes `e_k` from 9.3). Then `f_k * a_k * F` quanta go to the **reserve**, `(1 - f_k) * a_k * F` go to **dissolved N** at the creature's cell (excretion), and `(1 - a_k) * F` go to **detritus** as faeces, booking heat `(f_k - 0.3) * (1 - a_k) * F` if positive. Specific dynamic action: 10% of the absorbed reserve gain is burnt immediately.
- **Burning**: any power `P` (W) over `dt` burns `P dt / (Q_MASS * E_B)` quanta of reserve into dissolved N (heat, and consumes oxygen). So 1 kg burnt is 4,000 J of heat and 1 kg of dissolved nutrient.
- **Growth**: building `dm` of tissue costs `C_G = 1.4` † reserve per unit (neural tissue 2.0, armour 1.2 plus mineral from N): `dm` moves reserve to tissue and `0.4 dm` is burnt.
- **Starvation**: with the reserve empty, tissue is catabolised at efficiency 0.8: covering energy `E` moves `E / (0.8 E_B)` from tissue to the reserve, of which `0.2` is burnt (02 §2.6.8).
- **Death**: the creature's pools stay in its record, which becomes a CARCASS; carcasses leach to D and N (04 §4.4).

### 9.3 Enzyme simplex (DESIGN R11, UX diet triangle)

From traits `x1 = DIET_PLANT`, `x2 = DIET_DETRITUS`: `e_plant = x1 (1 - x2)`, `e_meat = (1 - x1)(1 - x2)`, `e_det = x2`. They sum to 1.

### 9.4 Basal metabolism, repair and ageing (fixes review R10: no free immortality)

- **Basal**: `B = B0 * m^0.75 * exp((E_a / k_B)(1/288.15 - 1/(T + 273.15)))`, `B0 = 0.3 W kg^-0.75`, `E_a = 0.65 eV` † (DESIGN R15: reference 15 °C), times `(1 + 0.15 * IMMUNE_INVEST)` and the thermal-breadth cost `(1 + 0.04 * max(0, TEMP_TOLERANCE - 3))`.
- **Repair (disposable soma)**: lifespan is bought. `t_life = LIFESPAN_MULT * t_mature`, and the creature pays a continuous repair power `P_repair = C_REP * B * (LIFESPAN_MULT - 1)`, `C_REP = 0.05` †. At the default multiplier 4 that is 15% of basal; at 20 it nearly doubles basal.
- **Ageing hazard** (Gompertz, normalised so the cumulative hazard at `t_life` is 1 whatever the shape): `G = 0.5 + 7.5 * SENESCENCE`, `h(t) = (G / t_life) * exp(G t / t_life) / (exp(G) - 1)` per second. On each ecology tick a living creature dies of age with probability `1 - exp(-h dt_eco)`, drawn from stream AGEING. Low SENESCENCE spreads deaths over life; high SENESCENCE concentrates them near `t_life`; **no setting is immortal and no setting is free**.
- **Starving repair**: while the reserve is empty, `P_repair` is not paid and `t` advances at 3x for the hazard (frailty).

### 9.5 Feeding limits (fixes review R10: jet-parked filter blobs)

- Filter intake is Holling type II: `J = J_raw / (1 + J_raw / J_max)` with `J_raw = filter * A_mouth * |v_rel| * C` (04 §4.5) and `J_max = J_MAX_BASAL * B / (f_food * E_B)` kg/s with `J_MAX_BASAL = 12` (8 before the integration balance pass: microbes could not cover basal, repair and pumping at 8; docs/spikes/integration-1.md).
- Filtering costs pumping power `P_pump = 0.5 * B * filter * mouthOpen`, added to `powerW` by physics.
- Sessile attachment (`SESSILE > 0.5`) is a physics state; an attached creature still pays drag work against the current through its holdfast as basal-scaled isometric cost (`kappa_iso` term, 02 §2.6.3).

### 9.6 Reproduction, per-offspring overhead and the agent-cap tax (fixes review R11)

- A clutch of `n` offspring of mass `m_o` costs, from `qRepro`: `n * (m_o * C_G + m_o * FAT_CAPACITY_0 + overhead_o) + fee * n`, where `FAT_CAPACITY_0 = 0.3` (starting reserve fraction), the **per-offspring overhead** is `overhead_o = 0.15 m_o + 1e-3 * M_REF_1CM + KAPPA_DNA * genomeBytes` (yolk and packaging, which stops clutch-64 swarms of tiny offspring, plus genome replication at `KAPPA_DNA = 2.6e-14 kg` per byte, which makes bloat cost something; phase 2, request G9), and the **cap fee** below is per offspring. If the parent cannot pay, the clutch shrinks to what it can afford, at least 1, or waits.
- **Agent-cap tax, additive and absolute** (not the multiplicative surcharge of 04 §4.7): with `n_agents = liveCount + eggCount + carcassCount` at the start of the tick,

```
s   = clamp((n_agents / N_cap - 0.5) / 0.5, 0, 1)
fee = K_CAP * M_REF_1CM * s^2         K_CAP = 1, so at most 3.1e-5 kg per offspring
```

  where `N_cap` is the world's agent capacity (preset cap, or the CPU-backend cap). The fee is burnt (heat to dissolved N), so mass is conserved. At 90% of the cap it is 0.64 x 3.1e-5 kg: about 600 times the body of a 2 mm microbe's newborn, but 8% of a 20 cm fish's newborn. Microbes therefore stop flooding the cap first while large, slow breeders are almost untouched. At `n_agents >= N_cap` births are deferred, never dropped.
- **Commit order**: birth requests made during ticks `t-2..t` are committed at the end of ecology tick `t` in `(parentEntityId, requestIndex)` order: genome operators (mutation stream MUTATION keyed by the child's new entity id), `develop`, `physics.loadBody`, `brain.allocate`, species assignment. This batching is fixed and journal-independent (review R12).

### 9.7 Ledger statistics

Heat and flows are tallied per tick in 16 channels (f64, per world): 0 photosynthesis in, 1 chemosynthesis in, 2 god injection, 3 ingestion, 4 absorption, 5 faeces, 6 heat basal, 7 heat muscle, 8 heat organs and brain, 9 heat repair, 10 growth, 11 reproduction, 12 cap fee, 13 death to carcass, 14 decay, 15 parasite drain. They are statistics, not stocks; conservation is the integer invariant of 9.1.

## 10. The tick pipeline and system interfaces

### 10.1 Order within one tick (owner `src/sim`)

```
0. apply journal inputs due at this tick (god commands at their fire tick, governor decisions)
1. brain.sense(world, ctx)            perception and internal inputs
2. brain.think(world, ctx)            CTRNN and oscillators, outputs to out / cmd / cmd2
3. physics.step(world, ctx)           substeps, contacts, links, bites and grabs, powerW, work, touch
4. if tick % 3 == 0: ecosystem.stepEcology(world, ctx)
                                      feeding exchange, digestion, metabolism, growth and restage
                                      requests, ageing, reproduction requests, deaths, field reactions,
                                      transport; then sim.commit() births and deaths (9.6)
5. if tick % 15 == 0: ecosystem.stepSlow(world, ctx)   flow modes, light, temperature
6. sim emits primitive events; tick += 1
```

Detectors (hunts, schools, giants, outbreaks) run outside the step on the host (section 11) and never write sim state.

### 10.2 Interfaces (`src/core/contract.ts`)

```ts
interface StepContext { tick: number; config: WorldConfig; rng: RngStreams; events: EventSink }
interface GenomeModule {                       // the codec itself is core: decodeGenome, encodeGenome
  develop(g: Genome, maturity: number, env: BirthEnv, opts: DevelopOptions): Phenotype;
  mutate(g: Genome, ctx: MutationContext): Genome;
  crossover(bearer: Genome, donor: Genome, ctx: MutationContext): Genome;
  repair(g: Genome): Genome;
  distance(a: Genome, b: Genome): number;
  template(id: TemplateId): Genome;
}
interface PhysicsModule {
  loadBody(world: World, slot: number, ph: Phenotype): void;   // writes segments, mass, joints
  restage(world: World, slot: number, ph: Phenotype): void;
  step(world: World, ctx: StepContext): void;
}
interface BrainModule {
  layout(ph: Phenotype, g: Genome): BrainLayout;
  allocate(world: World, slot: number, ph: Phenotype, g: Genome, ctx: StepContext): boolean;
  free(world: World, slot: number): void;
  sense(world: World, ctx: StepContext): void;
  think(world: World, ctx: StepContext): void;
  rehydrate?(world: World, slot: number, ph: Phenotype, g: Genome): void;  // after a snapshot load (B2)
}
interface EcosystemModule {
  initWorld(world: World, ctx: StepContext): void;       // terrain, fields, M_total
  flowAt(world: World, x: number, y: number, out: Float64Array): void;  // m/s, out[0..1]
  stepEcology(world: World, ctx: StepContext): void;
  stepSlow(world: World, ctx: StepContext): void;
  applyGodEvent(world: World, ev: GodEventScheduled, ctx: StepContext): void;
  audit(world: World): LedgerAudit;
}
interface SimCore {
  create(config: WorldConfig): World;
  step(world: World): void;
  hash(world: World): bigint;
}
```

The authoritative TypeScript lives in `src/core/contract.ts` and `src/core/types.ts`; this section is a summary of it.

### 10.3 Physics constants that others rely on

Physics reads the water velocity only from the `flowU`/`flowV` grids (bilinear at cell centres, `sampleFlow`), which ecosystem rebuilds on slow ticks; physics never imports ecosystem. Tank water `nu = 2e-5 m^2/s`, `rho_w = 1025 kg/m^3`, `g = 9.81 m/s^2` along +y †. Substeps: at least 4 per tick for any creature with an active muscle, up to 16 (review R6); cross-creature links (bites, grabs, latches) are solved inside the substep loop for linked pairs; contact correction velocity is capped at the depenetration speed and any residual kinetic energy is charged to the ledger as heat. Exploit watchdogs measure kinetic energy in the **local water frame** and count drag work done by the current as an input (review R9). v0.x has one full tier only (review R7).

## 11. Events

One event channel (DESIGN R19) feeds the director, stats, timeline and audio. Primitive events come from the step; derived events from host detectors. In TS every event is a plain object; on the wire an EVENT frame carries a CBOR array of them (section 12).

```ts
type Id = number;                  // entity id (u64 on the wire), < 2^53
type V2 = [number, number];        // world metres
interface EventBase { k: string; t: number /* tick */; eid: number /* event id, world counter */; epoch: number }
```

| `k` | Fields (besides the base) | Source |
|---|---|---|
| `birth` | `id, parents: Id[], species, pos, size, mode: 'bud' \| 'sex'` | step |
| `death` | `id, species, pos, size, cause: 'predation' \| 'starvation' \| 'age' \| 'disease' \| 'parasite' \| 'disaster' \| 'hypoxia', killer?` | step |
| `bite` | `attacker, target, pos, dmg` | step |
| `mate` | `a, b, pos` | step |
| `infect` | `host, strain, pos` | step |
| `speciation` | `parent, child, founders: Id[], pos` | host (species registry) |
| `extinction` | `species, lastId, pos` | host |
| `god` | `cmdId, power, author: 'god' \| 'nature', tFire, pos, radius, strength, major` | host |
| `release` | `cmdId, species, count, pos, leviathan` | host |
| `reseed` | `reason: 'extinction' \| 'diversity' \| 'immigration', species: number[]` | step |
| `hunt` | `phase: 'start' \| 'update' \| 'end', pred, prey, pos, outcome?` | detector |
| `school` | `phase, species, n, centroid, radius, polarisation, sample: Id[]` | detector |
| `giant` | `id, species, size, percentile` | detector |
| `record` | `kind: 'size' \| 'age' \| 'speed' \| 'depth' \| 'generation' \| 'offspring', id, value, prev` | detector |
| `endangered` | `species, remaining, ids: Id[]` | detector |
| `outbreak` | `phase, strain, host, prevalence, growth, centroid, radius` | detector |
| `massDeath` | `centroid, radius, deaths, z` | detector |
| `carcass` | `id, size, pos, scavengers` | detector |
| `frenzy` | `carcass, n, pos` | detector |
| `epidemicFront` | `species, strain, pos, radius` | detector |
| `migration` | `species, direction: 'up' \| 'down', fraction` | detector |
| `bloomFront` | `pos, radius, strength` | detector |
| `newRole` | `species, role, trophic` | detector |
| `novelty` | `id, species, morphCluster, distance` | detector |

Base interest scores for the director are 04 §4.9's table (hunt 0.4, kill 0.6, new species 0.8, new role 0.9, extinction 0.7, mass death 0.8, swarm 0.5, giant 0.6, disaster 1.0, frenzy 0.7, epidemic front 0.6, migration 0.4, bloom front 0.3). The host sends at most 20 derived events per wall second to each view; births and deaths reach views only when notable (06 §6.2.2) and reach stats as aggregates.

## 12. Sim-to-view protocol v1 (binary frames)

Owner of the codec: `src/core/protocol.ts`. The **same frames** travel over a Web Worker `postMessage` (ArrayBuffer, transferred) in the dream tank and over a WebSocket (`/ws/v1`, binary) from the host. A view does not know which transport it has.

### 12.1 Frame header (8 B)

| Off | Type | Field |
|---|---|---|
| 0 | u8 | type (table) |
| 1 | u8 | flags: bit0 payload deflate-raw compressed, bit1 keyframe |
| 2 | u16 | version: `major << 8 \| minor`; v1.0 = 0x0100 † |
| 4 | u32 | tick (low 32 bits; WELCOME gives the high bits and epoch) |

A reader rejects a different major version and ignores unknown frame types. New fields are appended to payloads; readers ignore trailing bytes (forward compatibility).

### 12.2 Frame types †

| Code | Name | Dir | Encoding | Rate | Payload |
|---|---|---|---|---|---|
| 0x01 | HELLO | C to S | CBOR | once | `{view, token?, caps: {maxBytesPerSec, maxBodies, maxDust, gpu}, viewport, worldConfig?}` (`worldConfig` is honoured only by the dream-tank worker; the host ignores it) |
| 0x02 | WELCOME | S to C | CBOR | once | `{worldId, tickHi, epoch, tickHz, tank: {w, h, preset}, lCeiling, palette: bytes (n x RGB8, the colour indices of DUST_FRAME), speciesTable, schemaHash, scopes}` |
| 0x03 | VIEWPORT | C to S | binary 28 B | at most 10 Hz | `f32 x0, y0, x1, y1` (world m), `f32 pxPerM`, `u32 flags` (bit0 paused, bit1 resync), `f32` predicted centre lead (s) |
| 0x04 | ACK | C to S | binary 4 B | 2 Hz | `u32` last decoded tick |
| 0x05 | BYE | either | none | | |
| 0x06 | ERROR | S to C | CBOR | | `{code, message}` |
| 0x10 | BODY_ENTER | S to C | binary | on change | `u16 n`, then n x 32 B: `u16 slot, u16 reserved, u32 idLo, u32 idHi, u32 genomeLo, u32 genomeHi` (xxh64 key), `u32 species, f32 log2Length, u8 maturity, u8 energy, u8 lod, u8 flags` |
| 0x11 | BODY_LEAVE | S to C | binary | on change | `u16 n`, `u16 slot` x n |
| 0x12 | BODY_FRAME | S to C | binary | 10 to 30 Hz | `f32 rect[4]`, `u16 nSlots`, presence bitmask `ceil(n/8)` bytes, then per present slot a 10 B record: `u16 x, u16 y` (rect-relative, 1/65535), `u8 heading` (2 pi/256), `u8 speed` (log: `v = 2^(s/16 - 10)` m/s), `u8 phase`, `i8 bend`, `u8 glow`, `u8 flags` |
| 0x13 | NEAR_POSE | S to C | binary | 10 to 30 Hz | `u16 n`, per hero: `u16 slot, u8 nJoints, i8 angle[nJoints]` (pi/128 steps) |
| 0x14 | DUST_FRAME | S to C | binary | 5 to 15 Hz | `f32 rect[4]`, `u32 nSlots`, then n x 6 B: `u16 x, u16 y` (rect-relative), `u8 colour` (palette index, 255 = empty slot), `u8 glow` |
| 0x15 | GLOW_FIELD | S to C | binary | 2 Hz | `f32 rect[4]`, `u16 w, u16 h`, RGBA8 x w x h |
| 0x16 | FIELDS | S to C | binary | 0.5 Hz | `u8 nCh, u16 w, u16 h`, per channel `u8 id, f32 min, f32 max, u8[w h]` (ids: 0 light, 1 temperature, 2 nutrient, 3 plankton, 4 flowU, 5 flowV, 6 oxygen, 7 turbidity) |
| 0x17 | ENV | S to C | binary | 1 Hz | `f32 dayPhase, yearPhase, surfaceLight, surfaceTempC, turbidity, ySurface`, `u8 nModes`, `f32 mode[n]` |
| 0x18 | CENSUS | S to C | CBOR | 1 Hz | `{species: [{id, count, biomassKg, colour}], heat: bytes (64 x 36 x 4 u8), env}` |
| 0x20 | EVENT | S to C | CBOR | as they happen | array of events (section 11) |
| 0x21 | STATS | S to C | CBOR | 1 Hz, god only | population, species, ledger channels, metrics |
| 0x22 | INSPECT | S to C | binary | 10 Hz | `u32 idLo, idHi`, `u16 nNeu`, i8 activations, then up to 8 f32 scope neurons (DESIGN R34) |
| 0x30 | COMMAND | C to S | CBOR | user-driven | a god command (section 13) |
| 0x31 | COMMAND_RESULT | S to C | CBOR | per command | `{id, ok, reason?, eventId?, fireTick?, snapshotId?}` |
| 0x40 | GENOME_REQ | C to S | binary | on demand | `u16 n`, `u32 lo, u32 hi` x n |
| 0x41 | GENOME | S to C | binary | on demand | `u32 lo, u32 hi, u32 len`, genome bytes |

Rules:
- **Stable slots** (review R18): a slot keeps the same entity while it is in the stream, for both BODY_FRAME and DUST_FRAME, so views interpolate per slot between two frames. Slots are freed only by BODY_LEAVE or by marking a dust slot empty, and are reused lowest-first.
- **Keyframes** are sent every 2 s, to a new client and on resync. Predictive deltas (05 §5.3.4: 2-bit class per slot, i8 residuals against integer dead reckoning) are a later minor version (`0x0101`) behind the keyframe bit; v1.0 sends keyframes only.
- Views render 150 ms (god) to 250 ms (wallpaper, TV) behind the newest frame.
- Inbound messages are capped at 64 KB; CBOR is strict (no tags, no indefinite lengths, depth at most 16).

## 13. God commands

COMMAND payloads are CBOR maps; `src/core/types.ts` has the exact TS. Every command carries `id` (client-chosen string, at most 32 chars) and `epoch` (the world epoch the client last saw; a command with a stale epoch is rejected with reason `stale-epoch`, DESIGN R27).

| `t` | Fields | Notes |
|---|---|---|
| `cast` | `power: PowerId, target: Target, intensity: 0..1, duration?: s, seed: u32` | lead 3 s for major powers, 1 s for minor (DESIGN R7), wall time converted to a fire tick at the achieved speed; while paused the countdown starts on resume |
| `release` | `ptkg: Uint8Array \| libraryId: string, pos: V2, count, asLeviathan: boolean, founderProtection: boolean` | `asLeviathan` is major; sets the genome flag and the endowment (3.3) |
| `speed` | `speed: 0 \| 0.25 \| 1 \| 4 \| 16 \| 'max', until?: {tick?: number, wallIso?: string}, unattended?: boolean` | a lease (DESIGN R29); lapses when the god window closes unless `unattended` with an `until` (William's Q2 overnight lease) |
| `select` | `entity: Id, pin: boolean` | inspector stream |
| `snapshot` | `label: string` | manual, kept forever |
| `rewind` | `snapshotId: string` | in place: epoch + 1, the present saved as `beforeRewind` |
| `bookmark` | `label, pos, zoom` | |
| `setting` | `key: string, value: number \| string \| boolean` | world settings and balancing knobs |

`Target` = `{kind: 'global'} | {kind: 'point', pos} | {kind: 'circle', pos, radius} | {kind: 'depthBand', y0, y1} | {kind: 'stroke', points: V2[]} | {kind: 'species', species: number[]} | {kind: 'creature', entity: Id}`.

`PowerId` (the union of 04 §4.8 and 07 §3.4, DESIGN R26) †: `bloom, marineSnow, vent, coldSnap, heatwave, plague, meteor, currentShift, longNight, mutagen, toxinLeak, cull, bless, nutrientFlood, iceAge, predatorFlood, storm, whaleFall, riftBarrier, deadZone, earthquake, seasons`. The core 12 for v0.5: `bloom, vent, coldSnap, heatwave, plague, meteor, currentShift, longNight, mutagen, cull, bless, nutrientFlood`, plus `release`. **Major** (hold to confirm plus an automatic `beforePower` snapshot): `plague, meteor, cull, iceAge, predatorFlood, riftBarrier, earthquake` always; `coldSnap, heatwave` when intensity > 0.5; `longNight` > 0.7; `toxinLeak` > 0.3; `nutrientFlood` > 0.5; any `release` with `asLeviathan`. Nature mode issues only `coldSnap, heatwave, currentShift, storm, bloom` at magnitude at most 0.4 and never a major power (William's Q7).

Scheduled form inside the sim (`GodEventScheduled`): `{cmdId, power, target, intensity, duration, seed, issuedTick, fireTick, author, envelope: {attack, sustain, release} (s)}`. It is journalled at issue time and applied by `ecosystem.applyGodEvent` at `fireTick`.

## 14. File formats

### 14.1 `.ptk` world snapshot (owner of the container `src/core/container.ts`; of persistence `src/host`)

Header (64 B), LE:

| Off | Type | Field |
|---|---|---|
| 0 | 8 B | magic `PHYLOTNK` |
| 8 | u32 | container version (1) |
| 12 | u32 | sim schema version (the migration key; 1 in v0.x) |
| 16 | u32 | flags: bit0 full fidelity, bit1 lite |
| 20 | u32 | nSections |
| 24 | u64 | tick |
| 32 | u64 | simHash (hash of the sim build; replay is only exact on an equal value) |
| 40 | u32 | epoch |
| 44 | 16 B | reserved (0) |
| 60 | u32 | crc32 of bytes 0..59 |

Section table: `nSections` x 40 B: `u32 fourcc, u8 codec (0 none, 1 deflate-raw, 2 zstd reserved), u8 required, u16 reserved, u64 offset, u64 storedLen, u64 rawLen, u64 xxh64 of the raw bytes`. Sections follow, 8-byte aligned.

Sections in v1: `META` (CBOR: world config, seed, counters, app version, git hash), `GLOB` (the globals record, CBOR), `CREA` (creature columns), `SEGS` (segment columns), `BRN0`..`BRN4` (brain class pools), `FLDS` (field grids), `GENO` (genome store, parent-diff forest), `SPEC` (species registry), `LINE` (pruned phylogeny), `GBNK` (gene bank), `PARA` (strains and spores), `EVTQ` (scheduled god events and modifiers), `JRNL` (optional embedded journal tail), `CAMR` (optional director state), `THMB` (optional PNG).

**Column sections** (`CREA`, `SEGS`, `BRNn`, `FLDS`) use one layout: `u32 nCols`, then per column `u8 nameLen, name (UTF-8), u8 typeCode (0 f64, 1 f32, 2 u32, 3 i32, 4 u16, 5 i16, 6 u8, 7 i8), u8 lanes, u8 reserved, u32 count, u32 byteLen`, then the bytes 8-aligned. Columns are matched by name, so adding a column is forward compatible; a missing column takes its default. Only `[0, highWater)` is stored.

Unknown sections with `required = 0` are skipped; an unknown required section gives "This world needs Phylotank at least x.y", never a crash. Readers bounds-check every offset and cap decompression at 50:1 (05 §5.9).

### 14.2 `.ptkg` design or species pack (owner `src/core/ptkg.ts`; UI `src/ui`)

07 §2.3's container, renamed from `.ptk` (DESIGN R22):

| Off | Size | Field |
|---|---|---|
| 0 | 3 | magic `PTK` |
| 3 | 1 | container version (1) |
| 4 | 1 | kind: 1 single design, 2 pack (up to 64 designs), 3 world-snapshot reference |
| 5 | 1 | flags: bit0 payload deflate-raw compressed |
| 6 | 2 | genome format version (1) |
| 8 | 4 | payload length n |
| 12 | n | payload: CBOR `{meta, genome}` (kind 1) or `{meta, designs: [{meta, genome}]}` (kind 2) |
| 12+n | 4 | CRC-32 of bytes 0..12+n-1 |

`meta = {name: {genus, epithet, common?}, notes?, author?, created (ISO date), origin: 'designer' | 'captured' | 'template', parents: [fingerprint], tags: [string], world?: {name, day, generation}, licence: 'CC0-1.0'}`. String form: `PTK1.` + base64url (no padding) of the container. Import limits: 64 KB raw, 256 KB decompressed, strict CBOR, text NFC-normalised with control and bidi characters stripped, names at most 40 characters, notes at most 1 KB; an import always opens in the designer preview first.

## 15. View modes

One renderer, four modes (plus the standalone dream tank). The mode comes from the page (`web/wallpaper.html` and so on) or `?mode=` on `web/index.html`.

| | wallpaper | screensaver | tv | god |
|---|---|---|---|---|
| Page | `wallpaper.html` (Lively) | `screensaver.html` (.scr wrapper) | `tv.html` | `god.html` |
| Sim source | host stream; dream tank (in-page worker) when no host answers within 2 s (DESIGN R31) | host stream | host stream (LAN, paired) | host stream |
| UI | none at all | captions only | captions plus a remote or gamepad overlay | full god window |
| Camera | idle drift (William's Q10) | director | director | user, with follow and bookmarks |
| Captions | never | on, 5 s hold, at least 45 s apart | on, 6 s hold, at least 25 s apart | timeline only |
| Audio default | off | off | on | user toggle |
| FPS cap | 30 (15 on battery or high sim load) | 60 | 30 | vsync |
| Render scale | 0.5 at 4K, 0.75 at 1440p, 1.0 at 1080p | 1.0 | 0.75 to 1.0 | 1.0 |
| Emission slew (time constant) | 300 ms | 150 ms | 150 ms | 100 ms |
| Max on-screen pulse frequency | 1 Hz; saturated red 0.5 Hz | 2 Hz; red 0.5 Hz | 2 Hz; red 0.5 Hz | 2 Hz; red 0.5 Hz |
| Whole-screen luminance change | at most 10% per second | 25% per second | 25% per second | 25% per second |
| Day and night | compressed in the renderer to 40% of the sim's range (review R18) | full | full | full |
| God-event visuals | gentle (fades of at least 2 s, capped brightness) | full | full | full plus timeline |
| Input | none; pauses on `visibilitychange` | any input exits (wrapper) | remote, gamepad | everything |
| Host scope | view | view | view (paired token) | god |

Every mode draws a free, dim, non-heritable **baseline glow** for every living creature (William's Q5), so the tank never goes dark whatever evolution does; bright displays cost energy in the sim. Severed parts stay as food, fade their glow over 30 s and sink. The three-layer flash defence of 06 §6.1.7 applies in every mode.

## 16. Module boundaries and ownership

Each directory is owned by one engineer. A module may import only from the modules in its "may import" column; `tests/boundaries.test.ts` enforces it. Shared types and codecs live in `src/core` and change only through this contract.

| Directory | Owns (interfaces and files) | May import |
|---|---|---|
| `src/core` | this contract's types (`types.ts`, `contract.ts`), constants, `dmath`, `rng` (Philox), `hash` (xxh64, hash32, crc32), `soa`, `layout`, `genome-schema`, `genome-format`, `cbor`, `protocol`, `container`, `ptkg` | nothing |
| `src/genome` | `GenomeModule`: develop, mutate, crossover, repair, distance, templates, species assignment, innovation registry, genome store | core |
| `src/physics` | `PhysicsModule`: `toSegmentSpecs`, bodies, joints, muscles, fluid, contacts, bites and grabs, `powerW`, watchdogs | core, genome (types and `develop` only) |
| `src/brain` | `BrainModule`: layout, development (direct and CPPN), pools, sense, think, inspector data | core, genome |
| `src/ecosystem` | `EcosystemModule`: terrain, fields, flow, light, temperature, producers, ledger, metabolism, feeding, ageing, reproduction requests, cap tax, disease, god-power effects, safety valves, metrics | core, genome |
| `src/sim` | `SimCore`: world creation, the tick pipeline, birth and death commit, journal application, state hash, frame encoding for views, the worker entry and pacer | core, genome, physics, brain, ecosystem |
| `src/render` | WebGL2 renderer (WebGPU later): decode frames into GPU buffers, LOD, glow, trails, bloom, dither, flash defence, per-mode profile | core, genome (`develop` for templates) |
| `src/director` | camera director: StoryBook, scoring, shots, springs, captions text | core |
| `src/audio` | generative WebAudio ambience | core |
| `src/ui` | view shell for every mode, god window, designer, library, onboarding, input, localisation | core, genome, render, director, audio, sim (only `sim/client` and the worker URL) |
| `src/host` | Node host: HTTP and WebSocket server, sessions, throttle and governors, persistence (`.ptk`, journal, autosave), detectors, CLI | core, genome, sim |
| `web/` | HTML entry pages and the bootstrap | ui |
| `packaging/` | Lively package, screensaver wrapper source, Android TV notes | none (build artefacts only) |
| `tests/` | cross-module tests (contract, determinism, boundaries, e2e) | anything |

## 17. Spikes and how their results change this contract

The reviewer's spikes run as the first task of the module named; results go in `docs/spikes/NN-name.md` with numbers, and any contract change they force goes through this file.

| Spike | Module | Decides |
|---|---|---|
| 1 XPBD swimmer and microbenchmarks | physics | substep floor (4?), contact append strategy, perception query cost |
| 2 Dawn on Node | host | whether the host moves to GPU kernels; readback latency; birth batching interval |
| 3 Evolvability toy | ecosystem (with genome) | `M_target`, `K_CAP`, `C_REP`, Gompertz range, species threshold for budders |
| 4 Lively and WebView2 | render (with packaging) | wallpaper delivery, WebGPU availability, pause behaviour |
| 5 GPU etiquette and power | host | power budget throttle input |
| 6 Wallpaper calm recording | render | slew constants, dust rates, day-night compression |
| 7 TV picture | render (with packaging) | TV route |
| 8 Brain encoding shoot-out | brain | default `ENCODING` for templates |
