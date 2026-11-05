# Contract requests from src/brain (phase 1)

Each item says what, why, and the exact change. The brain module already implements the proposed behaviour against a local adapter, so applying an item changes no results unless it says so.

## B1. Mouth BITE and LATCH have no destination column (needed by physics)

**What.** CONTRACT 8.1 gives each MOUTH part three outputs (MOUTH_OPEN, BITE, LATCH), but the segment pool has only `cmd` and `cmd2`, and 8.3 says per-part outputs write "segment `cmd` or `cmd2`".

**Change.** Append a segment column to `SEGMENT_COLUMNS` and CONTRACT 5.2:

```ts
{ name: 'cmd3', type: 'f32', lanes: 2 },   // MOUTH parts: lane 0 BITE, lane 1 LATCH (writer brain)
```

and in 8.1: "MOUTH_OPEN writes the mouth part's `cmd2`; BITE and LATCH write `cmd3` lanes 0 and 1." A mouth part therefore cannot also carry an organ drive on `cmd2`; `organOutput` never gives a MOUTH part one in the current kind list.

**Adapter now.** MOUTH_OPEN goes to `cmd2`; BITE and LATCH go to `brainState(world).segAux[seg * 2 + lane]` (exported from `src/brain`), sized to the segment capacity. Physics can read that until the column exists.

## B2. `BrainModule.rehydrate` after loading a snapshot

**What.** The brain pools hold all evolving state (y, o, oPrev, phase, synDw and the triggers), but the tick also needs per-brain constants that are derived from the genome and phenotype and have no pool column: every neuron's time constant (to recompute `alpha` when `brainDiv` changes), the four plasticity rules, `TAU_FORGET`, `ETA_SCALE`, `SENSOR_NOISE`, `EXPLORATION`, the sense descriptors (eye geometry, chemo channels), the output destinations, and a few body constants (temperature optimum and tolerance, fat capacity, clutch cost). They are rebuilt deterministically by `allocate`.

**Change.** Add to `BrainModule` in `src/core/contract.ts` and CONTRACT 10.2:

```ts
/** Rebuild derived per-brain constants for a creature whose pool slot was restored from a snapshot. */
rehydrate(world: World, slot: number, ph: Phenotype, g: Genome): void;
```

`src/sim` (or the snapshot loader) calls it for every brained creature after restoring the pools and before the next tick. The implementation exists as `rehydrate` in `src/brain/index.ts`. The alternative (more pool columns: `tau` f32 x N, `rules` f32 x 16 per brain, and so on) would grow every brain by about 1 KB and still not cover the sense descriptors.

## B3. Trigger outputs and two scratch lanes (document in 5.3 and 8.1)

**What.** Triggers need memory between ticks, and the state must be hashed and snapshotted, so it lives in existing columns:

- `out[MATE]` and `out[LAY_BUD]` hold the **latched** 0 or 1 after hysteresis (on above 0.5, off below 0.2); the previous value of the lane is the latch state.
- `out[ROLL]` is 1 only on the brain tick it fires (motor above 0.5 and the 2 s cooldown elapsed), else 0. Physics acts on the rising edge (with `brainDiv > 1` the 1 is held for `brainDiv` ticks).
- The ROLL motor's `phase` lane holds its cooldown in seconds (motors never use `phase`).
- The pain modulator's `phase` lane holds the previous HEALTH, for the PAIN input.
- All other outputs carry the raw motor value `o[j]` in [-1, 1].

**Change.** Add these five bullets to CONTRACT 8.1 (outputs) and a note under the 5.3 table: "`phase` of a non-oscillator neuron is scratch state owned by `src/brain` (8.1)".

## B4. Stable-id slot codes (needed by genome and UI to write DSYN genes)

**What.** 8.1 defines a stable id as `hash32(moduleInnov, pathHash, slot)` but not the slot numbering, so nobody else can name a neuron in a DSYN gene or the inspector.

**Change.** Add to 8.1:

| Neuron or channel | `slot` code |
|---|---|
| input channel of kind `k`, lane `s` | `(k << 10) \| s` |
| output channel (and its motor neuron) of kind `k`, lane `s` | `0x10000 \| (k << 8) \| s` |
| drive `j` (hunger, fear, libido, fatigue, aggression, sociality) | `0x20000 + j` |
| modulator `j` (pleasure, pain) | `0x20100 + j` |
| head hidden `j` | `0x20200 + j` |
| oscillator of a part | `0x30000` |
| ganglion hidden `j` of a segment | `0x30100 + j` |
| DNEU hidden neuron | `hash32(innov, 0, 0xFF)` (already in 6.7) |

Kinds `k` are the channel kind codes (globals 0..17 or 0..7, part kinds `64 + index`). Input lanes: eyes number receptors then lanes `r * (C + 1) + c` continuing across eyes on the same part; chemo lanes are `organOrdinalOnPart * 8 + channel`; lateral and touch lane 0 dorsal, 1 ventral. Global channels use `moduleInnov = rootModuleInnov` and `pathHash = 0`, so a global's module key equals its instance key.

