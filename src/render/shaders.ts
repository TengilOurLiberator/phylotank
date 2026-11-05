/**
 * GLSL ES 3.00 shaders for the WebGL2 frame graph (06 §6.1.2). World units are metres,
 * x right, y down (depth). Colour maths is linear HDR until the composite.
 */

export const FULLSCREEN_VS = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Shared water lighting: per-channel Beer-Lambert depth light, caustics, haze colour. */
const WATER = `
uniform vec2 u_tank;
uniform float u_time;
uniform float u_sun;
uniform float u_depthScale;
uniform float u_turbidity;
const vec3 ABYSS_FLOOR = vec3(0.0015, 0.0025, 0.006);
vec3 depthLight(float y) {
  float yy = max(y, 0.0) * u_depthScale;
  vec3 k = vec3(0.35, 0.07, 0.03) + 0.11;
  return u_sun * exp(-k * yy) * (1.0 - u_turbidity * 0.5);
}
uniform sampler2D u_caustic; // the precomputed tileable caustic web (CAUSTIC_FS), 1.7 m per tile
float caustics(vec2 w) {
  float yy = max(w.y, 0.0) * u_depthScale;
  float fall = exp(-yy / 5.0);
  if (fall < 0.01 || u_sun < 0.05) return 0.0;
  float t = u_time;
  // two layers scrolled in different directions, combined with min and sharpened (06 §6.1.6)
  float a = texture(u_caustic, w / 1.7 + vec2(t * 0.011, t * 0.007)).r;
  float b = texture(u_caustic, w / 1.31 + vec2(-t * 0.009, t * 0.012) + 0.37).r;
  float m = min(a, b);
  return pow(m, 3.0) * 2.4 * fall * u_sun;
}
vec3 waterColour(float y) {
  float yy = max(y, 0.0) * u_depthScale;
  vec3 surface = vec3(0.020, 0.105, 0.150);
  vec3 abyss = vec3(0.004, 0.018, 0.045);
  return mix(surface, abyss, 1.0 - exp(-yy / 14.0)) * depthLight(y) + ABYSS_FLOOR;
}
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(float x) { float i = floor(x); float f = fract(x); float u = f * f * (3.0 - 2.0 * f); return mix(hash12(vec2(i, 1.7)), hash12(vec2(i + 1.0, 1.7)), u); }
`;

