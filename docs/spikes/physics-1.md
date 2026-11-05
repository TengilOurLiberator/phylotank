# Spike 1: XPBD swimmer and microbenchmarks (physics)

Owner: physics. Review spike 1 (REVIEW §9, R4 to R7); CONTRACT §17 says it decides the substep floor, the contact append strategy and the perception query cost. The spikes README names this report `01-xpbd.md`; the phase-1 brief limits physics to `docs/spikes/physics-*.md`, so it lives here and the integrator may rename it.

## 1. Question

1. Does swimming emerge from the drag model and the integrator, at low Re (Purcell, scallop theorem, Gray-Hancock) and at high Re (an anguilliform undulator)?
2. Does the integrator leak or inject energy (REVIEW R6, R7), and does evolution exploit numerical error (the exploit-transfer ratio)?
3. How do results converge with the substep count (T1) and the tick rate (T2)?
4. What does it cost on the CPU backend, in segments per second, and what do the hash, contact and perception queries cost (R5)?

## 2. Set-up

- Node v22.23.4, vitest 5.1.0, Linux x64, Intel Xeon @ 2.10 GHz, 4 vCPUs. The box was shared by about 11 engineers during the run (load average 20 to 31), so all timings are **process CPU time** (`process.cpuUsage`), not wall time, and are still inflated by contention. Treat them as upper bounds.
- Code: branch `mod/physics`; numbers from the commits after `43c7fb2` (tree solver) unless a row says "GS".
- Command: `PT_SPIKE=1 npx vitest run tests/physics-spike.test.ts tests/physics-bench.test.ts --no-file-parallelism --silent=false`, which prints `SPIKE <tag> <json>` lines. Without `PT_SPIKE` the quick variants run in `npm test`.
- Scenes are built by hand (`src/physics/testkit.ts`) because `genome.develop` is still a stub. Gravity is off in the swimming scenes (neutral bodies). Tank water `nu = 2e-5`, `rho = 1025`, `T = 15 C`.
- The independent low-Re reference (`src/physics/reference.ts`) is a quasi-static resistive-force solver: no inertia, the root velocity solved from zero total drag force and torque at every instant, RK4 in time. It shares only the drag law with the integrator.

## 3. Numbers

### 3.1 Two changes the spike forced before anything else worked

