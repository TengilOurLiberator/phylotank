# Contract requests from src/sim

Filed 2026-11-05 by the sim engineer. Each request says what, why and the exact type. All are implemented today behind local adapters in `src/sim`, so nothing blocks; the integrator moves them into `src/core` and the other modules switch to them.

## S1. Birth and death request queues on the World (CONTRACT 4.2 rule 6, 9.6, 10.1)

**Why.** The contract says births and deaths "requested during a tick are committed at the end of the next ecology tick", but defines no queue. The ecosystem (reproduction, starvation, ageing) and physics (predation kills) must request them, and neither may import `src/sim`. Today the queues live in `src/sim/requests.ts` in a WeakMap, reachable only by the sim's fallbacks.

**Change.** Add to `src/core/types.ts`:

```ts
export interface BirthRequest {
  parentSlot: number; parentId: number;   // bearer (pays)
  requestIndex: number;                    // per parent per commit window, from 0
  mode: 'bud' | 'sex';
  mateSlot: number; mateId: number;        // -1 for 'bud'
  n: number;                               // requested clutch, >= 1; the commit shrinks it to what the bearer can pay
  tick: number;                            // tick of the request
}
export interface DeathRequest { slot: number; id: number; cause: DeathCause; killer?: Id; tick: number }
export interface SimRequests { births: BirthRequest[]; deaths: DeathRequest[]; deferred: BirthRequest[] }
```

and to `World` (`src/core/world.ts`) a field `readonly requests: SimRequests` allocated empty by `allocWorld`, plus two helpers in core (`requestBirth(world, r)` assigning `requestIndex` and setting `CF.BUDDING`, and `requestDeath(world, slot, cause, tick, killer?)`), which are exactly `src/sim/requests.ts` moved. Commit order stays the sim's: deaths by `(entityId, tick)`, then births by `(parentEntityId, tick, requestIndex)` (the tick only orders deferred requests before new ones; see S4).

**Payment rule (please confirm in 9.6).** The ecosystem moves reserve into `qRepro`; the commit pays the clutch from `qRepro` (tissue and the 0.3 starting reserve to the child; growth heat `0.4 m_o`, the per-offspring overhead and the cap fee burnt to dissolved N at the bearer's cell) and shrinks the clutch to what `qRepro` covers. A request the bearer cannot pay for one offspring is dropped and `CF.BUDDING` is cleared, so the ecosystem asks again later ("or waits").

## S2. A genome store interface (CONTRACT 5.1 `genome`, 6.8)

**Why.** The creature column `genome` is "a u32 handle into the host genome store", owned by `src/genome`, but there is no interface, and the ecosystem, brain and views all need genomes by handle (traits for metabolism, `GENOME_REQ`, `BODY_ENTER.genomeKey`). The sim needs to intern children and release the dead in commit order.

**Change.** Add to `src/core/contract.ts`:

```ts
export interface GenomeStore {
  intern(g: Genome): number;          // add a reference, dedupe by xxh64 of canonical bytes, lowest free handle
  retain(handle: number): void;
  release(handle: number): void;      // frees the handle at zero references
  get(handle: number): Genome;
  key(handle: number): bigint;        // xxh64 content key
  bytes(handle: number): Uint8Array;  // canonical bytes (for GENOME frames and .ptk GENO)
}
```

and make it reachable from a world (`stateOf(world).store` today; proposed `world.genomes: GenomeStore` in core, implemented by `src/genome`). `src/sim/store.ts` is the reference implementation.

## S3. Species registry and assignment

**Why.** "species assignment" is listed under `src/genome` (CONTRACT 16) and as a step of the birth commit (9.6), but has no interface; `speciation` and `extinction` events are listed as host-sourced (CONTRACT 11), yet both are decided at commit time, in commit order. The sim emits them as primitive events today (deterministic, replayable).

**Change.** Either add `assignSpecies(parentSpecies, child: Genome, handle, ctx): { species: number; isNew: boolean }` and `speciesDied(species): boolean` to `GenomeModule`, or accept `src/sim/species.ts` (founder-as-representative, `THETA_SPECIES = 0.3` against `genome.distance`) as the v0.1 registry. In CONTRACT 11, change the source of `speciation` and `extinction` from "host" to "step".

## S4. Deferred births keep their tick for ordering

**Why.** 9.6 orders the commit by `(parentEntityId, requestIndex)`. A birth deferred at the cap is retried at the next commit, where a fresh request of the same parent could carry the same `requestIndex`. **Change:** order by `(parentEntityId, tick, requestIndex)`; for non-deferred requests the tick never changes the order the contract defines within a window except to put older requests first.

## S5. Founders in WorldConfig

**Why.** `WorldConfig.skeletonMotes` is the phase-0 seeding knob; worlds now start with creatures. **Change:** add `founders?: { template: TemplateId; count: number; genome?: Uint8Array }[]` to `WorldConfig` (today `SimConfig` in `src/sim/index.ts` extends it). Founders take their mass from the dissolved N under them, so `M_total` is unchanged; god releases inject (`ledger.inject`). `skeletonMotes`, if still set, seeds that many Motefly founders.

## S6. Releases through the journal

**Why.** CONTRACT 13 journals casts as `GodEventScheduled`, but a creature release changes sim state too and must replay. **Change:** add a journal entry kind `{ tick, kind: 'release', release: { cmdId, genome: Uint8Array, pos: V2, spread?: V2, count, asLeviathan, founderProtection } }` (today `JournalEntry` in `src/sim/state.ts`), applied at the start of its tick like a god event. The `.ptk` `EVTQ` and `JRNL` sections should carry it.

## S7. View-side details of the protocol

- **DUST palette size.** `WELCOME.palette` is `n x RGB8`; the sim sends a 252-entry 6 x 7 x 6 RGB cube so every body colour has an index (255 stays "empty"). The phase-0 renderer reads only the first 16 entries; the contract should say `n <= 255` and that readers must take all of them.
- **Speed display.** CENSUS `env` gains `speed` (0, 0.25, 1, 4, 16 or 'max'), `fastForward` (boolean) and `achievedX`, and STATS gains `pacer` (the full lease), so every view can show a fast-forward (William's Q2, "never fast-forward silently").
- **BODY record flags.** Proposed bits: 0 juvenile, 1 eating, 2 hurt, 3 mating, 4 carcass, 5 leviathan, 6 budding, 7 founder (`BODY_FLAG` in `src/sim/frames.ts`).
- **Body and dust overlap.** A creature in a client's body stream is marked empty in that client's DUST_FRAME, so it is never drawn twice. Please state this in CONTRACT 12.