/** Start-up pass: one period of a tileable water caustic (after joltz0r and Dave Hoskins) into a texture. */
export const CAUSTIC_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
void main() {
  vec2 p = v_uv * 6.2831853 - 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  float time = 11.0;
  for (int n = 0; n < 5; n++) {
    float t = time * (1.0 - 3.5 / float(n + 1));
    i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten)));
  }
  c /= 5.0;
  c = 1.17 - pow(c, 1.4);
  o = vec4(pow(clamp(abs(c), 0.0, 1.0), 2.5), 0.0, 0.0, 1.0);
}`;

/** Pass 3: water background at half resolution, with god rays and the density splat (tier D). */
export const BG_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec4 u_view;
uniform sampler2D u_density;  // view-rect density of tier D creatures (light)
uniform sampler2D u_glow;     // host GLOW_FIELD over u_glowRect
uniform vec4 u_glowRect;
uniform float u_glowOn;
${WATER}
out vec4 o;
float floorY(float x) { return u_tank.y - 0.35 - 0.25 * sin(x * 0.21) - 0.15 * sin(x * 0.57 + 1.3) - 0.1 * vnoise(x * 1.3); }
void main() {
  vec2 w = vec2(mix(u_view.x, u_view.z, v_uv.x), mix(u_view.w, u_view.y, v_uv.y));
  vec3 c = waterColour(w.y);
  float yy = max(w.y, 0.0) * u_depthScale;
  // god rays: 1D noise extruded along a slanted direction, swaying slowly
  float sx = w.x + w.y * 0.32;
  float r = vnoise(sx * 0.9 + u_time * 0.025) * vnoise(sx * 2.3 - u_time * 0.04 + 7.0);
  float rays = smoothstep(0.25, 0.85, r) * exp(-yy / 9.0) * u_sun;
  c += vec3(0.18, 0.42, 0.5) * rays * 0.09;
  c += vec3(0.25, 0.55, 0.6) * caustics(w) * depthLight(w.y) * 0.11;
  // under the surface: a bright, wobbling mirror band (total internal reflection)
  float ys = w.y + 0.04 * sin(w.x * 2.1 + u_time * 0.6) + 0.025 * sin(w.x * 5.3 - u_time * 0.9);
  if (ys < 0.0) {
    c = vec3(0.03, 0.12, 0.16) * (0.4 + 0.6 * u_sun) + vec3(0.2, 0.4, 0.45) * u_sun * exp(ys * 6.0) * 0.4;
  } else {
    c += vec3(0.3, 0.6, 0.65) * u_sun * exp(-ys * 30.0) * 0.25;
  }
  // the floor: dark sediment with a soft edge
  float fy = floorY(w.x);
  if (w.y > fy) {
    float into = w.y - fy;
    c = mix(c, vec3(0.006, 0.005, 0.004) * (0.3 + depthLight(fy) * 3.0) + ABYSS_FLOOR * 0.4, smoothstep(0.0, 0.08, into));
  }
  // tank walls: fade to a deep, never pure black
  float outside = max(max(-w.x, w.x - u_tank.x), 0.0);
  c = mix(c, ABYSS_FLOOR * 0.5, smoothstep(0.0, 0.6, outside));
  c += texture(u_density, v_uv).rgb;
  if (u_glowOn > 0.5) {
    vec2 g = (w - u_glowRect.xy) / (u_glowRect.zw - u_glowRect.xy);
    if (all(greaterThanEqual(g, vec2(0.0))) && all(lessThanEqual(g, vec2(1.0)))) c += texture(u_glow, g).rgb * 0.6;
  }
  o = vec4(c, 1.0);
}`;

