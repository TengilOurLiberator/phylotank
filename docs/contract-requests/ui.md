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

## Second pass (mod/ui2)

### 8. A `rename` command, `namedBy`, and a `rename` event (07 §6.4)

**Why.** William's renames must win (Q9) and propagate to every view and into captured `.ptk` files (UX-T39). Today the UI sends `{t:'setting', key:'species.<id>.name', value:'{"g":"Genus","e":"epithet","c":"common?","all":true?}'}` (value at most 256 characters, as `mod/host` validates) and keeps a per-world mirror in localStorage that is applied over every name it receives, so a user name wins even when the host answers `unknown-setting`.

**Proposed.** In CONTRACT 13: `| rename | species: number, genus: string, epithet: string, common?: string, wholeGenus: boolean |`, validated as in `src/ui/naming.ts` `checkRename` (genus 3 to 24 letters, capitalised; epithet 3 to 24 letters, lowercase; letters and hyphen; duplicates allowed with a warning). In CONTRACT 11: `| rename | species, from: string, to: string, by: 'user' |` (source host). In STATS species: `namedBy: 'user' | 'generator'`. The name generator must never overwrite a `namedBy: 'user'` name, and a daughter species inherits a user-named genus (the UI already does this on display).

### 9. Knob keys, `STATS.settings`, the `setting` event and `world.new` (07 §3.9)

**Why.** The knobs panel needs to show what the host actually applied, and "why did everything die" needs each change on the timeline.

**Proposed.** The `setting` keys are the `KnobSpec.id`s in `src/ui/god/knobs.ts` (`light.dayLength`, `climate.surfaceTemp`, `eco.plankton`, `life.metabolic`, `life.mutation`, `life.popCap`, `disease.virulence`, `god.disasters`, `god.releaseBudget`, `snap.autosave`, `snap.retention`, `views.brightness`, `views.glow`, and so on, with the ranges there). `mod/host` already accepts `autosaveMin` and `backgroundSpeed`; the UI retries `snap.autosave` as `autosaveMin`. Add `settings: Record<string, number | string | boolean>` to STATS (current values), a `setting` event `{k:'setting', key, value}` to CONTRACT 11, and the key `world.new` (value a JSON string of the new-world-only knobs, plus `empty: true` for "Start empty instead"), which snapshots the present first and re-sends WELCOME with a new epoch.

### 10. Onboarding flags on the host (07 §5.2)

`onboarding.version`, `onboarding.tourDone`, `onboarding.viewsSetupDismissed` as world-independent `setting` keys, echoed in STATS.settings. The UI keeps a localStorage mirror (`pt.onboarding`) and does not send them yet.

### 11. Food web flows in STATS (07 §3.6)

`web?: { windowS: number; flows: [from: number, to: number, kgPerSimDay: number, kind: 0 | 1 | 2][] }`, at most once per 5 s. `from` is what was eaten, `to` the eater; `-1` plankton, `-2` plants, `-3` detritus; kind 0 eating, 1 parasitism, 2 scavenging. The host aggregates feeding events over the last 10 sim-minutes (sparse S×S). The UI solves the trophic levels itself (`src/ui/god/foodweb.ts`).

### 12. Gene drift history on reconnect

The UI builds the drift heat map from successive `STATS.genes` (32-bin histograms per trait per species). A new client starts empty. Proposed: `geneHistory?: Record<trait, Record<speciesId, [tick, number[]][]>>` on the first STATS after HELLO, one sample per sim-minute, at most 720 samples.

### 13. `AudioModule.setVolume(v: 0..1)`

The TV overlay's "Sound: 0 to 10" control can only start and stop audio today. Proposed addition to `AudioModule` in `src/core/contract.ts`; the UI calls it when present.
