/**
 * Visual test page (web/render-test.html): synthetic creatures of every archetype, streamed to
 * the real renderer through the real protocol codecs (BODY_ENTER, BODY_FRAME, ENV), rendered
 * with a fixed time step so a scene at a given time is reproducible pixel for pixel.
 *
 * Exposes on window:
 *   renderScene(name, { mode, t, w, h }) -> stats   renders the scene at time t (s)
 *   recordLuma(name, { mode, seconds, fps }) -> per-frame luminance of 9 screen regions
 *   SCENES: the scene names
 */
import { encodeBodyEnter, encodeBodyFrame, encodeEnv, type BodyEnter, type BodyRecord, type Camera, type ViewMode } from '../core/index.js';
import { ARCHETYPE_LENGTH_M, ARCHETYPES, archetypeTemplate, createRenderer, LumaLimiter, type WebGL2Renderer } from './index.js';

interface Actor {
  arch: number;          // index into ARCHETYPES, 8 = red-lure Hushmaw
  x: number; y: number;  // start, m
  lenM: number;
  heading: number;
  speed: number;         // body lengths per second
  glow: number;          // 0..255
  wander: number;        // turn amplitude, rad
  phase0: number;
  flags?: number;
}

interface Scene { cam: Camera; tank: [number, number]; actors: Actor[]; sun: number; rect?: [number, number, number, number] }