/** Passes 5 and 6: per-creature SDF bodies (L0 chunks, L1 macro, L2 core). MRT body, emit, trail source. */
export const BODY_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 i_bounds;
layout(location = 2) in vec4 i_centre;
layout(location = 3) in vec4 i_range;
layout(location = 4) in vec4 i_albedo;
layout(location = 5) in vec4 i_emit;
layout(location = 6) in vec4 i_shape;
layout(location = 7) in vec4 i_misc;
layout(location = 8) in vec4 i_fade;
uniform vec4 u_view;
out vec2 v_local;
out vec2 v_world;
flat out vec4 v_centre;
flat out vec4 v_range;
flat out vec4 v_albedo;
flat out vec4 v_emit;
flat out vec4 v_shape;
flat out vec4 v_misc;
flat out vec4 v_fade;
void main() {
  vec2 local = mix(i_bounds.xy, i_bounds.zw, a_corner);
  vec2 w = i_centre.xy + local;
  vec2 ndc = (w - u_view.xy) / (u_view.zw - u_view.xy) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  v_local = local; v_world = w;
  v_centre = i_centre; v_range = i_range; v_albedo = i_albedo; v_emit = i_emit;
  v_shape = i_shape; v_misc = i_misc; v_fade = i_fade;
}`;

export const BODY_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_local;
in vec2 v_world;
flat in vec4 v_centre;  // cx cy lenM zl
flat in vec4 v_range;   // ownStart ownCount nbStart nbCount
flat in vec4 v_albedo;  // linear rgb, coreAlpha
flat in vec4 v_emit;    // linear HDR emission, edgeAlpha
flat in vec4 v_shape;   // rimW haloW stripeFreq stripeAmp
flat in vec4 v_misc;    // k rRef trailGain spotDensity
flat in vec4 v_fade;    // fade sign seed flags
uniform highp sampler2D u_caps;
uniform highp sampler2D u_nb;
uniform sampler2D u_blue;
uniform float u_mpp;        // metres per pixel
uniform float u_hazeMax;
${WATER}
layout(location = 0) out vec4 o_body;
layout(location = 1) out vec4 o_emit;
layout(location = 2) out vec4 o_trail;

struct Cap { vec2 a; vec2 b; float ra; float rb; float s0; float s1; float kind; float alpha; };
// two texels per capsule: (ax ay bx by), (ra rb s0 + 2 kind, s1 + 2 round(100 alpha))
Cap fetchCap(int i) {
  int x = (i % 1024) * 2; int y = i / 1024;
  vec4 t0 = texelFetch(u_caps, ivec2(x, y), 0);
  vec4 t1 = texelFetch(u_caps, ivec2(x + 1, y), 0);
  float kind = floor(t1.z * 0.5);
  float a100 = floor(t1.w * 0.5);
  return Cap(t0.xy, t0.zw, t1.x, t1.y, t1.z - 2.0 * kind, t1.w - 2.0 * a100, kind, a100 * 0.01);
}
float sdCap(vec2 p, Cap c, out float h) {
  vec2 ba = c.b - c.a; vec2 pa = p - c.a;
  float l2 = dot(ba, ba);
  h = l2 > 1e-14 ? clamp(dot(pa, ba) / l2, 0.0, 1.0) : 0.0;
  return length(pa - ba * h) - mix(c.ra, c.rb, h);
}
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}
// cellular noise for spots (body space)
float cells(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  float d = 1.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = vec2(hash12(i + g), hash12(i + g + 17.3));
    d = min(d, length(g + o - f));
  }
  return d;
}

void main() {
  float bn = (texelFetch(u_blue, ivec2(gl_FragCoord.xy) & 63, 0).r * 255.0 + 0.5) / 256.0;
  if (v_fade.y > 0.5 && bn > v_fade.x) discard;      // tier fading in
  if (v_fade.y < -0.5 && bn <= v_fade.x) discard;    // tier fading out
  vec2 p = v_local;
  float k = max(v_misc.x, 1e-7);
  float dBody = 1e9, dFin = 1e9, dGut = 1e9, dEye = 1e9, raw = 1e9, rawBody = 1e9;
  float sAt = 0.0, finA = 0.0, finAcross = 0.0, eyeR = 1.0;
  vec2 eyeC = vec2(0.0);
  int owner = -1;
  int own0 = int(v_range.x), ownN = int(v_range.y), nb0 = int(v_range.z), nbN = int(v_range.w);
  for (int j = 0; j < 40; j++) {
    if (j >= ownN + nbN) break;
    int ni = nb0 + j - ownN;
    int ci = j < ownN ? own0 + j : int(texelFetch(u_nb, ivec2(ni % 2048, ni / 2048), 0).r);
    Cap c = fetchCap(ci);
    float h;
    float d = sdCap(p, c, h);
    int kind = int(c.kind + 0.5);
    if (kind == 0) {
      if (d < raw) { raw = d; owner = j; }
      if (d < rawBody) { rawBody = d; sAt = mix(c.s0, c.s1, h); }
      dBody = dBody > 1e8 ? d : smin(dBody, d, k);
    } else if (kind == 1) {
      if (d < raw) { raw = d; owner = j; }
      if (d < dFin) {
        dFin = d; finA = c.alpha;
        vec2 ba = c.b - c.a;
        vec2 nrm = normalize(vec2(-ba.y, ba.x) + 1e-9);
        finAcross = dot(p - c.a, nrm) / max(mix(c.ra, c.rb, h), 1e-7);
      }
    } else if (kind == 2) {
      dGut = dGut > 1e8 ? d : smin(dGut, d, k * 0.6);
    } else {
      if (d < raw) { raw = d; owner = j; }
      if (d < dEye) { dEye = d; eyeC = c.a; eyeR = c.ra; }
    }
  }
  if (owner < 0 || owner >= ownN) discard; // exactly one chunk shades a pixel
  if (raw > v_shape.y * 3.0 + u_mpp) discard; // beyond the halo: nothing to add

  float aa = u_mpp * 0.85;
  float rimW = v_shape.x, haloW = v_shape.y;
  float cover = 1.0 - smoothstep(-aa, aa, dBody);
  float rRef = max(v_misc.y, 1e-7);
  float th = clamp(-dBody / rRef, 0.0, 1.0);
  float edgeA = v_emit.a, coreA = v_albedo.a;
  float aBody = cover * mix(edgeA, coreA, sqrt(th));
  float rim = exp(-abs(dBody) / rimW);
  float stripe = 1.0 + v_shape.w * cos(6.2831853 * sAt * v_shape.z);
  float lenM = v_centre.z;
  float spot = 1.0;
  if (v_misc.w > 0.01) {
    float cd = cells(p / lenM * 14.0 + v_fade.z * 13.0);
    spot = 1.0 - 0.55 * v_misc.w * (1.0 - smoothstep(0.18, 0.34, cd));
  }
  // fins: see-through webs with rays along their length
  float finCover = 1.0 - smoothstep(-aa, aa, dFin);
  float rays = 0.65 + 0.35 * cos(finAcross * 9.0);
  float aFin = finCover * finA * rays;
  float finRim = exp(-abs(dFin) / (rimW * 0.7)) * finCover;
  float alpha = max(aBody, aFin);
  // gut silhouette darkens the interior so a full gut shows through a translucent body
  float gutCover = (1.0 - smoothstep(-aa, aa, dGut)) * cover;
  vec3 albedo = v_albedo.rgb * stripe * spot * (1.0 - 0.4 * gutCover);
  // reflected light: depth light attenuated per channel, plus caustics near the surface
  vec3 light = depthLight(v_world.y) * 2.2 * (1.0 + caustics(v_world) * 0.8) + ABYSS_FLOOR * 4.0;
  // the body's own light reveals its pigment in the dark (self-illumination by bioluminescence)
  vec3 selfLit = v_emit.rgb * (0.35 + 0.65 * th) * 0.6;
  vec3 lit = albedo * (light + selfLit) * alpha + (rim * cover * 0.5 + finRim * 0.25) * light * 0.5;
  // eyes: a dark disc with an iris ring and a specular dot
  float eyeCover = 1.0 - smoothstep(-aa, aa, dEye);
  vec3 eyeEmit = vec3(0.0);
  if (eyeCover > 0.0) {
    vec2 q = (p - eyeC) / eyeR;
    float rr = length(q);
    float iris = smoothstep(0.55, 0.75, rr);
    vec3 eyeCol = mix(vec3(0.0015, 0.001, 0.002), v_albedo.rgb * 0.5 + v_emit.rgb * 0.02, iris);
    vec2 sq = q - vec2(-0.3, -0.32);
    float spec = exp(-dot(sq, sq) * 40.0);
    eyeCol += (light * 1.2 + 0.05) * spec;
    lit = mix(lit, eyeCol * 0.95, eyeCover);
    alpha = max(alpha, eyeCover * 0.95);
    eyeEmit = v_emit.rgb * spec * 0.25 * eyeCover;
  }
  float zl = v_centre.w;
  vec3 hazed = mix(lit, waterColour(v_world.y) * alpha, zl * u_hazeMax);
  // emission: rim glow inside, halo outside, a faint glow through thick tissue
  float dAll = min(dBody, dFin);
  float halo = dAll > 0.0 ? exp(-dAll / haloW) : 1.0 - cover;
  // banded glow: the pattern genes modulate the light as well as the pigment
  float band = mix(1.0, stripe * spot, 0.7);
  vec3 e = v_emit.rgb * ((rim * cover * 0.8 + 0.14 * th * cover) * band + 0.4 * halo + finRim * 0.35) + eyeEmit;
  int flags = int(v_fade.w + 0.5);
  if ((flags & 8) != 0) { // diseased: mottled darkening of the light
    float m = cells(p / lenM * 9.0 + u_time * 0.05);
    e *= 0.45 + 0.55 * smoothstep(0.15, 0.45, m);
  }
  o_body = vec4(hazed, alpha);
  o_emit = vec4(e, 0.0);
  o_trail = vec4(e * v_misc.z, 0.0);
}`;

