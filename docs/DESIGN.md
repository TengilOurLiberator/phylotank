# Phylotank: design document

Status: consolidated draft for William's review, 2026-11-04. Editor's synthesis of the interview record ([BRIEF.md](BRIEF.md)) and seven detailed sections, which stay as appendices:

| Appendix | Owns |
|---|---|
| [01 Genome, development and evolution](sections/01-genome.md) | encoding, growth, mutation, reproduction, mate choice, species, phylogeny |
| [02 Bodies, physics and metabolism](sections/02-physics.md) | mass, joints, muscles, fluid, contacts, energy ledger, integrator, physics LOD |
| [03 Brains, senses and behaviour](sections/03-brains.md) | neuron model, brain encoding, senses, outputs, reflexes, GPU brain kernel |
| [04 Habitat, ecosystem and god powers](sections/04-ecosystem.md) | tank, fields, producers, nutrient cycle, feeding, disease, regulation, powers, metrics, tuning |
| [05 Architecture, persistence and platforms](sections/05-architecture.md) | host, processes, streaming, snapshots, determinism, Lively, `.scr`, TV, security |
| [06 Rendering, camera director and audio](sections/06-rendering.md) | the look, LOD, director, captions, generative audio |
| [07 Creature designer, god window and UX](sections/07-ux.md) | designer, library, god window, onboarding, accessibility, naming |

Where this document and an appendix disagree, **this document wins**; section 4 lists every change the appendices must absorb. All performance figures are estimates until the prototypes measure them.

---

## 1. Overview

Phylotank is an artificial-life fishtank. A glowing, deep-sea, 2D side view of a finite tank holds creatures whose bodies are grown from DNA, whose brains are evolved neural networks, and whose every trait, including how they reproduce and how fast they mutate, is heritable. Light-grown plankton feed grazers, grazers feed predators, corpses feed scavengers and the plankton again. Diseases coevolve with their hosts. William designs new creatures, releases them, and as god throws meteors, plagues, cold snaps and vents at the tank to watch it react. Nobody scripts outcomes: bodies swim because fins push water, species split because genomes drift apart, giants appear only if the food web can carry them.

There is **one persistent world**. A simulation host on William's RTX 5090 PC owns it, saves it to disk and resumes it after a reboot. Every screen is a view into that one world:

- **Wallpaper (Lively Wallpaper).** Pure ambience with no UI at all. A slow idle camera drifts over lit, lively places. Dark water, soft bioluminescent bodies that pulse and trail light, marine snow falling. At most 30 fps, under about 3% of the GPU, silent by default, paused when a game goes fullscreen.
- **Screensaver director (`phylotank.scr`).** The camera works on its own like a nature documentary crew. The host detects hunts, kills, births of giants, new species, mass deaths, swarms, outbreaks and god events; the director scores them as stories, chooses shots (establishing, tracking, slow push-in, scale reveal, aftermath) and moves with critically damped springs and smooth zoom paths across three orders of magnitude, with occasional documentary captions.
- **TV (Google TV or Chromecast).** The same director, tuned for the couch: larger captions, audio on, either a cast Chrome tab or a local web view that renders the stream itself. A remote or gamepad summons an overlay that controls only that TV's camera and sound.
- **God window.** The only place with chrome and the only client that may change the world: the creature designer (gene sliders and a part editor over one genome, with a live physics test tank and an energy budget), the species library and sharing, god powers, an inspector with a live brain view, stats (population, phylogeny, food web, gene drift), a timeline, bookmarks and rewind.

God events appear in every view. Wallpaper versions are gentler (slow fades, capped brightness, no captions).

---

## 2. Architecture at a glance

```
 Windows user session (per user, no admin rights)
 +--------------------------------------------------------------------------------+
 | Phylotank.exe  (Tauri v2 shell, Rust): tray, god window, supervisor,           |
 |   OS probes (fullscreen, NVML, battery, ComfyUI) -> throttle state             |
 |          | stdio JSON (control)                                                |
 |          v                                                                     |
 | phylotank-host  (Node 24 + host.mjs + dawn.node)                               |
 |   fixed 30 Hz tick -> sim-gpu (WGSL via Dawn -> D3D12 -> RTX 5090)             |
 |     perception -> brains -> actions -> physics substeps -> contacts           |
 |     -> metabolism ; ecology fields at 10 Hz ; flow and light at 2 Hz           |
 |   CPU workers: development (genome -> body, brain), mutation, crossover,       |
 |     speciation, phylogeny, detectors, snapshot codec, stream compression      |
 |   persistence: .ptk snapshots + journal + lineage.sqlite + metrics Parquet     |
 |   HTTP + WebSocket 127.0.0.1:47615 (LAN only when "Let my TV watch" is on)     |
 +-----+----------------+-----------------+-------------------+------------------+
       | ws             | ws              | ws                | ws (LAN, paired)
       v                v                 v                   v
   /wallpaper       /screensaver        /god               /tv
   Lively WebView2  .scr (Rust + wry)   Tauri or browser   Android TV WebView,
   idle drift       director+captions   designer, powers   browser, or cast tab
```

**Processes.** The Rust shell is small, native and crash-proof; it does all Win32 work and restarts the host with backoff. The host is a TypeScript sim core whose hot loops are WGSL compute kernels; the same TypeScript and WGSL run in a browser tab (standalone demo, wallpaper fallback) and on a pure-CPU reference backend that is the test oracle. Views are web pages served by the host, so a Lively package never goes stale.

