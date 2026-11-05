# Contract requests from src/ui (phase 1)

Each item is implemented against a local adapter in `src/ui/god/wire.ts` or `src/ui/mock-sim.ts`, so nothing blocks. The integrator can apply them as written.

## 1. Shape the STATS payload (CONTRACT 12.2, 0x21)

**Why.** STATS is "population, species, ledger channels, metrics" with no fields, but the god window needs species metadata (names, colours, origin, parents for the phylogeny), the snapshot list for bookmarks and rewind, the speed lease state (achieved speed, `until`, unattended) and population history on reconnect. Nothing else carries the snapshot list.

**Proposed type** (add to `src/core/types.ts`; this is `StatsPayload` in `src/ui/god/wire.ts`):

```ts
interface StatsPayload {
  tick: number; epoch: number;
  speed: { requested: Speed; achieved: number; until?: { tick?: number; wallIso?: string }; unattended?: boolean; leaseLeftS?: number };
  population: number;
  species: { id: number; name: string; common?: string; count: number; biomassKg: number; colour: [number, number, number];
             parent: number; bornTick: number; extinctTick?: number; origin: 'template' | 'designed' | 'natural' | 'imported' | 'captured';
             leviathan?: boolean; glyph: number; prefDepth: number }[];
  snapshots: { id: string; name: string; tick: number; epoch: number; kind: 'manual' | 'auto' | 'beforePower' | 'beforeRewind';
               life: number; species: number; parentId?: string }[];
  history?: [tick: number, flat: number[] /* speciesId, count, ... */][];   // full ring on (re)connect
  sample?: [tick: number, flat: number[]];                                   // one per STATS
  genes?: Record<string /* trait name */, Record<string /* species id */, number[] /* 32 bins */>>;  // every 5 s
  selected?: InspectDetail;                                                  // see 2
  env?: { tempC: number; light: number; vents: [number, number][] };
}
```

## 2. Inspector detail (INSPECT, 0x22, and DESIGN R34)

**Why.** INSPECT carries activations only. The inspector also needs energy, health, age, generation, current action, offspring, ancestors (with collapsed unary stretches), children, the genome key and a brain graph to draw the activations on.

**Proposed.** Keep INSPECT binary at 10 Hz and fix its tail: `u32 idLo, u32 idHi, u16 nNeu, i8 x nNeu, u8 nScope, f32 x nScope` (the count byte is new; "up to 8 f32" had no count). Put the slow detail in STATS as `selected` (1 Hz):

```ts
interface InspectDetail {
  id: number; species: number; energy: number; health: number; ageS: number; lengthM: number; adult: boolean; generation: number;
  offspring: number; action: string; parents: number[];
  ancestors: { id: number; gen: number; alive: boolean; species: number }[]; collapsed: number;
  children: { id: number; gen: number; alive: boolean; species: number }[];
  genomeLo: number; genomeHi: number; pos: [number, number];
  brain: { inputs: string[]; outputs: string[]; hidden: number; edges: [src: number, dst: number, w: number][] };
}
```

Node index space for `brain.edges` and the INSPECT activations: inputs, then motor neurons (one per output), then the remaining neurons, which matches CONTRACT 8.1 when `inputs` are the input channel names.

## 3. Codecs for INSPECT, GENOME_REQ and GENOME in `src/core/protocol.ts`

**Why.** The frames are specified but have no codec, so the host and UI would each write one. Copy `encodeInspect`, `decodeInspect`, `encodeGenomeReq`, `decodeGenomeReq`, `encodeGenomeFrame`, `decodeGenomeFrame` from `src/ui/god/wire.ts` into core.

## 4. `SimLink.kind` gains `'mock'`

**Why.** `MockSimLink` (the in-page stand-in host that lets the god window, designer and captioned views run with no host) has to claim `'worker'` today. Diff: `readonly kind: 'worker' | 'socket' | 'mock';` in `src/core/contract.ts`. The e2e smoke test only checks `kind` on `index.html`, which keeps the worker.

## 5. A synchronous inflate, or an async `decodePtkg`

**Why.** `decodePtkg` takes a synchronous `Deflate`; browsers only have the async `CompressionStream`. Today the UI writes uncompressed `.ptkg` (flag 0) and refuses compressed imports with a reason. Either add `decodePtkgAsync(bytes, inflate: (b, max) => Promise<Uint8Array>)` with the same caps, or ship a small capped inflate in core. Templates fit QR codes uncompressed (docs/spikes/ui-1.md), but evolved genomes near the 16 KB cap will not.

## 6. A `worldReset` signal

**Why.** 07 §3.8 says views drop their interpolation buffers on `worldReset`. The UI treats a WELCOME with a new `epoch` as that signal (the mock re-sends WELCOME after a rewind). Recording this in CONTRACT 12 ("after a rewind the host re-sends WELCOME with the new epoch to every client") would make it binding for the host.

## 7. Release by genome, and the release count cap

`release` carries `ptkg` bytes. The UI always sends a `.ptkg` (never `libraryId`, since the browser-only library is per viewer) and sets the leviathan flag in the genome itself as well as `asLeviathan: true`. The mock clamps `count` to 1..500 as in 07 §2.1; please state the cap in CONTRACT 13.