/** Pass 7: specks (L3), light organs and dust motes as additive gaussians. */
export const SPRITE_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 i_pos;    // world x y, radius (m), min radius (px)
layout(location = 2) in vec4 i_col;    // linear HDR rgb, trail weight
uniform vec4 u_view;
uniform float u_ppm;                   // render-target pixels per metre
out vec2 v_q;
flat out vec4 v_col;
void main() {
  float rTrue = i_pos.z * u_ppm;
  float rPx = max(rTrue, i_pos.w);
  float r = rPx / u_ppm * 2.6;         // the quad covers 2.6 sigma
  vec2 q = a_corner * 2.0 - 1.0;
  vec2 w = i_pos.xy + q * r;
  vec2 ndc = (w - u_view.xy) / (u_view.zw - u_view.xy) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  v_q = q * 2.6;
  // below the minimum size a speck keeps roughly its total light instead of growing brighter
  float shrink = rTrue / max(rPx, 1e-6);
  v_col = vec4(i_col.rgb * clamp(shrink * shrink, 0.12, 1.0), i_col.a);
}`;

export const SPRITE_FS = `#version 300 es
precision highp float;
in vec2 v_q;
flat in vec4 v_col;
layout(location = 0) out vec4 o_body;
layout(location = 1) out vec4 o_emit;
layout(location = 2) out vec4 o_trail;
void main() {
  float d2 = dot(v_q, v_q);
  float g = 0.55 * exp(-d2 * 0.5) + 0.8 * exp(-d2 * 3.0);
  vec3 e = v_col.rgb * g;
  o_body = vec4(0.0);
  o_emit = vec4(e, 0.0);
  o_trail = vec4(e * v_col.a, 0.0);
}`;

/** Passes 4 and 8: marine snow, procedural and world-anchored per zoom level, in three parallax layers. */
export const SNOW_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
uniform vec4 u_view;
uniform float u_tile;       // tile size (m) of this level
uniform float u_shift;      // camera centre times (1 - parallax), applied as a world offset
uniform vec2 u_camShift;
uniform float u_sizeTile;   // particle radius as a fraction of the tile
uniform float u_perTile;
uniform vec2 u_tiles;       // tiles across and down
uniform vec2 u_origin;      // first tile index
uniform float u_time;
uniform vec2 u_current;     // m/s
uniform float u_seed;
uniform float u_minPx;      // minimum radius in px
uniform float u_ppm;
out vec2 v_q;
out float v_y;
flat out float v_bright;
float h(float n) { return fract(sin(n * 12.9898 + u_seed * 78.233) * 43758.5453); }
void main() {
  float id = float(gl_InstanceID);
  float tileIdx = floor(id / u_perTile);
  float k = id - tileIdx * u_perTile;
  vec2 t = u_origin + vec2(mod(tileIdx, u_tiles.x), floor(tileIdx / u_tiles.x));
  float s = t.x * 131.0 + t.y * 977.0 + k * 7.31;
  float fall = mix(0.006, 0.02, h(s + 3.0));
  vec2 drift = vec2(u_current.x * mix(0.8, 1.2, h(s + 4.0)), fall + u_current.y) * u_time;
  vec2 wob = vec2(sin(u_time * 0.21 + s), cos(u_time * 0.17 + s * 1.3)) * 0.02 * u_tile;
  vec2 local = fract(vec2(h(s), h(s + 1.0)) + drift / u_tile) * u_tile;
  vec2 w = t * u_tile + local + wob + u_camShift;
  float rW = u_tile * u_sizeTile * mix(0.5, 1.6, h(s + 2.0));
  float rPx = max(rW * u_ppm, u_minPx);
  float r = rPx / u_ppm;
  vec2 q = a_corner * 2.0 - 1.0;
  vec2 p = w + q * r;
  vec2 ndc = (p - u_view.xy) / (u_view.zw - u_view.xy) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  v_q = q; v_y = w.y;
  v_bright = mix(0.25, 1.0, h(s + 5.0) * h(s + 6.0) * 1.6) * min(1.0, rW * u_ppm / max(rPx, 1e-6) + 0.35);
}`;

