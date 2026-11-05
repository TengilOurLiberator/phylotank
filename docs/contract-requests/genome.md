# Contract requests from src/genome

Filed by the genome engineer, phase 1 (2026-11-05). Each item says what, why, and the exact change. The module already implements the proposed behaviour behind local adapters, so nothing blocks on these.

## G1. Fix the joint and body-frame conventions of the Phenotype (CONTRACT 7.1)

**What.** CONTRACT 7.1 gives `attachU` (-0.5..0.5) and `restAngle` without a sign convention, so physics and render could read them differently.

**Why.** `develop()` must place parts and physics must join them the same way; the renderer regrows bodies from the same numbers.

**Proposed text for 7.1** (what `src/genome` implements):

> Every part's axis points from its free end (tip) towards its joint end (base). The root's base is the snout, so the root axis is the creature's forward direction `f`. A child's joint is at its own `+0.5` end and at `attachU * length` along the parent's axis, where `attachU = 0.5 - attachPos / 255` (`+0.5` is the parent's base, `-0.5` its tip). `restAngle` is the child's axis angle relative to the parent's axis, in the world sense (positive from +x towards +y) for `heading = 0, mirror = +1`; a positive angle lifts a trailing child's free end dorsally. `limitLo = restAngle - range/2`, `limitHi = restAngle + range/2`, both relative to the parent. `u` is 0 at the snout and 1 at the tail end of the root chain, clamped; `v` is the dorsal offset over `L/4`, clamped to [-1, 1]; `d` is 0 to 1 along an appendage, 0 on the root chain. `lengthM` is the root-chain length, so a flagellum does not count. `taper` is a ratio (tip width / base width), not metres. `span` is `spanGene x 2 x radius`, doubled for `PAIRED`; fin mass uses the plate volume `length x span x 2 radius`.

## G2. Put the innovation registry into `MutationContext` (CONTRACT 6.8, 10.2)

**What.** `GenomeModule.mutate(g, ctx)` needs the world's innovation registry (01 §1.3.7, DESIGN R16), but `MutationContext` has no field for it, so a module-level registry would leak between worlds in one process (tests, the host running a test tank next to the world).

**Proposed diff** (`src/core/contract.ts`):

```ts
export interface InnovationSource {
  /** Same structural event (53-bit key), same id, inside the sliding window. */
  innovFor(key: number): number;
  lookup(key: number): number | undefined;
  noteBirth(): void;
}
export interface MutationContext {
  ...
  /** The world's registry; saved in META (or a new optional section INNO) of every `.ptk`. */
  readonly registry: InnovationSource;
}
```

**Local adapter.** `createGenomeModule(registry)` binds one `InnovationRegistry` per world, and `mutate` also honours an optional `ctx.registry`. `InnovationRegistry.save()` / `load()` give a JSON-safe snapshot form; the sim and host should store it with the world.

## G3. Record the mouth table (DESIGN R12) in CONTRACT 7

**What.** The fixed table from mouth subtype to `MouthDescriptor` weights is implemented but not in the contract.

**Proposed table:** FILTER: `filter = 1`, `mesh = gape x 0.001 x 100^(1 - p2/255)`; JAWS: `bite = 1`, `biteForce = MUSCLE_STRENGTH x muscleFrac(host) x pi r_host^2`; RASP: `scrape = 1`; PROBOSCIS: `latch = 0.5 + 0.5 x p4/255`, `scrape >= 0.3`; SUCTION: `suction = 1`, `latch >= 0.5 x p4/255`. `gape = (2 x p1/255) x G_MOUTH x host width`, the largest over all mouths. Weights take the maximum over mouths.

## G4. Regulatory-gene semantics (CONTRACT 6.6)

**What.** 01's gate formula cannot switch a part on (with expression defaulting to true, `expressed || f > 0.5` is always true), and DV has no numeric axis value.

**Proposed text:** a gate with `amount >= 0` expresses the part only where `f > 0.5`; with `amount < 0` it suppresses the part where `f > 0.5`; several gates combine by AND. Scalar genes multiply the decoded field by `exp(amount x f)` with `amount = i8 / 127`, then clamp to the field's range. Axis values: AP in [0, 1] from the root chain; DV `t = (dv + 1) / 2` (ventral 0, axial 0.5, dorsal 1); MATURITY `m`; DEPTH_AT_BIRTH `env.depth01`. `centre = q/255`, `width = 0.01 + 0.99 q/255`. Gating the root is ignored.

