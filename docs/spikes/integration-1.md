# Spike integration-1: the real modules together, balance, and whether evolution happens

Owner: integrator (phase 2, night of 2026-11-05). Machine: the shared build container, 4 vCPU at 2.1 GHz, load average 12 to 36 from parallel engineers, so every wall time here is pessimistic (an idle core is about 3 to 4 times faster).

## 1. What runs

`sim = createSim(realModules())`: src/genome (develop, mutate, repair, one innovation registry per world), src/physics (XPBD trees, contacts, bites), src/brain (layout, CTRNN and oscillators, reflexes) and src/ecosystem (fields, producers, metabolism, feeding, ageing, reproduction requests, deaths), with the sim's commit following the ecosystem's pending requests (`src/sim/eco-commit.ts`). Every ledger audit in every run below was exact (integer equality).

## 2. Cost

| Set-up | ms per tick | Per agent per tick |
|---|---|---|
| 200 Motefly (0.8 mm, 9 parts), genome only (fallback physics, brain, ecology) | 1.2 | 6 µs |
| the same with real physics | 31 | 0.15 ms |
| the same with real physics and brain | 48 | 0.24 ms |
| all four real modules, 155 Motefly placed | 28 to 38 | 0.18 to 0.24 ms |

So on this box one worker core carries about 150 to 200 agents at 30 ticks per second; an idle desktop core perhaps 500 to 800. The v0.1 target (2,000 agents at 30 Hz on at most 2 cores) is about 2 to 4 times out of reach on the CPU path until mod/perf and the physics speed-up land. The dream tank therefore starts with 347 founders and an agent cap of 1,200; the pacer falls behind real time when the population grows, it never skips ticks.

## 3. Balance: what was wrong, what changed

Measured per creature per second (ledger channels, quanta of 1 ng), Small Basin, 100 founders of one template, 30 s of sim time:

| Template, release | Ingestion | To reserve | Costs (basal + muscle + organs + repair) | Verdict |
|---|---|---|---|---|
| Motefly (filter), open water, contract values | 4,320 | 495 | 693 | starves: reserve falls, maturity shrinks, no births |
| Motefly, after the fixes below, released at the surface | 8,160 | 1,510 | 736 | grows: surplus about 770 q/s, doubling in about 4 min |
| Meadowlamp (rasp grazer), open water | 1,060 | 112 | 5,800 | starves: never reaches a surface to graze |
| Meadowlamp, released on the shelf | 42,900 | 6,730 | 7,600 | marginal (V02 in the designer's budget too) |
| Ashpicker (suction detritivore), on the floor | 0 | 0 | 14,300 | starves: suction mouths had no intake path at all |
| Ashpicker, after suction feeds via filter and deposit paths | 527,000 | 24,500 | 19,200 | grows |

Changes (all recorded in the code and in docs/contract-requests/APPLIED.md):

1. **Pumping power is charged** (CONTRACT 9.5 `P_pump = 0.5 B filter`): it was not, which hid how tight the filter budget is.
2. **Selective filtering**: a filter retains particles in proportion to the enzymes that digest them (`filterSelect0 = 0.25` for a kind it cannot digest). Before, a plant specialist's gut and Holling budget filled with detritus it could not use (assimilation 0.115 instead of 0.2).
3. **Holling ceiling 8 to 12 basal** (`J_MAX_BASAL`, CONTRACT 9.5) and a **feeding current of 1 body length per second** (`pumpFloorBL`, was 0.2): at 8 a microbe's assimilated ceiling (2.4 B) barely covered basal, repair, pumping, SDA and its brain (about 1.9 B). This is evolab-1's "J_max ceiling limits generation time", now measured on the real modules.
4. **The jet-blob exploit is closed at its source**: the `SESSILE` trait alone used to grant still-water intake (the creature's own velocity treated as zero, so the full current counted as feeding flow) anywhere in mid-water. Only the physical attached state (`CF.SESSILE_ATTACHED`, set by physics) does that now. evolab-1 saw sessile filter blobs take over after about 8 h; with this rule a drifting "sessile" creature gains nothing over a drifting swimmer.
5. **Suction mouths feed**: through the filter path at 0.8 and, near the substrate, the deposit-feeding (sediment) path at 0.5. Every suction feeder starved before.
6. **Diet diversity by placement**: founders are released where their food is (`zone`: surface layer for filter feeders, the lit shelf for grazers, the floor for detritivores). Without this every grazer and detritivore starved within minutes, which is evolab-1's "every world collapsed to filter feeders".

Not changed (decisions): brain cost (review B8) stays as the contract has it; at 0.8 mm a C1 brain is 2.5% of basal in these runs, not the 38% the brain spike estimated for 0.5 mm. The cap fee stays additive.

## 4. Does evolution happen? (evolab on the real SimCore)

Runs (`node tools/evolab/evolab.mjs run --engine sim ...`, results in `tools/evolab/results/integration-1/`):

- B-motes: 150 Motefly at the surface, agent cap 300, seed 1.
- C-web: 130 Motefly, 30 Meadowlamp (shelf), 16 Ashpicker (floor), 5 Sievebell, 4 Hushmaw, agent cap 450, seed 2.

RESULTS_PLACEHOLDER