export const SNOW_FS = `#version 300 es
precision highp float;
in vec2 v_q;
in float v_y;
flat in float v_bright;
uniform float u_gain;
uniform float u_over;   // near layer: soft out-of-focus discs over the water
${WATER}
layout(location = 0) out vec4 o_body;
layout(location = 1) out vec4 o_emit;
layout(location = 2) out vec4 o_trail;
void main() {
  float d2 = dot(v_q, v_q);
  if (d2 > 1.0) discard;
  // snow is lit by what little light reaches it, plus a faint glow from the living tank
  vec3 lightC = depthLight(v_y) * 0.8 + vec3(0.010, 0.016, 0.024);
  if (u_over > 0.5) {
    float g = smoothstep(1.0, 0.6, sqrt(d2)) * (0.75 + 0.25 * smoothstep(0.6, 0.95, sqrt(d2)));
    float a = g * 0.06 * v_bright * u_gain;
    o_body = vec4(lightC * 1.2 * a, a);
    o_emit = vec4(0.0);
  } else {
    float g = exp(-d2 * 3.5);
    o_body = vec4(0.0);
    o_emit = vec4(lightC * g * v_bright * u_gain, 0.0);
  }
  o_trail = vec4(0.0);
}`;

/** Pass 9: trails, ping-pong with camera reprojection and advection by the water current. */
export const TRAIL_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_prev;
uniform sampler2D u_fresh;
uniform vec4 u_view;
uniform vec4 u_prevView;
uniform float u_dt;
uniform float u_decay;
uniform float u_time;
uniform vec2 u_current;
out vec4 o;
vec2 currentAt(vec2 w) {
  return u_current * (1.0 + 0.35 * sin(w.y * 0.7 + u_time * 0.05)) + vec2(0.0, 0.3 * length(u_current) * sin(w.x * 0.4 + u_time * 0.03));
}
void main() {
  vec2 w = vec2(mix(u_view.x, u_view.z, v_uv.x), mix(u_view.w, u_view.y, v_uv.y));
  vec2 wp = w - currentAt(w) * u_dt;
  vec2 pu = vec2((wp.x - u_prevView.x) / (u_prevView.z - u_prevView.x), (u_prevView.w - wp.y) / (u_prevView.w - u_prevView.y));
  vec3 prev = texture(u_prev, pu).rgb;
  if (any(lessThan(pu, vec2(0.0))) || any(greaterThan(pu, vec2(1.0)))) prev = vec3(0.0);
  vec3 fresh = texture(u_fresh, v_uv).rgb;
  o = vec4(prev * u_decay + fresh * (1.0 - u_decay), 1.0);
}`;

/** Pass 10: dual-filter bloom (Kawase-style down and up chain), soft-knee prefilter. */
export const BLOOM_PRE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_emit;
uniform sampler2D u_trail;
uniform vec2 u_texel;     // of the emit target
uniform float u_knee;
uniform float u_threshold;
uniform float u_trailGain;
out vec4 o;
void main() {
  vec3 c = texture(u_emit, v_uv + u_texel * vec2(-0.5, -0.5)).rgb + texture(u_emit, v_uv + u_texel * vec2(0.5, -0.5)).rgb
         + texture(u_emit, v_uv + u_texel * vec2(-0.5, 0.5)).rgb + texture(u_emit, v_uv + u_texel * vec2(0.5, 0.5)).rgb;
  c = c * 0.25 + texture(u_trail, v_uv).rgb * u_trailGain;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - u_threshold + u_knee, 0.0, 2.0 * u_knee);
  soft = soft * soft / (4.0 * u_knee + 1e-5);
  float contrib = max(soft, br - u_threshold) / max(br, 1e-5);
  o = vec4(c * contrib, 1.0);
}`;

