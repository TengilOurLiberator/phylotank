# 4. Habitat, ecosystem and god powers

This section defines the world the creatures live in: the finite tank, the physical fields (light, temperature, oxygen, currents, chemistry), the primary producers, the nutrient cycle, the feeding and infection mechanics that let trophic roles and diseases emerge, the regulation that keeps the tank alive, William's god powers, and the metrics that tell the camera director and the stats view what is interesting.

It assumes the default architecture in BRIEF.md: a sim host that owns the world, WebGPU compute with a CPU or worker fallback, views that only render, and a seeded fixed-timestep sim. Where it needs something from another section (genome, body, physics, brain, rendering, director, audio, architecture) it names the interface it expects, so those sections can confirm or change it.

## 4.0 Units, clocks and the one rule

**Units.** Length in metres, time in sim seconds, mass in **mu** (mass units). 1 mu is the biomass of a reference creature 1 cm long; the body and physics sections own the exact mass-from-shape formula, and this section only needs mass in mu. All concentrations are per square metre of water area, because the world is 2D: `mu/m²`.

**Clocks.**

| Clock | Rate (sim) | What runs on it |
|---|---|---|
| Physics tick | 60 Hz | bodies, collisions, swimming (physics section) |
| Ecology tick | 10 Hz | feeding, metabolism, excretion, field reactions, transport, infections |
| Flow tick | 2 Hz | current field rebuild |
| Light and temperature tick | 2 Hz | light column scan, temperature profile |
| Metrics tick | every 60 sim s | diversity, trophic, budget metrics |
| Interest events | as they happen | director feed |

**Day and year.** Default sim day `D = 1200 s` (20 minutes at 1x speed), default year `Y = 20 days` (about 6.7 hours at 1x), so William sees roughly one full year per evening and three days per hour. Both are parameters; syncing day and night to William's real clock is open question 1.

**The one rule: mass is conserved.** Every gram of life is a gram of nutrient that came from somewhere and goes somewhere. There is one conserved currency, *nutrient mass*, held in a fixed set of pools:

```
M_total = N (dissolved) + P (phytoplankton) + B (benthic mats) + D (detritus, suspended)
        + Sed (sediment, incl. dormant cysts) + Σ creature body mass + Σ gut contents
        + Σ eggs + Σ carcass mass + Σ pathogen load (negligible) + R (geological reservoir)
```

Light and vent chemistry are *energy* and are not conserved; they decide where mass can be turned into producers. Because the total is fixed, carrying capacity falls out of the arithmetic: the tank cannot explode, only redistribute. God powers that add or remove mass do so explicitly through the reservoir (4.4) and are logged.

## 4.1 The finite habitat

### Size presets

The tank is a 2D side view: `x` horizontal, `y` depth (positive downwards), surface at `y = y_s` (normally 0). 16:9 to match screens.

| Preset | Size (m) | Coarse grid (0.25 m) | Fine grid | Agent cap `N_max` | Target hardware |
|---|---|---|---|---|---|
| Small | 32 x 18 | 128 x 72 | 512 x 288 (1/16 m) | 16,384 | weak laptop, CPU fallback, tuning runs |
| Default | 64 x 36 | 256 x 144 | 1024 x 576 (1/16 m) | 131,072 | RTX 5090 everyday |
| Large | 128 x 72 | 512 x 288 | 2048 x 1152 (1/16 m) | 262,144 | RTX 5090, experimental |

At the Default size the zoomed-out view is 64 m across; at 3840 px that is about 1.7 cm per pixel. A 3-orders-of-magnitude zoom takes the view down to 6.4 cm across, where a 2 mm microbe is about 120 px wide. The fine grid (6.25 cm cells) carries producers; beyond that zoom the renderer synthesises sub-cell detail from noise seeded by cell values, it never needs more simulation resolution.

### Shape and terrain

The default world generator ("Basin") makes a cross-section through an imaginary sea, chosen so depth and terrain create niches side by side:

```
x: 0 ............................................................ W
y=0  ~~~~~~~~~~~~~~~~~~~~ surface (light in, oxygen exchange, ice) ~~~~
     | shelf (6 to 9 m)  \                                          |
     | reef, kelp, caves  \  slope with caves                       |
     |                     \_____                                   |
     |                           \_____ abyssal plain (28 to 31 m)  |
     |                                 \_____________     __ vents  |
     |                                               \___/  trench  |
y=H  |___________________________________________ (34 to 36 m) _____|
```

- **Walls** at `x = 0` and `x = W` are irregular rock (noise-displaced), **floor** is a heightmap. The surface is open water at the top; nothing passes above it.
- **Shelf** (left 25 to 35 % of width): shallow, sunlit, warm in summer, where reefs and mats grow.
- **Slope**: steep, with **caves** (dark refuges). Refuges are not decoration: spatial heterogeneity and refuges are the classic way predator-prey systems avoid mutual extinction (Huffaker 1958).
- **Abyssal plain**: dark, cold, fed by falling detritus and carcasses ("marine snow" and "whale falls").
- **Trench with vents** (right 15 to 25 %): 1 to 3 hydrothermal vents, oases of heat and chemistry in the dark.

**Generation algorithm** (seeded, deterministic, under 50 ms on CPU for Default):

1. Floor profile `h(x)`: piecewise target depths (shelf, slope, plain, trench) blended with smoothstep, plus 1D fractal noise (4 octaves, amplitude 0.6 m).
2. Wall profiles: vertical lines displaced by 1D noise (amplitude 1.5 m).
3. Caves: 6 to 12 metaball blobs carved into the slope and walls, connected to open water by a tunnel of radius 0.6 to 1.2 m, with at least one cave of each size class (small refuges for small creatures only: entrance radius 0.15 m; large ones for medium creatures).
4. Overhangs and arches: 2D noise threshold near the slope.
5. Vents: placed on the trench floor, at least 4 m apart.
6. Reef seeds: rough rock patches on the shelf tagged as reef substrate.
7. Validation: flood fill from the surface; any water cell not connected to open water becomes rock (no sealed pockets). Check that every habitat class (shelf, cave, plain, vent) exists.

Other generators are cheap to add later ("Lagoon": no trench, warm and shallow; "Twin basins": a sill divides the tank for allopatric speciation).

### Representation

| Buffer | Grid | Format | Content |
|---|---|---|---|
| `terrainSDF` | coarse x2 (0.125 m) | r16f | signed distance to rock in m (negative inside rock) |
| `material` | coarse x2 | r8u | 0 water, 1 rock, 2 sand, 3 mud, 4 reef, 5 vent, 6 ice, 7 crater glass |
| `sediment` | per floor column at 0.25 m | r32f x2 | sediment mass `Sed`, dormant cysts |

The SDF feeds physics collision (physics section samples it with bilinear filtering and its gradient as the normal), the flow boundary (4.2) and the light scan. Terrain is mutable (meteor craters, new vents, reef growth, ice, barriers): edits are written into `material`, then the SDF is rebuilt with the jump flooding algorithm (Rong and Tan 2006), about 10 passes at 512 x 288, under 0.2 ms on a 5090 and about 3 ms on a laptop iGPU. Views receive a **terrain patch** message (bounding box plus new material bytes) and rebuild their own SDF for rendering.

### Reefs as biology

Reef material is *built by life*: when a creature with a calcifying-shell gene dies sessile (or every day while sessile), a fraction `κ_reef` of its shell mass is written into `material = reef` on the nearest substrate cell instead of into detritus (the mass moves into the sediment pool, so conservation holds). Reef erodes back to sediment at `1 %` per sim day without living builders. Reef cells are favoured substrate for mats and give a sensory cover bonus (creatures inside reef cells are 50 % harder to see), so successful builders create the habitat that shelters their neighbours. If the genome section does not include a shell gene, reefs fall back to generator-placed static reef.

### Water surface

`y_s` is a parameter, normally 0. The ice age power (4.8) lowers it by up to 3 m and turns the top cells into ice. Cells above `y_s` are treated as rock by physics (creatures cannot leave the water), so a falling sea level genuinely destroys shelf habitat and raises it again later.

## 4.2 Abiotic fields

All fields live on the coarse grid (0.25 m) unless stated. Field table for Default:

| Field | Format | Meaning | Sources | Sinks |
|---|---|---|---|---|
| `N` | r32f | dissolved nutrient, mu/m² | excretion, remineralisation, vents, sediment | producer uptake |
| `D` | r32f | suspended detritus | faeces, producer mortality, carcass leaching | remineralisation, sinking, filter feeders |
| `O2` | r16f | oxygen, 1.0 = saturation at 15 °C | photosynthesis, surface exchange | respiration, remineralisation |
| `S` | r16f | vent chemistry (reduced sulphur, energy only) | vents | chemo-mat uptake, decay |
| `Tanom` | r16f | temperature anomaly, °C | vents, events | relaxation |
| `turb` | r16f | turbidity (ash, dust, sediment plume), light attenuation only | meteors, vents, storms | settling |
| `light` | r16f | derived photosynthetic light, 0 to 1 | scan | none |
| `flow` | rg16f | water velocity (u, v), m/s | derived | none |
| `P`, `B_photo`, `B_chemo` | rgba16f on the fine grid | producers (4.3) | | |

