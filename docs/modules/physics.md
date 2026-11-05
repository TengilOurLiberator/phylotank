# Physics module notes (phase 1, second pass)

Design: [02-physics](../sections/02-physics.md) as reconciled by DESIGN R1, R2, R5, R8 to R10 and CONTRACT §2, §5.1, §5.2, §7, §10.3. Spikes: [physics-1](../spikes/physics-1.md), [physics-2](../spikes/physics-2.md). Contract requests: [physics](../contract-requests/physics.md), [physics2](../contract-requests/physics2.md).

## Files

| File | What |
|---|---|
| `index.ts` | `PhysicsModule` (`physics`, `createPhysics(options)`), `sampleFlow`, the phase-0 drifters for creatures without segments |
| `segment-spec.ts` | `toSegmentSpecs(Phenotype)`: clamps, armour narrows joint ranges |
| `body.ts` | mass properties, drag coefficients, added mass, joints and muscle caps; `loadBody`, `restage` |
| `solver.ts` | per-creature tick: flow, activation, per-tick segment and joint constants, substeps (drag-augmented mass, trailing-edge term, cilia, jets, buoyancy, implicit drag), joints, walls, work, `powerW` |
| `tree.ts` | exact linear-time joint solve for a segment tree (Baraff 1996), the angular-momentum correction, joint limits |
| `organs.ts` | jet bells, gas bladders (Boyle), roll triggering from `out[ROLL]` |
| `sever.ts` | severing at damage 1, corpse fragments (sink, glow fade), the commit hooks and their local adapter |
| `contacts.ts` | hierarchical spatial hash (counting sort), capsule narrow phase, speculative contacts, rams, bites, terrain SDF, contact slip, perception radius query |
| `links.ts` | grabs, jaw locks and parasite latches; islands of linked creatures; scraping, itch |
| `card.ts` | far-LOD swimmer cards measured from full physics, keyed at 5% |
| `watchdog.ts` | R9 exploit watchdog in the local water frame |
| `sincos.ts` | allocation-free deterministic sine and cosine |
| `work.ts` | per-world f64 working arrays |
| `testkit.ts`, `benchkit.ts`, `reference.ts` | hand-built bodies, benchmark scenes and the independent Stokes reference (tests only) |

## Conventions (decided here)

- A segment's axis `t = (cos angle, sin angle)` runs from its **base** (attached to the parent) to its **tip**. `attachU` is the point on the parent from -0.5 (parent base) to +0.5 (parent tip), matching the genome's attachPos "0 base, 255 tip". A child's base sits on that point. The root's axis is the creature heading, so a fish whose root is the head hangs its trunk at `attachU = -0.5` with rest angle pi.
- `cmd > 0` pushes the joint angle `angle_child - angle_parent` up (towards +y rotation, clockwise on screen), times the mirror sign.
- `cmd2` is the fin pitch on FIN segments (`phi = 1 - 0.8 |p|` on normal drag and added mass), the cilia drive (0 to 1) on segments with the CILIA organ, and the **bite drive on MOUTH segments** (adapter, contract request P2).
- Mirror (`mirror = -1`, roll) negates rest angles, limits and muscle torque directions. Physics flips it when `out[ROLL]` (lane 7) rises through 0.5 (re-armed below 0.2, at most once per second); joint limits are relaxed for 0.5 s after a flip so the body swings over through its springs instead of snapping.
- `cmd2` on a JET segment is the bell's contraction drive (0 to 1); on a BLADDER segment it pumps gas in (> 0, costly) or vents it (< 0).

## Per tick

1. Load f64 working state; sample the flow at each segment centre (one bilinear sample per segment per tick, not per Gauss point: the coarse grid is 0.25 m).
2. Activation lag `a += (u - a)(1 - exp(-dt / tau_act))`; `c_a(Re)` from the creature's fastest segment speed relative to the water; substep count: the 2.7.4 speed rule with the floor 4 (all bodies, so `nSub` is always 4, 8 or 16).
3. Each substep: per segment, the drag-augmented generalised mass `A = M3 + h C` (two Gauss points, linear, `|v|^1.5` and quadratic terms linearised at the current relative velocity, added mass blended by `c_a`), buoyancy and cilia forces, implicit velocity solve; predict; **exact tree solve** of all joints (attachment rows hard, bend row compliant with XPBD damping and the muscle as a rest offset plus damping); hard limits; walls; velocities from positions; muscle work from the torque each bend row delivered.
4. Store: angles to f32 with a gap-preserving shift of the children; creature pose, centre-of-mass velocity, `nSub`, `powerW = positive work / 0.25 / dt + 3 B |a| m_mus / m + cilia power`.
5. Watchdog per creature; then contacts and bites for all creatures at once, then terrain.

## Decisions and deviations

