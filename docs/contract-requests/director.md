# Contract requests: director

## 1. A richer DirectorModule (CONTRACT 10.2, `src/core/contract.ts`)

**What.** Extend `DirectorModule` so a view can drive dips, prefetch and the heat-map drift:

```ts
export interface DirectorFrame {
  camera: Camera;
  dim: number;                       // exposure multiplier for dips to dark, 0.15..1
  caption: { text: { line1: string; line2: string }; side: 'left' | 'right' } | null;
  captionAlpha: number;
  predicted: { cx: number; cy: number; zeta: number; leadS: number };  // for VIEWPORT
}
export interface DirectorModule {
  update(events: readonly SimEvent[], dtWall: number, current: Camera): Camera;   // unchanged
  caption(): string | null;                                                       // unchanged
  step?(events: readonly SimEvent[], dtWall: number): DirectorFrame;
  setCensus?(c: { species: { id: number; count: number; biomassKg: number }[]; heat?: Uint8Array; heatW?: number; heatH?: number; heatCh?: number }): void;
  setSimTick?(tick: number): void;
  resize?(viewWpx: number, viewHpx: number): void;
  setLocator?(fn: ((id: Id) => V2 | null) | null): void;      // live body positions from BODY_FRAME
  observe?(bodies: { id: Id; species: number; prominence: number }[]): void;  // exposure of what is on screen
}
```

**Why.** `update()` alone cannot return the dip exposure, the caption placement or the predicted viewport (VIEWPORT `leadS`), and the director needs the tank and view size, the census heat map and live positions. Implemented locally by `Director` in `src/director/director.ts`; all additions are optional so nothing breaks.

## 2. Renderer exposure for dips (CONTRACT 10.2 `RendererModule.render`)

**What.** `render(nowMs: number, camera: Camera, opts?: { exposure?: number }): void`.
**Why.** 06 §6.2.6 dips ease exposure to 15% and back instead of cutting. The director computes the value (`DirectorFrame.dim`); the renderer must apply it (and clear trails at the jump).

## 3. CENSUS heat channels (CONTRACT 12.2, frame 0x18)

**What.** Fix the four `u8` channels of `heat` (64 x 36 x 4): `0 biomass, 1 emissive, 2 activity (bites, births, deaths per cell), 3 reserved`, each normalised 0..255 per frame.
**Why.** Idle drift weights waypoints by `(emissive + 0.3 biomass)^0.7` (06 §6.2.7) and must know which byte is which. The director assumes this order now.

## 4. Sizes on hunt and mate events (CONTRACT 11)

**What.** Optional `predSize?: number, preySize?: number` on `hunt`, `sizeA?: number, sizeB?: number` on `mate` (metres).
**Why.** Giant promotion of hunts (`giantKill`) and "two L1-or-larger animals mating" need sizes; today the director learns sizes only from `birth`, `death`, `giant` and `carcass`, so a hunt by an animal born before the view connected is never promoted.