Memory: coarse grid 36,864 cells x about 30 bytes = 1.1 MB; fine grid 590k cells x 8 bytes = 4.7 MB. Small enough to snapshot every few minutes.

### Light

Surface light follows a smooth day curve modulated by season:

```
θ(t)    = 2π · (t mod D) / D                       (0 = midnight)
e(t)    = −cos θ + δ_season(t)                      sun elevation proxy, δ in [−0.3, 0.3]
δ_season(t) = 0.3 · sin(2π t / Y)                   longer days in summer
a(t)    = smoothstep(−0.05, 0.35, e(t))             daylight factor, soft dawn and dusk
I_surf  = I_max · (1 + A_I · sin(2π t / Y)) · a(t) · M_light(t) + I_moon
```

`A_I = 0.35`, `I_moon = 0.01`, `M_light` is the light-change modifier from god powers. Below the surface, Beer-Lambert attenuation integrated down each column with a prefix scan (one workgroup per column, 144 cells, trivially cheap):

```
I(x, y) = I_surf · exp(−Σ_{y' < y} k(x, y') · Δy)
k = k_w + k_chl · (P + B_photo + shade) + k_turb · turb + k_ice · [ice] + ∞ · [rock]
```

Defaults `k_w = 0.2 /m` gives three zones in a 36 m tank: sunlit (above about 8 m, more than 20 % of surface light), twilight (8 to 23 m) and midnight (below 23 m, under 1 %). `k_chl = 1/500 per (mu/m²) per m`, so a dense bloom of 500 mu/m² doubles attenuation and shades out everything below it: blooms self-limit and starve the deep. `shade` is written by large photosynthetic or broad-bodied creatures (each adds its projected width to its column). Rock is opaque, so overhangs and caves are dark; to stop cave mouths going pitch black at the first cell, a 3-tap horizontal blur adds `0.3 x` the neighbouring columns' light (a cheap stand-in for scattering).

Creatures sense `light` for vision range and day/night (brain inputs). Bioluminescence is a visual and sensory signal only, it does not feed producers.

### Temperature

A baseline profile with a seasonal thermocline, plus a transported anomaly field:

```
T_s(t)     = T_mean + A_season · sin(2π t/Y − π/2) + A_day · sin(θ − π/2) + T_event(t)
y_th(t)    = y_th_summer + (y_th_winter − y_th_summer) · winterness(t)
T_base(y)  = T_deep + (T_s − T_deep) · σ((y_th − y) / w_th)
∂Tanom/∂t  = κ_T ∇²Tanom − u·∇Tanom − Tanom/τ_T + Σ_vents q_v · G(x − x_v)
T(x, y, t) = T_base(y) + Tanom(x, y, t)
```

Defaults: `T_mean = 14 °C`, `A_season = 5 °C`, `A_day = 0.5 °C`, `T_deep = 4 °C`, thermocline at 8 m in summer and 20 m in winter, `w_th = 2 m`, `κ_T = 0.01 m²/s`, `τ_T = 0.5 day`, vent output `q_v` keeps the water within 0.5 m of a vent at about 25 °C. A warm shelf (shallow and sunny) versus cold abyss emerges from depth alone; an optional `A_lateral` term makes one side of the tank warmer.

Temperature acts on life through two hooks the creature section consumes:
- Metabolic scaling `f_T = Q10^((T − 20)/10)`, `Q10 = 2`, applied to basal metabolism, digestion, producer growth and remineralisation.
- Thermal tolerance genes (optimum `T_opt`, breadth `σ_T`): performance `exp(−(T − T_opt)² / (2σ_T²))` multiplies muscle output; outside 2.5 σ the creature takes damage. A breadth cost (`+4 %` basal metabolism per °C of `σ_T` above 3 °C) stops everything becoming a generalist.

