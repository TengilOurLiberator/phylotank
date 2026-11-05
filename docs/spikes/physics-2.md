# Spike 2: physics second pass (B4 drag review, angular momentum, throughput)

Owner: physics (second pass). Follows [physics-1](physics-1.md), which left B4 (Strouhal 1.7 to 6), C1 angular momentum (5e-2 against 1e-6) and CPU throughput (1.5 to 2x short of v0.1) open. Every number below was measured on this branch; nothing is estimated unless it says so.

## 1. Set-up

- Node v22, vitest 5.1.0, Linux x64, Intel Xeon @ 2.10 GHz, 4 vCPUs, shared with the other engineers (load average 9 to 23 during the runs). Timings are process CPU time and, for the throughput A/B, the minimum and median of 5 interleaved runs of the old and the new code in the same minutes.
- "Before" is `main` at the start of this pass (`959df0f`, spike 1's code), extracted unchanged into a scratch copy and run side by side with this branch.
- Commands: `PT_SPIKE=1 npx vitest run tests/physics-spike2.test.ts tests/physics-bench.test.ts tests/physics-spike.test.ts --no-file-parallelism --silent=false` (lines tagged `SPIKE`); the throughput A/B is a standalone esbuild bundle of the same population scene as `physics-bench.test.ts` (3,000 creatures, 17,940 segments, log-uniform 1 mm to 12 cm, 4 to 8 segments, muscles driven).

## 2. B4: the drag review

### 2.1 What was wrong

Spike 1's undulator needed Strouhal numbers of 1.7 to 6. Three causes, in order of size:

1. **No reactive thrust.** Added mass sat only in the mass matrix, which gives the `-d/dt (m_a w)` part of Lighthill's elongated-body force but not the momentum the wake carries off the trailing edge. That term is the whole mean thrust of elongated-body theory (Lighthill 1971), so the body swam by cross-flow drag alone, which is inefficient and needs large, fast tail sweeps.
2. **The reference body was round.** `fish()` had a circular section (span = 2r). Real swimmers are laterally compressed: body depth about twice the width, which raises the reactive added mass per length (proportional to depth squared) much more than the cross-flow drag (proportional to depth).
3. **Laminar friction restarted on every segment.** `k_t15` used each segment's own length as its boundary-layer length, so a chain of `n` equal segments carried `sqrt(n)` times the friction of the same body in one piece (2.8x for 8 segments).

The gait matters too: spike 1 drove every joint with the same amplitude, so the thick front half swept as far as the tail. The sweep below adds a carangiform envelope (joint amplitude rising linearly to the tail), which is the usual lab gait.

### 2.2 Changes

| Change | Where |
|---|---|
| Laminar friction along the boundary-layer run: a segment covering `[x_a, x_b]` of the body's boundary layer gets `0.665 rho sqrt(nu) (S_wet / l) (sqrt(x_b) - sqrt(x_a))`; an in-line capsule continues its parent's layer, fins and side branches start their own. With `x_a = 0` it is the old formula | `body.ts` `dragCoeffs`, `boundaryRuns` |
| Lighthill's trailing-edge term at every free leaf tip, on by default (`trailingEdge: 1`): `F = 1/2 m w^2 tau - m w u n`, `m = c_a rho pi (s/2)^2 phi`, `tau` the headward tangent, `u`, `w` the tip's water-relative velocity along `tau` and `n`. The lateral part is linearised into the drag-augmented mass, the thrust part is explicit. Its power is `-1/2 m w^2 u <= 0`; when the tip leads (`u < 0`) the lateral part is dropped and the thrust fades out, so it never adds energy | `solver.ts` |
| B4 reference body: the same 8-capsule 20 cm fish with depth = 2 x width (`fish(8, 0.2, 2)`), gait `cmd_j = A (j / 7) sin(2 pi f t - 0.8 j)` | `testkit.ts`, `tests/physics-spike2.test.ts` |

The drag coefficients (`C_n = 1.1`, turbulent `C_f = 0.004`, end caps) and `C_a = 1` were checked against 02 §2.3.1 and left alone: they are the standard cross-flow and slender-body values, and they meet the calibration target of 02 §2.6.10 (drag 0.015 N at 1 body length per second): the straight body's glide drag at 0.2 m/s is 0.0144 N (round) and 0.0150 N (compressed, 0.17 kg against the design's 0.25 kg).

