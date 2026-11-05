# Ecosystem module: design notes (phase 1)

Owner: ecosystem engineer. Code: `src/ecosystem/`. Contract: CONTRACT 3, 5.4, 9, 13. Design: 04, as reconciled by DESIGN R1, R2, R5, R7, R11, R13, R14, R15, R18, R26, R28. Contract requests: [docs/contract-requests/ecosystem.md](../contract-requests/ecosystem.md). Spike: [docs/spikes/ecosystem-3.md](../spikes/ecosystem-3.md).

## Files

| File | Contents |
|---|---|
| `params.ts` | every tunable, in SI, with 04's mu densities rescaled to the CONTRACT 3.2 budgets |
| `terrain.ts` | habitat presets (Basin, Lagoon, Twin basins, Open), caves, overhangs, vents, reef and sediment materials, flood-fill sealing, exact EDT signed distance field, edit helpers |
| `flow.ts` | OU mode amplitudes, terrain-following streamfunction, vent plumes, SDF ramp, analytic `flowAt`, corner psi, coarse and fine face fluxes, `flowU`/`flowV` |
| `transport.ts` | donor-cell integer transport (advection, diffusion, sinking, settling) and its float twin |
| `env.ts` | clocks, surface light, Beer-Lambert scan with self-shading, ice and rock, thermocline, O2 exchange, vents' heat and sulphur, turbidity |
| `producers.ts` | plankton (Steele light, Monod N, Q10, linear and quadratic loss), Lenia mats (photo and chemo), cysts, remineralisation, sediment, burial, reservoir, excess relaxation |
| `metabolism.ts` | trait cache, Kleiber basal with Arrhenius, repair, burning and catabolism, demand-resolve-collect feeding (Holling filters, rasping, sediment, photosynthesis), digestion by the bridge rule, growth and restage, reproduction requests with overhead and cap fee, health hazards, Gompertz ageing, carcass leaching, death commit, bites |
| `disease.ts` | strains, keys, infection, within-host load, drain, hazard, contact, spores, vertical transmission, mutation, memory, GC, reservoir strains |
| `god.ts` | envelopes, lead times, `planCast`, every power's effect, the modifier stack, ice and sea level, rift barriers, leviathan endowment, mutagen field, nature mode |
| `metrics.ts` | Hill numbers, evenness, roles, trophic levels, size spectrum, speciation and extinction rates, prevalence, immigrant share, pools |
| `ledger.ts` | contract formulas, dither, transfer, inject, remove, the exact audit |
| `valves.ts` | safety-valve detection (reseed, immigration requests) |
| `state.ts` | the per-world side table (see contract request E4) |

## Decisions (made overnight, nobody to ask)

