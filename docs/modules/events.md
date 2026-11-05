# Events: the second detector pass and protocol 1.1 (phase 1)

Owner: events engineer. Binding: CONTRACT 4.2 (determinism), 11 (events), 12 (protocol); 06 §6.2.2 (what the director needs). Spike: [docs/spikes/events-1.md](../spikes/events-1.md). Contract requests: [docs/contract-requests/events.md](../contract-requests/events.md).

## Files

| File | What |
|---|---|
| `src/sim/events/suite.ts` | `EventSuite`: runs every detector below over one shared scan every `every` ticks (1 s), feeds them primitive events, measures cost per detector when given a clock |
| `src/sim/events/scan.ts` | `Scanner`: one O(N) pass per run: alive and carcass slot lists, a counting-sorted 1 m grid, per-species aggregates, the median adult length; `forNear` radius queries |
| `src/sim/events/carcass.ts` | carcasses and whale falls (`carcass` start, update, end; `fall` once it lies on the floor), feeding frenzies (`frenzy` start, update, end) |
| `src/sim/events/migration.ts` | vertical migration per species (mean depth over a window) |
| `src/sim/events/bloom.ts` | plankton blooms (`bloom` region story) and their advancing edges (`bloomFront`) from the fine `qP` grid |
| `src/sim/events/records.ts` | size, speed and age records |
| `src/sim/events/novelty.ts` | new body plans: descriptor, bounded archive, adaptive threshold |
| `src/sim/events/outbreak.ts` | outbreaks per (strain, host species) and epidemic fronts |
| `src/sim/events/roles.ts` | diet roles per species and `newRole` when a lineage switches |
| `src/sim/events/lineage.ts` | lineage stories: founded, radiation, extinct, lineEnded |
| `src/sim/events/types.ts` | the derived-event type (CONTRACT 11 plus the EV1 scoring fields and EV2 kinds), `Detector`, `Scan` |
| `src/core/protocol.ts` (end) | protocol 1.1: `predictBody`, `BodyDeltaEncoder`, `BodyDeltaDecoder` |

Wiring: `src/sim/detectors.ts` (the dream-tank session) and `src/host/detectors.ts` (the host) each own an `EventSuite` and run it on their own timers; the host passes `performance.now` as the clock. The phase-1 detectors those classes already had (hunt, school, giant, endangered, extinction, mass death) are unchanged; their old carcass, frenzy, migration, record and outbreak code is replaced by the suite, with the host's option names mapped onto it so the host tests keep their meaning. `InterestStream` (host) and `ViewStream` (sim) encode BODY_FRAME through a `BodyDeltaEncoder`, which only sends deltas when the view said `caps.proto >= 0x0101` in HELLO.

## Detector rules

All windows are in ticks of sim time, all thresholds are options with the defaults below, and every detector iterates slots in ascending order, sorts with total-order comparators and iterates maps only in insertion order of deterministic inputs. None reads a clock or writes the World (a test checks the state hash).

