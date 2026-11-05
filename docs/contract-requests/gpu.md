# Contract requests from the gpu module

Filed by the gpu engineer, phase 1 (2026-11-05). The module lives in `src/gpu/` (WebGPU compute backend and the backend selector). Design notes: [docs/modules/gpu.md](../modules/gpu.md); measurements: [docs/spikes/gpu-1.md](../spikes/gpu-1.md).

## G1. An asynchronous tick for GPU backends

**What.** A GPU readback cannot be synchronous in WebGPU (`mapAsync`), so `PhysicsModule.step` and `BrainModule.think` cannot be implemented on the GPU as they are typed. Add to `src/core/contract.ts`:

```ts
/** Same as PhysicsModule, with an awaitable step (GPU backends). */
export interface AsyncPhysicsModule {
  readonly kind: 'gpu' | 'cpu';
  loadBody(world: World, slot: number, ph: Phenotype): void;
  restage(world: World, slot: number, ph: Phenotype): void;
  step(world: World, ctx: StepContext): Promise<void>;
}
/** What the host drives per tick; `src/gpu` `selectBackend()` returns one. */
export interface SimBackend {
  readonly kind: 'gpu' | 'cpu';
  readonly reason: string;
  readonly physics: AsyncPhysicsModule;
  think(world: World, ctx: StepContext): Promise<void>;
}
```

and a `SimCore.stepAsync?(world: World): Promise<void>` that the Node host awaits when it runs a GPU backend. The CPU backend keeps its synchronous path (the dream-tank worker never changes). `src/gpu/index.ts` implements both shapes today against a local copy of these types.

**Why.** It is the only way to put the GPU kernels behind the existing pipeline without inventing a second tick order. The host is Node and already async (host-2 measured the binding's `mapAsync` overhead at about 10 µs).

## G2. `WorldConfig.backend`

**What.** `backend: 'cpu'` becomes `backend: 'cpu' | 'gpu' | 'auto'` (default `'cpu'` for v0.x, as host-2 decided). `'auto'` takes the GPU when `selectBackend()` finds an adapter and falls back to the CPU with a logged reason; `'gpu'` does the same but logs the fallback as a warning. Snapshots and journals are backend-independent (the World columns are the same), but a replay on a different backend is not bit-identical for the float physics and brains (see G5).

## G3. Ownership row and lints for `src/gpu`

**What.** CONTRACT 16:

| Directory | Owns (interfaces and files) | May import |
|---|---|---|
| `src/gpu` | WebGPU compute backend: device acquisition, WGSL kernels (physics, spatial hash, brains, field transport, Philox), backend selector, benchmarks | core, genome, physics, brain, ecosystem |

and `sim` may import `gpu` (when G1 lands, the sim or the host owns the choice). **Applied on `mod/gpu`** to `tests/boundaries.test.ts` (one line, `gpu: ['core', 'genome', 'physics', 'brain', 'ecosystem']`), because without a row the test throws on any import from `src/gpu`; the integrator may move or reword it. The determinism lint should add `src/gpu` with `bench.ts`, `bench-cli.ts` and `device.ts` exempt (only they touch clocks or the environment; today `src/gpu` is not scanned).

## G4. Physics internals the GPU backend uses

**What.** Keep these exported from `src/physics` (they are, today, but not from `index.ts`): `beginCreature`, `substepCreature`, `substepCreatureEnd`, `endCreature`, `DEFAULT_OPTIONS` (solver.ts); `loadBody`, `restage` (body.ts); `islands`, `linkState`, `pruneLinks`, `resetLinkForces`, `solveLinks` (links.ts); `stepContacts` (contacts.ts); `watch` (watchdog.ts); `workFor` (work.ts); the constants in constants.ts. Better: export `stepIsland` from `index.ts` so the GPU backend does not keep a copy of it (`src/gpu/physics.ts` has one).

**Why.** The GPU backend runs the unlinked creatures on the GPU and everything else (drifters, islands, watchdogs, contacts) with the CPU module's own code, so the CPU parts stay bit-identical.

## G5. Cross-backend agreement is banded, not bitwise

**What.** Add to CONTRACT 4.2: "A GPU backend reproduces the CPU backend bit for bit on integer state (spatial hash, Philox draws, quanta transport) and within the documented bands on f32 state (physics, brain neurons); see docs/modules/gpu.md §3. Golden-replay tests run on the CPU backend." This is what 02 §2.7.7 already says in prose.

## G6. A transport hook for the ecosystem

**What.** `src/ecosystem` calls `transportQ` and `transportF` directly inside `stepSlow`. To use the GPU kernels the ecosystem needs a pluggable transport, for example an optional `world`-scoped `{ transportQ, transportF }` provider with the same arguments, and (with G1) an async `stepSlow`. Until then the GPU transport is exercised by its tests and benchmark only.
