# 6. Rendering, camera director and audio

Status: draft for William's review, 2026-11-04.
Scope: everything a view does with the world state it receives: drawing the glowing deep-sea look, choosing what the camera looks at in screensaver and TV mode, and the generative soundtrack. The sim, genome, growth and architecture sections own the world itself; this section lists what it needs from them in 6.7.

Conventions used here:
- World units are metres. The habitat is a finite 2D side view: x is horizontal, y is depth (0 at the surface, positive downwards). Examples assume a 256 m by 128 m tank; every number that depends on tank size is written as a parameter.
- Zoom is stored as `zeta = log2(pixels per metre)`. A 4K screen showing the whole 256 m tank is zeta = log2(3840/256) ≈ 3.9; showing a 0.25 m field of view (a 2 mm microbe is then 30 px wide) is zeta ≈ 13.9. That is 10 octaves, about 3 orders of magnitude, matching the brief.
- Colour maths is in linear light, HDR (`rgba16float`), tonemapped once at the end.
- "5090" means William's RTX 5090 PC. "Laptop" means a weak reference machine: Intel Iris Xe class integrated GPU (about 2 TFLOPS fp32, shared memory), 1080p screen. Budgets are estimates to be confirmed by the benchmarks in 6.8.

---

## 6.1 Render architecture

### 6.1.1 Backends and targets

| Target | Runtime | Backend | Notes |
|---|---|---|---|
| Wallpaper | Lively Wallpaper web wallpaper (Chromium based: WebView2 or CEF, unverified which Lively version uses which) | WebGPU, WebGL2 fallback | Same PC as the sim host. Must leave the GPU to the sim and to William's own work. |
| Screensaver | `.scr` wrapper hosting WebView2 | WebGPU, WebGL2 fallback | Full quality. Wrapper passes `--autoplay-policy=no-user-gesture-required` if audio is enabled (unverified flag name for WebView2, check at build time). |
| TV, cast | Chrome tab cast to Google TV | rendered on the PC | Video is re-encoded by the cast pipeline: dark gradients and fine noise compress badly, see "cast sub-profile" in 6.1.6. |
| TV, local URL | Google TV built-in or installed browser | WebGL2 most likely | Weak GPU: low tier only. |
| God window | Chrome or Edge window | WebGPU | Full quality plus overlays. |

WebGPU has shipped in Chromium on Windows since version 113 (2023). WebView2 tracks Edge's Chromium, so the wallpaper and screensaver should get it, but Lively's embedded runtime and GPU flags must be checked (unverified). The renderer is written once against a thin "GPU abstraction" with two implementations; every effect in this section has a WebGL2 path, and only GPU-driven culling and tiled binning are WebGPU-only (the WebGL2 path does them on a CPU worker).

### 6.1.2 Frame graph

Each frame runs these passes in order. Resolution is relative to the internal render size R (which itself is the output size times `renderScale`).

| # | Pass | Kind | Res | Output |
|---|---|---|---|---|
| 1 | Classify and cull | compute (WGSL) or worker (WebGL2) | n/a | per-LOD instance lists, indirect draw args |
| 2 | Pose | compute or worker | n/a | posed capsule buffer for L0 and L1 instances |
| 3 | Water background | fullscreen fragment | R/2 | `bg` (depth gradient, caustics, god rays, haze) |
| 4 | Far snow and density | instanced additive | R/2 | into `emit` and `bg` |
| 5 | Bodies L1 and L0 | instanced SDF fragment, sorted | R | MRT: `body` (premultiplied colour over), `emit` (additive HDR) |
| 6 | Impostors L2 | instanced sprites, weighted blended OIT | R | `body`, `emit` |
| 7 | Specks L3 and organ glows | instanced additive gaussian quads | R | `emit` |
| 8 | Near snow | instanced | R | `body` |
| 9 | Trails | ping-pong feedback with reprojection | R/2 | `trail` |
| 10 | Bloom | dual-filter down and up chain | R/2 to R/64 | `bloom` |
| 11 | Composite | fullscreen | output | tonemap, safety gain, dither, sRGB |
| 12 | Captions | DOM overlay (not GPU) | output | lower third |

Rationale for the split between `body` and `emit`: reflected light (body pigment lit by the weak sunlight that reaches a given depth) must be composited "over" the water in depth order, while bioluminescence is light, adds, and feeds trails and bloom. Keeping them apart is also what makes the flash limiter (6.1.7) possible: it only has to police `emit` and the exposure curve.

### 6.1.3 Data the renderer receives

