# Contract requests from the host

Filed by the host engineer during phase 1. Each item says what, why, and the exact change. The host implements every item against a local adapter today, so none of them blocks the branch.

## H1. Host-made event ids must not use the world counter

**What.** CONTRACT 11 says `eid` is "event id, world counter" (`world.g.nextEventId`). The host emits `god` and `release` events (and later detector events) outside the step.

**Why.** If the host increments `world.g.nextEventId`, the globals change outside the journal, so replay after a crash produces a different state hash. The host therefore numbers its own events from `HOST_EVENT_ID_BASE = 2^50` upwards (`src/host/commands.ts`).

**Change.** Add to CONTRACT 11: "Events made outside the step (host and detectors) take ids from a host counter starting at 2^50; the world counter is advanced only by the step." Add `HOST_EVENT_ID_BASE = 2 ** 50` to `src/core/constants.ts`.

## H2. A journal kind for releases and for sim-affecting settings

**What.** `JournalEntry` in `src/sim/index.ts` has only `god` and `governor`.

**Why.** A `release` command (CONTRACT 13) and any `setting` that changes sim results must enter through the journal (CONTRACT 4.2 rule 1). Today the host answers `release` with `release-unsupported` and accepts only host-side settings (`autosaveMin`, `backgroundSpeed`).

**Change.**
```ts
export type JournalEntry =
  | { tick: number; kind: 'god'; ev: GodEventScheduled }
  | { tick: number; kind: 'governor'; decision: { brainDiv?: 1 | 2 | 3 } }
  | { tick: number; kind: 'release'; cmdId: string; genome: Uint8Array; pos: V2; count: number; asLeviathan: boolean; founderProtection: boolean }
  | { tick: number; kind: 'setting'; key: string; value: number | string | boolean };
```
The sim applies `release` at step 0 (develop, load, allocate, as for births in 9.6, keyed by the new entity ids) and `setting` by key from a whitelist the sim owns. The host journals both exactly as it journals `god` today.

## H3. Expose the sim's pending journal queue

**What.** `sim.schedule()` keeps its queue in a private WeakMap.

**Why.** A snapshot must carry inputs scheduled for later ticks (EVTQ). The host mirrors the queue itself (`HostWorld.pending`), which works only while the host is the sole caller of `schedule`.

**Change.** Export `pendingJournal(world: World): readonly JournalEntry[]` from `src/sim/index.ts`.

## H4. GLOW_FIELD codec in core

**What.** CONTRACT 12.2 defines GLOW_FIELD (`f32 rect[4], u16 w, u16 h, RGBA8 x w x h`) but `src/core/protocol.ts` has no encoder or decoder.

**Why.** The renderer needs the decoder; the host has written both (`encodeGlowField`, `decodeGlowField` in `src/host/interest.ts`), with the keyframe flag set.

**Change.** Move those two functions into `src/core/protocol.ts` unchanged. The host uses `w x h = 128 x 72` for any rect; document "the host chooses w and h; 16:9, at most 512 x 288".

## H5. The 50:1 decompression-ratio cap rejects sparse sections

**What.** `readPtk` refuses any section with `rawLen > storedLen * 50`. Field grids that are mostly zero (scent, sediment, cysts in a young world) deflate far better than 50:1, so a world written with deflate everywhere could not be read back.

**Why.** The cap defends against decompression bombs, but `inflateRawSync` is already bounded by `maxOutputLength = rawLen` and the reader has a total raw-size cap, so the ratio cap adds nothing for honest files and costs disk space (the host now stores such sections raw).

**Change.** In CONTRACT 14.1 and `container.ts`: apply the ratio cap only to sections whose `rawLen` exceeds 16 MiB, or raise it to 1000:1. Either keeps the bomb defence; the host's writer fallback can then go.

## H6. Genome key for BODY_ENTER

**What.** BODY_ENTER carries `genomeLo, genomeHi` (the xxh64 key, DESIGN R17), but the creature column `genome` is a u32 index into the genome store.

**Why.** The host cannot turn the index into the content key without the genome store API. It sends the index zero-extended for now.

**Change.** The genome module exports `genomeKey(world: World, slot: number): bigint` (or the store gains a `keyOf(index)`), callable from the host.

## H7. Pairing and health endpoints belong in the contract

**What.** The host serves `GET /health`, `POST /pair/request`, `GET /pair/status?pairId=`, and, with the god token as a Bearer header from loopback, `GET /pair/pending`, `GET /pair/devices`, `POST /pair/approve {pairId, code}`, `POST /pair/deny {pairId}`, `POST /pair/revoke {deviceId}`. The TV gets a per-device token to pass as `token` in HELLO.

**Why.** The UI (TV pairing screen, god-window device list), the Android TV wrapper and the Tauri shell all need them; they are not in CONTRACT 12.

**Change.** Add a short "12.3 HTTP endpoints" table to CONTRACT with the routes above and their JSON bodies (see `docs/modules/host.md`).

## H8. "All sim state lives in the World"

**What.** Snapshots (`.ptk`) store the SoA pools, the globals and the field grids. Any module that keeps per-world state elsewhere (a WeakMap cache that changes results) breaks exact resume.

**Change.** Add to CONTRACT 4.2: "Every value that can change a later tick's result lives in the World (pools, fields, globals) or in the journal. Module-private caches must be rebuildable from those." The host's round-trip test (`tests/host-persistence.test.ts`) will catch violations for every module merged into the pipeline.
