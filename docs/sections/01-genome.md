# 1. Genome, development and evolution

Status: draft for William's review. Owner of: genome encoding, development (genome to body), mutation, reproduction genetics, mate choice, species and phylogeny. Interfaces with: physics (section owning fluid forces and joints), brains (neural dynamics and the I/O slot semantics), ecology (food, metabolism constants), stats view and camera director (species events).

Web search was not used for this section. URLs in 1.16 are from memory; the ones marked (unverified) should be checked before the doc is published.

## 1.0 Key choices at a glance

1. **Encoding: a parametric body graph (Sims-style graph grammar) plus Hox-like regulatory genes, a fixed trait block, and a NEAT-style brain.** Every gene carries a historical marking (innovation id), which gives cheap alignment for crossover and genetic distance.
2. **Shape and size are separate.** Body genes are relative and unitless. One log-scale gene sets adult length (0.5 mm to 1 m), so size can creep upward without breaking the body plan. Allometry exponents per part handle the juvenile-to-adult change of shape.
3. **The body and the brain stay coupled under mutation.** Sensors feed fixed canonical brain slots by position, and actuators inherit their brain channel when duplicated. A duplicated fin swims straight away and a duplicated eye sees straight away.
4. **Variation is self-adaptive and costs something.** The per-gene mutation rate and step size are genes. Genome length costs replication energy, which bites hard on microbes and hardly at all on giants. Crossover takes structure from the parent that bears the offspring and alleles from both parents, aligned by innovation id.
5. **No design rules, only physics, metabolism and compute caps.** Species are genetic-distance clusters, tracked online with hysteresis and reconciled periodically. The phylogeny is a pruned individual tree plus a species tree that is kept for ever. Sliders map to trait genes and global modifier genes, and the part editor maps to module, link and regulatory genes through stable instance paths.

## 1.1 What the genome must do

From the brief, one genome must hold:

| Need | Where it lives |
|---|---|
| Body growth recipe (segments, limbs, fins, mouth, eyes, spikes, gut, light organs) | Body chromosome (module and link genes) and regulatory chromosome |
| Brain | Brain chromosome (neuron and synapse genes) |
| Behavioural parameters | Trait block, behaviour group (oscillator frequency, sensory gains, exploration noise, plasticity) |
| Life history: size at maturity, fertility, lifespan, reproduction mode | Trait block, life-history group |
| Mutation rate | Trait block, mutation group (self-adaptive) |
| Diet | Trait block (enzyme allocation) together with mouth and gut genes |
| Colour | Trait block, look group, plus per-module hue offsets and photophores |

Further requirements that drive the choice of encoding:

- **Editable by people:** sliders and a part editor must both edit it, and edits must round-trip.
- **Evolvable:** small mutations should mostly give small changes. Repetition (segments) and symmetry should be one mutation away. Size must be able to evolve over 3 orders of magnitude.
- **Crossable:** two parents with somewhat different body plans must still give a viable child often enough.
- **Cheap:** development runs at every birth and at growth stages, for populations of 10^4 to 10^5.
- **Deterministic:** the same genome and the same maturity give the same body bit for bit, on every machine.

## 1.2 Encoding options compared

| Option | How it works | Strengths | Weaknesses for Phylotank |
|---|---|---|---|
| **Direct encoding** (one gene per part, explicit parent index) | The genome is the phenotype list | Trivial development; trivial part editor | No reuse: 10 segments need 10 copies, so a "make all segments longer" mutation does not exist. Duplication is meaningless without homology. Genomes grow linearly with body complexity. Poor evolvability (Stanley and Miikkulainen 2003 taxonomy; Bongard 2002) |
| **L-system or graph grammar** (rewriting rules; Sims 1994 directed graphs are a parametric graph grammar) | Nodes are part types; edges are attachments with repeat, recursion and mirror flags. Development unfolds the graph | Compact; repetition, segmentation and symmetry are single genes; directly matches a part editor (a node is a part type); fast, bounded unfolding; proven for articulated swimmers (Sims 1994, Framsticks f4 developmental format) | Every copy of a node is identical unless something varies it along the body. Weak at smooth gradients (head to tail tapering) without help |
| **CPPN** (a small network maps body coordinates to tissue or part presence; Stanley 2007; Cheney et al. 2013 soft robots) | Query a function at each body location | Beautiful regularities, symmetry and gradients; good for voxel or soft bodies | Hard to express discrete parts (one mouth, two eyes, a proboscis). Hard to map to a part editor (William cannot drag a CPPN). Querying many points per birth costs more. Homology for crossover is fuzzy |
| **Gene regulatory network or developmental program** (cells divide and differentiate under GRN control; Eggenberger 1997, Bongard 2002) | Simulate embryogeny | Most biological; can produce modularity and novelty | Slow and opaque; long, chaotic development makes sliders and the editor nearly impossible; brittle (a small change can wreck the embryo); hard to bound in time and memory; hard to test |

**Choice: a hybrid built on the graph grammar.**

- **Backbone:** a Sims-style directed body graph (module genes are nodes, link genes are edges) with repeat counts, recursion limits, mirror and radial symmetry, and terminal-only links.
- **Regulatory layer (Hox-like):** a small set of regulatory genes reads two positional signals and one time signal: AP, the position along the main body axis from 0 at the head to 1 at the tail; side (left or right); and maturity m. Each regulatory gene scales or gates a parameter of the modules it targets. This adds the smooth gradients and position-specific identity that a pure grammar lacks, such as "segments get narrower towards the tail" or "only the first two segments carry legs". It also carries allometry and metamorphosis. A regulatory gene is a 16-byte record, not a running network, so development stays bounded and cheap.
- **Trait block:** a fixed-index vector of scalar genes for life history, mutation, diet, colour, mate choice, behaviour and global morphology modifiers. Every genome has the same layout, so sliders map to indices and crossover is trivial.
- **Brain:** NEAT-style node and connection genes with innovation ids (Stanley and Miikkulainen 2002). Input and output nodes are canonical slots that the body fills, so the brain survives body mutations.

The reasons, in order of weight:

1. The part editor and sliders must edit the genome directly, and graph nodes are exactly "part types".
2. Segmentation, duplication and symmetry are single mutations, which is the main source of evolvability in body plans (gene duplication then divergence; Ohno 1970).
3. Historical markings on every gene give alignment for crossover and a cheap distance for species.
4. Development is O(parts), bounded and deterministic.
5. The regulatory layer adds what CPPNs are good at (gradients, positional identity) for a few bytes, without a costly queried network.

## 1.3 Data structures and byte layouts

All multi-byte fields are little-endian. Within each chromosome, genes are stored sorted by innovation id, which makes alignment a merge walk. Quantised fields are decoded through the schema (1.3.3), so the binary form and the editor form are one and the same.

### 1.3.1 Genome container

```
Genome (variable length, typical 1.5 to 4 KB, hard cap 16 KB)
+-------------------------+ 0
| Header            32 B  |
+-------------------------+ 32
| TraitBlock   nTrait x 2 |   96 traits in format v1 -> 192 B
+-------------------------+
| ModuleGene[] nMod x 32  |   body nodes
+-------------------------+
| LinkGene[]   nLink x 20 |   body edges
+-------------------------+
| RegGene[]    nReg x 16  |   regulatory (Hox-like) genes
+-------------------------+
| NeuronGene[] nNeu x 8   |   hidden neurons only (I/O slots are implicit)
+-------------------------+
| SynapseGene[] nSyn x 16 |
+-------------------------+
```

### 1.3.2 Header (32 bytes)

| Offset | Type | Field | Notes |
|---|---|---|---|
| 0 | u32 | magic | `'PTG1'` |
| 4 | u16 | formatVersion | 1 |
| 6 | u16 | flags | bit0 designed by William; bit1 has been edited since birth; bit2 contains a silent root |
| 8 | u16 | nTrait | 96 in v1; older genomes are padded with schema defaults when loaded |
| 10 | u16 | nModule | at most 48 |
| 12 | u16 | nLink | at most 64 |
| 14 | u16 | nReg | at most 32 |
| 16 | u16 | nNeuron | hidden neurons, at most 128 (the brains section may lower this) |
| 18 | u16 | nSynapse | at most 512 |
| 20 | u32 | rootModuleInnov | innovation id of the root module (the head segment) |
| 24 | u32 | crc32 | over bytes 32 to end; catches corruption in snapshots |
| 28 | u32 | reserved | 0 |

Identity (organism id, parents, species) is **not** in the genome. It lives in the organism record (1.9.5), so identical genomes deduplicate by content hash.

### 1.3.3 Trait block (fixed index, u16 per trait)

Each trait is a u16 `q`. Its normalised value is `x = q / 65535`. The schema gives a range and a scale:

- linear: `v = min + x (max - min)`
- log: `v = min * (max / min)^x`

Mutation works in x space (1.6.1). On a log trait, a fixed step in x is therefore a fixed percentage change, which matters for size (1.5).

