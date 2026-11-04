# 2. Bodies, physics and metabolism

Status: draft for William's review, 2026-11-04.
Scope: how a grown body moves in water, touches other bodies, and spends energy. The growth/genome section owns how DNA becomes a body plan; this section takes the grown body plan as input and owns everything after that: mass properties, joints, muscles, the fluid model, contacts and combat mechanics, scaling laws, the energy ledger, the integrator, the GPU spatial hash, the physics level of detail and the performance budget.

Conventions (shared with the rendering and brains sections):
- SI units: metres, kilograms, seconds, newtons, joules, watts. The habitat is a 2D side view, x horizontal, y depth (0 at the surface, positive downwards), so gravity points along +y. Examples assume a 256 m by 128 m tank; tank size is a parameter.
- The sim ticks at a fixed 60 Hz (`dt = 1/60 s`); brains tick at 20 Hz (brains section 3.9.1). The weak laptop runs the same code at 30 Hz.
- "5090" means William's RTX 5090 PC. "Laptop" means a weak reference machine: 4-core, 8-thread mobile CPU and an Iris Xe class integrated GPU.
- Citations are from memory. URLs and DOIs were not re-checked in this session (web search was not used) and are marked "(unverified)" where I am less than sure of them.

---

## 2.0 Key choices at a glance