The view never sees full world state. It sends the host a region-of-interest (ROI) subscription (current viewport plus a margin, plus the director's predicted next viewport) and receives LOD-filtered data. Wire format belongs to the architecture section; the renderer needs:

```ts
// Per creature, per snapshot (15 to 30 Hz), only inside the ROI.
// 20 bytes, little endian, structure of arrays on the wire.
interface FarRecord {
  id: u32;          // unique for the world's lifetime (needed by the director's memory)
  x: f32; y: f32;   // metres. f32 gives ~15 µm resolution over 256 m, below 1 px at max zoom.
  heading: u16;     // angle, 2π/65536 steps
  logSize: f16;     // log2(body length in metres)
  genomeId: u32;    // key for the template cache; templates fetched lazily
  phase: u8;        // swim stroke phase, so drawn strokes match simulated thrust
  energy: u8;       // 0 to 255, dims bioluminescence when starving (honest health signal)
  flags: u8;        // dead, infected, mating, attacking, juvenile, sessile
  pad: u8;
}

// Only for instances the view has flagged as L0 (at most 64 or 128): real joint angles.
interface NearPose { id: u32; angles: Int8Array /* per joint, π/128 steps, up to 64 */ }

// Whole-tank, 1 Hz, from the host.
interface CensusFrame {
  t: number;
  species: { id: u32; count: u32; biomassKg: f32; meanColour: [f32, f32, f32] /* OKLCH */ }[];
  heat: Float32Array;     // 64 x 32 cells x 4: biomass, emissive sum, species count, activity
  microbeDensity?: Uint16Array; // 512 x 256 per colour bucket, when microbes are a field or too small to draw
  env: { dayPhase: f32; season: f32; turbidity: f32; temperatureMap?: Uint8Array };
}
```

Creature bodies come from the grown skeleton. The growth function is shared TypeScript code and deterministic, so the view regrows a `RenderTemplate` locally from the genome instead of streaming geometry. Genomes are fetched only when a creature first needs L1 or L0 (so a million microbes never cost a genome fetch), and templates live in an LRU cache keyed by `genomeId` (4096 entries on the 5090, 1024 on the laptop).

```ts
interface RenderTemplate {
  genomeId: u32;
  nodes: {          // parent-first order, at most 64 for L0
    parent: u8; restLen: f32; restAngle: f32;
    radius: f32;    // capsule end radius at this node
    kind: u8;       // spine | limb | fin | tentacle | mouth | eye | spike | gut | lightOrgan
    s: f32;         // arc-length coordinate along its chain, 0 to 1, for patterns
  }[];
  capsules: { a: u8; b: u8 }[];      // node pairs, tapered capsules
  membranes: { a: u8; b: u8; c: u8; alpha: f32 }[]; // fin webs as triangles
  macro: { node: u8; radius: f32 }[]; // at most 8, for L1 (6.1.4)
  organs: { node: u8; offset: [f32, f32]; radius: f32; hue: f32; chroma: f32;
            period: f32; phase: f32; duty: f32 }[];
  look: { bodyHue: f32; bodyChroma: f32; bodyL: f32; coreAlpha: f32; edgeAlpha: f32;
          rimGain: f32; rimHue: f32; stripeFreq: f32; stripeAmp: f32; spotDensity: f32;
          trailGain: f32 };
  swim: { mode: 'undulate' | 'flap' | 'jet' | 'drift'; waveNumber: f32; ampProfile: Float32Array };
  morphKey: u32;    // quantised shape hash, shared by near-identical bodies, keys the impostor atlas
  chunks: { capStart: u16; capEnd: u16; neighbours: u16[] }[]; // see 6.1.5
}
```

Snapshots arrive at 15 to 30 Hz and frames render at 30 to 60 Hz, so the view renders 2 snapshot intervals behind the newest snapshot and interpolates position and heading (Hermite on position using the two velocities), extrapolating at most 200 ms if the stream stalls, then freezing motion and slowly fading trails rather than snapping.

### 6.1.4 Level of detail across 3 orders of magnitude

Screen size `s = bodyLength × 2^zeta × renderScale` in pixels picks the tier. Thresholds have ±15% hysteresis per instance (previous LOD stored per id in a hash keyed buffer) and tier changes cross-fade over 250 ms using a blue-noise dissolve (each pixel picks old or new tier by comparing a blue-noise value with the fade fraction), which costs no extra blending.

| Tier | Screen size | What is drawn | Cap (5090 / laptop) |
|---|---|---|---|
| D, density | < 0.75 px | not drawn individually; host density grid splatted as a soft texture, coloured by bucket | n/a |
| L3, speck | 0.75 to 4 px | one additive gaussian quad, hue from organ colour, brightness from size and luminescence gene, slow twinkle | 2M / 150k |
| L2, impostor | 4 to 28 px | atlas sprite (rest pose plus 4 swim frames) tinted per individual, vertex wobble | 50k / 4k |
| L1, body | 28 to 110 px | SDF over at most 8 macro capsules, rim, pattern, one aggregate light organ | 4k / 400 |
| L0, hero | > 110 px | full SDF skeleton (up to 64 capsules), fin membranes, gut silhouette, eyes, every light organ, real physics pose | 128 / 16 |

When a cap is hit, the classify pass keeps the largest-on-screen instances in the higher tier and demotes the rest (sort key: screen size, then director subject priority, so the subject of the current shot is never demoted).

Macro capsules for L1 are built once per template by chain simplification: walk each chain, merge consecutive capsules while the merged tapered capsule stays within 10% of the union's area, then keep the 8 largest by area. Impostors are rendered lazily from L0 at rest pose into a `morphKey` atlas cell (64 × 64, 4096² atlas on 5090, 2048² on laptop) storing channels R = body thickness, G = rim, B = organ mask, A = coverage, so a single cell serves every individual of a shape and colour is applied per individual in the shader.

Microscopic scale: at max zoom, plankton and microbes get their own visual vocabulary (cilia as short ribbons, nuclei visible through the membrane), but they are drawn by the same L0 path from their templates. The deliberate "seamless" trick is that a creature's L3 speck colour equals the integrated emissive colour of its L0 body, so zooming in resolves a speck into the same colour of body rather than popping.

### 6.1.5 Bodies as signed distance fields

Prior art: Inigo Quilez's 2D distance functions and smooth minimum (https://iquilezles.org/articles/distfunctions2d/, https://iquilezles.org/articles/smin/). Metaball fields splatted into a shared buffer were rejected because two overlapping creatures would visibly fuse, which reads as wrong during a bite. A per-creature SDF keeps bodies distinct, and the distance value gives thickness, rim and halo for free.

Body field: `d(p) = smin_k(tapered capsules)` with blend radius `k = 0.6 × median capsule radius` (gene-modulated: soft jelly-like lineages blend more). Shading from `d`:
- coverage `c = 1 - smoothstep(-aa, aa, d)`, `aa = fwidth(d)`;
- thickness `th = saturate(-d / rRef)` (0 at the skin, 1 at the thickest point), an approximation of how much tissue light passes through;
- body alpha `a = c × mix(edgeAlpha, coreAlpha, sqrt(th))`, both genes; jellies have low core alpha;
- rim `rim = exp(-|d| / rimW)`, a Fresnel-like edge brightening that sells the membrane;
- halo (emissive only) `halo = exp(-max(d, 0) / haloW) × rimGain × energy` outside the body.

Large creatures (a leviathan filling the screen is 2M+ pixels) are split into chunks of 8 capsules. Each chunk is its own instanced quad covering its capsules' bounds plus blend and halo margin. A chunk evaluates its own capsules plus a precomputed neighbour list (capsules within `k + rMax + pose slack` in rest pose), and a pixel is written only by the chunk that owns the nearest raw capsule (ties broken by index). Every pixel therefore has exactly one owner, so translucent chunks never double-blend and the cost per pixel is about 12 capsule evaluations instead of 64.

Ordering: translucent bodies use premultiplied "over". Each creature gets a stable pseudo-depth `zl = hash(id) in [0, 1)` that is used only for draw order and a subtle 0 to 15% haze toward the water colour (it never touches the sim). L0 and L1 instances (at most a few thousand) are sorted by `zl` on the GPU (bitonic sort in compute, or CPU in the worker for WebGL2). L2 impostors use weighted blended order-independent transparency (McGuire and Bavoil 2013, https://jcgt.org/published/0002/02/09/), because sorting 50k sprites per frame is not worth it for 4 to 28 px objects. Specks are additive and need no order.

Pose: L0 uses the host's real joint angles (`NearPose`). L1 and L2 use a procedural pose from the streamed stroke phase: for undulators `angle_i = A(s_i) × sin(phase - waveNumber × 2π × s_i)`, for flappers fins oscillate with phase and the spine stays nearly rigid, for jets the bell radius pulses. Forward kinematics runs one thread per creature over the parent-first node list.

WGSL outline, L0 and L1 body fragment:

```wgsl
struct Capsule { a: vec2f, b: vec2f, ra: f32, rb: f32, s0: f32, s1: f32 };
struct Inst {
  ownStart: u32, ownEnd: u32,         // capsules this chunk owns
  nbStart: u32, nbCount: u32,         // neighbour indices into nbIdx
  look: u32,                          // index into looks[]
  rRef: f32, k: f32, zl: f32,
  energy: f32, flags: u32,
};
@group(0) @binding(0) var<storage, read> caps: array<Capsule>;
@group(0) @binding(1) var<storage, read> nbIdx: array<u32>;
@group(0) @binding(2) var<storage, read> insts: array<Inst>;
@group(0) @binding(3) var<storage, read> looks: array<Look>;
@group(0) @binding(4) var<uniform> frame: Frame; // time, camera, depth light, caustic params

fn sdTaperedCapsule(p: vec2f, c: Capsule, h: ptr<function, f32>) -> f32 {
  let ba = c.b - c.a; let pa = p - c.a;
  *h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * *h) - mix(c.ra, c.rb, *h); // not an exact SDF for strong taper; fine for shading
}
fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

struct FsOut { @location(0) body: vec4f, @location(1) emit: vec4f };

@fragment fn fsBody(@location(0) wp: vec2f, @interpolate(flat) @location(1) ii: u32) -> FsOut {
  let inst = insts[ii];
  var d = 1e9; var dRawMin = 1e9; var owner = 0u; var sAt = 0.0;
  // own capsules
  for (var i = inst.ownStart; i < inst.ownEnd; i++) {
    var h: f32; let di = sdTaperedCapsule(wp, caps[i], &h);
    if (di < dRawMin) { dRawMin = di; owner = i; sAt = mix(caps[i].s0, caps[i].s1, h); }
    d = smin(d, di, inst.k);
  }
  // neighbours: contribute to blending and to ownership test
  for (var j = 0u; j < inst.nbCount; j++) {
    let i = nbIdx[inst.nbStart + j];
    var h: f32; let di = sdTaperedCapsule(wp, caps[i], &h);
    if (di < dRawMin) { dRawMin = di; owner = i; }
    d = smin(d, di, inst.k);
  }
  if (owner < inst.ownStart || owner >= inst.ownEnd) { discard; } // exactly one chunk shades a pixel

  let L = looks[inst.look];
  let aa = fwidth(d);
  let cover = 1.0 - smoothstep(-aa, aa, d);
  let th = saturate(-d / inst.rRef);
  let rim = exp(-abs(d) / L.rimW);
  let stripe = 1.0 + L.stripeAmp * cos(6.2831853 * sAt * L.stripeFreq);
  let alpha = cover * mix(L.edgeAlpha, L.coreAlpha, sqrt(th));

  // Reflected light: sunlight attenuated per channel with depth (Beer-Lambert), plus caustics.
  let light = depthLight(wp.y, frame) + causticLight(wp, frame);
  let albedo = oklchToLinear(L.bodyL, L.bodyChroma, L.bodyHue) * stripe;
  let lit = albedo * light * alpha + rim * cover * light * 0.5;
  let hazed = mix(lit, frame.waterColour * alpha, inst.zl * frame.hazeMax);

  // Emission: rim glow inside, halo outside, scaled by energy (starving creatures dim).
  let halo = exp(-max(d, 0.0) / L.haloW);
  let e = oklchToLinear(0.75, L.rimChroma, L.rimHue) * L.rimGain * inst.energy
        * (rim * cover + 0.35 * halo);
  return FsOut(vec4f(hazed, alpha), vec4f(e, L.trailGain)); // emit.a = trail weight, see 6.1.6
}
```

Fin membranes use Quilez's triangle SDF with their own alpha (0.1 to 0.4) and the union `alpha = max(bodyAlpha, finAlpha)`, which keeps fins as see-through webs. The gut is a second, smaller SDF over `kind == gut` nodes, darkening the interior by up to 40% so a full gut is visible through a translucent body (a lovely cue for "just ate"). Eyes are discs with a pupil and a specular dot whose position follows the creature's heading.

Light organs are drawn in pass 7 as additive gaussian sprites at their node positions, radius from the gene, intensity:

```
pulse(t)   = duty-shaped raised cosine: 0.5 - 0.5 cos(2π · frac(t / T + φ)) shaped by duty
intensity  = base · energy · mix(1 - depthOfPulse, 1, pulse(t))
T          = clamp(gene period, T_min(profile), 12 s); T_min = 1.0 s (wallpaper), 0.5 s (others)
```

Light organ genes are expressive (period, phase, duty, colour, count, placement), so a species' rhythm is part of its identity. Synchronous flashing within a species (fireflies) can evolve if the sim exposes neighbours' light as a sense; the renderer simply draws what the genes and brain outputs say, inside the limits of 6.1.7.

Dead creatures: on death the body keeps its last pose, `coreAlpha` and colour fade over 20 s, light organs fade over 10 to 30 s (slowest for big animals, which is poignant), and the carcass sinks as the sim says. Decomposition emits detritus particles into the marine snow system. Infected creatures (flag) get a mottled cellular-noise darkening of `emit`, and parasites are drawn as their own small creatures attached to host nodes.

### 6.1.6 Water, light and atmosphere

Depth light, per channel Beer-Lambert attenuation so reflected colour goes blue then black with depth:

```
sun(t)      = daylight curve from env.dayPhase and season, 0 at night (moonlight 0.02)
k           = (0.35, 0.07, 0.03) per metre-equivalent for R, G, B (stylised, not real ocean values)
depthLight  = sun(t) · exp(-k · y · depthScale) · (1 - turbidity · 0.5)
background  = mix(surfaceColour, abyssColour, 1 - exp(-y / 40 m)) · depthLight + abyssFloor
abyssFloor  = linear (0.0015, 0.0025, 0.006), never pure black, so OLED TVs do not crush detail
```

Below roughly 60 m (parameter) the scene is lit almost only by bioluminescence, which is the look the brief asks for.

Caustics near the surface: two layers of a precomputed tileable caustic texture (generated at startup by ray-bending a height field, or a warped Voronoi), scrolled in different directions, combined with `min` and raised to a power, period 6 to 10 s (calm). Applied to the background and multiplied into body light, falling off as `exp(-y / 8 m)`. Off at night.

God rays: in daytime, 1D noise extruded along a slanted direction from the surface, fading by `exp(-y / 25 m)`, swaying slowly. No screen-space radial blur, it is too expensive at 4K for what it adds.

Marine snow: world-anchored particles in 3 parallax layers (far, mid at the creature plane, near) so camera motion always reads as motion. Fall speed 0.5 to 2 cm/s (scaled with zoom so it looks right at all scales: snow particle size is fixed in screen pixels for far and near layers and in world units for the mid layer), advected by the sim's current field sampled at 1 Hz from the census. Density scales with the local detritus concentration from the census heat map, so a whale fall leaves a visible snowstorm below it. Counts scale with screen area: 3000 at 1080p, 8000 at 4K, half in wallpaper.

Trails, a screen-space feedback buffer at half resolution:

```wgsl
@fragment fn fsTrail(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Reproject: where was this pixel's world point last frame (camera pan and zoom), then
  // advect against the local water current so trails drift with the water.
  let wp = frame.invViewProj * uv;
  let prevUv = frame.prevViewProj * (wp - currentAt(wp) * frame.dt);
  var prev = textureSampleLevel(trailPrev, linearClamp, prevUv, 0.0).rgb;
  if (any(prevUv < vec2f(0.0)) || any(prevUv > vec2f(1.0))) { prev = vec3f(0.0); }
  let fresh = textureSampleLevel(emitHalf, linearClamp, uv, 0.0);
  let decay = exp(-frame.dt / frame.trailTau);          // frame-rate independent
  return vec4f(prev * decay + fresh.rgb * fresh.a, 1.0); // fresh.a = per-creature trail weight
}
```

`trailTau` is 0.6 s (wallpaper) to 1.2 s (TV). Per-creature trail strength is a gene (`trailGain`, written into `emit.a`), so some lineages leave long comet tails and others none. On a zoom jump larger than 1 octave in one frame (a dip-to-dark cut), the buffer is cleared over 300 ms instead of reprojected.

Bloom: dual-filter (Kawase-style) downsample and upsample chain, 4 to 6 levels from half resolution (Bjørge, "Bandwidth-Efficient Rendering", SIGGRAPH 2015 course; slides were hosted by ARM, URL not re-checked), with a soft knee threshold so only emitters bloom. Intensity is a profile parameter, capped so bloom can never lift the screen's mean luminance by more than 25%.

Composite:

```wgsl
@fragment fn fsComposite(@location(0) uv: vec2f, @builtin(position) fc: vec4f) -> @location(0) vec4f {
  let bg = textureSample(bgTex, s, uv).rgb;
  let body = textureSample(bodyTex, s, uv);           // premultiplied
  var hdr = bg * (1.0 - body.a) + body.rgb;
  let em = textureSample(emitTex, s, uv).rgb + textureSample(trailTex, s, uv).rgb;
  hdr += em + textureSample(bloomTex, s, uv).rgb * frame.bloomStrength;
  hdr *= textureSample(safetyGain, s, uv).r * frame.exposure; // 6.1.7, low-res, slew-limited
  var ldr = tonemapFilmic(hdr);                        // fitted ACES curve (Narkowicz 2015)
  ldr = linearToSrgb(ldr);
  let n = textureLoad(blueNoise, vec2u(fc.xy) % 64u, 0).r - 0.5; // Peters' blue noise
  ldr += n * frame.ditherAmp / 255.0;                  // kills banding in dark gradients
  return vec4f(ldr, 1.0);
}
```

Dithering matters more than usual here: a near-black gradient across a 4K screen has only a handful of 8-bit codes, and banding is the most likely "looks cheap" failure. Blue-noise textures: Christoph Peters, http://momentsingraphics.de/BlueNoise.html. Tonemap: Krzysztof Narkowicz, https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/.

Cast sub-profile (Chrome tab casting re-encodes video at a bitrate the renderer cannot control): static rather than animated dither, minimum speck size 2 px, marine snow count halved, black level lifted by 2/255, trails slightly longer. All of these reduce macroblocking in dark, sparkly scenes. Selected automatically when the page is opened with `?mode=tv&cast=1`, which the TV launcher sets.

### 6.1.7 Accessibility: no harsh flashing

The wallpaper runs for hours in William's peripheral vision, and the repo is public, so it must be safe for photosensitive viewers by design, not by luck. Target: never fail WCAG 2.3.1 "Three Flashes or Below Threshold" (https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html) in any mode, and in wallpaper mode stay far below it.

Three layers of protection:
1. Slow by construction. Light organ periods are clamped (6.1.5); creature glow changes are smooth raised cosines; global light (day and night, seasons) changes over minutes; exposure adapts with a 4 s time constant and at most 0.5 stops per second. The brightest event visuals (meteor, vent eruption) are authored as slow swells (rise of at least 1.2 s) with a shockwave drawn as a refraction ring and a dim glow, never a white frame.
2. Red is special. Saturated red emission (OKLCH hue 0 to 40 degrees, chroma > 0.15) gets an extra period clamp of 2 s, because WCAG's red flash threshold is stricter.
3. Safety net at runtime. After bloom, the 1/32-resolution bloom mip gives a coarse luminance grid (about 120 × 68 tiles at 4K). Per tile, the composite keeps a 1 s history of relative luminance and counts opposing transitions of at least 10% where the darker state is below 0.8. If a region larger than the WCAG small-area allowance (taken conservatively as 10% of the screen) has 2 or more transitions in 1 s, a low-res `safetyGain` texture for those tiles ramps the emissive contribution down by up to 70% over 300 ms and recovers over 3 s. This should essentially never trigger; when it does, it logs an event so the cause can be fixed.

Also: `prefers-reduced-motion` halves camera speeds, disables cuts (only glides) and shortens trails; captions meet 4.5:1 contrast against a soft dark scrim; there is no text or UI in wallpaper mode at all.

### 6.1.8 Colour from genes, and readable species

Colour space: OKLCH (Björn Ottosson, https://bottosson.github.io/posts/oklab/), because equal gene steps then look like equal colour steps, which keeps mutation drift visually smooth and lets the director and tests measure colour distance meaningfully.

Gene to colour mapping:

| Gene (0 to 1) | Visual parameter | Mapping |
|---|---|---|
| `pigHue` | body hue | `360 · g` degrees |
| `pigSat` | body chroma | `0.02 + 0.10 · g` (translucent tissue is never very saturated) |
| `pigLight` | body lightness | `0.30 + 0.35 · g` |
| `opacity` | core and edge alpha | core `0.08 + 0.5 g`, edge `core + 0.25` |
| `lumHue` | emission hue | warped: `h = 220 + 180 · (2g - 1)^3` degrees, so most of the gene range lands in blue to green (deep-sea bioluminescence is mostly blue, around 470 to 490 nm: Widder 2010, Science 328:704, https://doi.org/10.1126/science.1174269), while rare lineages can still reach red or violet |
| `lumGain` | rim and organ brightness | `0` to `4` HDR units, times energy |
| `stripeFreq`, `stripeAmp`, `spotDensity` | pattern | along chain coordinate `s`, spots by cellular noise in body space |
| `trailGain` | trail weight | 0 to 1 |
| organ genes | per-organ hue, period, phase, duty | as above, hue warped the same way |

Colour is honest: the ambient views always show the genetic colour, never a renderer-assigned species colour. Readability comes from things that genuinely co-vary with species:
- silhouette, which follows the grown body and is the strongest cue at L1 and above;
- colour genes, which drift with the rest of the genome and so cluster by species;
- light organ rhythm, a per-species "signature" that is readable even as specks;
- size distribution.

In god mode and in captions, the swatch shown for a species is the census `meanColour`. God mode also has a "phylo colours" toggle that recolours everything by clade: the root gets the hue interval [0, 360), each split divides its parent's interval among its children in proportion to their population, and a species' hue is the midpoint of its interval, so sister species look related. If two coexisting species have mean colours closer than ΔE_OK 0.04, god mode draws thin outlines when hovering; ambient views do nothing (whether colour is visible to the creatures themselves is open question 1).

### 6.1.9 Frame budgets and profiles

The sim shares the 5090 with the renderer and must win. GPU times below are for the render only, at the stated output resolution; "laptop" is the weak reference machine.

| Profile | FPS cap | renderScale | Bloom levels | L0 / L1 caps | Snow | Audio | GPU budget 5090 (4K) | GPU budget laptop (1080p) |
|---|---|---|---|---|---|---|---|---|
| Wallpaper | 30 (15 on battery or when the host reports high sim load) | 0.5 at 4K, 0.75 at 1440p, 1.0 at 1080p | 4 | 16 / 800 | half | off | ≤ 1.5 ms per frame (under 5% of one 30 fps frame) | ≤ 8 ms |
| Screensaver | 60 | 1.0 | 6 | 128 / 4000 | full | off by default (open question 4) | ≤ 5 ms | ≤ 25 ms at 30 fps |
| TV, cast | 30 | 1.0 at 1080p | 5 | 64 / 2000 | half | on | ≤ 3 ms | n/a |
| TV, local browser | 30 | 0.75 | 3 | 8 / 300 | quarter | on | n/a | (TV SoC) ≤ 30 ms |
| God window | vsync | 1.0 | 6 | 128 / 4000 | full | user toggle | ≤ 8 ms | ≤ 25 ms |

Rough cost model on the 5090 at 4K (to be measured): background and atmosphere 0.2 ms; 1M specks at about 16 px each, 0.3 ms; 50k impostors, 0.3 ms; 4000 L1 at about 50² px with 8 capsules, 0.2 ms; 128 L0 at about 200² px with about 12 capsules per pixel after chunking, 0.4 ms; trails and bloom at half resolution, 0.4 ms; composite 0.2 ms. That is about 2 ms of a 16.7 ms frame. On the laptop at 1080p the same scene with laptop caps is about 6 to 9 ms. Memory: impostor atlas 64 MB (5090) or 16 MB (laptop); HDR targets about 200 MB at 4K full rate, about 30 MB at 1080p.

Frame cap: `requestAnimationFrame` still fires at the monitor rate, so the loop accumulates time and renders only when `accum ≥ 1 / capFps`, which avoids judder from uneven skipping by locking to integer divisors of the refresh rate when possible (a 144 Hz monitor and a 30 fps cap renders every 5th frame, 28.8 fps).

Adaptive quality: a PI controller on measured GPU time (WebGPU `timestamp-query` when the feature is present, otherwise smoothed frame time) adjusts, in order, renderScale (0.5 to 1.0), bloom levels, L1 and L0 caps, snow count, speck cutoff. It changes one step at most every 2 s, with a 10% dead band, so quality never visibly pumps. Lively already pauses the wallpaper when a fullscreen app runs; the page also stops rendering on `visibilitychange` and tells the host to drop its ROI stream.

Failure modes and responses: WebGPU missing or device lost (recreate device once, then fall back to WebGL2 for the session); template not yet grown when a creature enters L1 (draw it as L2 or L3 until ready, never as nothing); stream stall (extrapolate 200 ms, then freeze and fade trails); shader compile failure on a driver (per-pass fallbacks: bloom off, trails off, SDF to impostor).

---

## 6.2 Screensaver camera director

Prior art: He, Cohen and Salesin, "The Virtual Cinematographer" (SIGGRAPH 1996, https://doi.org/10.1145/237170.237259) for idiom-based shot selection; van Wijk and Nuij, "Smooth and efficient zooming and panning" (InfoVis 2003, https://www.win.tue.nl/~vanwijk/zoompan.pdf) for the optimal pan-and-zoom path; Electric Sheep (https://electricsheep.org) as an evolving screensaver; nature documentary grammar (establishing shot, follow, reveal, aftermath) for the shot vocabulary.

The director runs in each view (screensaver, TV, optionally god window and, in calm mode, the wallpaper), because each view has its own camera. It needs global events, which every view receives in full (they are small), plus the 1 Hz census.

### 6.2.1 Data flow

```
SIM HOST (owns world)
 step @ fixed dt ──► primitive events ring buffer
 │                    birth, death{cause,killer}, bite, mate, infect,
 │                    speciation, extinction, god{cmd,tFire}
 ├─ detectors @ 1 to 4 Hz on full state ──► derived events
 │                    hunt, school, giant, record, endangered,
 │                    outbreak, massDeath, carcass, novelty
 ├─ census @ 1 Hz ──► species stats, 64x32 heat map, env
 └─ ROI state @ 15 to 30 Hz ──► FarRecord / NearPose for each view's ROI
        ▲                                  │
        │ ROI subscribe (viewport +        │ events (reliable, ordered, all)
        │ predicted next viewport)         ▼
VIEW ──────────────────────────────────────────────────────────────────
 EventIngest ─► StoryBook (merge by key, bounded at 512 stories)
                  │
 Director @ 2 Hz: score stories ─► select (hysteresis, softmax) ─► ShotPlanner
                  │                                                 │
 ExposureMemory ◄─┘ (what has been on screen, decayed)              ▼
                                         CameraRig @ frame rate: springs, paths,
                                         limits ─► Renderer, Captions, Audio
```

Every event and census frame is also appended to a rolling binary event log on the host (24 h, versioned schema), which is what the director tests replay (6.8.2) and which later enables a "highlights of the night" reel.

### 6.2.2 Events from the sim

Entity ids are unique for the world's lifetime (u32 with wrap detection, or u64 on the wire), so "have I shown this shark" works across hours.

```ts
type SimEvent =
  // primitive, emitted by the step
  | { k: 'birth'; t: number; id: Id; parents: Id[]; species: Sp; pos: V2; size: number; mode: 'bud' | 'sex' }
  | { k: 'death'; t: number; id: Id; species: Sp; pos: V2; size: number;
      cause: 'predation' | 'starvation' | 'age' | 'disease' | 'parasite' | 'disaster'; killer?: Id }
  | { k: 'bite'; t: number; attacker: Id; target: Id; pos: V2; dmg: number }
  | { k: 'mate'; t: number; a: Id; b: Id; pos: V2 }
  | { k: 'infect'; t: number; host: Id; strain: number; pos: V2 }
  | { k: 'speciation'; t: number; parent: Sp; child: Sp; founders: Id[]; pos: V2 }
  | { k: 'extinction'; t: number; species: Sp; lastId: Id; pos: V2 }
  | { k: 'god'; t: number; tFire: number; cmd: GodCmd; pos: V2; radius: number; strength: number }
  // derived, emitted by detectors
  | { k: 'hunt'; t: number; phase: 'start' | 'update' | 'end'; pred: Id; prey: Id; pos: V2; outcome?: 'kill' | 'escape' }
  | { k: 'school'; t: number; phase: 'start' | 'update' | 'end'; species: Sp; n: number; centroid: V2; radius: number; polarisation: number; sample: Id[] }
  | { k: 'giant'; t: number; id: Id; species: Sp; size: number; percentile: number }
  | { k: 'record'; t: number; kind: 'size' | 'age' | 'speed' | 'depth' | 'generation' | 'offspring'; id: Id; value: number; prev: number }
  | { k: 'endangered'; t: number; species: Sp; remaining: number; ids: Id[] }
  | { k: 'outbreak'; t: number; phase: 'start' | 'update' | 'end'; strain: number; host: Sp; prevalence: number; growth: number; centroid: V2; radius: number }
  | { k: 'massDeath'; t: number; centroid: V2; radius: number; deaths: number; z: number }
  | { k: 'carcass'; t: number; id: Id; size: number; pos: V2; scavengers: number }
  | { k: 'novelty'; t: number; id: Id; species: Sp; morphCluster: number; distance: number };
```

Detector algorithms (host side, all O(N) with the sim's spatial hash, run on a worker at the stated rate):

| Detector | Rate | Rule | Notes |
|---|---|---|---|
| Hunt | 4 Hz | Predator P (diet genes say carnivore, or has bitten before) with thrust > 0.5 of its max, distance to a prey Q decreasing over a 1.5 s window, closing speed > 0.2 body lengths/s, and Q's speed rising (fleeing). If the brain exposes an attention or target output, use it directly instead. End on kill (death with killer P), escape (distance growing for 3 s), or 30 s timeout. | Only predators are scanned; about 5% of creatures. |
| School or swarm | 1 Hz | Grid DBSCAN per species, eps = 3 body lengths, minPts = 12. Polarisation φ = ‖Σ vᵢ/‖vᵢ‖‖ / n (Vicsek et al. 1995, https://doi.org/10.1103/PhysRevLett.75.1226). School if n ≥ 30 and φ > 0.7; swarm or mill if n ≥ 30 and φ < 0.3. Bait ball if a school has ≥ 2 predators within 2 radii. | |
| Giant | 1 Hz | Size ≥ max(q99.9 of all macro sizes, 30 × median macro size, G_abs = 2 m). Streaming quantiles with the P² algorithm (Jain and Chlamtac 1985, https://doi.org/10.1145/4372.4378). Re-emit every 60 s while alive. | |
| Record | on change | New all-time max for a kind, emitted only if it beats the previous record by ≥ 5%, and only once per 10 min per kind unless the gain is ≥ 20%. | Avoids a stream of 0.1% "records" from a growing animal. |
| Endangered | 1 Hz | Species population ≤ 5 having peaked at ≥ 30. Re-emits with the remaining ids; the last individual becomes a story of its own. | |
| Outbreak | 0.5 Hz | Per (strain, host species) prevalence p over 30 s windows. Start when p > 0.15, dp/dt > 0.02/min and infected ≥ 10; end when p < 0.05. Centroid and radius of infected hosts. | |
| Mass death | 1 Hz | Deaths per cell (16 × 8 grid) per 20 s window versus an exponentially weighted baseline: z = (n - μ) / sqrt(μ + σ² + 1) > 5 and n ≥ 20. | Catches unplanned crashes, not just god events. |
| Carcass ("whale fall") | 1 Hz | A corpse of size ≥ giant threshold or ≥ 10 kg with ≥ 3 scavengers within 2 body lengths. | |
| Novelty | 0.2 Hz | Body-plan descriptor (segment, limb, fin, eye counts; mouth type; log size; aspect) for each new adult. Archive as in novelty search (Lehman and Stanley 2011, Evolutionary Computation 19(2)); emit if the k-nearest (k = 15) distance to the archive exceeds a threshold tuned so it fires about twice an hour. | "First creature with eyes" moments. |
| God commands | immediate | The god window's command is broadcast as `god` at once with `tFire = t + leadIn` (default 3 s, parameter 0 to 5 s; open question 5). The host applies it at `tFire`, so every director can arrive in time for the start. | |

Births are by far the most common event and are mostly noise. They only become stories when notable: first birth of a new species, a giant's offspring, a sexual mating of two L1-or-larger animals, or a "baby boom" (≥ 10 births of one species in a 20 m cell within 20 s, merged in the StoryBook).

### 6.2.3 Stories

The StoryBook turns events into stories, which are what the director actually scores.

```ts
interface Story {
  id: number;
  type: StoryType;          // disaster | lastOfSpecies | speciation | giantKill | record | massDeath
                            // | carcass | hunt | kill | outbreak | school | novelty | mating | giant | birthNotable
  key: string;              // merge key, e.g. "hunt:<pred>" or "school:<species>:<cell>"
  subjects: Id[];           // primary subject first
  species: Sp[];
  pos: V2; radius: number;  // world region to frame
  tStart: number; tLast: number;  // tLast = last supporting event
  magnitude: number;        // type specific (biomass lost, school size, size ratio to record...)
  ended: boolean;
}
```

Merging: an event updates the story with the same key, or one of the same type within `mergeRadius` (20 m) and 10 s. A kill ends its hunt story and spawns a short `kill` (aftermath) story. A hunt where predator or prey is a giant is promoted to `giantKill`. The book is bounded at 512 stories; eviction removes the lowest-scoring ended stories first, so an event storm (a plague killing 10k animals) cannot grow memory or tick cost.

### 6.2.4 Interest score

Each director tick (2 Hz), every story gets

```
S = W[type] · (1 + a · ln(1 + magnitude / m0[type]))     base interest
      · A · N · V · T · Q

A = exp(-(now - tLast) / tau[type])                        recency of activity
N = exp(-(βe·Ee + βs·Es + βt·Et + βr·Er))                  novelty, from exposure memory
V = visibility (0.2 to 1)                                  can it be seen and framed?
T = exp(-u / u0)                                           travel cost, exempt for disasters
Q = 1 + 0.3 while it is the current story and inside its planned hold, else 1
```

Exposure memory (this is what stops the same shark being shown twice). Every frame, everything on screen accumulates exposure, not just the subject of the shot, weighted by its prominence (`min(1, screen area fraction × 4)`), so incidental appearances also count. Exposure is stored per key and decays exponentially:

| Key | Accumulates | Half-life | β |
|---|---|---|---|
| entity id (Ee) | seconds of prominent screen time | 30 min | 0.15 per s |
| species (Es) | seconds | 10 min | 0.04 per s |
| story type (Et) | seconds featured | 4 min | 0.01 per s |
| region, 32 m cell (Er) | seconds | 3 min | 0.01 per s |

For a story, `Ee` and `Es` are the maxima over its subjects and species. With these numbers, a shark followed for 30 s has `N ≈ exp(-4.5) ≈ 0.01` from entity exposure alone, so it cannot come back unless its story is a disaster-tier event; after an hour it is back to `N ≈ 0.25`.

Base weights and time constants (initial values for tuning on recorded logs):

| Type | W | tau (s) | m0 and magnitude | Preferred shot |
|---|---|---|---|---|
| disaster (god) | 10 | 120 | affected radius | establishing, then push-in, then aftermath |
| lastOfSpecies | 6 | until death | 1 | slow push-in, long hold, caption |
| speciation | 5 | 600 | founders count | establishing on both species, caption |
| giantKill | 5 | 20 | size ratio | tracking two-shot |
| record (size) | 4.5 | 900 | % over previous | reveal |
| massDeath | 4 | 120 | deaths | establishing |
| carcass | 4 | 600 | scavengers | slow pull-back reveal |
| novelty | 3.5 | 900 | archive distance | push-in, caption |
| hunt | 3 | 8 | closing speed | tracking two-shot |
| kill (aftermath) | 3 | 15 | prey size | hold, then pull back |
| outbreak | 3 | 300 | prevalence growth | push-in on infected cluster |
| school or swarm | 2.5 | 120 | n | establishing, then tracking the flank |
| mating | 2 | 15 | body size | tracking |
| giant (present) | 2 | 60 | size / giant threshold | reveal |
| birthNotable | 1.5 | 20 | litter or boom size | push-in |
| idle composition | 0.5 | n/a | n/a | drift |

`a = 0.5` for all types. Visibility `V` multiplies: subject's expected luminance in the planned shot against a minimum (a dark creature with no light organs in the abyss is hard to film: factor down to 0.3); crowding (more than 40 L1-plus creatures overlapping the subject region: 0.6); expected remaining duration shorter than the minimum hold (0.5). Travel `u` is the van Wijk and Nuij path length from the current view to the planned view (in screen widths, log-scale aware), `u0 = 4`.

Selection and switching:
1. Candidates are stories with `S ≥ 0.6 · S_best`. Pick one by softmax over `ln S` with temperature 0.15, using the view's seeded RNG (deterministic for replays and tests).
2. Switch only if the current shot has passed its minimum hold and the pick beats the current story by 35% (`S_new > 1.35 · S_cur`), or the current story ended (aftermath hold of 3 s first), or the current shot passed its maximum hold.
3. Interrupts: a `disaster`, `lastOfSpecies` death, `giantKill` or `extinction` with `S > 8` may cut in after 2 s of any shot.
4. Idle: if `S_best < 0.8` for 5 s, go to idle drift.
5. Diversity safety: if one story type has filled more than 50% of featured time in the last 20 min, its W is halved until it drops below 40%.

Tick cost: 512 stories × a few multiplies plus exposure lookups in hash maps; under 0.2 ms in JavaScript.

### 6.2.5 Shot types

```ts
interface ShotPlan {
  kind: 'establish' | 'track' | 'pushIn' | 'reveal' | 'aftermath' | 'drift';
  story?: number; subjects: Id[];
  fill: number;          // fraction of screen height the subject bounding box should fill
  lead: number;          // look-ahead room in the heading direction, fraction of screen width
  hold: [min: number, max: number];  // seconds
  transition: 'glide' | 'zoomPath' | 'dip';
  zoomDelta?: number;    // octaves, for pushIn and reveal
}
```

| Shot | Framing | Motion | Hold (screensaver) | Used for |
|---|---|---|---|---|
| Establishing wide | story region × 2.5, fill 0.25, centred with thirds bias toward the densest heat-map cell | lateral drift 0.02 screen widths/s, zoom breathing ±0.1 octave | 10 to 20 s | disasters, schools, speciation, mass death |
| Tracking | primary subject (or bounding box of a pair) fill 0.35 (single) or 0.6 (two-shot); lead 0.12 in heading direction; subject on a third line | critically damped follow, ω = 1.5 rad/s, look-ahead 0.5 s, dead zone 15% of screen width | 8 to 40 s | hunts, mating, records, giants swimming |
| Slow push-in | starts at fill 0.2, ends at fill 0.5 | zoom +0.8 to +1.5 octaves over 10 to 20 s, eased in and out, position spring ω = 0.8 | 12 to 25 s | last of species, novelty, outbreaks, births |
| Reveal (scale) | starts on a detail (a small creature beside the giant, or the giant's eye or a light organ) 2 to 4 octaves tighter than the final framing | hold 2.5 s, then pull back at 0.2 to 0.35 octaves/s to fill 0.4; giant thud cue on the reveal | 14 to 25 s | giants, record sizes, carcass |
| Reveal (lateral) | starts on dark water beside the subject | pan 0.5 screen widths over 4 to 6 s until the subject sits on a third | 10 to 18 s | deep, glowing subjects |
| Aftermath | holds the location of a kill or death | very slow pull-back, 0.1 octaves/s, shows scavengers arriving and the glow fading | 5 to 10 s | after kill, extinction, disaster |
| Idle drift | composition from the heat map | see 6.2.7 | until a story wins | quiet times |

Framing details: the view rectangle is always clamped inside the habitat (with a small margin so the surface line or sea floor can be in shot but the camera never shows outside the tank); the horizon never rotates (rotation is the fastest way to make an ambient screen feel restless); the caption-safe band (lower third) is avoided for subject placement when captions are on.

### 6.2.6 Camera motion

Camera state: `c = (x, y, zeta)`, plus velocities. Position error is measured in screen widths at the current zoom (`ex = (x_target - x) · 2^zeta / screenWidthPx`) so a pan feels equally fast at any scale; zoom error is in octaves.

Critically damped spring per axis (Lowe, "Critically Damped Ease-In/Ease-Out Smoothing", Game Programming Gems 4, 2004; Holden's spring notes, https://theorangeduck.com/page/spring-roll-call), exact integration so it is frame-rate independent and never overshoots:

```ts
function springCritical(x: number, v: number, target: number, omega: number, dt: number) {
  const e = x - target;
  const j = v + omega * e;
  const decay = Math.exp(-omega * dt);
  return { x: target + (e + j * dt) * decay, v: (v - j * omega * dt) * decay };
}
```

Limits (soft): pan speed ≤ 0.25 screen widths/s (screensaver), 0.08 (wallpaper calm mode); zoom speed ≤ 0.35 octaves/s (screensaver), 0.12 (wallpaper); acceleration ≤ 0.5 screen widths/s². Limits are applied by scaling the spring's target error with a smooth saturation `e' = e_max · tanh(e / e_max)` rather than clamping velocity, so there is no jerk when a limit engages.

Transitions to a new shot:
- `glide` if the van Wijk path length `u < 1.5`: retarget the springs.
- `zoomPath` if `1.5 ≤ u ≤ 6`: follow the van Wijk and Nuij optimal path (zoom out, pan, zoom in as one smooth curve) with `ρ = 1.4` and constant perceived speed `V = 0.8 /s`, duration `u / V` clamped to 3 to 10 s. This is exactly the "zoom transitions across scales" problem: going from a microbe swarm to a leviathan 100 m away becomes a graceful rise, drift and dive.
- `dip` if `u > 6` or a transition would take more than 10 s: exposure eases down to 15% over 1.2 s, the camera jumps, exposure eases back over 1.5 s; trails clear. No hard cuts in any mode, and dips at most once per 20 s (once per 2 min in wallpaper calm mode).

Splines: establishing moves and idle drift waypoints are joined with centripetal Catmull-Rom splines (Yuksel, Schaefer and Keyser 2011, "Parameterization and applications of Catmull-Rom curves", Computer-Aided Design 43(7)) in `(x, y, zeta)` space, reparameterised by arc length and eased, so paths never loop or cusp.

Tracking prediction: target = subject position + velocity × 0.5 s, filtered by the spring; the dead zone means a lazily swimming subject does not cause constant micro-motion. If a subject dies mid-shot, the target freezes on the carcass and the shot becomes `aftermath`; if it leaves the ROI faster than the camera may move, the director lets it go and picks again.

Prefetch: when a shot is planned, its target viewport is added to the ROI subscription immediately, and genome templates for its subjects are requested, so by arrival the subjects are already at full L0 detail.

### 6.2.7 Idle drift

When nothing scores high, the camera should feel like a slow dive watching the tank breathe.

- Waypoints are sampled every 20 to 40 s from the census heat map with probability ∝ `(emissive + 0.3 · biomass)^0.7 · (1 - regionExposure)`, so it favours lit, lively places it has not looked at lately.
- Between waypoints the camera follows a Catmull-Rom path at 0.02 to 0.04 screen widths/s, plus an Ornstein-Uhlenbeck wobble (σ = 0.01 screen widths, mean reversion 0.05/s).
- Zoom breathes slowly: `zeta = zeta_base + 0.3 · sin(2π t / 90 s)`, with `zeta_base` itself random-walking between "whole region" and "a single school".
- Occasionally (10% of waypoints) it picks a tight detail such as a light organ cluster or plankton at microbe scale, which keeps the 3 orders of magnitude present even in quiet periods.

Wallpaper default is idle drift only (no stories), or a fixed composition if William prefers (open question 2). An optional "calm director" for the wallpaper uses the same machinery with W multiplied by 0.5 for everything except disasters, minimum hold 45 s, glides only, no captions.

### 6.2.8 Captions: the documentary lower third

Only in screensaver and TV modes, and only when enabled (default on for TV, off for screensaver). DOM overlay, not GPU, so text is crisp and accessible.

- Layout: bottom-left in the title-safe area (inner 90% of the screen, for TV overscan). Line 1: species common name in small caps, with the generated binomial in italics after it. Line 2: what is happening, in plain words. Font height 3.5% of screen height on TV (couch distance), 2.5% on monitors. A soft dark gradient scrim behind, contrast ≥ 4.5:1. The font is bundled (an open-licence sans such as Inter or IBM Plex Sans, both SIL OFL), since the views must work offline.
- Timing: appears 2 s after the shot settles, fades in 1.2 s, holds 6 s, fades out 1.5 s. At most one caption per 25 s, never two in a row for the same species.
- Placement: on the side of the screen away from the subject; the director avoids putting subjects in the lower third while a caption is planned.
- Text: templates per story type, filled from census data. Examples:
  - hunt: "Glasswhip hunting a Lanternmote" / "{pred} hunting {prey}"
  - speciation: "A new species: {child}, split from {parent} {gens} generations ago"
  - lastOfSpecies: "The last {name}. {peak} once lived here."
  - record: "The largest creature this tank has ever grown: {size} long"
  - outbreak: "A parasite is spreading through the {host}: {pct}% infected"
  - disaster: "A meteor strikes the shallows" / "Day {day} · {depth} m"
- Names come from the species section's naming scheme. If there is none, a deterministic generator builds pronounceable pseudo-Latin binomials from original morpheme tables keyed by traits (luminous, giant, spined, many-armed) and the species id, so names are stable and original (open question 3 asks whether William wants to name species himself).

---

## 6.3 Generative ambient audio

Web Audio API (https://www.w3.org/TR/webaudio/), no samples or assets: everything is synthesised so the repo stays small and CC0 clean. Off by default in wallpaper mode; on by default for TV; screensaver and god window follow a setting. Audio starts only after the platform allows it: in a browser that means a user gesture (any remote button press on the TV counts), in the `.scr` wrapper and Lively via their autoplay settings (unverified details per host).

### 6.3.1 Graph

```
Drone bus:  2 to 3 detuned oscillators (custom PeriodicWave, soft harmonics) ─► lowpass ─┐
Pad bus:    2 to 6 voices, each 2 detuned oscillators ─► lowpass (env) ─► stereo pan ────┤
Thud bus:   sine with pitch drop + filtered noise burst ─► lowpass ─► stereo pan ───────┼─► depth lowpass ─► reverb send ─► master ─► limiter ─► out
Sparkle:    soft bell (FM: 2 oscillators) ─► pan ────────────────────────────────────┤        (ConvolverNode, IR generated
Micro bus:  filtered noise ticks and bubbles (zoomed-in layer) ─────────────────────────┘         at startup: decaying stereo noise, 3 to 6 s)
```

All parameter changes use `setTargetAtTime` with long time constants (1 to 30 s), so the music moves like weather. Nodes are created once; voices are re-tuned rather than recreated, except short one-shots. Budget: at most 24 sounding voices, under 2% of one CPU core on the 5090 PC and under 5% on the laptop.

### 6.3.2 Mapping tank state to sound

Inputs, all smoothed: from the census (biomass, species count, Shannon diversity H, deaths, births, env), from the camera (depth of view centre, zoom), and from the director (current story, visible giants).

| Tank state | Sound parameter | Mapping |
|---|---|---|
| Biomass B (kg) | density d in [0, 1] | `d = clamp(0.5 + log10(B / B_ref) / 2, 0, 1)`, τ = 60 s; `B_ref` = the world's 24 h median |
| d | pad voices, note rate, brightness | voices `2 + round(4d)`; chord change every `20 - 12d` s; pad cutoff `300 · 2^(3d)` Hz |
| Diversity H | harmonic richness | H < 1: triads; 1 to 2: add9; > 2: add 7 and 9, open voicings |
| Darkness D in [0, 1] | mode, cutoff, detune, reverb, register | D rises with τ = 5 s by the fraction of biomass lost in a disaster or mass death, decays with τ = 10 min. Mode by D: Lydian (0), Ionian (0.2), Mixolydian (0.35), Dorian (0.5), Aeolian (0.7), Phrygian (0.9). Cutoff × `2^(-2D)`, drone detune `3 + 15D` cents, reverb wet `0.3 + 0.3D`, drone drops an octave when D > 0.6 |
| Day and night | brightness, tempo | night: chord changes 30% slower, cutoff × 0.7 |
| Season | key | tonic moves one step round the circle of fifths per season, crossfaded over 2 min |
| Camera depth | whole-mix lowpass | 8 kHz at the surface to 1.2 kHz at the floor, exponential in depth |
| Zoom | layer balance | microbe scale: micro bus up, drone down; whole tank: drone up |
| Giant in view | low thuds | one per power stroke (stroke phase crossing), at most 1 per 1.5 s; pitch `70 · (size / G_abs)^(-1/3)` Hz clamped 30 to 70 Hz; gain ∝ `sqrt(screen area fraction)`; a 2nd harmonic is mixed in so TV speakers without bass still convey it |
| Births on screen | sparkle | soft bell on a pentatonic subset of the current chord, at most 1 per 4 s |
| Kill on screen | no impact sound | the next chord change is pulled forward and voiced lower, a "swell" |
| Featured species | leitmotif | 3 to 5 note motif from a hash of the species id, quantised to the current mode, played once softly when the director features the species |
| Speciation | new motif | the child species' motif is its parent's with one note mutated, which is the evolution story told in sound |

Chord generator: a first-order Markov chain over the diatonic chords of the current mode (weights favour I, IV, vi, ii; leaving and returning to the tonic), with voice leading that minimises total semitone movement between chords. Pitch set always comes from the current mode, so nothing clashes no matter what the tank does.

Loudness: master peak at most -1 dBFS through a `DynamicsCompressorNode` set as a limiter; long-term level around -24 LUFS on TV (gentle background, measured offline, 6.8.3). Envelopes have attacks of at least 50 ms (thuds 20 ms, low-passed), so nothing startles.

---

## 6.4 Parameters (initial values)

| Area | Parameter | Value | Range |
|---|---|---|---|
| LOD | speck, impostor, L1, L0 thresholds | 0.75, 4, 28, 110 px | tuned per profile |
| LOD | hysteresis, cross-fade | 15%, 250 ms | 5 to 30%, 100 to 500 ms |
| Body | blend radius k | 0.6 × median capsule radius | 0.2 to 1.2 |
| Body | max capsules L0, L1; chunk size | 64, 8; 8 | |
| Light | organ period minimum | 1.0 s wallpaper, 0.5 s others, 2 s for saturated red | |
| Light | attenuation k (R, G, B) | 0.35, 0.07, 0.03 | stylised |
| Light | caustic falloff, god ray falloff | 8 m, 25 m | |
| Trails | tau | 0.6 s wallpaper, 1.2 s TV | 0.2 to 3 s |
| Bloom | levels, strength | 4 to 6, 0.6 | 0 to 1.5 |
| Exposure | adaptation tau, max rate | 4 s, 0.5 stops/s | |
| Safety | transition threshold, area | 10% change, 10% of screen | WCAG based |
| Director | tick | 2 Hz | |
| Director | switch margin, softmax temperature | 35%, 0.15 | 10 to 60%, 0.05 to 0.5 |
| Director | exposure half-lives | entity 30 min, species 10 min, type 4 min, region 3 min | |
| Director | idle threshold | S < 0.8 for 5 s | |
| Director | god lead-in | 3 s | 0 to 5 s |
| Camera | tracking ω, establishing ω | 1.5, 0.4 rad/s | |
| Camera | pan, zoom limits | 0.25 sw/s, 0.35 oct/s (screensaver); 0.08, 0.12 (wallpaper) | |
| Camera | van Wijk ρ, V | 1.4, 0.8 /s | |
| Captions | hold, min gap | 6 s, 25 s | |
| Audio | biomass τ, darkness τ up and down | 60 s; 5 s and 10 min | |
| Audio | max voices | 24 | |

All of these live in one `viewConfig` JSON per profile, hot-reloadable from the god window for tuning.

---

## 6.5 Prior art notes

- ALIEN (https://alien-project.org) renders large artificial-life particle worlds with glow on CUDA; useful reference for "many glowing things look good with bloom" but its particle-network bodies differ from grown skeletons.
- Lenia (Chan 2019, https://arxiv.org/abs/1812.05433) shows how continuous fields read as organisms; relevant to how microbe-scale density rendering should feel.
- The Bibites, prior art only: top-down 2D, a different look; nothing is borrowed.
- Electric Sheep: an evolving screensaver with community voting, an example of "interest" driving what the screen shows.
- Brian Eno's generative works (Music for Airports, the Bloom app with Peter Chilvers) for the "music as weather" approach to ambient audio.

---

## 6.6 Build order

1. WebGL2 and WebGPU skeleton with background, specks and composite (dither, tonemap): proves the look of the dark water early.
2. Template growth in the view, L1 SDF bodies, impostor atlas, LOD classify.
3. L0 with chunking and real poses; light organs; trails; bloom; flash safety net.
4. Director: event ingest, StoryBook, scoring, springs, van Wijk paths; replay harness first, so it is developed against recorded logs.
5. Captions; audio; profiles and adaptive quality.

---

## 6.7 Interfaces this section depends on

- Growth section: a deterministic, shared `grow(genome) → skeleton` with node kinds, radii and chain coordinates; colour, pattern, light organ and trail genes as listed in 6.1.8.
- Sim section: stroke phase per creature; joint angles on request for ROI; energy; flags; species ids; unique entity ids; current field and detritus concentration on a coarse grid; the primitive events in 6.2.2, including `killer` on predation deaths, and ideally a brain "attention target" output for hunt detection.
- Architecture section: ROI subscriptions, an ordered reliable event channel, a 1 Hz census channel, and the god command lead-in (`tFire`).

---

## 6.8 Tests

### 6.8.1 Visual snapshot tests

- Harness: Playwright driving headless Chromium. The WebGL2 path runs on SwiftShader in CI for deterministic pixels; the WebGPU path runs on a self-hosted Windows runner on William's PC (WebGPU in headless CI is not reliable enough to gate on; unverified for current Chromium).
- Fixtures: recorded sim snapshots plus a fixed camera and fixed time, rendered after a fixed number of warm-up frames at a fixed dt (so trails and adaptation reach the same state), with seeded blue noise.
- Comparison: NVIDIA FLIP (Andersson et al. 2020, https://research.nvidia.com/publication/2020-07_flip-difference-evaluator-alternating-images), failing if mean FLIP > 0.02 or any 32 × 32 tile > 0.15. Goldens are stored per profile and backend.
- Scenes: one per LOD tier; LOD boundary with a creature at exactly each threshold (no popping across a zoom sweep: max per-frame FLIP between consecutive frames below 0.05); palette sheet (a grid of creatures across the gene ranges, also reviewed by eye); depth series (same creature at 0, 20, 60, 120 m); caustics and god rays day versus night; bloom on a bright cluster; trails after a pan and after a zoom (reprojection, no smearing); chunked leviathan (no seams at chunk borders, checked by rendering the same creature unchunked and comparing); dead creature fade; infected mottling; cast sub-profile; dark gradient banding check (count distinct output codes in a gradient region with and without dither).
- Flash safety: render 10 s sequences at 30 fps for the worst cases (meteor, vent, algae bloom, mass synchronous organ pulsing, fastest allowed red organs, a dip transition) and run a flash analyser implementing the WCAG general and red flash rules on the frames (a small in-repo implementation, cross-checked once against PEAT, https://trace.umd.edu/peat/, which is Windows-only, unverified current availability). Pass means zero failing windows. A unit test also asserts that the safety net never triggers in these scenes, since it is meant to be a net, not the mechanism.
- Performance: benchmark scenes (1M specks, 50k impostors, 4k L1, 128 L0, a screen-filling leviathan) measured with timestamp queries on the 5090 and on a laptop-class machine, failing if a profile exceeds its budget in 6.1.9 by more than 20%.

### 6.8.2 Director tests on recorded event logs

Logs: three recorded from real runs and checked into the repo (compressed): "quiet reef" (2 h), "predator boom" (1 h), "god session" (30 min of disasters). Plus synthetic logs generated by a small script for edge cases. The director is a pure function of (event log, census frames, seed, config) producing a shot list and camera track, so tests run in Node without a GPU, faster than real time.

Unit tests:
- Spring: critically damped step response never overshoots, and is identical at 30, 60 and 144 Hz frame rates within 1e-6.
- van Wijk path: endpoints exact, path length matches the closed form, perceived speed constant within 2%.
- Scoring: each factor in isolation (recency decay, exposure decay with the half-lives, travel exemption for disasters).
- StoryBook: merging rules; bounded size under 10k events per second; eviction keeps the highest scores.

Property tests over all logs (fast-check style, many seeds):
1. No repeated subject: no entity is the primary subject of two shots within 15 min, unless it is a lastOfSpecies or disaster story.
2. Disasters are shown: every god event is on screen by `tFire` in at least 99% of cases, and within `tFire + 2 s` always.
3. Holds respected: no shot shorter than its minimum hold except by an interrupt-class event; no shot longer than its maximum.
4. Camera limits: speeds and accelerations within limits on every frame; view rectangle always inside the habitat; no rotation; at most one dip per 20 s.
5. Determinism: same log, seed and config gives a byte-identical shot list hash.
6. Calm when quiet: idle fraction ≥ 60% on "quiet reef", ≤ 30% on "predator boom".
7. Variety: no story type above 50% of featured time over any 1 h window of a mixed log.
8. Robustness: subject dies mid-shot (becomes aftermath, no camera jump); subject leaves the habitat edge; two simultaneous disasters at opposite ends; an empty tank; a stream gap of 30 s.
9. Captions: at most one per 25 s; never overlapping the subject's screen bounding box; never in wallpaper mode.
10. Cost: director tick under 1 ms at p99 on the laptop with the bounded StoryBook full.

Golden shot lists for each recorded log are kept, and a diff report (which shots changed and why, with scores) is produced on every change to the scoring code, so tuning is a reviewable decision rather than a silent drift. A "director replay viewer" page renders any log with the chosen shots for William to watch and rate; his ratings become the tuning data.

### 6.8.3 Audio tests

- Render 120 s with `OfflineAudioContext` for scripted state trajectories (boom, crash, recovery, giant pass-by).
- Assert: no NaN or denormal runs; peak ≤ -1 dBFS; integrated loudness within ±2 LU of target; spectral centroid after a crash at least 30% lower than before, and recovered within 20% after 15 simulated minutes; thud rate never above 1 per 1.5 s; voice count never above 24.
- Deterministic: same seed and trajectory gives a bit-identical buffer (Web Audio offline rendering is deterministic in Chromium for the nodes used here; unverified for ConvolverNode across versions, so that comparison uses a tolerance).

---

## 6.9 Open questions for William

1. Should creatures be able to see colour and light patterns (so colour and flashing can evolve as signals, camouflage and lures)? It changes how much the renderer's colour mapping matters to the sim, and makes it part of the genome contract.
2. Wallpaper camera: pure idle drift, a fixed framing you choose, or the "calm director" with very long holds?
3. Species names in captions: generated pseudo-Latin only, or can you name species yourself in god mode, with the generated name as the fallback?
4. Screensaver audio: off by default (my assumption, since nobody may be in the room) or on like TV?
5. Is a 3 s delay between issuing a god command and it taking effect acceptable, so the camera can arrive in time to film it? It costs some immediacy in the god window.