### 2.3 Results

Strouhal number `St = f * (peak-to-peak tail excursion) / U` at the gait of peak efficiency, for each amplitude, 8 s runs at 4 substeps. The efficiency `eta` is a Froude proxy: the glide drag of the straight body at `U` times `U`, over the net mechanical muscle power. It is optimistic in absolute terms (the bent body's drag is higher than the glide drag, and net work nets out negative work), so read it for where it peaks, not for its value.

| Body, gait, model | St at peak eta, A 0.3 | St at peak eta, A 0.5 | Peak eta | Speed at that gait |
|---|---|---|---|---|
| Round, uniform gait, friction fix only (spike 1's body and gait) | 1.03 (4 Hz) | 1.28 (6 Hz) | 0.07 | 0.36 m/s |
| Round, uniform gait, trailing edge on | 0.71 (4 Hz) | 0.73 (6 Hz) | 0.16 | 0.51 m/s |
| Round, tail envelope, trailing edge on | 0.68 (4 Hz) | 0.82 (6 Hz) | 0.24 | 0.40 m/s |
| Compressed x2, tail envelope, trailing edge off | 0.55 (4 Hz) | 0.49 (6 Hz) | 0.29 | 0.56 m/s |
| **Compressed x2, tail envelope, trailing edge on (B4 reference)** | **0.33 (4 Hz)** | **0.37 (4 Hz)** | 0.71 | 0.67 m/s (3.4 BL/s, Re 6,700) |
| Compressed x2.5, tail envelope, trailing edge on | 0.26 (4 Hz) | 0.29 (4 Hz) | 0.91 | 0.75 m/s |

The full sweep of the B4 reference (A is the tail joint's amplitude; tail excursion is the peak lateral amplitude of the tail tip):

| A | f (Hz) | U (m/s) | BL/s | Re | St | Power (W) | eta | Tail excursion (cm) |
|---|---|---|---|---|---|---|---|---|
| 0.3 | 1 | 0.160 | 0.80 | 1,600 | 0.65 | 0.19 | 0.20 | 5.2 |
| 0.3 | 2 | 0.388 | 1.94 | 3,880 | 0.51 | 0.32 | 0.38 | 5.0 |
| 0.3 | 3 | 0.618 | 3.09 | 6,180 | 0.38 | 0.39 | 0.61 | 4.0 |
| 0.3 | 4 | 0.671 | 3.36 | 6,710 | 0.33 | 0.37 | 0.71 | 2.8 |
| 0.3 | 6 | 0.572 | 2.86 | 5,720 | 0.30 | 0.31 | 0.54 | 1.4 |
| 0.5 | 1 | 0.098 | 0.49 | 980 | 1.37 | 0.46 | 0.03 | 6.7 |
| 0.5 | 2 | 0.295 | 1.47 | 2,950 | 0.91 | 0.72 | 0.10 | 6.7 |
| 0.5 | 3 | 0.641 | 3.21 | 6,410 | 0.53 | 0.81 | 0.35 | 5.6 |
| 0.5 | 4 | 0.882 | 4.41 | 8,820 | 0.37 | 0.77 | 0.67 | 4.1 |
| 0.5 | 6 | 0.813 | 4.06 | 8,130 | 0.27 | 0.61 | 0.67 | 1.8 |

Before is spike 1's body and gait on `main`: St 1.70 to 6.27 at A 0.5 (`f` 0.5 to 4 Hz), best at 4 Hz with St 1.70.

**B4 is met** for the compressed reference fish: peak efficiency at St 0.33 and 0.37 (A 0.3 and 0.5, both at 4 Hz), inside [0.15, 0.5] and in the 0.2 to 0.4 band of cruising swimmers; speed is linear in frequency from 1 to 3 Hz at A 0.3 (0.16, 0.39, 0.62 m/s: steps of 0.23) and rises steadily to 4 Hz at A 0.5 (0.10, 0.30, 0.64, 0.88 m/s). The trailing-edge term is the main lever (St 0.50 to 0.55 without it on the same body, 0.33 to 0.37 with it); the friction fix alone moved spike 1's body from St 1.70 to 1.30 at its best gait. A round body stays at St 0.7 even with the term, so the shape belongs in the reference, as 02 §2.13 suggests ("a caudal fin plate in the reference fish"). A deep caudal fin plate on the round body was tried and swam worse (St 0.57 at peak, eta 0.15): its weak joint lets it flop, and a stiff fin ray helps only a little (St 0.33, eta 0.77 on the compressed body, the same as no fin); bodies will have to evolve their fins.

Above 4 Hz the swimmers slow down: the joints cannot follow (the 0.03 to 0.12 s activation lag and the torque caps), so the tail excursion collapses (A 0.3: 5.0 cm at 2 Hz, 2.8 cm at 4 Hz, 1.4 cm at 6 Hz). That is the muscle model's frequency ceiling, not a drag effect.

### 2.4 Convergence with the new term (T1, T2)

Against `n_sub` 64, 8 s runs:

| `n_sub` | 1 | 2 | 4 | 8 | 16 |
|---|---|---|---|---|---|
| B4 reference (compressed, envelope, 4 Hz): speed error | -9.8% | -3.5% | **-1.9%** | -1.0% | -0.5% |
| B4 reference: power error | -2.1% | -0.5% | -0.5% | -0.4% | -0.2% |
| Spike 1's round body and uniform gait (2 Hz, A 0.3): speed error | +10.4% | +6.1% | +4.2% | +2.4% | +1.2% |
| Spike 1's round body: power error | +16.6% | +8.9% | +4.6% | +2.3% | +1.0% |

First order in both. On the B4 reference T1's "below 2% at the chosen `n_sub`" holds (1.9% at the floor of 4). On spike 1's round body it does not any more (4.2% at 4 against 1.7% in spike 1): the thrust half of the trailing-edge term is explicit, evaluated from the start-of-substep tip velocity, and that body's thin tail sweeps fast. Making it implicit needs a non-symmetric block (thrust depends on the lateral velocity), which the symmetric tree solve does not take; left as is, since the error is a smooth first-order one and the exploit test below shows evolution does not use it.

T2 (30 Hz against 60 Hz, 4 substeps): B4 reference -1.0% speed, +1.4% power, both inside the 3% mark (spike 1 missed it for power); 30 Hz x 8 against 60 Hz x 4: -0.1%. Round body: -0.1% speed, +5.2% power (as in spike 1).

Exploit transfer (the spike 1 protocol, (1+6)-ES, fitness = distance in 3 s):

| Swimmer | Trained at | Ratio | Spike 1 |
|---|---|---|---|
| 8-segment round undulator | 1 substep, 200 generations | 0.64 (16 / 1) | 0.69 |
| 8-segment round undulator | 4 substeps, 100 generations | **0.94** (16 / 4) | 0.97 |
| 2 mm muscle flagellate (Re < 0.1) | 1 substep | 0.87 | 0.88 |

The substep floor of 4 still keeps the ratio above 0.8. The muscle-driven energy budget (R6) still closes below 1 at every `n_sub` (0.12 at 1 to 0.46 at 16; GS 0.02 to 0.57): no energy from nothing.

### 2.5 Low Re is unchanged

| Benchmark | Spike 1 | Spike 2 |
|---|---|---|
| B3 Purcell, sim against the Stokes reference (`n_sub` 16) | 0.09% | 0.094% |
| T1 Purcell, `n_sub` 1 / 2 / 4 / 8 / 16 / 32 | 0.16 / 0.11 / 0.10 / 0.095 / 0.094 / 0.094% | 0.17 / 0.12 / 0.10 / 0.095 / 0.094 / 0.094% |
| B1 scallop, body lengths per cycle | 3.5e-8 | 2.2e-8 |
| B2 flagellum against the reference, `n_sub` 1 / 4 / 16 | -1.1 / -0.8 / -0.7% | -1.1 / -0.8 / -0.7% |
| T6 far corner against origin | 4e-10 | 5e-10 |
| Passive bodies, energy never rises between ticks (`n_sub` 1, 4, 16, with and without added mass) | yes | yes (largest ratio 0.85) |
| B7 coasting below Re 1, body lengths | 1.4e-4 to 3.4e-3 | 1.4e-4 to 3.6e-3 |

The trailing-edge term scales with `c_a(Re) = Re / (Re + 10)` and the square of the tip's lateral speed, so at Re 1e-3 it is about 1e-4 of an already tiny inertial term. The friction change does not touch B2 and B3 (linear drag, or arms at 1 rad that start their own boundary layer).

## 3. C1: angular momentum in a vacuum

| Quantity | Spike 1 | Spike 2 |
|---|---|---|
| Largest total angular momentum, unit `m L^2 / s`, `n_sub` 4 / 16 / 64 (10 s of random full-strength muscles) | 5.0e-2 / 2.6e-2 / 0.94e-2 | 5.3e-8 / 6.7e-8 / 9.2e-8 |
| Centre-of-mass drift, body lengths | 0.9e-6 to 1.9e-6 | 0.6e-6 to 2.0e-6 |

**The 1e-6 target is right and is now met.** The error was not the linearisation of the joint rows as such: a first try that moved the attachment rows' lever arms to the gap's midpoint (which makes the joint impulses torque-free about the predicted pose) changed nothing (4.5e-2). The discrete angular momentum `sum m x_k x v_k+1 + I w` changes by the joint impulses' moment about the **start-of-substep** positions, while the linear solve takes its lever arms at the predicted pose; the difference is `h^2 sum v x F` per substep, first order overall, and large for a light tail swinging at tens of rad/s. After each tree solve the net moment `S = sum (x_old - c) x g_xy + g_theta` of the joint impulses `g = A dq` is cancelled by a rigid rotation `dtheta = -S / K` of the whole creature about its centre of mass (`K` the same sum for a unit rotation). A rigid rotation opens no joint and, about the centre of mass, moves no linear momentum. In water the same correction removes the same artefact, measured against the drag-augmented mass (the drag's own torque is not touched). What remains (5e-8 to 9e-8) is the f32 storage of velocities and angles between ticks. Cost: 2 to 5% of the integrator.

## 4. Severing, fragments and the new actuators

Measured in `tests/physics-sever.test.ts` and `tests/physics-organs.test.ts`:

| Behaviour | Result |
|---|---|
| Cut at segment 5 of the 8-segment fish | survivor 5 segments, fragment 3; every segment keeps its world pose bit for bit; tissue and reserve split `floor(f q)` with `f` the mass share; the creature pools' total is unchanged to the quantum |
| Fragment | CARCASS + `CF.FRAGMENT`, muscles off, glow 0.8 at the cut, 0.40 at 15 s (ratio 0.50), 0 at 30 s; sinks (more than 0.5 m in 31 s); a lipid-rich fragment sinks while its living, lipid-rich survivor rises |
| Survivor | swims on with closed joints (gap under 1e-4 m); `restage` with the whole Phenotype keeps the lost part lost |
| Jet bell, 2 cm | more than 0.05 body lengths per pulse; the same bell at 0.2 mm moves under 2% of that (jet Reynolds number about 0.005 against 46 for the 2 cm bell, so `c_j` fades it out) |
| Bladder | Boyle: gas volume 0.50 of its surface value at 10.08 m; a bladder fish loaded neutral drifts under 10% of a plain fish's sinking; pumping lifts it and costs more than holding; displaced 4 m down it loses gas volume and keeps sinking (the unstable equilibrium of 02 §2.3.8) |
| Roll | `out[ROLL]` held at 1 flips the mirror once (cooldown 1 s), back after release and a new rise; a bent joint swings from +0.25 through 0.07, -0.28, -0.42 to -0.25 rad over about 8 ticks instead of snapping |
| Scraping | a host rubbing its latched segment along the floor at 0.4 m/s (2 body lengths per second) sheds the parasite after 15 ticks (0.5 s); at 0.05 m/s it keeps it; a shed parasite cannot re-latch for 2 s |

## 5. CPU throughput

The same population scene (3,000 creatures, 17,940 segments, muscles driven) on spike 1's code (`main`) and on this branch, run alternately, 5 runs each, 20 timed ticks after 3 warm-up ticks, process CPU time:

| Scene | Before (min / median), ms per tick | After (min / median) | Gain (median) |
|---|---|---|---|
| Integrator, `n_sub` 4, no contacts | 72.7 / 80.8 | 50.1 / 52.0 | **1.55x** (0.72 µs per segment-substep, from 1.13) |
| Integrator and contacts, `n_sub` 4 | 87.8 / 91.8 | 77.0 / 78.8 | 1.17x |
| Integrator and contacts, substep rule (4 to 16) | 122.2 / 127.4 | 92.5 / 95.2 | 1.34x |

The "after" column also carries this pass's new work (trailing-edge term, angular-momentum correction at 2 to 5% of the integrator by profile, organs, roll and slip bookkeeping), and every optimisation was checked to leave the state hash of the scene bit for bit unchanged (with and without contacts), so the gain is free of behaviour change. The vitest benchmark of `physics-bench.test.ts` (no warm-up, noisier) gives 1,390 to 1,122 ns per segment-substep at `n_sub` 4 and 1,106 to 667 at 16.

What the profile found and what was done:

| Finding (V8 CPU profile, `node --cpu-prof`) | Change |
|---|---|
| Garbage collection 9% of the integrator: about 2 scavenges per tick, from doubles boxed when passed to or returned from calls the engine did not inline (`sincos`, `wrapAngle`, `mulTo`, the flow sampler closure, `closestSegSeg`, `accum`) and from two closures allocated per call | range functions (`sincosRange` per creature), inlined helpers, no closures in hot paths; GC fell to 3% |
| Per-substep work that is constant over the tick: added mass, buoyancy, jet and cilia forces, drag coefficients with feathering, muscle torques, XPBD gamma and alpha, rest interpolation, limits | computed once per tick into two interleaved f64 rows per segment (`wk.tc`, 18 values; `wk.jt`, 8 values) |
| Tree solve: generic 3x3 products with Jacobians that are mostly 0 and 1; general inverses of blocks that are symmetric; two `sincos` per joint | Jacobians stored as their four free entries, symmetric 3x3 inverse (same bits), one sine and cosine per segment |
| Contacts: per candidate pair two `sincos` and an eight-double call | segment axes once per tick, closest points through a buffer, a bounding-circle early out that rejects exactly the pairs the full test would |

Not cache-bound: the cost per segment-substep is the same at 585, 1,766, 5,967 and 17,940 segments (849, 809, 777, 773 ns in one series), so a structure-of-arrays rewrite of the scratch (per-creature instead of per-slot indexing) would not pay; the integrator is now arithmetic-bound at about 1,500 cycles per segment-substep, mostly the exact tree solve (30%) and the drag-augmented mass (20%).

**Budget.** With contacts at the R6 floor of 4 substeps one core now does about 4.4 µs per segment-tick, about 228,000 segment-ticks per second, so **about 7,600 segments at 30 Hz per core** (spike 1: 6,300 on a busier box; spike 1's code in the same minutes: 6,500). v0.1's 2,000 agents of about 5 segments (10,000 segments) fit in 1.3 cores; 4,000 agents need about 2.6 cores, so the top of the v0.1 range is still about 1.3x short on two cores, before brains and ecology. The remaining levers are structural, not micro: fewer substeps for passive and resting bodies (corpses and fragments on the floor), a contact pass per cell pair instead of per item (the query visits 24.6 cells per item and is now a third of the tick), and workers (the tick is per creature, so it splits cleanly by slot range).

## 6. Decisions

1. **Trailing-edge term on** (`trailingEdge: 1`), laminar friction by boundary-layer run, B4 reference body laterally compressed (depth = 2 x width). No contract change; 02 §2.3.3's "off by default" becomes "on" and should be updated by its owner.
2. **C1 correction on** (`angularFix: true`): the 1e-6 target stands.
3. **Severing** goes through hooks the sim and ecosystem own (PH2-1); glow fade and the part map are adapters until PH2-2 and PH2-3 land.
4. Jets, bladders and roll state live in `Work` until PH2-4 gives them columns; a `.ptk` restore does not yet carry them (the same gap as P1).
5. **Throughput**: keep the optimised layout (1.55x on the integrator, 1.17x to 1.34x with contacts, bit-identical). The top of the v0.1 range needs the structural levers in section 5.
