# 03. Brains, senses and behaviour

Status: draft for William's review. Depends on the body/growth section (organ list), the genome section (mutation, crossover, speciation), physics (muscles, drag), ecosystem (chemical fields, light) and architecture (sim host, WebGPU). Where those sections are not yet fixed, the assumptions I rely on are listed in section 3.12 so they can be checked against each other.

## 3.1 Summary of choices

| Question | Choice |
|---|---|
| Neuron model | CTRNN (leaky integrator) neurons with evolvable time constants, plus explicit phase-oscillator neurons for central pattern generators (CPGs) |
| Encoding | Indirect: a NEAT-evolved CPPN wires a **body-anchored substrate** (HyperNEAT style with a link-expression output), plus up to 32 direct "override" connection genes (HybrID style) for irregular fixes |
| Why | A new or duplicated limb automatically gets sensory and motor neurons, and the CPPN gives them sensible weights from their body position on the first generation it exists |
| Innate layer | Hard-wired, gene-weighted reflex circuits (swim, startle, graze, bite, avoid walls, reproduce) so generation 0 survives |
| Learning | Optional neuromodulated Hebbian plasticity (ABCD rule), switched on and scaled by genes, costs energy, not inherited (no Lamarckism) |
| Personality | About 12 named heritable parameters acting on named "drive" neurons and global gains, plus per-individual developmental noise |
| GPU layout | Fixed size classes (max 256 non-input neurons, 192 inputs), ELL-style sparse fan-in of 8 or 16 synapses per neuron, one neuron per thread, activations in workgroup memory, brain tick 20 Hz staggered over 3 sim ticks |
| Budget | 300k brained creatures cost about 0.4 ms per 60 Hz sim tick on an RTX 5090 (bandwidth bound, about 2.5 percent of a frame). Weak laptop: 23k creatures in about 0.6 ms |

## 3.2 Choosing the architecture

### 3.2.1 Options considered