/** Deterministic hash in [0, 1). */
function h01(n: number): number {
  let x = Math.imul(n ^ 0x27d4eb2d, 0x165667b1);
  x ^= x >>> 15; x = Math.imul(x, 0x85ebca77); x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

function lineup(y: number, zeta: number): Scene {
  const actors: Actor[] = [];
  const order = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const cellW = 0.16, cellH = 0.09;
  order.forEach((a, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    actors.push({
      arch: a, x: 32 + (col - 1) * cellW, y: y + (row - 1) * cellH, lenM: a === 2 ? 0.075 : 0.1,
      heading: a === 2 ? -Math.PI / 2 : i % 2 ? Math.PI : 0, speed: 0, glow: 230, wander: 0, phase0: i * 0.9,
    });
  });
  return { cam: { cx: 32, cy: y, zeta }, tank: [64, 36], actors, sun: 0.9 };
}

/** A populated Default tank: every archetype at a realistic size in its depth zone. */
function tank(): Actor[] {
  const actors: Actor[] = [];
  const zones: Record<string, [number, number]> = {
    meadowlamp: [0.5, 8], hushmaw: [7, 20], sievebell: [2, 22], tetherling: [5, 30], ashpicker: [20, 34], deepcrown: [14, 33], motefly: [0.5, 30], blank: [3, 15],
  };
  const counts = [70, 14, 30, 40, 26, 6, 160, 10];
  let n = 0;
  ARCHETYPES.forEach((a, ai) => {
    for (let i = 0; i < counts[ai]!; i++, n++) {
      const [y0, y1] = zones[a]!;
      const school = ai === 0 || ai === 6 ? Math.floor(i / 10) : i;
      const sx = h01(school * 7 + ai * 101) * 60 + 2, sy = y0 + h01(school * 13 + ai * 37) * (y1 - y0);
      const jitter = ai === 0 || ai === 6 ? 0.6 : 0;
      actors.push({
        arch: ai === 1 && i === 0 ? 8 : ai,
        x: sx + (h01(n * 3 + 1) - 0.5) * jitter * 2, y: sy + (h01(n * 3 + 2) - 0.5) * jitter,
        lenM: ARCHETYPE_LENGTH_M[a] * (0.6 + 0.8 * h01(n * 5 + 3)),
        heading: (ai === 2 ? -Math.PI / 2 : 0) + (h01(n * 11) < 0.5 ? 0 : Math.PI) + (h01(n * 17) - 0.5) * 0.6,
        speed: ai === 2 ? 0.15 : 0.4 + 0.5 * h01(n * 19), glow: 120 + Math.floor(135 * h01(n * 23)), wander: 0.25, phase0: h01(n * 29) * 6.28,
      });
    }
  });
  // a dense swarm of motes around the micro camera
  for (let i = 0; i < 40; i++, n++) {
    actors.push({ arch: 6, x: 20 + (h01(n) - 0.5) * 0.12, y: 12 + (h01(n + 1) - 0.5) * 0.07, lenM: 0.0012 + 0.0008 * h01(n + 2), heading: h01(n + 3) * 6.28, speed: 1.5, glow: 200, wander: 0.6, phase0: h01(n + 4) * 6.28 });
  }
  // a Deepcrown and a cluster near the close camera
  actors.push({ arch: 5, x: 31, y: 18.3, lenM: 0.32, heading: 0.05, speed: 0.15, glow: 255, wander: 0.05, phase0: 0 });
  actors.push({ arch: 3, x: 31.15, y: 18.28, lenM: 0.008, heading: 0.1, speed: 0.15 * 0.32 / 0.008, glow: 80, wander: 0.02, phase0: 1 });
  actors.push({ arch: 1, x: 30.2, y: 17.7, lenM: 0.14, heading: 0.1, speed: 0.05, glow: 255, wander: 0.1, phase0: 2 });
  for (let i = 0; i < 9; i++, n++) actors.push({ arch: 4, x: 30 + h01(n) * 2.4, y: 18.7 + h01(n + 1) * 0.6, lenM: 0.07 + 0.04 * h01(n + 2), heading: h01(n + 3) < 0.5 ? 0 : Math.PI, speed: 0.5, glow: 200, wander: 0.2, phase0: h01(n + 4) * 6 });
  for (let i = 0; i < 5; i++, n++) actors.push({ arch: 2, x: 29.5 + h01(n) * 3, y: 17.3 + h01(n + 1) * 1.8, lenM: 0.06 + 0.05 * h01(n + 2), heading: -Math.PI / 2 + (h01(n + 3) - 0.5) * 0.5, speed: 0.12, glow: 220, wander: 0.1, phase0: h01(n + 4) * 6 });
  // near the surface: a Meadowlamp school
  for (let i = 0; i < 24; i++, n++) actors.push({ arch: 0, x: 8 + h01(n) * 2.2, y: 1.2 + h01(n + 1) * 1.0, lenM: 0.05 + 0.03 * h01(n + 2), heading: 0.1 + (h01(n + 3) - 0.5) * 0.3, speed: 0.8, glow: 200, wander: 0.15, phase0: h01(n + 4) * 6 });
  return actors;
}

const TANK_ACTORS = tank();
const SCENES: Record<string, () => Scene> = {
  'lineup-shallow': () => lineup(1.6, Math.log2(2600)),
  'lineup-deep': () => lineup(22, Math.log2(2600)),
  'tank-whole': () => ({ cam: { cx: 32, cy: 18, zeta: Math.log2(1280 / 64) }, tank: [64, 36], actors: TANK_ACTORS, sun: 0.9 }),
  'tank-mid': () => ({ cam: { cx: 30, cy: 17, zeta: Math.log2(1280 / 12) }, tank: [64, 36], actors: TANK_ACTORS, sun: 0.9 }),
  'tank-close': () => ({ cam: { cx: 31, cy: 18.2, zeta: Math.log2(1280 / 2.6) }, tank: [64, 36], actors: TANK_ACTORS, sun: 0.9 }),
  'tank-micro': () => ({ cam: { cx: 20.03, cy: 12, zeta: Math.log2(1280 / 0.05) }, tank: [64, 36], actors: TANK_ACTORS, sun: 0.9 }),
  'surface': () => ({ cam: { cx: 9, cy: 1.7, zeta: Math.log2(1280 / 4.5) }, tank: [64, 36], actors: TANK_ACTORS, sun: 1 }),
  'night': () => ({ cam: { cx: 9, cy: 1.7, zeta: Math.log2(1280 / 4.5) }, tank: [64, 36], actors: TANK_ACTORS, sun: 0.02 }),
};

const STEP = 1 / 30;
const STREAM_EVERY = 2; // BODY_FRAME at 15 Hz

function actorState(a: Actor, t: number, i: number, tank: [number, number]): { x: number; y: number; h: number; phase: number } {
  const tpl = archetypeTemplate(a.arch === 8 ? 'hushmaw' : ARCHETYPES[a.arch]!, a.arch === 8 ? 'red' : '');
  const wob = a.wander * Math.sin(t * 0.37 + i * 1.7);
  const h = a.heading + wob;
  // integrate along a gently wandering path (closed form for small wander is fine for tests)
  const v = a.speed * a.lenM;
  let x = a.x + v * t * Math.cos(a.heading) - (a.wander * v / 0.37) * Math.sin(a.heading) * (Math.cos(i * 1.7) - Math.cos(t * 0.37 + i * 1.7)) * 0.3;
  let y = a.y + v * t * Math.sin(a.heading) + (a.wander * v / 0.37) * Math.cos(a.heading) * (Math.cos(i * 1.7) - Math.cos(t * 0.37 + i * 1.7)) * 0.3;
  x += 0.012 * t * (a.speed > 0 ? 1 : 0); // the water carries everyone that swims with it (the renderer's default current)
  x = ((x % tank[0]) + tank[0]) % tank[0];
  y = Math.min(tank[1] - 0.5, Math.max(0.2, y));
  const hz = tpl.strokeHz * Math.min(2, 0.5 + a.speed);
  return { x, y, h, phase: a.phase0 + 2 * Math.PI * hz * t };
}

interface Ctx { canvas: HTMLCanvasElement; r: WebGL2Renderer; mode: ViewMode }
let ctx: Ctx | null = null;

function setup(mode: ViewMode, w: number, h: number, software = false): Ctx {
  if (ctx) ctx.canvas.remove();
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.style.cssText = `display:block;width:${w}px;height:${h}px`;
  document.body.appendChild(canvas);
  const r = createRenderer(canvas, mode);
  r.options.syncReadback = true;
  r.options.software = software; // review the full-quality look even on SwiftShader
  r.applyOptions();
  r.resize(w, h, 1);
  r.setTemplateSource((key) => {
    const k = Number(key);
    return k === 8 ? archetypeTemplate('hushmaw', 'red') : archetypeTemplate(ARCHETYPES[k % ARCHETYPES.length]!);
  });
  ctx = { canvas, r, mode };
  return ctx;
}

function streamFrame(r: WebGL2Renderer, sc: Scene, t: number, tick: number, rect: [number, number, number, number], visible: number[], noisyGlow = false): void {
  const n = sc.actors.length;
  const present = new Uint8Array(Math.ceil(n / 8));
  const records: BodyRecord[] = [];
  for (const i of visible) present[i >> 3]! |= 1 << (i & 7);
  for (let i = 0; i < n; i++) {
    if (!(present[i >> 3]! & (1 << (i & 7)))) continue;
    const a = sc.actors[i]!;
    const s = actorState(a, t, i, sc.tank);
    const q = (v: number, lo: number, hi: number): number => Math.max(0, Math.min(65535, Math.round(((v - lo) / (hi - lo)) * 65535)));
    records.push({
      x: q(s.x, rect[0], rect[2]), y: q(s.y, rect[1], rect[3]),
      heading: Math.round((((s.h % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * 256) & 255,
      speed: 128, phase: Math.round((((s.phase % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * 256) & 255,
      bend: Math.round(40 * Math.sin(t * 0.37 + i * 1.7) * a.wander), glow: noisyGlow ? (h01(tick * 7919 + i * 104729) < 0.5 ? 20 : 255) : a.glow, flags: a.flags ?? 0,
    });
  }
  r.ingest(encodeBodyFrame({ tick, rect, nSlots: n, present, records }));
}

/** Render scene `name` at time `t` (seconds), stepping from 0 with a fixed step. */
function renderScene(name: string, opts: { mode?: ViewMode; t?: number; w?: number; h?: number; profile?: boolean; step?: number; warm?: number; software?: boolean } = {}): unknown {
  const sc = SCENES[name]!();
  sc.cam = { ...sc.cam, zeta: sc.cam.zeta + Math.log2((opts.w ?? 1280) / 1280) };
  const { r } = setup(opts.mode ?? 'screensaver', opts.w ?? 1280, opts.h ?? 720, !!opts.software);
  r.tank = { w: sc.tank[0], h: sc.tank[1] };
  r.options.profilePasses = !!opts.profile;
  r.ingest(encodeEnv({ tick: 0, dayPhase: 0.5, yearPhase: 0, surfaceLight: sc.sun, surfaceTempC: 15, turbidity: 0.1, ySurface: 0, modes: [] }));
  const enter: BodyEnter[] = sc.actors.map((a, i) => ({
    slot: i, id: 1000 + i, genomeKey: BigInt(a.arch), species: a.arch, log2Length: Math.log2(a.lenM), maturity: 255, energy: 220, lod: 0, flags: 0,
  }));
  for (let i = 0; i < enter.length; i += 1000) r.ingest(encodeBodyEnter(0, enter.slice(i, i + 1000)));
  // stream only what is near the camera, like the host's ROI
  const vw = (opts.w ?? 1280) / 2 ** sc.cam.zeta, vh = (opts.h ?? 720) / 2 ** sc.cam.zeta;
  const rect: [number, number, number, number] = [sc.cam.cx - vw * 1.5, sc.cam.cy - vh * 1.5, sc.cam.cx + vw * 1.5, sc.cam.cy + vh * 1.5];
  const tEnd = opts.t ?? 3;
  const step = opts.step ?? 1 / 15;
  // actors move in closed form, so only the last `warm` seconds need rendering (trails, slews, fades)
  const warm = Math.min(tEnd, opts.warm ?? 1.2);
  const k0 = Math.round((tEnd - warm) / step), k1 = Math.round(tEnd / step);
  const every = Math.max(1, Math.round((STREAM_EVERY * STEP) / step));
  for (let k = k0; k <= k1; k++) {
    const t = k * step;
    if ((k - k0) % every === 0) {
      const vis: number[] = [];
      sc.actors.forEach((a, i) => {
        const s = actorState(a, t, i, sc.tank);
        if (s.x >= rect[0] && s.x <= rect[2] && s.y >= rect[1] && s.y <= rect[3]) vis.push(i);
      });
      streamFrame(r, sc, t, k, rect, vis);
    }
    r.render(t * 1000 + 1000, sc.cam);
  }
  return { ...r.stats, tiers: [...r.stats.tiers], settings: r.settings, passMs: r.passMs };
}

/** Render `seconds` of a scene and return the mean sRGB luminance of a 3 x 3 grid of regions per frame. */
function recordLuma(name: string, opts: { mode?: ViewMode; seconds?: number; w?: number; h?: number; step?: number } = {}): { fps: number; regions: number[][] } {
  const w = opts.w ?? 320, h = opts.h ?? 180;
  const sc = SCENES[name]!();
  const { r, canvas } = setup(opts.mode ?? 'wallpaper', w, h);
  r.tank = { w: sc.tank[0], h: sc.tank[1] };
  const cam = { ...sc.cam, zeta: sc.cam.zeta + Math.log2(w / 1280) };
  r.ingest(encodeEnv({ tick: 0, dayPhase: 0.5, yearPhase: 0, surfaceLight: sc.sun, surfaceTempC: 15, turbidity: 0.1, ySurface: 0, modes: [] }));
  r.ingest(encodeBodyEnter(0, sc.actors.map((a, i) => ({ slot: i, id: 1000 + i, genomeKey: BigInt(a.arch), species: a.arch, log2Length: Math.log2(a.lenM), maturity: 255, energy: 220, lod: 0, flags: 0 }))));
  const vw = w / 2 ** cam.zeta, vh = h / 2 ** cam.zeta;
  const rect: [number, number, number, number] = [cam.cx - vw * 1.5, cam.cy - vh * 1.5, cam.cx + vw * 1.5, cam.cy + vh * 1.5];
  const gl = canvas.getContext('webgl2')!;
  const px = new Uint8Array(w * h * 4);
  const regions: number[][] = Array.from({ length: 9 }, () => []);
  const steps = Math.round((opts.seconds ?? 10) / STEP);
  const lin = (v: number): number => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lut = new Float32Array(256).map((_, i) => lin(i));
  for (let k = 0; k <= steps; k++) {
    const t = k * STEP;
    if (k % STREAM_EVERY === 0) {
      const vis: number[] = [];
      sc.actors.forEach((a, i) => { const s = actorState(a, t, i, sc.tank); if (s.x >= rect[0] && s.x <= rect[2] && s.y >= rect[1] && s.y <= rect[3]) vis.push(i); });
      streamFrame(r, sc, t, k, rect, vis);
    }
    r.render(t * 1000 + 1000, cam);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const sums = new Float64Array(9), cnt = new Float64Array(9);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const reg = Math.min(2, Math.floor((3 * x) / w)) + 3 * Math.min(2, Math.floor((3 * y) / h));
      sums[reg]! += 0.2126 * lut[px[i]!]! + 0.7152 * lut[px[i + 1]!]! + 0.0722 * lut[px[i + 2]!]!;
      cnt[reg]!++;
    }
    for (let g = 0; g < 9; g++) regions[g]!.push(sums[g]! / cnt[g]!);
  }
  return { fps: 1 / STEP, regions };
}

/**
 * Spike 6 recorder: render `seconds` of a scene at `step` and return, per frame, the mean
 * displayed relative luminance, and once per second a 32 x 18 grid of tile luminance.
 * `noisyGlow` drives every creature's streamed glow with a random on/off brain output (the worst
 * case); `unsafe` removes the profile's slew, pulse and luminance limits for comparison.
 */
function recordCalm(name: string, opts: { mode?: ViewMode; seconds?: number; step?: number; w?: number; h?: number; noisyGlow?: boolean; unsafe?: boolean } = {}): unknown {
  const w = opts.w ?? 192, h = opts.h ?? 108, step = opts.step ?? 1 / 15;
  const sc = SCENES[name]!();
  const { r, canvas } = setup(opts.mode ?? 'wallpaper', w, h);
  if (opts.unsafe) {
    const p = { ...r.profile, emissionSlewS: 0, maxPulseHz: 30, maxRedPulseHz: 30, maxLumaChangePerS: 100 };
    (r as unknown as { profile: unknown }).profile = p;
    (r as unknown as { limiter: unknown }).limiter = new LumaLimiter(100);
  }
  r.tank = { w: sc.tank[0], h: sc.tank[1] };
  const cam = { ...sc.cam, zeta: sc.cam.zeta + Math.log2(w / 1280) };
  r.ingest(encodeEnv({ tick: 0, dayPhase: 0.5, yearPhase: 0, surfaceLight: sc.sun, surfaceTempC: 15, turbidity: 0.1, ySurface: 0, modes: [] }));
  r.ingest(encodeBodyEnter(0, sc.actors.map((a, i) => ({ slot: i, id: 1000 + i, genomeKey: BigInt(a.arch), species: a.arch, log2Length: Math.log2(a.lenM), maturity: 255, energy: 220, lod: 0, flags: 0 }))));
  const vw = w / 2 ** cam.zeta, vh = h / 2 ** cam.zeta;
  const rect: [number, number, number, number] = [cam.cx - vw * 1.5, cam.cy - vh * 1.5, cam.cx + vw * 1.5, cam.cy + vh * 1.5];
  const gl = canvas.getContext('webgl2')!;
  const px = new Uint8Array(w * h * 4);
  const lut = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const mean: number[] = [], grids: number[][] = [];
  const every = Math.max(1, Math.round((STREAM_EVERY * STEP) / step));
  const steps = Math.round((opts.seconds ?? 30) / step);
  const perSec = Math.round(1 / step);
  for (let k = 0; k <= steps; k++) {
    const t = k * step;
    if (k % every === 0) {
      const vis: number[] = [];
      sc.actors.forEach((a, i) => { const s = actorState(a, t, i, sc.tank); if (s.x >= rect[0] && s.x <= rect[2] && s.y >= rect[1] && s.y <= rect[3]) vis.push(i); });
      streamFrame(r, sc, t, k, rect, vis, opts.noisyGlow);
    }
    r.render(t * 1000 + 1000, cam);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0;
    const grid = k % perSec === 0 ? new Float64Array(32 * 18) : null;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const L = 0.2126 * lut[px[i]!]! + 0.7152 * lut[px[i + 1]!]! + 0.0722 * lut[px[i + 2]!]!;
      sum += L;
      if (grid) grid[Math.min(17, Math.floor((y * 18) / h)) * 32 + Math.min(31, Math.floor((x * 32) / w))]! += L / ((w / 32) * (h / 18));
    }
    mean.push(sum / (w * h));
    if (grid) grids.push(Array.from(grid));
  }
  return { step, mean, grids, safetyTriggers: r.stats.safetyTriggers };
}

declare global {
  interface Window { renderScene: typeof renderScene; recordLuma: typeof recordLuma; recordCalm: typeof recordCalm; SCENES: string[]; __renderTestReady: boolean }
}
window.renderScene = renderScene;
window.recordLuma = recordLuma;
window.recordCalm = recordCalm;
window.SCENES = Object.keys(SCENES);
window.__renderTestReady = true;