| Finding | Evidence | Change |
|---|---|---|
| Constraint projection weighted by bare mass gives vacuum-like motion at low Re | (design analysis; microbe drag time 35 µs against a 8 ms substep) | Every XPBD projection uses the inverse of the drag-augmented generalised mass `A = M3 + h C` (3x3 per segment), the linearly implicit drag inside the constraint solve |
| The velocity-capped explicit motor of 02 §2.2.5 makes gaits depend on `n_sub` | 2-segment joint driven at 0.3 activation: deflection 0.006, 0.025, 0.10, 0.34 rad at `n_sub` 2, 8, 32, 128 (the cap `omega_max / (h * mobility)` scales the torque with 1/h) | Muscles are implicit: torque `amax (1 - w/w_max)` (linear force-velocity through Hill's end points) enters the bend row as a rest offset `amax * compliance` plus extra XPBD damping `amax / w_max`. Deflection then 0.42, 0.43, 0.43 rad at 4, 16, 64. A curved Hill law fed back from the start-of-substep velocity chattered on 8-segment chains |
| One Gauss-Seidel pass per substep does not converge on long drag-dominated chains | 24-segment flagellum, prescribed wave: speed error against the reference -101% (`n_sub` 4), -92% (16), -57% (64); 32 passes at 4 substeps still -42% | Joints of a creature are solved **exactly** each substep by a linear-time tree solve (Baraff 1996, 3x3 blocks, no fill-in, `src/physics/tree.ts`); GS stays available as `solver: 'gs'` |
| f32 angle storage turns rounding into velocity in the next tick | gap of `l * 1e-7` corrected over one substep gives `l * 1e-7 / h` | at store, children are shifted so every joint gap is exactly the f64 one |

### 3.2 Low Re (B1, B3, B2, T1)

Purcell three-link swimmer: links 0.5 mm, radius 30 µm, square stroke of amplitude 1 rad, period 2 s, Re about 1e-3.

| Quantity | Value |
|---|---|
| Net displacement per cycle | 0.0307 body lengths (reference and sim agree on direction) |
| Sim against independent reference (tree, `n_sub` 16) | 0.09% (GS: 0.6%) |
| T1, error against reference, `n_sub` 1 / 2 / 4 / 8 / 16 / 32 | 0.16% / 0.11% / 0.10% / 0.095% / 0.094% / 0.094% (GS: 8.3% / 1.5% / 1.1% / 0.97% / 0.61% / 0.34%) |
| B1 scallop (reciprocal flap of the same body) | 3.5e-8 body lengths per cycle (GS: 4.7e-5); pass mark 0.005 |

Gray-Hancock flagellum (B2): 24 links of 0.1 mm, radius 2 µm, two wavelengths, `bk = 0.3`, linear drag only, prescribed wave.

| Quantity | Value |
|---|---|
| Drag anisotropy `gamma = k_n1 / k_t1` | 1.52 |
| Gray-Hancock estimate `U = (gamma - 1)(bk)^2 V / 2` | 2.82e-5 m/s |
| Independent reference | 2.72e-5 m/s (-3.6% against Gray-Hancock: the reference is right) |
| Sim, tree solver, `n_sub` 1 / 4 / 16 / 64 | 2.32e-5 m/s at every `n_sub` (-14.4% against the reference, -17.4% against Gray-Hancock) |
| Sim, GS | see 3.1 |

The tree solver converges in `n_sub` but sits 14% below the reference. This is **open**: B2's 10% pass mark is not met. Suspects: the per-tick linear interpolation of the prescribed joint angles, or one linearised solve per substep on 24 very short links. Purcell (3 links) agrees to 0.09%, so the drag law and the projection are right.

### 3.3 High Re (B4, T1, T2)

Undulator: 8 capsules, 20 cm, radius 12 mm tapering to 5 mm, muscle fraction 0.5, `E = 3e5 Pa`, driven by its own muscles with `cmd_j = A sin(2 pi f t - 0.8 j)`.

| Gait | Speed | BL/s | Re | Strouhal `2 f a_tip / U` | Power (W) | Cost of transport |
|---|---|---|---|---|---|---|
| A 0.3, f 2 Hz (reference gait) | 0.102 m/s | 0.51 | 1,020 | 1.97 | 0.93 | 11 |
| A 0.5, f 0.5 / 1 / 2 / 3 / 4 Hz | 0.008 / 0.026 / 0.074 / 0.173 / 0.266 m/s | 0.04 / 0.13 / 0.37 / 0.87 / 1.33 | 85 to 2,660 | 6.3 / 4.3 / 3.2 / 1.8 / 1.7 | 0.9 to 2.3 | 126 / 73 / 36 / 16 / 9.4 |
| A 1.0, f 0.5 to 2 Hz | -0.001 to -0.013 m/s | about 0 | | 6 to 105 | 1.9 to 5.6 | (thrashing: joints hit their limits) |
| A 1.0, f 3 / 4 Hz | 0.110 / 0.115 m/s | 0.55 / 0.58 | 1,100 | 3.0 / 4.0 | 5.2 / 4.4 | 57 / 46 |

Swimming emerges and speed rises with frequency (roughly linearly from 2 to 4 Hz at A 0.5). B4's soft criterion is **not met**: the Strouhal numbers are 1.7 to 6 instead of 0.2 to 0.5. The quasi-steady drag model (no reactive added-mass thrust; the Munk moment and momentum-form added mass are not implemented, as the review's v0.1 cut suggests) makes a capsule-only undulator inefficient. As 02 §2.13 prescribes, this triggers a review of the drag constants and the trailing-edge flag (and a caudal fin plate in the reference fish), not a build failure.