| Detector | Rule (defaults) | Bound per run |
|---|---|---|
| carcass | a corpse at least 0.25 L_ceiling, 10 kg or a leviathan: `start` when first seen, `update` when its crowd changed by 3 or more, it settled, or it lost a quarter of its mass (at most every 30 s), `end` with its duration when gone; `fall` = within max(0.3 m, 2 L) of the floor and sinking under 5 mm/s | candidates sorted by size, at most 256 |
| frenzy | at least 5 live creatures within max(0.2 m, 5 L) of a corpse of at least max(0.05 L_ceiling, 4 x median adult), and at least 3 times the count the density of the ring from r to max(1 m, 4 r) around it would put there, and, once the ecology records diets, 3 or more meat eaters among them; `update` every 10 s while the crowd changes, `end` after two runs below half, no new start at the same corpse within 60 s | same 256 |
| migration | a species of 10 or more whose mean depth moved 15% of the water column within 60 s; then the baseline resets, and the same direction within two windows is an `update` | 512 species, ring of 60 samples each |
| bloom | 32 x 18 blocks of the fine plankton grid (swept over several runs when the grid is larger than Default's, so Large is judged every 4 s); hot = at least 2x its own EMA (tau 120 s, a quarter of the rate while hot) and 1.5x the tank mean (the day cycle lifts every block and does not count); 4-connected hot regions of 3 blocks or more are blooms (start, update every 30 s, end), matched run to run by largest overlap | at most 589,824 fine cells (one Default grid), 16 regions |
| bloomFront | a tracked bloom that took in 2 or more new blocks (at most every 10 s): their centroid, radius, mean strength, the direction from the old centroid and the speed of the front | as bloom |
| record | size (length), sustained speed (the lower of two consecutive runs, under 50 body lengths per second, for the 16 fastest), age; a new holder must beat the record by 5%, at most once per 10 min per kind unless by 20%; a holder growing or speeding past its own last report by 20% is news again, an ageing holder never; the first 60 s only set the bar | O(N) plus 16 |
| novelty | each new adult genome described once (parts, tree depth, distinct part kinds, counts of 12 organs, log size, aspect, all log-scaled); sparseness = mean distance to the 15 nearest archived plans; news when above rho (1.5) with the nearest plan beyond rho/2; archived when above rho/2 with the nearest beyond rho/4; rho up 25% after an event sooner than the target interval (30 min), down 10% per interval without one, floor 0.5; the first 60 s only fill the archive | 32 new genomes per run, archive 512, 8,192 described handles |
| outbreak | per (strain, host species): prevalence among living members; start above 0.15 with growth above 0.02 per minute over 30 s and 10 or more infected; update every 10 s; end below 0.05 | 64 pairs, largest first |
| epidemicFront | while an outbreak runs: the 90th percentile distance of infected hosts from where it started; when it grows by 1 m (at most every 10 s), the mean position of the infected beyond the old reach, the new reach, direction and speed | as outbreak |
| newRole | role from the intake EMA (`diet`): grazer, detritivore, scavenger, predator, parasite, or omnivore when no share reaches 0.5; a species' role is the rule on its feeders' mean shares (5 feeders or more), established after 3 runs in a row; reported when an established role changes, or when a new species' first role differs from its parent species' (`lineage: true`); founders are silent | 1,024 species |
| lineage | from `speciation`, `extinction` and `death`: depth in the species tree, founding tick, peak population, last 16 death causes, daughters; `founded`, `radiation` (3 daughters within 10 min, once per parent per window), `extinct` (lifespan, peak, commonest recent cause, living daughter species), `lineEnded` (no living descendant of the root ancestor) | 4,096 species records |

Every event carries `pos`, `size`, `novelty` (0 to 1) and `durationS` where they mean something (contract request EV1).

## Decisions

1. **One implementation, two callers.** The host and the dream-tank worker had diverging detectors. The new ones live once in `src/sim/events` (the host may import sim; the sim may not import host) and both callers run them. The old host carcass, frenzy, migration and record code and the sim's outbreak are gone.
2. **One scan per run.** Detectors share the alive list, the grid and the species aggregates, so adding a detector costs only its own work, and the total is measured per detector.
3. **Bounded by construction.** Each detector has a hard cap (table above) on what it considers per run and on what it remembers; an event storm (a plague's thousand corpses) costs a sort, not a thousand neighbour queries.
4. **Hysteresis everywhere.** Roles need three runs, records need 5% (or 20% for the same holder), migrations reset their baseline, blooms use a slower EMA while hot, outbreaks start at 0.15 and end at 0.05. The director gets few, meaningful events.
5. **Records of a growing animal.** A holder creeping up is not news; a different creature beating it is, and a growing giant is news again after 20%. Age records only change hands.
6. **Novelty in body-plan space, not genome space.** The descriptor comes from the developed segments (what the camera sees), so a silent mutation is never "new". The fallback genome has one capsule part, so in fallback worlds novelty only fires on staged bodies; with the real genome and physics it fires on real plans.
7. **Eggs are not here.** They need the birth commit and the ecology step (contract request EV4).
8. **Protocol 1.1 is lossless and opt-in.** The delta decoder reproduces exactly the keyframe records, so a view never drifts; it is sent only to a view that says `caps.proto >= 0x0101`, so 1.0 views (every view in the tree today) see no change. Keyframes every 2 s, on a new client, on resync and whenever the encoder has no baseline. A slot that changes entity is sent FULL, so the decoder never needs BODY_LEAVE to stay right.

## Not done

- The director does not yet read `bloom`, `lineage` or the scoring fields (request EV5); unknown kinds are ignored by its StoryBook, so nothing breaks.
- Eggs (EV4).
- The renderer and UI do not yet decode deltas or send `caps.proto` (EV5), so the saving is measured in tests, not yet seen on the wire.
- The detectors run on the main thread of the host timer; at the measured cost (spike) that is fine up to the CPU-backend cap.