Because `src/genome` may import only `core`, its DSYN "add synapse" mutation cannot ask the brain for valid keys. Proposal: move `inputSlotCode`, `outputSlotCode` and the namespace constants above from `src/brain/layout.ts` into a new `src/core/brain-keys.ts`, so genome can mint module keys from its module list (for example `hash32(finInnov, 0, outputSlotCode(MUSCLE, 0))`). Until then the functions are exported from `src/brain/layout.ts`.

A module-keyed DSYN source that names several instances resolves, for each destination instance, to the instance on the same part, else the one nearest in `u` (ties to the lower index). DSYN genes are applied sorted by `(src, dst)`, the codec's canonical order, so encoding and decoding never changes a brain.

## B5. Reserved CPPN node ids (6.7)

**Change.** "CPPN node ids 1 to 38 are the query inputs in this order: `u_a, v_a, |v_a|, d_a, type_a` (12 one-hot), `u_b, v_b, |v_b|, d_b, type_b` (12), `u_b - u_a, v_b - v_a, dist, sameSide, sameOrgan, bias`; ids 39 to 44 are the outputs `w, leo, eta, rule, nodeBias, nodeTau` (default function tanh, overridable by a CppnNodeGene with that id). `hash64` (xxh64 of the two ids as 16 LE bytes) never returns an id below 64." Substrate types (the one-hot): 0 eye, 1 lateral, 2 chemo, 3 touch and taste, 4 internal (and proprioception, gland), 5 clock (and BIAS), 6 drive and modulator, 7 oscillator, 8 ganglion, 9 head hidden (and DNEU), 10 muscle motor (MUSCLE, FIN_PITCH), 11 action motor.

## B6. OrganSpec.params for eyes and noses (7.1, genome)

**What.** Sensing reads `organList[].params`. The brain assumes, for EYE: `[radius m, field of view in degrees (10..360), receptor count (1..16), spectral byte as stored (bits 0-2 blue, 3-5 green, 6-7 red), acuity 0..1]`; for CHEMO: `params[1]` = channel mask byte as stored. Bit fields must not be "decoded" to a float range.

**Change.** State this in CONTRACT 7.1 next to `OrganSpec`. Eye range is `2 + 38 x acuity` body lengths, capped at 4 m.

## B7. C0 is reachable only by bodies with no actuator (8.2)

**What.** Every brain has 8 global motors, 6 drives and 2 modulators: 16 neurons, which is C0's whole N. A single muscle, fin, cilia patch or mouth puts a brain in C1. Pool shares assume C0 holds 60% of brains.

**Change (recommended).** Raise C0 to N = 24 (I 32, K 8), or move 35 points of the C0 pool share to C1. Measured: a 1-part microbe with no hidden neurons lands in C0 with exactly 16 neurons; a fish with 5 trunk segments and a fin is C2 (40 neurons, 46 inputs).

## B8. Smaller items

- **Sensor noise and BIAS.** Noise is not added to input 0 (BIAS stays exactly 1). Normal draws use Box-Muller on the four 24-bit words of one Philox block (pairs (w0, w1) and (w2, w3)), so block `b` serves inputs `4b..4b+3` (drawIndex = index / 4, as 8.3 says). The same scheme serves EXPLORATION noise per neuron (stream BRAIN_NOISE).
- **Padding.** The CPU tick loops each neuron's packed synapse row only (unused slots after it are skipped). This is exactly equivalent except for the sign of a zero sum; a GPU kernel may loop all K slots and match within the 03 §3.14 tolerance.
- **ITCH and GLAND_FULL** have no data source in v0.1 (no latched-parasite count, no gland pool); they read 0 and 1. The ecosystem engineer should name the columns when disease and glands arrive.
- **Touch side.** The segment `touch` column is a magnitude. The brain splits it into dorsal and ventral by probing the SDF on each side; a signed or two-lane touch from physics would be better.
- **Brain cost (8.5).** With the initial values a 0.5 mm microbe's C1 brain (22 neurons, about 60 synapses, 5.6e-8 W) is 38% of its basal rate, a 1 mm one 8%, a 5 mm grazer 0.5% and a 2 cm "Glimmerkin" 0.05%. The two figures in 03 (3% for a microbe, 15 to 20% for Glimmerkin) need scale factors of 0.08 and 350, four orders apart, so absolute costs cannot meet both. Recommendation: keep absolute costs (the contract's intent) and halve both, `e_n = 1e-9`, `e_s = 1e-10` (0.5 mm: 19%, 1 mm: 4%), and leave brain-size selection in large creatures to E8 later. Not applied; the ecosystem engineer should confirm against metabolism.
