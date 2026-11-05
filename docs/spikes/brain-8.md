# Spike 8: brain encoding shoot-out (direct versus CPPN)

Status: measured 2026-11-05, phase 1. Decides the default `ENCODING` for templates (CONTRACT 17). Review R15; DESIGN R3.

## Decision

**Keep the direct encoding (`ENCODING = 0`) as the default for every template in v0.1.** The CPPN stays implemented and tested behind `ENCODING = 1` as an experiment. On this task the direct encoding evolved better controllers (median held-out fitness 1.58 against 1.24, Mann-Whitney U = 72 of 100, two-sided p about 0.10, so a tendency rather than proof), it uses its brain genes in every run while the CPPN expressed no link at all in 8 of 10 runs, and it develops 4 to 6 times faster. Its main weakness, mutational load, is real but moderate (64% of single mutations neutral against 85% for the CPPN), and the fix is in the operator rates, not the encoding. Both encodings make duplicated organs arrive wired; the module-keyed DSYN genes plus the innate gait give the direct encoding the benefit that R3 claimed for the CPPN. No contract change is needed: CONTRACT 6.7 already defaults `ENCODING` to 0.

## Setup

Everything here is reproducible: `SPIKE8=1 SPIKE8_MODE=full SPIKE8_SEEDS=1,2,3,4,5,6,7,8,9,10 SPIKE8_POP=20 SPIKE8_GENS=25 SPIKE8_DFE=120 SPIKE8_LOG=out.log SPIKE8_OUT=out.json npx vitest run tests/brain-spike8.test.ts`, and `SPIKE8_MODE=lesion` for the lesion table. The harness is `src/brain/spike8.ts`; the brains are the real `src/brain` development and CPU tick (`developBrain`, `tickBrain`, `actBrain`), not a copy.

