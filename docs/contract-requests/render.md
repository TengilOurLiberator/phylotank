# Contract requests from src/render

Filed by the render engineer, phase 1 (2026-11-05). The renderer implements each of these against a local adapter, so nothing blocks on them.

## 1. Body flag bits in core (CONTRACT 12.2, BODY_ENTER and BODY_FRAME `flags`)

**What.** The contract gives BODY_FRAME a `u8 flags` but no bit table. 05 §5.3 lists "eating, mating, hurt, diseased, dying, budding, carrying a parasite, selected". Please add to `src/core/protocol.ts`:

```ts
export const BODY_FLAG = { EATING: 1, MATING: 2, HURT: 4, DISEASED: 8, DYING: 16, BUDDING: 32, PARASITE: 64, SELECTED: 128 } as const;
```

**Why.** The renderer fades dying creatures (20 s body, 10 to 30 s glow), mottles diseased glow, and never demotes a selected subject's LOD; the sim must set the same bits. Local adapter: `BODY_FLAG` in `src/render/index.ts` with exactly these values.

## 2. Codecs for NEAR_POSE, GLOW_FIELD and FIELDS in core

**What.** `src/core/protocol.ts` has no encoder or decoder for 0x13 NEAR_POSE, 0x15 GLOW_FIELD and 0x16 FIELDS. Please add `encodeNearPose/decodeNearPose`, `encodeGlowField/decodeGlowField`, `encodeFields/decodeFields` with the payloads of CONTRACT 12.2 exactly as written.

**Why.** The renderer decodes them today with local readers in `src/render/index.ts` (`ingestNearPose`, `ingestGlow`, `ingestFields`) that follow the table byte for byte; the sim needs the matching encoders, and one codec in core avoids drift.

## 3. NEAR_POSE joint order

**What.** State that `angle[j]` is the joint angle of part `j + 1` in the Phenotype's BFS order (the root has no joint), as offsets from `restAngle`.

**Why.** The renderer adds `angle[j]` to the rest angle of template node `j + 1`. Templates from `templateFromPhenotype` keep one end node per part, so the mapping is exact once the host uses the same order.

## 4. Render template source

**What.** No change to types; a note in CONTRACT 15: views obtain a `RenderTemplate` by fetching the genome (GENOME_REQ/GENOME), calling `genome.develop(g, maturity/255, env, {maxParts, lCeilingM})` and `templateFromPhenotype` (exported by `src/render`). The Look genes are read from the TRAT block: `BODY_HUE` (pigHue), `BODY_SAT` (pigSat), `BODY_LUM` (pigLight), `1 - TRANSLUCENCY` (opacity), `GLOW_HUE` (lumHue), `GLOW_BASE` (lumGain), `PATTERN_FREQ` and `PATTERN_CONTRAST` (stripes), `TRAIL_LENGTH` (trailGain), `PULSE_FREQ` and `PULSE_SHAPE` (period and duty).

**Why.** `genome.develop` is a stub on this branch, so `src/render` ships hand-authored archetype templates (`src/render/archetypes.ts`) as a fallback keyed by species. `WebGL2Renderer.setTemplateSource` is the seam the UI wires once `develop` lands.
