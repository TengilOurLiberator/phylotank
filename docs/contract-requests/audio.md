# Contract requests: audio

## 1. Richer AudioModule inputs (CONTRACT 10.2, `src/core/contract.ts`)

**What.** Add optional inputs beside `setMood`:

```ts
export interface AudioModule {
  start(): Promise<void>;
  stop(): void;
  setMood(m: { activity: number; richness: number; stress: number; darkness: number; season: number }): void;
  census?(c: { species: { id: number; count: number; biomassKg: number }[] }): void;
  events?(evs: readonly SimEvent[]): void;
  camera?(c: { depth01: number; zoom01: number; giants?: { id: number; sizeRel: number; area: number; phase: number }[];
               births?: number; kills?: number; featured?: number | null; night?: boolean }): void;
}
```

**Why.** 06 §6.3.2 maps biomass, Shannon diversity, disasters, speciation (motif mutation), camera depth and zoom, giants' stroke phases, births and kills on screen and the featured species to sound; five mood scalars cannot carry these. Implemented locally by `Ambience` in `src/audio/index.ts`.
