# src/sim: design notes (phase 1)

Owner: sim engineer. Binding: CONTRACT 4, 9.6, 10, 11, 12, 13. Spike: [docs/spikes/sim-1.md](../spikes/sim-1.md). Contract requests: [docs/contract-requests/sim.md](../contract-requests/sim.md).

## Files

| File | What |
|---|---|
| `index.ts` | `createSim(modules)` and the default `sim`; the tick pipeline; the journal (`schedule`, `appliedJournal`); `drainEvents`, `drainChannels`, `stateDigest`, `census` |
| `state.ts` | per-world non-SoA state (WeakMap): modules, RNG streams, event buffer, journal, genome store, species registry, ledger channels, hash log |
| `commit.ts` | birth and death commit, slot and segment allocation, compaction, releases and founders, the clutch cost |
| `requests.ts` | birth and death request queues (local adapter, contract request S1) |
| `store.ts`, `species.ts` | genome store and species registry (adapters, S2 and S3) |
| `fallback/` | local stand-ins for genome, physics, brain and the ecosystem life cycle |
| `runner.ts` | headless runner with audits, hash and a summary (the Node runner; the host CLI wraps it) |
| `detectors.ts` | derived events: hunts, giants, schools, outbreaks, mass deaths, endangered |
| `frames.ts` | DUST palette, `ViewStream` (per-client body set, BODY_ENTER/LEAVE deltas, BODY_FRAME and DUST_FRAME keyframes), CENSUS, GENOME and EVENT frames |
| `session.ts` | `SimSession`: the protocol session shared by the worker and the host, commands |
| `pacer.ts` | wall-clock pacing and speed leases (the only clock reader) |
| `budget.ts` | the CPU budget table and the governor helper (R4, R16) |
| `worker.ts`, `client.ts` | the dream-tank worker entry and the view-side links |

## The tick (CONTRACT 10.1)

```
0  journal entries due now, in (tick, scheduling order): god events, governor decisions, releases
1  brain.sense
2  brain.think
2b actuate (sim): NaN outputs to 0, all outputs and segment commands clamped to [-1, 1]
3  physics.step (contacts, bites and grabs inside)
4  if tick % 3 == 0: ecosystem.stepEcology (eat and contact, digestion, metabolism, growth,
   restage, reproduction requests, ageing and starvation deaths, producers, transport),
   then the birth and death commit
5  if tick % 15 == 0: ecosystem.stepSlow (flow, light, temperature)
6  tick += 1; a hash checkpoint every HASH_EVERY ticks when `hashCheckpoints` is set
```

`n_agents` for the cap fee is taken at the very start of the tick, before the journal (9.6).

## The commit (CONTRACT 9.6)