**Data flow.** God commands go from the god window to the host as schema-validated CBOR, are journalled with the tick they apply to, and are broadcast. Each view sends a viewport (its region of interest plus the director's predicted next viewport); the host runs a GPU cull-and-quantise pass per client and streams compact binary frames: body records near the camera, dust points further out, a glow texture for everything below half a pixel, environment fields at 0.5 to 2 Hz, and an ordered event channel. Views interpolate 150 to 250 ms behind, regrow creature bodies locally from genomes with the shared `develop()` function, and render. Snapshots are written every 10 minutes; after a crash the host loads the last snapshot and replays the journal deterministically.

Detail: [05 §5.1 to 5.5](sections/05-architecture.md).

---

## 3. The core model

### 3.1 Genome and development

**Decision.** The genome is a Sims-style parametric **body graph** (module genes are part types, link genes are attachments with repeat counts, recursion, mirror or radial symmetry and terminal-only flags), plus **Hox-like regulatory genes** that read position along the body, side and maturity to scale or gate parts, plus a **fixed-index trait block** (life history, mutation, diet, habitat, look, mating, global shape modifiers), plus a **brain chromosome** (section 3.3). Every structural gene carries an innovation id, which gives crossover alignment and a cheap genetic distance.

**Key numbers.** Typical genome 1.5 to 4 KB, hard cap 16 KB; at most 48 modules, 64 links, 32 regulatory genes; at most 64 parts per body (32 on laptop worlds). Adult length is one log gene from **0.5 mm to 1 m** (section 4, R2). Growth is von Bertalanffy on a size-scaled clock with per-part allometry exponents; a full `develop()` costs about 20 µs, a growth restage about 3 µs. Mutation rate and step size are self-adaptive genes (MU_LOG from -4 to -1 per gene, default -2.3). Reproduction mode is a gene (SEX_PROB, MATE_PATIENCE): budding, obligate sex, or anything between. Crossover takes structure from the bearer and alleles from both parents. Species are genetic-distance clusters (theta 0.30) with hysteresis (8 members and 2 generations before promotion), periodic reconcile and split detection; the phylogeny is a pruned individual tree plus a species tree kept forever.

**Why.** Graph nodes are exactly what a part editor edits; segmentation, duplication and symmetry are single mutations; development is O(parts), bounded and bit-deterministic; the regulatory layer adds gradients and metamorphosis for a few bytes. No design rules exist: a badly placed fin produces torque instead of thrust, and selection removes it.

Detail: [01](sections/01-genome.md).

### 3.2 Bodies and physics

**Decision.** A body is a tree of rigid capsule and plate segments in 2D with 3D volumes ("2.5D", so mass scales as length cubed), joined by compliant revolute joints and solved with small-step XPBD. Each joint has an antagonistic muscle pair with activation lag, a Hill force-velocity curve and a torque cap from muscle cross-section and bending strength. Water exerts per-segment anisotropic drag with linear (Stokes), laminar-friction and quadratic terms, solved implicitly, so viscous and inertial regimes emerge without switches; added mass with the Munk moment lives in the mass matrix. Cilia, jets and gas bladders (Boyle's law) are organs. Bites, grabs and parasite latches are physical links; ramming, spikes and armour act through contact impulses. Positions are an integer anchor per creature plus f32 offsets.

**Key numbers.** Tank viscosity is 20x sea water (`nu = 2e-5 m²/s`), so a 0.5 mm microbe swims at Re about 0.01 and a 1 m giant at Re about 2.5e4. 1 to 16 substeps per tick chosen per creature. Two LOD tiers: full articulated, and a reduced-order swimmer driven by a "swimmer card" measured from the creature's own full-physics gaits; fights, giants and interactions are always full, and on the 5090 the camera never affects tier choice ("fair mode"). Metabolism is Kleiber `B0 m^0.75` with an Arrhenius temperature factor; muscle cost is positive work over 0.25 efficiency plus an isometric term; biomass energy density is compressed to 4 kJ/kg so lifetimes fit a wallpaper (R5). Every joule and every nutrient quantum is accounted for.

**Why.** Rigid segments give exact torques, work and momentum; XPBD and implicit drag are unconditionally stable from microbes to leviathans; the scallop theorem, coasting, streamlining and the square-cube law all fall out of the equations, which is what makes evolved bodies plausible.

Detail: [02](sections/02-physics.md).

### 3.3 Brains

**Decision.** Neurons are **CTRNN** leaky integrators with evolvable time constants (50 ms to 120 s), plus **phase-oscillator neurons** for central pattern generators. The **substrate is the grown body**: each organ contributes its own neurons at its body coordinates (an eye gives receptors, a joint gives a proprioceptor and a muscle motor, a segment gives a small ganglion and an oscillator, the head gives drives and modulators). An evolved **CPPN** (NEAT-style genes) wires the substrate by querying neuron coordinates for weight, link expression, plasticity rule, bias and time constant; up to 32 direct override genes add irregular fixes. An innate reflex layer (swim, startle, graze, bite on taste, avoid walls, reproduce, hunger seeks, fear flees) scaled by heritable gains lets generation 0 live. Optional neuromodulated Hebbian plasticity is gene-gated, costs energy and is not inherited. Twelve named personality genes act on six drive neurons.

**Key numbers.** Size classes C0 to C4, maximum 256 non-input neurons, 192 inputs, fan-in 16 (4,096 synapses). Sparse fixed-fan-in layout, one neuron per thread, activations in workgroup memory. Brain energy cost is absolute per neuron and synapse, so brains are expensive for microbes and cheap for giants.

**Why.** When a segment or fin duplicates, the new organ's neurons receive weights from the same CPPN at a shifted position, so it works in the first generation it exists: brain and body evolve together, which the brief demands.

Detail: [03](sections/03-brains.md).

### 3.4 Habitat and ecosystem

**Decision.** A finite 16:9 tank ("Basin" generator: sunlit shelf with reefs, a cave-riddled slope, a dark abyssal plain, a trench with hydrothermal vents) with light by Beer-Lambert attenuation and self-shading, a seasonal thermocline, oxygen, vent chemistry, and a cheap divergence-free current field from a streamfunction (seeded mode amplitudes plus curl-noise eddies). Producers are a phytoplankton reaction-transport field, Lenia-like benthic mats, and plant creatures. **One conserved currency, nutrient mass**, cycles through dissolved nutrient, producers, consumers, carcasses, detritus, sediment and a geological reservoir; carrying capacity falls out of the arithmetic. Feeding uses a deterministic, conserving demand-resolve-collect exchange in fixed point. Pathogens are lightweight strains with bit-key antigens and adhesins that coevolve with host immune keys (matching alleles, a virulence-transmission trade-off). Regulation is layered: finite nutrients, light, metabolism, predation, disease, refuges, an agent-cap birth tax, and logged safety valves (reseed from a gene bank, immigration).

**Key numbers.** Default tank 64 m x 36 m (R1). Sim day 1,200 s, year 20 days, so roughly a year per evening. Ecology tick 10 Hz; flow, light and temperature 2 Hz. Ecosystem cost on the 5090 about 7 ms per wall second (under 1% of the GPU). About 16 parameters are auto-tuned with headless fast-forward runs (Morris screening, then CMA-ES with early stopping) against target bands for richness, trophic depth, boom-bust, disease and giant viability.

**Why.** Conservation makes the tank impossible to explode and keeps "why did everything die" answerable; refuges, seasons and density-dependent disease are the classic mechanisms that keep real ecosystems diverse and dramatic without scripting.

Detail: [04](sections/04-ecosystem.md).

### 3.5 Rendering and the director

**Decision.** One renderer with WebGPU and WebGL2 paths for every view. Bodies are per-creature signed distance fields (smooth union of tapered capsules) shaded for thickness, rim and halo, with separate "reflected" and "emitted" buffers; bioluminescence feeds reprojected trails (which drift with the current) and dual-filter bloom; filmic tonemapping and blue-noise dither kill banding in dark gradients. Five LOD tiers (density field, specks, impostors, 8-capsule bodies, 64-capsule heroes) with hysteresis and blue-noise cross-fades; a speck's colour equals its body's integrated glow, so zooming resolves rather than pops. Colour is genetic, in OKLCH. A three-layer flash defence (slow by construction, a stricter clamp for saturated red, and a runtime luminance safety net) keeps every mode under WCAG 2.3.1.

The **director** runs in the view as a pure function of the event log, census and seed: events merge into a bounded StoryBook, stories are scored (`S = W · magnitude term · recency · novelty · visibility · travel`), with exposure memory so the same shark is not shown twice within the hour; shots use critically damped springs, van Wijk and Nuij zoom paths for scale changes and slow dips to dark instead of cuts. Captions are a documentary lower third.

**Audio.** Generative WebAudio with no samples: drone, pads, low thuds for giants' strokes, soft bells for births. Biomass sets density, diversity sets harmonic richness, disasters raise a "darkness" that shifts the mode from Lydian towards Phrygian and decays over ten minutes; seasons move the key; each species has a leitmotif that mutates at speciation. Off on the wallpaper, on for TV.

**Key numbers.** Wallpaper at most 1.5 ms per frame at 4K (30 fps, render scale 0.5); screensaver at most 5 ms at 60 fps; laptop wallpaper at most 8 ms at 1080p. Director tick 2 Hz, under 1 ms.

Detail: [06](sections/06-rendering.md).

### 3.6 Designer and god UX

**Decision.** The designer edits one `DesignDoc.genome` through two views generated from the genome schema: gene sliders (each showing the gene value, the predicted phenotype and, once measured, the test-tank value) and a part editor that edits growth rules while letting William point at instances ("this fin comes from rule F2 and appears 6 times", with "break out this copy"). A growth strip scrubs juvenile to adult; a test tank runs the real CPU physics, brain and metabolism in a worker; an energy budget shows break-even food density, starvation time and trade-off chips. **Warn, never forbid**: inviable designs can be released ("Release anyway"). Designs and captured evolved genomes live in a plain-file library and travel as `.ptkg` files or `PTK1.` strings, QR codes and static share links with the creature in the URL fragment. God powers are data-driven `PowerSpec`s with preview counts and hold-to-confirm for major ones, each preceded by an automatic snapshot. Fast-forward is a lease that lapses when the god window closes, so the wallpaper returns to calm. Rewind never deletes the present.

**Key numbers.** God UI under 300 KB gzipped JS (Preact with signals, uPlot, Canvas 2D); onboarding to a living tank in under 10 s on the PC; English and Swedish; full keyboard, gamepad and screen-reader paths.

Detail: [07](sections/07-ux.md).

---

## 4. Reconciled decisions

The sections were written in parallel and conflict. Each item gives the options, the decision, the reason and the appendices that must change. "All" means every section that quotes the figure.

### R1. Tank size

- **Options.** (a) 256 m x 128 m (physics, rendering examples); (b) presets Small 32 x 18, Default 64 x 36, Large 128 x 72 m (ecosystem).
- **Decision.** (b). Tank size is a world parameter with three presets; all three are 16:9.
- **Reason.** The ecosystem's grids, mass budget, agent caps and tuning are built on these presets; 16:9 matches every screen; 64 m keeps the whole-tank view dense enough to watch (about 57 agents per m² at the cap) and keeps the fine producer grid at 590k cells. Physics and rendering wrote "examples assume 256 m; size is a parameter", so only their examples move. Anchored positions stay (cheap, and needed for Large).
- **Change.** 02 (examples, terrain SDF resolution now the ecosystem's 0.125 m grid, hash levels), 06 (zoom examples: whole Default tank at 4K is `zeta = log2(3840/64) ≈ 5.9`; a 6.4 cm view is about 15.9, still 10 octaves), 05 (field grids 256 x 144, not 256 x 128).

### R2. Maximum creature length

- **Options.** (a) 1 m (genome schema); (b) 4 m nominal leviathan, stable to 20 m (physics); (c) "14 m" in a UX example.
- **Decision.** ADULT_LENGTH range **0.5 mm to 1 m** in genome format v1, as two schema constants. The Large preset may raise the ceiling to 4 m later; physics keeps its 20 m stability tests as a safety margin. "Giant" thresholds become relative to the ceiling: rendering's absolute `G_abs = 2 m` becomes 0.3 m; physics' "always full tier" threshold stays 0.3 m.
- **Reason.** 2,000x is the brief's three orders of magnitude; a 1 m creature is already 31 kg in the 2.5D mass model, and even that needs the ecosystem mass budget raised (R14). A 4 m leviathan (2 t) would exceed the whole Default tank's biomass. Physics' viscosity choice still spans both regimes at this range.
- **Change.** 02 (Re table: 0.5 mm at about 0.01, 1 m at 1 m/s about 5e4; starvation example for 1 m), 01 (Re figures used real water; recompute with `nu = 2e-5`), 06 (giant threshold, thud pitch), 07 (TV overlay example).

### R3. Brain encoding

- **Options.** (a) NEAT-style direct node and synapse genes with fixed I/O slots (genome); (b) CTRNN neurons placed on the body and wired by an evolved CPPN, plus overrides (brains).
- **Decision.** (b). The genome's brain chromosome is replaced by: CPPN node and connection genes; up to 32 override genes keyed by stable neuron ids; and a fixed-index **BrainTraits** block (about 64 u16 entries: hidden counts, oscillator flags and frequency band, plasticity rules and rates, sensor noise, 8 reflex gains, 12 personality genes, 6 drive parameter sets), schema-described like the trait block so sliders map by index. Stable neuron id = `hash32(moduleInnov, instancePathHash, slot)`, using the genome's existing instance path hash. Genome traits that duplicate brain genes (EXPLORATION_NOISE, PLASTICITY_RATE, BRAIN_TAU_SCALE, GAIN_*) move into BrainTraits; CPG_BASE_FREQ becomes the oscillator band. The genome's brain mutation operators are replaced by 03 §3.6.4, scaled by MU_LOG. Brain distance enters species distance as CPPN genes in the Jaccard term at weight 0.5 plus personality genes in the trait term.
- **Reason.** Only (b) makes a duplicated organ arrive wired and working; it removes the fixed-slot ceiling on eyes and segments; and physics already expects one motor per joint. The genome's concerns (fixed GPU kernel shape, crossover alignment, editable presets) are met by size classes, hashed CPPN innovation ids and the brain templates.
- **Change.** 01 (§1.3.6, header counts, operators, distance, presets), 07 (brain-size slider maps to `headHidden` and `hiddenPerSegment`; instinct dials map to BrainTraits and reflex gains, not raw weights).

### R4. Inputs, outputs and actuation

- **Options.** (a) Fixed 52 inputs and 23 outputs, 16 actuator channels driving per-part oscillators (genome); (b) organ-contributed variable inputs (108 for the reference grazer) and one motor per joint and fin plus action motors (brains, physics).
- **Decision.** (b). Inputs are whatever the grown organs provide (03 §3.3.2) plus the internal and clock inputs; outputs are per-joint muscles, fin stroke and pitch, CPG frequency, amplitude and turn, and the action motors (mouth, bite, latch, grip, mate, lay or bud, emit intensity and hue, release, cilia, jet, bladder). Physics' organ drives (cilia, jet, bladder, grip) are added to the brains output table. The genome's per-module `cpgPhase` and `cpgAmp` and the link `phaseWave`/`phaseStep` stay, reinterpreted as the **innate gait**: they set that part's oscillator phase offset (added to the CPPN lag) and the weight of the swim reflex from oscillator to muscle. `brainChannel` and `channelSign` are retired.
- **Reason.** Designed gaits stay editable ("wave" toggle, stroke phase in the part editor) and heritable as body genes, while the brain owns the runtime and can override or abandon them.
- **Change.** 01 (§1.3.4 fields, §1.3.6 tables, §1.4.2 joint target formula), 03 (add organ drive outputs; add the innate-gait reflex), 02 (§2.15 output list confirmed).

### R5. Biomass energy density and the mass-energy bridge

- **Options.** Physics: energy in joules, `e_b = 4,000 J/kg` compressed about 1,250x; genome: per-tissue energy densities as "ecology constants"; ecosystem: no energy, only nutrient mass, with "metabolised mass excreted as dissolved N".
- **Decision.** Keep `e_b = 4,000 J/kg` as one world constant (owned by 02, tuned jointly with 04). Tissue factors from the genome multiply it (neural 2.0, armour 1.2 plus mineral, per 02 §2.6.6). Food energy is 0.6 (plant), 1.0 (meat) and 0.3 (detritus) of `e_b`. The bridge: absorbed food mass enters the reserve at its energy-equivalent mass (`E / e_b`) and the remainder of the absorbed mass is excreted as dissolved nutrient at once; unabsorbed mass leaves as faeces to detritus; every joule burnt releases `E / e_b` of reserve mass as dissolved nutrient (and consumes oxygen). So 1 kg of burnt biomass is 4,000 J of heat and 1 kg of dissolved nutrient.
- **Reason.** Physics needs joules for honest power ratios; ecology needs exact mass conservation; this rule makes both ledgers balance simultaneously and is checkable by tests C4, C5 and the ecosystem mass audit.
- **Change.** 01 (§1.4.3 build energy uses `e_b`), 04 (§4.4 creature mass accounting), 02 (§2.6.9 add the excretion coupling).

### R6. Population and memory budgets

- **Options.** Genome 200k creatures and a 256 MB part pool; physics 60k full plus 1.5M reduced agents; brains 300k brains; architecture Default 250k at about 5 KB GPU each including genomes, Big 1M, Unleashed 4M; ecosystem caps 16k, 131k, 262k.
- **Decision.** One table of agent caps per preset, enforced by the ecosystem's birth tax:

| Preset | Tank | Agent cap `N_max` | Machine |
|---|---|---|---|
| Small | 32 x 18 m | 16,384 | weak laptop iGPU; 4,096 on the CPU fallback |
| Default | 64 x 36 m | 131,072 | RTX 5090 everyday |
| Large | 128 x 72 m | 262,144 (manual "Unleashed" to 1M) | RTX 5090, experimental |

Genomes stay on the host (never on the GPU). The GPU holds compiled state only: physics segments and creature records (02 §2.9), brain pools (03 §3.9), ecology and infection state, about 5 to 6 KB per agent at 10 segments and a mid-size brain. The genome's 64 B compiled-part record is a host-side intermediate that feeds both the physics buffers and render templates, not a separate GPU pool. Plankton is a field, never particles (R18).
- **Reason.** 131k agents, most of them small and on the reduced physics tier, fit the 15% Ambient duty cap at 1x (section 5); the larger figures in other sections assumed either no gentleness cap or no ecology mass budget.
- **Change.** 01 (§1.3.8, §1.4.5 budgets), 02 (§2.12 reference workload), 03 (§3.9.6 scenarios), 05 (§5.1.4 table, snapshot sizes, VRAM caps), 07 (soft-cap knob range).

### R7. God-command lead time

- **Options.** 3 s (rendering, so the director arrives in time); 1 s wall (ecosystem, for immediacy).
- **Decision.** Per power: **3 s for major powers** (the `major(i)` rule in 07 §3.4: meteor, plague, cull, strong cold snap, ice age and so on), **1 s for minor powers** (bloom, bless, release, current shift). The lead is wall time converted to a tick at the achieved speed; while paused, the countdown starts on resume. The god window shows a countdown and views pre-roll visuals (meteor streak, shimmer) during the lead.
- **Reason.** Major powers are the ones worth filming and they already take an undo snapshot; a visible countdown turns the delay into drama. Minor powers stay snappy.
- **Change.** 04 (§4.8 `startTick`), 06 (§6.2.2 `tFire`, parameter table, director test 2), 07 (casting flow).

### R8. Coordinate conventions

- **Options.** Physics and rendering: x right, y depth down from the surface; ecosystem: the same with surface at `y_s`; body frames as genome AP and SIDE "left or right", brains `u, v` "left or right", physics `attachSide`, UX left and right lateral sockets. In a side view, "left and right" are out of the plane.
- **Decision.** World: SI units, x to the right, y downwards with y = 0 at the nominal surface; the live surface is `y_s` (an ice age raises `y_s`, which moves the waterline down). Angles in radians, positive from +x towards +y (clockwise on screen); heading 0 faces +x. Body frame: `u` from 0 (snout) to 1 (tail tip), `v` in-plane from -1 (ventral) to +1 (dorsal), `d` along a limb from 0 (base) to 1 (tip). Genome SIDE is renamed ventral/dorsal; an in-plane mirror is dorsal-ventral symmetry. **Paired lateral appendages** (pectoral pairs) are one physics part with doubled span, drawn as a near and a slightly offset, dimmer far copy; the UX's left and right lateral sockets merge into one "lateral (paired)" socket.
- **Reason.** Every section already agrees on the world axes; the body axes were the hidden conflict, and the 2.5D model already carries out-of-plane extent as span.
- **Change.** 01 (SIDE naming, mirror semantics), 02 (sign convention wording), 03 (`v` definition), 06 (far-copy drawing), 07 (socket list).

### R9 to R34. Other conflicts found

| # | Conflict | Decision and reason | Change |
|---|---|---|---|
| R9 | **Sim tick**: 60 Hz (physics, brains, ecosystem) vs `dt = 1/30 s` (architecture) | One fixed tick of **1/30 s** on every machine; physics substeps inside it (its own rule picks 1 to 16, and test T2 already checks 30 vs 60 Hz parity). Brains run every tick (30 Hz; the governor may drop to 15 or 10 Hz staggered). Ecology every 3rd tick (10 Hz), flow and light every 15th (2 Hz). One tick structure makes worlds and replays portable between PC and laptop. | 02, 03, 04 |
| R10 | **Body contract**: genome `Phenotype` (8 part kinds, 64 parts) vs physics `SegmentSpec` (7 kinds plus organ flags, up to 256 segments) vs architecture "soft-body nodes" | `develop()` output is canonical; physics reads it through an adapter `toSegmentSpecs()`. Cap 64 parts. EYE, CHEMO and PHOTOPHORE below 2% of body length become organ flags on their host segment. The genome adds what physics needs: cilia patch, jet bell volume, gas bladder (volume, rigid fraction), lipid fraction, claw tip with grip (LIMB jointed subtype flag). Module `density` and the DENSITY_BIAS trait retire: buoyancy emerges from lipid, armour and gas. Genome stiffness maps to Young's modulus `E = 3e5 Pa x stiffness x G_STIFFNESS`. Architecture's soft-body figures are replaced by physics' rigid segments. | 01, 02, 05 |
| R11 | **Digestion**: three models (genome DIET plus gut length; physics `eps_max(g_gut)`; ecosystem enzyme simplex `a = a_max e^theta`) | Assimilation `a_k = a_max,k(g_gut) x e_k^1.3`: gut-length dependence from physics (with `g_gut` derived from the genome's gut length over body length), enzyme allocation `e_k` over plant, meat and detritus from the ecosystem (2 genes, matching the UX diet triangle), first-order emptying and half-times from physics. DIET and CARRION_TOLERANCE are replaced. | 01, 02, 04, 07 |
| R12 | **Mouths and contact feeding**: genome 4 subtypes, UX 5, ecosystem a continuous `MouthDescriptor`; bite, latch drain and grooming formulas in three sections | Five genome subtypes (FILTER, JAWS, RASP, PROBOSCIS, SUCTION, the UX "scoop"), mapped to the ecosystem descriptor by a fixed table plus gape and mesh genes. Physics owns contact mechanics (bites, latch drain `kappa_d A E_s/m`, scraping and thrashing to remove parasites); the ecosystem owns field feeding (filter, scrape) and the conserving exchange. | 01, 04, 07 |
| R13 | **Chemical channels**: brains and genome assume food, blood, toxin, alarm and pheromone fields that the ecosystem never defines; odour is 3 genes in 01, a 4-vector in 03 | The ecosystem adds 8 coarse scent channels (plant scent, blood and meat, toxin, alarm, 4 pheromones) advected and diffused by the existing tracer scheme with per-channel decay (about 1 ms per wall second extra). ODOUR becomes 4 genes (add ODOUR_D), used for both pheromone emission and mate odour. | 01, 03, 04 |
| R14 | **Mass units**: ecosystem "mu" (biomass of a 1 cm creature) vs kg | SI kg everywhere; fields in kg/m². Existing ecosystem numbers convert at 1 mu ≈ 3e-5 kg. `M_target` must be re-derived from the giant-viability constraint (5 to 10 adults of the largest size): first guess about 2e4 kg for Default, then tuned. Nutrient quantum 1e-10 kg (below the 4 µg smallest creature), totals in 64-bit fixed point, per-tick deltas as i32 atomics. | 02, 04 |
| R15 | **Temperature reference**: 15 °C (physics Arrhenius) vs 20 °C (ecosystem Q10) | One reference of 15 °C. Animals use the Arrhenius factor (`E_a = 0.65 eV`); producers and remineralisation keep Q10 = 2, referenced to 15 °C. | 04 |
| R16 | **Innovation ids**: world registry, u32 (genome) vs `hash64` without registry (brains) | Body and regulatory genes keep the registry and reserved template ranges; CPPN genes use 64-bit hashed ids. Both give "same mutation, same id". Births are processed in a fixed order, so the registry stays deterministic. | 01, 03 |
| R17 | **Genome store**: content-addressed blobs (genome) vs parent-diff forest, genomes on GPU (architecture) | In RAM: immutable content-addressed blobs (xxh64). On disk: the parent-diff forest in the snapshot's GENO section. GPU: no genomes (R6). | 01, 05 |
| R18 | **Plankton**: 4M particles (architecture) vs a field (ecosystem, rendering) | A field. Views synthesise particles from the streamed field. The snapshot's PLNK section holds the fine producer grids (about 5 MB). | 05 |
| R19 | **Director location and events**: host-side director (architecture) vs director in each view (rendering); three event schemas (`InterestEvent`, `SimEvent`, `WorldEvent`) | Detectors run on the host (they need global state); the director runs in the view (pure, replayable, one camera per view) and adds its predicted viewport to the ROI so the host prefetches. One EVENT channel carries rendering's `SimEvent` union, extended with god and nature events (`id`, `epoch`, `author`) and the ecosystem's extra kinds (feeding frenzy, epidemic front, migration, bloom front, new role). The ecosystem's base scores seed the director's weights. Host rate limit: 20 derived events per wall second. A multi-monitor screensaver runs one director; secondary monitors take wide context of its shot. | 04, 05, 06, 07 |
| R20 | **Stream records and body shapes**: 10 B quantised records (architecture) vs 20 B f32 `FarRecord` (rendering); 180 B body descriptors vs regrowing from genomes; no joint angles in the protocol | Architecture's wire format; `FarRecord` is the decoded in-memory form. Maturity, log size and energy go in the slow-fields block. Views fetch genome blobs by hash (deflated, LRU cached) only for L1 and L0 subjects and one exemplar per morphology key, then run `develop(genome, m)` locally; descriptors are dropped. A new NEAR_POSE message carries i8 joint angles for at most 128 heroes. | 05, 06 |
| R21 | **Entity ids**: u32 monotonic would wrap in about 45 days at 1,100 births/s | u64 ids on the host and wire (in BODY_ENTER and events); the GPU uses a u32 slot plus generation. | 01, 05, 06 |
| R22 | **File formats**: `.ptk` world (architecture) vs `.ptk` design (UX) vs `.ptg` export (genome) | `.ptk` is a world snapshot (magic `PHYLOTNK`). A design or species pack is `.ptkg`, using the UX container (magic `PTK`, CBOR meta plus genome, CRC32) and the `PTK1.` string form. `.ptg` retires. Internal key xxh64; user-facing fingerprint is the SHA-256 prefix. | 01, 07 |
| R23 | **Starter templates**: seven names in 01, six plus Blank in 07, behaviour templates in 03 | Ship 07's six (Meadowlamp, Hushmaw, Sievebell, Tetherling, Ashpicker, Deepcrown), plus 01's **Motefly** (whip microbe, needed for the bottom of the zoom and the low-Re tests), plus Blank. Each body template carries a matching 03 behaviour template (grazer, ambusher, drifter, parasite, scavenger, giant, microbe). | 01, 03, 07 |
| R24 | **Gene names and missing genes**: UX loci (`body.adultScale`, `gen.mutRate` default 3e-3, "choosiness = max distance") vs genome trait block; genes requested by others | The genome schema is canonical; UX `LocusSpec`s are generated from it with genome ids. Defaults follow 01 (mutation 5e-3). Choosiness is 01's acceptance threshold. Added to trait block v1 (35 reserved slots suffice): IMMUNE_INVEST, O_CRIT, SHELL, SESSILE, MUSCLE_STRENGTH, FAST_FIBRE, AEROBIC_SCOPE, JOINT_DAMPING, CILIA_SPEED, DIET_PLANT, DIET_DETRITUS, ODOUR_D. A key block holds the 32-bit `immuneKey` and `surfaceSig`. Eye receptor count and three spectral sensitivities use the module's spare bytes; photosynthetic tissue is a module field. | 01, 04, 07 |
| R25 | **Glow pulse**: genome 0.05 to 4 Hz, UX "capped at 2 Hz in the genome", renderer clamps | The genome range stays (creatures may perceive fast pulses); only the screen is clamped, per profile (1 Hz wallpaper, 2 Hz elsewhere, 0.5 Hz saturated red). UX V12 informs. | 07 |
| R26 | **God power lists**: 18 in 04, 14 in 07 | The union, defined as `PowerSpec` data with 04's semantics and 07's targeting. Bless (energy top-up) draws mass from the reservoir. v0.5 ships a core 12; the rest by v1.0. | 04, 07 |
| R27 | **Snapshots, undo, rewind**: three cadences; rewind as a branch world (05) vs in-place with an epoch (07) | 05's cadence (auto every 10 min of host time, keep 6; daily, keep 7; 10 GB cap) plus 07's kinds: `beforePower` for every major power and `beforeRewind`, kept 7 days, at most 20 each; manual forever. Rewind is in place (epoch +1, present saved as `beforeRewind`), since all views follow one world; "open as separate world" offers 05's branch for what-ifs. | 04, 05, 07 |
| R28 | **Climate and nature defaults**: year 20 vs 12 days; surface 14/5 °C vs 18/6 °C; nature mode on (04) vs off (07); virulence cap 2/day vs a 0 to 1 knob | 04's habitat values (year 20 days, 14 °C mean, 5 °C swing, 4 °C deep). Nature mode: see open question Q7. The virulence knob maps 0 to 1 onto `v_max` 0 to 5 per day, default 2. | 07 |
| R29 | **Speed**: 0.25x to 4x (05) vs pause, 1x, 4x, 16x, max with leases (07) | 07's lease model with speeds pause, 0.25x, 1x, 4x, 16x, max; achieved speed is capped by 05's duty cap for the throttle state and is shown. | 05, 07 |
| R30 | **Captions**: screensaver off (06) vs on (07); 6 s hold every 25 s vs 5 s every 45 s | TV: on, 6 s hold, at least 25 s apart. Screensaver: on, 5 s hold, at least 45 s apart. Wallpaper: never. | 06, 07 |
| R31 | **Wallpaper without a host**: idle water animation (05) vs in-page "dream tank" (07) | The dream tank, which is v0.1's standalone sim; the idle animation covers its first seconds. | 05 |
| R32 | **Stats storage**: four tiering schemes | Per-species population and trait means at 1 s (last hour), 10 s (1 day), 1 min (30 days), 10 min (forever); ecosystem metrics every 60 sim s to Parquet; species tree in `lineage.sqlite`. | 01, 04, 07 |
| R33 | **Grid shapes and depth constants** assume 2:1 or 256 m (minimap 256 x 64, census 64 x 32, glow 512 x 256; rendering "dark below 60 m") | All grids follow the preset's 16:9 coarse grid (Default 256 x 144; census 64 x 36; glow 512 x 288). Rendering's depth light is fitted to the ecosystem light field (twilight from about 8 m, midnight below about 23 m in the Default tank). | 05, 06, 07 |
| R34 | **Inspector stream**: 20 Hz f32 (03) vs 10 Hz int8 (07) | 10 Hz int8 activations for the whole brain; 30 Hz f32 for up to 8 pinned "scope" neurons; at most 4 inspected creatures. | 03, 07 |

---

## 5. Performance budget

All figures are **estimates** derived from the appendices' models and must be replaced by measurements from the v0.1 and v0.2 benchmarks. Per-tick figures are per 1/30 s sim tick at 1x.

| Item | RTX 5090, Default preset (131k agents, about 40k on the full physics tier) | Weak laptop (4-core, Iris Xe class), Small preset (16k agents, budget mode) |
|---|---|---|
| Physics (integrate, hash, contacts, interactions, metabolism) | 3 to 4 ms per tick | about 3 to 4 ms per tick on the iGPU; CPU fallback: 4k agents in about 35 core-ms per tick on 3 workers |
| Brains plus perception | about 1.2 ms per tick | about 1.5 ms per tick (iGPU); CPU about 3,000 brains per core |
| Ecosystem fields (including scent channels) | about 7 ms per wall second (0.25 ms per tick) | about 20 ms per wall second iGPU; about 115 core-ms per wall second on CPU |
| **Sim GPU duty at 1x** | **about 15%** (Ambient cap 15%, Watching 35%); Large preset about 30% | about 18% of the iGPU |
| Host CPU (births, development, speciation, encoding) | about 1,100 births/s, 1 to 2 worker cores; under 8 ms per tick at p95 | 1 to 2 cores |
| Render, wallpaper | at most 1.5 ms per frame at 4K, 30 fps (about 4.5%) | at most 8 ms per frame at 1080p; 15 to 24 fps recommended |
| Render, screensaver / god window | at most 5 ms per frame at 60 fps / at most 8 ms at vsync | at most 25 ms at 30 fps |
| Streaming, localhost | wallpaper about 3 MB/s; god window about 3 MB/s; screensaver about 2 MB/s | about 1 MB/s |
| Streaming, TV over Wi-Fi | about 0.35 MB/s (2.8 Mbps), hard cap 8 Mbps | n/a |
| VRAM | sim about 1.6 GB (cap 2 GB); wallpaper view about 0.3 GB | sim under 200 MB; view about 100 MB |
| Host RAM | about 0.6 GB working; up to about 2.2 GB while Evicted or holding the device-loss mirror | about 300 MB |
| Disk | about 120 MB per snapshot; 10 GB retention cap; stats and lineage under 1 GB per year | about 15 MB per snapshot |

Rules that make the budget hold: the population governor taxes births near `N_max`; physics budget mode moves small creatures to the reduced tier; brains may drop to 15 Hz before population or physics rate; no single dispatch exceeds 2 ms on the 5090; the host yields completely to fullscreen games and ComfyUI (02 §2.12, 03 §3.9.6, 04 §4.12, 05 §5.2.4, 06 §6.1.9, 07 §7).

---

## 6. Milestones

Each milestone ends with something William can watch, and with acceptance tests that gate it.

### v0.1 "Glass tank": a browser-only wallpaper

The smallest thing worth leaving on the desktop, scoped to a few weeks of evenings. One static web page, no host, loadable directly by Lively as a web wallpaper and in Chrome.

- **Sim (CPU reference backend in a worker; WebGPU optional):** fixed 1/30 s tick, Philox RNG; Small tank (32 x 18 m) with a floor heightmap and a few rocks; light by depth with day and night; a phytoplankton field with nutrient and detritus cycling on the coarse grid, moved by two current modes.
- **Creatures:** about 2,000 to 4,000 agents. Genome subset: trait block, body graph (segment, fin, whip, cup eye, photophore, filter, rasp and jaws mouths), point and structural mutation, budding only. Brains: the innate reflex layer and oscillator neurons only (the CPPN arrives in v0.4). Physics: rigid chains with implicit drag and simple overlap contacts for bites. Metabolism: Kleiber plus muscle work, conserving nutrient exchange.
- **Look:** WebGL2 specks and 8-capsule SDF bodies, glow, trails, bloom, dither, the flash clamps, and the idle-drift camera.
- **Persistence:** best-effort autosave to IndexedDB every 5 minutes.

Acceptance tests:
1. Runs as a Lively wallpaper and as a Chrome tab from the same zip.
2. 2,000 agents at 30 ticks/s on the 5090 PC using at most 2 CPU cores; render at most 3% of the GPU at 4K, 30 fps.
3. 8-hour unattended run: no NaN, population between 200 and the cap, at least 3 distinct body plans alive, nutrient total exact.
4. Same seed, 10,000 ticks, two runs: identical state hash.
5. From a random minimal seed, median swim speed rises at least 2x within 24 hours of sim time.
6. Flash analyser: zero WCAG 2.3.1 violations over 10 minutes.
7. Reload resumes from the last IndexedDB save within 10 s.

### v0.2 "Host": one persistent world

Node plus Dawn host with GPU kernels (CPU backend stays the oracle); the Default preset; WebSocket protocol (HELLO, VIEWPORT, BODY_ENTER and BODY_FRAME, DUST, GLOW, FIELDS, EVENT, ACK); `.ptk` snapshots, journal and crash recovery; Tauri tray shell with throttle states and GPU etiquette; the wallpaper becomes a host client with the dream tank as fallback.

Acceptance: 24-hour soak with a clean mass audit and energy ledger; killing the host mid-run resumes with journalled state hashes matching; resume after reboot; a measured 1x population at or under the 15% Ambient duty, recorded in `bench/results.jsonl`; Yield within 6 s of starting a CUDA load; wallpaper stream at most 3 MB/s; golden replay and the lavapipe job green in CI.

### v0.3 "Director": the screensaver

`phylotank.scr` (Rust plus wry), host detectors and the event stream, the in-view director (StoryBook, scoring, springs, van Wijk paths, dips), captions, audio v1 (drone, pads, darkness, thuds), multi-monitor.

Acceptance: 06 §6.2 director property tests 1 to 10 on the three recorded logs; `.scr` argument-parser tests; exit within 100 ms on input, no exit on launch jitter; every god event on screen by its fire tick in at least 99% of cases; audio offline-render tests (06 §6.8.3).

### v0.4 "Deep evolution"

Full genome (regulatory genes, crossover, sexual mating, mate choice), CPPN brains with plasticity and personality, speciation and phylogeny, the full ecosystem (mats, oxygen, scent fields, carcasses, disease, gene bank and safety valves), both physics LOD tiers with swimmer cards, the auto-tuner and the nightly ecology suite.

Acceptance: genome E1, E2, E5 and E9; brains E1 and E2; physics B1 to B7 and L1 to L3; ecosystem tuning bands hold in 8 of 10 seeds over 150 sim days; richness between 8 and 40; at least one detected population cycle; spring bloom every sim year.

### v0.5 "God window"

Designer (sliders, parts, growth strip, test tank, budget, validation), library with `.ptkg` and `PTK1.` strings, the core 12 powers, inspector with the glass-body brain view, stats (population, phylogeny, food web, gene drift), timeline, bookmarks and rewind, speed lease, onboarding with Founding Waters.

Acceptance: UX-T01 to T08, T20 to T27 and T35; a release reaches the wallpaper and screensaver within 500 ms; every major power takes a snapshot before its effect tick; rewind increments the epoch and rejects stale commands; onboarding under 10 s on the PC.

### v0.6 "TV"

`/tv` WebGL2 low tier and cast sub-profile, LAN binding with pairing, the Android TV wrapper if approved (Q11), audio on by default, overlay and remote and gamepad controls.

Acceptance: median TV stream at most 2.8 Mbps, never above 8 Mbps; at least 30 fps on a Chromecast with Google TV HD or a documented automatic step-down; pairing, Origin and Host checks pass their security tests; banding check passes on the cast profile; UX-T36.

### v1.0 "Public release"

Per-user NSIS installer, Lively zip, npm package, GitHub Pages standalone demo and share page, accessibility (axe-core, NVDA), English and Swedish, docs, CONTRIBUTING with originality and determinism rules, licence audit, fuzzing, remaining powers, optional code signing.

Acceptance: 30 real days of soak on the 5090; install on a fresh Windows VM without admin rights; UX-T30 to T39; browser-only onboarding under 60 s on the throttled laptop profile; no GPL dependencies; a fixture world for every schema version loads and migrates.

---

## 7. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **Evolution is boring or degenerate**: one strategy wins, stasis, or a physics exploit dominates | High | High | anti-exploit invariants and energy watchdog with glitch fossils as regression tests; density-dependent disease; seasons; refuges; nightly emergence suite; tuning bands on richness and turnover |
| 2 | **Performance estimates are optimistic** (Dawn at 50 to 70% of native, barrier-heavy kernels) | High | Medium | measure in v0.1 and v0.2 before scaling; presets and caps are parameters; budget mode and the reduced tier; brains at 15 Hz |
| 3 | **Ecosystem balance takes far longer to tune than planned** | Medium | High | headless fast-forward runs on the Small preset; conserved mass makes failures bounded; safety valves; tuning re-run when costs change |
| 4 | **Scope is large for one person** (TypeScript, WGSL, Rust, Kotlin; seven subsystems) | High | High | milestones each deliver something watchable; the CPU reference backend lets most work proceed without GPU code; TV app and signing are optional |
| 5 | **Dawn Node binding immature or abandoned** | Medium | High | code only against the standard WebGPU API; nightly Deno run as a second implementation; defined exit to a Rust and wgpu host reusing all WGSL |
| 6 | **The calm look fails**: banding, flicker, restless motion, photosensitive risk | Medium | High | dither, slow-by-construction light, three-layer flash defence with an automated analyser, director speed limits, golden image tests |
| 7 | **Giants never evolve** (slow generations, mass budget) | Medium | Medium | Deepcrown seed; `M_target` tuned against giant viability; KLEIBER choice (Q2); fast-forward when unwatched; god-mode seeding |
| 8 | **Determinism breaks**, so replay and crash recovery diverge | Medium | Medium | integer atomics, counter-based RNG, lint bans, journalled state hashes with bisect; recovery degrades to "lose at most 10 minutes" |
| 9 | **GPU contention** with ComfyUI or games annoys William | Medium | Medium | throttle states, Yield and Eviction, 2 ms dispatch cap, below-normal priority and EcoQoS |
| 10 | **Platform quirks** (Lively web type flag, `.scr` outside System32, TV WebView GPU, WebView2 autoplay) | Medium | Medium | each unverified item has a spike in its milestone and a documented fallback (tab casting, location.replace, elevated copy, WebGL2) |

---

## 8. Open questions for William

The sections raised 35 questions (one, whether creatures can see colour, is already answered by the brains section's three-band eyes: yes). They merge into these 12. Each has a recommended default; "use defaults" lets the build proceed.

**Time and pace**

- **Q1. Day and night.** Sim time (20-minute day, 20-day year, so a year per evening), or synced to your real clock with seasons on a faster cycle? *Default: sim time; a "sync sun to local time" option later, entering through the journal.*
- **Q2. Pace of big evolution.** Real metabolic scaling makes a 1 m giant's generation about 300x a microbe's. Keep it real, flatten the exponent to 0.85 (about 30x), or fast-forward when only the wallpaper is watching; and may you leave the tank on an "evolve overnight at max" lease? *Default: keep 0.75; allow an explicit "run unattended until ..." lease from the god window; never fast-forward silently.*

**Scale and realism**

- **Q3. How big.** Default preset 131k agents within the 15% wallpaper duty, or Large (262k, about 0.5x speed as wallpaper)? Fair physics on the 5090 (the camera never changes physics) even if it caps population? May microbe swarms be super-individuals? Brain ceiling 256 neurons, or a 512-neuron class for a few giants? A size ceiling of 1 m? *Default: Default preset; fair mode on; no super-individuals in v1; 256 neurons; 1 m ceiling, raisable later.*
- **Q4. Realism knobs.** Keep oxygen and dead zones; fixed 20x-viscous water (no live slider); hermaphrodites only, or separate sexes for dimorphism; developmental plasticity and horizontal gene transfer; cultural imprinting? *Default: oxygen on; fixed viscosity; hermaphrodites in v1, sexes as a later gene; no plasticity at birth, no HGT, no culture in v1.*
- **Q5. Glow and gore.** Should a free, non-heritable baseline glow keep the tank from going dark if glowing stops paying? Should severed parts stay as visible food or dissolve quickly into glowing particles? *Default: a dim free baseline, bright displays cost energy; fragments stay as food but fade their glow over 30 s and sink.*

**Your designs and your powers**

- **Q6. Releasing designs.** Train a design's brain in a short sandbox before release (nursery), protect founders with one reseed, add a brain hand-wiring tab, limit releases? *Default: nursery off but offered with a before-and-after clip; founder protection on for the first 10 sim minutes; no hand-wiring tab in v1 (templates, sliders and inspector only); releases unlimited.*
- **Q7. God reach.** Should the tank throw its own weather while you are away; must world-ending powers be confirmed and rewindable; is a 3 s lead for major powers acceptable; may brain lesions and stimulation act on the live world? *Default: "nature mode" on for weather-class events only (storms, current shifts, small blooms, mild cold snaps, about one per 10 sim days, never meteors or plagues); hold-to-confirm plus auto-snapshot for major powers; 3 s lead with a countdown; brain experiments in a sandbox fork only.*
- **Q8. Arrivals.** Background immigration from the gene bank on, or a sealed tank? Should reseeds and immigrants show a subtle in-world sign on the wallpaper and TV? *Default: immigration on at a low rate, a faint drift of glowing spores from the surface, never text.*

**Species, views and release**

- **Q9. Species and names.** A view-only slider to see the tree "lumped" or "split" while the sim keeps one threshold? Name species yourself? Keep the template names (Meadowlamp, Hushmaw, Sievebell, Tetherling, Ashpicker, Deepcrown, Motefly) or give Deepcrown a stronger kaiju flavour? Swedish common names? *Default: yes to the view slider; generated binomials with your renames taking precedence; keep the names; Swedish common names on.*
- **Q10. Wallpaper and screensaver behaviour.** Wallpaper camera: idle drift, a fixed framing, or a "calm director"? Screensaver audio off or on? While you game or run ComfyUI, freeze or trickle at 0.1x? *Default: idle drift; screensaver audio off; freeze, but trickle while the screensaver is showing.*
- **Q11. TV route.** Sideload a small Phylotank Android TV app (best picture, local rendering), or rely on tab casting and a sideloaded browser? *Default: tab casting in v0.6, the app as v0.6.x if you agree to sideload.*
- **Q12. Public release.** Ship the browser-only mode on the static site; share links with the creature in the URL fragment; try to hand a shared creature to a local host; apply for free open-source code signing? *Default: yes to browser-only mode and fragment share links; no local hand-off in v1; apply for signing, ship unsigned meanwhile.*

---

## 9. Glossary

Terms outside computer science, machine learning and statistics.

| Term | Meaning |
|---|---|
| Added mass | Water that must be accelerated with a body; makes thin fins and large bodies sluggish to accelerate and turn |
| Aerobic scope | How many times basal metabolism an animal can sustain; above it, work draws on an anaerobic reserve that tires the animal |
| Allometry | Change of proportions with size, such as juveniles with big heads |
| Anagenesis, cladogenesis | A lineage changing over time without splitting; a lineage splitting into two species |
| Arrhenius factor, Q10 | Rules for how rates rise with temperature; Q10 = 2 means a rate doubles per 10 °C |
| Baldwin effect | Learning within a lifetime guiding which genes selection favours, without learned traits being inherited |
| Basin, shelf, slope, abyssal plain, trench | The default tank's zones from shallow sunlit ledge to deep floor and vent trench |
| Beer-Lambert attenuation | Light fading exponentially with depth through absorbing water |
| Benthic mat | A carpet of algae or bacteria growing on rock or sediment |
| Bioluminescence, photophore | Light made by living things; a light-emitting organ |
| Budding | Asexual reproduction by growing an offspring from the parent's body |
| Central pattern generator (CPG) | Neural circuit that produces rhythm (such as a swimming beat) without rhythmic input |
| Chemosynthesis | Making food from chemical energy (vent sulphur) instead of light |
| Clutch | The set of offspring produced in one breeding event |
| Cost of transport | Energy used to move a unit of body weight a unit of distance |
| Counter-illumination | Glowing on the belly to match light from above and hide a silhouette |
| C-start | A fish's sudden escape bend, triggered by a startle reflex |
| Damuth's law | Population density of a species falls as body mass to the power -0.75 |
| Detritus, marine snow | Dead organic particles; their slow rain from upper waters |
| Diel vertical migration | Daily rise of animals to feed at night and descent to hide by day |
| Exaptation | A part evolved for one use taken over for another |
| Fisherian runaway | Mate preference and display amplifying each other over generations |
| Hermaphrodite | An individual that can act as either parent |
| Hill muscle model | Muscle force falls as shortening speed rises |
| Homology | Shared descent of a gene or part in two organisms |
| Hox genes | Genes that give body regions their positional identity |
| Hydrothermal vent | Hot, mineral-rich seafloor spring; an oasis in the dark |
| Kleiber's law | Basal metabolic rate scales as body mass to the power 0.75 |
| Klinotaxis, tropotaxis | Following a smell gradient by sampling over time; by comparing two sensors at once |
| Lateral line | A fish's sense of water pressure and nearby motion |
| Lenia | A continuous cellular automaton that forms organism-like patterns |
| Lower third, title-safe | The caption band at the bottom of a frame; the inner screen area safe from TV overscan |
| Matching alleles | Infection succeeds only when pathogen and host keys match, driving arms races |
| Medoid, species tree, phylogeny | A cluster's most central member; the tree of species; the history of descent |
| Minimum viable population | Population size below which chance extinction becomes likely |
| Monod, Steele curve | Saturating uptake with nutrient; growth with light that saturates then inhibits |
| Munk moment | Torque that turns a moving elongated body broadside to the flow |
| Paralog | A gene copy created by duplication within a genome |
| Paradox of enrichment | Adding food can destabilise predator-prey cycles until they crash |
| Phytoplankton | Drifting microscopic photosynthesisers; the base of the food web |
| Post-zygotic isolation | Hybrids that fail to develop or breed, separating species |
| Red Queen | Hosts and parasites evolving continually just to keep pace |
| Refuge | A place prey can hide from predators, such as caves and reefs |
| Remineralisation | Breakdown of dead matter back into dissolved nutrient |
| Reynolds number (Re) | Ratio of inertial to viscous forces; low Re means syrupy swimming, high Re means gliding |
| Scallop theorem | At low Re a time-reversible stroke produces no net motion |
| Sheldon spectrum | Roughly equal biomass in each logarithmic body-size class |
| Spring bloom, thermocline, turnover | Plankton boom in spring; the layer where warm surface water meets cold deep water; seasonal mixing that brings deep nutrients up |
| Stokes flow | Fluid motion dominated by viscosity |
| Strouhal number | Tail-beat frequency times amplitude over speed; efficient swimmers cruise at 0.2 to 0.4 |
| Super-individual | One simulated agent standing for a cloud of identical small animals |
| Trophic level | Position in the food chain: producers 1, grazers 2, their predators 3 |
| Virulence trade-off | Harsher pathogens shed more but kill hosts sooner, so intermediate virulence wins |
| von Bertalanffy growth | Growth that slows smoothly as an animal approaches adult size |
| Whale fall | A large carcass on the deep floor that feeds scavengers for days |
| XPBD | Extended position-based dynamics: a stable solver for joints and contacts |

---

## 10. William's answers (2026-11-05)

- Leviathans: relative giants (size ceiling about 20 cm on the Default budget, about 400x a microbe) plus leviathans William designs and releases, refined by evolution afterwards (REVIEW R2 resolved this way).
- Plan: build as far towards v1.0 as possible now ("spend all my tokens"). The build still runs the reviewer's spikes as the first tasks of each module and records their results.
- Q2: real metabolic scaling (exponent 0.75), plus an explicit "run at max until ..." overnight lease; never fast-forward silently.
- Q10: wallpaper camera is idle drift.
- Q5: free dim baseline glow; bright displays cost energy; severed parts stay as food, fade their glow over 30 s and sink.
- Q7: nature mode on for mild weather only; major powers need hold-to-confirm plus an automatic snapshot; 3 s lead with a countdown.
- Q9: keep the template names (Meadowlamp, Hushmaw, Sievebell, Tetherling, Ashpicker, Deepcrown, Motefly); generated binomials for evolved species; Swedish common names on; William's renames win.
- Q1, Q3, Q4, Q6, Q8, Q11, Q12: recommended defaults, as listed in section 8.
