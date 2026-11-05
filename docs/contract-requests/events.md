# Contract requests: events (second detector pass and protocol 1.1)

Filed 2026-11-05 by the events engineer. Everything below is implemented today against local adapters (`src/sim/events/types.ts` and `src/core/protocol.ts`), so nothing blocks. The integrator moves the types into `src/core/types.ts`, updates CONTRACT 11 and 12, and the consumers switch over.

## EV1. Scoring fields on derived events (CONTRACT 11)

**What.** Add optional fields to every derived event:

```ts
/** Fields the director scores on. Optional; primitive events need none of them. */
export interface ScoreFields {
  pos?: V2;          // where to look, world metres
  size?: number;     // body length of the subject (m), or radius of the region (m)
  novelty?: number;  // 0 seen it before .. 1 never seen anything like it
  durationS?: number;// sim seconds the phenomenon has lasted so far
}
export type SimEvent = EventBase & ScoreFields & ( ...unchanged union... );
```

plus these optional per-kind extras (all already emitted):

| `k` | Extra fields |
|---|---|
| `carcass` | `phase: 'start' \| 'update' \| 'end'`, `massKg`, `fall` (lies on the floor: a whale fall), `feeding` (scavengers with `CF.EATING`) |
| `frenzy` | `phase`, `feeding` |
| `migration` | `phase: 'start' \| 'update'`, `n`, `fromY`, `toY` |
| `bloomFront` | `dir: V2` (unit, direction of advance), `speed` (m/s) |
| `record` | `species`, `prevId` (the old holder) |
| `novelty` | `plan` (short text: "6 parts, 1 eye, 2 claws"), `nearest` (the nearest known morph cluster) |
| `outbreak` | `infected` |
| `epidemicFront` | `speed` (m/s), `dir: V2` |
| `newRole` | `prevRole`, `lineage` (true when a daughter species differs from its parent), `n` |

**Why.** 06 §6.2.4 scores stories on magnitude, recency, novelty and visibility, and needs a position to frame. Today the StoryBook has to remember sizes and positions from births and deaths it may never have seen (a view that connects late), so `migration`, `newRole` and `novelty` events have no position and fall back to the tank centre or are dropped (`newRole` without a known species position is ignored). Carrying `pos`, `size`, `novelty` and `durationS` on the event removes that dependency and lets `m0[type]` scale on a field the detector already knows.

## EV2. Two new derived kinds (CONTRACT 11)

```ts
| { k: 'bloom'; phase: Phase3; pos: V2; radius: number; strength: number; areaM2: number }
| { k: 'lineage'; story: 'founded' | 'radiation' | 'extinct' | 'lineEnded'; species: number; parent: number;
    depth: number; pos: V2; peak: number; descendants: number; cause?: DeathCause; daughters?: number }
```

**Why.** `bloomFront` alone reports an edge but not the bloom it belongs to; the director needs a region story (start, update, end) to frame an establishing shot and to merge fronts into it. `lineage` turns the step's `speciation` and `extinction` into narratives: how deep the line is, an adaptive radiation (three daughters within ten minutes), a species gone with its lifespan, peak and commonest cause of death, and the end of a whole line. Suggested base interest: bloom 0.3 (as bloom front), lineage `founded` 0.8 (as new species), `radiation` 0.9, `extinct` 0.7, `lineEnded` 0.9.

## EV3. Protocol 1.1 (CONTRACT 12.1, 12.2; `PROTOCOL_MINOR`)

**What.**
1. `PROTOCOL_MINOR = 1` once every view decodes deltas (until then the server writes 0x0100 on every frame except a delta BODY_FRAME, which carries 0x0101; `PROTOCOL_VERSION_1_1` in `src/core/protocol.ts`).
2. HELLO `caps` gains `proto?: number`, the newest protocol the view decodes. A view without it is treated as 1.0 and gets keyframes only.
3. The delta BODY_FRAME (KEYFRAME flag clear) as specified in the comment block above `BodyDeltaEncoder` in `src/core/protocol.ts`: `f32 rect[4], u16 nSlots, u32 baseTick`, 2-bit class per slot (0 predicted, 1 residual, 2 full, 3 absent), then per slot by class; residuals are a mask byte, two i4 or two i8 position residuals and only the fields that differ from the dead-reckoning prediction. The prediction uses only `+ - * /`, `Math.round` and tables built from core `dmath`, so every engine agrees, and the codec is lossless against keyframes.
4. Rule: a delta's `baseTick` must be the last BODY_FRAME the view decoded; otherwise the view sends VIEWPORT with the resync bit and the server answers with a keyframe.