1. Deaths in `(entityId, request tick)` order; a second request for the same entity is ignored. ALIVE becomes CARCASS with its pools intact; the brain is freed; the species count drops and the last member emits `extinction`.
2. Empty carcasses (all pools zero) are freed in ascending slot order: segments cleared, genome released, every column reset except `gen`.
3. Births: deferred ones first, then new, in `(parentEntityId, tick, requestIndex)` order. Per offspring: check the cap (`liveCount + eggCount + carcassCount >= agentCap`, or the governor's soft limit) and defer the rest of the clutch if full; genome operators keyed by the child's new entity id (`mutate`, or `crossover` then `mutate` for 'sex', then `repair`); intern; species assignment; `develop` at maturity 0; lowest free slot (`gen` + 1); segment range (first fit, compacting once if fragmented); `physics.loadBody`; `brain.allocate` (a refusal rolls back and defers); pay; emit `birth` (and `speciation`, and one `mate` per sexual clutch).

The clutch cost per offspring in quanta: `tissue = round(m_o / Q)`, `growthHeat = floor(0.4 tissue)`, `reserve = floor(0.3 tissue)`, `overhead = floor((0.15 m_o + 1e-3 M_REF_1CM) / Q)`, `fee = floor(agentCapFeeKg(n_agents, N_cap) / Q)`. Tissue and reserve go to the child; the rest is burnt to dissolved N at the bearer's coarse cell. Every movement is integer, so the audit stays exact (checked on every ecology tick in tests).

**Decisions.** Deaths before births, so a parent that dies in the window does not breed. A sexual request whose mate died becomes a bud unless the bearer is obligately sexual (`SEX_PROB >= 0.98`, 01 §1.7.1), in which case it is dropped. Affordability is checked before the cap, so a parent that cannot pay at the current fee waits rather than queueing.

## The journal

`schedule(world, entry)` keeps entries sorted by `(tick, scheduling order)`; past ticks are refused; governor decisions are refused off `GOVERNOR_EVERY` ticks. Applied entries are kept in order (`appliedJournal`) for persistence and replay. A god event calls `ecosystem.applyGodEvent` (the phase-0 module's `NotImplementedError` is swallowed after it records the modifier) and emits a `god` event. A release injects its mass (`M_total` rises, channel `godInjection`); a leviathan release also adds the `K_ENDOW` endowment to dissolved N and `M_target`, or is refused above `0.8 MAX_WORLD_MASS_KG`.

## Fallback modules (to be swapped)

The integrator builds the real pipeline with

```ts
import { genome } from '../genome/index.js';
import { physics } from '../physics/index.js';
import { brain } from '../brain/index.js';
import { ecosystem } from '../ecosystem/index.js';
export const sim = createSim({ genome, physics, brain, ecosystem });
```

Any module left out keeps its fallback, so modules can be swapped one at a time. The fallbacks:

- **genome**: one capsule part; length linear in maturity from `BIRTH_FRACTION x adult` to the expressed adult length (ceiling clamp); trait point mutation in x space at `10^MU_LOG` with step `N(0, SIGMA)` (stream MUTATION keyed by the child id); per-trait crossover; distance = half the mean absolute x difference over the Dist traits. Motefly: 3 mm adult, newborn 0.4, mature at 0.75 of adult length, clutch 2, pure budder.
- **physics**: one segment; implicit drag towards the water plus thrust `2 body lengths/s x CPG_AMP` along the heading, turning by `CPG_TURN`; reflecting walls; carcasses sink at 1 cm/s; `powerW` is the thrust's drag power.
- **brain**: no pools; a wander turn every 16 ticks (stream BRAIN_NOISE), steering to PREF_DEPTH, swim amplitude from ACTIVITY and hunger; `brainW` of a minimal C0 brain.
- **ecosystem life cycle** (wrapping the real phase-0 module): grazing of phytoplankton held in the anchor fine cell of each coarse cell, capped at `J_max = 8 B / (0.6 E_B)`; absorption `0.8 e_plant^1.3`, excretion to N, faeces to D, 10% SDA; basal Kleiber with Arrhenius at 14 C plus `tAnom`, repair `0.05 B (LIFESPAN_MULT - 1)`, active and brain power, burnt to N; starvation catabolism at 0.8; growth at `C_G` from the reserve above half the fat capacity (half the surplus once mature, the rest kept for breeding); repro reserve into `qRepro` and a request when it covers one offspring; Gompertz ageing (stream AGEING) and starvation deaths; carcass decay to D at 2% per second; producers N to P with depth and day light, P mortality to D, D remineralised to N, on slow ticks. `stepSlow` uses a separable flow rebuild that is bit-identical to the real one.

## Views and the session

- Stream slot = creature slot. A `ViewStream` per client streams bodies for creatures at least 6 px long in its viewport (at most 512), sending BODY_LEAVE before any BODY_ENTER that reuses a slot, then a keyframe BODY_FRAME and the client's DUST_FRAME with body slots marked empty. VIEWPORT updates the rect, scale and pause; `resync` forces every body to leave and re-enter.
- Cadence: BODY and DUST every 2nd tick, ENV and CENSUS at 1 Hz, STATS at 1 Hz to the god scope, EVENT as events happen. Births and deaths reach views only when notable (a killer, a disaster, a big body); derived events are rate-limited to 20 per second of 1x time per client.
- Commands need the god scope and the current epoch: `speed` goes to the pacer; `cast` is journalled with the 3 s (major) or 1 s (minor) lead converted to ticks at the current speed; `release` takes a `.ptkg` or a template id and is journalled with the same lead.

## Pacer and leases

Speeds 0, 0.25, 1, 4, 16 and max. Above 1x a lease is required: attended (lapses to 1x when the last god window detaches) or unattended with an `until` tick or wall time (the overnight "run at max until ..."). Max runs bursts within an 80% duty cap of 20 ms windows and stops exactly at a tick-bounded lease's end. Every change of the speed in force is reported with a reason (`onStatus`) and shown to every view in CENSUS `env.speed` and `env.fastForward`. Tests drive the pacer with a fake clock.

## Determinism notes

- Everything in the step iterates slots in ascending order; every sort has a total-order comparator; maps are used for lookups only, except the detectors' maps, which live outside the step and are iterated in sorted or insertion order of deterministic inputs.
- `sim.hash` is exactly `hashWorld` (CONTRACT 4.5). `stateDigest` adds the non-SoA state (store, species, queues, journal position), so a replay check should compare both.
- Snapshots: after the commit of ecology tick `t` the queues are empty and `g.tick = t + 1`, so a snapshot taken when `g.tick % 3 == 1` needs no queue section. At other ticks, pending requests (from ticks after the last commit) must be saved with the world.
- The golden hash of the 1-hour acceptance run belongs to the fallback modules; re-record it (one line in `tests/sim-acceptance.test.ts`) when real modules are swapped in.

## Left for later

- The commit scans for the lowest free slot and segment run linearly (fine at 4,096 agents; a free-list would help at 131,072).
- No eggs yet (`LIFE.EGG` is counted but never produced); hatching would be a second commit step.
- Restaging that changes the part count needs a segment reallocation in the commit; the fallback body always has one part.
- Detectors for frenzy, carcass, migration, bloom fronts, records and novelty.
- Protocol 1.1 predictive deltas.
