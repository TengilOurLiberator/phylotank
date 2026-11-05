# Glossary

Every term in the Phylotank docs and code that is not ordinary computer science, machine learning or statistics, in alphabetical order within each group. Biology and physics terms are explained as Phylotank uses them, which is sometimes simpler than the textbook. If a word in the docs puzzles you and is missing here, please open an issue.

- [Phylotank's own words](#phylotanks-own-words)
- [Biology, ecology and evolution](#biology-ecology-and-evolution)
- [Physics, fluids and the body](#physics-fluids-and-the-body)
- [Ocean and habitat](#ocean-and-habitat)
- [Look, film and sound](#look-film-and-sound)
- [Platforms and packaging](#platforms-and-packaging)

---

## Phylotank's own words

| Term | Meaning |
|---|---|
| **Agent cap, cap fee (birth tax)** | The most creatures, eggs and carcasses a world may hold (`N_max`, set by the preset). As the tank fills past half the cap, every newborn costs its parent an extra fee in food, which stops tiny fast breeders from filling the tank first. At the cap, births wait; they are never dropped. |
| **Bearer, donor** | In sexual reproduction the bearer is the parent whose body plan the child takes; the donor contributes gene values only. |
| **Baseline glow** | A dim glow that every living creature shows for free, so the tank never goes dark whatever evolution does. Brighter displays cost the creature energy. |
| **Behaviour template** | A starting set of instincts (grazer, ambusher, drifter, parasite, scavenger, giant, microbe) that comes with each body template. Evolution changes it like any other gene. |
| **Blank** | The empty starter design: one segment and default genes. A starting point for your own design. |
| **Body graph** | The part of the genome that describes the body as a recipe: part types (modules) and rules for attaching them (links), with repeats, symmetry and recursion. Growing a body means unfolding this graph. |
| **BrainTraits** | A fixed block of brain genes: brain size, oscillator band, reflex strengths, personality and drives. The designer shows them as sliders. |
| **Ceiling (size ceiling)** | The longest adult length evolution may reach in a given world, about 20 cm in the Default tank. Only leviathans may exceed it. |
| **Census** | The once-per-second count of every species and its biomass, sent to every view. |
| **Clutch** | The offspring produced in one breeding event. Clutch size is a gene. |
| **Core 12** | The twelve god powers planned for v0.5: bloom, vent, cold snap, heatwave, plague, meteor, current shift, long night, mutagen, cull, bless and nutrient flood, plus release. |
| **Designer** | The part of the god window where you build a creature, with gene sliders and a part editor that edit the same genome. |
| **Director** | The automatic camera of the screensaver and TV views. It watches the event stream, scores possible stories and films the best one, like a nature documentary crew. |
| **Dream tank** | The small world that runs inside the web page itself (in a Web Worker) when no host is running. It is what the public demo and the wallpaper fallback show. |
| **Dust, specks** | Creatures too small on screen to draw as bodies are sent and drawn as single glowing points. |
| **Endowment** | Extra nutrient mass that a leviathan release brings into the world with it, so that the food web can carry it. |
| **Energy ledger, mass ledger** | Phylotank's bookkeeping. All matter in a world is counted in whole quanta of 1 nanogram, and energy is derived from that mass, so nothing appears or vanishes except through logged god powers. |
| **Epoch** | A counter that goes up by one every time the world is rewound. Commands sent before a rewind are refused, so you cannot act on a present that no longer exists. |
| **Fingerprint** | A short code such as `3fa9-12c0-88e1-04bd` that identifies a creature design. Two designs with the same fingerprint are the same genome. |
| **Founder, founder protection** | The first creatures of a release. Founder protection is meant to shield them for their first 10 sim minutes so that a fresh design gets a fair start (the flag exists; the shielding itself is planned). |
| **God, god window, god power** | You, the window from which you change the world, and the events you can cast (meteors, plagues, blooms and so on). |
| **Golden (golden hash, golden image)** | A recorded "known good" result that a test compares against, such as the state hash after an hour of simulation or a rendered picture. |
| **Host** | The program on your PC that owns the persistent world, runs it all the time, saves it and streams it to the views. |
| **Idle drift** | The wallpaper's slow, unscripted camera, which wanders towards lively places. |
| **Innate gait** | The swimming rhythm a design is born with, set by phase genes on its parts. The brain may keep, change or abandon it. |
| **Journal** | The log of every outside input to a world (god commands, releases, governor decisions) stamped with the tick it applies to. Replaying a snapshot plus its journal gives back the same world. |
| **Lease (speed lease)** | Permission to run faster than normal. It lapses when the god window closes, so the wallpaper returns to calm, unless you start an explicit "run at max until ..." overnight lease. |
| **Leviathan** | A creature you release deliberately as a giant. It may grow beyond the size ceiling and brings its own endowment. |
| **Library** | Your collection of designs and captured creatures. |
| **LOD (level of detail)** | Drawing near creatures in full and far ones more simply. Phylotank has five tiers, from a density haze to full bodies. |
| **Major power** | A god power with big consequences (meteor, plague, cull, ice age and others). It needs a deliberate hold to confirm, waits 3 seconds and takes a snapshot first, so you can undo it. |
| **Motefly** | The starter whip microbe, the smallest template, needed at the bottom of the zoom range. |
| **Nature mode** | The tank casting its own mild weather (small cold snaps, heatwaves, current shifts, storms, blooms) while you are away. Never meteors or plagues. |
| **Preset (Small, Default, Large)** | The three world sizes: 32 x 18 m, 64 x 36 m and 128 x 72 m, each with its own agent cap and food budget. |
| **`.ptk` file** | A saved world snapshot. |
| **`.ptkg` file, `PTK1.` string** | A creature design (or a pack of them) as a file, or the same bytes as a text string you can paste or put in a link. |
| **Release** | Putting creatures from the designer or library into the live world. |
| **Restage** | Regrowing a creature's body as it grows, at every 4% change in length. |
| **Rewind** | Going back to a snapshot. The present is saved first, so rewinding never deletes anything. |
| **Sim, tick, sim time** | The simulation; one step of it (1/30 of a second of sim time); time as the creatures experience it, which can run faster or slower than your clock. A sim day is 20 minutes and a sim year is 20 days. |
| **Snapshot** | A saved copy of the whole world at one moment. Taken automatically every 10 minutes, before every major power and before every rewind, and whenever you ask. |
| **State hash** | A fingerprint of the whole world state. Two runs from the same seed and inputs must produce the same hash; tests check this. |
| **Swimmer card** | A small table, measured from a creature's own full physics, of how fast it swims at each stroke. Used to pose and move far-away creatures cheaply. |
| **Template** | One of the eight starter designs: Meadowlamp, Hushmaw, Sievebell, Tetherling, Ashpicker, Deepcrown, Motefly and Blank. |
| **Throttle state** | How much of your PC the host may use: Watching, Ambient, Background, Yield (a game or another GPU job is running), Evicted or Battery. |
| **Views (wallpaper, screensaver, TV, god window)** | The four ways to look at the one world. |

## Biology, ecology and evolution

| Term | Meaning |
|---|---|
| **Aerobic scope** | How many times its resting metabolism an animal can sustain. Above it, work draws on a reserve that tires the animal. |
| **Allele** | One version of a gene. |
| **Allometry** | Proportions changing with size, such as juveniles with big heads. |
| **Allopatric speciation** | New species forming because a barrier splits a population in two. The rift barrier power exists to show it. |
| **Anagenesis, cladogenesis** | A lineage changing over time without splitting; a lineage splitting into two species. |
| **Antigen, adhesin, immune key** | The molecular "locks and keys" of infection. In Phylotank a pathogen's adhesin must match a host's surface signature to infect it, and the host's immune key fights back. |
| **Assimilation** | The fraction of eaten food that the gut actually absorbs. |
| **Baldwin effect** | Learning within a lifetime guiding which genes selection favours, without learned traits being inherited. |
| **Benthic mat** | A carpet of algae or bacteria growing on rock or sediment. |
| **Binomial** | A two-part scientific name such as *Pratilux tondens* (genus, then species). Phylotank generates original ones. |
| **Bioluminescence** | Light made by living things. |
| **Biomass** | The total mass of living things, of a species or of the whole tank. |
| **Body plan, morphology** | The overall layout of a body (how many segments, which parts, what symmetry); body shape and structure in general. |
| **Budding** | Asexual reproduction: growing an offspring from the parent's own body. The child is a copy, apart from mutations. |
| **Carcass, carrion** | A dead body; eating dead bodies. |
| **Carrying capacity** | The population an environment can support. In Phylotank it falls out of the finite nutrient mass. |
| **Central pattern generator (CPG)** | A neural circuit that makes a rhythm, such as a swimming beat, without needing a rhythmic input. |
| **Chemosynthesis** | Making food from chemical energy (vent sulphur) instead of light. |
| **Coevolution** | Two species evolving in response to each other, such as hosts and their parasites. |
| **Counter-illumination** | Glowing on the belly to match light from above and hide a silhouette. |
| **Crossover** | Mixing two parents' genomes when a child is made sexually. |
| **Cyst** | A dormant, resistant stage (of plankton or a pathogen) resting in the sediment. |
| **Damuth's law** | Population density falls as body mass to the power -0.75: big animals are rarer. |
| **Detritivore, scavenger** | An animal that eats detritus; one that eats carcasses. |
| **Detritus, marine snow** | Dead organic particles; their slow rain from the upper water. |
| **Diel vertical migration** | The daily rise of animals to feed at night and their descent to hide by day. |
| **Disposable soma** | The idea that a long life must be paid for with body repair, so living longer costs energy. Phylotank charges exactly that. |
| **DNA, genome, gene** | The heritable recipe of a creature; the whole of it; one entry in it. |
| **Dorsal, ventral, snout, anteroposterior (AP) axis** | The back and the belly side; the front tip; the line from snout to tail. Phylotank's body frame runs `u` from snout (0) to tail tip (1) and `v` from ventral (-1) to dorsal (+1). |
| **Drive** | A built-in motivation neuron: hunger, fear, libido, fatigue, aggression or sociality. |
| **Egg, hatching, juvenile, maturity** | An offspring not yet born; its emergence; a young creature; the point (0 at birth to 1 as an adult) at which it is grown and may breed. |
| **Enzyme (diet enzymes)** | In Phylotank, a creature's split of digestive effort between plants, meat and detritus, set by two genes and shown as the designer's diet triangle. |
| **Exaptation** | A part evolved for one use taken over for another. |
| **Excretion, faeces** | Getting rid of waste: dissolved waste goes back to the water as nutrient, unabsorbed food leaves as faeces that become detritus. |
| **Extinction** | The death of the last member of a species. |
| **Fisherian runaway** | Mate preference and a display amplifying each other over generations. |
| **Food web, food chain, trophic level** | Who eats whom; a single line of it; position in it (producers 1, grazers 2, their predators 3). |
| **Ganglion** | A small cluster of neurons, here one per body segment. |
| **Gape** | How wide a mouth opens, which limits the size of prey it can take. |
| **Gene bank, immigration, reseed, safety valve** | A store of past genomes; new arrivals drawn from it at a low rate; refilling a tank that lost too much; the logged measures that keep a world from dying out completely. |
| **Generation** | One step of descent, from parent to child. |
| **Genus, epithet** | The first and second parts of a scientific name: *Pratilux* is the genus and *tondens* the epithet. |
| **Gompertz ageing** | A death risk that rises exponentially with age. In Phylotank its steepness is a gene (SENESCENCE). |
| **Grazer, herbivore, predator, parasite, filter feeder** | An animal that crops plants or mats; one that eats plants; one that hunts other animals; one that lives on a host and drains it; one that sieves food from the water. |
| **Hebbian learning, neuromodulator** | Synapses strengthening when the neurons on both sides are active together; a signal (here pleasure or pain) that switches such learning up or down. |
| **Heritable, trait** | Passed from parent to child; one measurable property of a creature, such as adult length or glow hue. In Phylotank almost every trait is a gene. |
| **Hermaphrodite** | An individual that can act as either parent. All sexual Phylotank creatures are, for now. |
| **Holdfast** | The part a sessile creature uses to grip the rock. |
| **Holling type II** | Feeding that rises with food density and then levels off, because handling food takes time. |
| **Homology** | Shared descent of a gene or part in two organisms. |
| **Hox genes** | Genes that give body regions their identity by position. Phylotank's regulatory genes are modelled on them. |
| **Hybrid** | A child of parents from two different species. |
| **Kleiber's law** | Resting metabolic rate scales as body mass to the power 0.75, so big animals burn less per kilogram. |
| **Klinotaxis, tropotaxis** | Following a smell by sampling it over time; by comparing two sensors at once. |
| **Larva** | The young, often very different-looking, stage of an animal. |
| **Lateral line** | A fish's sense of water pressure and nearby movement. |
| **Lenia** | A continuous cellular automaton that forms organism-like patterns; the inspiration for Phylotank's benthic mats. |
| **Lineage, phylogeny, species tree** | A line of descent; the history of descent of individuals; the branching tree of species. |
| **Matching alleles** | An infection rule where pathogen and host keys must match, which drives arms races. |
| **Medoid** | The most central member of a cluster, used as a species' representative. |
| **Metabolism, basal metabolism** | The chemistry of staying alive; the energy an animal burns at rest. |
| **Metamorphosis** | A big change of body form during growth, such as a larva becoming an adult. |
| **Minimum viable population** | A population size below which chance extinction becomes likely. |
| **Monod curve, Steele curve** | Growth that rises with nutrient and saturates; growth with light that saturates and then falls in too much light. |
| **Mouth types (filter, jaws, rasp, proboscis, suction)** | Phylotank's five mouths: a comb that sieves the water; biting jaws; a scraper for mats and plants; a piercing tube that latches on and drains; a mouth that sucks food in. |
| **Mutation, mutation rate** | A random change to a gene when a child is made; how often that happens. In Phylotank the rate is itself a gene. |
| **Niche** | The role a species plays and the resources it uses. |
| **Nutrient, nutrient cycle, remineralisation** | The dissolved matter producers grow from; its loop from water to plankton to animals to carcasses and back; the breakdown of dead matter back into dissolved nutrient. |
| **Ontogeny** | The development of one individual from birth to adult. |
| **Organ, appendage, segment, limb, tentacle, whip (flagellum)** | A body part with a job; a part that sticks out; one unit of a body repeated along its length; a jointed arm or leg; a flexible arm; a long beating tail that drives microbes. |
| **Paradox of enrichment** | Adding food can destabilise predator-prey cycles until they crash. |
| **Paralog** | A gene copy created by duplication within one genome. |
| **Pathogen, strain, virulence, prevalence** | A disease agent; one variety of it; how much harm it does; the fraction of a population infected. |
| **Phenotype, genotype** | What a creature is actually like (its grown body and behaviour); the genes it carries. Phylotank's `develop()` turns one into the other. |
| **Pheromone, scent channel** | A chemical signal between animals of one species; one of the eight smells carried by the water in Phylotank (plant, blood, toxin, alarm and four pheromones). |
| **Photic zone** | The sunlit upper layer of water where plants can grow. |
| **Photophore** | A light-emitting organ. |
| **Photosynthesis, producer** | Making food from light; an organism that does, at the base of the food web. |
| **Phytoplankton, plankton** | Drifting microscopic photosynthesisers; drifting life in general. In Phylotank plankton is a field, not individual creatures. |
| **Plasticity (neural)** | Synapses changing during a lifetime. In Phylotank it is gene-gated, costs energy, and is never inherited. |
| **Population cycle, boom and bust** | A population rising and crashing in a repeating pattern, often in step with its predators. |
| **Post-zygotic isolation** | Hybrids that fail to develop or breed, which keeps species apart. |
| **Proprioception** | The sense of one's own body position, such as joint angles. |
| **Red Queen** | Hosts and parasites evolving continually just to keep pace with each other. |
| **Reflex** | A built-in reaction, such as startle or bite on taste, wired in before any learning. |
| **Refuge** | A place where prey can hide from predators, such as caves and reefs. |
| **Reserve, repro reserve** | A creature's stored energy (fat); the part set aside for breeding. |
| **Richness, evenness, Hill numbers** | The number of species; how evenly individuals are spread among them; a family of diversity measures that combine both. |
| **Selection, natural selection** | Some variants leaving more offspring than others, so their genes spread. |
| **Senescence** | Ageing: the decline of the body with age. |
| **Sessile** | Attached to one place, like a sea anemone. |
| **Sexual selection, mate choice, choosiness** | Evolution driven by who mates with whom; a creature's preferences; how picky it is. |
| **Sheldon spectrum** | Roughly equal biomass in each logarithmic body-size class of a healthy ocean. |
| **Speciation** | One species splitting into two. Phylotank detects it automatically when genomes drift apart. |
| **Species** | In Phylotank, a cluster of genetically similar creatures. A new species is promoted only after it holds enough members for enough generations. |
| **Specific dynamic action** | The extra energy burnt in digesting a meal. |
| **Spore** | A tiny dormant particle that spreads a pathogen through the water. |
| **Spring bloom** | The plankton boom when spring light meets nutrients mixed up over winter. |
| **Super-individual** | One simulated agent standing for a cloud of identical small animals. Not used in v1. |
| **Symmetry (mirror, radial)** | A body whose upper and lower halves match; one arranged around a centre like a jellyfish. |
| **Taste** | Phylotank's contact sense of food value and toxins at the mouth. |
| **Toxicity** | How poisonous a creature is to eat; a gene. |
| **Virulence trade-off** | Harsher pathogens spread more but kill hosts sooner, so intermediate virulence often wins. |
| **von Bertalanffy growth** | Growth that slows smoothly as an animal approaches adult size. |
| **Whale fall** | A large carcass on the deep floor that feeds scavengers for days; also a god power. |

## Physics, fluids and the body

| Term | Meaning |
|---|---|
| **2.5D** | Phylotank's compromise: bodies move in a flat 2D plane but have a depth (span) out of it, so mass and drag scale as they would in 3D. |
| **Added mass** | Water that must be accelerated along with a body. It makes thin fins and large bodies sluggish to start and turn. |
| **Anisotropic drag** | Water resisting sideways motion more than motion along a body, which is what lets a wriggle push a creature forwards. |
| **Antagonistic muscle pair** | Two muscles that pull a joint in opposite directions. |
| **Armour, shell, lipid** | Heavy protective tissue; a calcified shell, built from dissolved minerals; fat, which is lighter than water and makes a body float. |
| **Arrhenius factor, Q10** | Rules for how rates rise with temperature. Q10 = 2 means a rate doubles for every 10 °C. |
| **Buoyancy** | The upward push of water. In Phylotank it comes from lipid (fat), gas bladders and the lack of armour, not from a density gene. |
| **C-start** | A fish's sudden escape bend, triggered by a startle reflex. |
| **Capsule** | A cylinder with rounded ends: the shape of most body segments. |
| **Cilia** | Tiny beating hairs that move very small creatures or the water around them. |
| **Compliance, damping, stiffness, Young's modulus** | How much a joint gives under load; how quickly it stops wobbling; how hard it is to bend; the material constant behind stiffness. |
| **Cost of transport** | The energy used to move a unit of body weight over a unit of distance. |
| **Drag (linear, quadratic, Stokes flow)** | Water resistance. Linear drag dominates for tiny, slow bodies (syrupy Stokes flow); quadratic drag dominates for big, fast ones. |
| **Eyes (cup, lens, eyespot)** | A simple pit of light-sensitive cells; an eye with a lens that sees more sharply; the smallest light-sensing spot. |
| **Fin (paddle, fringe, fluke), pectoral fin** | Fin shapes: a stiff blade, a soft frilled edge, a broad tail; a fin on the side of the body behind the head, often in a pair. |
| **Fluke** | A broad tail fin. |
| **Gland, ink** | An organ that stores and releases a substance (toxin, or a cloud of ink to escape behind). |
| **Hill muscle model** | Muscle force falls as shortening speed rises. |
| **Isometric cost** | The energy a muscle burns holding still against a load. |
| **Jet, gas bladder** | An organ that squirts water to push the body along, like a jellyfish's bell; a gas-filled sac that adjusts buoyancy. |
| **Joint, revolute joint, joint limit** | Where two segments meet; a hinge that turns in the plane; how far it can bend. |
| **Kinetic energy** | The energy of motion. Phylotank's watchdog checks that no creature gains it from nothing. |
| **Munk moment** | The torque that turns a moving elongated body broadside to the flow. |
| **Plume, vortex** | The rising column of warm water above a vent; a swirl in the water. |
| **Reynolds number (Re)** | The ratio of inertial to viscous forces. Low Re means syrupy swimming where coasting is impossible; high Re means gliding. Phylotank spans Re about 0.01 (microbes) to tens of thousands (giants). |
| **Scallop theorem** | At low Re a stroke that runs the same backwards and forwards produces no net motion, so microbes need whips or cilia. |
| **Span** | A part's depth out of the plane, in the 2.5D model. |
| **Square-cube law** | As a body grows, its volume (and mass) grows faster than its surface area or muscle cross-section. |
| **Strouhal number** | Tail-beat frequency times amplitude over speed. Efficient swimmers cruise between 0.2 and 0.4. |
| **Substep** | A smaller time step inside one tick (4, 8 or 16 per tick in Phylotank) that keeps fast-moving joints stable. |
| **Thrust** | The forward push a fin or a tail makes against the water. |
| **Torque** | A turning force. |
| **Viscosity** | How thick, or syrupy, a fluid is. Phylotank's water is 20 times as viscous as sea water, so that both the microbe and the giant regimes fit in one tank. |
| **XPBD** | Extended position-based dynamics: a stable way to solve joints and contacts by moving positions directly. |

## Ocean and habitat

| Term | Meaning |
|---|---|
| **Abyssal plain** | The deep, dark, flat floor of the ocean. |
| **Anoxic, hypoxia, dead zone** | Without oxygen; too little oxygen; a region where oxygen has run out and animals die. |
| **Basin, shelf, slope, trench** | The default tank's zones: a sunlit shelf with reefs, a cave-riddled slope, the dark plain and a trench with vents. |
| **Beer-Lambert attenuation** | Light fading exponentially with depth through absorbing water. |
| **Current, eddy, gyre, streamfunction** | Moving water; a swirl in it; a large circulating current; the mathematical field from which Phylotank derives a current that never creates or destroys water. |
| **Hydrothermal vent** | A hot, mineral-rich spring on the seafloor, an oasis in the dark. |
| **Ice age, sea level** | A long cold spell during which the water surface falls and ice covers it. |
| **Marine snow** | See detritus. Also a god power that rains food down. |
| **Reef** | A rocky or living structure that shelters prey. |
| **Sediment** | Settled particles on the floor, which store nutrients and dormant cysts. |
| **Thermocline, stratification, turnover** | The layer where warm surface water meets cold deep water; the water being layered that way; seasonal mixing that brings deep nutrients up. |
| **Turbidity** | How cloudy the water is. Meteors and earthquakes stir it up and dim the light. |
| **Twilight zone, midnight zone** | Depths where light is faint; depths where it is gone. In the Default tank twilight starts at about 8 m and midnight below about 23 m. |
| **Upwelling** | Deep, nutrient-rich water rising to the surface. |

## Look, film and sound

| Term | Meaning |
|---|---|
| **Banding** | Visible steps in a smooth dark gradient; dither hides them. |
| **Bloom (render)** | A soft halo around bright things. Not to be confused with an algae bloom. |
| **Caption, lower third, title-safe** | Phylotank's documentary text; the band at the bottom of the frame where it sits; the inner area that TVs never crop. |
| **Caustics** | The rippling bright patterns that light makes through a wavy surface. |
| **Chroma, hue, lightness** | How colourful a colour is; which colour it is; how light or dark it is. |
| **Dip to dark** | The director's slow fade through black between shots instead of a hard cut. |
| **Dither, blue noise** | Adding very fine, even noise to an image so that gradients do not band. |
| **Drone, pad, leitmotif** | A sustained low note; a soft sustained chord; a short tune tied to one character, here one per species. |
| **Establishing shot, tracking shot, push-in, scale reveal** | A wide shot that shows where we are; following a subject; a slow move closer; a zoom out that shows how big something is. |
| **Fresnel rim, specular highlight** | The brighter edge a translucent body shows where you see it at a glancing angle; the small bright reflection of a light source, such as the dot in an eye. |
| **Lydian, Phrygian** | Musical modes: bright and open; dark and tense. Phylotank's ambience moves from one towards the other after a disaster. |
| **OKLCH** | A colour space based on lightness, chroma (colourfulness) and hue that matches how people see colour. Creature colours are genes in it. |
| **Photosensitive safety, WCAG 2.3.1** | Keeping flashes slow and gentle enough not to trigger photosensitive seizures; the web accessibility rule that defines it (no more than three flashes in any second). |
| **SDF (signed distance field)** | A way to draw smooth shapes by knowing, for every pixel, how far it is from the shape's edge. Phylotank's bodies are drawn this way. |
| **Spring (critically damped)** | A motion rule that eases the camera to a target as fast as possible without overshooting. |
| **Tonemapping** | Squeezing very bright and very dark light into what a screen can show. |
| **Trails** | The fading streaks of light that glowing creatures leave behind. |
| **van Wijk and Nuij path** | A smooth, efficient way to zoom out, pan and zoom in, used for the director's big scale changes. |

## Platforms and packaging

| Term | Meaning |
|---|---|
| **Cast (a tab)** | Sending a Chrome tab's picture and sound to a TV through Chromecast or Google TV. |
| **Chromecast, Google TV, Android TV** | Google's TV devices and their operating system. |
| **Lively Wallpaper** | A free, open-source Windows program that shows web pages and videos as the desktop background. |
| **Portable zip** | The Windows download that installs into your user folder with no administrator rights. |
| **`.scr` (screensaver file)** | The Windows screensaver format; Phylotank's is a small wrapper that opens the screensaver view. |
| **SmartScreen** | The Windows warning shown for unsigned downloads. |
| **Tray app** | The small Phylotank program in the Windows notification area that starts and watches over the host. |
| **WebView2** | The Microsoft Edge engine that Windows apps (Lively and the screensaver) use to show web pages. |