**Why.** CONTRACT 12.2 reserves predictive deltas for "a later minor version (0x0101) behind the keyframe bit". Measured saving: docs/spikes/events-1.md (BODY_FRAME bytes fall to about 37% of keyframes on a live fallback world).

## EV4. Eggs (request to the sim and ecosystem owners)

Eggs cannot be added from the event module: they need the birth commit and the ecology step, which belong to `src/sim/commit.ts` and `src/ecosystem`. The contract already has `LIFE.EGG`, `g.eggCount` and `birthTick` "of laying". Proposed:

1. **Commit** (`commitBirth`): when the genome says oviparous (a trait `EGG_FRACTION > 0`, or a `LAY_BUD` output pattern), the child is allocated as `LIFE.EGG` with the same pools (tissue and reserve as now), `maturity = 0`, no brain (`brainSlot = NONE`), `segCount = 1` (one capsule segment of the egg's radius so physics can sink and collide it), and `hatchTick = tick + incubation(genome, tempC)` in a new f32 column `hatchAt` (or reuse `reproTimer` as the countdown). Emit `birth` with `mode` unchanged and a new field `egg: true`; `liveCount` is not incremented, `eggCount` is.
2. **Hatching**: a second commit step on ecology ticks, in ascending slot order: eggs whose `hatchAt <= tick` run `develop`, `physics.loadBody` (restage to the hatchling), `brain.allocate` (a refusal defers the hatch one ecology tick), become `ALIVE`, move from `eggCount` to `liveCount`, and emit `hatch {id, species, pos}`.
3. **Ecology**: eggs pay basal metabolism at `0.2x` (no activity, no repair), can be eaten as carcass-like food (diet lane `CARCASS`, or a new `EGG` lane), and die to detritus (`death` with cause `predation` or `starvation`) like any creature; an egg that dies is not a carcass.
4. **Events**: the event suite would add a `clutch` story (many eggs of one species in one place, "a spawning ground") and a `hatch` boom; both are a few lines once the column exists.

## EV5. Consumers (requests to director, render and ui)

- **director** (`src/director/storybook.ts`): ingest `bloom` (area story, as `bloomFront`) and `lineage` (map `founded` to `speciation`, `radiation` to a new type or `speciation` with doubled magnitude, `extinct` and `lineEnded` to `extinction`); prefer the event's `pos` over remembered positions when present; use `novelty`, `size` and `durationS` for magnitude where 06 §6.2.4 names them (novelty: archive distance; record: percentage over the previous; carcass: scavengers; migration: fraction).
- **render / ui**: decode BODY_FRAME with `BodyDeltaDecoder` (one per connection; it accepts keyframes too), send `caps.proto: 0x0101` in HELLO, and on a `FormatError` from it send VIEWPORT with the resync bit.
- **host** STATS: add `detectors.costs()` (per-detector mean and max ms) so the measured cost shows in the god window.

## EV6. The diet EMA (request to the ecosystem owner)

**What.** Write the creature columns `diet` (f32 x7: phyto, mat, plantCreature, detritus, carcass, livePrey, host) and `trophic` (CONTRACT 5.1) on every ecology tick, as an EMA of each lane's ingested quanta (time constant about 60 s of sim time), and set `CF.EATING` only while the creature is actually ingesting.

**Why.** Nothing writes them today (`src/sim/fallback/ecology.ts` sets only `CF.EATING`, for grazing). `newRole` (a lineage switching diet role) and the frenzy feeder rule (a crowd at a corpse is a frenzy only when meat eaters are in it) read them; until they are written, `newRole` never fires and frenzies are crowds (docs/spikes/events-1.md section 2).