- **Body.** A fish fixture (`fishBody`): head, a trunk module repeated 5 times with an innate travelling wave (`cpgPhase = t x phaseStep`, `cpgAmp`), one paired fin on trunk 1, a plant nose on the head. Class C2: 40 neurons, 46 inputs, K = 16. Phase step and amplitude are heritable body genes in both arms.
- **Task (toy kinematics, not physics, because spike 1's swimmer was not available).** Thrust is the travelling-wave signed area of adjacent trunk muscle commands, `c_i dc_{i+1}/dt - c_{i+1} dc_i/dt` (positive for a head-to-tail wave), plus fin stroke times pitch; turning rate is 3 x the mean trunk bend; `dv/dt = 0.15 thrust - v`. One food item at a time, 5 to 12 body lengths away; plant smell `log(1 + 5 exp(-d / 8))` feeds the nose's level and rate inputs. 40 s per trial. Fitness = items eaten + 0.5 x progress towards the current item - 0.001 x muscle effort. Training uses 4 fixed trials, every reported number uses 8 different held-out trials.
- **Arms.** Both start from the same reflex-only brain (innate reflexes, gait oscillators, drives; no DSYN genes; the CPPN arm's single connection, bias to LEO at -1, expresses nothing), so generation 0 is identical. Direct: DSYN genes keyed by module (so all trunk copies share them). CPPN: `ENCODING = 1`, links where `leo > 0` fill free slots in canonical order, no DSYN overrides.
- **Mutation.** Each offspring gets one event plus a second with probability 0.5. Event mix in both arms: 25% a brain trait (9 reflex, gait and gain genes, N(0, 0.05 of range)), 10% a body gait gene, 65% encoding-specific. Direct: weight perturbation N(0, 0.4) of one DSYN gene 55%, remove 7%, add (random module-keyed source and target, weight N(0, 1)) 38%. CPPN: weight perturbation N(0, 0.4) of one connection 55%, add connection 20%, add node (NEAT split, hashed id) 10%, toggle 7%, change node function 8%. So both arms run about 1.5 point events per birth, far below the 0.8 per connection of 03 §3.6.4 that R15 objected to.
- **Selection.** Population 20, 25 generations, truncation to the best quarter with elitism; 10 seeds per arm.
- **E2 (forced duplications), on each run's best genome.** `insTrunk`: a literal copy of trunk 1 inserted behind it (same module, same innate phase, new path hash; every part behind it shifts in u). `dupTrunk`: the trunk repeat count + 1 (a new tail segment continuing the wave). `dupFin`: a second copy of the fin. "Unwired" is the NEAT-style control the design asks for: the same body, but every inbound synapse of the new part's motors removed, so the new organ starts unconnected.
- **E8 (distribution of fitness effects).** 120 single-event mutants of each best genome, relative fitness change on 4 held-out trials: lethal < -50%, deleterious -50% to -2%, neutral within 2%, beneficial > +2%.
- **Machine.** A 4-core container shared with about 11 other engineers (load average 12 to 25 during the runs). Wall-clock times are therefore pessimistic by 2 to 6 times; timings below are the minimum over repeats, or process CPU time where stated.

## Results (10 seeds per arm; held-out trials)

### Fitness and how it is reached

| | Direct | CPPN |
|---|---|---|
| generation 0 (both arms identical: reflexes only) | 0.535 | 0.535 |
| best after 10 generations, median | 1.93 | 1.13 |
| best after 25 generations, held-out, median (mean) | **1.58** (2.13) | **1.24** (1.65) |
| per seed | 1.06 2.90 2.73 1.28 1.53 1.00 2.70 4.98 1.57 1.59 | 5.28 0.91 1.20 1.24 0.98 1.24 1.41 2.07 1.31 0.90 |
| runs whose brain genes express any synapse | 10 of 10 (2 to 8 DSYN genes, 45 to 54 synapses) | 2 of 10 (154 and 120 synapses; the other 8 stay at the reflex-only 43) |

E1 on the toy (03 §3.15): the reflex-only brain scores 0.535; 20 random direct brains (30 random DSYN genes of weight N(0, 2), random reflex gains) have median -0.04 and none beats the reflexes. Generation 0 stands on the reflexes.

**Lesion** (re-evolved seeds 1 to 4, deterministic, then the DSYN or CPPN genes removed; "gait only" is the reflex-only brain with the run's evolved gait genes):

| Seed | Direct: evolved / without DSYN / gait only | CPPN: evolved / without CPPN / gait only |
|---|---|---|
| 1 | 1.06 / 0.91 / 0.54 | 5.28 / 0.96 / 0.40 |
| 2 | 2.90 / 0.13 / 0.13 | 0.91 / 0.91 / 0.83 |
| 3 | 2.73 / 0.40 / 0.64 | 1.20 / 1.20 / 0.47 |
| 4 | 1.28 / 1.27 / 0.66 | 1.24 / 1.24 / 0.87 |

In the direct arm the DSYN genes carry most of the gain in 2 of 4 seeds; in the CPPN arm the CPPN carries it in 1 of 4 (the best single run of the whole spike) and is irrelevant in the other 3, where evolution only tuned reflex gains and gait. This is review R15 point 4 ("evolution may simply tune reflex gains and leave the CPPN irrelevant"), measured: a CPPN that starts silent has to find a connection whose LEO crosses zero before selection sees anything, while a direct gene is one synapse with an immediate, local effect.

### E2: forced duplications (relative change of held-out fitness)

| Variant | Direct, wired | Direct, new part unwired | CPPN, wired | CPPN, new part unwired |
|---|---|---|---|---|
| copy of trunk 1 inserted behind it | **-0.6%** median, worst -5.2%, 0/10 drop > 20% | **-55%** median, worst -74%, 9/10 drop > 20% | -0.4%, worst -0.7%, 0/10 | -7.6%, worst -77%, 4/10 |
| trunk repeat + 1 (new tail segment) | +1.7%, worst -26%, 2/10 | -2.2%, worst -23%, 1/10 | -0.6%, worst -6.6%, 0/10 | -3.4%, worst -16%, 0/10 |
| second fin | -0.6%, worst -5.0%, 0/10 | 0.0% | -0.5%, worst **-102%**, 1/10 | 0.0%, worst -101%, 1/10 |

- Both encodings pass E2's target (a duplication costs at most 20%) for the inserted copy, which is the case where an unconnected organ hurts: an unwired segment in the middle of the chain breaks the travelling wave and costs half the fitness, a wired one costs under 1%.
- Appending a tail segment (repeat + 1) changes the body itself, so even wired it can hurt: 2 of 10 direct creatures lost more than 20% (worst -26%), because the extra segment shifts the mean bend the creature's turning was tuned to. That is a body effect, not missing wiring (the unwired tail costs about the same).
- The direct encoding gets this from module keys (the DSYN genes name the trunk module, so the copy receives them) and from the innate gait being a module gene. The CPPN arm's smaller unwired penalty only reflects that 8 of its 10 creatures do not depend on brain genes at all.
- The CPPN's worst case is a new finding: in the seed-1 CPPN creature a second fin destroys the behaviour **whether or not the fin is wired**, because the extra fin neurons change other neurons' candidate source lists, and canonical-order slot filling then gives some old links' slots to new ones. Slot competition is a residue of the ruggedness R15 described for top-K selection; LEO with fixed order removes the |w| ranking but not the competition for K slots. The direct encoding has no such coupling: a DSYN gene's slot does not depend on other parts.

### E8: distribution of fitness effects of single mutations (120 mutants x 10 seeds)

| | Direct | CPPN |
|---|---|---|
| lethal (< -50%) | 7.3% | 3.3% |
| deleterious (-50% to -2%) | 20.4% | 8.2% |
| neutral (within 2%) | 64.1% | 84.5% |
| beneficial (> +2%) | 8.2% | 4.0% |
| mean relative effect | -8.0% | -3.4% |

By operator (mean effect, fraction neutral): direct DSYN add -3.4% / 0.89, DSYN weight -7.5% / 0.72, DSYN remove -14% / 0.66; CPPN weight -0.8% / 0.99, add connection -2.9% / 0.94, add node -4.9% / 0.93, toggle -9.2% / 0.88, change function -2.0% / 0.98; shared trait -6.5% / 0.44 (direct) and -3.4% / 0.66 (CPPN); gait gene -24% / 0.18 (direct) and -12% / 0.49 (CPPN). The CPPN is gentler mostly because most of its mutations change links that are not expressed; the direct encoding has twice the beneficial fraction. The gait genes are the most dangerous operator in both arms: their step of 0.2 rad (phase) and 0.1 (amplitude) is too coarse once a brain has been tuned around them.

**Recommended brain mutation rates for `src/genome` (direct encoding),** to keep the load low (R15): per birth, scaled by MU_LOG, about 0.35 DSYN weight perturbations with sigma 0.25 (not 0.4), 0.1 DSYN additions, 0.03 removals, 0.25 BrainTraits perturbations of 0.05 of range, and innate-gait perturbations (cpgPhase, cpgAmp, phaseStep) with half the step used here. For the CPPN, if it is revived: perturb one connection per birth (never 0.8 per connection), toggles at 0.01.

### Development time per birth (JavaScript, `developBrain`, minimum of 15 repeats)

Genomes after 60 random mutation events: 13 DSYN genes; CPPN with 11 connections and 1 hidden node.

| Body | Parts | Class (N, I) | Layout only | Direct | CPPN |
|---|---|---|---|---|---|
| microbe | 1 | C1 (22, 18) | 23 us | 77 us | 477 us |
| fish (spike body) | 7 | C2 (40, 46) | 37 us | 156 us | 946 us |
| large (30 trunk, 6 fins, eye, 3-channel nose) | 38 | C4 (133, 191, inputs trimmed) | 239 us | 729 us | 2,144 us |

The CPPN costs 0.4 to 1.4 ms more per birth (about 40 to 128 candidate queries per target neuron). At the 03 §3.14 target of 2,000 C0 births per second on 2 workers, the direct encoding needs about 0.15 core and the CPPN about 1 core. Under the shared-machine load the in-run means were 2 to 3 times these minima.

### Brain tick cost (CPU reference)

- A full C4 brain (256 neurons x 16 slots = 4,096 synapses, every slot used, exploration noise on): **71 us of process CPU time per tick, 58 M synapse updates per second**, inside 03 §3.9.6's CPU estimate of 50 to 100 M per second per core (41 to 82 us). The minimum wall time under the machine's load was 161 us.
- 1,000 C2 fish (6-receptor two-band eyes, lateral line on 6 segments, 3-channel nose, 46 inputs, 40 neurons) in one Small world: sense 8.0 ms and think 4.0 ms of CPU time per tick (minimum wall 6.2 and 3.0 ms). Padding slots are skipped, so think scales with real synapses. Perception dominates; the v0.1 budget (2,000 agents at 30 ticks per second on 2 cores) needs either cheaper senses for small creatures (most v0.1 agents are microbes without eyes, which skip the neighbour search entirely) or the governor's brain divisor of 2.

## Caveats

- The task is a toy with hand-made kinematics; spike 1's XPBD swimmer and spike 3's world were not ready. The comparison is about how each encoding responds to mutation and duplication on the same body and the same reflex floor, not about absolute swimming.
- 10 seeds, 25 generations, population 20: enough to see the direction (and the CPPN's silent start), not to rank small differences. The CPPN might do better with a non-silent initial CPPN (for example inputs connected to w and LEO), but then generation 0 is no longer the reflex floor and E1 suffers.
- The CPPN arm had no DSYN overrides (HybrID); E3 (overrides help) was not run.
- Timing was measured on a heavily shared 4-core container; re-measure on William's PC before using the numbers for budgets.