export const BLOOM_DOWN_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_texel; // of the source
out vec4 o;
void main() {
  vec3 s = texture(u_src, v_uv).rgb * 4.0;
  s += texture(u_src, v_uv - u_texel).rgb;
  s += texture(u_src, v_uv + u_texel).rgb;
  s += texture(u_src, v_uv + vec2(u_texel.x, -u_texel.y)).rgb;
  s += texture(u_src, v_uv - vec2(u_texel.x, -u_texel.y)).rgb;
  o = vec4(s / 8.0, 1.0);
}`;

export const BLOOM_UP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;   // the lower (smaller) level
uniform sampler2D u_add;   // this level's down result
uniform vec2 u_texel;      // of the source
out vec4 o;
void main() {
  vec2 h = u_texel;
  vec3 s = texture(u_src, v_uv + vec2(-h.x * 2.0, 0.0)).rgb;
  s += texture(u_src, v_uv + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture(u_src, v_uv + vec2(0.0, h.y * 2.0)).rgb;
  s += texture(u_src, v_uv + vec2(h.x, h.y)).rgb * 2.0;
  s += texture(u_src, v_uv + vec2(h.x * 2.0, 0.0)).rgb;
  s += texture(u_src, v_uv + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture(u_src, v_uv + vec2(0.0, -h.y * 2.0)).rgb;
  s += texture(u_src, v_uv + vec2(-h.x, -h.y)).rgb * 2.0;
  o = vec4(s / 12.0 + texture(u_add, v_uv).rgb, 1.0);
}`;

