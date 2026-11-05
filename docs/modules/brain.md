# src/brain: design notes (phase 1)

Owner: brain engineer. Design: [03-brains.md](../sections/03-brains.md) as reconciled by DESIGN R3, R4, R9, R13, R15, R16, R18, R34 and CONTRACT 5.3, 6.7, 8. Contract gaps are in [contract-requests/brain.md](../contract-requests/brain.md); spike 8 is [spikes/brain-8.md](../spikes/brain-8.md).

## Files

| File | What |
|---|---|
| `layout.ts` | CONTRACT 8.1 layout: ordered inputs, outputs, neurons, stable keys, substrate coordinates and types, size class, trimming |
| `traits.ts` | decoded BrainTraits and body traits |
| `develop.ts` | direct encoding: neuron parameters, innate reflexes, innate gait, drives, oscillator couplings, DSYN genes; calls the CPPN when `ENCODING = 1` |
| `cppn.ts` | CPPN compile and evaluate, 64-bit hashed innovation ids, CPPN wiring (LEO, canonical order) |
| `pool.ts` | class pools: free slot search, writing a brain into a slot, freeing, derived per-brain constants (`BrainStatic`), `alpha` recomputation |
| `sense.ts` | perception: internal and clock inputs, eyes (3 bands plus proximity, occlusion), lateral line, smell (level and rate), touch, taste, proprioception |
| `think.ts` | the batched CTRNN and oscillator tick, ABCD plasticity, NaN guard, act step with trigger hysteresis |
| `inspect.ts` | inspector frame: int8 activations plus 8 f32 scope neurons |
| `templates.ts` | behaviour templates (BrainTraits settings) for the seven body templates |
| `fixture.ts` | phenotype fixtures and test-world helpers (a local adapter until `genome.develop` lands) |
| `spike8.ts` | spike 8 toy task, mutation operators and evolution loop |

## Decisions

1. **Direct encoding is the default** (`ENCODING = 0`), as review R15 asked and spike 8 confirms. The CPPN is complete and tested behind `ENCODING = 1`; templates set 0.
2. **Slot order is canonical and fixed per neuron**: reflexes and the innate gait first; then CPPN links whose `leo > 0`, visiting candidate sources in ascending unified index (inputs, then neurons) and stopping when the K slots are full; then DSYN genes in `(src, dst)` order. Nothing is ranked by `|w|`, so a small genetic change only adds or removes the links it touches (R15). A DSYN gene in the CPPN encoding is a HybrID override: it adds to an existing link from the same source, else takes a free slot.
3. **Module keys make duplicates arrive wired.** A DSYN gene keyed by module applies to every instance of the module; the duplicated part also inherits its innate gait (cpgPhase, cpgAmp are module genes), so the direct encoding already gets "brain follows body" for repeated parts. Instance keys (flag bit 2) wire one instance.
4. **Innate reflexes** (03 §3.8.2) and drives, with the weights used (all scaled by the named gain gene):