**Stratification and turnover.** `strat = clamp((T_s − T_deep) / 10, 0, 1)`. The vertical mixing coefficient used for tracer transport is `K_z = K_z0 + K_mix · (1 − strat)` above the winter mixed-layer depth. In winter the surface cools, stratification collapses, and deep nutrients mix up; when light returns in spring, plankton bloom on the stored nutrients and crash as they deplete them. That is the real mechanism of the spring bloom (Sverdrup's critical depth idea, 1953) and gives the tank an annual boom-bust heartbeat with no scripting.

### Oxygen

```
∂O2/∂t = p_O · (producer gross growth) − r_O · (creature respiration + remineralisation)
         + k_air · (O_sat(T) − O2) · [top cell] + transport
O_sat(T) = 1.0 · (1 − 0.02 · (T − 15))
```

Creatures have a hypoxia tolerance `O_crit` gene (cost: larger gills mean more drag, owned by the body section). Below `O_crit` muscle output and digestion fall linearly to zero at `O_crit / 2`, and damage accrues. Oxygen makes blooms dangerous: a bloom's crash feeds detritus, remineralisation consumes oxygen, and a dead zone forms under it, as in real eutrophied seas. Vents are naturally low-oxygen, so vent specialists must evolve tolerance. Cost is one r16f channel and a few lines of shader; it can be switched off (`O2 ≡ 1`) if it proves too harsh (open question 2).

### Currents: a cheap divergence-free flow field

A full Navier-Stokes solve (Stam 1999, stable fluids) at 256 x 144 is affordable on a 5090 but costs 20 to 40 Jacobi iterations per step, is hard to keep deterministic across drivers, and couples to every creature. Instead the default flow is built from a **streamfunction**, which is divergence-free by construction (Bridson et al. 2007, curl noise):

```
ψ(x, y, t) = Σ_m a_m(t) · Φ_m(x, y)            large-scale circulation modes
           + a_e · ψ_noise(x/λ_e, y/λ_e, ω_e t)  eddies (3D simplex noise, time as 3rd axis)
           + Σ_vents ψ_plume,v                   rising plume vortex pairs above vents
           + a_w · Φ_surface(y)                  wind-driven surface shear
ψ_b = ψ · ramp(sdf / d_0),  ramp(r) = 15/8 r − 10/8 r³ + 3/8 r⁵ for r < 1, else 1
u = ∂ψ_b/∂y,   v = −∂ψ_b/∂x                      central differences on the grid
```

Modes: `Φ_1 = sin(πx/W) sin(πy/H)` (one overturning cell), `Φ_2 = sin(2πx/W) sin(πy/H)` (two cells), `Φ_3 = sin(πx/W) sin(2πy/H)` (surface current with deep counter-current). Mode amplitudes `a_m(t)` follow seeded Ornstein-Uhlenbeck processes around seasonal means (time constant 3 days), so currents meander but never jump. The SDF ramp (`d_0 = 0.75 m`) drives the normal velocity to zero at rock, so water never flows into walls, and flow speeds up through cave mouths and over ridges for free. Typical speeds: 0.02 to 0.08 m/s in the interior, up to 0.25 m/s in surface currents and plumes.

Rebuilt at 2 Hz into the `flow` texture (one compute pass, under 0.05 ms on a 5090, about 0.5 ms on a laptop iGPU or 4 ms on the CPU fallback at 128 x 72); between rebuilds, consumers interpolate linearly between the last two fields.

Coupling is **one-way**: water moves creatures, plankton, detritus, spores and heat; creatures do not stir the water. Physics computes drag from velocity relative to the local water `v_body − u(x)`, so filter feeders can sit in a current and let food come to them, and drifting plankton blooms trace the eddies beautifully. An optional "High fluid" mode for the 5090 swaps in a stable-fluids solve with momentum injected by creatures over 1 m long; it is a visual luxury, not a design dependency.

### Tracer transport

`N`, `D`, `O2`, `S`, `Tanom`, `turb` and the producer field `P` are moved by a **conservative finite-volume** scheme: upwind fluxes with a minmod limiter, plus diffusion `K_h = 0.002 m²/s` horizontally and `K_z` vertically. Semi-Lagrangian advection (Stam's method) is cheaper but does not conserve mass, which would break the one rule. Courant number at the fine grid with `u_max = 0.25 m/s` and `dt = 0.1 s` is 0.4; if a god power pushes `u_max` higher, transport sub-steps automatically. Flux into rock is zero. Detritus and producers add a sinking velocity (`w_D = 8 m/day`, `w_P = 0.5 m/day`); detritus that reaches the floor enters the sediment pool.

### Day and night, seasons: summary of what they drive

| Driver | Day/night | Seasons |
|---|---|---|
| Light | full cycle, moonlight floor | +-35 % intensity, day length 35 to 65 % |
| Temperature | +-0.5 °C at surface | +-5 °C, thermocline 8 m to 20 m |
| Mixing | none | winter turnover brings deep nutrients up |
| Currents | none | mode means shift (summer surface current, winter overturning) |
| Expected emergent behaviour | diel vertical migration of grazers and predators that sense light | spring bloom, summer stratified oligotrophy, autumn secondary bloom, winter die-back |

Diel vertical migration (small grazers rising to feed at night, hiding deep by day) is the largest synchronised animal movement on Earth; it is a target emergent behaviour and has a dedicated long test (4.14).

## 4.3 Primary producers

Producers come in three forms, chosen for cost and for what each needs to do ecologically.

### 4.3.1 Phytoplankton field `P` (drifting)

A reaction-transport field on the fine grid, in the style of NPZD plankton models (Franks 2002):

```
μ_P   = μ_max · f_L · f_N · f_T
f_L   = (I/I_k) · exp(1 − I/I_k)          Steele curve: saturates, then photoinhibits at the brightest surface
f_N   = N / (N + K_N)                     Monod
growth  = μ_P · P                          (taken from N in the same cell, capped by available N)
loss    = m_P · P + m_P2 · P²              linear mortality plus quadratic closure (viral lysis, crowding)
∂P/∂t = growth − loss − grazing + transport − w_P ∂P/∂y
```

Mortality goes to `D`. The quadratic closure term is standard in plankton models and damps unrealistic oscillations without capping blooms. Defaults: `μ_max = 1.5 /day` (a doubling in about 11 real minutes at 1x), `I_k = 0.3`, `K_N = 50 mu/m²`, `m_P = 0.05 /day`, `m_P2 = 2e-4 per (mu/m²) per day`.

**Seed bank.** Phytoplankton that sinks to the floor becomes dormant cysts in the sediment (conserved mass). Cysts resuspend when currents over the floor exceed 0.05 m/s or during turnover, and germinate when `light > 0.05` and `N > K_N`. Real plankton survive winters and disasters this way, and it means the producer base can always recover without any reseeding hack.

Rendering: the views receive a quantised copy of `P` and draw it as glowing haze plus particles sampled from the density (rendering section). Individual plankton are never agents.

### 4.3.2 Benthic mats `B_photo` and `B_chemo` (attached): Lenia-like fields

Mats (algal turf, seagrass, bacterial carpets at vents) grow only on a substrate mask `M_sub = smoothstep(0.4, 0.1, sdf)` (within about 0.4 m of rock, sand or reef). To make them grow as patches, spots and stripes, rather than as a uniform green film, their growth uses a **Lenia-style** neighbourhood kernel (Chan 2019), made mass-conserving:

```
U      = K_ring * B                     ring kernel, radius R_B fine cells, Σ K = 1
G(U)   = 2 · exp(−(U − m_B)² / (2 s_B²)) − 1        Lenia growth mapping, range [−1, 1]
grow   = μ_B · f_E · f_N · f_T · max(G, 0) · (B + ε_seed) · (1 − B / B_max)     taken from N
decay  = d_B · max(−G, 0) · B                                                    released to D
B_new  = B + dt · (grow − decay − grazing)
```

`f_E = f_L(I)` for `B_photo`, and `f_E = S / (S + K_S)` for `B_chemo` (chemosynthesis from vent chemistry, so vents become glowing oases in the dark). Defaults: `R_B = 8` fine cells (0.5 m), `m_B = 0.3`, `s_B = 0.06`, `μ_B = 0.6 /day`, `d_B = 0.5 /day`, `B_max = 400 mu/m²`, `ε_seed = 0.5 mu/m²` (only where cysts or a neighbour exist).

Why Lenia-like rather than plain Gray-Scott (Pearson 1993)? Both give Turing-style patches, but the ring kernel sets patch size directly through `R_B`, independent of diffusion constants, and is stable at the 10 Hz ecology tick, where Gray-Scott needs small explicit steps. Patches matter ecologically: grazers have to search, and patch edges are where predators ambush.

Why not full Lenia for the plankton, or Lenia "creatures" in the tank? Classic Lenia does not conserve mass and its self-organising gliders would compete visually and conceptually with the real evolving creatures. Flow-Lenia (Plantec et al. 2023) does conserve mass and is a tempting "living reef" option for the 5090, at about 3x the cost; listed as a later experiment, not the default. The chosen parameters keep mats in the static-patch regime, away from glider regimes; a test (4.14) checks that.

Cost: direct convolution with 17 x 17 taps (circular mask, about 200 effective taps) on 590k cells is 120 M taps per step. Mats update at 2 Hz (they are slow), so about 0.25 G taps/s: under 0.1 ms per step on a 5090. Laptop preset: 512 x 288, `R_B = 4`, 1 Hz.

### 4.3.3 Plants as creatures (macrophytes)

Kelp, sea fans and anything big and plant-like is **a creature** whose genome expresses photosynthetic tissue and sessile behaviour, not a separate system. This lets plants evolve, be eaten, get diseases, build reefs and compete for light by growing tall. The ecosystem provides the hooks:

- Photosynthesis gain per ecology tick: `η_ph · A_photo · I(x, y) · f_N(N_local) · f_T`, where `A_photo` is the photosynthetic surface area from the body section. The nutrient is drawn from `N` under the creature via the same demand and resolve mechanism as feeding (4.5), so plants and plankton compete for the same nutrient.
- Shading: each photosynthetic creature adds its projected width to the `shade` term in its column.
- Root uptake: sessile creatures attached to substrate may also draw from `Sed` at 20 % of their `N` rate (gene-gated).

The founder assemblage (4.7) always includes 1 to 3 such plant lineages. If the genome section cannot support photosynthesis in time, the fallback is mats only.

## 4.4 Nutrient cycling

### Flows

```
             light / vent chemistry (energy)
                     │
   N (dissolved) ───► P, B_photo, B_chemo, plant creatures
     ▲                     │ grazing, filtering, scraping
     │ excretion           ▼
     │ (metabolism) ◄── consumers ──► predators, parasites ──► ...
     │                     │ faeces (1 − assimilation) ─────► D
     │                     │ death ───► carcass entity ──► scavengers
     │                     │                 │ leaching
     │ remineralisation    ▼                 ▼
     └────────────── D (suspended) ──sinking──► Sed (floor) ──regeneration──► N
                                                   │ burial (slow)
                                              R (geological reservoir) ──► vents ──► N, S
```

### Creature mass accounting

This is the contract with the creature and metabolism sections:

- **Intake**: food mass `F` enters the gut. Assimilation `a_k(e)` (4.5) moves `a_k · F` into body mass; `(1 − a_k) · F` leaves as faeces into `D` at the creature's position.
- **Metabolism**: basal `b_0 · M^0.75 · f_T` (Kleiber scaling, as in the metabolic theory of ecology, Brown et al. 2004) plus activity costs from muscle work, sensing and brain size. Metabolised mass is **excreted as dissolved `N`** at the creature's position and consumes `O2`. A creature that cannot cover its metabolism shrinks, then starves.
- **Reproduction**: offspring and eggs are mass taken from the parent. Eggs are entities with mass; unhatched eggs that die become detritus.
- **Death**: the body becomes a **carcass** entity (position, mass, original species, trophic level, infection state). Carcasses sink as physics bodies (negative buoyancy), can be bitten by anything with a flesh-capable mouth, and leach `D` and `N` at `ln 2 / t_half` per second, `t_half = 1.5 days · Q10^((20 − T)/10)`. Cold slows decay, so a big carcass on the cold abyssal plain lasts for days and becomes a scavenger oasis: an emergent whale fall.

### Remineralisation, sediment and the reservoir

```
∂D/∂t   ⊃ −r_D · f_T · D                  → N, consumes O2 (r_O per unit)
∂Sed/∂t  = sinking flux − r_sed · f_T · Sed − β · Sed + resuspension
vents    : N and S emitted from R at rate q_N per vent
```

Defaults: `r_D = 0.15 /day` at 20 °C, `r_sed = 0.02 /day`, burial `β = 0.001 /day`. The reservoir `R` closes the loop on a geological timescale: burial moves mass into `R`, vents return it. Total mass stays exactly `M_total`.

**God-added mass relaxes.** A nutrient flood or meteor adds `ΔM` to the world; the target `M_target` does not change, so while `M_total > M_target` the burial rate gains an extra term that removes the excess with a half-life of 2 sim years (40 days). Cull without carcasses removes mass the same way in reverse (vents run slightly faster until restored). The tank therefore always drifts back to its tuned richness, while short-term floods and famines play out fully.

### Field-to-creature exchange: deterministic and conserving

Thousands of creatures eat from and deposit into the same cells in parallel. Float atomics on the GPU are order-dependent and break determinism, so all exchange uses **fixed-point integer atomics** (u32, 1 unit = 1e-4 mu, saturating with an overflow flag) in three passes per ecology tick:

1. **Demand**: each feeding creature computes what it wants from each cell its mouth covers and `atomicAdd`s it into `demand[cell][foodType]`.
2. **Resolve**: per cell, `ρ = min(1, available / demand)`; subtract `ρ · demand` from the field.
3. **Collect**: each creature receives `ρ · its own demand`. Integer sums are order-independent, so this is deterministic and never drives a field negative.

Deposits (faeces, excretion, leaching, shed spores' loads) use the same fixed-point `deposit` buffers, merged into the float fields once per tick.

**Mass audit.** Every 100 ecology ticks a reduction sums every pool (pairwise reduction on GPU, final sum in f64 on the host). Float rounding drift above `1e-6 · M_total` is corrected by adjusting `N` proportionally; drift above `1e-3` is a bug and raises a diagnostic (and fails tests).

## 4.5 Feeding mechanics and emergent trophic roles

Nothing in the sim is labelled herbivore or predator. The ecosystem defines **what food exists and what each mouth, gut and behaviour can physically do with it**; roles are a statistic computed afterwards.

### Food sources

| Source | Where | Food class |
|---|---|---|
| Phytoplankton `P` | water column field | plant |
| Mats `B_photo`, `B_chemo` | surfaces | plant |
| Plant creatures | agents | plant |
| Suspended detritus `D`, sediment `Sed` | field, floor | detritus |
| Carcasses | entities | flesh |
| Live creatures (prey) | agents | flesh |
| Hosts (attached) | agents | flesh |

### Mouth actions (interface to body and brain sections)

The body section produces, from the genome, a `MouthDescriptor` with continuous weights; the brain emits action outputs. The ecosystem resolves them:

```ts
interface MouthDescriptor {
  filter: number;     // 0..1 filter mesh development (gill rakers, baleen-like)
  scrape: number;     // 0..1 rasping surface
  bite: number;       // 0..1 jaw development
  suction: number;    // 0..1 suction-feeding capacity
  latch: number;      // 0..1 attachment organ (sucker, hooks)
  gape: number;       // m, mouth opening width
  biteForce: number;  // N-equivalent, from jaw muscle mass
  mesh: number;       // m, smallest particle retained (finer is costlier: more drag)
}
interface GutDescriptor {
  volume: number;       // mu capacity
  enzymes: [number, number, number]; // plant, flesh, detritus; sum = 1
  transitRate: number;  // fraction of gut processed per second
}
```

| Action | Brain output | Intake per ecology tick |
|---|---|---|
| Filter | passive while `filter > 0`, mouth open output | `filter · gape · |v_rel| · dt · (P + D)` from cells along the mouth (swept volume times concentration) |
| Scrape | eat output while touching substrate | `scrape · gape · r_s · B` from cells under the mouth |
| Bite | eat output while touching a creature, plant or carcass | chunk `min(bite · gape² · ρ_bite, target mass)`, with a cooldown of `0.3 s / biteForce^0.5`; on a live target, damage `biteForce − armour` |
| Suction | eat output, target smaller than `0.5 · gape` | swallow whole with probability `suction · (1 − preyLength / (0.5 · gape))`, reduced by the prey's escape impulse that tick |
| Latch | attach output while touching a host | joint to host; drain `latch · r_drain · host_mass^0.67` per second, host gets damage at `0.5 x` drain |

Intake fills the gut (capped by `volume`); digestion moves `transitRate · gut` per second through assimilation. Gut maintenance costs `c_gut · volume` metabolism, filter mesh adds drag (physics), jaws and suckers cost body mass. These costs are the trade-offs that make specialisation pay.

**Assimilation and the specialisation trade-off.**

```
a_k = a_max_k · e_k^θ        k ∈ {plant, flesh, detritus},  Σ e_k = 1
a_max = (plant 0.45, flesh 0.80, detritus 0.30)
```

`θ > 1` makes generalists worse than the sum of specialists; `θ = 1.3` by default. This one number strongly shapes role diversity, so it is in the tuning set. The ordering of `a_max` follows real ecology (plant matter is hard to digest, meat is easy).

**Latch and the emergence of parasites.** A latched creature moves with its host (a physics joint), drains slowly and ideally does not kill: a dead host stops feeding it. Hosts can evolve grooming (a brain output: shake, scrape against rock) that breaks the joint with probability `groomStrength / (latchStrength + groomStrength)`. Tierra famously evolved parasites spontaneously (Ray 1991); here the latch action makes macro-parasites (lamprey or leech-like) reachable by mutation from small biters.

### Role inference (stats, director, never used by the sim)

Each creature keeps an exponentially weighted diet vector over the last `τ_diet = 1 day` of intake mass, over seven sources: `phyto, mat, plantCreature, detritus, carcass, livePrey, host`. Labels:

| Role | Rule |
|---|---|
| Producer | photosynthesis or chemosynthesis provides more than 50 % of mass gain |
| Filter feeder | `phyto + suspended detritus` via the filter action more than 60 % |
| Grazer (herbivore) | `mat + plantCreature + phyto (non-filter)` more than 60 % |
| Predator | `livePrey` more than 50 % |
| Scavenger | `carcass + detritus (floor)` more than 50 % |
| Parasite | `host` more than 50 % |
| Omnivore | none of the above |

**Trophic level**, the standard diet-weighted definition (Levine 1980): `TL = 1` for producers and detritus, and for a consumer `TL = 1 + Σ_k w_k · TL_k` where `w_k` are intake mass fractions and `TL_k` is the trophic level of what was eaten (prey and hosts carry their own TL, carcasses keep the TL the creature had at death). Computed as an EMA per creature, aggregated per species. The **food web** is a sparse matrix `W[eater species][food species]` of mass eaten in the last 5 days, built from collect-pass events.

**Designing for giants.** Energy transfer between levels is about 10 % (Lindeman), so a top predator at TL 4 can have about 0.1 % of producer biomass. The biggest animals on Earth are filter feeders at TL 2 to 3 for exactly this reason. The tank's surface plankton and filter mechanics deliberately make giant filter feeders feasible, and `M_total` must be large enough that at least 5 to 10 individuals of the largest plausible size can coexist (a minimum viable population). This is a tuning constraint (4.11).

## 4.6 Diseases and parasites as coevolving entities

Macro-parasites are creatures (4.5). **Micro-parasites** (pathogens) are lightweight entities with their own small genome, so they can be numerous, cheap and fast-evolving.

### Data structures

```ts
// Strain table: GPU buffer, max 4096 rows, garbage-collected
struct Strain {
  id: u32; parent: u32; bornTick: u32;
  antigen: u32;      // 32-bit key the host immune system may recognise
  adhesin: u32;      // 32-bit key that must bind the host's surface signature
  beta: f32;         // transmissibility per unit dose
  virulence: f32;    // host mass drain per day per unit load, 0..v_max
  growth: f32;       // within-host replication rate /day
  envHalfLife: f32;  // survival outside a host, s
  routes: u32;       // bitmask: contact, waterborne, trophic, vertical (to offspring)
  hostCount: u32; sporeLoad: f32;  // maintained by reductions
}
// Per creature (2 infection slots)
struct Infection { strain: u32; load: f16; age: f16; }
// Host genes (requested from the genome section)
immuneKey: u32       // recognition key
immuneInvest: f32    // ι in [0, 1], costs metabolism
surfaceSig: u32      // surface signature, low per-bit mutation (0.002 per birth); diverges with lineages
memory: u32          // last cleared antigen (acquired immunity, not inherited)
```

Waterborne transmission uses **spore particles** (max 65,536): position, strain id, load. They drift with the flow, decay with the strain's `envHalfLife`, and are found by creatures through the physics spatial hash. When the buffer is full, the lowest-load spores of the most common strain are merged.

### Infection, within-host dynamics, transmission

```
sim(a, b)  = 1 − popcount(a XOR b) / 32
bind       = σ(20 · (sim(adhesin, surfaceSig) − 0.75))             can it enter this host at all
recog      = σ(20 · (max(sim(immuneKey, antigen), sim(memory, antigen)) − 0.70))
p_infect   = 1 − exp(−β · dose · bind · (1 − ι · recog))
dL/dt      = growth · L · (1 − L) − c_clear · ι · recog · L          load L in [0, 1]
drain      = virulence · L · M_host  per day  (mass to N and D, so conservation holds)
hazard     = h_v · virulence · L     extra death hazard per day
shedding   = σ_0 · virulence^z · L,  z = 0.5                         the virulence-transmission trade-off
```

- **Exposure**: contact (collisions, mating, biting: dose proportional to the partner's load), waterborne (touching spores: dose = spore load), trophic (eating infected flesh or carcasses: dose proportional to bite mass times load), vertical (offspring of an infected parent with probability `0.3 · L`).
- **Recovery**: when `L < 0.01` the infection clears and `memory = antigen`.
- **Immune cost**: basal metabolism times `(1 + c_ι · ι)`, `c_ι = 0.15`. Resistance is never free, so it is only selected while disease is around; when a pathogen disappears, hosts drift back to low investment and become vulnerable again.

### Why this produces arms races

- **Matching-alleles specificity** (Agrawal and Lively 2002): a host resists pathogens whose antigen its immune key resembles. Common host keys select for pathogen antigens that escape them, and the commonest pathogen antigen selects for host keys that match it. Negative frequency dependence on both sides gives Red Queen cycles rather than a single winner.
- **Host range by adhesin versus surface signature**: pathogens specialise to lineages; as species diverge, their signatures drift apart and their shared pathogens split too. A pathogen can jump to a related species whose signature is still close: spillover and emerging diseases, for free.
- **Virulence evolves to an intermediate optimum** because shedding grows sublinearly with virulence while killing the host ends transmission (the trade-off hypothesis, Anderson and May 1982; reviewed by Alizon et al. 2009). Dense populations favour higher virulence, sparse ones milder strains.
- **Disease is density-dependent**, so it naturally hits whichever species becomes too common: "kill the winner", one of the strongest diversity-maintaining forces in the design.

**Mutation**: at each transmission, with probability `μ_s = 0.02`, the new infection gets a child strain: 1 or 2 random bit flips in the antigen (80 %) or adhesin (20 %), and `beta`, `virulence`, `growth` multiplied by `exp(N(0, 0.1))`, clamped (`virulence ≤ v_max = 2 /day`). Strains with no hosts and no spores are freed. A strain phylogeny (parent pointers plus birth tick) is stored for the stats view.

**Reservoir strains.** A pathogen-free tank is less interesting, so dormant strains persist in the sediment (a list of 32 archived strains). With probability `1e-3` per sim day per floor cell disturbed by a meteor, vent or burrowing creature, one re-emerges as spores. This keeps disease endemic without scripting outbreaks.

**Measuring the arms race** (stats and tests): every 5 sim days, archive 64 random hosts' immune keys and the top 16 strains. The *time-shift test* (Gandon et al. 2008) computes mean infectivity of strains from time `t` against hosts from `t − Δ`, `t`, `t + Δ`. Pathogens doing best against past hosts and worse against future ones is the signature of ongoing coevolution.

**Visuals**: infected creatures pulse slightly off-rhythm with a desaturated glow (rendering section); spores are faint motes, visible only at close zoom.

## 4.7 Population regulation and safety valves

The tank must neither explode nor die. Regulation comes in layers, from natural to engineered, and the goal of tuning is that the engineered layers almost never act.

1. **Finite nutrients** (4.0, 4.4). Hard ceiling on total living mass.
2. **Light and stratification.** Producers are limited by light at depth, self-shading and seasonal nutrient supply.
3. **Metabolic costs.** Kleiber scaling, temperature, activity, brain cost, immune cost.
4. **Predation, disease and refuges.** Density-dependent mortality; caves and reefs prevent predators from eating prey to zero. Enrichment destabilises predator-prey cycles (Rosenzweig 1971, the paradox of enrichment), which is why `M_total` is tuned rather than maximised, and why the quadratic plankton mortality and refuges are in the design.
5. **Agent cap soft limit.** As the agent count `n` approaches `N_max`, offspring cost more: `cost_birth · (1 + k_cap · (n / N_max)^8)`, `k_cap = 2`. Below 80 % of the cap it is under 35 % extra; at 95 % it is 2.3x. Small creatures hit this first, which also counters the size-spectrum problem (millions of 2 mm creatures would fit the mass budget but not the GPU). The fraction of time the cap tax exceeds 10 % is logged and penalised in tuning. The super-individual technique (one agent stands for a swarm of identical tiny animals; Scheffer et al. 1995) is a possible extension for microbe-scale swarms, open question 3.
6. **Safety valves** (engineered, logged, optional announcement):
   - **Producer collapse**: no valve needed; cysts in the sediment always regrow plankton and mats (4.3.1).
   - **Total consumer extinction**: when the count of non-producer agents and eggs is zero for a grace period `G = 0.5 sim day`, reseed a founder assemblage from the gene bank.
   - **Diversity collapse**: when fewer than 2 consumer species with at least 10 individuals exist for 10 sim days, enable **immigration**: one founder group (10 to 30 individuals) from the gene bank arrives every 2 sim days until diversity recovers. Default on.
   - **Background immigration** (island biogeography style): a founder group of an archived species arrives with probability `p_imm = 0.05` per sim day. Default on, can be set to 0 for a "sealed tank".
   - **Numerical watchdog**: NaN or Inf anywhere, or a mass audit failure above `1e-3`, restores the last good snapshot and logs a bug report with seed and tick.

### Gene bank

```ts
interface GeneBankEntry {
  genomeId: string; genome: Uint8Array;     // ~4 KB
  origin: 'designer' | 'founder' | 'hallOfFame' | 'immigrant';
  speciesName: string; archivedTick: number; peakCount: number;
  role: Role; meanTL: number; meanMass: number;
  niche: { depthMean: number; depthSd: number; tempMean: number; lightMean: number };
  favourite: boolean;                       // set by William in the god window
}
```

Every species that reaches 50 individuals is archived at its peak (hall of fame), plus all of William's designs and the default founders. Cap 10,000 entries (about 40 MB), evicting the oldest non-favourite hall-of-fame entries. Saved with the world snapshot.

**Founder assemblage selection** for reseeds: a trophic recipe (1 to 2 plant lineages if absent, 2 to 3 grazers or filter feeders, 1 to 2 small predators, 1 scavenger, 0 to 1 large predator), each slot filled by weighted sampling over entries with that role: weight = `2 if favourite` x `recency` x `niche fit` (how well the current environment matches the archived niche). Each founder species spawns 50 to 200 individuals (by mass budget) in the zone matching its niche, using mass taken from `N` (conservation holds).

**Announcements.** In the god window a reseed or immigration appears as a log line and timeline marker ("The tank was reseeded: 6 founder species from the gene bank"). In the wallpaper, screensaver and TV, an optional slow drift of glowing spores from the surface marks the arrival, never text, and only if "show arrivals" is on (open question 4).

## 4.8 God powers

### Event model

Every god power is a `GodEvent` sent from the god window to the sim host, which validates it, schedules it, logs it and broadcasts it. Views never simulate events; they render the event's visuals and the resulting state.

```ts
interface GodEvent {
  id: string; kind: GodKind; seed: number;
  issuedAtTick: number; startTick: number;     // start = now + lead (1 s wall, scaled by sim speed)
  origin?: { x: number; y: number }; radius?: number; region?: Polygon;
  targetSpecies?: number[]; magnitude: number;  // 0..1 slider, mapped per kind
  params: Record<string, number | string>;
  envelope: { attack: number; sustain: number; release: number };   // sim seconds
  source: 'william' | 'nature';
}
```

- **Modifier stack**: most events are envelopes on parameters (surface temperature, light multiplier, mutation multiplier, flow mode amplitudes) or source terms in fields. Temperature modifiers add, rate modifiers multiply, everything clamps to physical limits. Active modifiers are saved in snapshots, so a cold snap survives a reboot.
- **Lead time** of 1 s wall lets every view pre-roll its visual (a meteor streak appears before impact) and lets the director cut to the location.
- **Undo**: the host takes an automatic snapshot just before any event with `magnitude > 0.3`; the god window offers "rewind to before this event" for the last 10.
- **Propagation channels**: (a) `event` message on the WebSocket, immediately, to all views; (b) the normal state stream carries the consequences (fields, terrain patches, creatures, environment uniforms); (c) an `InterestEvent` (4.9) to the director and stats; (d) a mood impulse to audio ("darker after disasters").
- **Per-view behaviour**: wallpaper shows only in-world visuals with gentle mode (all fades at least 2 s, peak brightness capped, never more than 3 flashes per second, following WCAG 2.3.1); screensaver and TV show the same with full intensity, the director gives disasters the top interest score, TV may show a one-line caption; the god window shows a timeline marker, a live effect panel and before/after metrics.
- **Nature mode** (optional, default on at a low rate): the host itself issues mild events (cold snap, current shift, small bloom, storm) as a Poisson process at 1 per 10 sim days, so the tank keeps its drama while William is away. `source = 'nature'` events are never larger than magnitude 0.4.

### Powers

Durations are in sim time at default `D = 1200 s`. "Days" means sim days.

| Power | Effect | Duration | Propagation (beyond the common channels) |
|---|---|---|---|
| **Volcanic vent** | New vent at a floor point: rock mound (radius 1 to 3 m) added to terrain; `Tanom` source +20 °C; `N` and `S` from the reservoir; a plume vortex pair in the flow; ash `turb` column for the eruption phase; creatures within 0.5 m killed (carcasses scorched: 50 % mass to `D` immediately). | Eruption 0.5 day; the vent persists with output halving every 20 days (or permanent, option). | Terrain patch; flow modes; glowing vent becomes a permanent rendered feature. |
| **Algae bloom** | In a region (or tank-wide): `μ_max` x3 for producers, plus 20 % of local `N` converted to `P` instantly. Variant "toxic bloom": grazers eating bloom `P` take damage `0.5 x` intake. Expected aftermath: shading, crash, oxygen dead zone. | Boost 2 days, release 1 day; consequences for about 10 days. | Producer field stream shows the bloom; audio brightens then darkens. |
| **Plague** | New strain with `adhesin = surfaceSig` of the chosen species (or random), magnitude sets `beta` and `virulence` (mild, moderate, deadly), infects `k = 5 to 50` individuals near the cursor. The strain then evolves like any other. | Emergent (days to tens of days). | Infection flags in creature stream; prevalence chart in god window. |
| **Cold snap / heatwave** | `T_event` from −10 to +10 °C at the surface, propagating down through the thermocline profile; also shifts stratification (heatwave strengthens it and starves the surface of nutrients; cold snap triggers turnover). | Attack 0.5 day, sustain 1 to 5 days, release 2 days. | Environment uniforms; views tint water colour subtly. |
| **Meteor** | Impact point at surface or floor: radial shockwave impulse (physics) with kill radius `r_k` and stun radius `3 r_k`; crater (terrain, material "crater glass"); dust `turb` over the tank (light x0.3 at peak); nutrient input `ΔM` (iron and dust fertilisation); temperature −2 to −6 °C for large impacts (impact winter); sediment resuspension wakes reservoir pathogens. Sizes: pebble (`r_k` 0.5 m, dust 1 day), boulder (2 m, 5 days), extinction-level (6 m, dust 30 days, −6 °C, confirmation required). | Instant impact; dust and cooling 1 to 30 days. | Terrain patch, turb field, shockwave event with origin for views' visual ring; director gets maximum interest. |
| **Current shift** | Changes mode amplitudes and directions, eddy strength `a_e` and surface current `a_w`; optional "reverse the gyre". Moves plankton, larvae and spores to new places, so colonisation patterns change. | Transition 0.5 day; holds 5 days, then returns to the natural OU drift (or "permanent"). | Flow uniforms only (views rebuild flow locally for particle visuals from the same parameters and seed, so this costs almost no bandwidth). |
| **Light change** | `M_light` from 0.1 (eclipse, long night) to 2.0 (blazing summer), or lock the day phase ("eternal day", "eternal night"). | Minutes (eclipse) to 30 days. | Environment uniforms. |
| **Nutrient flood** | Adds `ΔM` (5 to 50 % of `M_target`) as `N` along a chosen edge (surface "river mouth" or a wall), relaxed later by burial (4.4). Expected: bloom, then crash, dead zone, then scavenger and detritivore boom. | Pulse 0.5 day; excess relaxes with 40-day half-life. | Fields stream. |
| **Introduce species** | Spawns `n` individuals of a designer genome or gene bank entry at a point, mass taken from `N` (or from the reservoir if `N` is short). | Instant. | Creature stream; a gentle "descending bubble" visual. |
| **Cull** | Removes a fraction `f` (10 to 100 %) of creatures selected by brush region, species, role or trait filter (for example "mass > 5 kg", "infected"). Option "leave carcasses" (default, feeds scavengers) or "vanish" (mass to reservoir). | Instant. | Creature stream; carcass entities. |
| **Ice age** | Long cold: `T_event` −8 °C, sea level `y_s` falls 1 to 3 m (shelf habitat shrinks, terrain cells above `y_s` become ice), surface ice layer (`k_ice = 1.2 /m`, 70 % light loss), weak surface exchange (oxygen falls). Reverses on release: sea level rises and the shelf is recolonised. | Attack 5 days, sustain 10 to 40 days, release 10 days. Confirmation required. | Terrain patches (ice), uniforms. |
| **Mutation storm** | Multiplies the expressed mutation-rate genes by 2 to 20 (globally or in a region) for births during the storm; also pathogen `μ_s`. Expect a burst of novelty and speciation, plus many unfit offspring. | 1 to 5 days. | Uniforms; aurora-like shimmer visual in views. |
| **Predator flood** | Spawns `n` predators (top predator species from the gene bank, or a chosen design) across a zone. | Instant spawn; consequences days. | Creature stream. |
| **Storm** | Strong surface current and mixing pulse: `K_z` x10 in the top 10 m, resuspension on the shelf, mixes nutrients up and plankton down. | 0.5 to 2 days. | Uniforms, flow. |
| **Whale fall** | Drops a carcass of chosen mass (or a real dead giant from the gene bank's phenotype) at a point; it sinks to the floor. | Instant; lasts days. | Carcass entity. |
| **Rift barrier** | Raises a rock wall (full height or a sill) across the tank, splitting populations for allopatric speciation; can be lowered later to watch reunited lineages compete. | Until removed. | Terrain patches. |
| **Dead zone** | Sets `O2` to 0.1 in a region and suppresses re-oxygenation there. | 1 to 10 days. | Fields. |
| **Earthquake** | Shakes terrain: opens or collapses 1 to 3 caves, triggers a sediment slide (nutrient pulse, `turb`), stuns creatures near the floor. | Instant; sediment cloud 1 to 3 days. | Terrain patches, fields. |
| **Seasons control** | Pause seasons, jump to a season, or change `Y`. | Until changed. | Uniforms. |

All powers are reproducible: the event (including its seed) is in the event log, so replaying the log from a snapshot gives the same world.

## 4.9 Metrics for interesting states

Two products: a **live interest feed** for the camera director and audio, and **ecosystem metrics** for the stats view and auto-tuning. Both are computed by the sim host from GPU reductions and event buffers.

### Interest events (director feed)

```ts
interface InterestEvent {
  kind: InterestKind; tick: number; x: number; y: number; radius: number;
  score: number;          // 0..1 after rarity scaling
  ttl: number;            // sim seconds the moment stays relevant
  subjects: number[];     // creature or entity ids, so the director can track them
  species?: number; caption?: string;  // caption for TV and god window
}
```

| Kind | Detector | Base score |
|---|---|---|
| Hunt | predator's sensed target id stable for 2 s, closing speed > 0, target fleeing | 0.4 |
| Kill | bite event that killed a live creature | 0.6 |
| Birth | birth of an individual in the top 1 % of mass, or first births of a new species | 0.4 |
| New species | speciation event from the species registry (genome section) | 0.8 |
| New role | first species ever (or for 50 days) to occupy a role or a TL above the previous maximum | 0.9 |
| Extinction | species with peak count at least 50 drops to 0 | 0.7 |
| Mass mortality | deaths in a coarse 4 x 4 m tile over 60 s exceed baseline with Poisson z > 4 | 0.8 |
| Swarm | spatial hash cell counts: more than 30 individuals of one species within 1 m | 0.5 |
| Giant | creature above the 99.5th mass percentile; new all-time mass record | 0.6, +0.3 for a record |
| Disaster | any god or nature event above magnitude 0.3 | 1.0 |
| Feeding frenzy | at least 8 creatures biting one carcass | 0.7 |
| Epidemic front | infected fraction of a species doubles in 1 day | 0.6 |
| Migration | dusk or dawn vertical movement of more than 20 % of a species' biomass | 0.4 |
| Bloom front | `P` gradient front moving across the shelf | 0.3 |

Score = `base · rarity · scale`, where `rarity = clamp(1 + 0.5 · log2(t_since_last_same_kind / τ_kind), 0.5, 2)` (stops the director showing 50 hunts in a row) and `scale` lightly favours larger subjects at wide zoom. Budget: at most 20 interest events per wall second are sent; the host keeps the top ones by score.

### Ecosystem metrics (every 60 sim s)

- **Diversity**: species richness `S` (species with at least 5 individuals); Hill numbers `qD` for `q = 0, 1, 2` by abundance and by biomass (Hill 1973; Jost 2006): `0D = S`, `1D = exp(H)` with Shannon `H = −Σ p_i ln p_i`, `2D = 1 / Σ p_i²` (inverse Simpson); evenness `J = H / ln S`.
- **Phylogenetic and morphological diversity**: Faith's phylogenetic diversity (sum of branch lengths of the living species' tree, from the genome section's species tree); mean pairwise genetic distance; morphospace spread (mean distance between species centroids in a fixed trait embedding: mass, aspect ratio, fin area, mouth weights, eye count).
- **Trophic structure**: biomass by TL bin (1, 2, 3, 4, 5+), the biomass pyramid; maximum TL among species with at least 10 individuals; mean food-chain length; roles occupied (of 7); food-web connectance `L / S²` from `W`; producer to consumer biomass ratio.
- **Turnover**: speciation and extinction counts per sim day, per-species rates `λ`, `μ`, net diversification `λ − μ`, mean species age.
- **Boom and bust**: per species, log-abundance series in a 256-sample ring buffer; coefficient of variation over 20 days; peak detection by rolling z-score; cycle detection by the autocorrelation peak (or a 256-point FFT periodogram), reporting period and strength; predator-prey phase lag from cross-correlation between a predator species and its main prey (from `W`).
- **Size spectrum**: histogram of log2 body mass; slope of log biomass per log-mass bin (marine systems are close to flat, Sheldon et al. 1972); maximum mass.
- **Disease**: prevalence per species, number of strains, estimated `R` (new infections per infected per infectious period), dominant-strain turnover, time-shift infectivity (4.6).
- **Budget and environment**: all mass pools, `O2` minimum and hypoxic area, mean light and temperature by zone, cap-tax activity, reseed and immigration counts.
- **Open-endedness**: Bedau-Packard evolutionary activity (Bedau and Packard 1992): count of genotypes or species persisting longer than a neutral shadow run would predict. Cheap version: compare the age distribution of species to that of a shadow model with random survival; optional.
- **Mood scalars for audio**: `activity` (births + deaths + bites per minute, normalised by population), `richness` (`1D` normalised), `stress` (share of deaths from starvation, hypoxia and disease over the last 2 days), `recentDisaster` (decaying impulse).

Storage: in-memory ring buffers for the god window charts (last 50 days at full resolution); each sim day's metrics appended to a Parquet (or CSV) file per world, so William can open the history in DuckDB or pandas. About 2 KB per metrics tick, 3 MB per sim year.

## 4.10 Balancing parameters

Defaults are first guesses for the Default preset, to be replaced by tuned values (4.11). "Tuned" marks the parameters in the auto-tuning set.

| Group | Parameter | Default | Range | Tuned |
|---|---|---|---|---|
| Clock | day `D`, year `Y` | 1200 s, 20 days | 300 to 86,400 s; 4 to 365 days | no |
| Mass | `M_target` (and `M_total` at start) | 2.0e6 mu (about 1000 mu/m²) | 2e5 to 2e7 | yes |
| Light | `k_w`, `k_chl`, `I_k` | 0.2 /m, 1/500, 0.3 | 0.1 to 0.4; 1/2000 to 1/100; 0.1 to 0.6 | `I_k` |
| Temperature | `T_mean`, `A_season`, `T_deep` | 14, 5, 4 °C | 4 to 28, 0 to 10, 2 to 10 | no |
| Mixing | `K_z0`, `K_mix` | 1e-4, 5e-3 m²/s | x0.1 to x10 | `K_mix` |
| Flow | mode amplitudes, `a_e`, `λ_e` | 0.05 m/s, 0.03 m/s, 6 m | 0 to 0.25; 0 to 0.1; 2 to 12 | `a_e` |
| Plankton | `μ_max`, `K_N`, `m_P`, `m_P2` | 1.5 /day, 50, 0.05 /day, 2e-4 | 0.5 to 3; 10 to 200; 0.01 to 0.2; 0 to 1e-3 | all four |
| Mats | `μ_B`, `m_B`, `s_B`, `R_B`, `d_B` | 0.6 /day, 0.3, 0.06, 8, 0.5 /day | 0.2 to 1.5; 0.15 to 0.45; 0.03 to 0.1; 4 to 12 | `μ_B` |
| Cycling | `r_D`, `w_D`, carcass `t_half`, `r_sed`, `β` | 0.15 /day, 8 m/day, 1.5 days, 0.02 /day, 0.001 /day | x0.25 to x4 | `r_D`, `w_D`, `t_half` |
| Digestion | `a_max` (plant, flesh, detritus), `θ` | 0.45, 0.80, 0.30; 1.3 | ±0.15; 1.0 to 2.0 | `a_max.plant`, `θ` |
| Metabolism | `b_0`, `Q10`, `c_gut` | tuned, 2.0, 0.02 | x0.3 to x3; 1.5 to 3 | `b_0` |
| Disease | `β` scale, `c_clear`, `c_ι`, `μ_s`, `v_max`, `z` | 1, 2 /day, 0.15, 0.02, 2 /day, 0.5 | x0.1 to x10; 0.5 to 5; 0.05 to 0.4; 0.005 to 0.1; 0.5 to 5; 0.3 to 0.8 | `β`, `c_ι` |
| Regulation | `N_max`, `k_cap`, grace `G`, `p_imm` | per preset, 2, 0.5 day, 0.05 /day | | `p_imm` no |
| Events | nature-mode rate | 0.1 /day | 0 to 1 | no |

About 16 parameters are tuned; the rest are fixed by design or exposed in the god window as world settings.

**Worked budget (Default preset, first guess).** `M_target = 2e6 mu`. Expected steady state: dissolved `N` 35 %, producers 30 %, detritus and sediment 15 %, consumers 15 to 20 % (3e5 to 4e5 mu), reservoir the rest. With a Sheldon-like flat biomass spectrum over 6 log2 mass classes of consumers, each class holds about 6e4 mu: plenty of 1 mu creatures (capped by `N_max`), a few hundred at 100 mu, and a handful at 1e4 mu. Whether that handful is a viable giant population depends on the body section's mass scaling, which is why `M_target` is tuned against a giant-viability metric.

## 4.11 Auto-tuning with headless fast-forward runs

### Headless runner

The sim host gets a `--headless` mode: no views, no streaming, uncapped sim speed, metrics written to Parquet, exit after `--days`. Tuning runs use the **Small** preset with `M_target` scaled by area (a quarter), so a run is cheap and many fit on one GPU.

```
phylotank-host --headless --preset small --seed 17 --days 150 \
  --params trial_0042.json --events scenario_meteor.json --out runs/0042_s17.parquet
```

Throughput estimate (to be measured once the sim exists): Small preset, 16k agents, brains dominating cost, roughly 300 to 800x real time on the 5090 (the brain and physics sections' budgets decide). 150 sim days is 50 hours at 1x, so about 4 to 10 minutes per run; 6 to 8 concurrent worlds in one process share the GPU. That is about 50 to 100 runs per hour. Weak laptops never tune; they ship the tuned defaults.

### Objective

Each metric gets a trapezoid score `s_j ∈ [0, 1]` (1 inside the target band, linear fall-off to 0 at twice the band distance), measured after a burn-in of 30 days:

| Metric | Target band |
|---|---|
| Consumer survival without reseed | all seeds survive 150 days (hard gate: else score 0) |
| Species richness `S` | 8 to 40 |
| `1D` (Shannon effective species) | at least 5 |
| Max TL sustained | at least 3.5 for 70 % of time |
| Roles occupied | at least 5 of 7 |
| Speciation rate | 0.5 to 3 per sim day (calibrate with the genome section's species definition) |
| Consumer biomass CV over 20-day windows | 0.1 to 0.5 (some boom-bust, no crashes) |
| At least one detected population cycle | present in 50 % of windows |
| Producers share of `M_total` | 15 to 60 % (not all locked in plankton) |
| Cap-tax active above 10 % | under 5 % of time |
| Disease prevalence | 2 to 30 % with at least one endemic strain 50 % of the time |
| Giant viability | at least 5 individuals above the 99th mass percentile of all-time for 50 % of time |
| Resilience (scenario runs) | after a boulder meteor at day 60, `1D` back to 80 % of pre-event within 15 days |

Combined score: weighted geometric mean `J = Π s_j^{w_j}` (no metric can be traded off to zero), then robust over seeds: `J_robust = mean − 0.5 · sd` across 4 seeds.

### Procedure

1. **Screening (Morris 1991 elementary effects)**: 16 parameters, 10 trajectories, 30-day runs, 1 seed: 170 runs, about 2 to 3 hours. Drops parameters with negligible effect from the tuning set and reveals strong interactions (for example `M_target` with `μ_max`).
2. **Viable region mapping**: 200 Latin hypercube samples, 30-day runs; fit a simple classifier (logistic regression or gradient boosting) for "consumers survive and producers below 80 %". Restricts the search to the viable region.
3. **Optimisation**: CMA-ES (Hansen, tutorial arXiv:1604.00772) in log-parameter space, population 12, about 25 generations, 4 seeds per candidate, with successive-halving early stopping (Hyperband style, Li et al. 2018): candidates that go extinct or saturate in the first 30 days are killed. About 500 to 800 runs, roughly one night on the 5090. Optuna's CMA-ES sampler and pruners can drive this from Python.
4. **Validation**: the best 3 candidates, 20 seeds x 365 days, plus 4 disaster scenarios (meteor, plague, ice age, nutrient flood). The winner becomes `defaults.json`, versioned with the code.
5. **Scale check**: run the winner on the Default and Large presets (5 seeds each, 100 days) to confirm the parameters transfer across tank sizes; if not, tune `M_target` and `N_max` per preset only.

The tuning driver is a small Python package (`tools/tune/`) calling the headless host, with results in Parquet and a DuckDB notebook for analysis. Re-tuning is required whenever the creature, brain or physics sections change costs materially; the nightly regression suite (4.14) detects when that has happened.

No live "governor" adjusts parameters during William's real world, beyond the mass-excess relaxation and safety valves: hidden steering would flatten exactly the drama he wants to watch.

## 4.12 Performance budgets

Ecosystem work per wall second at 1x sim speed (10 Hz ecology, 2 Hz light, temperature and flow, mats at 2 Hz):

| Item | RTX 5090, Default (131k agents) | Weak laptop iGPU, Small (16k agents) | CPU fallback, Small |
|---|---|---|---|
| Light scan + temperature | 0.05 ms | 0.4 ms | 2 ms |
| Flow rebuild | 0.1 ms | 1 ms | 8 ms |
| Plankton reaction + FV transport (fine grid) | 2 ms | 8 ms (512 x 288) | 40 ms (256 x 144 fine) |
| Coarse tracers (N, D, O2, S, Tanom, turb) | 0.5 ms | 3 ms | 20 ms |
| Mats Lenia-like convolution | 0.3 ms | 2 ms (radius 4, 1 Hz) | 15 ms (radius 3) |
| Demand, resolve, collect, deposits | 2 ms | 2 ms | 20 ms |
| Spores (65k / 8k) | 0.5 ms | 0.5 ms | 5 ms |
| Reductions, audit, metrics | 0.5 ms | 1 ms | 5 ms |
| **Total per wall second** | **about 6 ms (0.6 % of GPU time)** | **about 18 ms** | **about 115 ms of one core** |

So the ecosystem is cheap; the agents (brains, physics) own the budget. At 100x fast-forward the 5090 figure becomes about 600 ms per wall second, which is why tuning uses the Small preset.

**Bandwidth to views** (architecture section owns the protocol): environment uniforms (time, season, `y_s`, active modifiers, flow parameters and seed) at 1 Hz, about 300 bytes; coarse field snapshots for rendering (`P` downsampled to coarse, `B` summary, `turb`, `light`, `Tanom`) quantised to u8, delta-encoded and deflated, at 2 Hz: about 30 to 80 KB/s; fine-grid tiles only for the viewport of a deeply zoomed view, on request; terrain patches on change; events immediately. Views rebuild the flow field locally from the parameters and seed, so it is never streamed.

## 4.13 Failure modes and mitigations

| Failure | Symptom | Mitigation |
|---|---|---|
| Producer runaway, consumers starve | all mass in plankton, consumers dwindle | tuning bands on producer share; quadratic mortality; grazer `a_max.plant` |
| Paradox of enrichment | violent cycles then collapse | finite `M_target` tuned, refuges, quadratic closure, disease |
| Monoculture | one species owns everything | density-dependent disease (kill the winner), spatial heterogeneity, seasons |
| Stasis | stable but boring equilibrium for weeks | seasons, nature-mode events, Red Queen disease cycles, immigration; stats flag "no speciation in 20 days" |
| Pathogen apocalypse | disease wipes all hosts | virulence cap `v_max`, trade-off, safety valve; tuning band on prevalence |
| Pathogens vanish | no disease for long periods | reservoir strains re-emerge |
| Size spectrum swamped by tiny creatures | agent cap bound, no big creatures | cap tax, giant-viability tuning metric, possible super-individuals |
| Mass drift | slow leak or creation of mass | fixed-point exchange, conservative transport, audit and correction, test |
| Negative or NaN fields | visual glitches, crashes | positivity-preserving limiter, clamps, watchdog snapshot restore |
| Non-determinism | replays diverge | integer atomics, seeded RNG per entity and tick, fixed reduction order; cross-GPU float determinism not promised |
| God power regret | William wipes his favourite species | confirmation on large events, auto-snapshot undo, favourites in the gene bank |
| Weak machine cannot keep up | sim slower than real time | lower field rates and grids by preset; sim time slows gracefully rather than skipping ecology ticks |
| Flow artefacts at sharp terrain | water through thin walls | SDF ramp width `d_0` at least 3 coarse cells; generator removes walls thinner than 0.5 m |

## 4.14 Tests

**Unit (CI, seconds):**
- Mass conservation: random world, 10,000 ecology ticks with random creatures eating, excreting, dying, plus god floods and culls; `|M_total − expected| < 1e-6 · M_total` after correction and under `1e-4` before correction.
- Demand and resolve: synthetic cells with over-demand; no field goes negative, shares are pro-rata, results bitwise identical across 10 runs with shuffled thread order.
- Light: uniform water, no producers; scan matches `exp(−k_w y)` within 1e-4; a rock overhang casts a shadow; a bloom of 500 mu/m² halves light at the expected depth.
- Flow: discrete divergence below 1e-5 everywhere; normal velocity at rock cells below 1e-4 m/s; field identical for identical seed and time.
- Transport: a blob advected round a closed gyre for one revolution keeps its mass to 1e-6 and stays non-negative.
- Producer equilibrium: no consumers, fixed light and temperature, well mixed; `P` converges to the analytic NPZ equilibrium within 2 %.
- Mats: chosen defaults produce patches (spectral peak at wavelength about `2 R_B`) and no gliders (pattern centroid moves under 0.1 m per day).
- Disease kernel: `bind`, `recog`, `p_infect` match hand-computed values; strain GC frees strains with no hosts and no spores.
- Metrics: Hill numbers and evenness on known distributions; trophic level on a hand-built chain (1, 2, 3, 4) and a diamond web; cycle detector finds the period of a noisy sine within 5 %; Poisson z-score detector fires on an injected mortality spike and not on baseline noise (false positive rate under 1 per 100 days).

**Integration (CI, minutes):**
- Determinism: same seed and event log, 1 sim day, state hash identical on the same machine; snapshot at day 0.5, restore, continue: identical hash.
- SIR sanity: well-mixed tank, one non-mutating strain, fixed non-evolving hosts; epidemic final size within 10 % of SIR theory for the same `R0`.
- Predator-prey: scripted grazer and predator brains on a plankton field; oscillations appear; adding caves increases mean persistence time (Huffaker check).
- God powers golden tests, one per power, each asserting its signature: cold snap reaches the target surface temperature within its attack time; meteor carves a crater (SDF), kills inside `r_k`, raises `turb`; nutrient flood raises `M_total` by `ΔM` and the excess halves in 40 days ±10 %; plague infects only the target species when signatures are far apart; cull removes `f ± 1` individual; rift barrier: zero crossings; ice age moves `y_s` and restores it; introduce and cull conserve mass.
- Event propagation: sim host plus two mock views; both receive the event with identical `startTick` before it applies; the auto-snapshot exists; the event and active modifiers survive a host restart.
- Safety valves: forced total extinction triggers a reseed after `G`, with a founder assemblage covering at least 3 roles and an announcement flag; NaN injection triggers snapshot restore.

**Long-run (nightly, headless, the ecology regression suite):**
- 10 fixed seeds x 150 days on the tuned defaults; every tuning band must hold for at least 8 of 10 seeds. Metric distributions are compared to the last accepted baseline; a significant shift (two-sample KS test, p < 0.01, on richness, max TL, biomass CV) marks the build "balance changed, re-tune".
- Emergence targets, tracked as pass rates rather than hard failures: diel vertical migration (correlation between light and mean depth of a grazer species below −0.5) appears in some seed within 100 days; virulence settles at an intermediate value; time-shift test shows coevolution signature; a spring bloom occurs every simulated year; at least one whale-fall scavenger aggregation per 50 days.
- Soak: 30 real days of the Default preset at 1x on the dev machine: no NaN, flat memory, mass audit clean, snapshot sizes stable.

## 4.15 Prior art

URLs are from memory and were not checked in this session (no searches used); treat them as unverified.

- Lenia, continuous cellular automata: Chan 2019, https://arxiv.org/abs/1812.05433 ; Flow-Lenia, mass-conserving: Plantec et al. 2023, https://arxiv.org/abs/2212.07906
- Gray-Scott patterns: Pearson 1993, "Complex patterns in a simple system", https://arxiv.org/abs/patt-sol/9304003
- Stable fluids: Stam 1999, https://www.dgp.toronto.edu/public_user/stam/reality/Research/pdf/ns.pdf
- Curl noise and the SDF ramp: Bridson, Hourihan and Nordenstam 2007, https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph2007-curlnoise.pdf
- NPZ plankton models: Franks 2002, J. Oceanography, https://doi.org/10.1023/A:1015820616384 ; Sverdrup 1953 critical depth (spring bloom)
- Metabolic theory of ecology: Brown et al. 2004, Ecology, https://doi.org/10.1890/03-9000
- Paradox of enrichment: Rosenzweig 1971, Science; refuges and persistence: Huffaker 1958, Hilgardia
- Trophic position from diet: Levine 1980, J. Theoretical Biology; size spectrum: Sheldon, Prakash and Sutcliffe 1972
- Host-parasite genetics: Agrawal and Lively 2002, Evolutionary Ecology Research (matching alleles versus gene-for-gene); virulence trade-off: Anderson and May 1982, Parasitology; Alizon et al. 2009, J. Evolutionary Biology, https://doi.org/10.1111/j.1420-9101.2008.01658.x ; time-shift experiments: Gandon et al. 2008, J. Evolutionary Biology
- Diversity: Hill 1973, Ecology, https://doi.org/10.2307/1934352 ; Jost 2006, Oikos; Faith 1992 phylogenetic diversity
- Evolutionary activity statistics: Bedau and Packard 1992 (Artificial Life II)
- Super-individuals: Scheffer et al. 1995, Ecological Modelling
- Jump flooding for distance fields: Rong and Tan 2006, I3D
- CMA-ES: Hansen, https://arxiv.org/abs/1604.00772 ; Hyperband: Li et al., https://arxiv.org/abs/1603.06560 ; Optuna, https://optuna.org ; Morris 1991 screening, Technometrics
- Artificial life ecosystems: Polyworld (Yaeger 1994), https://github.com/polyworld/polyworld ; Tierra (Ray 1991), where parasites emerged spontaneously; Avida resources, https://github.com/devosoft/avida ; ALIEN (GPU particle ecosystems), https://alien-project.org ; The Bibites, prior art only (as I recall it regulates its world through a fixed total energy budget for plant pellets; unverified). Phylotank's conserved nutrient currency is in the same spirit, made spatial and cyclic.

## 4.16 Open questions for William

1. **Time scale.** Default is a 20-minute sim day and a 20-day year (one year per evening). Or should day and night follow your real clock, so the TV tank is dark at night, with seasons on a separate faster cycle?
2. **Oxygen and dead zones.** Keep oxygen as a field (blooms cause dead zones, vents are hypoxic, creatures evolve gill size), or drop it for simplicity? I recommend keeping it.
3. **Microbe-scale swarms.** To fill the bottom of the 3-orders zoom without blowing the agent cap, may the smallest creatures be simulated as super-individuals (one agent stands for a cloud of identical tiny animals), or must every visible creature be its own agent?
4. **Arrivals and reseeds.** When the tank reseeds or immigrants arrive, should the wallpaper and TV show a subtle in-world sign (glowing spores drifting down), or should it be silent outside the god window? Should background immigration be on by default, or is a sealed tank more satisfying?
5. **Nature mode and undo.** Should the tank throw its own mild disasters while you are away (default: about one per 10 sim days), and do you want confirmation plus rewind for world-ending powers (extinction-level meteor, ice age), or the raw, irreversible god experience?