| Idx | Trait | Range | Scale | Slider group |
|---|---|---|---|---|
| 0 | ADULT_LENGTH | 0.5 mm to 1000 mm | log | Size |
| 1 | BIRTH_FRACTION (newborn length / adult) | 0.04 to 0.5 | log | Life |
| 2 | GROWTH_RATE (multiplier on the size-scaled clock) | 0.2 to 5 | log | Life |
| 3 | MATURITY_FRACTION (length fraction at maturity) | 0.3 to 0.95 | lin | Life |
| 4 | LIFESPAN_MULT (x time to maturity) | 1.5 to 20 | log | Life |
| 5 | SENESCENCE (how sharply mortality rises past lifespan) | 0 to 1 | lin | Life |
| 6 | CLUTCH_SIZE | 1 to 64 | log | Life |
| 7 | REPRO_RESERVE (energy fraction kept back before breeding) | 0.1 to 0.9 | lin | Life |
| 8 | SEX_PROB (chance a breeding attempt is sexual) | 0 to 1 | lin | Reproduction |
| 9 | MATE_PATIENCE (x maturity time to search before falling back to budding) | 0.05 to 5 | log | Reproduction |
| 10 | FAT_CAPACITY (fraction of body mass) | 0.05 to 0.5 | lin | Life |
| 11 | BROOD_INTERVAL (x maturity time between clutches) | 0.05 to 2 | log | Life |
| 12 to 15 | reserved | | | |
| 16 | MU_LOG (log10 per-gene point mutation chance) | -4 to -1 | lin | Mutation |
| 17 | MU_STRUCT_RATIO (structural events per point event) | 0.02 to 1 | log | Mutation |
| 18 | SIGMA (point step in x space) | 0.005 to 0.2 | log | Mutation |
| 19 | reserved | | | |
| 20 | DIET (0 plant enzymes, 1 meat enzymes) | 0 to 1 | lin | Diet |
| 21 | CARRION_TOLERANCE | 0 to 1 | lin | Diet |
| 22 | TEMP_OPTIMUM | world min to world max (about 2 to 30 C) | lin | Habitat |
| 23 | TEMP_TOLERANCE | 1 to 15 C | log | Habitat |
| 24 | DENSITY_BIAS (tissue density vs water; buoyancy) | 0.97 to 1.05 | lin | Habitat |
| 25 | TOXICITY (costly; damages whoever eats it) | 0 to 1 | lin | Diet |
| 26, 27 | reserved | | | |
| 28 to 31 | BODY_HUE, BODY_SAT, BODY_LUM, TRANSLUCENCY | 0 to 1 | lin | Look |
| 32 to 35 | GLOW_HUE, GLOW_BASE, PULSE_FREQ (0.05 to 4 Hz, log), PULSE_SHAPE | | | Look |
| 36 to 38 | PATTERN_KIND (stripes, bands, spots, countershade; quantised), PATTERN_FREQ, PATTERN_CONTRAST | | | Look |
| 39 | TRAIL_LENGTH (renderer only, costs nothing, drifts neutrally) | 0 to 1 | lin | Look |
| 40 to 42 | ODOUR_A, ODOUR_B, ODOUR_C (neutral chemical markers that drift and act as kin and species signals) | 0 to 1 | lin | hidden |
| 43 | reserved | | | |
| 44 | PREF_GLOW_HUE | 0 to 1 | lin (circular) | Mating |
| 45 | PREF_HUE_WIDTH | 0.02 to 0.5 | log | Mating |
| 46 | PREF_SIZE_RATIO (preferred mate length / own length) | 0.5 to 2 | log | Mating |
| 47 | PREF_PULSE | 0 to 1 | lin | Mating |
| 48 | PREF_ODOUR_WEIGHT | 0 to 1 | lin | Mating |
| 49 | CHOOSINESS | 0 to 1 | lin | Mating |
| 50, 51 | reserved | | | |
| 52 | CPG_BASE_FREQ (x size-scaled natural stroke frequency) | 0.25 to 4 | log | Behaviour |
| 53 | BRAIN_TAU_SCALE | 0.25 to 4 | log | Behaviour |
| 54 | EXPLORATION_NOISE | 0 to 0.3 | lin | Behaviour |
| 55 to 57 | GAIN_VISION, GAIN_LATERAL, GAIN_CHEMO | 0.25 to 4 | log | Behaviour |
| 58 | PLASTICITY_RATE (lifetime synapse learning; brains section) | 0 to 1 | lin | Behaviour |
| 59 | ALARM_EMIT (alarm scent released when hurt) | 0 to 1 | lin | Behaviour |
| 60 to 63 | reserved | | | |
| 64 | G_SLENDERNESS (global width scale) | 0.5 to 2 | log | Shape |
| 65 to 69 | G_FIN, G_EYE, G_MOUTH, G_SPIKE, G_ARMOUR (global part scales) | 0.5 to 2 | log | Shape |
| 70 | G_TAPER (head-to-tail narrowing) | 0.5 to 2 | log | Shape |
| 71 | G_STIFFNESS | 0.5 to 2 | log | Shape |
| 72 to 74 | G_PHOTOPHORE, G_GUT, G_LIMB_LENGTH | 0.5 to 2 | log | Shape |
| 75 to 95 | reserved for later versions | | | |

Global modifiers default to x = 0.5, which is 1.0 on a symmetric log range. They exist so that sliders have something to move that applies to every genome, and so that evolution has "scale all fins" mutations as well as "scale this fin" mutations.

### 1.3.4 Body chromosome

**ModuleGene (32 bytes): a node of the body graph, meaning one part type.**

| Off | Type | Field | Meaning (decoded) |
|---|---|---|---|
| 0 | u32 | innov | historical marking |
| 4 | u8 | kind | 0 SEGMENT, 1 FIN, 2 LIMB, 3 MOUTH, 4 EYE, 5 CHEMO, 6 SPIKE, 7 PHOTOPHORE |
| 5 | u8 | subtype | kind-specific (table below) |
| 6 | u8 | flags | bit0 enabled; bit1 root; bit2 bilateral-pair default |
| 7 | u8 | recursionLimit | 0 to 7: how many times this node may recur on one path |
| 8 | u16 | length | log, 0.05 to 4 x the parent's reference length |
| 10 | u16 | width | log, aspect 0.05 to 2 (width / length) |
| 12 | u8 | span | log, out-of-plane depth / width, 0.5 to 8 (fins are thin in plane but wide out of plane) |
| 13 | u8 | taper | 0 to 1: tip width / base width |
| 14 | u8 | stiffness | log, joint spring 0.1 to 10 (x size-scaled reference) |
| 15 | u8 | density | lin, 0.6 to 2.5 x soft tissue (membrane, flesh, armour) |
| 16 | u8 | muscleFraction | 0 to 0.8 of part mass |
| 17 | u8 | gutFraction | SEGMENT only, 0 to 0.7 of volume |
| 18 | u8 | armourCoverage | SEGMENT and LIMB, 0 to 1 |
| 19 | i8 | hueOffset | -0.5 to 0.5 added to BODY_HUE |
| 20 | u8 | glow | resting glow of the part surface, 0 to 1 |
| 21 | u8 | p1 | kind-specific (eye radius, antenna length, mouth gape, spike length, lateral-line density) |
| 22 | u8 | p2 | kind-specific (eye acuity versus sensitivity, chemo channel mask, filter mesh, photophore pulse multiplier) |
| 23 | u8 | cpgPhase | 0 to 2 pi phase of this part's oscillator |
| 24 | u8 | cpgAmp | 0 to 1 stroke amplitude |
| 25 | u8 | jointRange | 0 to 170 degrees |
| 26 | i8 | jointRest | -90 to 90 degrees rest angle |
| 27 | u8 | allometry | exponent alpha, 0.5 to 1.5 (128 is 1.0, isometric) |
| 28 | u8 | brainChannel | which actuator channel drives this part (0 to 15), or 255 for passive |
| 29 | u8 | channelSign | bit0 invert, bit1 mirror-invert on the left copy |
| 30 | u16 | reserved | 0 |

Subtypes:

| Kind | Subtypes |
|---|---|
| SEGMENT | 0 trunk, 1 head (holds the brain), 2 bell (radial body) |
| FIN | 0 paddle, 1 fringe (low aspect), 2 tail fluke |
| LIMB | 0 jointed (rigid links), 1 tentacle (soft, many joints), 2 whip (flagellum: thin, travelling wave) |
| MOUTH | 0 FILTER, 1 JAWS, 2 RASP, 3 PROBOSCIS |
| EYE | 0 cup (wide field, cheap, low acuity), 1 lens (narrow field, costly, acute) |
| CHEMO | 0 pit (on the body), 1 antenna, 2 barbel |
| SPIKE | 0 straight, 1 hooked (raises the chance of injuring something that bites it) |
| PHOTOPHORE | 0 spot, 1 strip, 2 lure (pulses under brain control) |

**LinkGene (20 bytes): an edge of the body graph, meaning "attach child type to parent type".**

| Off | Type | Field | Meaning |
|---|---|---|---|
| 0 | u32 | innov | historical marking |
| 4 | u32 | fromInnov | parent module |
| 8 | u32 | toInnov | child module (may equal fromInnov: recursion gives chains) |
| 12 | u8 | attachPos | 0 to 255 along the parent from base to tip (255 is the tip) |
| 13 | i8 | attachAngle | -180 to 180 degrees (1.41 degree steps) relative to the parent axis |
| 14 | u8 | repeat | 1 to 16 copies in series along the attach line (segments, ribs, rows of photophores) |
| 15 | u8 | symmetry | 0 none, 1 mirror (adds the reflected copy across the parent axis), 2 radial (repeat copies spread evenly around the parent) |
| 16 | u8 | childScale | log, 0.25 to 2: child reference length relative to parent |
| 17 | u8 | repeatScale | log, 0.7 to 1.3: geometric scale per repeat (tapering tails, growing tentacle rings) |
| 18 | u8 | flags | bit0 enabled; bit1 terminalOnly (only where recursion stops); bit2 phaseWave (phase advances along repeats) |
| 19 | u8 | phaseStep | 0 to 2 pi phase step per repeat when phaseWave is set (gives a travelling wave) |

### 1.3.5 Regulatory chromosome

**RegGene (16 bytes): a Hox-like positional or temporal modifier.**

| Off | Type | Field | Meaning |
|---|---|---|---|
| 0 | u32 | innov | historical marking |
| 4 | u32 | targetInnov | a module innov, or 0 for "every module of targetKind" |
| 8 | u8 | targetKind | used when targetInnov is 0; 255 means every kind |
| 9 | u8 | axis | 0 AP (0 head to 1 tail), 1 SIDE (-1 left, +1 right), 2 MATURITY m (0 birth to 1 adult), 3 DEPTH_AT_BIRTH (plasticity; see open question 5) |
| 10 | u8 | param | which ModuleGene field to modulate, or 254 to gate expression (express or suppress) |
| 11 | u8 | shape | 0 gaussian bump, 1 rising sigmoid, 2 falling sigmoid, 3 band (hard window) |
| 12 | u8 | centre | 0 to 1 on the axis |
| 13 | u8 | width | 0.01 to 1 |
| 14 | i8 | amount | log factor, -1 to 1 (x0.37 to x2.7) for scalar params; sign means express or suppress for gating |
| 15 | u8 | flags | bit0 enabled |

