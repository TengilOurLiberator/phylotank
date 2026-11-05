# Contract requests from src/ecosystem (phase 1)

Each item says what, why, and the exact type or diff. Until the integrator applies them, the ecosystem implements against local adapters (named below), so nothing here blocks other modules.

## E1. Ecosystem extension functions on `EcosystemModule`

**Why.** CONTRACT 9.6 has births committed by the sim, but no interface says how the sim learns about reproduction requests, how mass moves from a parent to a child, or how the ecosystem learns a creature's traits. The ecosystem cannot read genomes itself (the creature column `genome` is a handle into a host-side store).

**Local adapter (today).** Free functions exported from `src/ecosystem/index.ts`:

```ts
interface CreatureEcoInit {
  traits: Uint16Array;                         // the genome's TRAT q values
  phenotype?: { mouth: MouthDescriptor; gGut: number; gutVolume: number; massKg?: number; adultLengthM?: number;
                nParts?: number; organs?: Uint16Array; length?: Float32Array; span?: Float32Array };
  adultMassKg?: number; photoAreaM2?: number; immigrantTick?: number;
}
loadCreatureEco(world, slot, init): void                 // decode traits into the ecosystem cache
endowCreatureEco(world, slot, tissueKg, reserveKg): boolean   // body from dissolved N (founders, releases)
takePending(world): Pending                              // births, deaths, restage, free, spawns of this ecology tick
commitOffspringEco(world, req, childSlot, ctx): boolean  // move tissue and reserve from parent qRepro to the child
finishRequest(world, req): void
commitPending(world, ctx, hooks: CommitHooks)            // reference commit in (parentEntityId, requestIndex) order
applyBiteEco(world, attacker, target, chunkKg): number   // see E3
commitCarcassSpawn(world, slot, req)                     // whale fall
releaseSlot(world, slot)                                 // a fully decayed carcass
mutagenAt(world, x, y): number                           // MutationContext.mutagen for a birth
natureEvent(world, ctx): GodEventScheduled | null        // E5
computeMetrics(world): EcoMetrics
```

**Proposed diff to `src/core/contract.ts`:**

```ts
export interface EcosystemModule {
  // ...existing six methods...
  loadCreature(world: World, slot: number, init: CreatureEcoInit): void;
  endowCreature(world: World, slot: number, tissueKg: number, reserveKg: number): boolean;
  pending(world: World): EcoPending;         // read after stepEcology, before sim.commit
  commitOffspring(world: World, req: BirthRequest, childSlot: number, ctx: StepContext): boolean;
  applyBite(world: World, attacker: number, target: number, chunkKg: number): number;
  mutagenAt(world: World, x: number, y: number): number;
}
```

with `BirthRequest`, `DeathRequest`, `SpawnRequest`, `EcoPending` and `CreatureEcoInit` moved from `src/ecosystem/state.ts` / `metabolism.ts` into `src/core/types.ts` unchanged.

**Semantics the sim must follow.** Deaths are converted to carcasses by the ecosystem at the end of `stepEcology` (life ALIVE to CARCASS, pools stay); the sim then frees the brains of `pending.deaths`. For each birth request the sim allocates a slot, runs genome operators, `develop`, `physics.loadBody`, `brain.allocate`, calls `loadCreature`, then `commitOffspring`; if that returns false it frees the slot. Requests not committed by the next ecology tick lapse and the parent asks again (deferred, never dropped). `pending.free` lists carcasses whose pools are empty; the sim clears those slots.

## E2. World config: habitat preset

**What.** `WorldConfig.habitat?: 'basin' | 'lagoon' | 'twinBasins' | 'open'` (default `'basin'`).

**Why.** 04 §4.1 names three generators; tests and spike runs need a featureless tank. Today the ecosystem reads `config.habitat` loosely and, as a phase-0 compatibility rule, gives worlds with `skeletonMotes` the `'open'` tank (the skeleton's passive motes do not collide with terrain, so the sim test "motes move with the current" would otherwise see a quarter of them parked in rock). Remove that rule when the skeleton retires.

## E3. Bite buffer from physics to the ledger

**Why.** Physics resolves bites, swallows and latch drains (DESIGN R12) but may not import the ecosystem, and only the ecosystem may move quanta. A shared buffer in the world closes the loop.

**Proposed.** A small SoA pool in `src/core/layout.ts`, capacity `agentCap`, cleared by the ecosystem each ecology tick:

```ts
export const BITE_COLUMNS = [
  { name: 'attacker', type: 'u32' }, { name: 'target', type: 'u32' }, { name: 'chunkKg', type: 'f32' }, { name: 'kind', type: 'u8' }, // 0 bite, 1 swallow, 2 latch drain
] as const;
```

Physics appends in `(attacker slot, contact order)`; `stepEcology` applies them in order through `applyBite` before metabolism.

## E4. Ecosystem state that should be in the snapshot and the hash

**Why.** CONTRACT 4.5 hashes only the SoA pools and field grids. The ecosystem keeps, in a per-world side table, state that changes sim results: the strain table and spores (CONTRACT 5.5 lists them but `layout.ts` has no columns yet), installed vents and their output, rift-barrier cells, the ageing clock and peak tissue per creature, the photosynthesis EMA, the immigrant tick, the reproduction-request flag, and the nominal reservoir size. Two identical runs stay identical (tested), but a snapshot restore would lose these.

**Proposed.**
- `STRAIN_COLUMNS` (capacity 4,096): `live u8, id u32, parent u32, bornTick f64, antigen u32, adhesin u32, beta f32, virulence f32, growth f32, envHalfLife f32, routes u32, hostCount u32, sporeLoad f32`.
- `SPORE_COLUMNS` (capacity 65,536): `posX f64, posY f64, strain u32, load f32` (as CONTRACT 5.5).
- Append to `CREATURE_COLUMNS`: `ageClock f32` (hazard clock with frailty), `tissuePeak f64` (quanta), `immigrantTick f64`, `ecoFlags u8` (bit0 repro request pending, bit1 starving).
- `WorldGlobals`: `reservoirNominalQ` (f64), `vents` (array of `{x, y, bornTick, output, permanent}`) and `barriers` (map of command id to cell lists) in the canonical CBOR, or as an `EVTQ` sub-record.
The traits cache itself is derived from the genome store and need not be saved: `loadCreature` rebuilds it on restore.

## E5. Nature-mode events are journalled like god casts

**What.** `natureEvent(world, ctx)` is a pure function of (seed, tick) on governor ticks. The host (or the sim) calls it, journals the result as a `god` entry with `author: 'nature'`, and applies it at its fire tick. No contract type changes; please state in CONTRACT 13 that nature events are journalled at issue time like casts.

## E6. FLOW_MODES amplitudes

Phase 0's flow mode means (0.05, 0.03, 0.03, 0.015, 0.01 m/s) are halved to (0.03, 0.015, 0.015, 0.008, 0.005). With terrain-following modes the shallow shelf speeds up by mass continuity, and the old values gave 0.23 m/s interior jets, above 04's "0.02 to 0.08 m/s in the interior", and forced six transport substeps on the fine grid. No contract value changes (the table is ecosystem-owned); listed so physics and render know.

## E7. Ledger channel for photosynthesis by plant creatures

No change needed: plant creatures book on channel 0 (photosynthesis) and chemosynthetic mats on channel 1. Noted because CONTRACT 9.2 says only photosynthesis and chemosynthesis may raise the energy factor, and cyst germination (cysts f 0.3 to plankton f 0.6) is booked as photosynthesis.