/** Pass 11: composite, safety gain, exposure, filmic tonemap, sRGB and blue-noise dither. */
export const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_bg;
uniform sampler2D u_body;
uniform sampler2D u_emit;
uniform sampler2D u_trail;
uniform sampler2D u_bloom;
uniform sampler2D u_safety;
uniform sampler2D u_blue;
uniform float u_bloomStrength;
uniform float u_trailGain;
uniform float u_exposure;
uniform float u_ditherAmp;
uniform vec2 u_ditherOffset;
uniform float u_blackLift;
out vec4 o;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec3 bg = texture(u_bg, v_uv).rgb;
  vec4 body = texture(u_body, v_uv);
  vec3 hdr = bg * (1.0 - body.a) + body.rgb;
  vec3 em = texture(u_emit, v_uv).rgb + texture(u_trail, v_uv).rgb * u_trailGain + texture(u_bloom, v_uv).rgb * u_bloomStrength;
  em *= texture(u_safety, v_uv).r;
  hdr = (hdr + em) * u_exposure;
  vec3 ldr = toSrgb(aces(hdr));
  ldr = ldr * (1.0 - u_blackLift) + u_blackLift;
  float n = (texelFetch(u_blue, ivec2(mod(gl_FragCoord.xy + u_ditherOffset, 64.0)), 0).r * 255.0 + 0.5) / 256.0 - 0.5;
  ldr += n * u_ditherAmp / 255.0;
  o = vec4(ldr, 1.0);
}`;

/** Safety net input: mean displayed luminance per coarse tile (rendered at the tile grid size). */
export const LUM_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_bg;
uniform sampler2D u_body;
uniform sampler2D u_emit;
uniform sampler2D u_trail;
uniform sampler2D u_bloom;
uniform float u_bloomStrength;
uniform float u_trailGain;
uniform float u_exposure;
uniform vec2 u_tileUv;
out vec4 o;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  float lumDisp = 0.0, lumScene = 0.0, lumEmit = 0.0;
  for (int j = 0; j < 3; j++) for (int i = 0; i < 3; i++) {
    vec2 uv = v_uv + (vec2(float(i), float(j)) - 1.0) * u_tileUv / 3.0;
    vec4 body = texture(u_body, uv);
    vec3 em = texture(u_emit, uv).rgb + texture(u_trail, uv).rgb * u_trailGain + texture(u_bloom, uv).rgb * u_bloomStrength;
    vec3 hdr = texture(u_bg, uv).rgb * (1.0 - body.a) + body.rgb + em;
    lumScene += dot(hdr, vec3(0.2126, 0.7152, 0.0722));
    lumDisp += dot(aces(hdr * u_exposure), vec3(0.2126, 0.7152, 0.0722));
    lumEmit += dot(em, vec3(0.2126, 0.7152, 0.0722));
  }
  o = vec4(lumDisp / 9.0, lumScene / 9.0, lumEmit / 9.0, 1.0);
}`;