**A. NEAT, direct variable topology** ([Stanley and Miikkulainen 2002](http://nn.cs.utexas.edu/downloads/papers/stanley.ec02.pdf)). Each connection is a gene with an innovation number. Strengths: proven, starts minimal, crossover aligns by innovation number. Weaknesses for Phylotank:
- It knows nothing about the body. When the body genome duplicates a fin, the new fin has a muscle with zero connections, so it hangs limp or is wired by chance. Most body mutations then become harmful only because the brain did not follow, which slows body evolution badly.
- Neuron identity is tied to indices, so body changes shuffle the mapping between neurons and organs.
- Topology is irregular per individual, which is awkward but not fatal for GPU batching.

**B. Fixed-topology recurrent net** (as used by many artificial-life sims, including Polyworld's layered groups to some extent, [Yaeger 1994](https://github.com/polyworld/polyworld)). Easy to batch on the GPU, but the input and output counts must be fixed, while our bodies have a variable number of eyes, segments, fins and mouths. Padding every brain to the worst case wastes memory and still does not tell a new fin which neurons are "its own".

**C. CTRNN** ([Beer 1995](https://journals.sagepub.com/doi/10.1177/105971239500300405)). This is a neuron model, not an encoding. Each neuron has a time constant, so one network can mix fast reflexes (50 ms) with slow moods (minutes). CTRNNs are the standard model for evolved locomotion and minimal cognition. It combines with any of the encodings.

**D. CPPN / HyperNEAT indirect encoding** ([Stanley 2007, CPPNs](http://eplex.cs.ucf.edu/papers/stanley_gpem07.pdf); [Stanley, D'Ambrosio and Gauci 2009, HyperNEAT](http://eplex.cs.ucf.edu/papers/stanley_alife09.pdf)). A small evolved network (the CPPN) is queried with the coordinates of two neurons and returns the weight between them. Neurons placed on a geometric "substrate" get weights as a function of geometry, which gives symmetry, repetition and gradients for free. Weakness: it is poor at fine, irregular weight patterns ([Clune et al. 2011, "On the performance of indirect encoding across the continuum of regularity"](https://doi.org/10.1109/TEVC.2010.2104157)). The fix proposed there, HybrID, adds a direct-encoded layer on top.

### 3.2.2 Decision

Use **C + D + a small A**:

1. **Neurons are CTRNN units**, plus a separate oscillator neuron type for CPGs.
2. **The substrate is the grown body.** Every organ the body grows contributes neurons at its own body coordinates. A fin contributes a muscle neuron and a proprioceptor; an eye contributes receptor inputs; each segment contributes a small ganglion of hidden neurons and, if the gene is on, an oscillator. The head contributes a central ganglion and the drive neurons.
3. **A CPPN wires the substrate.** Connection weight, whether the link is expressed, its plasticity rate and rule, and each neuron's bias and time constant all come from querying the CPPN with neuron coordinates and types. The CPPN genome is itself evolved NEAT-style (node and connection genes with innovation ids), which is exactly the HyperNEAT recipe.
4. **Up to 32 override genes** add direct weights between neurons named by stable ids. They let evolution make an irregular fix (one odd connection) without disturbing the regular pattern.

Why this fits the brief: "a body must make sense for what it evolved to do" requires body and brain to evolve together. With a body-anchored substrate, when segment 4 duplicates into segments 4 and 5, the new segment's muscle, oscillator, lateral-line organ and ganglion receive weights from the same CPPN at a slightly shifted position, so the new segment swims in phase with its neighbours immediately. Polyworld and Karl Sims both faced this coupling; Sims evolved brain and body together with nested graphs whose neural elements are replicated with each body part ([Sims 1994](https://www.karlsims.com/papers/siggraph94.pdf)). Our approach gets the same "brain follows body" property with a much smaller, GPU-friendly runtime net.

What we do not use: ES-HyperNEAT (evolvable substrate density, [Risi and Stanley 2012](http://eplex.cs.ucf.edu/papers/risi_alife12.pdf)) because the body already decides where neurons go; and gene regulatory network brains, because GRN dynamics are slower to evaluate and harder to inspect. A GRN may still drive body development (body section decides).

## 3.3 The substrate: neurons from organs

### 3.3.1 Coordinates

Every neuron gets a coordinate in the body's normalised frame, computed once at development:

| Field | Range | Meaning |
|---|---|---|
| `u` | 0 (snout) to 1 (tail tip) | position along the main body axis |
| `v` | -1 (left) to +1 (right) | lateral offset, normalised by local half-width |
| `d` | 0 to 1 | depth along a limb branch (0 at the body, 1 at the limb tip) |
| `type` | one of 12 | eye, lateral line, chemical, touch/taste, internal, clock, drive, oscillator, ganglion hidden, head hidden, muscle motor, action motor |
| `organ` | stable id | the organ gene that produced it, plus slot index |

The stable neuron id is `hash32(organGeneId, slot)`. Organ gene ids come from the body genome (assumed stable across mutation, see 3.12). Override genes and the inspector refer to neurons by this id, so a body mutation elsewhere does not renumber them.

### 3.3.2 Neuron sets per organ

| Organ (body section) | Inputs it contributes | Non-input neurons it contributes |
|---|---|---|
| Eye | `R` receptors x (`C` colour channels + 1 proximity), R in 1 to 16, C in 1 to 3 | none |
| Lateral-line organ (per segment, per side) | 1 (log pressure magnitude) | none |
| Nose (chemoreceptor) | per chemical channel sensed: level + temporal derivative | none |
| Touch patch (per segment, per side) | 1 (contact force) | none |
| Mouth | 2 taste (nutrition, toxicity) + 1 "holding/attached" | action motors: mouth open, bite, latch |
| Joint with muscle | 1 proprioceptor (joint angle) | 1 muscle motor |
| Fin | 1 proprioceptor (stroke angle) | 1 muscle motor (stroke), 1 motor (pitch), optional oscillator |
| Segment | none | `hiddenPerSegment` ganglion neurons (gene 0 to 8), optional oscillator |
| Head | internal-state and clock inputs (below) | `headHidden` neurons (gene 0 to 64), 6 drive neurons, 2 modulatory neurons, CPG control motors, global action motors |
| Photophore (light organ) | none | emit intensity, emit hue shift |
| Toxin gland / ink sac | 1 (gland fullness) | release |
| Gonad / brood pouch | 1 (gestation or egg load) | mate, lay/bud |

Inputs are not neurons in the runtime sense: they are clamped values written by the perception pass. They live in the same workgroup memory array as neuron outputs, so any neuron can read them through a synapse, but they have no synapse rows of their own. This matters for the budget, because eyes are input-heavy.

**Larval and adult forms.** If the body section grows organs in stages, the brain is developed once at birth for the full adult plan. Organs not yet grown have inputs held at 0 and motor outputs ignored. Brains never reallocate during a life, which keeps the GPU pools stable.

### 3.3.3 Worked example

"Glimmerkin", an original design: a 6-segment grazer, 2 eyes of 8 receptors with 2 colour channels, 1 nose sensing 4 channels, lateral line and touch on every segment, 5 body joints, 4 fins, 1 photophore.

| Group | Count |
|---|---|
| Eyes: 2 x 8 x (2 + 1) | 48 |
| Lateral line: 6 x 2 | 12 |
| Nose: 4 x 2 | 8 |
| Touch: 6 x 2 | 12 |
| Mouth taste + attached | 3 |
| Proprioception: 5 joints + 4 fins | 9 |
| Internal state | 11 |
| Clocks + bias | 5 |
| **Inputs** | **108** |
| Drives 6 + modulatory 2 | 8 |
| Oscillators: 6 segments | 6 |
| Hidden: 6 x 4 ganglion + 16 head | 40 |
| Muscles: 5 joints + 4 fins x 2 | 13 |
| CPG control: frequency, amplitude, turn | 3 |
| Actions: mouth, bite, latch, mate, lay, light x 2 | 7 |
| **Non-input neurons** | **77** |

This lands in size class C3 (section 3.9.2): 128 neuron slots, 160 input slots, 16 synapses per neuron.

## 3.4 Senses (inputs)

All inputs are normalised to roughly [-1, 1] or [0, 1], then get additive sensory noise `n ~ N(0, sensorNoise)` with `sensorNoise` a gene in [0, 0.1] (some noise makes evolved controllers robust; zero noise invites brittle exploits). Noise uses a counter-based hash RNG keyed by `(creatureId, tick, inputIndex)` so runs stay deterministic.

### 3.4.1 Eyes: field of view and colour

Eye parameters come from the body genome: mount angle on the body, field of view `fov` in [10, 360] degrees, receptor count `R` in [1, 16], range `rEye` in [2, 40] body lengths (capped in world units by water clarity), and a spectral sensitivity vector `s` over 3 light bands (blue about 470 nm, green about 510 nm, red about 600 nm, nominal).

Light bands matter in a deep-sea tank. Most deep-sea animals see only blue-green, and a few real dragonfish use red light as a private channel (from memory, unverified). In Phylotank a lineage that evolves red photophores plus red receptors gains a channel its prey cannot see, which is an emergent niche we get for free from the 3-band model.

Algorithm (per eye, per brain tick), in the shared perception kernel:

1. Iterate neighbours from the spatial hash within `rEye` (cap 48 nearest by cell ring order).
2. For each object `j` at distance `dist` and bearing `theta` inside the field of view, compute its angular half-width `a = atan(radius_j / dist)` and the receptor bins it covers.
3. Per bin, keep only the nearest object (a 1D depth buffer of R floats): this gives occlusion.
4. Receptor value per channel `c`:
   `I_c = (E_j[c] + A(depth_j) * albedo_j[c]) * s[c] * exp(-kappa * dist) / (1 + (dist / r0)^2)`
   where `E_j` is j's current emitted light (photophores, driven by its brain), `A(depth)` the ambient light at j's depth from the ecosystem light field, `kappa` water absorption. Then `I_c := log(1 + I_c / I0)` clamped to [0, 1].
5. Bins with no object see the background: downwelling ambient light if the bin points upward (`A` at own depth times the upward component), else near 0. Prey above a viewer appear as **dark silhouettes against the downwelling light**, unless they emit matching light, which is counter-illumination camouflage, also emergent.
6. Proximity channel per bin: `p = clamp(radius_j / dist, 0, 1)` of the nearest object, 0 if none. Looming (fast growth of `p`) is the classic escape trigger.

Plankton and plants are not individual objects at microbe scale for large viewers; the ecosystem section's density fields are sampled along the bin centre ray at 3 distances and added as a diffuse glow term.

### 3.4.2 Lateral line

Each lateral-line organ at position `x` (one per segment per side) senses nearby water disturbance from other moving bodies:

`P = sum_j  m_j * |v_j - v_self| * max(0, n . (x_j - x)/|x_j - x|)^0.5 / (|x_j - x|^2 + eps)`, then `log(1 + P / P0) - g_self * |v_self|`

`n` is the organ's outward normal, so left and right organs differ, which gives bearing. The self-motion term `g_self * |v_self|` (gain fixed at 1 in v1) means a fast swimmer's lateral line is partly deafened by its own motion. This makes the lateral line most useful to still animals, which favours ambush predators and hovering prey, and it works in total darkness. Range: 4 own body lengths. Uses the same neighbour list as the eyes.

### 3.4.3 Smell and chemical gradients

The ecosystem section owns the chemical grid. I assume channels: dissolved food (from plankton and corpses), blood (released on damage), toxin, and 4 pheromone channels. A creature emits pheromones in proportions given by a 4-vector scent fingerprint gene; its nose receptors have a tuning 4-vector gene, and the pheromone input is the dot product of tuning and local concentrations. This means kin and species recognition is learned or evolved, never hard-coded, and **scent mimicry** is possible.

Per channel sensed: `level = log(1 + c / c0)` and `rate = clamp((level_t - level_{t-1}) / dt * tauSmell, -1, 1)`. The rate input lets a single nose do klinotaxis (turn when the gradient gets worse), the way bacteria and nematodes climb gradients; two bilateral noses can do tropotaxis by comparing left and right, which is a Braitenberg vehicle ([Braitenberg 1984, Vehicles](https://mitpress.mit.edu/9780262521123/vehicles/)). Smell cost per channel is paid by the body section; the brain just reads what exists.

### 3.4.4 Touch and taste

Touch patch: contact force magnitude from physics, `tanh(F / F0)`. Mouth taste on contact: nutrition (0 to 1, per food type: plant matter, meat, carrion, in proportion to what the mouth touches) and toxicity. "Attached" is 1 while latched onto a host (parasites) or while something is latched onto this mouth's region (rare).

Parasite load ("itch") is an internal input: fraction of body segments with an attached parasite. Hosts can evolve to scrape or roll when it rises.

### 3.4.5 Internal state and clocks

| Input | Encoding |
|---|---|
| energy | reserves / max reserves, 0 to 1 |
| gut fullness | 0 to 1 |
| health | 0 to 1 |
| pain | `clamp(-dHealth/dt * tauPain, 0, 1)` |
| age | age / genetic lifespan, 0 to 1 |
| mature | 0 or 1 |
| gestation / egg load | 0 to 1 (brood pouch or reproductive reserve) |
| temperature | local water temperature, normalised to the species' comfort range gene |
| depth | 0 surface to 1 floor |
| ambient light | `A(depth)` normalised |
| own speed | `tanh(|v| / v0)` where `v0` is 1 body length per second |
| day clock | `sin(2 pi t_day)`, `cos(2 pi t_day)` |
| season clock | `sin(2 pi t_year)`, `cos(2 pi t_year)` |
| bias | constant 1 |

Clocks are given as sin/cos pairs so time is a smooth circle and any phase preference is one linear readout.

## 3.5 Neuron dynamics

### 3.5.1 CTRNN neurons

For neuron `i` with state `y_i`, bias `theta_i`, time constant `tau_i`:

`tau_i dy_i/dt = -y_i + sum_j w_ij o_j + noise_i`,  `o_i = f_i(y_i + theta_i)`

Integration uses exponential Euler with the brain step `dt = 50 ms`:

`y_i <- y_i + alpha_i * (sum_j w_ij o_j + noise_i - y_i)`,  `alpha_i = 1 - exp(-dt / tau_i)`

`alpha` is precomputed at development and lies in (0, 1], so the leak is unconditionally stable. `tau_i` range: 50 ms (alpha about 0.63, a plain recurrent unit) to 120 s (a slow mood or habit integrator), log-uniform mapping from the CPPN output. States are clamped to [-8, 8]; any NaN resets the brain's state to 0 and increments a debug counter (tested, should never fire).

Activation `f_i`: `tanh` for hidden, drive and motor neurons. v1 keeps a single function at runtime for simplicity and speed; the CPPN still uses a rich function set. Open for later: a per-neuron choice of `tanh` or a rectified `max(0, tanh)`.

`noise_i ~ N(0, sigma_noise)` from the `exploration` personality gene, applied to hidden and drive neurons only.

### 3.5.2 Oscillator neurons and CPGs

Swimming is rhythmic, and evolving a rhythm generator from scratch in a CTRNN is a classic bootstrapping trap. We therefore provide oscillator neurons, as in coupled-oscillator CPG models of lamprey and salamander locomotion ([Ijspeert 2008](https://doi.org/10.1016/j.neunet.2008.03.014)):

`dphi_i/dt = 2 pi F + sum_{j in N(i)} k_ij * sin(phi_j - phi_i - lag_ij)`,  `o_i = Amp * sin(phi_i)`

- `F = fLow + (fHigh - fLow) * sigmoid(cpgFrequency)` where `cpgFrequency` is a head motor neuron output, and `fLow`, `fHigh` are genes in [0.1, 6] Hz.
- `Amp = sigmoid(cpgAmplitude)`, another head motor output.
- Neighbours `N(i)`: oscillators in adjacent segments, and the mirror fin of a paired fin. `k_ij` and `lag_ij` come from a CPPN pair query (section 3.6.2), so a travelling body wave (anguilliform), a stiff-body tail beat (thunniform), or in-phase and anti-phase fin pairs are all reachable. Coupling `k` in [0, 10] per second.
- The phase update is analytic per brain tick, so 20 Hz is enough for beats up to about 5 Hz.

Oscillator outputs enter the synapse array like any other neuron output. A muscle motor neuron typically receives its segment's oscillator plus a turn signal (the `cpgTurn` motor output, weighted by `v`) plus reflex and higher inputs. Muscles therefore get "CPG with descending control", the structure of real vertebrate swimming, but nothing forces it: evolution can cut the oscillators out with zero weights, and the `oscPerSegment` gene can turn them off (sessile or jet-propelled bodies).

### 3.5.3 Neuromodulation and plasticity (optional, gene-controlled)

Two modulatory neurons in the head, `pleasure` and `pain`, are CTRNN units with innate inputs (eating, successful mating, energy rising for `pleasure`; damage, toxicity, starvation for `pain`) plus CPPN connections. Their outputs `m_+`, `m_-` are brain-wide modulation signals.

Each plastic synapse uses a neuromodulated ABCD rule ([Soltoggio et al. 2008](https://doi.org/10.7551/mitpress/9780262750172.003.0069); the ABCD form follows [Niv et al. 2002](https://doi.org/10.1177/1059712302010001001)):

`dw_ij <- dw_ij + eta_ij * m_r * (A_r o_i o_j + B_r o_i + C_r o_j + D_r) - (dt / tauForget) * dw_ij`

`w_ij = clamp(w0_ij + dw_ij, -wMax, wMax)`, `wMax = 4`

- `r` is the rule index (0 to 3) chosen per synapse by the CPPN. The genome stores 4 rules, each with `(A, B, C, D)` in [-1, 1] and a channel select (`m_+`, `m_-`, or the constant 1 for plain Hebbian).
- `eta_ij` from the CPPN, quantised to a 4-bit log scale in [1e-4, 1e-1].
- `tauForget` gene in [10 s, 1 day] decays learned changes back towards the genetic baseline `w0`.
- Plasticity is gated by a gene `plasticityOn` (expressed if a float gene > 0, so it can drift on and off) and scaled by `etaScale` in [0, 1].
- Energy cost per plastic synapse (3.7), so plasticity survives only where it pays: variable environments, seasons, mimicry learning.
- `dw` is stored in f32, because f16 cannot hold updates of 1e-4 against weights near 0.5 (f16 spacing there is about 5e-4).
- **Learned weights are not inherited.** Offspring develop `w0` from the genome. Learning still shapes evolution through the Baldwin effect ([Hinton and Nowlan 1987](https://www.complex-systems.com/abstracts/v01_i03_a06/)).

Encoding plasticity through the CPPN follows adaptive HyperNEAT ([Risi and Stanley 2010](http://eplex.cs.ucf.edu/papers/risi_sab10.pdf)). Polyworld also used Hebbian learning in evolved brains ([Yaeger 1994](https://github.com/polyworld/polyworld)).

## 3.6 Development: from genome to runtime brain

### 3.6.1 Brain genome

```ts
interface BrainGenome {
  cppn: CppnGenome;                 // NEAT-style graph, 5 to 60 nodes
  overrides: OverrideGene[];        // at most 32
  hiddenPerSegment: number;         // int 0..8
  headHidden: number;               // int 0..64
  oscPerSegment: boolean;           // float gene > 0
  oscPerFin: boolean;
  fLow: number; fHigh: number;      // Hz, 0.1..6
  plasticityOn: number;             // expressed if > 0
  etaScale: number;                 // 0..1
  rules: [number, number, number, number, Channel][];  // exactly 4
  tauForget: number;                // seconds, log 10..86400
  sensorNoise: number;              // 0..0.1
  reflex: Record<ReflexId, number>; // gains, -2..2, see 3.8
  personality: Personality;         // see 3.7
  drives: DriveParams[];            // 6 entries: bias, tau, innate input gains
}

interface CppnGenome {
  nodes: { innov: u64; fn: 'lin'|'tanh'|'sin'|'gauss'|'abs'|'step'; bias: number }[];
  conns: { innov: u64; from: u64; to: u64; w: number; enabled: boolean }[];
}

interface OverrideGene { src: u32; dst: u32; w: number } // stable neuron ids
```

**Innovation ids without a global registry.** NEAT needs matching innovation numbers for crossover. Phylotank reproduces asynchronously in a world that runs for months, so a central counter is fragile. Instead: a connection's innovation is `hash64(fromInnov, toInnov)`; a node created by splitting connection `c` gets `hash64(c, k)` where `k` counts prior splits of `c` in that lineage's genome. Identical structural mutations anywhere in the world get identical ids, crossover alignment works, and save files need no registry. Collision risk at 64 bits is negligible.

### 3.6.2 CPPN queries

CPPN inputs for a connection query from source `a` to target `b` (38 inputs):
`u_a, v_a, |v_a|, d_a, type_a (one-hot 12), u_b, v_b, |v_b|, d_b, type_b (one-hot 12), u_b - u_a, v_b - v_a, dist, sameSide, sameOrgan, bias`.

Outputs (6): `w`, `leo` (link expression output, [Verbancsics and Stanley 2011](http://eplex.cs.ucf.edu/papers/verbancsics_gecco11.pdf)), `eta`, `rule`, `nodeBias`, `nodeTau`.

- **Connection query**: read `w` (scaled by 3), `leo`, `eta`, `rule` (4 bins).
- **Node query** (`a = b`, a node flag set via `sameOrgan = 2`): read `nodeBias` and `nodeTau`.
- **Oscillator pair query**: for coupled oscillators, `k = 10 * sigmoid(w)`, `lag = pi * tanh(eta)`.

`|v|` and `v` are both given, so bilateral symmetry is the easy default (functions of `|v|`) and asymmetry (handedness, flatfish-like bodies) is reachable via the sign.

### 3.6.3 Wiring algorithm

For each non-input target neuron `b`:

1. Build candidate sources, capped at 128: all head neurons and drives, all internal and clock inputs, everything within `|u_b - u_a| <= 0.25` or on the same organ, then the remaining sensors subsampled by stride until the cap.
2. Query the CPPN for each candidate; keep those with `leo > 0`.
3. Reserve slots for reflex connections (3.8) first.
4. Fill remaining slots with the top `K - reflexCount` by `|w|`.
5. Add override genes whose `dst` is `b` (they add to an existing slot's weight or replace the weakest slot).
6. Unused slots get `src = self, w = 0` (harmless padding).

Then classify the brain into a size class (3.9.2). If it fits no class, trim in this order: head hidden neurons beyond 64, ganglion hidden from the tail forward, then merge eye receptors pairwise (halving R). Trimming is deterministic and logged in the inspector.

**Cost.** Typical brain: 77 targets x about 128 candidates = 10k queries. CPPN of 30 nodes is about 100 flops per query, so 1 MFLOP per birth. At a boom of 2,000 births per second (mostly microbes with about 800 queries each) development needs roughly 0.5 GFLOP/s. That fits in 1 to 2 CPU worker cores in WASM or JS, so v1 develops brains on CPU workers (deterministic, easy to debug) and uploads them to GPU pools. A GPU development kernel is a later optimisation if births ever bottleneck.

### 3.6.4 Mutation and crossover

The genome section owns the global mutation-rate gene `mu`; every probability below is multiplied by `mu / mu_default`.

| Operator | Default probability per offspring | Detail |
|---|---|---|
| CPPN weight perturb | 0.8 per conn | `w += N(0, 0.15)`, 5 percent chance of full reset |
| CPPN add connection | 0.08 | random feed-forward or recurrent pair |
| CPPN add node | 0.03 | split an enabled connection (NEAT) |
| CPPN toggle connection | 0.02 | |
| CPPN change node function | 0.02 | |
| Hidden counts | 0.05 each | +1 or -1 |
| Override add / remove / perturb | 0.02 / 0.02 / 0.3 | |
| Personality, reflex, drive, rule floats | 0.3 per gene | `N(0, 0.05 * range)` |

Sexual crossover: CPPN genes aligned by innovation id (matching genes chosen at random from either parent, disjoint and excess from the fitter parent, where "fitter" means higher energy at mating because there is no explicit fitness); overrides aligned by `(src, dst)`; floats uniform pick or blend at 50/50.

Speciation: the brain contributes NEAT compatibility distance `delta = c1 E/N + c2 D/N + c3 Wbar` on the CPPN plus L2 distance on personality genes. The genome section decides the weighting against body genes.

## 3.7 Drives, habits and personality

Six **drive neurons** sit in the head with fixed names and innate inputs, so behaviour is legible in the inspector and personality genes have something concrete to act on. Their downstream wiring is entirely evolved.

| Drive | Innate inputs (gene gains) |
|---|---|
| hunger | low energy, empty gut |
| fear | pain, looming proximity, blood smell, sudden lateral-line spikes |
| libido | maturity, energy above threshold, low gestation |
| fatigue | sustained muscle effort, night clock (if diurnal) |
| aggression | hunger, conspecific proximity, being bitten |
| sociality | conspecific pheromone match, conspecific glow |

**Personality genes** (each a float with range, applied at development):

| Gene | Range | Mechanism |
|---|---|---|
| boldness | -1..1 | bias on `fear` (negative) and gain of fear's innate inputs |
| activity | 0..1 | baseline bias on `cpgAmplitude` and `cpgFrequency` |
| exploration | 0..0.3 | hidden-neuron noise sigma |
| sociality | -1..1 | bias and innate gain of `sociality` |
| aggression | -1..1 | bias of `aggression` |
| appetite / satiety | 0..1 | threshold of `hunger` |
| patience | 0..1 | log time-constant multiplier on drives (patient = slow-changing moods) |
| chronotype | -1..1 | weight from day-clock inputs into `fatigue` (diurnal vs nocturnal) |
| preferred depth | 0..1 | bias on a depth-error signal into vertical swimming |
| risk aversion | 0..1 | weight from `fear` into the CPG frequency (flight speed) |
| lightShow | 0..1 | baseline photophore intensity |
| individuality | 0..0.3 | per-individual developmental noise on all of the above |

**Individuality** gives consistent within-species differences, the biological definition of personality: at development each personality gene gets an offset `N(0, individuality * range)` from the seeded RNG, fixed for that individual's life. It is not inherited (only the `individuality` gene is), which separates genetic and developmental variance in experiments.

**Habits** come from three sources: (1) heritable clock weights (daily vertical migration, nocturnal feeding), (2) long time-constant neurons that hold state for minutes (resting after a meal, returning to a depth), and (3) plasticity, which can lock in learned associations (this glow colour tasted bad) for the life of the individual. Item 3 is optional per lineage.

## 3.8 Outputs and innate reflexes

### 3.8.1 Output table

All motor neuron outputs are `tanh` values in [-1, 1]. Triggers use hysteresis (on above 0.5, off below 0.2) and a cooldown.

| Output | Effect (physics/ecosystem sections enact it) | Cooldown | Energy cost |
|---|---|---|---|
| muscle (per joint) | target activation for the joint's antagonist pair; physics applies first-order muscle lag of 50 to 100 ms | none | proportional to `|activation| * muscle mass` |
| fin stroke, fin pitch | as muscle | none | as muscle |
| cpgFrequency, cpgAmplitude, cpgTurn | drive oscillators (3.5.2) | none | none directly |
| mouth open | 0 to 1 aperture, also increases drag | none | small |
| bite | one bite impulse, damage from mouth gene | 0.3 to 2 s (mouth gene) | per bite |
| latch | attach to touched body if mouth type permits; release when below 0.2 | 1 s | none while attached |
| mate | willingness; mating needs both partners above threshold, in contact, compatible (genome section) | per gestation | per mating |
| lay / bud | release eggs or bud if reproductive reserve is full; mode is a reproduction gene | reserve refill | the reserve itself |
| emit intensity, emit hue | photophore light within the genetic palette; hue shifts at most 0.15 of the palette range | none | per intensity-second |
| release (toxin or ink) | puff into chemical field | gland refill | gland contents |

Brains cost energy too: `E_brain = e_n * N + e_s * S + e_p * P` per second for non-input neurons `N`, synapses `S` and plastic synapses `P`. Costs are absolute, not proportional to body metabolism, so small creatures find brains expensive and giants find them cheap. Defaults are tuned so Glimmerkin's brain is 15 to 20 percent of its basal metabolic rate, similar to the human figure, and a 16-neuron microbe's is about 3 percent.

### 3.8.2 Innate reflexes

Reflexes are fixed connection templates between named neurons, scaled by `reflex` gain genes (initial value 1, range -2 to 2; evolution can turn any of them off or invert them). They occupy reserved synapse slots and are drawn in a distinct colour in the inspector.

| Reflex | Circuit |
|---|---|
| swim | constant bias into `cpgAmplitude` and `cpgFrequency` |
| startle (Mauthner-like C-start) | lateral-line or proximity spike on one side into contralateral muscles and into `cpgFrequency`, gain 3, 50 ms latency (one brain tick) |
| graze / klinotaxis | food-smell rate negative into `cpgTurn` (turn when it gets worse); food level into mouth open |
| bite on taste | mouth nutrition taste into bite |
| avoid wall | touch on one side into `cpgTurn` away |
| reproduce | `libido` into mate and lay |
| hunger seeks | `hunger` into `cpgAmplitude` |
| fear flees | `fear` into `cpgFrequency` and `cpgAmplitude` |

These alone make a Braitenberg-grade creature that swims, finds food by smell, eats, escapes and reproduces. That is the floor generation 0 stands on.

## 3.9 Running thousands of brains on WebGPU

### 3.9.1 Tick scheduling

- Physics runs at a fixed 60 Hz (assumed from the physics section).
- Brains tick at 20 Hz, `dt = 50 ms`. Creature `i` ticks when `(i + tick) mod 3 == 0`, so each sim tick processes a third of all brains and the load is flat.
- Motor outputs are held between brain ticks (zero-order hold) and smoothed by muscle lag in physics.
- The host's load governor can drop brains to 10 Hz (`mod 6`) before it drops the population or the physics rate. Behaviour degrades gracefully because time constants are in seconds, not ticks.
- Order within a sim tick: perception kernel (eyes, lateral line, touch, smell, internal) writes input buffers, then the brain kernel, then the action resolver, then physics.

### 3.9.2 Size classes and the fixed maximum

A brain belongs to the smallest class where both its non-input neuron count `N` and input count `I` fit:

| Class | N max | I max | Fan-in K | Brains per 256-thread workgroup | Typical creature |
|---|---|---|---|---|---|
| C0 | 16 | 32 | 8 | 16 | microbe |
| C1 | 32 | 64 | 8 | 8 | small grazer |
| C2 | 64 | 96 | 16 | 4 | small fish |
| C3 | 128 | 160 | 16 | 2 | Glimmerkin, hunters |
| C4 | 256 | 192 | 16 | 1 | giants, leviathans |

The hard maximum is 256 non-input neurons, 192 inputs and 16 synapses per neuron, so 4,096 synapses per brain. Workgroup memory per C4 brain is `(256 + 192) * 4 B = 1.8 KB`, and a full C0 workgroup uses `16 * 48 * 4 B = 3 KB`, both well inside WebGPU's guaranteed 16 KB `maxComputeWorkgroupStorageSize`. Each class has its own pool buffers with a free list; births take a slot, deaths return it. No compaction is needed because idle slots are skipped by an `alive` mask per workgroup (and slot reuse keeps occupancy high).

### 3.9.3 Sparse versus dense

| | Dense matrix per brain | Sparse ELL (fixed K per neuron) |
|---|---|---|
| C3 storage (weights only) | 128 x 288 x 2 B = 74 KB | 128 x 16 x 4 B = 8 KB |
| Work per neuron per tick | 288 multiply-adds | 16 multiply-adds |
| Access pattern | perfectly coalesced | coalesced on weight records, gather from workgroup memory for sources |
| Tensor cores | would help, but WebGPU has no stable matrix-core access (subgroup matrix extensions are experimental, unverified status) | not applicable |
| Plasticity | every weight is a candidate | only expressed synapses |

Sparse ELL wins by 9x on memory and 18x on arithmetic, and the gather is from workgroup memory, which is cheap. Evolved CPPN brains are sparse anyway because of LEO. Dense is not used.

### 3.9.4 Memory layout

Synapse record, packed in a `u32` pair so the shader needs no optional `shader-f16` feature (it uses the core `unpack2x16float`):

```
word0: bits 0..8  src local index (0..447, inputs first then neurons)
       bits 9..10 rule index
       bit  11    plastic
       bits 12..15 eta code (4-bit log scale)
       bits 16..31 w0 as f16
word1: dw as f32 (plastic pools only)
```

Non-plastic brains live in pools with 4-byte records; plastic brains use 8-byte records. Records are stored **slot-major** within a brain, `[brain][k][neuron]`, so the 32 threads of a subgroup reading slot `k` for neurons 0 to 31 touch consecutive words.

Neuron record (16 B): `y: f32`, `theta: f16, alpha: f16`, `phase: f32` (oscillators), `kind: u8, flags: u8, reserved: u16`.

WebGPU's default `maxStorageBufferBindingSize` is 128 MiB. The sim host requests the adapter maximum, and in any case pools are split into pages of at most 128 MiB, each its own bind group and dispatch, so the design works on adapters that refuse higher limits.

### 3.9.5 Kernel

One thread per neuron slot, `@workgroup_size(256)`:

```
load inputs[brain][0..I] and o_prev[brain][0..N] into var<workgroup> act
workgroupBarrier()
s = 0
for k in 0..K: rec = syn[brain][k][i]; s += w(rec) * act[src(rec)]
y += alpha * (s + noise - y); clamp
o = (kind == OSC) ? phaseUpdate() : tanh(y + theta)
workgroupBarrier()
act[I + i] = o                      // new outputs visible for plasticity
workgroupBarrier()
if plastic: for k in 0..K: dw += eta * m_r * (A o_i o_j + B o_i + C o_j + D) - decay*dw
write y, o; motor neurons also write to the action buffer
```

The loop order over `k` is fixed, so results are bitwise reproducible on the same GPU and driver. Across GPUs they differ in the last bits; the CPU reference implementation is the cross-platform oracle (tested to a tolerance, not bitwise). Modulation `m_+`, `m_-` comes from the previous tick's modulatory neuron outputs, which avoids an extra barrier.

### 3.9.6 Compute budget

Bandwidth dominates; arithmetic is negligible (about 2 flops per synapse plus about 8 for plasticity). RTX 5090 figures used: about 1.8 TB/s memory bandwidth, about 105 TFLOPS FP32, 32 GB (from memory, verify). Weak laptop: Iris Xe-class integrated GPU, about 2 TFLOPS, about 60 GB/s shared memory bandwidth of which about 40 GB/s is effective.

**RTX 5090, "full tank" scenario**

| Class | Brains | Synapse slots |
|---|---|---|
| C0 | 250,000 | 32.0 M |
| C2 | 40,000 | 41.0 M |
| C3 | 10,000 | 20.5 M |
| C4 | 500 | 2.0 M |
| **Total** | **300,500** | **95.5 M** |

- Memory: synapses 95.5 M x 6 B average (half plastic) = 0.57 GB, neurons (8.0 M neuron slots) x 16 B = 128 MB, inputs (13.5 M slots) x 4 B = 54 MB. About 0.75 GB of 32 GB.
- Per sim tick (one third of brains): 32 M synapses x 6 B read (191 MB) + plastic writes 16 M x 4 B (64 MB) + neuron read and write 2.7 M x 32 B (85 MB) + inputs 18 MB = about 0.36 GB. At 1.8 TB/s that is 0.2 ms; at a realistic 50 percent efficiency **0.4 ms**.
- Arithmetic per sim tick: 32 M x 10 = 0.32 GFLOP, 0.02 percent of peak per second at 60 Hz.
- Perception kernel: 300k creatures x up to 48 neighbours / 3 = 4.8 M neighbour evaluations per sim tick plus 1D bin splats. Budget **0.5 ms** (irregular spatial-hash access, not bandwidth-limited).
- Brain plus perception target: **at most 1.0 ms per 60 Hz sim tick**, about 6 percent of the frame. Brains are not the bottleneck; physics and rendering will be.

**Weak laptop scenario**

| Class | Brains | Synapse slots |
|---|---|---|
| C0 | 20,000 | 2.6 M |
| C2 | 3,000 | 3.1 M |
| C3 | 500 | 1.0 M |
| **Total** | **23,500** | **6.7 M** |

- Per sim tick: 2.2 M synapses x about 10 B with neuron and input traffic = 22 MB, about **0.55 ms** at 40 GB/s. Perception about 0.5 ms. Target **at most 1.5 ms** per sim tick, or run the sim at 30 Hz.

**CPU fallback (no WebGPU)**: the reference implementation in JS typed arrays (or WASM SIMD later). Estimated 50 to 100 M synapse updates per second per worker core with plasticity (to be measured). At 20 Hz, one core carries about 3 M synapse slots, roughly 5,000 small-to-medium brains. The host uses up to `cores - 2` workers.

**Development (births)**: on CPU workers, 0.5 GFLOP/s at a 2,000 births per second boom (3.6.3).

## 3.10 How behaviours can emerge

The rule: nothing below is scripted. Each behaviour needs (a) senses that carry the information, (b) outputs that can act on it, (c) a selective pressure in the tank that rewards it, and (d) a metric so we know it happened (also used by the camera director to find interesting moments).

| Behaviour | Senses and outputs used | Selective pressure | Head start | Detection metric |
|---|---|---|---|---|
| Grazing | food smell level and rate, taste, mouth open | plankton patches, light-grown plants | graze reflex | time with mouth open in food over 50 percent, low speed |
| Fleeing | proximity looming, lateral line, blood smell, fear drive, CPG frequency | predators | startle and fear reflexes | speed spike over 3x cruise within 200 ms of a predator approach |
| Schooling | eyes on conspecific glow, lateral line, sociality drive | predator confusion: predators' receptors see a blob, and bite success falls when several prey share the attacked bin; drag reduction behind neighbours if physics supports it; dilution | sociality drive exists but has no innate wiring to muscles | polarisation `|mean unit velocity|` over 0.6 and nearest-neighbour distance under 3 body lengths for 10 s or more ([Couzin et al. 2002](https://doi.org/10.1006/jtbi.2002.3065); predator confusion: [Olson et al. 2013](https://doi.org/10.1098/rsif.2013.0305)) |
| Ambush hunting | lateral line (works best when still), emit light as a lure, bite, long time constants | swimming cost rises with size; lateral-line self-noise | none beyond startle wiring reused as a strike | over 70 percent time near-stationary, then strikes over 5x cruise speed |
| Luring | emit intensity and hue, eyes of prey | prey attracted to glow resembling plankton | none | prey approach rate toward a stationary emitter vs control |
| Pack hunting | conspecific glow and pheromone, aggression, bite | prey larger than one predator can kill, shared carcass, kin nearby when budding is local | none | 2 or more conspecifics biting the same prey within 5 s, rate above a shuffled-identity baseline |
| Mimicry | glow colour and pattern genes, scent fingerprint; predators' colour receptors and plasticity | toxic species taste bad (pain modulation), predators learn or evolve aversion | none | appearance distance between a palatable species and a toxic one shrinking over generations |
| Parasitism | touch, latch, attached, host energy drain | free energy from hosts; hosts evolve itch-scraping | latch output exists only on suitable mouth types | fraction of a lineage's energy intake from attachment |
| Vertical migration, nocturnality | clocks, light, depth | visual predators near the lit surface by day | chronotype gene | correlation of depth with day clock |
| Counter-illumination | photophore, ambient light from above | predators below see silhouettes | none | ventral emission tracking `A(depth)` |

The behaviour classifier that produces these labels runs on the host every 2 s per creature from logged outputs, drives and neighbour data. It feeds the inspector, the stats view and the screensaver director's event stream (`hunt-start`, `strike`, `flee`, `school-formed`, `latch`).

## 3.11 Bootstrapping: the first generations must live

Random brains in a random world die out. Five layers of help, outermost first:

1. **Innate reflexes** (3.8.2) give every creature working swimming, feeding, escape and reproduction on day one. Experiment E1 checks this.
2. **CPG oscillators** mean swimming does not have to be discovered.
3. **Behaviour templates for William's designs.** In the god window's design tab William picks a template: grazer, hunter, ambusher, scavenger, schooler, parasite, drifter. A template is a CPPN genome plus reflex, drive and personality settings. Templates ship with the app, are pre-evolved offline for archetype bodies, and are body-independent because the CPPN reads coordinates, so they transfer to his custom body. Personality sliders edit the same genome genes listed in 3.7, matching "sliders and part editor edit the same genome".
4. **Nursery (optional "train before release").** When William releases a new design, the host can run a short headless micro-evolution in a sandbox: 64 individuals, about 200 generations, fitness = energy gained in 60 s simulated, around 30 s of wall time on the 5090 (estimate). Only brain genes and reflex gains are mutated; his body is kept. He sees a before and after clip and chooses which to release. Default off, so his designs stay his.
5. **Founder protection.** Founders spawn as 20 to 50 mutated copies with full energy. For the first 10 simulated minutes, if a designed species drops below 5 individuals it is reseeded from the founder genome once. Toggle per release; ignored for species that evolved naturally.

## 3.12 Interfaces and assumptions about other sections

- **Body section** provides, per creature, an organ list with stable organ gene ids, positions in the normalised frame `(u, v, d)`, organ type and parameters (eye FOV, receptors, colour bands; mouth type; photophore palette). Organs exist for the adult plan at birth.
- **Genome section** owns the mutation-rate gene, the reproduction mode gene, mating compatibility and the overall speciation distance. Brain genes are one module of the genome.
- **Physics** consumes muscle activations in [-1, 1] per joint and fin, applies muscle lag, and reports contacts, joint angles and damage. Physics runs at 60 Hz.
- **Ecosystem** owns the light field `A(depth)`, the chemical grid channels listed in 3.4.3, plankton density fields and the clocks.
- **Architecture** owns the sim host and its load governor. The god window subscribes to inspector streams over the same WebSocket.

## 3.13 Tooling: the brain inspector

A panel in the god window, opened by clicking a creature.

- **Glass-body view.** Because neurons sit at body coordinates, the default layout draws the creature as a faint silhouette with its neurons as glowing dots at their real positions: eyes at the eyes, ganglia along the spine, muscles at the joints. Brightness is `|o|`, hue is sign. Edges are drawn for the selected neuron, or the top 64 by current flow `|w * o_src|`. This fits the bioluminescent look and makes the "brain follows body" idea visible.
- **Schematic view.** Columns: inputs, drives and modulators, oscillators, hidden, motors, with names ("left eye r3 blue", "segment 4 muscle"). Reflex synapses in a separate colour, plastic synapses dashed.
- **Live traces.** Oscilloscope strips for up to 8 pinned neurons, drive bars, output bars, an eye strip showing what each eye sees as a 1D coloured image, smell levels, and the behaviour label history.
- **Plasticity heatmap.** `dw` per synapse, so William can watch learning happen.
- **CPPN view.** The CPPN graph, plus the weight pattern it paints from a chosen source neuron across the body (a heatmap on the silhouette), as in HyperNEAT papers.
- **Lineage diff.** Compare with parent or another individual: changed genes, added or removed synapses, personality deltas.
- **Experiments.** Lesion a neuron (clamp to 0), stimulate one (inject current), pause and single-step. These run on a **sandbox fork** of the creature and its neighbourhood, not the live world, so curiosity does not alter the persistent ecosystem unless William explicitly chooses "apply in world" (see open question 5).
- **Export** a brain and its genome as JSON for offline analysis in Python.

Data path: the god window sends `{type: "inspect", creatureId}`; the host then streams that brain's inputs and outputs each brain tick (at most 448 floats x 20 Hz, about 36 KB/s) plus static structure once. Up to 4 inspected at a time. The host reads them back with one small GPU-to-CPU copy per tick into a mapped staging buffer, which is cheap but must be asynchronous so it never stalls the sim.

## 3.14 Tests

**Unit and correctness (CI, CPU and, where a GPU runner exists, GPU)**

1. CTRNN step response of a single neuron matches `1 - exp(-t/tau)` within 1e-5 for tau in {50 ms, 1 s, 60 s}.
2. Oscillator: two coupled oscillators with lag `L` converge to phase difference `L` within 0.05 rad in 10 s for `k >= 2`.
3. GPU kernel vs CPU reference: 1,000 random brains of every class, 2,000 ticks, outputs agree within 1e-4 (non-plastic) and 1e-3 (plastic).
4. Determinism: same seed, same machine, 10,000 ticks, bitwise equal state hash. Snapshot at tick 5,000, restore, continue: identical hash.
5. Development: duplicating a fin gene produces a new muscle neuron whose incoming weights equal the original's within the CPPN's positional variation (and exactly, when the CPPN ignores `u`); unrelated neurons' weights are unchanged (stable ids).
6. Symmetry: a CPPN that uses only `|v|` yields mirror-equal left and right weights.
7. Caps: brains exceeding class limits are trimmed in the documented order; no out-of-range `src` index ever reaches the GPU (fuzz 100k random genomes).
8. Innovation hashing: the same structural mutation in two unrelated lineages yields the same id; crossover of two CPPNs aligns them.
9. Plasticity: ABCD rule on hand-set activations gives the expected `dw`; `dw` stays within `wMax`; with `plasticityOn <= 0` no weight changes; 10,000 updates of 1e-4 accumulate correctly in f32.
10. Sensors: a glowing disc at bearing 30 degrees lands in the right receptor bin; a nearer object occludes a farther one; objects outside FOV are invisible; red emission is invisible to a blue-only eye; lateral line falls off with distance squared and with own speed; smell rate input has the correct sign when swimming up a gradient.
11. Outputs: hysteresis and cooldowns hold; every action charges its energy cost; brain energy cost matches the formula.
12. NaN guard: injected NaN resets the brain and increments the counter.

**Behavioural arena tests (headless scenes, run nightly)**

13. Reflex-only grazer finds a food patch 20 body lengths away within 60 s in at least 90 percent of seeds.
14. Startle: a predator approaching at 2x prey speed triggers an escape in at least 80 percent of trials.
15. CPG swimmer covers at least 1 body length per second on a well-formed body, and visibly worse on a deliberately bad body (for example fins mounted backwards), confirming that brain and physics both matter.
16. Every shipped template keeps a population alive for 30 simulated minutes in the default tank in at least 9 of 10 seeds.

**Performance benchmarks (local, on William's PC and a laptop)**

17. Full-tank synthetic population: brain kernel at most 0.6 ms and perception at most 0.5 ms per sim tick on the 5090. Laptop scenario at most 1.5 ms combined. Fail the benchmark run on a 20 percent regression.
18. Development throughput: at least 2,000 C0 births per second on 2 workers.

## 3.15 Evolvability experiments

Each runs headless with 10 seeds, from a fixed starting tank, and reports a plot to the stats view. These validate design choices before William's world depends on them.

| ID | Question | Setup | Expected result |
|---|---|---|---|
| E1 | Is bootstrapping sufficient? | random brains vs reflexes only vs reflexes plus template | random brains go extinct within 5 generations; reflex lineages persist in at least 9 of 10 seeds |
| E2 | Does the body-anchored CPPN make body mutations less harmful? | apply forced segment and fin duplications; compare our encoding with a NEAT direct-encoding control where new organs start unconnected | swimming speed drop after a duplication at most 20 percent for ours, much larger for the control; faster body diversification over 1,000 generations |
| E3 | Do overrides (HybrID) help? | nursery swim-and-eat task: CPPN only vs CPPN plus overrides | overrides improve final fitness on irregular tasks, matching Clune et al. |
| E4 | When does plasticity evolve? | food colour that is nutritious flips every season vs never flips | `plasticityOn` frequency rises only in the flipping world (Soltoggio et al.) |
| E5 | Does schooling emerge? | visual predators with vs without the predator-confusion rule | polarisation and group size rise only with confusion on (Olson et al.) |
| E6 | Does mimicry emerge? | one toxic glowing species, palatable species, predators with colour vision and plasticity | palatable species' glow converges toward the toxic one's; none in a control with toxicity off |
| E7 | Does pack hunting emerge? | prey 4x predator mass that takes 3 bites to kill, local budding | co-attack rate above the shuffled baseline after about 500 generations (uncertain, may need kin structure) |
| E8 | Does brain size stay sane? | sweep the per-neuron cost `e_n` | at zero cost brains bloat to the cap; at default cost microbes stay near 16 neurons and predators grow larger brains than grazers |
| E9 | Is behaviour open-ended? | log behaviour descriptors (speed, depth, activity rhythm, sociality, diet) into a MAP-Elites-style grid used only for measurement ([Mouret and Clune 2015](https://arxiv.org/abs/1504.04909)) | number of occupied cells keeps rising over 24 simulated hours rather than plateauing in the first hour |

## 3.16 Failure modes and mitigations

| Failure | Mitigation |
|---|---|
| Brain bloat | absolute energy cost per neuron and synapse, size caps |
| Chaotic or saturated nets | state clamp, `tanh`, alpha in (0, 1], NaN guard |
| Exploits (spinning in place to farm something, physics glitches) | arena tests, behaviour metrics that flag odd outliers, sensor noise |
| Population-wide convergence on one strategy | speciation (genome section), diversity metrics from E9 on the stats view |
| A body mutation pushes a brain over a class limit | deterministic trimming; class chosen at birth only |
| Mutation rate gene runs away | bounded range in the genome section; brain operators scale with it |
| GPU and CPU drift apart | the CPU reference is the oracle; test 3 runs on every kernel change |
| Inspector readback stalls the sim | async staging buffers, at most 4 inspected creatures |

## 3.17 Prior art and references

URLs are from memory and were not verified in this session; treat them as unverified. No web searches were used for this section.

- Stanley, K. O. and Miikkulainen, R. (2002). Evolving neural networks through augmenting topologies (NEAT). http://nn.cs.utexas.edu/downloads/papers/stanley.ec02.pdf
- Stanley, K. O. (2007). Compositional pattern producing networks. http://eplex.cs.ucf.edu/papers/stanley_gpem07.pdf
- Stanley, K. O., D'Ambrosio, D. B. and Gauci, J. (2009). A hypercube-based encoding for evolving large-scale neural networks (HyperNEAT). http://eplex.cs.ucf.edu/papers/stanley_alife09.pdf
- Verbancsics, P. and Stanley, K. O. (2011). Constraining connectivity to encourage modularity in HyperNEAT (link expression output). http://eplex.cs.ucf.edu/papers/verbancsics_gecco11.pdf
- Risi, S. and Stanley, K. O. (2010). Indirectly encoding neural plasticity as a pattern of local rules (adaptive HyperNEAT). http://eplex.cs.ucf.edu/papers/risi_sab10.pdf
- Risi, S. and Stanley, K. O. (2012). An enhanced hypercube-based encoding for evolving the placement, density and connectivity of neurons (ES-HyperNEAT). http://eplex.cs.ucf.edu/papers/risi_alife12.pdf
- Clune, J., Stanley, K. O., Pennock, R. T. and Ofria, C. (2011). On the performance of indirect encoding across the continuum of regularity (HybrID). https://doi.org/10.1109/TEVC.2010.2104157
- Beer, R. D. (1995). On the dynamics of small continuous-time recurrent neural networks. https://journals.sagepub.com/doi/10.1177/105971239500300405
- Ijspeert, A. J. (2008). Central pattern generators for locomotion control in animals and robots: a review. https://doi.org/10.1016/j.neunet.2008.03.014
- Soltoggio, A. et al. (2008). Evolutionary advantages of neuromodulated plasticity in dynamic, reward-based scenarios. https://doi.org/10.7551/mitpress/9780262750172.003.0069
- Niv, Y., Joel, D., Meilijson, I. and Ruppin, E. (2002). Evolution of reinforcement learning in uncertain environments. https://doi.org/10.1177/1059712302010001001
- Hinton, G. E. and Nowlan, S. J. (1987). How learning can guide evolution (Baldwin effect). https://www.complex-systems.com/abstracts/v01_i03_a06/
- Sims, K. (1994). Evolving virtual creatures. https://www.karlsims.com/papers/siggraph94.pdf
- Yaeger, L. (1994). Computational genetics, physiology, metabolism, neural systems, learning, vision and behavior, or Polyworld. https://github.com/polyworld/polyworld
- Framsticks (neural control evolved with bodies). https://www.framsticks.com/
- Braitenberg, V. (1984). Vehicles: experiments in synthetic psychology. https://mitpress.mit.edu/9780262521123/vehicles/
- Couzin, I. D. et al. (2002). Collective memory and spatial sorting in animal groups. https://doi.org/10.1006/jtbi.2002.3065
- Olson, R. S. et al. (2013). Predator confusion is sufficient to evolve swarming behaviour. https://doi.org/10.1098/rsif.2013.0305
- Mouret, J.-B. and Clune, J. (2015). Illuminating search spaces by mapping elites (MAP-Elites). https://arxiv.org/abs/1504.04909
- The Bibites (evolving creatures with neural brains; genre prior art only, nothing copied). https://thebibites.com

## 3.18 Open questions for William

1. **Brain ceiling.** Is 256 neurons and 192 inputs per creature enough for leviathans, or do you want a C5 class (512 neurons) for a handful of giants? It is cheap in compute but enlarges development and the inspector.
2. **Inheritance of learning.** Default is no Lamarckism: learned weights die with the individual. Would you like an optional "culture" mechanism later (for example young imprinting on a parent's glow or route), which is biologically plausible and would show in the inspector?
3. **Nursery.** Should "train before release" default to off (your design exactly as drawn) or on (it swims well on release)?
4. **Hand-wiring.** Is choosing a template plus personality sliders enough in the part editor, or do you want a brain tab for hand-wiring override connections, an expert tool with stable neuron names?
5. **God interventions on brains.** Should lesion and stimulate be sandbox-only (default), or allowed in the live world as god powers (for example "make every predator fearless for an hour")?