Two examples. "Legs only in the front third" is a band gate on LIMB along AP. "A larva has no jaws and then grows them" is a rising-sigmoid gate on the jaws module along MATURITY, centred at 0.4, which gives metamorphosis.

### 1.3.6 Brain chromosome

The brains section owns the neural dynamics and the meaning of each slot. This section owns the encoding and the body-to-brain contract.

**NeuronGene (8 bytes):** u32 innov; u8 activation (tanh, sigmoid, sin, gaussian, relu, identity, latch); u8 tau (log, leak time constant 0.02 to 5 s, scaled by BRAIN_TAU_SCALE); i16 bias (Q4.11, about -16 to 16).

**SynapseGene (16 bytes):** u32 innov; u32 srcInnov; u32 dstInnov; i16 weight (Q4.11, -16 to 16); u8 flags (bit0 enabled, bit1 modulatory); i8 plasticity (Hebbian coefficient, brains section).

**Implicit I/O nodes.** Innovation ids 1 to 63 are reserved for input slots and 64 to 95 for output slots. They exist in every genome without being stored, so synapses can always reference them. The body fills the input slots and reads the output slots:

| Inputs (provisional, brains section finalises) | Count | Filled by |
|---|---|---|
| Vision: 8 sectors around the body x (brightness, hue, apparent size) | 24 | all EYE parts; each sector takes the best eye covering it; zero if no eye covers it |
| Lateral line: front, rear, above, below pressure | 4 | lateral-line density on SEGMENTs |
| Chemo: plant scent, meat or blood scent, kin odour, alarm, each as (concentration, gradient along the body axis) | 8 | CHEMO parts |
| Body: energy, health, gut fullness, age / lifespan, maturity, pain, touch front, touch rear, attached (parasite) | 9 | always present |
| World: light level, temperature error, depth, day phase sin and cos | 5 | always present (proprioception and skin) |
| Constant 1 and a noise source | 2 | always present |

| Outputs | Count | Drives |
|---|---|---|
| 16 actuator channels (amplitude and bias, 8 pairs) | 16 | parts whose brainChannel matches; each part's oscillator runs at CPG_BASE_FREQ with its own phase, and the channel scales its amplitude and bias |
| Global stroke frequency multiplier | 1 | all oscillators |
| Mouth (open or bite, or attach for a proboscis) | 1 | MOUTH parts |
| Glow intensity, glow pulse | 2 | PHOTOPHORE parts and surface glow |
| Mate readiness, lay or bud | 2 | reproduction |
| Emit pheromone | 1 | chemo field |

Why fixed slots: they keep the GPU brain kernel a fixed shape, and they make body mutations brain-safe. Adding a second eye improves the quality of the vision slots the brain already reads, and does not create a new neuron the brain has never seen. Moving an eye from the side to the front changes which sectors it covers, so field of view (panoramic prey versus binocular predator) is a body trait selected through behaviour.

### 1.3.7 Innovation registry (world-global)

```ts
interface InnovationRegistry {
  next: u32;                            // monotonically increasing, saved with the world
  recent: Map<u64 /*eventKey*/, u32>;   // structural event -> innov, sliding window
  windowBirths: number;                 // default 100_000 births
}
// eventKey = hash(kind of event, srcInnov, dstInnov or parentInnov, subtype)
function innovFor(key: u64): u32 {
  const hit = reg.recent.get(key);
  if (hit !== undefined) return hit;    // the same mutation in two lineages gets the same id
  const id = reg.next++; reg.recent.set(key, id); return id;
}
```

Reusing ids for identical structural events inside the window (as NEAT does within a generation) raises homology between independent lineages, which helps crossover. Ids 1 to 4095 are reserved: 1 to 95 for brain I/O, the rest for the built-in templates. Overflow: about 0.05 structural events per birth at 2,000 births/s uses 2^32 ids in about 1.4 years. When `next` passes 2^31, the host runs an offline compaction that renumbers every live gene and every stored snapshot through one remapping table, at its next save.

### 1.3.8 Sizes and memory

A typical evolved mid-size creature has 192 B of traits, 14 modules (448 B), 20 links (400 B), 8 regulatory genes (128 B), 20 hidden neurons (160 B) and 150 synapses (2,400 B), about 3.8 KB in all. Microbes are under 1 KB.

Genomes are immutable, content-addressed blobs (keyed by a 64-bit xxHash). Clones from budding with zero mutations share one blob.

- 5090 host, 200k creatures: at most 760 MB, realistically about 300 MB after deduplication.
- Weak laptop host, 10k creatures: about 30 MB.

Genomes stay on the host. The GPU only receives the compiled phenotype (1.4.5) and the compiled brain.

## 1.4 Development: from genome to a 2D articulated body

### 1.4.1 Pipeline

Development is a pure function: `develop(genome, m, envAtBirth) -> Phenotype`, where `m` is maturity in [0, 1]. It runs:

- **in full** at birth and whenever a MATURITY-axis gate changes expression (metamorphosis);
- **as a cheap restage** (scale pass only) at each growth stage. A new stage starts when length has changed by 4% since the last one, which gives about 15 to 40 stages per life.

```ts
const MAX_PARTS = 64;      // world config; 32 on a laptop-host world
function develop(g: Genome, m: number, env: BirthEnv): Phenotype {
  // 1. unfold the body graph breadth-first from the root (BFS: when capped, distal parts go first)
  const parts: PartTmp[] = [];
  const q = new Queue<Item>();
  q.push({ mod: g.root, parent: -1, refLen: 1, path: [], recur: new Uint8Array(g.nModule),
           side: 0, phase: 0 });
  while (!q.empty() && parts.length < MAX_PARTS) {
    const it = q.pop();
    const idx = parts.push(instantiate(g, it)) - 1;
    for (const L of g.outLinks(it.mod)) {                 // sorted by innov: deterministic
      if (!L.enabled || !g.module(L.to).enabled) continue;
      const rec = it.recur[L.toIdx];
      const terminal = rec >= g.module(L.to).recursionLimit;
      if (L.to === it.mod && terminal) continue;          // recursion exhausted
      if (L.terminalOnly && !isTerminal(it)) continue;
      for (let r = 0; r < L.repeat; r++)
        for (const s of sidesOf(L.symmetry, L.repeat, r)) // none | mirror pair | radial angle
          q.push({ mod: L.to, parent: idx,
                   refLen: it.refLen * L.childScale * L.repeatScale ** r,
                   attachPos: seriesPos(L.attachPos, r, L.repeat), angle: s.angle,
                   side: s.side || it.side, recur: bump(it.recur, L.toIdx),
                   phase: it.phase + (L.phaseWave ? r * L.phaseStep : 0),
                   path: [...it.path, { link: L.innov, r, side: s.side }] });
    }
  }
  // 2. positional signals
  computeAP(parts);            // AP = distance along the root chain (head 0 to tail 1); appendages inherit their host's AP
  // 3. regulation: each RegGene multiplies or gates the params of matching parts
  for (const R of g.reg) if (R.enabled) for (const p of parts) if (targets(R, p)) {
    const t = R.axis === AP ? p.ap : R.axis === SIDE ? p.side : R.axis === MATURITY ? m : env.depth01;
    const f = shapeFn(R.shape, t, R.centre, R.width);   // in [0, 1]
    if (R.param === GATE) p.expressed = (R.amount > 0) ? p.expressed || f > 0.5 : p.expressed && f <= 0.5;
    else p[R.param] *= Math.exp(R.amount * f);
  }
  dropUnexpressed(parts);      // removes the part and its subtree
  // 4. global modifiers from the trait block (G_FIN etc.), then allometry, then absolute size
  applyGlobalModifiers(parts, g.traits);
  const L = lengthAt(m, g.traits);                      // von Bertalanffy, 1.4.4
  const Ladult = g.traits.ADULT_LENGTH;
  for (const p of parts) p.len *= (L / Ladult) ** (p.alpha - 1);   // relative allometry
  normaliseBodyLength(parts, L);                        // the root chain spans exactly L
  // 5. clamp for solver safety (1.11.2), derive physical and sensory quantities
  clampForSolver(parts);
  return derive(parts, g);   // mass, areas, inertia, gut volume, gape, I/O maps, costs
}
```

Complexity is O(parts + genes x parts) for regulation: at most 64 x 32 = 2,048 cheap tests. Allocations are pooled. The `path` arrays are only materialised in editor mode; the sim keeps a 32-bit path hash.

### 1.4.2 Part catalogue: what each part does physically

The world is a 2D side view: x is horizontal, y is depth. Each part is a **tapered capsule** with in-plane length `l`, in-plane width `w` and out-of-plane span `h = span x w`. Physics uses `h` for fluid force and mass. The renderer draws fins and photophore strips as glowing membranes whose visual extent follows `h`. Mass is `rho x l x w x h x shapeFactor`. Under isometric scaling, mass therefore goes as L^3, so 3D metabolic scaling laws apply honestly.

Each part joins its parent by a **revolute joint** at the attach point, with a rest angle, a range limit, a spring (stiffness gene x reference that scales with cross-section, ~w x h) and damping. Muscle torque is limited by muscle cross-section, `tau_max ~ sigma_muscle x muscleFraction x w x h x leverArm`. The joint target angle follows the oscillator:

```
theta_target(t) = rest + range * cpgAmp * A_ch(t) * sin(2*pi*f*t + phase_part) + B_ch(t)
f = CPG_BASE_FREQ * f_nat(L) * F_brain(t),   f_nat(L) = f0 * (L / 1 cm)^(-1/2)
```

