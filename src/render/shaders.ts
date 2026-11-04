/** GLSL ES 3.00 shaders for the phase-0 renderer. */

export const BG_VS = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const BG_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec4 u_view;   // world rect x0 y0 x1 y1
uniform vec2 u_tank;   // tank w h (m)
uniform float u_time;
uniform float u_dayRange;
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 w = vec2(mix(u_view.x, u_view.z, v_uv.x), mix(u_view.w, u_view.y, v_uv.y));
  float depth = clamp(w.y / u_tank.y, 0.0, 1.0);
  vec3 surface = vec3(0.004, 0.016, 0.032);
  vec3 deep = vec3(0.0006, 0.0012, 0.0035);
  vec3 c = mix(surface, deep, pow(depth, 0.55));
  // slow, soft light shafts near the surface (calm by construction: periods of minutes)
  float shaft = 0.5 + 0.5 * sin(w.x * 0.35 + 0.9 * sin(w.x * 0.11 + u_time * 0.013) + u_time * 0.021);
  shaft *= exp(-depth * 6.0) * 0.012 * u_dayRange;
  c += vec3(0.25, 0.6, 0.8) * shaft;
  // outside the tank: black
  if (w.x < 0.0 || w.x > u_tank.x || w.y < 0.0 || w.y > u_tank.y) c = vec3(0.0);
  // dither against banding in dark gradients (about 1 LSB)
  c = pow(c, vec3(1.0 / 2.2));
  c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  o = vec4(c, 1.0);
}`;

export const DOT_VS = `#version 300 es
layout(location = 0) in vec2 a_prev;
layout(location = 1) in vec2 a_cur;
layout(location = 2) in uvec2 a_attr; // colour index (255 empty), glow
uniform vec4 u_view;
uniform vec4 u_rect;
uniform float u_t;
uniform float u_time;
uniform float u_pxPerM;
uniform float u_dpr;
uniform float u_maxPulseHz;
uniform vec3 u_palette[16];
out vec3 v_col;
float h1(float n) { return fract(sin(n * 91.3458) * 47453.5453); }
void main() {
  if (a_attr.x == 255u) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); gl_PointSize = 0.0; v_col = vec3(0.0); return; }
  vec2 rel = mix(a_prev, a_cur, u_t);
  vec2 w = u_rect.xy + rel * (u_rect.zw - u_rect.xy);
  vec2 ndc = (w - u_view.xy) / (u_view.zw - u_view.xy) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  float glow = float(a_attr.y) / 255.0;
  float id = float(gl_VertexID);
  // a slow breathing pulse, always well under the profile's maximum frequency
  float f = mix(0.03, 0.35, h1(id)) * min(1.0, u_maxPulseHz);
  float pulse = 0.72 + 0.28 * sin(6.2831853 * f * u_time + 6.2831853 * h1(id + 7.0));
  float depthDim = 1.0;
  v_col = u_palette[a_attr.x & 15u] * glow * pulse * depthDim;
  gl_PointSize = clamp((3.0 + 9.0 * glow) * u_dpr * clamp(u_pxPerM / 40.0, 0.6, 3.0), 1.0, 64.0);
}`;

export const DOT_FS = `#version 300 es
precision highp float;
in vec3 v_col;
out vec4 o;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(p, p);
  if (d2 > 1.0) discard;
  float core = exp(-d2 * 9.0);
  float halo = exp(-d2 * 3.0) * 0.3;
  o = vec4(v_col * 1.5 * (core + halo), 1.0);
}`;