| Target | Source: weight |
|---|---|
| CPG_AMP | BIAS: swim (0.5 + activity); hunger: hungerSeeks; fear: fearFlees |
| CPG_FREQ | BIAS: 0.25 swim; fear: 1.5 fearFlees (0.5 + riskAversion); lateral D and V: 1.5 startle; bias theta activity - 0.5 |
| CPG_TURN | lateral D: -1.5 startle, V: +1.5 startle; touch D: -2 avoidWall, V: +2; plant smell rate: -4 graze; BIAS: 0.4 graze (only with a plant nose) |
| MATE, LAY_BUD | libido: 2 reproduce; LAY_BUD also REPRO_LOAD: 2; theta -1 and -1.5 |
| EMIT_INTENSITY | libido 0.5; theta 2 lightShow - 1 |
| MUSCLE | own or nearest ancestor oscillator: 2 innateGait cpgAmp; CPG_TURN: 0.6 (0.3 for fins) times the dv sign |
| FIN_PITCH | oscillator: innateGait cpgAmp; CPG_TURN 0.5 |
| MOUTH_OPEN | plant smell level 1.5 graze; hunger 1 |
| BITE, LATCH | own taste: 3 biteOnTaste (BITE), 2 (LATCH); BITE also aggression 1 |
| organ drives | photophore from EMIT_INTENSITY; cilia from CPG_AMP; jet from its oscillator and CPG_AMP; bladder from DEPTH with theta -2 prefDepth; gland from fear; grip from touch |
| hunger | ENERGY -2, GUT -1; theta bias + 1.5 + 2 (appetite - 0.5) |
| fear | PAIN 3 (1 - 0.5 boldness), first eye centre proximity 2 x vision gain, head lateral D 0.5, blood smell 1; theta bias - 1 - boldness |
| libido | MATURE 2, ENERGY 1; theta bias - 2 |
| fatigue | FATIGUE 2, DAY_SIN -chronotype; theta bias - 1 |
| aggression | hunger 1, PAIN 1, blood 0.5; theta bias + aggression - 0.5 |
| sociality | pheromone A level 1; theta bias + sociality |
| pleasure, pain | taste 2 and ENERGY 0.5; PAIN 3 and toxin taste 2 |

   The BIAS-into-CPG_TURN term exists because a linear "smell rate into turn" reflex makes a creature orbit a food source at 90 degrees (the rate term's stable fixed point); a small turning bias that the rate suppresses when smell improves gives a biased walk that spirals in. Found while calibrating spike 8.
5. **Time constants.** Motors 20 ms x TAU_SCALE (so the innate gait passes through almost unfiltered); emission motors (EMIT_INTENSITY, EMIT_HUE, PHOTO_INTENSITY) 0.5 s, so brain-driven light cannot flicker faster than about 0.3 Hz by construction (R18); trigger motors 0.1 s; drives DRIVE_TAU x 4^(2 patience - 1); modulators 0.2 s; head and ganglion hidden 0.1 s x TAU_SCALE (CPPN node queries override); DNEU from the gene (log 50 ms to 120 s).
6. **Oscillators** couple to the nearest ancestor part's oscillator and back with k = 4/s, lag 0; the innate-gait phase offsets are applied at the output (`phaseOff`), so equal phases produce the designed travelling wave. The CPPN encoding replaces k and lag by a pair query (k = 10 sigmoid(w), lag = pi tanh(eta)).
7. **Trimming** follows CONTRACT 8.2 (head hidden beyond 64, ganglia from the tail, eye receptors merged pairwise up to 4 times), each stage by bisection, then three extra stages needed only by pathological bodies: oscillators, part inputs and part outputs from the tail. The random-body fuzz test checks that every brain fits a class.
8. **Personality individuality** draws from stream DEVELOPMENT, subject entity id, at `allocate`; offsets are not inherited.
9. **Sense.** Neighbours come from a 0.5 m uniform grid rebuilt per call in `(cell, slot)` order; one gather per creature (at most 49 cells, at most 512 neighbours), then every eye and lateral organ filters it. Objects subtending under 0.004 rad are skipped (R5). Eyes: `I_c = (glow c_j + 0.5 A_j c_j) s_c exp(-kappa d) / (1 + (d / r0)^2)`, `log(1 + I / 0.05)` normalised to [0, 1]; background bins looking up see `A_own x upward component`. Smell rate is `5 s x grad(level) . v` (the temporal derivative along own motion, stateless). Plant smell is scent channel 0 plus the phytoplankton density in units of 1 g/m^2. PAIN uses the previous health held in the pain modulator's `phase` lane.
10. **Hysteresis and cooldown** for MATE, LAY_BUD (latched in `out`) and ROLL (2 s cooldown in its motor's `phase` lane): contract request B3.
11. **Determinism.** No platform transcendentals (dmath only), no Map iteration feeding results, fixed slot orders, Philox per (stream, tick, entity id, block). `tests/brain.test.ts` checks that two worlds hash the same after 200 ticks of sense and think.

## Performance (measured, see the spike for the setup)

The worker was shared with about 11 other engineers (load average 8 to 12 on 4 cores), so these are pessimistic.

- A full C4 brain tick (4,096 synapses): 71 us of CPU time (58 M synapse updates per second). 1,000 C2 fish with eyes and lateral lines: sense 8.0 ms, think 4.0 ms CPU time per tick.
- Development per birth (minimum of repeats): 1-part microbe 77 us direct and 477 us CPPN; 7-part fish 156 us and 946 us; 38-part body 729 us and 2,144 us.

## Stubbed or left

- ITCH reads 0 and GLAND_FULL reads 1 (no data source yet). Taste is approximate (EATING flag, else phytoplankton under the mouth).
- BITE and LATCH write `brainState(world).segAux` until the contract gives them a column (B1).
- No GPU kernel; the CPU tick is written in the kernel's shape (per class, fixed strides, slot-major synapses).
- No behaviour classifier yet (03 §3.10 metrics); the inspector frame exists.
- Brain mutation operators live in `src/genome`; spike 8 has its own local ones, with the rates recommended for the genome engineer in the spike report.