Here `A_ch` and `B_ch` are the amplitude and bias outputs of the part's brain channel, and `F_brain` is the global frequency output. The physics section owns the integrator.

| Part | Physical role (all mediated by physics or metabolism) | Main costs |
|---|---|---|
| **SEGMENT** (trunk, head, bell) | Body mass, volume for the gut, armour carrier, lateral-line carrier. Chains of segments with phaseWave links give undulation (eel or worm). A head segment holds the brain. A bell with radial children gives jellyfish forms; bell contraction is the joint motion of its radial children | Maintenance proportional to mass; drag proportional to the frontal span |
| **FIN** paddle, fringe, fluke | Thin in plane, large `h`, low density (membrane). Fluid force is anisotropic, normal much greater than tangential, so a stroke normal to the fin gives thrust. Fin area x stroke speed^2 sets thrust at high Reynolds number | Drag when not stroking; muscle mass to drive it |
| **LIMB** jointed, tentacle, whip | Jointed: paddles, steering, grabbing at contact (a rigid chain). Tentacle: recursion gives a soft chain with a sticky tip that holds prey at contact. Whip: a thin chain driven as a travelling wave, the only thing that swims at low Reynolds number (1.5.2) | Mass, drag, control (needs channels) |
| **MOUTH** FILTER | Intake = mouth area x relative water speed x particle concentration, for particles below the mesh size (p2). Passive while swimming. Works for microbes and for giant filter feeders | Drag of the open mouth (mouth output opens it) |
| **MOUTH** JAWS | Gape `g = gapeGene x headWidth`. Prey with handling size < g is swallowed whole. Larger prey and corpses lose bites of size ~g^2 x biteForce, where biteForce ~ jaw muscle cross-section | Heavy head; turning inertia |
| **MOUTH** RASP | At contact, removes mass at a rate ~ rasp width x contact time from plants, biofilm, corpses or living flesh. The grazer and scavenger tool | Slow intake |
| **MOUTH** PROBOSCIS | At contact with a host more than 2x the parasite's length, the attach output forms a physics joint. Drain rate ~ proboscis width^2. Attachment breaks when the joint force exceeds an attach strength ~ width, so hosts can shake parasites off by violent motion, and armour lowers the chance of attaching. Parasites ride along and add drag to the host | Can rarely feed otherwise; host defences |
| **EYE** cup, lens | Fills the vision sectors within its field of view (cup about 200 degrees, lens about 90 degrees, centred on the outward normal). Detection range ~ eye radius x sqrt(target brightness). In the dark deep, only glowing things are visible | Neural tissue: maintenance factor 4 (eyes are costly, so cave dwellers lose them) |
| **CHEMO** pit, antenna, barbel | Fills the chemo slots. Gradient resolution ~ antenna length (the baseline between the two ends) | Small mass; antennae add drag |
| Lateral line (a SEGMENT field, p1) | Senses pressure from nearby moving bodies, ~ size x speed / distance^3, and works in the dark. Range ~ coverage x body length | Small maintenance |
| **SPIKE** | Damages whatever touches it at relative speed v: damage ~ spike length x v (hooked spikes add bleeding). Adds 2 x spike length to the handling size seen by jaws, so a spiny creature may be too big to swallow | Mass, drag |
| Armour (armourCoverage on SEGMENT and LIMB) | Damage is reduced by coverage x hardness. Density becomes 2.5x soft tissue, and the joint range shrinks by `(1 - 0.6 x coverage)` | Heavy and stiff, so it swims slower |
| Gut (gutFraction on SEGMENT) | Capacity = sum of the gut volumes. Plant digestion efficiency rises with gut length relative to body length (retention time); meat digests fast in a short gut. Efficiencies also depend on DIET: `e_plant = e_p,max x (1 - DIET) x (1 - exp(-gutLen/(0.6 L)))`, `e_meat = e_m,max x DIET` | Gut tissue maintenance factor 1.5 |
| **PHOTOPHORE** spot, strip, lure | Emits light at GLOW_HUE plus its hue offset, driven by the glow outputs. Other creatures see it (signalling, mate choice, schooling). A lure on the tip of a limb exploits prey that evolved to approach glowing plankton. Glow along the belly can counter-illuminate against the light from above | Energy per second ~ intensity x area while lit |

A creature with no mouth cannot eat and starves. A creature with no fins or limbs drifts. Neither is forbidden: drifting filter feeders with a big open mouth may well be viable in a current.

### 1.4.3 Derived quantities (the Phenotype contract)

`derive()` computes, once per stage:

- **Mass and inertia:** total mass M, centre of mass, moment of inertia, buoyant mass `M x (1 - 1/DENSITY_BIAS)` (also includes fat).
- **Hydrodynamic summaries:** frontal span, wetted area. These are for the camera director and stats only; the physics uses per-part geometry.
- **Metabolism:** basal rate `B = b0 x M^0.75 x (sum_i w_i m_i / M)`, where `w_i` is the tissue factor (soft 1, muscle 1.2, neural and eye 4, gut 1.5, armour 0.3, membrane 0.5, photophore 2 when lit and 0.5 when dark), plus brain cost `c_n x (nNeurons + 0.1 x nSynapses)`. `b0` is an ecology constant. The exponent 0.75 is world constant KLEIBER_EXP (see 1.5 and open question 2).
- **Feeding:** gape, bite force, filter area and mesh, rasp width, proboscis width, gut capacity, `e_plant`, `e_meat`.
- **Defence:** handling size (body width plus 2 x spike length), armour damage factor, spike damage factor, toxicity.
- **Sensing:** per-sector eye maps (which eye covers which sector, with range and acuity), lateral-line range, chemo gains.
- **Actuation:** a joint-to-channel table, oscillator phases and amplitudes.
- **Build energy:** `E_body = sum_i m_i x energyDensity_i`, used for growth cost and offspring cost (1.7).

### 1.4.4 Allometric growth, juvenile to adult

**Length** follows von Bertalanffy growth on a size-scaled clock:

```
L(t) = L_inf - (L_inf - L_0) * exp(-k * t)
L_inf = ADULT_LENGTH / 0.98            (so the adult reaches ADULT_LENGTH at a finite time)
L_0   = BIRTH_FRACTION * ADULT_LENGTH
k     = GROWTH_RATE * k0 * (ADULT_LENGTH / 1 cm)^(-3 * (1 - KLEIBER_EXP))   (= L^-0.75 at KLEIBER_EXP 0.75)
m     = (L - L_0) / (ADULT_LENGTH - L_0)          maturity in [0, 1]
mature when L >= MATURITY_FRACTION * ADULT_LENGTH
lifespan = LIFESPAN_MULT * t_maturity
```

Growth only happens when energy allows. The cost of a stage is `(E_body(new) - E_body(old)) x 1.3` (30% construction overhead). A starving juvenile stops growing, so stunting is real.

**Shape** changes through two mechanisms:

1. **Per-part allometry exponent alpha.** At body length L, each part has `l_i = l_i,adult x (L / L_adult)^alpha_i`. Eyes and heads with alpha < 1 are relatively big in juveniles; jaws and fins with alpha > 1 grow into adult proportions. Adult designs are what William edits, and juveniles derive from them.
2. **MATURITY-axis regulatory genes** gate whole modules on or off at a maturity threshold (larva to adult metamorphosis), or scale params smoothly.

Gonads are implicit: reproduction outputs do nothing before maturity. Juveniles therefore do not pay breeding costs, but they also cannot breed.

### 1.4.5 Compiled phenotype (what the GPU receives)

Structure-of-arrays slices in a world-wide part pool. Each creature owns a contiguous range `[partStart, partStart + nParts)`.

| Field | Type | Bytes |
|---|---|---|
| parent (local index, 255 for root) | u8 | 1 |
| kind, subtype | u8, u8 | 2 |
| side (-1, 0, 1), brainChannel | i8, u8 | 2 |
| attach offset along parent, attach angle | f16, f16 | 4 |
| length, width, span, taper | f16 x 4 | 8 |
| mass, inertia | f32, f32 | 8 |
| stiffness, damping, rest, range | f16 x 4 | 8 |
| tauMax, cpgPhase, cpgAmp | f16 x 3 | 6 |
| drag coefficients normal and tangential | f16 x 2 | 4 |
| colour (packed RGBA8), glow (f16), glow pulse multiplier (f16) | u32, f16, f16 | 8 |
| p1, p2 (kind-specific, decoded) | f16 x 2 | 4 |
| **total** | | **55 B, padded to 64 B** |

At 200k creatures x 20 parts average, the part pool is 4M parts x 64 B = 256 MB of VRAM. That fits the 5090's 32 GB easily, but it is the biggest buffer, so the physics section may trim fields. At 10k creatures (laptop host) it is 13 MB. Per-creature records (mass, B, gape, sensor maps and so on) live in a separate SoA of about 256 B per creature.

### 1.4.6 Development budget

| Operation | Rate (5090 host, 200k pop, mean life 120 s) | Target cost | Load |
|---|---|---|---|
| Full develop at birth | 1,700/s | 20 us (modern desktop core); 80 us on a weak laptop | 3.4% of one core |
| Restage (scale pass) | about 50,000/s (30 stages per life) | 3 us | 15% of one core |
| Mutation | 1,700/s | 5 us | under 1% |
| Crossover (when sexual) | under 1,700/s | 10 us | under 2% |
| Species distance (1 to 5 per birth) | under 8,500/s | 1.5 us | about 1% |

All of this runs in one or two host worker threads. Births are batched per tick, and the compiled parts are uploaded in one buffer write per tick. A laptop host (10k pop) needs under 2% of a core. These numbers are targets; benchmark B1 (1.14.4) measures them.

## 1.5 Scale: microbes to leviathans

### 1.5.1 Range

ADULT_LENGTH spans **0.5 mm to 1,000 mm**, a factor of 2,000 (3.3 orders). Mass spans 2,000^3 = 8 x 10^9. The range is two schema constants, so it can be widened. The world section decides the tank size: a 1 m leviathan needs a tank of tens of metres for room to swim, which means the seamless zoom spans about 4.5 orders from microbe to whole tank.