1. **Cadence.** Creatures, feeding, disease and the death commit run every ecology tick (10 Hz). The field work runs at 2 Hz with dt 0.5 s, staggered so no tick carries all of it: phase A (`tick % 15 == 0`) chemistry, cycling, scents and coarse transport; phase B (`== 6`) producer reactions; phase C (`== 9`) fine plankton transport. stepSlow (2 Hz) rebuilds modifiers, clocks, flow and light. 04 had coarse tracers at 10 Hz; at 0.5 s with CFL substeps they are just as conservative and 5 times cheaper on the CPU backend.
2. **Terrain-following flow modes.** psi_m = (a_m / k) (h(x) / H) sin(k_x x) sin(j pi y / h(x)), with h(x) the smoothed local floor depth. Multiplying tank-scale modes by the SDF ramp alone (04's recipe) produced 0.7 m/s jets along the floor, because psi is largest at mid-depth where the Basin floor cuts it. Terrain-following modes vanish at the floor, so the ramp only handles caves and overhangs. psi is also forced to zero on every corner a solid coarse (or fine) cell touches, so no face carries flux into rock: without that, pits drained their tracers into the open water (found when a one-cell pit went anoxic in 200 s).
3. **Mode amplitudes halved** (request E6): interior speeds now peak around 0.14 m/s.
4. **Fine-grid vertical mixing.** On the fine grid the turbulent Kz acts only across coarse-row faces, with the coarse-spacing gradient (K/4 on the fine spacing): the coarse discretisation of the same diffusion. It keeps the plankton pass at 2 to 4 substeps instead of 6 to 16.
5. **Dither.** One Philox block of the ECOLOGY stream seeds each run of 1,024 items; item i uses `fmix32(seed + i * golden)`; one hash per donor cell, the five outflows take golden-ratio rotations of it. Subjects sit above 2^52 so they never collide with entity ids.
6. **Densities.** All presets share one mean density, 0.174 kg/m^2, 5.6 times 04's 1,000 mu/m^2. Every 04 density (K_N, bloom shading, mat ceiling, quadratic closure) is scaled by that factor (`DENS`), so their ratios are as 04 tuned them.
7. **2D intake.** Filter intake uses 04's 2D form `filter x gape x |v_rel| x C` with C in kg/m^2, then Holling type II with `J_max = 8 B / (f E_B)` (CONTRACT 9.5). A floor of 0.2 body lengths per second of pumped water stands in for the mouth's own flow.
8. **Growth law.** Maximum tissue growth `2 x GROWTH_RATE x B / (E_B C_G)`; time to maturity follows from it (`tMature` is set when the sim leaves it 0), and `lifespan = LIFESPAN_MULT x tMature`. At 15 C and default traits: 231 s for a 1 mm microbe, 22 minutes for 1 cm, 10 sim days for 20 cm.
9. **Reproduction.** Mature creatures move reserve above `REPRO_RESERVE x capacity` into qRepro at up to 4 B, and ask for a clutch when they can pay at least one offspring and either the full clutch or are at full reserve. Child tissue is `adult x BIRTH_FRACTION^3`; the build surplus (0.4), the per-offspring overhead and the cap fee are burnt to N at commit. A brained creature with `LAY_BUD < -0.5` withholds.
10. **Deaths.** Starvation when tissue falls below half its peak; hypoxia, heat and cold, toxin and wounds lower health; a drop in health that the ecosystem did not cause is counted as predation. The ecosystem converts deaths to carcasses itself at the end of `stepEcology`; carcasses leach half to D and half to N with `t_half = 1.5 days / Q10(T)` and are offered to the sim for freeing when empty.
11. **Excess relaxation.** "Active mass" is everything but the reservoir. Its target is `M_target` minus the nominal reservoir (2% of `M_target` at creation). Excess goes from dissolved N to the reservoir, a deficit returns through the vents (or the deepest floor in a vent-less lagoon), both with a 40-day half-life. Burial and vents therefore balance by themselves.
12. **Oxygen units.** One saturation unit is 0.05 kg/m^2 of matter burnt or remineralised; chemosynthesis does not produce oxygen (it is booked as producer growth but `produceO2` is only for photosynthesis; see the open item below).
13. **Leviathans.** `leviathanEndowment` injects `K_ENDOW x n x m_adult` into N around the release point, raises `mTargetQ` by the same amount, and refuses above 0.8 x `MAX_WORLD_MASS_KG` with a reason.
14. **God powers.** Every PowerId has an effect: instant terrain and population effects at the fire tick (meteor crater with crater glass, vent mound with a new decaying vent, cull by exact count with a partial Fisher-Yates from stream GOD, plague strain bound to a member's surface signature, bless from the reservoir, flood injection, earthquake cave collapse or opening plus a sediment slide, rift barrier cells restored when it lapses, whale fall and predator flood as spawn requests), plus envelopes on the modifier stack (temperature adds, light, mutation and growth rates multiply). Lead: 3 s wall for major powers, 1 s for minor, times the achieved speed (`leadTicks`).
15. **Nature mode.** `natureEvent` runs only on governor ticks, Poisson at 0.1 per sim day, picks one of `NATURE_POWERS` at magnitude 0.1 to 0.4 and never a major power. It is a pure function of seed and tick, so journalling it keeps replays exact.
16. **The `open` habitat** exists for tests and uniform-world experiments, and for phase-0 skeleton worlds (request E2).

## Performance (Node 22, this container, Small preset, no creatures)

| Piece | Cost |
|---|---|
| Field phase A, B or C | 13 to 20 ms each, once per 15 ticks |
| stepSlow | 12 to 17 ms per call (2 Hz) |
| Average per sim tick | 3.5 ms (Open) to 5 ms (Basin) |
| Per creature per ecology tick | about 1 to 2 microseconds |

The fine plankton field (147k cells) and the light scan dominate. Next steps if the CPU backend needs it: skip empty fine rows, transport plankton every other phase C with doubled dt, and keep a coarse producer sum updated incrementally instead of rescanning in `scanLight`.

## Open items

- Snapshot and hash coverage of the side table (request E4).
- Pheromones (channels 4 to 7) are emitted continuously from the ODOUR genes; a brain-gated emission output does not exist yet.
- Reef growth by shell-building sessile creatures (04 §4.1) and root uptake from sediment are not implemented.
- Safety valves are detected here (`valves.ts`: extinction after a 0.5-day grace, diversity collapse for 10 days, background immigration at 0.05 per day) and posted as `SpawnRequest` kind `'reseed'` plus a `reseed` event; the gene bank that fills them is host-side and not started.
- The time-shift infectivity test and the food-web matrix `W` are not built yet; trophic levels are per-creature EMAs.