Convergence (reference gait, against `n_sub` 64 = 0.1037 m/s, 0.884 W):

| `n_sub` | 1 | 2 | 4 | 8 | 16 |
|---|---|---|---|---|---|
| Speed error (tree) | -6.9% | -4.1% | -1.7% | -0.6% | -0.2% |
| Power error (tree) | +16% | +8.8% | +4.7% | +2.4% | +1.0% |
| Speed (GS), m/s | 0.0018 | 0.035 | 0.098 | 0.117 | 0.124 |

First-order convergence with the tree solver; at 4 substeps speed is within 2% and power within 5%. With GS the swimmer barely moves at 1 substep (R6's prediction: numerical damping eats thrust).

T2 (tick rate): 30 Hz x 4 against 60 Hz x 4: speed -2.0%, power +5.1%. At equal substep length (30 Hz x 8 against 60 Hz x 4): speed -0.9%. Tick-rate invariance holds at equal `h`; the 3% T2 mark is met for speed, not for power at equal `n_sub`.

### 3.4 Energy and momentum (C1, R6, R7, R9)

| Test | Result |
|---|---|
| C1 vacuum, random full-strength muscles, 10 s: centre-of-mass drift | 0.9e-6 to 1.9e-6 body lengths (pass mark 1e-5) |
| C1 angular momentum error (unit `m L^2 / s`), `n_sub` 4 / 16 / 64 | 5.0e-2 / 2.6e-2 / 0.94e-2 (first order in `h`; design target 1e-6 **not met**). A whip-like tail of tiny inertia turns at tens of rad/s, and one linearised solve per substep loses angular momentum at second order in the rotation per substep |
| Passive bodies in water (random initial velocities, stiff joints), 3 s | kinetic plus elastic energy never rises between ticks at `n_sub` 1, 4, 16, with and without added mass (GS rose by up to 32% in one tick at `n_sub` 1) |
| Muscle-driven budget: (drag dissipation + stored energy change) / net muscle work, `n_sub` 1 / 2 / 4 / 8 / 16 | 0.07 / 0.11 / 0.17 / 0.25 / 0.37: always below 1, so **no energy from nothing**. The rest is passive joint damping (zeta 0.05) and numerical damping, which falls with `n_sub` |
| Contacts: two overlapping bodies, vacuum | separate, total kinetic energy never rises (position corrections add no velocity; normal impulses are inelastic) |
| R9: passive 1 mm microbe in a 0.25 m/s plume for 60 s | no watchdog flag; it drifts at the water speed. An injected 0.05 m/s per tick is flagged and clamped |
| B5 Stokes settling of a near-spherical dense segment | within 5% of `(2/9) Delta rho g r^2 / mu` |

### 3.5 Exploit transfer (R6)

(1+6)-ES with the one-fifth rule, 200 generations, fitness = distance swum in 3 s from rest. Ratio = speed of the champion at the evaluation `n_sub` over its speed at the training `n_sub`.

| Swimmer | Trained at | Champion speed | At 4 | At 16 | Ratio 16 / trained |
|---|---|---|---|---|---|
| 8-segment undulator | 1 substep | 0.393 m/s | 0.295 | 0.271 | **0.69** (fails 0.8: evolution used numerical error) |
| 8-segment undulator | 4 substeps (100 generations) | 0.204 m/s | 0.204 | 0.197 | **0.97** |
| 4-segment, 2 mm muscle flagellate (Re < 0.1) | 1 substep | 3.7e-4 m/s | 3.4e-4 | 3.3e-4 | 0.88 |

Jaw-locked and grabbed prey (links solved inside a shared 8-substep loop for the linked pair, `tests/physics-links.test.ts`): a 6-segment prey thrashing for 3 s in a claw keeps the pair's kinetic energy below its start value plus the prey's muscle work, and the watchdog stays silent. The end-of-tick link stretch is under 10% of a segment, set by tick-rate contacts of the neighbouring segments pushing against the link.

### 3.6 CPU throughput (one core, CPU time, contended box)

Population with a size spectrum (log-uniform 1 mm to 12 cm, 4 to 8 segments), muscles active, flow sampled, watchdog on.

| Scene | Cost |
|---|---|
| Integrator, fixed `n_sub` 1 / 4 / 16 (17,940 segments), first version | 3.6 / 1.7 / 1.55 µs per segment-substep |
| Integrator at `n_sub` 4 after specialising the sparse 3x3 blocks of the tree solve and removing a per-substep allocation | **1.17 µs per segment-substep** (84 ms per tick for 17,940 segments) |
| The same with contacts and bites | 96 ms per tick: contacts add about 0.65 µs per segment per tick |
| Profile after the optimisation | tree solve 28%, drag-augmented mass and forces 27%, limits 5%, `sincos` 5%, garbage collection 5% |
| Hash build (counting sort, 47,762 items) | 0.16 µs per item |
| Contact pair query | 0.82 µs per item; 24.6 cells visited and 2.9 candidates per item; pairs equal brute force with no duplicates (test I1) |
| Perception radius query, minimum angle 0.02 rad, cap 4,096 cells, at 2 / 10 / 40 body lengths | 9.7 / 4.7 / 4.1 µs per query; 238 / 249 / 176 cells; 6.6 / 3.9 / 2.8 items |

At 4 substeps one core does about 4 x 1.17 + 0.65 = 5.3 µs per segment-tick, about 190k segment-ticks per second, so **about 6,300 segments at 30 Hz per core** (about 1,300 agents of 5 segments). v0.1's 2,000 to 4,000 agents on at most two cores fit only if bodies average about 3 to 6 segments, so a further 1.5 to 2x is still wanted: fewer substeps for passive bodies and drifters, sleeping still bodies, and a typed-array layout for the per-segment scratch. The design's laptop estimate (1 µs per segment-tick at 1.3 substeps) is about 5x optimistic at the R6 floor. These timings were taken at load average 30 on 4 vCPUs and are upper bounds.

## 4. Decision

1. **Substep floor 4 stays** (CONTRACT §3.1, §10.3, `MIN_SUBSTEPS_ACTIVE = 4`): at 1 substep the exploit-transfer ratio is 0.69; at 4 it is 0.97 and speed is within 2% of converged. No contract change. Passive bodies also use 4 in v0.x (the `nSub` column says 4, 8 or 16).
2. **Joint solver: exact tree solve per substep**, not one Gauss-Seidel pass (a physics-internal choice, no contract change). It fixes low-Re chains, makes passive energy monotone and makes T1 converge.
3. **Muscles are implicit** with a linear force-velocity law (deviation from 02 §2.2.5's curved Hill law; documented in `docs/modules/physics.md`).
4. **Contacts**: on the CPU the hash is a counting sort ordered by (cell hash, slot); queries are bounded by cells visited (at most 72), never by objects found; position corrections are fixed point (2^-20 m) and add no velocity. The GPU per-workgroup append question (R5) is not measurable on the CPU and moves to spike 2.
5. **Perception**: skip hash levels whose items subtend under about 0.02 rad and cap the cell visits; budget perception in cell visits (about 200 per query). This is for the brain module to adopt.
6. **Links** (grabs, jaw locks, latches) are solved inside the substep loop of the linked island at 8 substeps (R6); contacts use a speculative margin `|v| dt` so a 2 m/s ram cannot tunnel.
7. **Open**: B2 (-14%), B4 Strouhal, C1 angular momentum (5e-2 against 1e-6), and CPU throughput (about 1.5 to 2x short of v0.1 for 5-segment bodies).