The Reynolds number `Re = rho v L / mu` runs from about 0.25 (a 0.5 mm microbe at 0.5 mm/s) to about 5 x 10^5 (a 1 m giant at 0.5 m/s). It therefore crosses from viscous to inertial flow, and different body plans win at different sizes **without any hand rule**, provided the physics uses a drag law that blends both regimes. The contract to the physics section: per part, normal and tangential drag with `C(Re)` blending a Stokes term and a quadratic term, and an anisotropy ratio `C_n/C_t` of about 2 at low Re (resistive force theory). Consequences:

- **Low Re (microbes):** reciprocal strokes go nowhere (Purcell's scallop theorem), so only travelling waves (whips) and non-reciprocal beats swim. Paddles fail. Coasting is impossible.
- **High Re (fish to leviathans):** fins and flukes with large stroke amplitude win, coasting works, and streamlining pays.

### 1.5.2 How body size can evolve upward

Big bodies must be reachable by small steps, and pay off when ecology favours them.

1. **Size is one log gene, decoupled from shape.** A mutation with SIGMA = 0.01 changes length by 2,000^0.01, about 7.9%, at any size. A 2,000x increase needs about 100 net steps in one direction, which is easy for directional selection over hundreds of generations.
2. **Shape is relative.** All body genes are relative to the parent's reference length, so scaling up keeps the plan intact. What changes is physics: drag regime, turning inertia, stroke frequency `f_nat ~ L^-1/2`. That is selection, not breakage.
3. **Payoffs of size, all emergent:**
   - Gape grows with head width, so a bigger creature can eat more kinds of prey.
   - Few predators can swallow it.
   - Mass-specific metabolism falls as M^-0.25, so it can fast longer: reserves ~ M while burn ~ M^0.75.
   - It has more thermal inertia, which matters in cold snaps (ecology).
   - Its absolute speed is higher.
   - A giant filter mouth processes more water.
4. **Costs of size, also emergent:** slower maturation (`t_mat ~ L^0.75`), more food needed, larger turning radius, an easier target for parasites, and fewer offspring per unit of energy.
5. **Generation-time scaling.** With KLEIBER_EXP = 0.75, generation time scales as L^0.75, so a 1 m giant's generation is 2,000^0.75, about 300x a microbe's. If microbes breed every 30 s, giants breed about every 2.5 h of sim time. That suits a persistent world, but evolution of giants will be slow to watch. Two levers exist: run the world faster when only the wallpaper is watching, or flatten KLEIBER_EXP to 0.85, which gives about 30x (open question 2).
6. **Carrying capacity must allow giants.** The population of a size class is roughly `K ~ productivity / (b0 M^0.75)`. The ecology section must make sure the tank's productivity supports at least a handful of leviathans. Otherwise giants never evolve, because a population of fewer than about 5 goes extinct by chance.
7. **Compute cost does not scale with size.** A leviathan uses the same at most 64 parts as anything else. The renderer adds detail (texture, glow trails), not simulated parts.

## 1.6 Mutation

### 1.6.1 Point mutations

```ts
function mutate(parent: Genome, rng: Rng, reg: InnovationRegistry): Genome {
  const g = parent.cloneMutable();
  const mu = 10 ** g.traits.MU_LOG;               // per gene
  const sigma = g.traits.SIGMA;
  // self-adaptation first (Schwefel-style log-normal), with a fixed meta-rate
  g.setX(MU_LOG,  reflect01(g.x(MU_LOG)  + 0.02 * rng.normal()));
  g.setX(SIGMA,   reflect01(g.x(SIGMA)   + 0.02 * rng.normal()));
  g.setX(MU_STRUCT_RATIO, reflect01(g.x(MU_STRUCT_RATIO) + 0.02 * rng.normal()));
  const nGenes = g.countGenes();                  // traits + modules + links + regs + neurons + synapses
  // point mutations: Poisson(mu * nGenes); each picks one gene, then one field
  for (let k = rng.poisson(mu * nGenes); k > 0; k--) {
    const gene = g.randomGene(rng);
    const f = gene.randomMutableField(rng);
    if (f.discrete) { if (rng.u() < 0.1) f.set(f.randomNeighbour(rng)); }  // kind and subtype rarely
    else f.setX(reflect01(f.x + sigma * rng.normal() * f.sensitivity));
  }
  // structural events: Poisson(mu * ratio * nStruct)
  const nStruct = g.nModule + g.nLink + g.nReg + g.nNeuron + g.nSynapse;
  for (let k = rng.poisson(mu * g.traits.MU_STRUCT_RATIO * nStruct); k > 0; k--)
    applyStructural(g, pickOperator(rng), rng, reg);
  repair(g);                        // 1.7.4, deterministic
  if (g.byteLength() > 16384) return parent;   // over the cap: the mutation is a no-op
  return g.freeze();
}
```

`reflect01` reflects at 0 and 1, so a gene never sticks at a bound. `f.sensitivity` is a per-field schema factor (for example 0.5 on attachAngle) so that typical steps have similar phenotypic effect.

Weights mutate differently: 90% perturb by sigma x 4 in weight units, 10% replace with N(0, 1).

### 1.6.2 Structural operators

| Operator | Weight | Effect | Why |
|---|---|---|---|
| Link repeat +1 or -1 | 15 | One more or one fewer segment, rib or tentacle copy | The cheapest segmentation change |
| Duplicate module (paralog) | 12 | Copy a module gene with a new innov from `innovFor(dup, src)`, add a link from the same parent at a nearby attachPos. With 30% chance, deep-copy its whole subtree (a modular duplication). The copy keeps brainChannel, so it is driven at once | Duplication then divergence |
| Delete module | 8 | Remove a non-root module, its links, and regulatory genes that only target it | Simplification, cave-style loss |
| Add new module | 4 | A random kind and subtype with schema-default params, attached to a random module | Novelty |
| Rewire link | 8 | Change fromInnov or toInnov to another module, or move attachPos by +-0.2 | Rearrangement, such as moving the eyes |
| Toggle symmetry | 4 | Cycle none, mirror, radial | Bilateral to radial forms |
| Change kind or subtype | 4 | For example fin to limb, cup eye to lens, jaws to rasp | Exaptation |
| Toggle module or link enable | 4 | A silent gene stays in the genome as raw material | Neutral networks |
| Add or remove regulatory gene | 8 | A new gene targets a random module, axis and param with a small amount | Gradients, positional identity |
| Brain: add synapse | 14 | NEAT add-connection between random nodes (I/O slots included) | |
| Brain: add neuron (split a synapse) | 6 | NEAT add-node: in-weight 1, out-weight equal to the old weight | Function-preserving |
| Brain: delete or disable synapse | 8 | | Keeps brains from bloating |
| Brain: delete unconnected neuron | 5 | | |

Weights are relative; the operator is chosen with probability weight / sum. They are world constants, tuned by experiment E8 (distribution of fitness effects). Mutation RNG is counter-based and keyed by birth id, so order does not matter (1.12).

### 1.6.3 The mutation-rate gene

- **Range:** MU_LOG between -4 and -1, per gene. With about 250 genes, that is 0.025 to 25 point mutations per birth. Structural events are 2% to 100% of that.
- **Default for designs:** MU_LOG = -2.3, MU_STRUCT_RATIO = 0.2, SIGMA = 0.02 (about 1.25 point mutations and 0.25 structural events per birth).
- **Self-adaptation:** the rate genes ride along with the rest. Lineages whose rates produce fitter offspring spread. The meta-rate (0.02 in x space) is fixed, so the rate cannot run away faster than selection can track it.
- **Floor:** MU_LOG cannot go below -4, so evolution never stalls completely. That matters in a world meant to change for years.
- **Ceiling:** at -1, offspring are mostly broken (error catastrophe), so selection pushes the rate down.
- **What we expect:** rates fall in stable times and rise after disasters or under parasite pressure. Experiment E6 checks this, and the stats view plots it.

### 1.6.4 Genome-length cost

Three costs, one of them explicit:

1. **Replication energy (explicit).** Making an offspring costs `E_dna = kappa x genomeBytes` extra. kappa is set so that a 4 KB genome costs 2% of the build energy of a minimum-size (0.5 mm) newborn. For a 1 cm newborn that is 2.5 x 10^-4 %, which is negligible. So microbes are pushed to streamline their genomes and giants can afford complex ones, like real bacteria and vertebrates. Silent genes pay this too, so they are purged slowly but stay around long enough to be re-enabled.
2. **Mutational load (emergent).** More genes mean more targets per birth at the same per-gene rate.
3. **Phenotype costs (emergent).** Expressed parts and neurons cost maintenance and build energy (1.4.3). This is the main brake on bloat.

There is also a hard safety cap of 16 KB and the per-chromosome count caps in the header. A mutation that would exceed a cap does nothing.

## 1.7 Reproduction

### 1.7.1 The reproduction-mode gene

```
when mature AND energy >= reserve(REPRO_RESERVE) AND time since last clutch >= BROOD_INTERVAL * t_mat:
  if rng.u() < SEX_PROB:
      enter MATE_SEEKING for at most MATE_PATIENCE * t_mat
          (brain input "ready" = 1; "mate readiness" output gates courtship)
      on mutual acceptance (1.8): sexual clutch, the bearer pays
      on timeout: if SEX_PROB < 0.98, bud asexually; else stay seeking (obligate sex)
  else:
      bud asexually
```

- SEX_PROB around 0 is a pure budder.
- SEX_PROB around 1 with long patience is obligately sexual.
- Values in between are facultative, which is common in real plankton.
- **Clutch:** CLUTCH_SIZE offspring of length `BIRTH_FRACTION x ADULT_LENGTH`. The bearer pays `n x (E_body(newborn) + E_dna) x 1.3`. If the bearer cannot pay, the clutch shrinks to what it can afford, with at least 1 offspring.
- **Bearer:** in a sexual pairing, the partner with more spare energy bears the clutch. The other contributes genes for a small courtship cost. Every creature is a hermaphrodite in v1 (open question 1).

The cost of sex therefore emerges: search time, predation risk during courtship, and broken co-adapted gene combinations. So does its benefit: recombination against coevolving parasites (disease section), and purging bad mutations. We do not tune for an outcome. We watch it (experiment E7).

### 1.7.2 Asexual budding

`child = mutate(copy(parent))`. It is born near the parent. Its species is checked in the same way (1.9.3).

### 1.7.3 Sexual crossover between possibly different body plans

**Principle: structure from the bearer, alleles from both.** A body plan is a co-adapted whole, so a child that takes half of one plan and half of another is usually a cripple. NEAT faces the same issue and takes disjoint genes from the fitter parent. Here the bearer plays the fitter parent's role: it is the one that proved it could gather the energy to breed.

```ts
function crossover(A: Genome /*bearer*/, B: Genome, rng: Rng): Genome {
  const c = new GenomeBuilder(A.header);
  // trait block: per trait, take A or B; with 20% chance blend at a random point between them
  for (let i = 0; i < NTRAIT; i++)
    c.trait[i] = rng.u() < 0.2 ? lerpQ(A.trait[i], B.trait[i], rng.u())
                               : (rng.bit() ? A.trait[i] : B.trait[i]);
  // per chromosome: merge-walk by innov (both sorted)
  for (const chrom of [MODULES, LINKS, REGS, NEURONS, SYNAPSES])
    mergeWalk(A[chrom], B[chrom], (a, b) => {
      if (a && b)  c.add(chrom, rng.bit() ? a : b,          // matching gene: either allele
                         /*blend numeric fields*/ rng.u() < 0.2);
      else if (a)  c.add(chrom, a);                          // disjoint or excess in the bearer: keep
      else if (b && admitDonorGene(chrom, b, A, rng)) c.add(chrom, b);
    });
  repair(c);
  return c.freeze();
}
// Donor-only genes: synapses and regulatory genes 25%; a module is admitted only together with the
// link that attaches it to a module the child has (whole donor subtrees come in at 15%).
```

- **Homology:** matching innov means common descent (or the same structural event via the registry), so a matching gene is the same part type or synapse in both parents.
- **Different plans:** parents from distant lineages share few innovs. The child is then essentially the bearer's body with a sprinkling of the donor's alleles and occasional donor parts.
- **Sex is still useful within a species**, where most genes match and allele shuffling does real work.

### 1.7.4 Repair (always deterministic)

Repair runs after mutation and after crossover. It:

1. sorts every chromosome by innov and drops duplicate innovs, keeping the first;
2. makes sure the root module exists, restoring the bearer's root if it does not;
3. drops links whose `from` or `to` module is missing, drops regulatory genes whose target is missing (only when targetInnov is set), and drops synapses whose endpoints are missing (I/O ids 1 to 95 always exist);
4. leaves modules that no link reaches as **silent**: kept in the genome but not expressed;
5. clamps counts to the header caps by dropping the highest-innov silent genes first, then the highest-innov expressed ones.

### 1.7.5 Hybrid viability (post-zygotic isolation)

Fertilisation success is `v(delta) = exp(-(delta / theta_h)^4)`, where delta is the genetic distance (1.9.1) and `theta_h = 1.5 x theta_species`. A failed fertilisation wastes the courtship. On top of this, hybrid inviability emerges: a mixed body may simply not work. Reproductive isolation therefore builds up with divergence, and the species detector can see it (1.9.4).

## 1.8 Mate choice

Each creature broadcasts a **display**:

```
D = (glowHue, glowPower = sum(photophore intensity x area) + GLOW_BASE x body area,
     pulseFreq, length, odour = (ODOUR_A, ODOUR_B, ODOUR_C))
```

Glow and size are only perceived through eyes; odour only through CHEMO parts. A blind creature chooses by smell alone. A creature with no sense of smell and no eyes cannot choose, and accepts anyone in contact.

**Acceptance score** for a candidate seen by a chooser with preferences P:

```
s = w_h * exp(-angDist(D.glowHue, PREF_GLOW_HUE)^2 / (2 PREF_HUE_WIDTH^2)) * sat(glowPower)
  + w_s * exp(-(ln(D.length / (own length * PREF_SIZE_RATIO)))^2 / 0.08)
  + w_p * exp(-(D.pulseFreq - PREF_PULSE)^2 / 0.05)
  + PREF_ODOUR_WEIGHT * exp(-|D.odour - own odour|^2 / 0.02)     // "smells like my kind"
p_accept = sigmoid(12 * (s / s_max - CHOOSINESS))
```

- **Mutual:** both partners must accept. Courtship takes 2 to 5 s of sim time during which both are distracted, so there is predation risk.
- **The brain chooses whom to approach** (the "mate readiness" output plus the sensory inputs). The score only decides acceptance at contact. Behavioural courtship (approach, pulse displays) can therefore evolve in the brain, while the preference genes set the standard.
- **What this can produce:** preferences and displays are heritable and correlated in offspring, so Fisherian runaway (ever brighter, ever more pulsing) and reinforcement (choosiness rising where hybrids fail) can emerge. Bright displays cost energy (photophore cost) and attract predators that hunt by sight. This makes the wallpaper prettier for a reason.
- **Kin and species smell:** the ODOUR genes drift neutrally, so their distance tracks relatedness. Odour preference therefore turns into species recognition without a species label.

## 1.9 Species and phylogeny

### 1.9.1 Genetic distance

Distance is computed exactly by a merge walk over sorted chromosomes, in O(genes), about 1.5 us:

```
delta(a, b) = c_s * (1 - J)           // J = |shared innovs| / |union of innovs|, over expressed structural genes
            + c_p * mean_matching( |x_a - x_b| )   // mean normalised param difference on matching genes
            + c_t * mean_i |x_a,i - x_b,i|          // trait block, excluding look-only and reserved traits
defaults: c_s = 1.0, c_p = 0.5, c_t = 2.0, theta_species = 0.30
```

Synapse genes count in J with weight 0.5, because brains diverge faster than bodies and we do not want behavioural noise alone to split species. The weights are calibrated by experiment E5. Calibration target: two populations isolated at the default mutation rate should cross theta after about 200 to 400 generations of divergent selection, and should not cross it within 1,000 generations of neutral drift in one well-mixed population.

### 1.9.2 Species records

```ts
interface Species {
  id: u32; parentId: u32;                 // 0 for designed or seeded founders
  name: string;                           // generated binomial from original syllable tables; William can rename
  bornTick: u64; extinctTick: u64 | 0; promotedTick: u64 | 0;
  status: 'incipient' | 'species' | 'extinct' | 'absorbed';
  medoid: GenomeHash;                     // current representative
  reservoir: GenomeHash[64];              // reservoir sample of members (Vitter's algorithm R)
  pop: u32; peakPop: u32;
  snapshots: { tick: u64, genome: GenomeHash, traitMeans: Float32Array }[];  // at most 12, log-spaced
}
```

### 1.9.3 Online assignment at every birth

```ts
function assignSpecies(child: Org, mother: Org, father?: Org) {
  const S = species[mother.speciesId];
  if (dist(child.g, S.medoid) < THETA) return join(child, S);
  // look nearby in the species tree: parent, children and siblings of S, then the father's species
  for (const T of nearby(S, father?.speciesId)) if (T.status !== 'extinct' && dist(child.g, T.medoid) < THETA)
    return join(child, T);
  // otherwise found an incipient species
  const N = newSpecies({ parentId: S.id, status: 'incipient', medoid: child.g.hash });
  return join(child, N);
}
```

- **Promotion:** an incipient species becomes a species when it reaches N_min = 8 living members and has persisted for 2 of its own generation times. If it fails, it dissolves on its last death, and its members (if any remain) are reassigned to the nearest species at the next reconcile. Only promoted species appear in the stats view and trigger the camera director's "new species" event. This hysteresis stops one odd mutant creating a species.
- **Medoid upkeep:** every 256 joins, recompute the medoid of the reservoir (64 x 64 distances, 6 ms, in a worker). The species follows gradual drift (anagenesis) and does not shed false "species" as it drifts.
- **Split detection (cladogenesis):** during medoid upkeep, run 2-medoids on the reservoir. If the two medoids are more than THETA apart, each cluster has at least 16 of the 64 sampled members, and the mean silhouette is above 0.25, then split. The cluster closer to the old medoid keeps the id, and the other becomes a new species whose parent is the old one. Members are reassigned lazily: each live member is checked against the two medoids at its next reproduction, or at the next reconcile.
- **Anagenetic labels (optional display):** if the medoid drifts more than THETA from the species' founding snapshot, the stats view may label a chronospecies boundary. The id does not change.

### 1.9.4 Periodic reconcile

Every 10 sim minutes, a host worker reconciles species against the population:

1. Draw a stratified sample of up to 4,096 living genomes (at least 16 per species).
2. Run leader clustering at THETA over the current medoids, then reassign the sample to the nearest medoid. That is about 4,096 x 200 medoids x 1.5 us, about 1.2 s, in a worker.
3. Match the new clusters to existing ids by maximum overlap, so ids stay stable.
4. Merge two species whose medoids are closer than THETA/2 **and** whose hybrid success, as tracked by courtship statistics, is above 50%. The younger species becomes `absorbed`, which keeps the tree a tree.
5. Recompute populations exactly from the organism table.

For sexual species, reconcile also logs the inter-cluster mating success rate. The stats view can then show "these two have stopped interbreeding", which is the biological species concept, next to the genetic-distance clusters.

Asexual lineages use the same genotypic-cluster definition. This is honest: in a mixed world, distance clustering is the only definition that covers both modes.

### 1.9.5 Lineage and phylogeny tracking

**Organism record (32 bytes, live table):** id u32 (slot) with gen u16 (slot generation), mother id u32, father id u32 (0 for budding), birthTick u32 in sim-seconds/8, speciesId u32, genomeHash u64, descendant refcount u16.

**Pruned individual phylogeny**, in the style of systematics trackers such as phylotrackpy:

- On birth, add a node and increment the mother's refcount. Paternal links are stored but the tree follows the mother line, so it stays a tree.
- On death with refcount 0, delete the node and decrement the mother's refcount, cascading up.
- Unary chains (ancestors with exactly one surviving child line) are coalesced into a single edge with a length and a birth-count.
- What remains is the ancestry of everything alive. Its size is about 2P nodes x 32 B, so 13 MB at 200k population.
- The most recent common ancestor of any two living creatures is a walk up this tree, which the stats view uses for "how related are these two?".

**Species tree:** kept for ever. 10,000 species x (record plus 12 compressed snapshots of about 1 KB each) is about 130 MB on disk after a long run. Species that never reached a peak of 30 are kept without snapshots.

**Time series for the stats view:** every 10 sim-seconds, per live species, record population and 8 trait means (length, speed, DIET, eye size, armour, SEX_PROB, MU_LOG, glow power), about 40 B per species per sample. Downsample in round-robin-database style: keep 10 s resolution for 1 day, 1 min for 1 month, and 10 min after that. At 100 live species this is about 35 MB per day before downsampling and under 1 GB per year after it.

**Feeds to other sections:**

- **Stats view:** a cladogram on a real time axis, a Muller plot of species shares, trait trajectories, a body-size distribution heatmap over time, and "firsts" (first eyes, first lens eye, first proboscis, first creature over 10 cm, first leviathan over 50 cm).
- **Camera director:** promotion events, splits, extinctions of species that peaked above 100, and new size records.

## 1.10 William's sliders and part editor on the same genome

The editor works on a **draft genome**. It re-runs `develop(draft, m = 1)` on every change (about 20 us, so 60 Hz is trivial) and shows the adult. A maturity scrubber shows the juvenile and the growth sequence.

### 1.10.1 Sliders

| Slider group | Writes |
|---|---|
| Size, Life, Reproduction, Mutation, Diet, Habitat, Look, Mating, Behaviour | the trait with that index, one to one |
| Shape (slenderness, fins, eyes, mouth, spikes, armour, taper, stiffness, glow organs, gut, limb length) | the G_* global modifier traits |
| "Segments" | the repeat count of the trunk link (the self-link of the root chain) |
| "Symmetry" | the symmetry field of the selected link |

Every slider shows the live consequences next to it: swim speed, cost of transport, basal burn, gape, and the time to maturity at the current size.

### 1.10.2 Part editor

Each phenotype part keeps its **instance path** (from the BFS: a list of link innov, repeat index and side from the root). Selecting a part therefore resolves to the module gene behind it and the exact copy.

| Edit | Genome change |
|---|---|
| Resize or recolour a part, applies to "all copies" (default; the UI shows "affects 6 copies") | edit fields of the ModuleGene |
| Resize or recolour "this copy only" | add a RegGene with a narrow band on AP (and SIDE if mirrored) at that copy's position, targeting that module and field. The structure is untouched and the edit can later evolve like any regulatory gene |
| Add a part on this copy only, or "make unique" | clone the ModuleGene (new innov) and split the repeat link into three: before, the unique copy, after |
| Drag a part along its parent or around it | the attachPos or attachAngle of its LinkGene |
| Add a part (palette: segment, fin, limb, four mouths, two eyes, chemo, spike, photophore) | a new ModuleGene with schema defaults, plus a LinkGene from the parent's module |
| Delete | a single copy: a gate RegGene; all copies: disable or remove the LinkGene |
| Mirror or radial toggle | link symmetry |
| Joint and stroke (range, rest, stiffness, phase, amplitude, channel) | the ModuleGene fields; a "wave" toggle on a repeat link sets phaseWave and phaseStep |
| Juvenile look | the per-part allometry exponent, and MATURITY regulatory genes ("appears at maturity 0.4") |
| Brain | **behaviour presets** (seek plant scent, chase moving glow, flee larger shapes, school with kin odour, rest at night, court with pulses), each a template of synapse genes with fixed template innovs, merged in; plus an advanced node graph |

### 1.10.3 Templates and new lineages

William starts from original archetypes such as Bellwisp (radial drifter), Glassribbon (undulating grazer), Thornback (armoured rasp grazer), Lanternmaw (lure predator), Siltleech (proboscis parasite), Veilwhale (giant filter feeder) and Motefly (whip microbe). Template genes use innovs from the reserved range. Two designs built from the same template therefore share homology and can interbreed. A design built from scratch gets fresh innovs and starts as a reproductively isolated new species with `parentId = 0`.

### 1.10.4 Checks without rules

Before release, the editor runs a 20 s headless **sandbox trial**: standard food, standard current, no predators. It shows speed, turning, cost of transport, intake versus burn ("starves in 3 minutes"), whether it can reach and eat each food type, and the predicted time to maturity. Nothing is blocked. William may release a creature that cannot swim, and it will simply lose.

Edits must round-trip: `develop(applyEdit(g, e))` must show exactly the change asked for. Test U9 checks this.

## 1.11 Why bodies make sense: selection, not hand rules

### 1.11.1 Every part pays and earns through mechanisms

There is no rule such as "a predator must have jaws" or "fins must be at the back". Every part's benefit goes through physics or the sensing model. Every cost goes through mass (inertia and buoyancy), drag (span and area), maintenance (tissue factor x mass), build energy, and the replication cost of its genes.

- A body with fins in the wrong place produces torque instead of thrust, and swims in circles.
- A body with too many eyes starves from their upkeep.
- A heavy armoured body sinks unless its density genes compensate.
- A jaw on a tail can only eat what the tail touches, and a brain that has to steer backwards will rarely evolve.

These are not rules. They are consequences that selection sees. This is the approach of Sims (1994) and Framsticks, made stronger by an ecology in place of a fitness function.

### 1.11.2 The only hard constraints (compute and solver safety)

| Constraint | Value | Reason |
|---|---|---|
| Parts per body | 64 (32 on a laptop-host world) | GPU budget |
| Genome bytes and gene counts | 16 KB; caps in the header | memory, development time |
| Recursion limit | 7 | bounded development |
| Parameter ranges | schema ranges | quantisation |
| Mass ratio between joined parts | clamped to at most 1:200 | stiff solver stability (the physics section may tune this) |
| Minimum part dimension | 2% of body length; smaller parts become massless drag and sensor elements | timestep stability |

Clamps change the phenotype but never reject it. They are documented, so selection works against them in the open.

### 1.11.3 Anti-exploit invariants

Artificial evolution finds physics bugs. Sims' creatures famously did. These invariants are checked by tests and by a runtime watchdog:

1. **No self-propulsion without fluid.** Internal joint torques sum to zero. In a test tank with the fluid switched off, no body can move its centre of mass (test P1).
2. **Every joule is charged.** Muscle energy is `sum |tau x omega| / efficiency (0.25)` plus basal metabolism. No passive structure gains energy from a uniform current except through drag (test P2).
3. **Energy bound watchdog.** If a creature's kinetic energy exceeds `10 x 0.5 M v_max(L)^2`, the creature is removed. Its genome is saved to `glitch-fossils/` together with the world seed and the tick, and it becomes a regression test.
4. **Scallop check.** At Re below 1, a body with only one reciprocal joint must not make net progress (test P3).

## 1.12 Determinism and serialisation

- **Randomness:** a counter-based PRNG (Philox4x32 or SplitMix64 on a hash) keyed by `(worldSeed, birthId, stream)`. Mutation and crossover results do not depend on thread scheduling or batch order.
- **Arithmetic:** development uses float32 math with a fixed operation order, and no transcendental functions outside a small set of in-house approximations (exp, pow, sin). JS `Math.*` results are not guaranteed identical across engines, so these are implemented once in TypeScript and once in WGSL for any GPU path. Test U2 hashes the phenotype bytes.
- **World snapshot:** the genome blob store (zstd), the innovation registry, organism and species tables, the pruned phylogeny, and the time series. Versioned with formatVersion. Old genomes load with schema defaults for new traits.
- **Export:** the god window can export a single creature as a `.ptg` file (a base64 genome plus name and species), so William can share designs.

## 1.13 Interfaces to other sections

| Section | Gets from this section | Gives to this section |
|---|---|---|
| Physics | compiled parts (1.4.5), joint targets from the oscillators | per-part drag law (Stokes plus quadratic blend), the integrator, attachment joints for proboscis and tentacle, sandbox test harness |
| Brains | genome encoding, the I/O slot contract (1.3.6) | neural dynamics, slot semantics, the GPU kernel, plasticity |
| Ecology | metabolic rate, feeding capabilities, gut efficiencies, build energy | b0, energy densities, food types and particle sizes, productivity, temperature |
| Disease | genome access for host-parasite matching (for example ODOUR or a future immune gene) | infection effects on energy and fertility |
| Stats and camera | species tree, events, time series | |

## 1.14 Testing

### 1.14.1 Unit tests (Vitest, run in CI and on the host build)

| Id | Test |
|---|---|
| U1 | Encode and decode round-trip for random genomes: bytes equal, crc valid, fields within schema ranges |
| U2 | **Development determinism:** 10,000 random genomes, each developed twice and in two worker threads. SHA-256 of the phenotype bytes are equal. A golden hash file for the 7 templates is checked in, so any change to development is noticed |
| U3 | **Development bounds:** 10^6 random and mutated genomes. Never above MAX_PARTS, never NaN or Inf, mass > 0, p99 development time under 50 us on CI |
| U4 | **Symmetry:** a mirror link gives exact reflections (positions within 1e-6). Radial n gives angles 2 pi k / n |
| U5 | **Repeat and recursion:** a repeat of n gives n copies. Recursion stops at the limit. terminalOnly expresses only at the leaves |
| U6 | **Regulation:** an AP band gate expresses only within its window. A gaussian scale peaks at its centre. MATURITY gates switch at the threshold (metamorphosis) |
| U7 | **Allometry:** a part with alpha = 0.6 has its relative size at m = 0 equal to `BIRTH_FRACTION^-0.4` times its adult relative size, within 1e-4 |
| U8 | **Mutation validity:** 10^6 mutations from evolved genomes all pass repair invariants (sorted, unique innovs, links resolve, root present, under caps). The structural operator frequencies match their weights (chi-squared test) |
| U9 | **Editor round-trip:** each edit type on each template changes exactly the targeted parts. A phenotype diff confirms nothing else changed. "This copy only" affects one instance |
| U10 | **Crossover:** `crossover(A, A) == A` (except blends of identical values). Matching genes come from A or B only. The child is valid. With B unrelated, the child's structure equals A's except admitted donor genes |
| U11 | **Distance:** `d(a, a) = 0`, symmetric, `d >= 0`. Triangle inequality holds approximately on a 1,000-genome sample (log any violation; it is not a strict metric) |
| U12 | **Species assignment** on synthetic data: drift genomes along a known tree with known splits. Adjusted Rand index over 0.85 against the truth, and fewer than 1 false split per 10^5 births under neutral drift |
| U13 | **Phylogeny pruning:** on a 5,000-birth run, compare the pruned tree with a full log. Same ancestry for every living node, same MRCAs |

### 1.14.2 Property-based tests (fast-check)

- Any sequence of mutate, crossover and edit operations gives a valid genome.
- Development of a valid genome never throws.
- Restage gives the same result as a full develop whenever no MATURITY gate changed between the two maturities.

### 1.14.3 Physics-integration tests (with the physics section)

- P1: no translation without fluid (1.11.3).
- P2: a passive body in a uniform current gains no energy beyond drag.
- P3: the scallop check at low Re.
- P4: each template swims within 20% of its recorded golden speed, and turns.
- P5: microbe templates swim only with whips; a paddle microbe makes no progress.

### 1.14.4 Evolvability experiments (headless, fast-forward, seeds fixed, results kept as reports)

| Id | Setup | Pass or report |
|---|---|---|
| E1 | **Swim selection:** 500 creatures, 5 cm, truncation selection on distance in 20 s, 300 generations, from random minimal genomes | Median speed improves at least 5x. Ablations (no duplication, no regulatory genes, no brainChannel inheritance on duplication) each do measurably worse, which shows that each feature earns its complexity. Videos are kept for William |
| E2 | **Low Re:** the same at 0.5 mm | The winners use travelling waves. No reciprocal-only body is in the top 10% |
| E3 | **Size ratchet:** ecology with large prey abundant, carrying capacity scaled to allow giants | Some lineage reaches 10x its founder length within 500 generations. Control (no benefit to size): the drift of mean log-length stays within +-0.1 decades |
| E4 | **Regressive eyes:** half the tank completely dark | Mean eye mass in the dark lineage falls by at least 50% within 150 generations. Control: no fall |
| E5 | **Diet split:** two resources, separated in space, with a gene-flow bridge | At least 2 species detected, ARI over 0.8 against the ecological clusters. Calibrates c_s, c_p, c_t and theta |
| E6 | **Mutation-rate dynamics:** start MU_LOG at -1.2 or at -3.8 | The rate converges into the -3.2 to -1.8 band and rises (by at least 0.3) after an imposed environmental shift |
| E7 | **Sex versus asex:** a static world versus a world with coevolving parasites (with the disease section) | Report the trajectory of SEX_PROB. This is a science result, not pass or fail |
| E8 | **Distribution of fitness effects:** 20 evolved genomes x 10,000 single mutations each, fitness measured in the sandbox | At least 50% near-neutral (\|delta fitness\| under 1%), at most 10% lethal. Otherwise retune operator weights and sensitivities |
| E9 | **Crossover viability:** within species, at least 90% of children develop, eat and swim at 50% or more of the parental mean. Viability falls monotonically with distance |
| E10 | **Bloat check:** a 10^6-birth open run | Median genome bytes stay under 6 KB; silent-gene fraction under 40% |

### 1.14.5 Performance benchmarks

- **B1:** development, restage, mutation, crossover and distance timings, measured on William's 5090 PC and on a weak reference laptop (4-core, 2018-era). They must meet 1.4.6. Regressions over 20% fail CI on the benchmark job.
- **B2:** births per second sustained by the host pipeline at 200k population, without dropping sim ticks.

## 1.15 Failure modes and mitigations

| Failure | Sign | Mitigation |
|---|---|---|
| Genome bloat | genome bytes rising, many silent genes | replication cost, caps, deletion operators; E10 |
| Homology erosion after many duplications | crossover viability falls, distances inflate | registry reuse of innovs; the bearer-structure rule; tune duplication weight |
| Species flicker (many tiny incipient species) | promotion rate high, lifetimes short | N_min, persistence time, THETA calibration (E5) |
| No speciation at all | one species for ever | check THETA, spatial structure (ecology), assortative mating strength |
| Mutation-rate runaway | MU_LOG pinned at a bound | meta-rate, bounds; E6 |
| Physics exploits | the energy watchdog fires, odd fast creatures | glitch fossils become regression tests; P1 to P3 |
| Truncation of bodies at MAX_PARTS | ragged distal parts on complex creatures | BFS cuts distal parts first; the stats view flags the rate; a part-count cost already penalises large counts |
| Giants never evolve | size distribution capped well below 1 m | carrying capacity (ecology), the KLEIBER_EXP choice, god-mode seeding |
| Designed creatures die at once | lineage extinct within minutes | sandbox trial in the editor; behaviour presets; optional pre-evolution (open question 4) |
| Snapshot corruption | crc mismatch | crc32 per genome; refuse the blob and fall back to the previous snapshot |

## 1.16 Prior art

- Karl Sims, "Evolving Virtual Creatures", SIGGRAPH 1994: directed-graph genotypes with recursion, terminal-only links and nested neural controllers; the backbone of this design. https://www.karlsims.com/papers/siggraph94.pdf
- Framsticks (Komosinski and Ulatowski): several genotype formats, including a developmental one; articulated creatures with neural control and an open simulator. https://www.framsticks.com/
- Polyworld (Yaeger 1994): an ecology with neural brains and vision, energy-driven reproduction. https://github.com/polyworld/polyworld
- NEAT (Stanley and Miikkulainen 2002): historical markings, crossover alignment, speciation by compatibility distance. https://nn.cs.utexas.edu/downloads/papers/stanley.ec02.pdf
- HyperNEAT (Stanley, D'Ambrosio and Gauci 2009) and CPPNs (Stanley 2007): considered and rejected for the body (1.2). http://eplex.cs.ucf.edu/hyperNEATpage/ (unverified)
- Cheney, MacCurdy, Clune and Lipson 2013, CPPN-NEAT soft robots. http://jeffclune.com/publications/2013_Softbots_GECCO.pdf (unverified)
- Stanley and Miikkulainen 2003, "A Taxonomy for Artificial Embryogeny". https://nn.cs.utexas.edu/downloads/papers/stanley.alife03.pdf (unverified)
- Bongard 2002, evolving modular genetic regulatory networks; Eggenberger 1997, GRN-driven artificial embryogeny (cited from memory, no URL).
- Prusinkiewicz and Lindenmayer, "The Algorithmic Beauty of Plants" (L-systems). http://algorithmicbotany.org/papers/abop/abop.pdf
- Lenia (Bert Chan), continuous cellular automata. https://chakazul.github.io/lenia.html
- ALIEN (artificial life environment, GPU particles). https://alien-project.org/
- Avida (digital evolution; Lenski et al. 2003, Nature, "The evolutionary origin of complex features"). https://github.com/devosoft/avida
- Tierra (Tom Ray 1991). https://tomray.me/tierra/ (unverified)
- The Bibites, prior art only, nothing borrowed. https://thebibites.com (unverified)
- phylotrackpy (Dolson) and hstrat (Moreno), phylogeny tracking in digital evolution. https://github.com/emilydolson/phylotrackpy and https://github.com/mmore500/hstrat (unverified)
- Purcell 1977, "Life at low Reynolds number". https://doi.org/10.1119/1.10903
- West, Brown and Enquist 1997, metabolic scaling. https://doi.org/10.1126/science.276.5309.122
- Salmon et al. 2011, "Parallel random numbers: as easy as 1, 2, 3" (Philox counter-based RNG). https://doi.org/10.1145/2063384.2063405 (unverified)
- Ohno 1970, "Evolution by Gene Duplication"; Beyer and Schwefel 2002, self-adaptive evolution strategies (cited from memory).

## 1.17 Open questions for William

1. **Sexes.** v1 makes every creature a hermaphrodite, and the partner with more energy bears the clutch. Would you like separate sexes (a sex-determination gene), which allows sexual dimorphism, such as showy males with huge glowing crests? It costs some complexity and halves the effective breeding population.
2. **How slow should giants be?** With real metabolic scaling (exponent 0.75), a 1 m leviathan's generation is about 300x a microbe's: hours of sim time. Should we keep it real, flatten it (exponent 0.85, about 30x), or fast-forward the world when nobody is watching closely?
3. **How many species do you want to see?** Species are defined by a fixed genetic-distance threshold, which is honest but may give 3 or 300. Should the stats view let you slide the threshold, so you can view the tree "lumped" or "split", while the sim keeps one fixed definition?
4. **Your designs' brains.** Should a newly designed creature get a short sandbox pre-evolution (say 50 generations, about a minute) to tune its brain before release? Or should it go in with only the behaviour presets you chose and sink or swim?
5. **Plasticity and gene transfer.** Should development read the environment at birth (for example cold water gives thicker bodies; the DEPTH_AT_BIRTH axis is reserved), and should diseases occasionally carry genes between species (horizontal transfer)? Both are fun and real, but both make lineages harder to read.
