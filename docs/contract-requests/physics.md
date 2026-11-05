# Contract requests from physics (phase 1)

Each item: what, why, the exact change. Physics implements against a local adapter for every item, so nothing blocks; the adapter is named.

## P1. Persistent physics state as columns (snapshot-exact determinism, I2)

**Why.** Some physics state outlives a tick but is not in the SoA pools, so a `.ptk` restore would continue slightly differently from an uninterrupted run (CONTRACT 4.5, test I2 "snapshot at tick 5,000, restore, continue: identical hash"). Today it lives in per-world `WeakMap`s (`src/physics/work.ts`, `contacts.ts`, `watchdog.ts`).

**Change.** Append to `SEGMENT_COLUMNS` (layout.ts):

```ts
{ name: 'muscleFrac', type: 'f32' },     // from the Phenotype; isometric cost m_mus = muscleFrac * mass
{ name: 'restPrev', type: 'f32' },       // rest angle at the end of the last tick (restage blends from it)
{ name: 'biteArmed', type: 'u8' },       // bite hysteresis (on 0.5, off 0.2)
```

and to `CREATURE_COLUMNS`:

```ts
{ name: 'biteCooldown', type: 'f32' },   // s until the next bite
{ name: 'wdE0', type: 'f64' },           // watchdog: water-frame mechanical energy at window start, J (-1 = unset)
{ name: 'wdIn', type: 'f64' },           // watchdog: muscle + buoyancy work in the window, J
{ name: 'wdTicks', type: 'u16' },        // watchdog: ticks into the window
```

Adapter: the WeakMap state; `muscleFrac` defaults to 0.3 and `restPrev` to `restAngle` when absent.

## P2. Mouth and grip outputs need their own segment channel

**Why.** CONTRACT 5.2 gives a segment `cmd` (muscle) and `cmd2` (fin pitch or one organ drive). A mouth part has three outputs (MOUTH_OPEN, BITE, LATCH; 8.2 OUTPUT_PART) and a claw has GRIP; none has a column.

**Change.** Append `{ name: 'cmd3', type: 'f32' }` to `SEGMENT_COLUMNS` and fix the mapping in CONTRACT 5.2 and 8.1: on MOUTH parts `cmd2 = MOUTH_OPEN`, `cmd3 = BITE` (JAWS, RASP) or `LATCH` (PROBOSCIS); on CLAW parts `cmd3 = GRIP`.

Adapter: physics reads the **bite drive from `cmd2` on MOUTH segments** (`src/physics/contacts.ts`, `tryBite`). Brain should write BITE there until `cmd3` exists.

## P3. A channel for bite mass transfers (physics to ecosystem)

**Why.** Physics decides bites (02 §2.4.3) but the ecosystem owns the conserving mass exchange (tissue quanta to the biter's gut and detritus, test C6). Ecosystem may not import physics, and a `bite` event is for views.

**Change.** Add to `World` (core/world.ts) a per-tick queue that physics appends to and `ecosystem.stepEcology` drains:

```ts
export interface BiteRecord { attacker: number; target: number; targetSeg: number; dmKg: number; tick: number }
// World
readonly queues: { bites: BiteRecord[] };
```

(slots, not ids; the queue is empty at every snapshot point because ecology drains it every third tick, or it is serialised with the journal). Adapter: `physics.drainBites(world)` exported from `src/physics/index.ts`; the sim can call it and hand the list to the ecosystem.

## P4. Hash ordering wording (CONTRACT 4.2 rule 4)

**Why.** The CPU hash is a counting sort over hashed cells, so neighbour lists are ordered by (cell hash bucket, slot), which is deterministic but not "(cellKey, slot)". Every contact effect is accumulated in fixed point and averaged, so the order does not change results anyway.

**Change.** Rule 4: "Neighbour lists (spatial hash) are ordered by a deterministic function of the state, such as (cell bucket, slot)".

## P5. Contact heat is not a ledger channel

**Why.** CONTRACT 10.3 says residual kinetic energy from contacts is "charged to the ledger as heat". With the spike-1 contact model (inelastic normal impulses, position corrections that add no velocity) contacts can only remove kinetic energy, and that kinetic energy was already paid for as muscle work (`powerW`). Charging it again would double count.

**Change.** CONTRACT 10.3: "contact position corrections add no velocity; contacts only remove kinetic energy, which was already charged as muscle work, so no ledger entry is needed". Physics still logs the lost energy per creature (`workFor(world).contactHeat`) for ram damage and diagnostics.

## P6. Optional diagnostic hooks on `PhysicsModule`

**Why.** The host logs watchdog-flagged genomes as regression cases (02 §2.14) and the inspector wants bite records; the host may import only sim.

**Change.** Extend the interface (contract.ts) with optional members, re-exported by sim:

```ts
interface PhysicsModule {
  // ...
  drainFlags?(world: World): number[];        // creature slots flagged by the exploit watchdog
  drainBites?(world: World): BiteRecord[];   // until P3 lands
}
```

Adapter: the free functions `drainFlags` and `drainBites` exported from `src/physics/index.ts`.

## P7. Muscle force-velocity law (design change, for the record)

Spike 1 found the explicit velocity-capped Hill motor of 02 §2.2.5 makes gaits depend on the substep count. Muscles are now implicit with a linear force-velocity law `tau = a tau_max (1 - w / w_max)`. No contract value changes; 02 §2.2.5 should be updated by its owner.
