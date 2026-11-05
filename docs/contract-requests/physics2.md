# Contract requests from physics, second pass (phase 1)

Each item: what, why, the exact change, and the local adapter physics uses meanwhile so nothing blocks. Numbering continues physics.md's P1 to P7 as PH2-n.

## PH2-1. Severing needs a commit hook (sim allocates, ecosystem moves the quanta)

**Why.** 02 §2.4.7 and DESIGN Q5: a segment at damage 1 detaches with its subtree and becomes a corpse fragment that stays as food. Physics decides the cut and does the mechanics, but the new creature slot and segment range are the sim's (`allocCreature`, `allocSegments`), and the tissue and reserve that leave with the fragment are ledger transfers (CONTRACT 9.1), which only the ecosystem may book.

**Change.** In CONTRACT 10.1, step 4, after the deaths and before the births of `sim.commit()`:

```
4b. severs: physics.commitSevers(world, hooks)    in (creature slot, deepest segment) order
```

and in `src/core/contract.ts`:

```ts
interface SeverHooks {
  allocCreature(world: World): number;                                  // sim: lowest free slot, fresh id, birthTick
  allocSegments(world: World, slot: number, n: number): boolean;        // sim: contiguous range, owner set
  moveQuanta(world: World, from: number, to: number, qTissue: number, qReserve: number): void;
                                                                        // ecosystem: ledger.transfer(..., 'sever'), updates massKg
}
interface SeverResult { parent: number; fragment: number; keep: Int16Array; moved: Int16Array; qTissue: number; qReserve: number }
interface PhysicsModule {
  // ...
  commitSevers?(world: World, hooks: SeverHooks): SeverResult[];
}
```

The fragment takes `floor(f * qTissue)` and `floor(f * qReserve)` with `f` its share of the segment mass; gut and reproductive pools stay with the survivor. Both are creature pools of the audit sum, so `M_total` is untouched (integer equality holds; `tests/physics-sever.test.ts` checks it with the adapter).

The fragment is a `CARCASS` with `CF.FRAGMENT` (and `CF.LEVIATHAN` if the parent had it), no brain, no infection, `birthTick` = the cut tick. The ecosystem should treat it like any carcass (leaching to detritus and N, scavenging). If `allocSegments` compacts the pool, it must do so before physics reads the parent's range (physics re-reads `segStart` after the call).

Adapter: `commitSevers(world, localSeverHooks)` exported from `src/physics/index.ts`; `localSeverHooks` allocates like the sim and moves the quanta directly between the two records. Until the sim calls it, severed segments stay attached at damage 1 (pending requests are kept, `pendingSevers(world)`).

## PH2-2. Fragment glow fade (ecosystem's glow pass)

**Why.** DESIGN Q5: fragments fade their glow over 30 s. `glow` (creature and segment) is written by the ecosystem.

**Change.** In the ecosystem's glow pass, for `CARCASS` records with `CF.FRAGMENT`: `glow = glow_at_cut * fragmentGlow(age)`, where `fragmentGlow(t) = max(0, 1 - t / 30)` (exported by physics as a pure function) and `age = (tick - birthTick) * DT`.

Adapter: `physics.step` calls `fadeFragments(world)`, which applies the same linear fade tick by tick, statelessly (`g(t + dt) = g(t) (T - t - dt) / (T - t)`). The ecosystem must then not overwrite fragment glow; once it applies the rule itself, physics drops the adapter.

## PH2-3. A `part` segment column: Phenotype part index per segment

**Why.** After a cut, the survivor's segments are compacted (CONTRACT 5.2 requires a contiguous parent-first range), so segment `k` is no longer Phenotype part `k`. The brain writes `cmd`/`cmd2` by part, and growth restages from a fresh Phenotype that still has every part.

**Change.** Append to `SEGMENT_COLUMNS`:

```ts
{ name: 'part', type: 'u16' },   // Phenotype part index of this segment; k after loadBody, kept through severing
```

and in CONTRACT 5.2: "Segment `k` of a creature is part `part[k]` of its Phenotype; `part[k] == k` until a part is severed." The brain addresses a part's segment through this column (or re-runs its layout from the `keep` map of `SeverResult`).

Adapter: `workFor(world).part` (per segment slot, like P1's other physics state; it does not follow the sim's `compactSegments`, which is P1's known gap). `physics.restage` with a Phenotype that has more parts than the creature keeps only the parts listed in `part` (`pruneSpecs`), so growth does not regrow a lost tail; regrowth is the repair rule's job (02 §2.6.6), not yet built.

## PH2-4. Jet and bladder state as columns

**Why.** Jets (02 §2.3.6) need the bell volume between ticks; gas bladders (2.3.8) need the gas amount `n_g`. Both are physics state that must survive a snapshot (CONTRACT 4.5). The bladder's gas exchange costs energy (`powerW`), and its organ is not in the ORGAN bits.

**Change.** Append to `SEGMENT_COLUMNS`:

```ts
{ name: 'jetVol', type: 'f32' },   // current bell volume, m^3 (JET organ segments; 0 otherwise)
{ name: 'gasMol', type: 'f32' },   // bladder gas, mol (BLADDER segments; 0 otherwise)
```

and an organ bit `ORGAN.BLADDER` (7.2), plus the Phenotype fields the genes give: the bell's maximum volume fraction (`jetFrac`, up to 0.3 of the segment volume, 2.2.6) and the bladder's `rigidFrac`. Drives: `cmd2` on a JET segment is the contraction drive; on a BLADDER segment `cmd2 > 0` inflates and `< 0` deflates.

Adapter: `workFor(world).jetVol` and `.gasMol`; the bell size is 0.3 of the segment volume; a segment is a bladder when the adapter `setBladder(world, seg, mol)` was called on it (tests), since no gene produces one yet.

## PH2-5. Roll is triggered by the ROLL global output

**Why.** CONTRACT 8.2 lists `ROLL` among the global outputs; `mirror` is a physics column but nothing said when it flips.

**Change.** CONTRACT 5.1 `mirror`: "Physics flips it when `out[ROLL]` crosses 0.5 upwards (hysteresis: re-armed below 0.2), at most once per 1 s; the flip mirrors rest angles, limits and muscle directions about the root axis, and the pose relaxes to the mirrored rest through the joints (no teleport)."

## PH2-6. Parasite removal events and the itch input

**Why.** 02 §2.4.5: a host scrapes a latched parasite off against terrain or another creature. The ecosystem stops the drain when the latch goes (it reads `latches(world)`, already in place); the brain's itch input needs the fraction of segments carrying a latch.

**Change.** None to the layout; for views, an optional event `{ k: 'scrape', host, parasite, pos }` in CONTRACT 11. The itch value per creature is `itch(world, slot)` from physics (fraction of the host's segments that hold a latch), which brain may call until a column exists.

## PH2-7. Contact heat (P5) still stands; the trailing-edge term needs no channel

The trailing-edge reactive force only sheds energy into the wake (its power is `-1/2 m w^2 u <= 0`), like drag, so it needs no ledger entry: the energy was paid as muscle work.
