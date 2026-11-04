# Phylotank design review (Reviewer 2)

Reviewer stance: a sceptical senior engineer who has shipped GPU simulations and artificial-life systems. I read BRIEF.md and all seven sections in full. This review tries to find where the design fails in practice, not where it reads well. It reads very well. That is part of the problem: seven strong sections were written in parallel, each internally careful, and they do not yet describe one system.

Severity legend:
- **Blocker:** the design cannot be built as written, or a binding brief requirement fails, until this is resolved.
- **Major:** it will cost weeks, produce a visibly wrong result, or quietly corrupt evolution, unless fixed early.
- **Minor:** fix when you reach that code.

Arithmetic in this review is mine and approximate, and it is marked as an estimate wherever it depends on hardware behaviour I have not measured. Nothing here was benchmarked.

---

## 0. Findings at a glance

| Id | Severity | Finding |
|---|---|---|
| R1 | Blocker | The sections do not share one contract: brain encoding, actuation, tank size, size range, population, tick rate, energy currency and file formats all disagree |
| R2 | Blocker | The leviathan path does not close: the default tank's nutrient mass cannot hold giants, and generation times put them months away |
| R3 | Blocker (for the plan) | As specified this is a multi-year research programme with no early, delightful milestone |
| R4 | Major | The GPU budgets do not fit the duty caps; at 1x the sim runs at about half speed as a wallpaper |
| R5 | Major | Contact append on one atomic counter, hierarchical queries and ranged perception are underestimated, and microbe "fog" blinds large creatures |
| R6 | Major | XPBD at 1 to 2 substeps with one iteration, and tick-rate cross-creature constraints, will leak or inject energy that evolution will find |
| R7 | Major | Microbes always run on reduced-tier "swimmer cards", so their locomotion evolution is decided by a lookup table, and card sharing hides cost changes |
| R8 | Major | u32 fixed point and f32 stocks cannot span 10 to 11 decades of mass: microbes cannot eat, giants overflow and their energy books drift |
| R9 | Major | Both exploit watchdogs misfire in water currents and will cull or clamp drifting microbes |
| R10 | Major | Degenerate attractors: free immortality, sessile filter blobs parked in current jets, and clutch-64 swarms |
| R11 | Major | The agent-cap tax is size-neutral, so microbes fill the cap and squeeze out slow-breeding large species |
| R12 | Major | At 1x, macro-scale evolution takes weeks; fast-forward is capped by per-tick readbacks and CPU-side births |
| R13 | Major | The auto-tuning campaign is about 20x more expensive than estimated and must re-run whenever costs change |
| R14 | Major | A fixed genetic-distance threshold will shatter large asexual microbe populations into hundreds of "species" |
| R15 | Major | The HyperNEAT brain has a heavy mutational load, a rugged top-K wiring step and a CPU development cost that blocks fast-forward |
| R16 | Major | Determinism is broken by every adaptive governor and by unsorted neighbour order |
| R17 | Major | Dawn on Node is unproven exactly where the design leans on it |
| R18 | Major | Wallpaper calm is not guaranteed: 5 Hz dust, brain-driven flicker, a sunrise every 20 minutes, and evolution may dim the tank |
| R19 | Major | "Gentle" ignores power and noise: about 20 to 35% of a 5090 around the clock |
| R20 | Major | The public install story (unsigned tray app, .scr, local server, Lively prerequisite) will trip SmartScreen and antivirus |
| R21 | Major | Chrome tab casting degrades exactly the dark gradients and pinpoint glows that are the look |
| R22 | Minor | The innovation registry makes a second duplication of the same module a silent no-op; the overflow estimate uses the wrong rate |
| R23 | Minor | Several kernels exceed WebGPU's default 8 storage buffers per stage |
| R24 | Minor | Lively unknowns: `Type: 1`, WebGPU in a cross-origin iframe, pause mechanism, one client per monitor |
| R25 | Minor | `.scr` details: settings-list visibility outside System32, wake locks, first-frame timing |
| R26 | Minor | A bit-exact `Math.fround` CPU backend cannot also be the fast laptop fallback |

---

## 1. Consistency

### R1. The sections do not share one contract (Blocker)

**Evidence.** The sections say so themselves: "Other sections were being written in parallel, so this one depends on them only through the small interfaces in section 0" (07-ux.md, 0). The contradictions are not cosmetic. They are in the interfaces that every kernel and every file format depends on:

| Topic | What the sections say |
|---|---|
| Brain encoding | Genome: "NEAT-style node and connection genes with innovation ids ... Input and output nodes are canonical slots" with "Innovation ids 1 to 63 are reserved for input slots and 64 to 95 for output slots" (01-genome.md, 1.2 and 1.3.6). Brains: "a NEAT-evolved CPPN wires a body-anchored substrate, plus up to 32 direct 'override' connection genes" (03-brains.md, 3.1). Architecture budgets "about 1,500 synapses, f16 weights" (05, 5.1.1). These are three different genomes. |
| Actuation | Genome: "16 actuator channels (amplitude and bias, 8 pairs)" driving per-part oscillators. Physics: "One brain motor output `u_j` in [-1, 1] per joint" (02, 2.2.5). Brains: one muscle motor neuron per joint plus oscillator neurons and `cpgFrequency`, `cpgAmplitude`, `cpgTurn` (03, 3.3.2). UX brain view: outputs are "thrust, turn, mouth, attack, mate, bud, glow" (07, 3.5). |
| Innovation ids | Genome: a world-global u32 registry with a 100,000-birth reuse window (01, 1.3.7). Brains: "Innovation ids without a global registry" via `hash64` (03, 3.6.1). |
| Tank size | Genome: "a 1 m leviathan needs a tank of tens of metres" (01, 1.5.1). Physics and rendering: "Examples assume a 256 m by 128 m tank" (02 conventions; 06 conventions). Ecosystem: Default is "64 x 36" m (04, 4.1). |
| Size range | Genome: "adult length (0.5 mm to 1 m)". Physics: "1 mm to 4 m nominal ... tested from 0.2 mm to 20 m" (02, 2.1). Rendering's giant threshold has `G_abs = 2 m` (06, 6.2.2). UX's TV mock-up: "Bathycorona patiens, 14 m, the largest alive" (07, 4.3). |
| Part cap | Genome `MAX_PARTS = 64` (32 on laptops). Physics "A tree of up to 256 rigid segments". Rendering L0 "up to 64 capsules". Architecture body descriptor "up to 32 segments x 5 B". |
| Body model | Physics: rigid segment trees in XPBD. Architecture: "Soft-body physics (about 16 nodes, 2 substeps)" and a `BODY` section of "soft-body node columns" (05, 5.1.1 and 5.4.2). |
| Population | Genome 200k; physics 60k full plus 1.5M reduced; brains 300k brained; ecosystem `N_max` 131,072; architecture 250k Default, 1M Big, 4M Unleashed; UX soft cap "1k to 1M, auto from a first-run benchmark". |
| Tick rate | Physics 60 Hz; brains "Creature `i` ticks when `(i + tick) mod 3 == 0`", which assumes 60 Hz; architecture "One tick is `dt = 1/30` s" (05, 5.5.1). At 30 Hz the brain stagger gives 10 Hz brains. |
| Water | Genome computes Re with real water ("about 0.25 (a 0.5 mm microbe at 0.5 mm/s)"). Physics makes the tank "20x real sea water" (`nu = 2e-5`), which moves that microbe to Re about 0.0125. |
| Currency | Physics: joules, "`e_b = 4000 J/kg`", plus integer nutrient quanta. Ecosystem: mass in "mu" ("the biomass of a reference creature 1 cm long") and "Metabolised mass is excreted as dissolved `N`". Genome: its own basal formula with tissue factors and a world constant `KLEIBER_EXP`. |
| Digestion | Three models: genome `e_plant = e_p,max x (1 - DIET) x (1 - exp(-gutLen/(0.6 L)))`; physics `eps_max(g_gut)` table; ecosystem `a_k = a_max_k · e_k^θ` with three enzymes summing to 1. |
| Temperature | Physics Arrhenius with `E_a = 0.65 eV` at 288 K; ecosystem and UX `Q10 = 2` at 20 °C. |
| Growth | Genome codes von Bertalanffy `L(t)` with a `GROWTH_RATE` gene; physics says growth "follows a von Bertalanffy-like curve without that curve being coded". |
| Organs | Physics needs cilia patches, jet bells, gas bladders, lipid fraction and claws; brains need toxin glands, ink sacs and gonads; ecosystem needs a calcifying shell gene, photosynthetic area `A_photo`, `immuneKey`, `surfaceSig`, `immuneInvest` and a hypoxia gene. None of these exist in the genome's module kinds or trait block. |
| Mouths | Genome: FILTER, JAWS, RASP, PROBOSCIS. UX: rasp, jaw, comb, proboscis, scoop. Ecosystem: continuous `filter`, `scrape`, `bite`, `suction`, `latch`. |
| Senses | Brains already gives eyes 3 spectral bands; rendering asks "Should creatures be able to see colour and light patterns" (06, open question 1). |
| Director | Architecture: "The screensaver and TV camera director runs host-side". Rendering: "The director runs in each view". |
| Stream format | Architecture: 10-byte body records with u16 positions and a streamed body descriptor. Rendering: 20-byte `FarRecord` with "x: f32; y: f32" and views regrow templates from fetched genomes. |
| God lead time | Ecosystem "1 s wall"; rendering "default 3 s". |
| File formats | Genome exports a `.ptg`; architecture uses `.ptk` for worlds and `.ptkg` for creatures; UX uses `.ptk` for single designs ("Each one ships as a `.ptk` file in the library"). `.ptk` means two different things. |
| Speeds and clocks | UX: "1x, 4x, 16x and max"; architecture Watching: "0.25x to 4x". Year: ecosystem 20 days, UX 12. Surface temperature: ecosystem 14 °C, UX 18 °C. |
| Defaults | Ecosystem nature mode "default on"; UX natural disasters "off (William is the god)". Architecture autosave every 10 minutes keeping 6; UX every 30 sim-minutes keeping 24. |
| Host absent | Architecture loader shows `idle.js` "and nothing else"; UX wallpaper runs "a 2,000-creature local sim". |
| Flash caps | Genome `PULSE_FREQ` up to 4 Hz; UX "capped at 2 Hz in the genome range"; rendering minimum period 1 s on the wallpaper. |
| Templates | Genome: Bellwisp, Glassribbon, Thornback, Lanternmaw, Siltleech, Veilwhale, Motefly. UX: Meadowlamp, Hushmaw, Sievebell, Tetherling, Ashpicker, Deepcrown. Brains: Glimmerkin. |
| Mutation and brain cost | Genome default about 1.25 point mutations per birth; brains "CPPN weight perturb 0.8 per conn". Brains: brain is "15 to 20 percent of its basal metabolic rate"; UX: "about 1% of BMR per 16 neurons". |

**Why it fails.** Every one of these is a buffer layout, a kernel signature or a save-file field. Building any section first locks choices that break the others, and the evolutionary balance depends on the joint effect of growth, digestion, metabolism and temperature, which currently exist in two or three incompatible versions.