| Topic | Choice |
|---|---|
| Body | A tree of up to 256 rigid segments (capsules for body parts, thin plates for fins), moving in 2D but with 3D volumes ("2.5D"), joined by revolute joints. Softness is visual (rendering blends capsules); physical flexibility comes from compliant joints. |
| Actuation | Each joint has an antagonistic muscle pair driven by one brain activation in [-1, 1], with 30 to 120 ms activation lag, a Hill force-velocity curve, and a torque cap set by muscle cross-section and by the bending strength of the segment. Fin pitch output feathers the fin (changes its effective area). |
| Fluid | Per-segment anisotropic drag at two Gauss points with three terms (linear Stokes, laminar skin friction `|v|^1.5`, quadratic form drag), solved implicitly. Reynolds regimes emerge from the ratio of the terms, they are not switched. Added mass is anisotropic, integrated in momentum form with the Munk moment, and fades out at low Reynolds number. Cilia are a viscous slip force; jets are momentum flux. |
| Water | Tank water is 20x more viscous than sea water (`nu = 2e-5 m^2/s`), so a 1 mm microbe lives at Re about 0.05 and a 4 m leviathan at Re about 4e5. One-way coupled currents from the environment field; buoyancy from tissue density, lipids and compressible gas bladders (Boyle's law). |
| Integrator | XPBD with small steps (one constraint iteration per substep), semi-implicit drag, 1 to 16 substeps per tick chosen per creature (multi-rate buckets), creature state held in workgroup memory for all substeps. Cross-creature contacts, grabs and parasite latches are solved once per tick with Jacobi averaging and fixed-point atomics, which keeps the result deterministic. |
| Precision | Positions are an integer anchor per creature (Q16.16 metres) plus f32 offsets per segment, so a 1 mm microbe moving 4 micrometres per substep is not lost to f32 rounding far from the origin. |
| Neighbours | Hierarchical spatial hash (8 levels, cell size x4 per level, 1 mm to 16 m), counting sort on the GPU, shared with the perception kernel. |
| Metabolism | Kleiber basal rate `B0 m^0.75` times an Arrhenius temperature factor; muscle cost = positive work / 0.25 + an isometric term proportional to activation and muscle mass; costs for cilia, jets, bladders, light organs and the brain; digestion efficiency from a diet-by-gut matrix; growth, reproduction and starvation by catabolism. Biomass energy density is compressed (4 kJ/kg instead of about 5 MJ/kg) so lifetimes fit a wallpaper while power ratios stay physical. |
| Conservation | Nutrients are integer quanta, conserved exactly. Energy is a ledger of stocks and flows, reduced per tick in f64 on the CPU, and must balance to 1e-6 relative per simulated hour. |
| LOD | Two tiers: full articulated (F) and a reduced-order swimmer (R) driven by a per-morphology "swimmer card" measured from the full model using the creature's own gaits. Tier choice on the 5090 is camera-independent by default ("fair mode"). Interactions and big creatures are always full. The camera only enters tier choice when the machine is over budget, and audits bound the resulting bias. |
| Budget | 5090: 750k full-tier segments (about 60k creatures) plus 1.5M reduced-tier agents at 60 Hz in about 4 ms per tick. Laptop CPU: about 15k full segments plus 30k reduced agents at 30 Hz. |

---

## 2.1 Units, scale range and world constants

| Constant | Value | Notes |
|---|---|---|
| `rho_w0` | 1025 kg/m^3 | sea water at the surface, 15 C |
| `nu` | 2e-5 m^2/s | tank kinematic viscosity, 20x real sea water (about 1e-6). The only deliberately unphysical fluid constant, chosen so both regimes appear in a 3-decade size range. Tunable, see open question 1. |
| `mu` | `rho_w0 * nu` = 0.0205 Pa s | dynamic viscosity |
| `g` | 9.81 m/s^2 | along +y (down) |
| `P_atm` | 101 kPa | surface pressure, for bladders |
| `dt` | 1/60 s | sim tick (30 Hz on the laptop) |
| Body length range | 1 mm to 4 m nominal | stable and tested from 0.2 mm to 20 m |
| Mass range | about 3e-8 kg to 2e3 kg | 11 decades, fine in f32 per creature |
| Segments per creature | 1 to 256 | genome limit; rendering simplifies to at most 64 capsules for its hero LOD |

Reynolds number per creature, `Re = U L / nu`:

| Example | L | U | Re | Regime | What works |
|---|---|---|---|---|---|
| ciliate microbe | 1 mm | 1 mm/s | 0.05 | viscous | cilia, flagellar waves; coasting stops within 0.001 body lengths |
| larva | 5 mm | 5 mm/s | 1.25 | transitional | flagella and fins both partly |
| small fish | 5 cm | 5 cm/s | 125 | intermediate | fins, undulation; short glides |
| fish | 20 cm | 20 cm/s | 2,000 | inertial | tail beats, gliding about 6 body lengths |
| leviathan | 4 m | 2 m/s | 4e5 | inertial | slow strokes, long glides, jets |

## 2.2 Body model

### 2.2.1 Why rigid segment trees

Options considered:

1. **Mass-spring soft bodies** (point masses and springs, as in Tu and Terzopoulos's artificial fishes, SIGGRAPH 1994, https://www.cs.toronto.edu/~dt/siggraph94/ (unverified URL), and ALIEN's particle bodies, https://alien-project.org/). Natural softness, but shape stiffness needs many stiff springs, stiff springs need tiny timesteps, and fin orientation (needed for drag decomposition) has to be reconstructed from point triples. A 10-segment fish needs about 30 points and 80 springs.
2. **Rigid segments with joints** (Karl Sims 1994, https://www.karlsims.com/papers/siggraph94.pdf, used rigid boxes, Featherstone dynamics and viscous water drag; Framsticks, https://www.framsticks.com/, uses sticks with simple water forces). Orientation is explicit, a segment has only 3 degrees of freedom in 2D, and muscle torque, joint work and momentum are exact.
3. **Full continuum soft body (FEM or MPM)**. Too expensive for hundreds of thousands of creatures.

**Choice: option 2, solved with XPBD** (Macklin, Mueller and Chentanez 2016, https://matthias-research.github.io/pages/publications/XPBD.pdf; rigid bodies in XPBD: Mueller et al. 2020, "Detailed Rigid Body Simulation with Extended Position Based Dynamics", https://matthias-research.github.io/pages/publications/PBDBodies.pdf). Compliant joints give flexibility without stiffness problems. Jelly-like lineages get soft-looking bodies from low joint stiffness plus the renderer's capsule blending (rendering 6.2). Closed loops (a jelly bell ring) are allowed as up to 4 extra "closure" joints per creature on top of the tree.

The world is 2D but bodies are "2.5D": every segment has a 3D volume (a capsule is a solid of revolution; a fin plate has an out-of-plane span `s` and thickness), so mass scales as length cubed and the square-cube law holds.

### 2.2.2 Input from growth: the body plan

Growth (owned by the growth section) produces, for the current growth stage, a parent-first list of segments in breadth-first order, so the children of each segment are contiguous:

```ts
interface SegmentSpec {
  parent: number;          // -1 for root
  attachU: number;         // attachment point on the parent, fraction of its length [-0.5, 0.5]
  attachSide: number;      // -1, 0, +1 (offset by parent radius)
  restAngle: number;       // radians, relative to the parent
  length: number;          // m
  radius: number;          // m (capsule) or thickness/2 (plate)
  span: number;            // m, out-of-plane extent; 2*radius for capsules, gene for fins
  kind: 'body' | 'fin' | 'mouth' | 'spike' | 'claw' | 'proboscis' | 'tail';
  organs: OrganFlags;      // eye, cilia patch, jet bell, gas bladder, light organ, gut, gonad
  muscleFrac: number;      // fraction of cross-section that is muscle [0, 0.8]
  lipidFrac: number;       // [0, 0.6], density 920 kg/m^3
  armour: number;          // armour thickness as a fraction of radius [0, 0.5]
  stiffness: number;       // tissue Young's modulus gene, log-scaled 1e4 to 1e7 Pa
  limitLo: number; limitHi: number;   // joint range, radians
}
```

Physics derives everything else, so the body editor and mutation can never produce inconsistent mass or drag data.

### 2.2.3 Mass properties

For a capsule segment of length `l` and radius `r` (cylinder plus two hemispherical caps):

```
V = pi r^2 l + (4/3) pi r^3
rho_seg = (1 - f_lip - f_arm) rho_t + f_lip rho_lip + f_arm rho_arm
          rho_t = 1060, rho_lip = 920, rho_arm = 2000 kg/m^3; f_arm = armour volume fraction
m = rho_seg V
I = m (l^2 / 12 + r^2 / 4)                 (about the centre, rotation in plane)
```

For a fin plate of chord `l`, span `s`, thickness `t = 2r`: `V = l s t`, `I = m l^2 / 12`.

Added mass (section 2.3.3) is stored with the static data because it only changes with growth: normal `m_an = C_a rho_w pi (s/2)^2 l`, tangential `m_at = 0.1 rho_w pi r^2 l`, rotational `I_a = m_an l^2 / 12`, with `C_a = 1`.

### 2.2.4 Joints and passive mechanics

Each non-root segment owns the revolute joint to its parent. Constraints per joint (all XPBD):

- **Attachment** (2 rows, zero compliance): `C = (x_p + R_p a_p) - (x_c + R_c a_c) = 0`.
- **Passive bend** (1 row, compliant): `C = theta_c - theta_p - theta_rest`, stiffness from beam bending, `k_p = E I_beam / l_j` with `I_beam = pi r_min^4 / 4`, `r_min = min(r_p, r_c)`, `l_j = (l_p + l_c)/2`. Compliance `alpha = 1 / k_p`. Armour stiffens: `k_p *= 1 + 4 armour`.
- **Damping**: XPBD damping on the same row, `beta = zeta * 2 sqrt(k_p I_j)` with `zeta` in [0.05, 0.5] (gene).
- **Limits** (inequality): `theta_lo <= theta_rel <= theta_hi`. Armour narrows the range by `1 - armour`.

Why XPBD matters here: a 1 mm microbe's passive joint has a natural frequency of about 2,500 rad/s, which explicit springs would need a 0.4 ms timestep for. In XPBD the compliance term keeps it stable at any step size.

### 2.2.5 Muscles

One brain motor output `u_j` in [-1, 1] per joint (positive bends the child counter-clockwise). Fins get two outputs: stroke (the joint muscle) and pitch (feathering, section 2.3.4).

Activation dynamics (first-order lag, as the brains section expects):

```
da/dt = (u - a) / tau_act,    tau_act = clamp(0.05 s * (L / 0.1 m)^0.2, 0.03 s, 0.12 s)
```

Torque:

```
tau_max   = min( sigma_mus * f_mus * pi r_j^2 * (0.5 r_j),          muscle cross-section x moment arm
                 sigma_str * pi r_min^3 / 4 )                       bending strength of the thinner segment
            sigma_mus = 2e5 Pa (gene range 1e5 to 3e5), sigma_str = 2e6 Pa x (1 + 3 armour), r_j = (r_p + r_c)/2
omega'    = sign(a) * omega_rel                                     positive when moving with the activation
fv(w)     = (1 - w/omega_max) / (1 + 4 w/omega_max)          for w >= 0   (Hill shortening)
          = 1 + 0.5 min(1, -w / (0.3 omega_max))             for w < 0    (eccentric, up to 1.5)
tau_m     = a * tau_max * max(fv(omega'), 0)
omega_max = 20 rad/s * Q10^((T - 15 C)/10), Q10 = 2;  "fast fibre" gene raises it to 40 rad/s at 1.3x isometric cost
```

The structural cap means long thin limbs and fins with big muscles are weak, which pushes evolution towards plausible proportions. External loads above `1.5 * tau_struct` (rams, tugs on a grabbed limb) accumulate joint damage.

Stability: the Hill curve acts like a damper with coefficient about `5 tau_max / omega_max`, which is stiff for small creatures. The muscle is therefore applied as a **velocity-capped motor**: before applying `tau_m` the kernel predicts the relative angular velocity change `h tau_m (1/I_p + 1/I_c)` and scales `tau_m` down so that `omega'` cannot pass `omega_max` within the substep. This is unconditionally stable and costs 6 flops.

Muscle torque is applied as an equal and opposite pair (`+tau_m` on the child, `-tau_m` on the parent), so muscles cannot change total momentum or angular momentum. Mechanical work per substep is exact: `dW = tau_m * (dtheta_c - dtheta_p)`; its positive part is what metabolism charges (2.6.3).

### 2.2.6 Other actuators and organs

| Organ | Physics | Control |
|---|---|---|
| Fin | plate segment, high normal drag, feathering | stroke via joint muscle, pitch output |
| Cilia patch | tangential slip force (2.3.5) | one drive output in [0, 1] |
| Jet bell | cavity of volume `V_b` (gene, up to 30% of body volume) that contracts and refills (2.3.6) | one drive output |
| Gas bladder | gas amount `n_g`, volume by Boyle's law (2.3.8) | inflate/deflate output |
| Mouth | gape aperture adds frontal drag `0.5 rho C_gape A_gape v^2` (filter and ram feeding) | mouth open output |
| Light organ | no mechanical effect; energy cost only (2.6.3) | emit intensity output |

## 2.3 Fluid model

No fluid grid is solved around creatures. A resolved fluid (for example lattice Boltzmann with immersed boundaries) was considered and rejected for v1: a 256 m by 128 m tank at the 0.2 mm resolution a microbe needs is 8e11 cells. Instead each segment feels local, quasi-steady forces from its velocity relative to the ambient current, which is the standard approach for articulated swimmers in games and evolution sims (resistive force theory, Gray and Hancock 1955; blade-element drag; Lighthill's added mass).

### 2.3.1 Per-segment drag

For segment `i` with unit tangent `t` (along its length) and normal `n`, drag is evaluated at two Gauss points at `xi = +-l / (2 sqrt 3)` along the segment, each carrying half the coefficients. This gives the correct rotational resistance for the linear term (`k_n l^2 / 12`) without a separate formula. At each point:

```
v_rel = v + omega x (xi t) - u_flow(x_point)
v_t = v_rel . t,   v_n = v_rel . n

F_t = -[ k_t1 + k_t15 sqrt|v_t| + k_t2 |v_t| ] v_t / 2
F_n = -[ k_n1                   + k_n2 |v_n| ] v_n / 2
```

Coefficients (precomputed per segment when it grows):

| Coefficient | Capsule, slender (`l/r >= 4`) | Fin plate (chord `l`, span `s`) | Meaning |
|---|---|---|---|
| `k_t1` (linear, tangential) | `2 pi mu l / (ln(2l/r) - 0.5)` | `(32/3) mu a`, `a = sqrt(l s / pi)` | Stokes / resistive force theory |
| `k_n1` (linear, normal) | `4 pi mu l / (ln(2l/r) + 0.5)` | `16 mu a` | Stokes |
| `k_t15` (laminar skin friction) | `0.665 rho sqrt(nu / l) S_wet`, `S_wet = 2 pi r l` | same with `S_wet = 2 l s` | Blasius, `C_f = 1.33 / sqrt(Re_l)` |
| `k_t2` (quadratic, tangential) | `0.5 rho (0.1 pi r^2)` at the root and nose only, plus `0.5 rho 0.004 S_wet` turbulent friction | `0.5 rho 0.004 S_wet` | pressure and turbulent drag |
| `k_n2` (quadratic, normal) | `0.5 rho 1.1 (2 r l)` | `0.5 rho 1.2 (l s) phi` | cross-flow form drag; `phi` = feathering factor |

Stubby capsules (`l/r < 4`) blend towards the isotropic sphere value `6 pi mu r_eq` with `r_eq` the volume-equivalent radius, and the code enforces `k_n1 >= k_t1`. The slender-body formulas are the classical Lighthill/Gray-Hancock forms (Lighthill 1976, "Flagellar hydrodynamics", SIAM Review 18:161, https://doi.org/10.1137/1018040, unverified DOI); the disk values are the classical Stokes results for a disk moving broadside (`16 mu a`) and edgewise (`32 mu a / 3`). All constants are starting values and are fitted by the benchmarks in 2.13.

### 2.3.2 Regimes emerge

The three terms are the same structure as the standard drag correlation `C_D(Re) = 24/Re + 6/(1 + sqrt Re) + 0.4` (White, Viscous Fluid Flow): linear at low speed and size, quadratic at high. The ratio of the quadratic to the linear term is proportional to the segment Reynolds number, so nothing is switched by `Re`. Consequences that fall out without special code:

- **Coasting.** With linear drag, velocity decays with time constant `tau = m_eff / k_1`. For a 1 mm microbe `tau` is about 0.6 ms, so the coasting distance is under 0.001 body lengths. For the 20 cm fish the quadratic term dominates and a glide covers about `m_eff / k_2 * ln 2`, about 6 body lengths to half speed.
- **Scallop theorem** (Purcell 1977, "Life at low Reynolds number", Am. J. Phys. 45:3, https://doi.org/10.1119/1.10903). With linear drag and negligible inertia, any time-reversible stroke gives zero net displacement. A two-segment flapper stays in place at Re 0.05 and moves at Re 1,000. Microbes must evolve non-reciprocal strokes: travelling waves along flagella, or cilia, or a fin whose feathering differs between power and recovery stroke.
- **Drag scaling.** Viscous drag grows with `mu L U`, inertial drag with `rho L^2 U^2`, so streamlining (low `k_n2` frontal area, smooth taper) only pays for large creatures.

Re per creature is still computed (`Re = L U_ref / nu` with `U_ref = max(|v_com|, f_stroke A_stroke)`, smoothed over 0.5 s) for three uses: blending added mass (2.3.3), scaling jet thrust (2.3.6), and diagnostics.

### 2.3.3 Added mass

Accelerating a body in water also accelerates water. A segment's effective mass matrix in world coordinates is

```
M_i = m I_2 + c_a(Re) R(theta) diag(m_at, m_an) R(theta)^T,     I_eff = I + c_a(Re) I_a
c_a(Re) = Re / (Re + 10)
```

Added mass is an inertial effect and does not exist in Stokes flow, hence the `c_a(Re)` blend (it is updated per tick, not per substep, so `M` changes smoothly).

Two details make added mass stable and correct:

1. **Implicit in the mass matrix.** Added mass is not applied as a force (explicit added-mass forces become unstable when `m_a > m`, which is true for every thin fin). It is part of `M_i`, used by the drag solve and by every XPBD constraint as a direction-dependent inverse mass `w = d^T M^-1 d`.
2. **Momentum form with the Munk moment.** When a segment rotates, the water's share of its momentum must follow the fluid physics, not the body. Each substep starts with `v <- M(theta)^-1 M(theta_prev) v` (impulse conserved across the rotation) and applies the Munk moment `tau_munk = (p x v)_z = p_x v_y - p_y v_x` with `p = M v`. These are the Kirchhoff equations for a rigid body in ideal fluid: with drag off, they conserve total impulse and kinetic energy (I derived the energy identity `dT/dt = 0` for this exact pair; test C3 checks it numerically). The Munk moment turns a moving plate broadside to the flow, which is why fins and tails need active control at high Re. This also lets bodies swim in an ideal fluid purely by shape change (Saffman 1967, J. Fluid Mech. 28:385, https://doi.org/10.1017/S0022112067002150, unverified; Kanso et al. 2005, "Locomotion of articulated bodies in a perfect fluid", J. Nonlinear Sci. 15:255, unverified), and gives the reactive thrust that Lighthill's elongated-body theory describes (Lighthill 1971, Proc. R. Soc. B 179:125, https://doi.org/10.1098/rspb.1971.0085).

An optional extra term, Lighthill's trailing-edge thrust at a free tail tip (`F = 0.5 m_a' (w^2 - U^2 h_x^2)` along the body axis), is implemented behind a flag and off by default, because it may double-count thrust that the quadratic normal drag of the tail fin already produces. Benchmark B4 decides.

### 2.3.4 Fins and thrust

A fin is a plate segment with a large normal coefficient and a small tangential one. Thrust is not a formula; it is the forward component of the fin's normal force, `F_n = -0.5 rho C_n A_fin phi |v_n| v_n`, as the fin strokes at an angle to the swimming direction. So thrust scales with fin area times stroke velocity squared in the inertial regime (and with `mu l v_stroke` in the viscous regime, where reciprocal strokes cancel). A fin mounted backwards, too small, on a weak joint or on a body with high frontal drag swims badly, which is the selection pressure the brief asks for.

**Feathering.** Real fins rotate about their long axis (out of our plane) between strokes. The pitch output `p` in [-1, 1] sets `phi = 1 - 0.8 |p|` (projected area multiplier) and adds the same factor to the fin's added mass. Feathering on the recovery stroke makes paddling (labriform, rowing) work, and it is a non-reciprocal shape change, so it also works at low Re like a cilium's power and recovery strokes.

### 2.3.5 Cilia and flagella

**Flagella** are chains of thin segments: travelling waves produce thrust through the drag anisotropy `k_n1 / k_t1` (about 1.5 to 2), exactly as in resistive force theory. Benchmark B2 checks the classical result.

**Cilia** are too small to simulate as segments. A cilia patch on a segment produces a tangential slip force (a squirmer model in spirit; Blake 1971, J. Fluid Mech. 46:199, unverified):

```
F_c = a_c * mu * kappa_c * l_patch * u_s * t,      kappa_c = 3, u_s = 1 mm/s (gene 0.3 to 2 mm/s)
P_c = |F_c| u_s / eta_c,                            eta_c = 0.02
```

Because `F_c` grows with `mu L` while inertial drag grows with `rho L^2 U^2`, cilia give a 1 mm microbe about 1 body length per second but a 20 cm fish less than 0.1 percent of its fin thrust. Nobody has to forbid cilia on big creatures; they simply stop paying for their cost.

### 2.3.6 Jets

A jet bell (jellyfish, squid) of volume `V_b(t)` contracts with drive `a` over time `t_c` and refills elastically:

```
Q = -dV_b/dt
F_jet  = c_j(Re) rho Q^2 / A_n          along -nozzle axis, when expelling (Q > 0)
F_fill = c_j(Re) rho Q^2 / (4 A_n)      reversed, when refilling through a 4x wider aperture
c_j(Re) = Re / (Re + 10)
P_jet  = 0.5 rho |Q|^3 / A_n^2 / eta_jet,  eta_jet = 0.2
```

At low Re the momentum-flux picture is invalid (the flow is reciprocal and pressure-driven), so `c_j` fades jets out for microbes, just as added mass fades.

### 2.3.7 Currents

The environment section owns the current field: a coarse divergence-free velocity grid (for example from a stream function), stored as an `rg16float` texture with a time-varying component. Physics samples it bilinearly at every Gauss point and uses relative velocity in all drag terms, so small creatures drift with currents and big ones barely notice local eddies. Coupling is one-way in v1. A later option, owned by the environment section: big creatures splat momentum into the coarse grid so a passing leviathan stirs the water and plankton visibly.

Not in v1: wake effects between creatures (drafting behind schoolmates). The brains section's schooling notes mention "drag reduction behind neighbours if physics supports it"; it could be added later as a drag multiplier sampled from a coarse wake grid.

### 2.3.8 Buoyancy, gravity and depth

```
F_by = (m - rho_w(y, T) (V + V_gas)) g        (positive = sinks, since y points down)
rho_w(y, T) = rho_w0 (1 + 4.6e-10 * P_gauge(y) - 2e-4 (T - 15 C))
P(y) = P_atm + rho_w0 g y
V_gas = n_g R T_abs / P(y)                      (Boyle; n_g in moles)
```

Tissue at 1060 kg/m^3 sinks gently; lipids (920) make passive, incompressible lift; armour (2000) sinks. A gas bladder gives a lot of lift cheaply but its volume halves by 10 m depth, so neutral buoyancy is unstable: a fish that sinks a little loses lift and sinks more. Holding depth needs active control (fins or bladder gas exchange at a cost, 2.6.3), which brains must evolve. Rigid-walled bladders (gene `rigidFrac`) trade this instability for extra mass. Microbes are effectively neutral: Stokes settling `v_s = (2/9) Delta rho g r^2 / mu` is about 5 micrometres per second for a 0.1 mm radius cell, so plankton sinking belongs to the ecosystem section's field model, not to physics.

Buoyancy is applied as a constant force over the tick (it changes slowly) and is the only gravity effect on bodies: the 2D world has no ground reaction except terrain contact. Corpses keep their physics: they bloat (gas, lighter for a while) then sink to the floor, which feeds scavengers and the "whale fall" event.

### 2.3.9 What is deliberately not modelled

Vortex shedding and wake capture, ground effect, unsteady Basset history forces, three-dimensional flow around fins (span only enters through areas and added mass), cavitation, and fluid compressibility beyond water density.

## 2.4 Collisions, contacts and combat

### 2.4.1 Contact generation and solve

Every segment is a capsule for collision (fin plates use a capsule of radius `max(t/2, 0.1 s)` so they do not tunnel). The spatial hash (2.8) yields candidate pairs; the narrow phase computes the closest points between two 2D line segments, and a contact exists when `d = |p_a - p_b| - (r_a + r_b) < margin`, with a speculative margin `|v_rel| dt` so fast pairs are caught one tick early.

Contacts are XPBD inequality constraints `C = d >= 0` with compliance `alpha_c = 1e-6 m/N / (r_a + r_b)` (slightly soft, water-cushioned), Coulomb friction with `mu_f = 0.2` (slimy), and zero restitution. Adjacent segments of the same creature never collide; non-adjacent self-collision is off except for creatures over 64 segments (coiling leviathans).

The solver also returns, per contact, the normal impulse `J = lambda / dt`. That one number feeds touch inputs for brains (`tanh(F / F0)`), ram damage and grip breaking.

### 2.4.2 Terrain

Rocks, floor, walls and the surface come from the environment section as a signed distance field texture (for example 4096 by 2048 over the tank, with exact analytic walls). Each segment tests its two end caps and centre against the SDF; contact uses the SDF gradient as the normal, same compliance and friction. The surface is a soft ceiling (buoyant bodies bob just below it).

### 2.4.3 Biting

A mouth segment carries jaw genes: gape `g` (radians), sharpness `k_s` in [0, 1], and jaw muscle fraction. Bite force scales with head cross-section:

```
F_bite = sigma_jaw * f_jaw * pi r_mouth^2,           sigma_jaw = 2e5 Pa
reach  = mouth tip capsule extended by g * r_mouth
```

When the brain's bite output fires (hysteresis on 0.5, off 0.2; cooldown 0.3 to 2 s from the mouth gene, brains 3.8.1) and the reach capsule overlaps a target segment, the bite resolves:

```
penetration p = F_bite (0.5 + k_s) - H_target A_contact     H_target = 2e5 Pa x (1 + 20 armour)
if p > 0:
   dm = min( rho_t * V_gape,  0.5 * m_target_seg,  p * c_bite )     V_gape = (pi/2) g r_mouth^3, c_bite = 1e-6 kg/N
   target segment loses dm (radius shrinks, its mass properties are recomputed next tick)
   dm enters the biter's gut up to its free capacity; the rest becomes detritus in the water
```

Conflicts (two biters, one segment, same tick) are resolved by `atomicMin` on a priority key `hash(tick, biterId)`, so the outcome is deterministic and fair. Mass is moved, never created or destroyed (2.6.9).

### 2.4.4 Grabbing

Claw and tentacle tips with a grip output create a **link** on contact: a zero-length XPBD distance constraint between local anchors on two segments of different creatures. Links live in a global link buffer (capacity 64k on the 5090, 4k on the laptop). A link breaks when

- the owner's grip output falls below 0.2, or
- the constraint force `|lambda| / dt^2` exceeds `F_break = sigma_grip pi r_tip^2` (`sigma_grip` = 5e4 Pa, claw gene up to 3x), or
- either segment is severed or dies.

Jaws use the same mechanism after a successful bite (jaw lock, released when the bite output drops), so a predator can hold struggling prey and the prey's thrashing really pulls the predator around.

### 2.4.5 Latching parasites

A proboscis segment with the latch output attaches on contact when its piercing stress beats the host's armour: `sigma_pierce pi r_tip^2 > H_host A_tip`. The latch is a link of type `LATCH` with low compliance and a high break force. While attached:

```
energy drain   J_drain = kappa_d A_prob * (E_s,host / m_host)        capped by the parasite's gut throughput
kappa_d = 0.05 kg/(m^2 s) (gene)
```

The drain moves energy from host to parasite through the ledger. The parasite's mass and drag ride on the host through the link, so a heavily infested host really swims worse. Hosts can remove parasites by:

- **scraping**: the latched host segment touches terrain or another creature with tangential slip above 0.2 m/s (scaled by host length) for 0.5 s;
- **thrashing**: link force exceeds the break force.

The brains section's "itch" input (fraction of segments with a parasite) and the disease section's vectors hook onto the same link records.

### 2.4.6 Ramming, spikes and armour

The kinetic energy lost in a contact is `E_imp = J^2 / (2 m_red)`, with `m_red` the reduced effective mass of the two segments along the contact normal (including added mass, so ramming in water is softened). Damage to segment `i`:

```
D_i = max(0, E_imp - E_thr,i) / (toughness * V_i)         E_thr = 50 J/m^3 x V_i x (1 + 20 armour)
spike multiplier: if the other contact point is on a spike tip, D_i *= 1 + 10 k_spike
```

Damage accumulates in `[0, 1]` per segment. Damaged segments lose muscle torque in proportion and heal at a cost (2.6.6). A segment at damage 1 is severed (2.4.7).

Armour, spikes and size are all paid for physically: armour adds dense mass (sinks, more inertia, more growth cost), stiffens and narrows joints; spikes add frontal area (quadratic drag); big rams need big mass.

### 2.4.7 Severing and corpses

A severed segment (damage 1, or bitten below 30% of its grown mass) detaches with its subtree. The detached part becomes a passive corpse fragment: same segments, joints go limp (passive stiffness only, muscles off), it keeps its mass and energy content, sinks or floats by density, and decays into detritus at `k_decay * S_wet` per second (ecosystem section). A dead creature becomes a corpse the same way. A tail bitten off a prey animal is therefore food floating in the water, and its loss really slows the survivor.

## 2.5 Scaling laws

All of these come from the formulas above; none is imposed as a rule. For isometric scaling with length `L`:

| Quantity | Scales as | Consequence |
|---|---|---|
| mass `m` | `L^3` | |
| muscle force, bite force, grip | `L^2` | big creatures are strong in absolute terms |
| joint torque | `L^3` | |
| moment of inertia (with added mass) | `L^5` | angular acceleration `~ L^-2`, natural stroke frequency `~ L^-1`: giants beat slowly |
| basal metabolism (Kleiber) | `m^0.75 ~ L^2.25` | cheaper per kilogram |
| energy store | `m ~ L^3` | starvation time `~ m^0.25`: giants survive famines |
| viscous drag | `mu L U` | dominates small |
| inertial drag | `rho L^2 U^2` | dominates large |
| cilia thrust | `mu L u_s` | only useful at low Re |
| added mass share | rises with Re to `rho V` | big bodies are sluggish to accelerate and turn |
| ram energy | `m U^2 ~ L^3 U^2` | big rams hurt |
| growth time to adult | about `m^0.25` (from `dm/dt <= g_max m^0.75`) | long generations for giants |
| cost of transport `P / (m g U)` | falls with mass (expected slope about -0.3, Schmidt-Nielsen 1972, Science 177:222, https://doi.org/10.1126/science.177.4045.222) | benchmark B6 checks the emergent slope |

Why giants are costly: absolute food demand `~ m^0.75`, slow turning, slow maturation, a big target that cannot hide in rock crevices, high growth cost before the first offspring, and inertia that makes fine manoeuvring expensive. Why they are strong: bite and ram, starvation resistance, high absolute speed, ability to eat everything smaller, and cheap per-kilogram living. In water, buoyancy removes most of the square-cube penalty on support (the real reason whales can be big); the remaining penalty here is the structural torque cap `~ r^3` versus inertia `~ L^5` for long, thin limbs.

## 2.6 Energy accounting

### 2.6.1 Stocks and units

Energy is in joules. To make life histories fit a wallpaper while keeping power ratios physical, biomass energy density is **compressed**: `e_b = 4000 J/kg` instead of about 5 MJ/kg for real wet tissue (a factor of about 1,250). All powers (basal, muscle, drag) stay physical; only the stocks are small, so starvation, growth and generations are about 1,250x faster than nature. This is one knob, owned jointly with the ecosystem section.

Per creature stocks:

| Stock | Symbol | Capacity |
|---|---|---|
| energy reserve (fat, glycogen) | `E_s` | `s_fat e_b m`, `s_fat` = 0.3 (gene 0.1 to 0.6; stored lipid also changes density) |
| anaerobic reserve | `A` | `c_A e_b m`, `c_A` = 0.02 |
| gut contents by food class | `G_plant, G_meat, G_detritus` | gut volume `V_g` (gene, fraction of body volume) |
| tissue mass | `m` | target mass of the growth stage |
| reproductive reserve | `E_r` | offspring cost (2.6.7) |

### 2.6.2 Basal metabolism

```
B = B0 * m^0.75 * exp( (E_a / k_B) (1/T_ref - 1/T) )        B0 = 0.3 W kg^-0.75 at T_ref = 288 K, E_a = 0.65 eV
```

Kleiber's law with the temperature factor of the metabolic theory of ecology (Gillooly et al. 2001, Science 293:2248, https://doi.org/10.1126/science.1061967; West, Brown and Enquist 1997, Science 276:122, https://doi.org/10.1126/science.276.5309.122). Cold deep water slows both metabolism and muscles (`omega_max` uses the same temperature), favouring slow, long-lived deep life.

### 2.6.3 Active costs

```
P_muscle = sum_j [ max(0, tau_m,j * omega_rel,j) / eta_m  +  kappa_iso * B * |a_j| * m_mus,j / m ]
           eta_m = 0.25, kappa_iso = 3  (full co-contraction of every muscle costs 3x basal)
P_cilia  = sum |F_c| u_s / eta_c                                   eta_c = 0.02
P_jet    = 0.5 rho |Q|^3 / A_n^2 / eta_jet                           eta_jet = 0.2
P_blad   = P(y) * max(0, dV_gas/dt) / eta_b + c_hold * V_gas           eta_b = 0.1, small holding cost for leakage
P_light  = sum_k k_L I_k A_k                                         k_L = 8 W/m^2 at I = 1
P_brain  = e_n N + e_s S + e_p P                                     owned by the brains section (3.8.1)
P_heal   = 1.4 e_b * (mass equivalent of damage repaired per second)
```

The isometric term matches the brains section's "proportional to `|activation|` times muscle mass" and is tied to `B` so it follows Kleiber: holding tension is not ruinous for a leviathan. Negative work is not refunded. The muscle work term is computed from the solver's own torques and angles, so it is exact and identical in both LOD tiers.

Light organ cost check: for the 20 cm reference fish, a light organ covering 10% of its skin at full intensity costs about 20% of basal; for a 1 mm microbe the same relative organ costs about 70% of basal, so small glowers should evolve to flash only when disturbed, as real dinoflagellates do.

### 2.6.4 Aerobic scope and fatigue

Sustained active power is capped at `(S_aer - 1) B` with aerobic scope `S_aer` = 8 (gene 4 to 15). Demand above the cap draws on the anaerobic reserve `A`. When `A` is empty, all muscle activations are scaled down to the sustainable level. `A` refills at the unused aerobic power with efficiency 0.5. Bursts (C-starts, attacks, escapes) are real but short, and the brains section's `fatigue` input reads `1 - A / A_max`.

### 2.6.5 Digestion

The gut gene `g_gut` in [0, 1] runs from a short carnivore gut (0) to a long fermenting herbivore gut (1). Absorption efficiency by food class:

| Food | energy density | `eps_max(g_gut)` | half-time of absorption `t_1/2` |
|---|---|---|---|
| plant, plankton | 0.6 `e_b` | `0.15 + 0.60 g_gut` | `60 s (m / 1 kg)^0.25` |
| meat, parasite drain | 1.0 `e_b` | `0.90 - 0.40 g_gut` | `15 s (m / 1 kg)^0.25` |
| detritus, carrion | 0.3 `e_b` | `0.10 + 0.35 g_gut` | `90 s (m / 1 kg)^0.25` |

Each gut class empties first-order: absorbed rate `J_abs = eps_max * ln2 / t_1/2 * G * e_food`; the unabsorbed fraction leaves as faeces into the detritus and nutrient fields at the same rate. Throughput is limited by gut volume, so a large gut digests more but adds tissue that costs maintenance (it is part of `m`). Specific dynamic action: 10% of `J_abs` becomes heat. Parasite drain enters as "meat" directly into absorption (no gut volume used).

### 2.6.6 Growth and repair

```
if E_s > theta_g * E_s,max and m < m_target(stage):
    J_grow = min( g_max * m^0.75 * c_g,  (E_s - theta_g E_s,max) / tau_g )
    dm/dt  = J_grow / c_g
c_g = 1.4 e_b (40% synthesis overhead); armour tissue 1.2 e_b plus a mineral nutrient cost; neural tissue 2.0 e_b
theta_g = 0.5 (gene), tau_g = 30 s, g_max = 0.02 kg^0.25 / s at 15 C (temperature-scaled)
```

With intake limited by gut and mouth (roughly `~ m^0.75` for a good forager) and maintenance `~ m^0.75` plus activity, growth follows a von Bertalanffy-like curve without that curve being coded. When `m` crosses a growth-stage boundary the growth section emits the next body plan, physics recomputes static data for that creature (the segment count may change; the creature is re-packed into a new batch next tick).

Repair of damage uses the same `c_g` per unit of damaged mass.

### 2.6.7 Reproduction

```
E_offspring = n_o * (m_o * c_g + m_o * s_fat,0 * e_b)      tissue plus a starting reserve
E_r must reach E_offspring + E_mate                            E_mate = 0.05 e_b m (courtship, mating)
```

Budding, egg laying and live birth differ only in `n_o` and `m_o` (genome section). The reserve `E_r` fills from `E_s` at a gene-controlled rate when `E_s` is above a threshold, which is how "invest in growth or in offspring" becomes a heritable life-history trade-off.

### 2.6.8 Starvation and death

If `E_s` reaches 0, tissue is catabolised to cover the deficit at efficiency 0.8 (`dm/dt = -deficit / (0.8 e_b)`), in order: reproductive reserve, lipid, then muscle (so `tau_max` falls and the creature weakens), then gut, last brain and eyes. Death when `m < 0.5 m_structural` (the mass of the current growth stage without lipid) or when damage severs the root segment. The dead body becomes a corpse (2.4.7) holding its remaining energy and mass.

Starvation times from a full reserve with these constants (basal only, 15 C): 1 mm microbe about 50 s, 20 cm fish (0.25 kg) about 47 minutes, 4 m leviathan (2,000 kg) about 7 hours.

### 2.6.9 The ledger and conservation

**Nutrients** (the limiting element that plankton need and corpses return) are integer quanta. Every transfer is an integer move between a creature, a gut, a corpse, the detritus field and the dissolved nutrient grid, done with integer atomics, so the total is exact. Each creature's quanta are proportional to its tissue mass; mass changes that do not divide evenly carry a fractional remainder in the creature record until it adds up to a whole quantum.

**Energy** is an open flow (sunlight in, heat out). Stocks: all creature `E_s, A, E_r`, gut contents, tissue (`e_b m`), corpses, detritus, plankton (ecosystem). Flows per tick in 14 channels:

```
0 photosynthesis in     1 god-mode injection     2 ingestion (transfer)   3 absorption (transfer)
4 faeces to detritus    5 heat: basal            6 heat: muscle           7 heat: other organs and brain
8 growth (to tissue)    9 reproduction           10 death to corpse       11 corpse/detritus decay
12 bite transfer        13 parasite drain
```

Each creature accumulates its tick's flows in f32 registers; a workgroup reduction writes partial sums per channel; the host reads them back (about 60 KB per tick on the 5090) and sums in f64. The identity checked every tick:

```
Delta(sum of stocks) = inputs (0, 1) - heat (5, 6, 7, and heat from decay)       within 1e-6 relative per simulated hour
```

f32 per-creature rounding produces a tiny drift; every 10 s the host computes the discrepancy and books it to a "rounding" channel against the dissolved pool, and logs its size. A rounding channel larger than 1e-6 per hour is a bug (test C5).

### 2.6.10 Reference creature: the 20 cm fish

`L = 0.2 m, r = 0.02 m, 8 segments, m = 0.25 kg`.
- Basal: `0.3 * 0.25^0.75 = 0.106 W`.
- Cruise at 1 body length per second: Re 2,000, skin friction `C_f = 0.03`, drag 0.015 N, mechanical power 0.003 W; with propulsive efficiency about 0.3 and muscle efficiency 0.25, metabolic swimming cost about 0.04 W, about 40% of basal.
- Burst at 4 body lengths per second: drag power rises with `U^3` (64x), about 25x basal, beyond the aerobic cap, so it lasts a few seconds on `A`.
- Peak tail torque available about 1.3 N m, needed for a 3 Hz, 0.3 rad tail beat about 0.1 N m: plenty of headroom, matching real fish.

These numbers are the calibration targets for tuning `sigma_mus`, drag constants and `eta_m` (benchmarks B4 to B6).

## 2.7 Integration and timestep stability

### 2.7.1 Per-substep algorithm (full tier)

For a creature with `n_sub` substeps, `h = dt / n_sub`. Following "small steps" XPBD (Macklin et al. 2019, "Small Steps in Physics Simulation", SCA, https://mmacklin.com/smallsteps.pdf, unverified URL): one constraint iteration per substep, many substeps.

```
once per tick:  a <- a + (u - a) (1 - exp(-dt / tau_act));  recompute c_a(Re), buoyancy, organ drives
for s in 1..n_sub:
  1. added-mass rotation:  v <- M(theta)^-1 M(theta_prev) v;   omega += h tau_munk / I_eff
  2. explicit forces:      muscles (velocity-capped motor pairs), cilia, jets, buoyancy
                           v += h M^-1 F,  omega += h tau / I_eff
  3. implicit drag:        solve (M3 + h C) V' = M3 V + h C U_flow     (3x3 per segment, 2.7.2)
  4. predict:              x_prev = x; theta_prev = theta; x += h v; theta += h omega
  5. constraints:          joints by colour (attachment, bend, limits), closure joints last
  6. velocities:           v = (x - x_prev) / h; omega = (theta - theta_prev) / h
  7. bookkeeping:          W_muscle += max(0, tau_m (dtheta_c - dtheta_p)); touch, work, etc.
once per tick (all creatures together): contacts, terrain, links, combat events (2.7.5)
```

### 2.7.2 Implicit drag

Per segment, unknowns `V = (v_x, v_y, omega)`. Linearise the drag at the current relative velocity (Picard): at each Gauss point `p`, `D_p = c_t t t^T + c_n n n^T` with `c_t = (k_t1 + k_t15 sqrt|v_t| + k_t2 |v_t|) / 2`, `c_n = (k_n1 + k_n2 |v_n|) / 2`, and `J_p = [I_2 | perp(r_p)]` maps `V` to the point velocity. Then

```
C = sum_p J_p^T D_p J_p                     (3x3 symmetric positive semidefinite)
(M3 + h C) V' = M3 V + h F_ext + h sum_p J_p^T D_p u_flow(p)
M3 = blockdiag(M_i, I_eff)
```

`M3 + h C` is symmetric positive definite, solved in closed form (about 60 flops). Because drag only removes energy, this is unconditionally stable. It matters: the 1 mm microbe's drag time constant is about 0.6 ms, far below its 4 to 17 ms substep; explicit drag would diverge, and would need steps under 0.3 ms to be accurate. Implicit drag at `h >> tau` gives the correct overdamped (Stokes) limit, where velocity is set by force balance.

### 2.7.3 XPBD joints in parallel

Within a creature, joints that share a segment cannot be solved at the same time. Joints are tree edges, so a greedy breadth-first edge colouring needs exactly `max degree` colours (typically 2 to 4, at most 8 allowed by the growth section). Each thread owns the joint of its child segment and solves it during its colour pass; barriers separate colours. This is Gauss-Seidel within a creature, which converges much better than Jacobi on long chains.

Joint update (2D rigid XPBD, Mueller et al. 2020):

```
attachment:  d = (x_p + R_p a_p) - (x_c + R_c a_c);  n = d / |d|
             w_i = n^T M_i^-1 n + (r_i x n)^2 / I_eff,i
             dl  = -|d| / (w_p + w_c)
             x_p += M_p^-1 n dl;  theta_p += (r_p x n) dl / I_p
             x_c -= M_c^-1 n dl;  theta_c -= (r_c x n) dl / I_c
bend:        C = theta_c - theta_p - theta_rest;  dl = -(C + gamma (C - C_prev)) / ((1 + gamma)(1/I_p + 1/I_c) + alpha / h^2)
             gamma = alpha beta / h  (XPBD damping)
limits:      same with alpha = 0, only if outside [lo, hi]
```

### 2.7.4 Multi-rate stepping

Small creatures need more substeps (fast strokes, thin parts that could tunnel), big ones fewer. Per creature, recomputed every second:

```
n_need = max( 16 * f_stroke,max * dt,                 >= 16 substeps per stroke cycle
              |v|_max * dt / (0.5 r_min),             no part moves more than half its radius per substep
              1 )
n_sub  = clamp(next_pow2(ceil(n_need)), 1, 16)        buckets 1, 2, 4, 8, 16
```

`f_stroke,max` comes from the brain's oscillator limits (`fHigh` up to 6 Hz, brains 3.5.2) and the joint's `omega_max`. At 60 Hz most creatures land in bucket 1 or 2; fast small flagellates in 4 or 8; bucket 16 is a safety net. Creatures are sorted into batches by bucket, so a workgroup never mixes substep counts.

Viscous drag needs no extra substeps (implicit), and passive joint stiffness needs none (XPBD), so the substep count is driven by accuracy, not stability. That is why multi-rate is cheap here: stability is never the constraint.

### 2.7.5 Cross-creature constraints at tick rate

Contacts, terrain, grabs and latches couple different creatures, possibly in different buckets. They are solved once per tick after all creatures have stepped internally:

1. Find contacts (2.8) with speculative margin.
2. Two Jacobi iterations: each contact and link computes its position correction with XPBD; corrections are accumulated per segment with fixed-point integer atomics and averaged by count (constraint averaging, as in Macklin et al. 2014 "Unified Particle Physics for Real-Time Applications", unverified title).
3. Velocity update for touched segments: `v += dx / dt`, friction applied at velocity level.
4. Emit events (touch force, bite candidates, ram impulses, link breaks).

Tick-rate contacts are good enough in water because bodies are slow relative to their size (the substep rule already keeps per-tick displacement under a few radii). The latency costs at most one tick (17 ms) of interpenetration, which the compliance absorbs smoothly.

### 2.7.6 Precision: anchored positions

f32 has about 15 micrometres resolution at 256 m from the origin. A 1 mm microbe at 1 mm/s moves 4 micrometres per substep, which would be rounded away. So:

- Each creature has an **anchor** `vec2<i32>` in Q16.16 metres (resolution 15 micrometres, range +-32 km).
- Each segment stores its position as an f32 **offset** from its creature's anchor (offsets are at most a few body lengths, so resolution is about `1e-7 L`).
- At the end of each tick the host-side kernel re-anchors: `shift = round_to_Q16(centroid_offset)`, `anchor += shift`, `offset -= shift`. The shift is an exact multiple of the Q16 unit, so no position is changed by rounding.
- Cross-creature geometry (contacts, links, senses) computes `(anchor_a - anchor_b)` in integers first, converts that small difference to f32, then adds offsets.

Reduced-tier agents use the same anchor plus offset scheme.

### 2.7.7 Determinism

Same machine, same driver, same seed gives a bitwise identical run:

- Within a creature, the order of operations is fixed by colours and indices.
- Cross-creature sums use integer atomics (addition is associative), so the order in which threads arrive does not matter. Contact lists are appended in a nondeterministic order, but each contact's effect is accumulated in integers, so the result is the same.
- Fixed-point scales: position corrections are stored in units of `2^-20` times the receiving segment's radius (range +-2048 radii), impulses in units of `2^-16` times `m_seg * 1 m/s`.
- Overflowing buffers (contacts, links, events) are never silently truncated: an overflow flag makes the host grow the buffer and redo that tick.
- Across GPUs and against the CPU fallback, results agree statistically, not bitwise (FMA contraction and transcendental functions differ), as in the brains section.

### 2.7.8 Tick pipeline

```
 brains (20 Hz staggered, from brains section) -> activation targets u
 1  integrate_full      per bucketed batch, all substeps in workgroup memory
 2  integrate_reduced   reduced-tier agents
 3  reanchor
 4  hash_count -> scan -> hash_scatter        segments, reduced hulls
 5  find_contacts       (+ terrain SDF)
 6  solve_contacts x2   (+ links) -> apply_deltas
 7  resolve_interactions  bites, grabs, latches, rams, severing; mass transfers
 8  metabolism          per creature; ledger partials
 9  lod_and_cards       tier changes, gait statistics, card lab batch
 readback: ledger partials, events, overflow flags (async, mapped staging buffers)
```

## 2.8 Spatial hashing on the GPU

### 2.8.1 Hierarchical grid

Sizes span four decades, so one grid cell size cannot fit both microbes and leviathans. Levels `l = 0..7` with cell size `c_l = 1 mm * 4^l` (1 mm, 4 mm, 16 mm, 64 mm, 0.26 m, 1 m, 4 m, 16 m). An item (segment or reduced hull) with bounding radius `R` goes to the smallest level with `c_l >= 2R`, inserted once at its centre's cell.

Query rule: an item at level `l_i` searches the 3x3 cells around itself at its own level and every coarser level. Overlap of items `i` (level `l_i`) and `j` (level `l_j >= l_i`) implies centre distance at most `R_i + R_j <= c_lj`, so `j` is in the 3x3 block around `i`'s cell at level `l_j`. Every pair is therefore found exactly once: by the finer item, and for equal levels by the lower index.

Cells are hashed, not dense (the finest level of a 256 m by 128 m tank would have 3.3e10 cells):

```
key  = (l, ix, iy)
hash = ((ix * 73856093) ^ (iy * 19349663) ^ (l * 83492791)) & (T - 1),   T = next_pow2(2 N_items)
```

This is the counting-sort spatial hash popularised by Matthias Mueller's Ten Minute Physics (https://matthias-research.github.io/pages/tenMinutePhysics/), made hierarchical. Hash collisions only add candidates; a candidate is accepted only if its stored cell coordinates equal the queried cell, so collisions never duplicate a pair. A 64-bit `levelMask` of occupied levels per 16 m super-cell lets queries skip empty coarse levels.

### 2.8.2 Build (counting sort)

1. `hash_count`: per item compute level, cell and hash; `atomicAdd(cellCount[hash], 1)`.
2. `scan`: exclusive prefix sum of `cellCount` into `cellStart` (reduce-then-scan in three passes; WebGPU gives no forward-progress guarantee, so the single-pass decoupled look-back scan is not used).
3. `hash_scatter`: `slot = cellStart[h] + atomicAdd(cellFill[h], 1)`; `sorted[slot] = i`.

The order within a cell is nondeterministic, which is harmless because of the integer accumulation in 2.7.7. Cost: `O(N + T)`. The perception kernel (brains 3.4) reuses the same structure in the same tick.

## 2.9 Data layouts

WebGPU's default limit is 8 storage buffers per shader stage, and storage structs align to 16 bytes. So the layout is **SoA by access pattern**: separate buffers for hot dynamic state, cold static state and joints, each an array of small 16-byte-aligned structs. The CPU fallback uses fully separate `Float32Array`s per field (true SoA) with the same indices.

### 2.9.1 Segment buffers (capacity `N_seg`)

| Buffer | Element | Bytes | Written |
|---|---|---|---|
| `segDyn` | `pos: vec2f` (offset from anchor), `vel: vec2f`, `ang: vec2f` (theta, omega), `misc: vec2f` (damage, touch force) | 32 | every tick |
| `segStatic` | `geom: vec4f` (l, r, span, flags as bits), `mass: vec4f` (m, I, m_an, m_at), `drag: vec4f` (k_t1, k_n1, k_t2, k_n2), `extra: vec4f` (k_t15, buoyancy force, cilia force max, armour), `topo: vec4u` (creature, parent local, first child local, n_child and colour packed) | 80 | on growth or damage |
| `joint` | `anc: vec4f` (parent anchor xy, child anchor xy), `lim: vec4f` (rest, lo, hi, compliance), `mot: vec4f` (tau_max, omega_max, beta, tau_struct) | 48 | on growth |
| `jointDyn` | `u, a, work, isoCost` (f32 x 4) | 16 | every tick |
| `segAcc` | `atomic<i32> x 4` (dx, dy, dtheta, count) | 16 | contact solve |
| total | | **192 B per segment** | |

### 2.9.2 Creature buffers (capacity `N_cr`)

| Buffer | Fields | Bytes |
|---|---|---|
| `crHdr` | anchor `vec2<i32>`, first segment, segment count, tier, bucket, batch slot, flags | 32 |
| `crPhys` | total mass, `L`, `Re` (smoothed), `c_a`, centre-of-mass velocity, heading | 32 |
| `crMeta` | `E_s`, `A`, `E_r`, gut x 3, nutrient quanta (u32) and remainder, temperature, growth stage, target mass | 48 |
| `crFlow` | 14 ledger channels this tick (f32) plus pad | 64 |
| total | | **176 B per creature** |

### 2.9.3 Reduced tier, cards, links, hash

| Buffer | Fields | Bytes |
|---|---|---|
| `redDyn` | anchor, offset, vel, theta, omega, gait estimator state (EMA mean, RMS, zero-crossing rate for up to 4 joint groups) | 64 |
| `card` | 4 amplitude x 4 frequency x 3 turn cells of (U_ss, Omega_ss, P_muscle); passive `K1, K15, K2` per axis; `M_eff`, `I_eff`; mean pose and per-joint phase and amplitude for 16 joints; sample count and age | about 900, shared by morphology hash |
| `link` | segA, segB, type, owner, anchorA, anchorB, compliance, breakForce, age | 48 |
| `contact` | a, b, flags, pA, pB (offsets), normal, depth, lambda | 48 |
| hash | `keys`, `sorted` (u32 each per item), `cellCount`, `cellStart`, `cellFill` (u32 each per table slot, `T = 2N`) | about 32 per item |

Memory on the 5090 reference workload (2.12): segments 144 MB, creature records for all 1.56M creatures (both tiers) 275 MB, reduced-tier state 96 MB, cards 20 MB, contacts at 8 per item 860 MB worst-case capacity (typically 4 per item, about 430 MB allocated), hash 72 MB. About 1.5 GB of 32 GB at worst-case capacity. On the laptop, under 40 MB.

## 2.10 Kernel outlines (WGSL)

Outlines, not final code. Helper functions (`rot`, `cross2`, `perp`, `minv_dir`, `sample_flow`, fixed-point conversions) are omitted.

### 2.10.1 `integrate_full`

One workgroup per batch: up to 256 segments, either one big creature or several small creatures of the same bucket packed together (creatures never straddle batches). All substeps run in workgroup memory (about 10 KB, under the 16 KB default limit).

```wgsl
const WG: u32 = 64u;
const MAXS: u32 = 256u;

struct Params { dt: f32, mu: f32, rho: f32, g: f32, tick: u32, nBatch: u32, _a: u32, _b: u32 };
struct Batch  { firstSeg: u32, nSeg: u32, nSub: u32, nColour: u32 };
struct SegStatic { geom: vec4f, mass: vec4f, drag: vec4f, extra: vec4f, topo: vec4u };
struct SegDyn    { pos: vec2f, vel: vec2f, ang: vec2f, misc: vec2f };
struct Joint     { anc: vec4f, lim: vec4f, mot: vec4f };

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> batches: array<Batch>;
@group(0) @binding(2) var<storage, read> segS: array<SegStatic>;
@group(0) @binding(3) var<storage, read_write> segD: array<SegDyn>;
@group(0) @binding(4) var<storage, read> joints: array<Joint>;
@group(0) @binding(5) var<storage, read_write> jointD: array<vec4f>;   // u, a, work, iso
@group(0) @binding(6) var<storage, read> crHdr: array<vec4i>;          // anchor (as f32-convertible) for flow sampling
@group(0) @binding(7) var flowTex: texture_2d<f32>;
@group(0) @binding(8) var flowSmp: sampler;

var<workgroup> wx:   array<vec2f, MAXS>;   // position offset
var<workgroup> wv:   array<vec2f, MAXS>;
var<workgroup> wth:  array<vec2f, MAXS>;   // (theta, theta_prev)
var<workgroup> wom:  array<f32, MAXS>;
var<workgroup> wxp:  array<vec2f, MAXS>;   // x_prev
var<workgroup> wtau: array<f32, MAXS>;     // muscle torque of the joint owned by segment k
var<workgroup> wHdr: Batch;

@compute @workgroup_size(WG)
fn integrate_full(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { wHdr = batches[wg.x]; }
  let hdr = workgroupUniformLoad(&wHdr);            // uniform value, so barriers below are legal
  for (var k = li; k < hdr.nSeg; k += WG) {
    let d = segD[hdr.firstSeg + k];
    wx[k] = d.pos; wv[k] = d.vel; wth[k] = vec2f(d.ang.x, d.ang.x); wom[k] = d.ang.y;
  }
  workgroupBarrier();
  let h = P.dt / f32(hdr.nSub);

  for (var s = 0u; s < hdr.nSub; s++) {
    // (a) muscle torques for owned joints, velocity-capped
    for (var k = li; k < hdr.nSeg; k += WG) { wtau[k] = muscle_torque(hdr.firstSeg, k, h); }
    workgroupBarrier();
    // (b) per segment: added-mass rotation, explicit forces (own joint +tau, children -tau),
    //     implicit 3x3 drag solve, predict
    for (var k = li; k < hdr.nSeg; k += WG) {
      added_mass_rotate(hdr.firstSeg, k, h);       // v <- M(th)^-1 M(th_prev) v ; Munk moment
      let tauNet = wtau[k] - sum_children_tau(hdr.firstSeg, k);   // children are contiguous (BFS order)
      explicit_forces(hdr.firstSeg, k, h, tauNet); // cilia, jet, buoyancy
      implicit_drag(hdr.firstSeg, k, h);           // (M3 + hC) V' = M3 V + hC U_flow
      wxp[k] = wx[k]; wth[k].y = wth[k].x;
      wx[k] += h * wv[k]; wth[k].x += h * wom[k];
    }
    workgroupBarrier();
    // (c) joints, Gauss-Seidel by colour
    for (var c = 0u; c < hdr.nColour; c++) {
      for (var k = li; k < hdr.nSeg; k += WG) {
        if (colour_of(hdr.firstSeg, k) == c) { solve_joint(hdr.firstSeg, k, h); }
      }
      workgroupBarrier();
    }
    // (d) velocities and work
    for (var k = li; k < hdr.nSeg; k += WG) {
      wv[k]  = (wx[k] - wxp[k]) / h;
      wom[k] = (wth[k].x - wth[k].y) / h;
      accumulate_work(hdr.firstSeg, k);            // + max(0, tau * dtheta_rel) into jointD[..].z
    }
    workgroupBarrier();
  }
  for (var k = li; k < hdr.nSeg; k += WG) {
    let gi = hdr.firstSeg + k;
    segD[gi].pos = wx[k]; segD[gi].vel = wv[k]; segD[gi].ang = vec2f(wth[k].x, wom[k]);
  }
}
```

`implicit_drag` builds `C = sum_p J_p^T D_p J_p` from the two Gauss points (sampling `flowTex` at `anchor + offset + r_p`), adds `M3`, and solves the 3x3 system by Cramer's rule. `solve_joint` implements 2.7.3 using `minv_dir`, the direction-dependent inverse mass from the added-mass matrix.

### 2.10.2 Hash build and contact search

```wgsl
const NLEV: u32 = 8u;
fn cell_size(l: u32) -> f32 { return 0.001 * f32(1u << (2u * l)); }
fn level_of(R: f32) -> u32 { return min(NLEV - 1u, u32(max(0.0, ceil(log2(2.0 * R / 0.001) * 0.5)))); }
fn cell_hash(l: u32, c: vec2i) -> u32 {
  return ((u32(c.x) * 73856093u) ^ (u32(c.y) * 19349663u) ^ (l * 83492791u)) & (P.tableMask);
}

@compute @workgroup_size(256)
fn hash_count(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x; if (i >= P.nItems) { return; }
  let p = item_world_pos(i);                       // f32 world pos is fine at cell resolution
  let l = level_of(item_radius(i));
  let c = vec2i(floor(p / cell_size(l)));
  itemCell[i] = vec4i(c, i32(l), 0);
  let hsh = cell_hash(l, c);
  itemKey[i] = hsh;
  atomicAdd(&cellCount[hsh], 1u);
}

@compute @workgroup_size(256)
fn hash_scatter(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x; if (i >= P.nItems) { return; }
  let hsh = itemKey[i];
  let slot = cellStart[hsh] + atomicAdd(&cellFill[hsh], 1u);
  sortedItem[slot] = i;
}

@compute @workgroup_size(128)
fn find_contacts(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x; if (i >= P.nItems) { return; }
  let li = u32(itemCell[i].z);
  let p  = item_world_pos(i);
  let mask = level_mask_at(p);
  for (var l = li; l < NLEV; l++) {
    if ((mask & (1u << l)) == 0u) { continue; }
    let base = vec2i(floor(p / cell_size(l)));
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let cc = base + vec2i(dx, dy);
        let hsh = cell_hash(l, cc);
        let s0 = cellStart[hsh]; let s1 = s0 + atomicLoad(&cellCount[hsh]);
        for (var s = s0; s < s1; s++) {
          let j = sortedItem[s];
          let cj = itemCell[j];
          if (cj.z != i32(l) || any(cj.xy != cc)) { continue; }   // hash collision
          if (l == li && j <= i) { continue; }                     // same level: once per pair
          if (skip_pair(i, j)) { continue; }                       // same creature and adjacent, etc.
          let k = capsule_capsule(i, j);                           // relative geometry via integer anchors
          if (k.depth < k.margin) {
            let slot = atomicAdd(&nContacts, 1u);
            if (slot < P.contactCap) { contacts[slot] = k.contact; } else { atomicStore(&overflow, 1u); }
          }
        }
      }
    }
  }
}
```

### 2.10.3 Contact and link solve (Jacobi, fixed point)

```wgsl
@compute @workgroup_size(256)
fn solve_contacts(@builtin(global_invocation_id) gid: vec3u) {
  let ci = gid.x; if (ci >= min(atomicLoad(&nContacts), P.contactCap)) { return; }
  var c = contacts[ci];
  let g = current_contact_geometry(c);             // re-evaluate depth and normal from current state
  if (g.depth >= 0.0) { return; }
  let wa = minv_dir(c.a, g.n) + pow(cross2(g.ra, g.n), 2.0) * inv_inertia(c.a);
  let wb = minv_dir(c.b, g.n) + pow(cross2(g.rb, g.n), 2.0) * inv_inertia(c.b);
  let at = P.contactCompliance / (P.dt * P.dt);
  let dl = -g.depth / (wa + wb + at);
  let impA = g.n * dl;
  add_delta(c.a,  minv_mul(c.a, impA),  inv_inertia(c.a) * cross2(g.ra, impA));
  add_delta(c.b, -minv_mul(c.b, impA), -inv_inertia(c.b) * cross2(g.rb, impA));
  contacts[ci].lambda += dl;                       // for impulse J = lambda / dt (touch, ram damage)
}

fn add_delta(s: u32, dx: vec2f, dth: f32) {
  let q = fix_scale(s);                            // 2^20 / radius(s)
  atomicAdd(&segAcc[4u * s + 0u], i32(round(dx.x * q)));
  atomicAdd(&segAcc[4u * s + 1u], i32(round(dx.y * q)));
  atomicAdd(&segAcc[4u * s + 2u], i32(round(dth * 1048576.0)));
  atomicAdd(&segAcc[4u * s + 3u], 1);
}
// apply_deltas: per segment, delta = sum / max(count, 1); pos += delta; vel += delta / dt; clear.
// Links use the same pattern with type-specific compliance and break checks.
```

### 2.10.4 `metabolism`

```wgsl
@compute @workgroup_size(128)
fn metabolism(@builtin(global_invocation_id) gid: vec3u) {
  let c = gid.x; if (c >= P.nCreatures) { return; }
  var M = crMeta[c];
  let m = crPhys[c].x;
  let T = temperature_at(c);
  let B = P.B0 * pow(m, 0.75) * exp(P.EaOverK * (1.0 / P.Tref - 1.0 / T));
  let Pm = muscle_power(c, B);          // sum of positive work / (eta_m dt) + isometric term
  let Po = organ_power(c) + brain_power(c);
  let Pact = Pm + Po;
  let cap = (P.Saer - 1.0) * B;
  let anaer = max(0.0, Pact - cap);     // drawn from A; if A empty, set activation scale < 1 for next tick
  let absorbed = digest(&M, c);         // first-order emptying per class, faeces to detritus
  var dE = (absorbed - B - min(Pact, cap)) * P.dt;
  M.A = M.A - anaer * P.dt + recover(cap - Pact) * P.dt;
  grow_or_reproduce(&M, c, &dE);        // moves energy E_s -> tissue / E_r
  if (M.Es + dE < 0.0) { catabolise(&M, c, -(M.Es + dE)); dE = -M.Es; }
  M.Es += dE;
  write_ledger(c, B, Pm, Po, absorbed); // f32 channel values for this tick
  crMeta[c] = M;
}
```

### 2.10.5 `integrate_reduced`

```wgsl
@compute @workgroup_size(256)
fn integrate_reduced(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x; if (i >= P.nReduced) { return; }
  var r = redDyn[i];
  let card = cards[redCard[i]];
  update_gait_estimator(&r, i);                     // EMA mean, RMS amplitude, zero-crossing frequency per joint group
  let gd = gait_descriptor(r);                      // (A, f, turn)
  let ss = card_lookup(card, gd);                   // trilinear: steady speed U, turn rate Om, muscle power Pm
  let e = vec2f(cos(r.theta), sin(r.theta));
  let uRel = r.vel - sample_flow_world(r);
  // thrust and torque chosen so steady state reproduces the card exactly
  let T = drag_axial(card, ss.U);                   // K1 U + K15 U^1.5 + K2 U^2
  let Q = drag_rot(card, ss.Om);
  // implicit body-frame drag, same structure as 2.7.2 with aggregated coefficients
  r.vel   = implicit_body_drag(card, r, uRel, T * e + buoyancy(card, r), P.dt);
  r.omega = (card.Ieff * r.omega + P.dt * Q) / (card.Ieff + P.dt * rot_drag_coeff(card, r.omega));
  r.off   += P.dt * r.vel; r.theta += P.dt * r.omega;
  redWork[i] = ss.Pm * eta_m_times_dt();            // charged by the same metabolism kernel
  redDyn[i] = r;
}
```

## 2.11 Level of detail and camera fairness

### 2.11.1 Tiers

- **F (full)**: everything in 2.2 to 2.7.
- **R (reduced swimmer)**: one rigid body with anchor, heading, velocity and angular velocity, driven by its **swimmer card**: a table, per morphology, of steady speed, turn rate and muscle power as a function of a gait descriptor (amplitude, frequency, turn asymmetry), plus aggregated passive drag coefficients and effective mass. It collides as a single capsule hull. The brain still runs (brains decides its own rate). Proprioceptive inputs are synthesised from the card's mean pose plus per-joint amplitude and phase at the current gait descriptor, and the renderer gets the stroke phase (rendering 6.2 already poses far creatures procedurally from phase).

For microbes the R model is close to exact rather than an approximation: at low Re there is no inertia, so the period-averaged velocity is a linear function of the stroke, which the card captures fully.

### 2.11.2 Where cards come from

A card is keyed by a quantised morphology hash, so siblings and most offspring share their parent's card.

1. **Lab runs.** A new morphology is run in a "physics lab" batch: isolated full-tier copies in still water with 48 prescribed gaits (4 amplitudes x 4 frequencies x 3 turn values) for 3 s each. A 10-segment creature costs about 150k segment-substeps, so the 5090 calibrates hundreds of new morphologies per second in under 0.2 ms per tick. The same lab is the UX section's "test tank" for honest cruise-speed numbers (UX section, test UX-T08).
2. **Observed gaits.** Whenever a creature of that morphology is in tier F, its gait descriptor, realised speed, turn rate and muscle power are recorded into the card cell (recency-weighted mean). Cards therefore converge to what the lineage's real brains actually do, not only to the lab's sine waves.
3. **Audits.** Every minute, 2% of R-tier creatures (chosen by a seeded hash, never by the camera) are promoted to F for 10 s; the difference between card prediction and realised motion and energy is logged and fed back.

### 2.11.3 Tier rules

Camera-independent rules, applied first:

1. Body length at least 0.3 m, or more than 64 segments: always F (few, and they dominate scenes and fights).
2. Any interaction (contact with another creature, link, bite in progress, attacker or prey of a hunt within 3 body lengths) in the last 2 s: F. Promotion takes effect next tick, so every fight is full physics.
3. Re below 0.5 and at most 4 segments (microbes): R.
4. Audit sample: F.

Then:

5. **Fair mode** (default on the 5090): if the F tier fits the budget, every remaining creature is F. The camera never matters.
6. **Budget mode** (laptop, or the 5090 over budget): remaining creatures are ranked by a camera-independent score (size, recent interaction, card confidence) and the best fit into the budget. Only if William enables "detail near camera" does view proximity enter the score. Views are rendering clients; the host knows each view's region of interest from its ROI stream subscription.

Hysteresis: demote only after 3 s outside the rules; at most 2% of the F budget changes tier per tick. Promotion reconstructs segment poses from the card's mean pose and phase at the current gait, with velocities from rigid motion plus the gait derivative; the small momentum mismatch is logged, not charged.

### 2.11.4 Why evolution is not biased by the camera

- Both tiers call the same metabolism kernel. Muscle power in R comes from the card, which is measured with the exact same work formula as F.
- Cards are per morphology and are fitted from that morphology's own full-physics gaits, so a good swimmer stays good and a bad one stays bad in R.
- Fights, grabs, latches and giants are always F, so predation outcomes never depend on where the camera is.
- In fair mode (the 5090 default) the camera has no role at all.
- Bias is measured, not assumed: audits give per-species mean errors in speed and cost of transport, shown in the god window. A species whose card error exceeds 5% is recalibrated immediately. Test L2 compares evolution with different camera positions.

## 2.12 Performance budget

### 2.12.1 RTX 5090 (WebGPU, Dawn in the sim host)

Hardware: about 1.8 TB/s memory bandwidth, about 105 TFLOPS fp32, 32 GB. WebGPU through Dawn reaches perhaps 50 to 70% of native CUDA on compute kernels like these (estimate, to be measured). Physics budget: **4 ms per 60 Hz tick** (24% of the GPU; brains take about 1 ms per tick, rendering about 2 ms per frame, the rest is headroom for William's own use).

Reference workload: 60k F-tier creatures with 12.5 segments on average (750k segments, average 1.6 substeps) plus 1.5M R-tier agents (mostly microbes), 2.25M hash items.

| Kernel | Work | Estimate |
|---|---|---|
| `integrate_full` | 750k segments x 1.6 substeps, about 300 B of global traffic per segment per tick (rest in workgroup memory), about 400 flops per substep | 1.0 ms (ideal 0.15 ms; derated 6x for barriers, occupancy, divergence) |
| `integrate_reduced` | 1.5M agents x 64 B read and write plus card reads | 0.3 ms |
| hash count, scan, scatter | 2.25M items, table 4M | 0.5 ms |
| `find_contacts` | 2.25M queries, irregular reads | 1.0 ms |
| `solve_contacts` x2 + apply, links | about 9M contact evaluations | 0.4 ms |
| interactions, metabolism, ledger | 1.56M creatures | 0.3 ms |
| LOD, gait statistics, card lab | | 0.2 ms |
| **Total** | | **3.7 ms** |

Stretch goal (to be measured in the first prototype): 2M F-tier segments plus 4M R-tier agents at 60 Hz in about 8 ms, or the same at 30 Hz within the 4 ms share. The brains section budgets 300k brained creatures; the physics reference workload covers that with room for brainless drifters, corpses and fragments.

### 2.12.2 Weak laptop

**CPU fallback** (4 cores, 8 threads, JS typed arrays, 3 physics workers, 30 Hz tick, physics budget 3 workers x 12 ms = 36 core-ms per tick):

| Work | Cost estimate | Count |
|---|---|---|
| F tier | about 1 microsecond per segment per tick (1.3 substeps) | 15k segments (about 1.5k creatures): 15 core-ms |
| R tier | about 0.15 microseconds per agent | 30k agents: 4.5 core-ms |
| hash and contacts | about 0.3 microseconds per item | 45k items: 13.5 core-ms |
| metabolism, ledger, LOD | | 2 core-ms |
| **Total** | | **35 core-ms** |

WASM with SIMD could roughly double these counts later (estimate). Workers own whole creatures (no creature split across workers), contacts are solved per spatial stripe with the same integer accumulation, so the CPU result is deterministic too.

**Integrated GPU** (Iris Xe class, about 2 TFLOPS, about 60 GB/s shared): bandwidth is about 1/30 of the 5090, so about 40k F segments plus 80k R agents at 30 Hz within 4 ms (estimate). Workgroup memory per batch is the same 10 KB.

On the laptop the population governor (architecture section) caps births before physics would exceed its budget, and budget mode (2.11.3) is active.

## 2.13 Tests

Every test runs headless in CI on the CPU reference and, where a GPU runner exists, on WebGPU. "Reference" means an f64 CPU implementation of the same equations with 256 substeps.

### Conservation (C)

- **C1 Vacuum momentum.** Fluid, gravity and buoyancy off. 500 random grown bodies, random muscle activations for 60 s. The centre of mass moves less than `1e-5 L` (it cannot swim in vacuum) and total angular momentum stays at its initial value within `1e-6` of `m L^2 / s`. Bodies may reorient (like a falling cat) with zero net angular momentum.
- **C2 Muscle work.** Vacuum, passive damping off. Positive minus negative muscle work equals the change in kinetic plus elastic energy within 2% (XPBD's numerical damping is the allowed slack).
- **C3 Ideal fluid (Kirchhoff).** Drag off, added mass on (`c_a = 1`). A passive tumbling plate conserves kinetic energy within 1% over 100 s and total impulse `sum M_i v_i` within `1e-5`; the Munk moment turns it broadside, as theory predicts. An actuated three-segment body swims in ideal fluid with zero net impulse (Saffman's result).
- **C4 Nutrients.** 6 simulated hours of a full ecosystem with god-mode events: total nutrient quanta identical at every tick (integer equality).
- **C5 Energy ledger.** Stock change equals inputs minus heat within `1e-6` relative per simulated hour; the rounding channel stays below the same bound.
- **C6 Bites and drains.** Mass removed by bites equals mass added to guts plus detritus, exactly in quanta.

### Known swimmers (B)

- **B1 Scallop theorem.** A two-segment reciprocal flapper: net displacement under 0.005 body lengths per cycle at Re 0.05, and over 0.05 body lengths per cycle at Re 1,000. The same flapper with feathering (non-reciprocal) moves at both.
- **B2 Gray-Hancock flagellum.** A headless chain of 32 thin segments with a prescribed small-amplitude travelling wave `y = b sin(k(x - Vt))` at Re below 0.01. Resistive force theory gives, to leading order, `U / V = (gamma - 1)(b k)^2 / 2` with `gamma = k_n1 / k_t1` (my own derivation of the classical small-amplitude result, Gray and Hancock 1955, J. Exp. Biol. 32:802, https://doi.org/10.1242/jeb.32.4.802, unverified DOI). Pass: within 10% for `b k <= 0.3`; the swimming direction is opposite to the wave.
- **B3 Purcell's three-link swimmer.** The square stroke in joint-angle space at low Re. Pass: net displacement per cycle and direction agree within 3% with the f64 reference using the same resistive force coefficients, and the qualitative behaviour (direction, optimal stroke amplitude) agrees with Becker, Koehler and Stone 2003 (J. Fluid Mech. 490:15, https://doi.org/10.1017/S0022112003005184, unverified).
- **B4 Inertial undulator.** A 20 cm, 8-segment body with a prescribed travelling-wave gait, sweeping frequency and amplitude at Re 1e3 to 1e4. Pass: steady speed is close to linear in frequency at fixed amplitude, and peak Froude efficiency falls at a Strouhal number `St = f A / U` in [0.15, 0.5] (real swimmers cruise at 0.2 to 0.4: Taylor, Nudds and Thomas 2003, Nature 425:707, https://doi.org/10.1038/nature02000). This is a soft benchmark for a quasi-steady model: failing it triggers review of the drag constants and the trailing-edge flag, not a build failure.
- **B5 Stokes settling and terminal velocity.** A single sphere-like segment: settling speed matches `(2/9) Delta rho g r^2 / mu` within 2% at Re below 0.01; a large dense body reaches the quadratic-drag terminal speed within 2%.
- **B6 Scaling.** An isometric family of the reference fish from 2 mm to 4 m with lab gaits optimised per size. Pass: cost of transport falls with mass with slope between -0.15 and -0.45 on a log-log fit; cilia-only microbes reach 0.5 to 2 body lengths per second, independent of size in the Stokes regime, while cilia on a 0.2 m body give under 1% of its fin speed.
- **B7 Coasting.** After actuation stops, coasting distance in body lengths is proportional to Re below Re 1 and about constant (set by `m_eff / k_2`) above Re 1,000.

### Timestep convergence and stability (T)

- **T1 Substep convergence.** B2, B3 and B4 run with `n_sub` in {1, 2, 4, 8, 16, 32, 64} against the reference. Error in displacement per cycle and in cost of transport decreases at least first order, and at the `n_sub` chosen by the 2.7.4 rule it is below 2%.
- **T2 Tick-rate invariance.** The same scenes at 30 Hz and 60 Hz ticks (laptop versus 5090) give speeds and costs of transport within 3%.
- **T3 Multi-rate consistency.** Forcing every creature one bucket higher changes per-creature speed and energy statistics by less than 2%.
- **T4 Stiffness extremes.** Microbes at 0.2 mm, leviathans at 20 m, passive stiffness at both ends of its range, `h` up to 1/30 s: no NaN, no energy gain without muscle work.
- **T5 Fuzz.** 10,000 random genomes from the growth generator, random activations, 10 simulated minutes each: no NaN or Inf, positions inside the tank, no joint separation above 1% of segment length, kinetic energy never exceeds the integral of muscle work plus buoyancy work (an "energy from nothing" detector; any violation saves the genome as a regression case, because evolution will find every such exploit, as Karl Sims's creatures famously did).
- **T6 Precision.** A microbe at the far corner of the tank swims the same distance per cycle as at the origin, within 0.1%.

### Infrastructure (I)

- **I1 Hash correctness.** Random scenes with sizes over four decades: the set of contact pairs equals a brute-force all-pairs test, with no duplicates.
- **I2 Determinism.** Same seed, same machine, 10,000 ticks: bitwise identical state hash; snapshot at tick 5,000, restore, continue: identical hash.
- **I3 GPU versus CPU.** 1 s horizon: trajectories within `1e-3 L`; 10 minutes: distributions of speed and cost of transport agree (Kolmogorov-Smirnov p above 0.01).
- **I4 Performance.** Scripted scenes at 10k, 100k and 750k segments; per-kernel timings with timestamp queries; CI fails on a regression above 15%.

### LOD (L)

- **L1 Card accuracy.** 500 random morphologies, gaits from their own evolved brains: R-tier steady speed, turn rate and muscle power within 5% of F tier; transient response (start, stop) within 20% in time constant.
- **L2 Camera A/B.** 3 seeds x 2 camera placements (fixed on one region versus the opposite corner) x 6 simulated hours in budget mode with "detail near camera" on: species abundance trajectories and mean trait values differ by no more than the between-seed variance. Fair mode is checked with the same protocol for zero difference (bitwise, since the camera is not an input).
- **L3 Audit loop.** A deliberately miscalibrated card (speed +20%) is detected and corrected within 2 simulated minutes.

## 2.14 Failure modes

| Failure | Cause | Response |
|---|---|---|
| Tunnelling | thin fins, fast small bodies | collision radius floor for plates, speculative margin, substep rule on `v / r` |
| Chain stretch on long bodies | one XPBD iteration per substep on 256-segment chains | colour Gauss-Seidel plus small steps; T5 measures stretch; fall back to 2 iterations for chains over 128 |
| Added-mass blow-up | explicit added mass on thin fins | never explicit: it lives in the mass matrix |
| Munk tumbling looks wrong | real physics, but unstable bodies spin | fins and drag damp it; if bodies look restless, tune `c_a` (aesthetic constraint from the brief) |
| Contact explosions | deep overlap after growth or promotion | depenetration speed capped at 0.5 body lengths per second; growth checks overlap before committing |
| Energy exploits | numerical work from constraints or contacts | T5 detector at runtime too: a creature whose mechanical energy rises faster than its muscle work input for 2 s is flagged, its speed clamped, and its genome logged |
| f32 loss far from origin | large tank | anchors (2.7.6) |
| Buffer overflow | contact or event storms (a bait ball, a plague of latches) | overflow flag, buffer growth, tick redone; never silent truncation |
| Bucket thrash | creature near a bucket boundary | bucket recomputed once per second with hysteresis |
| Tier bias | card error | audits, recalibration, fair mode default |

## 2.15 Interfaces

- **Growth/genome section** provides `SegmentSpec[]` per growth stage (2.2.2), with organ flags and gene values. Physics never reads raw genes. It asks growth for the next stage when `m` crosses a boundary.
- **Brains section** writes per joint `u` (and fin pitch, cilia, jet, bladder, mouth, bite, grip, latch, emit) in [-1, 1] into `jointDyn.u` and organ drive slots. Physics returns joint angles and velocities, touch force per segment, body velocity relative to water, depth and pressure, energy, fatigue (`1 - A / A_max`), damage and "attached" flags. Brain cost `P_brain` comes from brains.
- **Ecosystem section** owns food particles, plankton, the detritus and nutrient fields and the light field; physics hands it faeces, corpse decay and bite spill as integer quanta, and reads plankton contacts at mouths.
- **Environment section** provides the current texture, temperature field, terrain SDF and tank size.
- **Rendering** receives segment poses for near views (`NearPose`) and stroke phase plus heading for far views; the 2.5D capsules match its tapered-capsule body field.
- **Architecture** owns the tick loop, the governor, snapshots (all buffers in 2.9 are the physics part of a snapshot; cards are cached and can be rebuilt) and the host's WebGPU device.

## 2.16 Prior art

- Karl Sims, "Evolving Virtual Creatures", SIGGRAPH 1994, https://www.karlsims.com/papers/siggraph94.pdf: rigid segments, joint torques from evolved controllers, viscous water drag. Also the classic warning about physics exploits.
- Tu and Terzopoulos, "Artificial Fishes", SIGGRAPH 1994 (unverified URL above): mass-spring fish with hydrodynamic forces from muscle contraction.
- Framsticks, https://www.framsticks.com/: stick creatures with water simulation and energy.
- ALIEN, https://alien-project.org/: GPU particle-based soft bodies in a large world; the GPU-scale inspiration, a different body model.
- Polyworld (Yaeger 1994), https://github.com/polyworld/polyworld: energy costs of size, movement and brains.
- The Bibites (prior art only): simple 2D bodies with energy budgets; nothing is copied.
- XPBD: Macklin et al. 2016, Mueller et al. 2020, Macklin et al. 2019 (URLs in 2.2.1 and 2.7.1).
- Low-Re swimming: Purcell 1977; Gray and Hancock 1955; Lighthill 1976; Becker, Koehler and Stone 2003. High-Re: Lighthill 1971; Taylor, Nudds and Thomas 2003.
- Metabolic scaling: Kleiber 1932 (Hilgardia 6:315, unverified); West, Brown and Enquist 1997; Gillooly et al. 2001; Schmidt-Nielsen 1972.

## 2.17 Open questions for William

1. **Viscosity of the tank.** Tank water is 20x more viscous than sea water so that microbes live at low Re and leviathans at high Re within the zoom range. Is a fixed "honest but thicker water" fine, or would you like it as a god-mode slider (which would reshape what evolves, live)?
2. **Glow cost.** If light organs cost what physics says, evolution may dim the tank wherever glowing does not pay (mating, lures, counter-illumination). Should there be a free, non-heritable baseline glow so the wallpaper never goes dark, with only the bright displays costing energy?
3. **Fair mode on the 5090.** I propose that on your PC the camera never affects physics (all non-microbes full physics when the budget allows), and camera-based detail only on weaker machines. Agreed, even if it caps the population somewhat lower?
4. **Size ceiling.** Physics is tested up to 20 m and 256 segments, but in a 256 m tank a 20 m leviathan is large. Should the tank size, a soft size cap, or nothing at all (only food) limit giants?
5. **Injury visibility.** Bites remove tissue and can sever tails and fins, which then float as corpse fragments. For a calm wallpaper, should severed parts dissolve into glowing particles quickly, or stay visible as food for scavengers?