## G5. Deepcrown carries the leviathan flag (CONTRACT 3.3)

**What.** 3.3 says the flag is set only by a confirmed "Release as leviathan". The genome brief for phase 1 asks for "Deepcrown leviathan seed with the leviathan flag", so `template('deepcrown')` returns a flagged genome (and `DESIGNED`).

**Proposed text for 3.3:** "The Deepcrown template is flagged. Releasing any flagged genome, Deepcrown included, is a major action that needs the 'Release as leviathan' confirmation and brings the endowment; a release without it clears the flag first." The UI and host enforce this; the genome module only stores the flag.

## G6. Species definition for budders (review R14): the lineage rule

**What.** Spike 3 (genome half, `docs/spikes/genome-3.md`) shows that 01 §1.9.3's rule (a birth further than theta from its species' medoid founds an incipient species) shatters clonal populations into many promoted species under neutral drift, with either distance. The default is now the **lineage rule**: a birth always joins its parent's species (or that species' latest split daughter, if nearer its medoid); species arise only from reservoir splits (2-medoids; both clusters at least a quarter of the 64-member sample; medoids more than theta apart; mean silhouette above 0.25), and promotion needs `N_MIN` members, 2 founder generation times and living biomass of at least 4 founder adults. Budders use the body-plan descriptor distance, sexual genomes the genetic distance.

**Proposed change:** CONTRACT 11's `speciation` event semantics stay; add to 6.8 or a new 6.9: "Species assignment is host-side (`SpeciesRegistry` in `src/genome`), the lineage rule by default; the medoid rule of 01 §1.9.3 is an option for experiments. Species ids are sequential per world and never reused."

## G7. Life-history decoding (CONTRACT 9.4, 9.6; review R10)

**What.** `t_mature` is needed by the sim (creature column `tMature`) and ecology, and 01 §1.4.4 has no `k0`.

**Proposed text for 9.4:** `k = GROWTH_RATE x K0 x (L_adult / 1 cm)^-(3 (1 - KLEIBER_EXP))`, `K0 = 1/600 s^-1`; `t_mature` is the von Bertalanffy time from `L_0 = BIRTH_FRACTION x L_adult` to `MATURITY_FRACTION x L_adult` with `L_inf = L_adult / 0.98`; `CLUTCH_SIZE` decodes as `round(v)` clamped to 1..64. A 1 cm default genome matures in about 9 minutes, a 20 cm one in about 90 minutes, a 0.5 mm one in about a minute (the review's estimates). `lifeHistory(g, lCeilingM)` in `src/genome` is the one implementation.

## G8. Small notes

- `DevelopOptions.maxParts` of 0 means `MAX_PARTS`; values above 64 are clamped.
- `G_SLENDERNESS` divides every part's width (slender means thinner).
- `G_TAPER` narrows the root chain towards the tail: width x `G_TAPER^-AP`.
- `OrganKind` has no entry for SHELL, PHOTOSYNTH or PAIRED; those exist only as organ flags, which is enough for brains (they have no I/O channel).

## G9. Genome replication cost (01 §1.6.4) is missing from CONTRACT 9.6

**What.** 01 charges `E_dna = kappa x genomeBytes` per offspring so that silent genes and bloat cost something (strongly for microbes, negligibly for giants). CONTRACT 9.6's clutch cost has no such term. Without selection, mutation alone grows genomes: 400 unselected births at 4x the default rate took Meadowlamp from 7 to 47 modules (8 expressed parts); see spike genome-1.

**Proposed diff** to the clutch cost in 9.6: add `+ n x KAPPA_DNA x genomeBytes` with `KAPPA_DNA` set so a 4 KB genome costs 2% of the build cost of a 0.5 mm newborn (a 0.5 mm newborn is about 3.9e-9 kg, so about `2.6e-14 kg` per byte; to be tuned with the ecosystem). `encodedSize(g)` in `src/genome` gives the byte count without encoding.