- **Exact tree solve instead of one Gauss-Seidel pass** (spike 1, 3.1): needed for long low-Re chains and for convergence; GS remains as `solver: 'gs'` for comparison.
- **Constraint projections use `A^-1`, not `M^-1`**: drag is part of the generalised mass inside the joint solve, which is what makes the Stokes limit right.
- **Implicit linear force-velocity muscles** replace the explicit velocity-capped Hill motor (contract request P7).
- **Contacts at tick rate**: inelastic normal impulse plus Coulomb friction (0.2) at velocity level; position corrections in fixed point (2^-20 m), Jacobi averaged, capped at 0.5 body lengths per second, and they add no velocity. Kinetic energy can only fall (test). Self-collision is off. Fin plates use their capsule radius (no tunnelling floor yet).
- **Hash**: 8 levels, 1 mm x 4^l cells, counting sort over a power-of-two bucket table, items scattered in slot order; queries visit 3x3 cells at the item's level and every coarser occupied level, at most 72 cells, with no cap on objects found (R5).
- **Bites**: penetration `p = F_bite (0.5 + k_s) - H A_contact` with `A_contact = 0.1 (1 - 0.8 k_s) pi r_m^2` (the design's `A_contact` made every bite fail); sharpness 0.5, jaw fraction 0.3, gape 0.5 rad as defaults until the mouth genes reach the Phenotype; damage `+= dm / m_seg`; 0.5 s cooldown; a `bite` event and a `BiteRecord` for the ecosystem's mass exchange (P3).
- **Watchdog** (R9): over 2 s windows, mechanical energy in the local water frame may not rise by more than 1.05 x (positive muscle work + |buoyancy work|) + 1e-6 J/kg; otherwise the creature is flagged and its water-relative velocity scaled down. Drag is not an input in the water frame (it only removes energy there).
- Added mass is in the mass matrix only (no momentum-form rotation, no Munk moment), as the review's v0.1 cut proposes. **Lighthill's trailing-edge term is on** (spike 2, B4): at every free leaf tip, `F = 1/2 m w^2 tau - m w u n` with `m = c_a rho pi (s/2)^2 phi` per length; the lateral part is implicit (a damping `m u n n^T` at the tip), the thrust explicit; it fades out when the tip leads, so its power is never positive. It does not double-count the tail's quadratic normal drag: that is cross-flow drag, this is the momentum the wake carries away.
- **Laminar skin friction uses the boundary-layer run length** (spike 2): a capsule in line with its parent continues the parent's boundary layer, so `k_t15` follows `sqrt(x_b) - sqrt(x_a)` along the body instead of restarting on every segment (which over-counted a chain's friction by `sqrt(n)`).
- **Angular momentum** (spike 2, C1): after each tree solve the net angular impulse of the joint impulses `g = A dq` about the start-of-substep positions is cancelled by a rigid rotation of the creature about its centre of mass. The linearised solve leaves `h^2 v x F` per substep because its lever arms are taken at the predicted pose; the rotation closes and opens no joint and moves no linear momentum.
- **Severing** (02 §2.4.7, DESIGN Q5): a segment at damage 1 queues a cut; `commitSevers(world, hooks)` moves the subtree into a new CARCASS record with `CF.FRAGMENT`, compacts the survivor, remaps links, recomputes the end-cap drag, and moves `floor(f q)` tissue and reserve quanta. Fragments have muscles off, are waterlogged (at least 3% denser than water) so they always sink, and their glow fades linearly to zero over 30 s. `restage` keeps a lost part lost (it prunes the Phenotype by the per-segment part map).
- **Jets**: bell up to 30% of its segment's volume, 0.3 s contraction to 20%, 0.6 s elastic refill; the thrust coefficient fades with the jet Reynolds number `d_n |Q| / (A_n nu)`, not the body's (a resting jellyfish must be able to start).
- **Bladders**: gas follows Boyle's and Charles's laws at the segment depth; pumping costs `P dV/dt / 0.1`, holding `80 W/m^3` of gas; a bladder creature is loaded neutral at its spawn depth.
- **Scraping**: a latch breaks when the host segment slips faster than 1 host length per second against a wall, terrain or another creature for 0.5 s; the parasite cannot latch again for 2 s.
- **Performance layout** (spike 2): per-tick segment constants interleaved in one strided f64 array (`wk.tc`, 18 per segment) and per-joint constants in `wk.jt`; sines and cosines computed per creature range (`sincosRange`); no call in a hot loop takes or returns a double (V8 boxes those when it does not inline). Results are bit-identical to the unoptimised code.
- No reduced tier (R7): `tier` stays 0.

- **Links**: grabs (CLAW organ, grip drive in `cmd2` at 0.5 on, 0.2 off; break force `5e4 Pa pi r^2`), jaw locks (after a successful bite, released when the bite drive drops; break force 3 x the bite force) and latches (PROBOSCIS mouths, subtype kept from the Phenotype as an adapter; 4 x the grip break force). Linked creatures form islands (union by link, lowest slot first) that step together at 8 substeps; links are hard point constraints solved after each member's tree solve and before the velocity update, through the drag-augmented inverse masses. Contacts between the two held segments are skipped. The latch's energy drain is the ecosystem's (`latches(world)` lists them).
- **Rams**: half the inelastic impact energy above `50 J/m^3 x V` damages a segment at toughness `2e3 J/m^3`, times 6 against a SPIKE part. Armour is not in the segment pool, so it does not raise the threshold yet.
- **Speculative contacts**: the hash bound and the narrow phase include `|v| dt`, and an approaching pair that is not yet touching gets the impulse that lets it close exactly the gap in one tick.
- **Swimmer cards**: `measureCard` runs the full physics on a (amplitude x frequency) grid at a given inter-joint lag (R7 asks for phase in the descriptor) and `cardLookup` interpolates. Not used to move creatures (no reduced tier); for far-view posing and the designer's test tank.

## Not done yet

Regrowth of severed parts (repair, 02 §2.6.6), whole-carcass bloating, the fin tunnelling floor, rigid-walled bladders (`rigidFrac`), the Munk moment and momentum-form added mass (C3), GPU kernels. The sim must call `commitSevers` and the brain must address segments through the part map (PH2-1, PH2-3) before severing shows in the running tank. Physics reads `massKg`, `tempC` and `length` from the ecosystem when present and falls back to geometry (and treats a missing temperature as 0 C, which slows muscles by Q10).