**Fix.** Before any code, write one short `CONTRACTS.md` (or an ADR set) that names a single owner and a single value for: units and currency (pick joules plus integer nutrient quanta, and make the ecosystem's "mu" a derived display unit); tick and brain rates; tank presets; size range; part cap; the brain encoding and actuation interface; the organ list with gene loci; the digestion, temperature and growth models; the stream records; file extensions; and default knobs. Then edit each section to match. The cheapest resolution of the brain conflict is the genome section's direct NEAT with fixed I/O slots and part-level CPGs for v0.1, with the body-anchored CPPN as an experiment (see R15 and spike 8).

**Test early.** A CI "contract test": a single TypeScript schema module imported by every package, with a test that the genome schema contains every locus that physics, brains, ecosystem and UX reference by name. It fails today by construction.

---

## 2. Performance

### R4. The GPU budgets do not fit the duty caps (Major)

**Evidence.** Physics: "Physics budget: 4 ms per 60 Hz tick (24% of the GPU; brains take about 1 ms per tick, rendering about 2 ms per frame" (02, 2.12.1). Architecture: Default "250,000 ... about 2 ms, so about 6% duty" at 30 ticks/s, and "Ambient | only the wallpaper is visible | 1x if it fits, otherwise it slows smoothly | 15%" (05, 5.1.4 and 5.2.4).

**Arithmetic (estimate).**

| Item | Per wall second at 1x |
|---|---|
| Physics, 3.7 ms per tick x 60 | 222 ms (22%) |
| Brains plus perception, 1.0 ms x 60 | 60 ms (6%) |
| Ecosystem | 6 ms (0.6%) |
| Wallpaper render, 1.5 ms x 30 fps | 45 ms (4.5%) |
| **Total** | **about 33%** |

The host's Ambient cap is 15% and Background is 10%, so at the physics section's reference workload the wallpaper world runs at roughly 0.5x and the "keeps evolving while you work" world at roughly 0.35x. The architecture's "2 ms per 30 Hz tick" for 250k creatures is about 4 to 5x below the physics section's own figure for a comparable population. Either the population at 1x is a third of what the sections advertise, or the wallpaper world runs slow most of the time (which also slows evolution; see R12).

**Fix.** Make one budget table, owned by architecture, in GPU milliseconds per wall second, per throttle state, and derive the population from it rather than the other way round. Plan the Default preset at about 50k to 80k creatures, not 250k, until spike 1 measures the real cost. Count stream-cull passes and readbacks in it.

**Test early.** Spike 1 plus spike 2: time the real kernels through Dawn with timestamp queries and compute duty at 1x.

### R5. Atomics, hierarchical queries and perception are underestimated (Major)

**Evidence.** Contacts: "about 9M contact evaluations | 0.4 ms" and the append is `let slot = atomicAdd(&nContacts, 1u);` (02, 2.12.1 and 2.10.2). Queries: "an item at level `l_i` searches the 3x3 cells around itself at its own level and every coarser level" over 8 levels (02, 2.8.1). Perception: "Iterate neighbours from the spatial hash within `rEye` (cap 48 nearest by cell ring order)" with "range `rEye` in [2, 40] body lengths", budgeted at "4.8 M neighbour evaluations per sim tick ... Budget 0.5 ms" (03, 3.4.1 and 3.9.6).

**Why it fails.**
1. **Single-address atomic.** Appending about 9M contacts per tick through one global counter serialises at the L2 atomic unit. At roughly one or two same-address atomics per clock, that is several milliseconds by itself (estimate), not part of a 0.4 ms solve.
2. **Probe count.** A microbe at level 0 in a busy tank probes up to 8 levels x 9 cells = 72 hashed cells, each a scattered read of `cellStart` and `cellCount`, then a scattered read of every candidate's `itemCell` to reject hash collisions. With 2.25M items that is on the order of 100M scattered 32-byte sector reads per tick, about 3 GB, so 2 to 5 ms rather than 1.0 ms (estimate).
3. **Perception is not a 3x3 query.** A 20 cm fish with `rEye` of 40 body lengths looks 8 m away. At the 1 m level that is about 256 cells, and at the 0.26 m level about 3,700 cells. "48 nearest by cell ring order" across 8 hashed levels is neither well defined nor cheap. The budget counts evaluations, not cell visits.
4. **Microbe fog.** With 1.5M microbes as hashed agents and "keep only the nearest object" per receptor bin, a predator's 48 nearest objects in a microbe cloud are all microbes. Large creatures become blind to each other exactly where life is densest, which is an artefact that selection will respond to (for example, by abandoning eyes in rich water).

**Fix.** Append contacts per workgroup (local counter in workgroup memory, one global atomic per workgroup), or use the `subgroups` feature where present. For perception, query only levels whose items subtend more than a minimum angle at the viewer, and treat everything smaller as the density field (the brains section already does this for plankton). Cap the ring search by cells visited, not only by objects found. Budget perception in cell visits.

**Test early.** A microbenchmark in spike 1: 2.25M items with a realistic size spectrum, measuring hash build, contact search and append with one global counter versus per-workgroup append, and a perception query at 2, 10 and 40 body lengths.

### R6. XPBD at 1 to 2 substeps, and tick-rate cross-creature constraints (Major)

**Evidence.** "XPBD with small steps (one constraint iteration per substep)", "`n_sub = clamp(next_pow2(ceil(n_need)), 1, 16)`" and "At 60 Hz most creatures land in bucket 1 or 2" (02, 2.0 and 2.7.4); the reference workload averages "1.6 substeps". Cross-creature: "Velocity update for touched segments: `v += dx / dt`" and "Tick-rate contacts are good enough in water because bodies are slow relative to their size" (02, 2.7.5). Jaw locks and latches use the same once-per-tick link mechanism (02, 2.4.4 and 2.4.5).

**Why it fails.** The "small steps" result is about many substeps with one iteration each. One substep with one iteration is plain one-iteration PBD at h = 16.7 ms. On a 12-segment chain driven by large muscle torques and per-segment implicit drag, joints will stretch and the solver will add numerical damping, which eats thrust (C2 allows only 2%). Worse, stretch-and-compress cycles of the constraint error are a non-reciprocal shape change, which produces thrust in the fluid model: a numerical swimming mode. At tick rate, a link between two bodies that each substep independently is a tug of war in which the position correction is turned into velocity by `v += dx / dt`; that is the classic way PBD injects kinetic energy. Karl Sims's creatures found exactly this kind of bug, and the genome section says so (01, 1.11.3).

**Fix.** Set a minimum of 4 substeps for any creature with an active muscle (and measure the cost; R4 already says the budget is tight). Solve cross-creature links inside the substep loop for linked pairs: pack linked creatures into the same batch, which the batching scheme already allows. Cap the velocity added by contact correction at the depenetration speed, and charge any residual kinetic energy against the ledger.

**Test early.** In spike 1, evolve a CPG gait at `n_sub = 1` for 200 generations with a simple evolution strategy, then re-evaluate the champions at `n_sub = 16`. An "exploit transfer ratio" (speed at 16 over speed at 1) below 0.8 means evolution is using numerical error. Repeat with a predator jaw-locked to struggling prey and log kinetic energy against muscle work.

### R7. Microbes run on swimmer cards, so a lookup table decides their evolution (Major)

**Evidence.** "Re below 0.5 and at most 4 segments (microbes): R" (02, 2.11.3). Cards hold "4 amplitude x 4 frequency x 3 turn cells", "A card is keyed by a quantised morphology hash, so siblings and most offspring share their parent's card", and lab runs use "48 prescribed gaits" (02, 2.9.3 and 2.11.2).

**Why it fails.** The physics section's best idea for microbes is the scallop theorem: only non-reciprocal strokes swim at low Re. A gait descriptor of amplitude, frequency and turn per joint group discards the inter-joint phase, which is the one thing that separates a travelling wave from a reciprocal flap. Microbes are the majority of agents and of generations, are never full tier except in a 2%-per-minute audit, and so their brains' phase coordination barely matters to selection. Second, a quantised morphology hash shared by "most offspring" means a mutation that shrinks a fin or drops a part keeps the parent's card: lower mass and drag, the same speed and power from the table, until an audit happens. Cost-cutting mutations get a free lunch.

**Fix.** Put relative phase into the gait descriptor (at least one phase-lag dimension per adjacent joint pair), and key cards by a hash that includes every quantity that changes drag, mass or muscle cross-section at 5% resolution. Or, simpler for v0.1, drop the reduced tier entirely and run every creature full tier at a smaller population.

**Test early.** Physics test L1 with evolved microbe gaits, not lab sine waves, and a deliberate "drop a part, keep the card" A/B.

---

## 3. Evolutionary dynamics

### R2. The leviathan path does not close (Blocker)

The brief is binding: "Creatures must be able to evolve up to really big sizes." The design does not yet show that they can.

**Evidence.** Ecosystem: "`M_target` (and `M_total` at start) | 2.0e6 mu" and its own worked budget, "plenty of 1 mu creatures (capped by `N_max`), a few hundred at 100 mu, and a handful at 1e4 mu" (04, 4.10). "1 mu is the biomass of a reference creature 1 cm long" (04, 4.0). Genome: "If microbes breed every 30 s, giants breed about every 2.5 h of sim time" (01, 1.5.2). Physics: starvation for a "4 m leviathan (2,000 kg) about 7 hours" (02, 2.6.8).

**Arithmetic (estimate).**
- Mass scales as L^3, so 1e4 mu is a creature about 22 cm long. By the ecosystem section's own budget, the largest viable class in the Default tank is about 20 cm.
- A 1 m creature (the genome's maximum) is 1e6 mu, half of the entire tank's nutrient mass. Five to ten of them are 2.5 to 5 times the whole world. A 4 m creature (physics) is about 6.4e7 mu, 32 times the world.
- Even at the top of the tuning range (`M_target` 2e7 mu), ten 1 m giants would lock up half of all nutrient, starving the producers they feed on. Holding a viable giant population at under about 10% of total mass needs `M_target` around 1e8 mu, 50 times the default, and then the agent cap rather than food limits the small end.
- Generation time: food-limited growth with intake a few times basal and `e_b` = 4,000 J/kg gives a time to build one's own mass of roughly 1.7 h x (m / 1 kg)^0.25 (estimate). That is about 1 to 2 minutes for a microbe, an hour or two for a 20 cm fish, and around 4 hours of wall time at 1x for a 1 m giant, before maturity and breeding. Going from 5 cm to 1 m is about 40 net steps of 7.9% each; with realistic noise in selection, 200 to 400 generations whose duration grows as the lineage grows. That is many weeks to months of 24/7 running at 1x, minus every hour spent in Yield.

**Why it fails.** The tank cannot feed the giants the brief wants, and even if it could, nobody will see them evolve within the first months. The UX's answer is the "Deepcrown" leviathan seed, which is a designed giant, not an evolved one.

**Fix.** Pick one of these and write it down with numbers:
1. **Redefine "leviathan" relative to the tank.** Set the size range to about 0.5 mm to 30 cm (2.8 orders), and let the zoom and the director make a 30 cm animal feel huge next to millimetre plankton. This fits the Default mass budget and keeps generation ratios near 100x.
2. **Scale the world to the giants.** Raise `M_target` to about 1e8 mu, make giants filter feeders on a plankton field (as the ecosystem section already recommends), and add super-individuals for microbes so the agent cap does not fill.
3. **Decouple generation time from size for the largest class** (for example flatten Kleiber to 0.85 for growth only, the genome section's open question 2), accepting a less physical world.

In every case, ship a "Founding Waters" world pre-evolved offline for many sim-years (headless) so William starts with evolved diversity, not with templates.

**Test early.** Spike 3: a 2D evolvability toy with the real metabolic constants and mass budget, measuring the steady-state size spectrum and the maximum sustained body mass for `M_target` in {2e6, 2e7, 1e8}.

### R10. Degenerate attractors: immortality, current-jet blobs, clutch swarms (Major)

**Evidence.**
- "SENESCENCE (how sharply mortality rises past lifespan) | 0 to 1" and "lifespan = LIFESPAN_MULT * t_maturity" (01, 1.3.3 and 1.4.4). No section implements an age hazard or charges for a long lifespan; physics deaths are starvation and severing only (02, 2.6.8). UX promises "longer life costs more upkeep per day for repair" (07, 1.2), which no sim section implements.
- Filter intake is "`filter · gape · |v_rel| · dt · (P + D)`" with no handling time or saturation (04, 4.5), while currents reach "up to 0.25 m/s in surface currents and plumes" and "flow speeds up through cave mouths" (04, 4.2).
- `CLUTCH_SIZE` up to 64 with `BIRTH_FRACTION` down to 0.04 (01, 1.3.3).

**Why it fails.** With `SENESCENCE` at 0 costing nothing, selection drives it to 0 and `LIFESPAN_MULT` to 20: immortal individuals. Combined with free intake from passing water, the cheapest strategy in the tank is a mouthless-body, open-mouthed, finless sessile blob parked in the fastest jet, living for ever and budding into the same jet. Whether that is "interesting" is a matter of taste, but it will fill the agent cap. Clutch-64 budders turn every plankton bloom into a cap-filling swarm.

**Fix.** Give ageing an owner (physics) and a mechanism: damage accumulates at a rate falling with repair investment, and repair costs energy (the disposable-soma trade-off), so long life is bought, not free. Give filter feeding a Holling type II saturation (the UX budget readout already assumes one) and a pumping cost. Make clutch cost include a fixed per-offspring overhead (see R11).

**Test early.** In spike 3, run a 10^6-birth open world and plot `SENESCENCE`, `LIFESPAN_MULT`, sessility and clutch size over time. Any trait that walks to its bound with no visible cost is an exploit.

### R9. Both exploit watchdogs misfire in currents (Major)

**Evidence.** Genome: "If a creature's kinetic energy exceeds `10 x 0.5 M v_max(L)^2`, the creature is removed" and saved as a glitch fossil (01, 1.11.3). Physics: "a creature whose mechanical energy rises faster than its muscle work input for 2 s is flagged, its speed clamped, and its genome logged" (02, 2.14), and T5's "kinetic energy never exceeds the integral of muscle work plus buoyancy work" (02, 2.13).

**Why it fails.** A 1 mm microbe with a natural speed of 1 mm/s carried by a 0.25 m/s plume has 250 times its `v_max`, so 62,500 times the kinetic-energy limit. Any passive drifter accelerated by a current gains mechanical energy with no muscle work. The watchdogs as written would delete or speed-clamp the plankton-scale life the currents are meant to carry, which is strong, invisible, artefactual selection against small drifters near currents.

**Fix.** Measure kinetic energy in the local water frame, and count drag work done by the current as an input in the energy-from-nothing test.

**Test early.** A unit test: a passive microbe released into the strongest plume for 60 s must not trigger either watchdog.

### R11. The agent-cap tax is size-neutral (Major)

**Evidence.** "offspring cost more: `cost_birth · (1 + k_cap · (n / N_max)^8)`" and "Small creatures hit this first" (04, 4.7).

**Why it fails.** A multiplicative surcharge on birth cost changes every lineage's fecundity by the same factor, so it does not favour large creatures at all. Agents are dominated in number by microbes because they are cheap and fast; once the cap binds, the tax cuts everyone's births, and slow-breeding large species, with few offspring and long generations, are the ones most exposed to demographic extinction.

**Fix.** Charge an additive, absolute per-agent fee (for example the build energy of a 1 cm newborn times a factor that rises near the cap). That costs a 1 mm microbe hundreds of times its own body and a 20 cm fish almost nothing, which is the intended effect. Or adopt super-individuals for the smallest class (ecosystem open question 3) and say yes to it now.

**Test early.** In spike 3, compare the size spectrum at the cap under the multiplicative and additive rules.

### R12. Evolution speed at 1x, and the fast-forward ceiling (Major)

**Evidence.** Day length "1200 s (20 minutes at 1x)" (04, 4.0); speed lease returns to 1x when the god window closes (07, 3.3); Yield freezes the world while William games or runs ComfyUI (05, 5.2.4). Births: "The CPU receives the list with a fixed latency of exactly 2 ticks" (05, 5.5.1); brain development is "77 targets x about 128 candidates = 10k queries ... 1 MFLOP per birth" on CPU workers (03, 3.6.3); headless tuning assumes "roughly 300 to 800x real time" (04, 4.11).

**Answer to "will anything interesting evolve within hours or days?"** Within hours: ecological drama (blooms, cycles, hunts) and microbe-scale adaptation (diet, gait, glow), because microbe generations are minutes. Within days: visible drift in small grazers and their behaviour, and plenty of microbe species. Macro-scale body-plan novelty and speciation of 10 cm animals: weeks of 24/7 running at 1x, by the genome section's own calibration of "200 to 400 generations of divergent selection" at an hour or more per generation. That is a fine long-term tank, but it is not what William will see in his first week.

**Fast-forward ceiling.** Every tick waits on a GPU-to-CPU readback of births from two ticks ago, and every macro birth costs about a millisecond of JavaScript for body development, CPPN wiring and species assignment. At 1,700 births per second, 300x would need about 500,000 births per second on the CPU, which is impossible; per-tick `mapAsync` round trips through Dawn cap tick rate independently (spike 2 measures it). My estimate is 10 to 50x for a small world, not 300 to 800x.

**Fix.** Batch births (process the birth list every N ticks, with N fixed and journalled so determinism holds). Move body development to the GPU or to WASM, and use the cheaper direct brain encoding (R15). Add an explicit "night shift" mode: when the PC is idle and unwatched, run at the highest speed the power budget allows (R19). Pre-evolve the starter world offline.

**Test early.** Spike 2 measures readback latency; spike 3 measures generations per wall hour for each size class.

### R14. Species counts from a fixed distance threshold (Major)

**Evidence.** "defaults: c_s = 1.0, c_p = 0.5, c_t = 2.0, theta_species = 0.30" with calibration that populations "should not cross it within 1,000 generations of neutral drift in one well-mixed population"; promotion at "N_min = 8 living members"; reconcile cost "about 4,096 x 200 medoids x 1.5 us" (01, 1.9). Default variation: "about 1.25 point mutations and 0.25 structural events per birth" (01, 1.6.3).

**Why it fails.** The calibration is for a sexual, well-mixed population. In an asexual budding population nothing homogenises genomes: two random members differ by the structural innovations accumulated along both branches since their common ancestor, about 0.5 per generation of coalescence time. In a microbe population of tens of thousands, coalescence times are hundreds to thousands of generations, so the Jaccard term collapses and the population shatters into many clusters above theta. Clonal bursts reach `N_min = 8` trivially, so they promote. The neutral `ODOUR_A` to `ODOUR_C` traits are counted in the trait-block term and drift with every point mutation. Expect hundreds of microbe "species", a director "new species" event every few minutes, a reconcile sized for 200 medoids running against many more, and the tuning target "Species richness S | 8 to 40" (04, 4.11) unreachable for the wrong reason.

**Fix.** Calibrate theta separately for asexual lineages, or define species for budders on the expressed phenotype (body-plan descriptor and diet) rather than on genes. Exclude silent genes, synapse genes and neutral markers from the distance. Promote species only above a biomass threshold as well as a count. Make the genome section's open question 3 (a display-level threshold slider) the default answer.

**Test early.** In spike 3, run 10,000 asexual microbes for 2,000 generations in a uniform world (no divergent selection at all) and count species. The right answer is about 1.

### R15. The HyperNEAT brain: mutational load, ruggedness, development cost (Major)

**Evidence.** "CPPN weight perturb | 0.8 per conn" per offspring (03, 3.6.4); "Fill remaining slots with the top `K - reflexCount` by `|w|`" (03, 3.6.3); "Typical brain: 77 targets x about 128 candidates = 10k queries ... 1 MFLOP per birth" (03, 3.6.3).

**Why it fails.**
1. With a 30-connection CPPN, 0.8 per connection is about 24 weight perturbations per birth, and every one of them changes weights everywhere in the brain. That is far above the genome section's whole-genome default and is a generational-EA setting transplanted into a steady-state ecology, where most offspring must remain viable.
2. Keeping the top 16 sources by |w| out of up to 128 candidates is a discontinuous step: a small CPPN change swaps which synapses exist at all. Fitness landscapes become rugged exactly where the design wants smooth body-brain coupling.
3. HyperNEAT is known to be weak at the irregular, fine control that evolved locomotion and foraging need (Clune et al. 2011, which the section cites); overrides are a patch.
4. The innate reflexes (03, 3.8.2) are good enough that evolution may simply tune reflex gains and leave the CPPN irrelevant, which makes "brains evolved" hard to show.
5. 1 MFLOP of JavaScript per birth is affordable at 1x and is the bottleneck for any fast-forward (R12).

**Fix.** For v0.1, use the genome section's direct NEAT encoding with fixed slots and part-level CPGs: it already makes duplicated fins "swim straight away" by inheriting the channel, which is the main benefit claimed for the CPPN. Keep the body-anchored CPPN as a later experiment behind the brains section's own E2.

**Test early.** Spike 8: brains E2 run against both encodings on a 2D swim-and-forage task with forced duplications, plus a distribution of fitness effects (genome E8) for each.

### R22. The innovation registry blocks repeated duplication (Minor)

**Evidence.** "Copy a module gene with a new innov from `innovFor(dup, src)`" with a reuse window of 100,000 births, and repair "drops duplicate innovs, keeping the first" (01, 1.6.2, 1.3.7 and 1.7.4). Overflow: "about 0.05 structural events per birth at 2,000 births/s uses 2^32 ids in about 1.4 years".

**Why it fails.** A lineage that duplicates module X, then duplicates X again within the window, receives the same innovation id twice; repair deletes the second copy, so the most important evolvability operator is silently a no-op for repeats. The overflow estimate uses 0.05 structural events per birth, but the stated default is 0.25, so the 2^31 compaction point arrives in about 2 months, not years.

**Fix.** Key duplications by `(src, number of existing paralogs of src in this genome)`, the same trick the brains section uses for node splits. Recompute the overflow with the default rate, or use 64-bit ids.

**Test early.** A unit test: duplicate the same module three times in one genome; expect three copies.

---

## 4. Ecosystem stability and tuning

### R13. Auto-tuning is far more expensive than estimated (Major)

**Evidence.** "roughly 300 to 800x real time on the 5090 ... About 500 to 800 runs, roughly one night" and "Re-tuning is required whenever the creature, brain or physics sections change costs materially" (04, 4.11).

**Arithmetic (estimate).** At a realistic 20 to 50x (R12), a 150-sim-day run (50 hours at 1x) takes 1 to 2.5 hours. Eight concurrent worlds give 3 to 8 runs per hour, so 800 runs take 4 to 10 days per campaign, plus screening and validation (20 seeds x 365 days for the top 3 is another week). During development, costs change weekly.

**Fix.** Tune ecology parameters on a reduced model first (fields plus agents with fixed, card-free movement and no brains), on a micro tank of about 2,000 agents. Shrink the tuning set from 16 to about 6 parameters chosen by the Morris screen, and use 30-day runs with a quick-fail gate. For v0.1, accept hand tuning plus the existing safety valves.

**Test early.** Measure real headless throughput in spike 2 and divide.

**Stability, more broadly.** The conserved-mass design is the right foundation: it cannot explode in mass, and the cysts, refuges, quadratic closure and disease give it several real stabilisers. The risks I would watch are elsewhere: the agent count (R11), immortal blobs (R10), and the safety valves themselves. "Diversity collapse" immigration every 2 sim days plus background immigration at 0.05 per day will, in a struggling world, make the tank a revolving door of archived species, which hides whether anything is evolving. Log the fraction of living biomass descended from immigrants within the last 30 days and show it in the stats view.

### R8. Fixed-point and f32 ranges cannot span the mass range (Major)

**Evidence.** Ecosystem exchange uses "u32, 1 unit = 1e-4 mu, saturating with an overflow flag" (04, 4.4). Physics: "Each creature accumulates its tick's flows in f32 registers" and stores `E_s` in a 48-byte f32 record (02, 2.6.9 and 2.9.2); "Mass range | about 3e-8 kg to 2e3 kg | 11 decades, fine in f32 per creature" (02, 2.1).

**Arithmetic.**
- A 0.5 mm microbe weighs (0.05)^3 = 1.25e-4 mu, about one unit. To double in 30 s it eats about 4e-7 mu per 10 Hz ecology tick, which is 0.004 units: it rounds to zero, so microbes cannot eat.
- A 1 m creature is 1e6 mu = 1e10 units, above the u32 maximum of 4.3e9; a 4 m creature is 6.4e11 units. u32 spans 9.6 decades and the mass range is 10 to 11.
- A 2,000 kg leviathan has `E_s = 0.3 x 4000 x 2000 = 2.4e6 J`, whose f32 spacing is 0.25 J. Its basal burn is about 90 W, 1.5 J per 60 Hz tick, so each update rounds by up to 0.125 J (8%), and because the per-tick change is nearly constant the rounding has the same sign every tick: a bias, not noise. Small costs (a light organ, a brain) for giants can vanish below half a unit.

WGSL has no 64-bit atomics, so "just use u64" is not available on the GPU.

**Fix.** Per-creature exchange amounts in units scaled to the creature's own mass (for example fractions of body mass in u32), converted to world units with a carried f32 remainder, plus deterministic stochastic rounding from the existing counter-based RNG, which is unbiased and conserving. Split stocks into a high and low f32 pair, or hold them as i32 fixed point relative to capacity. Update stocks at the 10 Hz ecology tick rather than 60 Hz.

**Test early.** Spike 3 or a one-day unit harness: push a microbe and a leviathan through one sim day of feeding and metabolism and compare against an f64 reference.

---

## 5. Determinism

### R16. Governors and neighbour order break determinism (Major)

The cross-GPU claim is appropriately modest: "Long runs agree statistically" (05, 5.5.2). The problems are within one machine.

**Evidence.**
- "The host's load governor can drop brains to 10 Hz (`mod 6`)" (03, 3.9.1).
- Fair mode: "if the F tier fits the budget, every remaining creature is F" (02, 2.11.3); budget mode ranks by budget.
- "the population governor (architecture section) caps births before physics would exceed its budget" (02, 2.12.2).
- Physics: "The order within a cell is nondeterministic, which is harmless" (02, 2.8.2). Brains: "cap 48 nearest by cell ring order" (03, 3.4.1). Architecture: cells "sorted by `(cell, entityId)`, so neighbour order is stable" (05, 5.5.1).

**Why it fails.** Any governor that reacts to measured milliseconds changes sim results according to load, so two runs from the same snapshot diverge, and journal replay after a crash does not reproduce the world. Capped nearest-48 selection from an unsorted cell changes which objects a creature sees, and order-free integer sums do not rescue a choice. Physics test L2 claims fair mode is "bitwise, since the camera is not an input", but timing is.

**Fix.** Governors may only decide at fixed tick boundaries, and their decisions are written to the journal as sim inputs, exactly like god commands. Adopt the architecture's rule (sort by `(cell, entityId)`) everywhere, with ties broken by entity id. Event lists consumed on the CPU must be sorted before use, as births already are.

**Test early.** Run the same snapshot twice for 10,000 ticks with an artificial GPU load in one run (another process saturating the GPU); the state hashes must match.

### R26. A bit-exact CPU backend cannot also be the fast laptop fallback (Minor)

**Evidence.** "f32 is emulated with `Math.fround` after every operation" (05, 5.5.2), while the physics CPU fallback is budgeted at "about 1 microsecond per segment per tick" (02, 2.12.2).

**Fix.** Two CPU paths: a slow bit-exact reference for tests and replays, and a fast float64 or WASM path for laptops whose results agree statistically, like the GPU path.

---

## 6. Architecture and platform risks

### R17. Dawn on Node is unproven exactly where the design leans on it (Major)

**Evidence.** "The host runtime is Node.js with Dawn (the `webgpu` npm package)" with "the Dawn Node binding is younger than wgpu" as the main risk; "Dawn Node on lavapipe in CI is unverified and is the first spike of stage S1"; whether Dawn can use WARP on Windows CI is "unverified" (05, 5.1.2 and 5.8).

**What the design depends on, untested:** prebuilt Windows binaries that track Dawn; `mapAsync` resolution latency under Node's event loop (the fixed 2-tick birth latency and per-client stream readbacks); `timestamp-query` without quantisation (the duty-cap controller needs sub-millisecond timing, and Dawn quantises timestamps by default in browsers); requesting the adapter's maximum limits; recovering from `device.lost` without leaking; and memory stability over weeks. Two Windows-specific risks: EcoQoS on hybrid CPUs moves the host to efficiency cores, slowing births and stream compression; and a windowless background process on Windows 11 may not get high timer resolution, so "sleeps between ticks to stay under the duty cap" will have about 15.6 ms granularity (to verify), which bunches ticks.

**Fix.** Run spike 2 before committing. Keep the in-page S0 stage as the development environment (Chrome's WebGPU is mature) and make the host move conditional on the spike. Pace ticks by GPU completion and a busy-wait budget rather than OS sleeps.

### R20. The public install story will trip SmartScreen and antivirus (Major)

**Evidence.** "Code signing: ship unsigned (Windows SmartScreen will warn strangers) or apply for free open-source signing" (05, open question 5); a per-user installer that writes a `Run` key, bundles `node.exe`, opens a local HTTP server (and optionally binds `0.0.0.0`), registers an `.scr`, and uses Raw Input with `RIDEV_INPUTSINK` (05, 5.2 and 5.6.2).

**Why it fails.** An unsigned new executable with autostart, a bundled interpreter, a listening socket, a global input sink and a screensaver file is close to a checklist for heuristic malware detection. `.scr` files are a classic malware vector and are frequently blocked by mail and browsers. The `0.0.0.0` toggle triggers a Windows Firewall prompt. Public users also need Lively installed separately, and the NVML probes only work on NVIDIA.

**Fix.** For v0.1 ship to William only, as a portable zip. Before any public release, sign (SignPath Foundation or Azure Trusted Signing), submit binaries to Microsoft's malware analysis, document Lively setup with screenshots, and make the browser-only demo the public front door.

### R21. TV via tab cast degrades the look (Major)

**Evidence.** "dark gradients and pinpoint glows are a worst case for video codecs" (05, 5.6.3); the cast sub-profile mitigates with dither and larger glows (06, 6.1.6).

**Why it fails.** Tab mirroring is typically 720p to 1080p at an adaptive 5 to 10 Mbps (unverified). Animated dither costs bitrate and becomes mush; static dither shows as a fixed pattern on an OLED. The result will look visibly cheaper than the wallpaper, on the biggest screen in the house, which is where William will show it to people.

**Fix.** Treat tab cast as a stopgap. Test route B (the Android TV WebView app) on the actual device early. Also consider a third route: the host encodes the TV view itself with NVENC as 10-bit HEVC or AV1 at 20 to 40 Mbps and a small Android TV app plays it. The CNX article the architecture cites says the Chromecast with Google TV HD decodes AV1. That costs the TV's GPU nothing and handles gradients far better (unverified; spike 7).

### R24. Lively unknowns (Minor)

`"Type: 1` for web is unverified", the pause mechanism is unverified, and WebGPU inside a cross-origin iframe loaded from a local loader is untested (05, 5.6.1; 06, 6.1.1). Each Lively monitor instance is its own client and renderer, so two 4K monitors double the wallpaper's render cost and stream load. **Fix and test:** spike 4.

### R25. Screensaver details (Minor)

Whether the Screen Saver Settings list shows an `.scr` outside System32 is unverified (05, 5.6.2). A god window or a casting Chrome tab can hold a display wake lock that stops the screensaver from ever starting. The screensaver flow starts the whole shell and host if absent and waits up to 5 s on black; with the host Evicted, re-uploading buffers and recompiling pipelines may exceed that. **Fix:** test all three on William's machine in spike 4; show the idle animation rather than black while waiting.

### R23. WebGPU storage-buffer limits (Minor)

The physics section notes "WebGPU's default limit is 8 storage buffers per shader stage" (02, 2.9), but `find_contacts` as outlined reads `itemCell`, `cellStart`, `cellCount`, `sortedItem`, `contacts`, `nContacts`, `overflow`, segment positions, creature anchors, static segment data for `skip_pair`, and the level mask: about 11. **Fix:** pack counters and flags into one buffer, and pack item data into one record. Add a CI check that every pipeline compiles at default limits.

---

## 7. The wallpaper

### R18. Calm is not guaranteed (Major)

**Evidence.**
- "DUST_FRAME | ... | 5 to 10 Hz | far-LOD points, always a keyframe", "sorted in Morton order", and "The vertex shader interpolates between two buffered frames" (05, 5.3.2 and 5.3.4). Interpolating by vertex index needs the same entity in the same slot in both frames; a per-frame Morton sort breaks that, so far creatures either jump at 5 Hz or interpolate between unrelated points.
- Brain-driven emission: the brain's "emit intensity" output is unclamped in time (03, 3.8.1), and brains tick at 20 Hz. Only organ gene periods are clamped (06, 6.1.5). Synchronous flashing "can evolve" (06, 6.1.5). The runtime safety net triggers only at WCAG thresholds, which are far above "calm".
- A 20-minute sim day (04, 4.0) puts a dawn and a dusk on the desktop every 20 minutes.
- Physics open question 2: "evolution may dim the tank wherever glowing does not pay". A wallpaper that evolves towards dark, dull, efficient creatures is a real outcome of honest costs.
- Severed tails, corpse fragments and Munk-moment tumbling ("if bodies look restless, tune `c_a`", 02, 2.14).

**Fix.** Give far LOD a stable per-client slot order (the body records already have slots) and send velocity so the view can extrapolate; or render far life only as the glow field on the wallpaper. Slew-limit every creature's emission in the renderer (time constant of about 300 ms on the wallpaper, plus a cap on whole-screen luminance change per second). Compress the day-night range on the wallpaper in the renderer only (the sim keeps its day), or sync the sun to local time as the ecosystem section offers. Decide physics open question 2 now: a free, non-heritable baseline glow that the renderer draws for every living creature, so the look survives whatever evolution does. Dissolve severed fragments into motes on the wallpaper profile.

**Test early.** Record 8 hours of the wallpaper view from a running world and score it: per-second mean luminance change, the fraction of screen changing more than 5% per second, and the mean emissive brightness over time.

### R19. Power and noise while idle (Major)

**Evidence.** Ambient 15% and Background 10% duty, with Background "1x by default ('keeps evolving while you work')" (05, 5.2.4), plus the wallpaper's own render at up to 4.5%.

**Why it fails.** A GPU that receives work every 33 ms never drops to its idle clocks. On a 5090 the difference between true idle and a steady 15 to 30% duty is plausibly 50 to 120 W at the wall (estimate, unverified), around the clock. At 100 W that is about 880 kWh a year, roughly £220 to £260 at UK prices, plus fan noise in a quiet room. "Gentle" in the brief is about how it looks, but William will notice the fans.

**While gaming** the design is sound: Yield freezes the sim, Lively pauses, borderless games are caught by the foreground-rect check and NVML. Two edge cases: a game on one monitor with the wallpaper visible on another (Lively may not pause that monitor, NVML catches it after 5 s), and 1.4 to 2 GB of VRAM held for the first 10 minutes of Yield.

**Fix.** Add a power budget, measured with NVML power draw, as a first-class throttle input (for example "at most +25 W on average while I am working"). Run ticks in bursts with long idle gaps so clocks can drop, and measure whether they do. Offer "evolve at night" as a schedule.

**Test early.** Spike 5 with a plug-in power meter.

---

## 8. Scope

### R3. A multi-year research programme with no early payoff (Blocker for the plan)

**Evidence.** About 520 KB of design across 7 sections. The architecture's stage S2 exit criterion is "William uses it daily for 2 weeks", after a Node and Dawn host, WebSocket streaming, persistence with journal replay, a Tauri tray shell, a Lively package, an `.scr`, a TV page and GPU etiquette.

**Count of research-grade subsystems:** multi-rate XPBD with implicit added mass and the Munk moment; reduced-tier swimmer cards with audits; a graph-grammar genome with regulatory genes and an innovation registry; a body-anchored HyperNEAT brain with plasticity; an NPZD plankton model with conservative finite-volume transport, Lenia-style mats, oxygen and stratification; coevolving pathogens; species tracking with medoids, splits and reconciles; a pruned phylogeny; a multi-client streaming protocol with dead reckoning; an SDF renderer with chunked leviathans and a flash-safety net; a story-based camera director; generative audio; a designer with a part editor and a live test tank; a Tauri shell, a Rust `.scr`, a Kotlin TV app and a Lively package; plus an auto-tuning pipeline. Each would be a respectable project on its own.

**Honest estimate.** At evenings-and-weekends pace (about 10 hours a week), the full design is 3,000 to 6,000 hours of work: three to six years alone, perhaps one and a half to three with heavy AI assistance, and the evolvability parts are bound by wall-clock experiment time, which assistance does not shorten. Yes, this is at least a 2-year project, and the leviathan requirement may still not be met at the end of it without R2's decision.

**Honest minimum to delight William soon (6 to 10 weeks):** a Lively wallpaper showing a few thousand glowing, soft-looking swimmers in dark water, which are visibly born, eat, die and drift in their traits; that survives a reboot; with a god page in the browser to drop food, a cold snap and a meteor, to watch a population chart and a simple species tree, and to release creatures from templates with sliders. That is the core promise of the brief, and everything else layers on it. Section 10 lists the cuts.

---

## 9. Spikes to run first

Eight small experiments, each a few days at most, chosen to retire the largest risks above. Run spikes 1 to 4 before approving the detailed design.

1. **XPBD swimmer benchmark in WGSL (3 to 4 days; R4, R5, R6, R7).** In a Chrome page: an 8-segment fish and a 4-segment flagellate on the physics section's equations. Measure B2 and B4, T1 convergence at `n_sub` in {1, 2, 4, 16}, the exploit-transfer ratio (evolve at 1 substep, re-evaluate at 16), and kernel timings at 100k and 750k segments. Add the hash, contact-append (one global atomic versus per-workgroup) and perception microbenchmarks with a realistic size spectrum.
2. **Dawn on Node on Windows (2 days; R12, R17).** `npm i webgpu` on William's PC: run spike 1's kernels, measure `mapAsync` latency p50 and p99 per tick, timestamp-query resolution, sustained ticks per second with a per-tick readback, `device.lost` recovery, and memory over a 24-hour soak. Repeat on lavapipe in a Linux container, and try Deno's WebGPU as the fallback.
3. **Evolvability toy in 2D (4 to 5 days; R2, R8, R10, R11, R12, R14).** CPU-only, deliberately crude bodies (a length gene, a speed gene, a mouth type, a few behaviour weights), but the real metabolic constants, `e_b`, nutrient conservation, plankton field and agent cap. Report: generations per wall hour by size class; the size spectrum and largest sustained mass for `M_target` 2e6, 2e7 and 1e8; species count from the genome section's distance under pure asexual drift; trajectories of `SENESCENCE`, lifespan, sessility and clutch size; multiplicative versus additive cap tax; fixed-point and f32 ledger error for a microbe and a leviathan.
4. **Lively and WebView2 WebGPU check (1 to 2 days; R18, R24, R25).** A minimal page that requests a WebGPU adapter, draws 100k additive specks with bloom at 4K 30 fps, connects a WebSocket to localhost and logs to the host. Package it for Lively (verify `Type`), try iframe and direct modes, observe pause behaviour, GPU use, and two-monitor behaviour. Load the same page in a bare wry WebView2 as a proto-`.scr`, and check the settings list and wake locks.
5. **GPU etiquette and power (1 day; R19).** A synthetic compute load through Dawn at 10%, 15% and 35% duty, steady and bursty. Measure wall power (plug meter) and NVML power and clocks against true idle, and frame-time percentiles in one demanding game with the load at 2 ms dispatches, then with Yield.
6. **Wallpaper calm recording (1 day after spike 4; R18).** Record an hour of the spike-4 page fed by spike 3's world: dust at 5 Hz with and without stable slots, brain-driven emission with and without slew limits. Score luminance change per second and look at it on William's actual desktop.
7. **TV picture test (1 to 2 days; R21).** Cast a still and a slow-moving dark-glow test scene to William's Google TV by tab cast; sideload a minimal Android TV WebView app running a WebGL2 version on the device and measure frame time; if possible, play a host-encoded 10-bit HEVC or AV1 stream of the same scene. Compare side by side on the TV.
8. **Brain encoding shoot-out (3 to 4 days; R1, R15).** On spike 3's world with spike 1's swimmer: the genome section's direct NEAT with fixed slots and part CPGs versus the brains section's body-anchored CPPN. Run brains E2 (forced duplications) and genome E8 (distribution of fitness effects), and time development per birth in JavaScript.

---

## 10. Recommended cuts for v0.1

The goal of v0.1 is the "minimum to delight" in section 8, on William's PC only.

**Keep, simplified:**
- One host process (Node and Dawn if spike 2 passes; otherwise the sim runs in a CPU worker pool on Node) streaming to views over WebSocket. Snapshots every 10 minutes with atomic writes and checksums. No journal replay yet: on a crash, resume from the last snapshot.
- One tank preset sized to the mass budget (for example 32 by 18 m), a size range of about 0.5 mm to 30 cm (R2, option 1), and one population target of 10k to 50k creatures.
- Genome: the graph grammar, trait block and regulatory genes, with the organ list trimmed to segment, fin, whip limb, two mouths (filter and jaws), one eye type, chemo and photophore. Asexual budding and simple sexual crossover.
- Brain: the genome section's direct NEAT with fixed I/O slots and part CPGs; the brains section's innate reflexes (they are excellent for bootstrapping).
- Physics: one full tier, rigid segments in XPBD at a fixed 4 substeps, linear plus quadratic drag, buoyancy, contacts and biting. No added mass, no Munk moment, no cards, no multi-rate buckets.
- Ecology: the conserved nutrient budget, the plankton field with light by depth, day and night and one seasonal cycle, detritus and corpses. Hand-tuned.
- Species: distance clustering on expressed body genes with promotion by biomass; a population chart and a simple species tree.
- Renderer: water background, specks, L1 SDF bodies, light organs, trails and bloom, with emission slew limits and the dither. Idle-drift camera only.
- Wallpaper via Lively; the god window as a browser page with an inspector, four powers (food bloom, cold snap, meteor, cull), release from templates, and gene sliders.

**Cut from v0.1 (each a later milestone):** the reduced tier and swimmer cards; added mass and jets; the body-anchored CPPN, overrides and plasticity; personality genes beyond 3 or 4; disease and pathogens; oxygen, mats, reefs, ice ages, earthquakes and terrain editing; the auto-tuning pipeline; the part editor and test tank; sharing strings, QR codes and the share page; the camera director, captions and audio; the `.scr`; the TV in all forms; the Tauri shell, tray, NVML probes and installer (use a start-up shortcut); localisation beyond English; journal replay and branch worlds; the browser-only public demo.

**Suggested order after v0.1:** v0.2 screensaver with a simple director; v0.3 TV by the route spike 7 picks; v0.4 disease and coevolution; v0.5 part editor and sharing; then the GPU scale-up and reduced tier if the population is the limit.

---

## 11. Overall verdict

The vision is right and the research is unusually good: the conserved nutrient currency, honest physics-driven costs, low-to-high Reynolds behaviour falling out of one drag law, fixed-point integer accumulation for determinism, the camera director's exposure memory, and the attention to photosensitivity are all things I would keep. The architecture direction (one host owning the world, thin views, a tray shell, Yield while gaming) is sound.

The document is not yet a buildable design. It is seven good designs for seven slightly different games (R1). Its headline promise, evolved leviathans, does not survive its own arithmetic (R2). Several numerical choices will hand evolution free energy or free life (R6, R7, R8, R9, R10), which artificial-life systems always find. The performance budgets add up to roughly twice the gentleness caps (R4, R19). And the plan has no point at which William gets a delightful thing on his desktop before a year of infrastructure (R3).

**Recommendation: approve the vision and the architecture direction; do not approve the detailed sections yet.** Run spikes 1 to 4 (about two weeks), write the single contract document that resolves R1 with the spike results, make an explicit numeric decision on R2, and build the v0.1 in section 10. Revisit the full design when v0.1 has run on William's desktop for a month and spike 3 has shown what actually evolves.
