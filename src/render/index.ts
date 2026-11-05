/**
 * src/render: the one renderer for every view (CONTRACT 15). WebGL2 now, WebGPU later behind
 * the same RendererModule interface. See README.md and docs/modules/render.md.
 *
 * Frame graph (06 §6.1.2): water background at half resolution; marine snow; per-creature SDF
 * bodies into separate premultiplied albedo ("body") and additive HDR glow ("emit") buffers
 * plus a trail source; light organs, specks and dust as additive gaussians; trails in a
 * reprojected ping-pong buffer that drifts with the current; dual-filter bloom; a coarse
 * luminance grid for the flash safety net; composite with exposure, filmic tonemap, sRGB and
 * blue-noise dither.
 */
import {
  decodeBodyEnter, decodeBodyFrame, decodeCborFrame, decodeDust, decodeEnv, FRAME, HEADER_BYTES, readHeader, VIEW_PROFILES,
  type BodyEnter, type Camera, type DustFrame, type RendererModule, type ViewMode, type ViewProfile,
} from '../core/index.js';
import { ARCHETYPES, archetypeTemplate } from './archetypes.js';
import { blueNoise64 } from './bluenoise.js';
import { isSaturatedRed, oklchToLinear, type RGB } from './colour.js';
import { Fbo, makeTexture, Program, type Target } from './gl.js';
import { classify, FADE_S, TIER, TIER_CAPS, type LodCandidate, type Tier, type TierCaps } from './lod.js';
import { CAP_FLOATS, CAPS_PER_ROW, capsuleBounds, PoseScratch, poseNodes, writeCapsules } from './pose.js';
import { BASELINE_GLOW, FlashGuard, LumaLimiter, organIntensity, stepEmission, type EmissionState } from './safety.js';
import {
  BG_FS, BLOOM_DOWN_FS, CAUSTIC_FS, BLOOM_PRE_FS, BLOOM_UP_FS, BODY_FS, BODY_VS, COMPOSITE_FS, FULLSCREEN_VS, LUM_FS, SNOW_FS, SNOW_VS,
  SPRITE_FS, SPRITE_VS, TRAIL_FS,
} from './shaders.js';
import type { Capsule, RenderTemplate } from './template.js';

export { ARCHETYPES, archetypeTemplate, ARCHETYPE_LENGTH_M, type Archetype } from './archetypes.js';
export { buildTemplate, templateFromPhenotype, type RenderTemplate } from './template.js';
export * from './safety.js';
export * from './lod.js';
export * from './colour.js';

export interface TankInfo { w: number; h: number }

/** BODY_FRAME / BODY_ENTER flag bits (05 §5.3 record table). Proposed for core in docs/contract-requests/render.md. */
export const BODY_FLAG = { EATING: 1, MATING: 2, HURT: 4, DISEASED: 8, DYING: 16, BUDDING: 32, PARASITE: 64, SELECTED: 128 } as const;

/** Per-mode render settings (06 §6.1.9 and the cast sub-profile of §6.1.6). */
export interface RenderSettings {
  renderScale: number; bloomLevels: number; bloomStrength: number; trailTau: number; trailGain: number; snow: number;
  caps: TierCaps; ditherAmp: number; staticDither: boolean; blackLift: number; minSpeckPx: number; hazeMax: number;
  emissionGain: number;
}
export function settingsFor(mode: ViewMode, outW: number, outH: number, opts: { cast?: boolean; tvLocal?: boolean; software?: boolean } = {}): RenderSettings {
  const s = settingsForMode(mode, outW, outH, opts);
  // a software rasteriser (SwiftShader, llvmpipe) is the weakest machine there is: lowest tier
  if (opts.software) { s.renderScale = Math.min(s.renderScale, 0.3); s.bloomLevels = Math.min(s.bloomLevels, 2); s.snow *= 0.25; }
  return s;
}
function settingsForMode(mode: ViewMode, outW: number, outH: number, opts: { cast?: boolean; tvLocal?: boolean }): RenderSettings {
  const big = Math.max(outW, outH);
  const base: RenderSettings = {
    renderScale: 1, bloomLevels: 6, bloomStrength: 0.9, trailTau: 0.9, trailGain: 0.55, snow: 1, caps: TIER_CAPS.screensaver,
    ditherAmp: 1.2, staticDither: false, blackLift: 0, minSpeckPx: 1.0, hazeMax: 0.15, emissionGain: 1,
  };
  switch (mode) {
    case 'wallpaper':
      return { ...base, renderScale: big >= 3800 ? 0.5 : big >= 2500 ? 0.75 : 1, bloomLevels: 4, bloomStrength: 0.75, trailTau: 0.6, snow: 0.5, caps: TIER_CAPS.wallpaper, emissionGain: 0.85 };
    case 'tv': {
      const s: RenderSettings = { ...base, renderScale: big > 2000 ? 0.75 : 1, bloomLevels: 5, trailTau: 1.2, snow: 0.5, caps: opts.tvLocal ? TIER_CAPS.tvLocal : TIER_CAPS.tv };
      if (opts.tvLocal) { s.renderScale = 0.75; s.bloomLevels = 3; s.snow = 0.25; }
      if (opts.cast) { s.staticDither = true; s.minSpeckPx = 2; s.snow *= 0.5; s.blackLift = 2 / 255; s.trailTau *= 1.2; }
      return s;
    }
    case 'god':
      return { ...base, trailTau: 0.8, caps: TIER_CAPS.god };
    default:
      return base;
  }
}

/** Template source: genome key plus species to a render template, or null while it is not ready. */
export type TemplateSource = (genomeKey: bigint, species: number) => RenderTemplate | null;
const defaultTemplates: TemplateSource = (_k, species) => archetypeTemplate(ARCHETYPES[((species % ARCHETYPES.length) + ARCHETYPES.length) % ARCHETYPES.length]!);

interface BodyState {
  slot: number; id: number; key: bigint; species: number; lenM: number; energy: number; flags: number;
  tpl: RenderTemplate | null;
  px: number; py: number; ph: number; pPhase: number; pBend: number;
  cx: number; cy: number; ch: number; cPhase: number; cBend: number; glowT: number;
  prevAt: number; curAt: number; have: number;
  level: number; em: EmissionState; zl: number; seed: number;
  tier: Tier | -1; oldTier: Tier | -1; fadeAt: number; deadAt: number;
  joints: Float32Array | null;
}

const DEFAULT_PALETTE = new Uint8Array([
  90, 230, 255, 60, 255, 200, 120, 160, 255, 190, 120, 255, 255, 120, 220, 140, 255, 120, 255, 200, 110, 100, 200, 255,
]);

const hashId = (id: number): number => {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};
const wrapPi = (a: number): number => { a = (a + Math.PI) % (2 * Math.PI); return (a < 0 ? a + 2 * Math.PI : a) - Math.PI; };

const LUM_W = 64, LUM_H = 36;
const INST_FLOATS = 32;
const SPRITE_FLOATS = 8;
const DENS_W = 256, DENS_H = 144;

interface OrganColour { col: RGB; red: boolean }

export class WebGL2Renderer implements RendererModule {
  readonly ok: boolean;
  readonly profile: ViewProfile;
  settings: RenderSettings;
  tank: TankInfo = { w: 32, h: 18 };
  /** Counters for tests and diagnostics. */
  readonly stats = {
    framesIn: 0, dustFrames: 0, bodyFrames: 0, rendered: 0, skipped: 0, live: 0, bodies: 0,
    tiers: [0, 0, 0, 0, 0], instances: 0, capsules: 0, sprites: 0, exposure: 1, meanLum: 0, safetyTriggers: 0, error: '',
  };
  /** Options for deterministic tests: synchronous luminance readback and a fixed dither phase. */
  options = { syncReadback: false, cast: false, tvLocal: false, profilePasses: false, software: false };
  /** True when the context is a software rasteriser; `options.software` follows it unless a test overrides it. */
  software = false;
  /** Per-pass wall times in ms when `options.profilePasses` is set (each pass is followed by gl.finish). */
  passMs: Record<string, number> = {};
  private mark(name: string, t0: number): number {
    if (!this.options.profilePasses) return 0;
    const gl = this.gl!;
    const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbLum!.fb);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, new Float32Array(4));
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const t = performance.now();
    this.passMs[name] = (this.passMs[name] ?? 0) + t - t0;
    return t;
  }

  private gl: WebGL2RenderingContext | null = null;
  private progs: Record<string, Program> = {};
  private quad: WebGLBuffer | null = null;
  private bodyVao: WebGLVertexArrayObject | null = null;
  private spriteVao: WebGLVertexArrayObject | null = null;
  private snowVao: WebGLVertexArrayObject | null = null;
  private emptyVao: WebGLVertexArrayObject | null = null;
  private instBuf: WebGLBuffer | null = null;
  private spriteBuf: WebGLBuffer | null = null;
  private capTex: WebGLTexture | null = null;
  private capTexH = 0;
  private nbTex: WebGLTexture | null = null;
  private nbTexH = 0;
  private blueTex: WebGLTexture | null = null;
  private densTex: WebGLTexture | null = null;
  private glowTex: WebGLTexture | null = null;
  private glowRect: [number, number, number, number] = [0, 0, 0, 0];
  private safetyTex: WebGLTexture | null = null;
  private causticTex: WebGLTexture | null = null;
  private lumPbo: WebGLBuffer | null = null;
  private lumFence: WebGLSync | null = null;
  private lumData = new Float32Array(LUM_W * LUM_H * 4);
  private lumDisp = new Float32Array(LUM_W * LUM_H);
  private safetyBytes = new Uint8Array(LUM_W * LUM_H);
  private size = { outW: 1, outH: 1, rw: 0, rh: 0 };
  private fbScene: Fbo | null = null;
  private fbBg: Fbo | null = null;
  private fbTrail: [Fbo, Fbo] | null = null;
  private trailIdx = 0;
  private fbDown: Fbo[] = [];
  private fbUp: Fbo[] = [];
  private fbLum: Fbo | null = null;
  private fbOut: Fbo | null = null;
  private hdrFormat = 0;

  // stream state
  private bodies = new Map<number, BodyState>();
  private bodyInterval = 1 / 15;
  private lastBodyAt = -1;
  private templates: TemplateSource = defaultTemplates;
  private nDust = 0;
  private dustPrev = new Uint16Array(0);
  private dustCur = new Uint16Array(0);
  private dustAttr = new Uint8Array(0);
  private dustRect: [number, number, number, number] = [0, 0, 32, 18];
  private dustAt = -1;
  private dustInterval = 1 / 15;
  private palette = new Float32Array(16 * 3);
  private sun = 0.85;
  private turbidity = 0;
  private current: [number, number] = [0.012, 0];

  // frame state
  private t0 = -1;
  private clock = 0;
  private lastRender = -1;
  private lastCall = -1;
  private accum = 0;
  private prevView: number[] | null = null;
  private prevZeta = 0;
  private frameNo = 0;
  private lod = new Map<number, Tier>();
  private limiter: LumaLimiter;
  private guard = new FlashGuard(LUM_W, LUM_H);
  private lastLumT = -1;
  private scratch = new PoseScratch();
  private caps = new Float32Array(CAP_FLOATS * 1024);
  private nb = new Float32Array(2048);
  private inst = new Float32Array(INST_FLOATS * 256);
  private sprites = new Float32Array(SPRITE_FLOATS * 4096);
  private dens = new Float32Array(DENS_W * DENS_H * 4);
  private densDirty = true;
  private organCols = new WeakMap<RenderTemplate, OrganColour[]>();

  constructor(private readonly canvas: HTMLCanvasElement, mode: ViewMode) {
    this.profile = VIEW_PROFILES[mode];
    this.settings = settingsFor(mode, canvas.width, canvas.height, this.options);
    this.limiter = new LumaLimiter(this.profile.maxLumaChangePerS);
    this.setPalette(DEFAULT_PALETTE);
    let ok = false;
    try {
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
      if (gl) { this.gl = gl; this.init(gl); ok = true; }
    } catch (e) {
      this.stats.error = String(e);
      console.error('WebGL2 renderer failed to start', e);
    }
    this.ok = ok;
    this.settings = settingsFor(mode, canvas.width, canvas.height, this.options);
  }

  /** Replace the template source (the genome-backed source arrives with `genome.develop`). */
  setTemplateSource(src: TemplateSource): void { this.templates = src; for (const b of this.bodies.values()) b.tpl = null; }

  private init(gl: WebGL2RenderingContext): void {
    const floatOk = !!gl.getExtension('EXT_color_buffer_float');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const rname = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    this.software = /swiftshader|llvmpipe|software/i.test(rname);
    this.options.software = this.software;
    gl.getExtension('EXT_float_blend');
    this.hdrFormat = floatOk ? gl.RGBA16F : gl.RGBA8;
    const P = (name: string, vs: string, fs: string): void => { this.progs[name] = new Program(gl, vs, fs, name); };
    P('bg', FULLSCREEN_VS, BG_FS);
    P('body', BODY_VS, BODY_FS);
    P('sprite', SPRITE_VS, SPRITE_FS);
    P('snow', SNOW_VS, SNOW_FS);
    P('trail', FULLSCREEN_VS, TRAIL_FS);
    P('bloomPre', FULLSCREEN_VS, BLOOM_PRE_FS);
    P('bloomDown', FULLSCREEN_VS, BLOOM_DOWN_FS);
    P('bloomUp', FULLSCREEN_VS, BLOOM_UP_FS);
    P('composite', FULLSCREEN_VS, COMPOSITE_FS);
    P('lum', FULLSCREEN_VS, LUM_FS);

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.instBuf = gl.createBuffer();
    this.spriteBuf = gl.createBuffer();
    const corner = (): void => {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    };
    this.bodyVao = gl.createVertexArray();
    gl.bindVertexArray(this.bodyVao);
    corner();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    for (let i = 0; i < 8; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, INST_FLOATS * 4, i * 16);
      gl.vertexAttribDivisor(1 + i, 1);
    }
    this.spriteVao = gl.createVertexArray();
    gl.bindVertexArray(this.spriteVao);
    corner();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
    for (let i = 0; i < 2; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, SPRITE_FLOATS * 4, i * 16);
      gl.vertexAttribDivisor(1 + i, 1);
    }
    this.snowVao = gl.createVertexArray();
    gl.bindVertexArray(this.snowVao);
    corner();
    this.emptyVao = gl.createVertexArray();
    gl.bindVertexArray(null);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.blueTex = makeTexture(gl, 64, 64, gl.R8, gl.RED, gl.UNSIGNED_BYTE, false, blueNoise64());
    this.densTex = makeTexture(gl, DENS_W, DENS_H, gl.RGBA16F, gl.RGBA, gl.FLOAT, true, this.dens);
    this.glowTex = makeTexture(gl, 1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, true, new Uint8Array(4));
    this.safetyBytes.fill(255);
    this.safetyTex = makeTexture(gl, LUM_W, LUM_H, gl.R8, gl.RED, gl.UNSIGNED_BYTE, true, this.safetyBytes);
    this.lumPbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.lumPbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, LUM_W * LUM_H * 16, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    // the caustic web, rendered once (06 §6.1.6: a precomputed tileable texture)
    const ct = makeTexture(gl, 256, 256, this.hdrFormat, gl.RGBA, this.hdrFormat === gl.RGBA8 ? gl.UNSIGNED_BYTE : gl.HALF_FLOAT, true);
    gl.bindTexture(gl.TEXTURE_2D, ct);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    const cfb = new Fbo(gl, [{ tex: ct, w: 256, h: 256 }]);
    cfb.bind();
    new Program(gl, FULLSCREEN_VS, CAUSTIC_FS, 'caustic').use();
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(cfb.fb);
    this.causticTex = ct;
    const lt = makeTexture(gl, LUM_W, LUM_H, floatOk ? gl.RGBA32F : gl.RGBA8, gl.RGBA, floatOk ? gl.FLOAT : gl.UNSIGNED_BYTE, false);
    this.fbLum = new Fbo(gl, [{ tex: lt, w: LUM_W, h: LUM_H }]);
  }

  setPalette(rgb: Uint8Array): void {
    this.palette.fill(0);
    for (let i = 0; i < Math.min(16 * 3, rgb.length); i++) this.palette[i] = (rgb[i]! / 255) ** 2.2;
  }

  resize(widthPx: number, heightPx: number, dpr = 1): void {
    void dpr;
    const w = Math.max(1, Math.floor(widthPx)), h = Math.max(1, Math.floor(heightPx));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.size.outW = w; this.size.outH = h;
    this.settings = settingsFor(this.profile.mode, w, h, this.options);
  }

  /** Re-derive the settings after changing `options` (cast or local TV). */
  applyOptions(): void { this.settings = settingsFor(this.profile.mode, this.size.outW, this.size.outH, this.options); }

  // ---------------- ingest ----------------
  ingest(frame: Uint8Array): void {
    this.stats.framesIn++;
    if (frame.length < HEADER_BYTES) return;
    const h = readHeader(frame);
    try {
      switch (h.type) {
        case FRAME.DUST_FRAME: this.ingestDust(decodeDust(frame)); break;
        case FRAME.BODY_ENTER: this.ingestEnter(decodeBodyEnter(frame)); break;
        case FRAME.BODY_LEAVE: this.ingestLeave(frame); break;
        case FRAME.BODY_FRAME: this.ingestBodyFrame(frame); break;
        case FRAME.NEAR_POSE: this.ingestNearPose(frame); break;
        case FRAME.GLOW_FIELD: this.ingestGlow(frame); break;
        case FRAME.FIELDS: this.ingestFields(frame); break;
        case FRAME.ENV: {
          const e = decodeEnv(frame);
          const day = Math.max(0, Math.sin(2 * Math.PI * (e.dayPhase - 0.25)));
          const raw = e.surfaceLight > 0 ? Math.min(1, e.surfaceLight) : Math.max(0.02, day);
          // day and night compressed in the renderer to the profile's range (review R18)
          const mid = 0.55;
          this.sun = mid + (raw - mid) * this.profile.dayNightRange;
          this.turbidity = Math.min(1, Math.max(0, e.turbidity));
          break;
        }
        case FRAME.WELCOME: {
          const w = decodeCborFrame(frame).payload as { tank?: TankInfo; palette?: Uint8Array };
          if (w.tank) this.tank = { w: w.tank.w, h: w.tank.h };
          if (w.palette instanceof Uint8Array) this.setPalette(w.palette);
          break;
        }
        default: break;
      }
    } catch (e) {
      this.stats.error = String(e);
    }
  }

  private ingestEnter(list: BodyEnter[]): void {
    for (const e of list) {
      const id = e.id >>> 0;
      this.bodies.set(e.slot, {
        slot: e.slot, id, key: e.genomeKey, species: e.species, lenM: 2 ** e.log2Length, energy: e.energy / 255, flags: e.flags,
        tpl: null, px: 0, py: 0, ph: 0, pPhase: 0, pBend: 0, cx: 0, cy: 0, ch: 0, cPhase: 0, cBend: 0, glowT: 0.5,
        prevAt: 0, curAt: 0, have: 0, level: BASELINE_GLOW, em: { level: BASELINE_GLOW, dir: 0, since: -1e9 }, zl: hashId(id), seed: hashId(id ^ 0x5bd1e995),
        tier: -1, oldTier: -1, fadeAt: -1, deadAt: -1, joints: null,
      });
    }
    this.stats.bodies = this.bodies.size;
  }

  private ingestLeave(frame: Uint8Array): void {
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const n = dv.getUint16(HEADER_BYTES, true);
    for (let i = 0; i < n; i++) {
      const slot = dv.getUint16(HEADER_BYTES + 2 + i * 2, true);
      const b = this.bodies.get(slot);
      if (b) this.lod.delete(b.id);
      this.bodies.delete(slot);
    }
    this.stats.bodies = this.bodies.size;
  }

  private ingestBodyFrame(frame: Uint8Array): void {
    const f = decodeBodyFrame(frame);
    this.stats.bodyFrames++;
    const now = this.clock;
    if (this.lastBodyAt >= 0 && now > this.lastBodyAt) this.bodyInterval = 0.8 * this.bodyInterval + 0.2 * Math.min(0.25, Math.max(1 / 120, now - this.lastBodyAt));
    this.lastBodyAt = now;
    const [x0, y0, x1, y1] = f.rect;
    let k = 0;
    for (let s = 0; s < f.nSlots; s++) {
      if ((f.present[s >> 3]! & (1 << (s & 7))) === 0) continue;
      const r = f.records[k++]!;
      const b = this.bodies.get(s);
      if (!b) continue;
      const x = x0 + (r.x / 65535) * (x1 - x0), y = y0 + (r.y / 65535) * (y1 - y0);
      const hd = (r.heading / 256) * 2 * Math.PI;
      const ph = (r.phase / 256) * 2 * Math.PI;
      if (b.have === 0) {
        b.px = x; b.py = y; b.ph = hd; b.pPhase = ph; b.pBend = r.bend / 127;
        b.cx = x; b.cy = y; b.ch = hd; b.cPhase = ph; b.cBend = r.bend / 127;
      }
      b.px = b.cx; b.py = b.cy; b.ph = b.ch; b.pPhase = b.cPhase; b.pBend = b.cBend;
      b.cx = x; b.cy = y; b.ch = b.ph + wrapPi(hd - b.ph);
      b.cPhase = b.pPhase + ((((ph - b.pPhase) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
      b.cBend = r.bend / 127;
      b.glowT = r.glow / 255;
      b.flags = r.flags;
      b.prevAt = b.curAt; b.curAt = now;
      b.have = Math.min(2, b.have + 1);
    }
  }

  private ingestNearPose(frame: Uint8Array): void {
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    let o = HEADER_BYTES;
    const n = dv.getUint16(o, true); o += 2;
    for (let i = 0; i < n && o + 3 <= frame.length; i++) {
      const slot = dv.getUint16(o, true); const nj = dv.getUint8(o + 2); o += 3;
      const b = this.bodies.get(slot);
      const j = new Float32Array(nj + 1);
      for (let q = 0; q < nj && o < frame.length; q++, o++) j[q + 1] = (dv.getInt8(o) * Math.PI) / 128;
      if (b) b.joints = j;
    }
  }

  private ingestGlow(frame: Uint8Array): void {
    const gl = this.gl;
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    let o = HEADER_BYTES;
    const rect: [number, number, number, number] = [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true)];
    o += 16;
    const w = dv.getUint16(o, true), h = dv.getUint16(o + 2, true); o += 4;
    if (w * h * 4 > frame.length - o || !gl) return;
    this.glowRect = rect;
    gl.bindTexture(gl.TEXTURE_2D, this.glowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame.subarray(o, o + w * h * 4));
  }

  private ingestFields(frame: Uint8Array): void {
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    let o = HEADER_BYTES;
    const nCh = dv.getUint8(o); const w = dv.getUint16(o + 1, true), h = dv.getUint16(o + 3, true); o += 5;
    let u = NaN, v = NaN;
    for (let c = 0; c < nCh && o + 9 + w * h <= frame.length; c++) {
      const id = dv.getUint8(o); const mn = dv.getFloat32(o + 1, true), mx = dv.getFloat32(o + 5, true); o += 9;
      if (id === 4 || id === 5 || id === 7) {
        let sum = 0;
        for (let i = 0; i < w * h; i++) sum += frame[o + i]!;
        const mean = mn + (sum / (w * h) / 255) * (mx - mn);
        if (id === 4) u = mean; else if (id === 5) v = mean; else this.turbidity = Math.min(1, Math.max(0, mean));
      }
      o += w * h;
    }
    if (Number.isFinite(u) && Number.isFinite(v)) this.current = [u, v];
  }

  private ingestDust(f: DustFrame): void {
    this.stats.dustFrames++;
    const now = this.clock;
    if (this.dustAt >= 0 && now > this.dustAt) this.dustInterval = 0.8 * this.dustInterval + 0.2 * Math.min(0.25, Math.max(1 / 120, now - this.dustAt));
    this.dustAt = now;
    this.dustRect = f.rect;
    const n = f.n;
    if (this.dustCur.length < n * 2) {
      const grow = (a: Uint16Array<ArrayBuffer>): Uint16Array<ArrayBuffer> => { const b = new Uint16Array(n * 2); b.set(a); return b; };
      this.dustPrev = grow(this.dustPrev);
      this.dustCur = grow(this.dustCur);
      const at = new Uint8Array(n * 2); at.set(this.dustAttr); this.dustAttr = at;
    }
    let live = 0;
    for (let s = 0; s < n; s++) {
      const wasEmpty = s >= this.nDust || this.dustAttr[s * 2] === 255;
      // a slot that just appeared starts where it is (no streak from a previous occupant)
      this.dustPrev[s * 2] = wasEmpty ? f.x[s]! : this.dustCur[s * 2]!;
      this.dustPrev[s * 2 + 1] = wasEmpty ? f.y[s]! : this.dustCur[s * 2 + 1]!;
      this.dustCur[s * 2] = f.x[s]!;
      this.dustCur[s * 2 + 1] = f.y[s]!;
      this.dustAttr[s * 2] = f.colour[s]!;
      this.dustAttr[s * 2 + 1] = f.glow[s]!;
      if (f.colour[s] !== 255) live++;
    }
    this.nDust = n;
    this.stats.live = live;
  }

  // ---------------- targets ----------------
  private ensureTargets(): void {
    const gl = this.gl!;
    const s = this.settings;
    const rw = Math.max(2, Math.round(this.size.outW * s.renderScale)), rh = Math.max(2, Math.round(this.size.outH * s.renderScale));
    const levels = s.bloomLevels;
    if (rw === this.size.rw && rh === this.size.rh && this.fbDown.length === levels) return;
    this.fbScene?.dispose(); this.fbBg?.dispose(); this.fbTrail?.forEach((f) => f.dispose());
    this.fbDown.forEach((f) => f.dispose()); this.fbUp.forEach((f) => f.dispose());
    const F = this.hdrFormat;
    const T = (w: number, h: number): Target => ({ tex: makeTexture(gl, w, h, F, gl.RGBA, F === gl.RGBA8 ? gl.UNSIGNED_BYTE : gl.HALF_FLOAT, true), w, h });
    this.fbScene = new Fbo(gl, [T(rw, rh), T(rw, rh), T(rw, rh)]);
    this.fbOut?.dispose();
    this.fbOut = new Fbo(gl, [{ tex: makeTexture(gl, rw, rh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, true), w: rw, h: rh }]);
    const hw = Math.max(1, rw >> 1), hh = Math.max(1, rh >> 1);
    this.fbBg = new Fbo(gl, [T(hw, hh)]);
    this.fbTrail = [new Fbo(gl, [T(hw, hh)]), new Fbo(gl, [T(hw, hh)])];
    for (const f of this.fbTrail) { f.bind(); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    this.fbDown = []; this.fbUp = [];
    let w = hw, h = hh;
    for (let i = 0; i < levels; i++) {
      this.fbDown.push(new Fbo(gl, [T(w, h)]));
      if (i < levels - 1) this.fbUp.push(new Fbo(gl, [T(w, h)]));
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
    }
    this.size.rw = rw; this.size.rh = rh;
  }

  // ---------------- per-frame geometry ----------------
  private capN = 0;
  private nbN = 0;
  private instN = 0;
  private spriteN = 0;

  private pushCapsules(list: readonly Capsule[], t: RenderTemplate, lenM: number): number {
    const need = (this.capN + list.length) * CAP_FLOATS;
    if (need > this.caps.length) { const c = new Float32Array(Math.max(need, this.caps.length * 2)); c.set(this.caps); this.caps = c; }
    const start = this.capN;
    writeCapsules(list, t, this.scratch, lenM, this.caps, start * CAP_FLOATS);
    this.capN += list.length;
    return start;
  }
  private pushNb(idx: number[], base: number): number {
    if (this.nbN + idx.length > this.nb.length) { const c = new Float32Array(Math.max(this.nb.length * 2, this.nbN + idx.length)); c.set(this.nb); this.nb = c; }
    const start = this.nbN;
    for (const i of idx) this.nb[this.nbN++] = base + i;
    return start;
  }
  private pushInst(v: number[]): void {
    if ((this.instN + 1) * INST_FLOATS > this.inst.length) { const c = new Float32Array(this.inst.length * 2); c.set(this.inst); this.inst = c; }
    this.inst.set(v, this.instN * INST_FLOATS);
    this.instN++;
  }
  private pushSprite(x: number, y: number, rM: number, minPx: number, r: number, g: number, b: number, trail: number): void {
    if ((this.spriteN + 1) * SPRITE_FLOATS > this.sprites.length) { const c = new Float32Array(this.sprites.length * 2); c.set(this.sprites); this.sprites = c; }
    const o = this.spriteN * SPRITE_FLOATS;
    const s = this.sprites;
    s[o] = x; s[o + 1] = y; s[o + 2] = rM; s[o + 3] = minPx; s[o + 4] = r; s[o + 5] = g; s[o + 6] = b; s[o + 7] = trail;
    this.spriteN++;
  }

  private organColours(t: RenderTemplate): OrganColour[] {
    let c = this.organCols.get(t);
    if (!c) {
      c = t.organs.map((o) => {
        const hue = o.hue ?? t.look.rimHue + o.hueShift;
        const chroma = o.chroma ?? 0.18;
        const col = oklchToLinear(0.78, chroma, hue);
        return { col, red: isSaturatedRed(hue, chroma, col) };
      });
      this.organCols.set(t, c);
    }
    return c;
  }

  /** Emit the draws for one creature at one tier; `w` is the cross-fade fraction, `sign` +1 fading in, -1 out, 0 steady. */
  private drawBody(b: BodyState, tier: Tier, x: number, y: number, heading: number, phase: number, bend: number, w: number, sign: number, view: number[], ppm: number): void {
    const t = b.tpl!;
    const look = t.look;
    const L = b.lenM;
    const life = b.deadAt >= 0 ? Math.max(0, 1 - (this.clock - b.deadAt) / 20) : 1;
    const glowLife = b.deadAt >= 0 ? Math.max(0, 1 - (this.clock - b.deadAt) / (10 + 20 * Math.min(1, L / 0.2))) : 1;
    const level = b.level * glowLife * this.settings.emissionGain;
    const em = look.emission;
    const ocols = this.organColours(t);
    const red = look.red;
    const sw = sign > 0 ? w : sign < 0 ? 1 - w : 1;
    if (tier === TIER.D) {
      const u = (x - view[0]!) / (view[2]! - view[0]!), v = (y - view[1]!) / (view[3]! - view[1]!);
      if (u < 0 || u >= 1 || v < 0 || v >= 1) return;
      const sz = L * ppm; // sub-pixel: light in proportion to the area it would cover
      const k = sw * level * Math.min(1, sz * sz * 6 + 0.02) * 0.5;
      // bilinear splat so a moving mote glides between cells
      const fx = u * DENS_W - 0.5, fy = v * DENS_H - 0.5;
      const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy;
      for (let q = 0; q < 4; q++) {
        const cx = ix + (q & 1), cy = iy + (q >> 1);
        if (cx < 0 || cy < 0 || cx >= DENS_W || cy >= DENS_H) continue;
        const wq = ((q & 1) ? ax : 1 - ax) * ((q >> 1) ? ay : 1 - ay) * k;
        const i = (cy * DENS_W + cx) * 4;
        this.dens[i] = this.dens[i]! + em[0] * wq; this.dens[i + 1] = this.dens[i + 1]! + em[1] * wq; this.dens[i + 2] = this.dens[i + 2]! + em[2] * wq;
      }
      this.densDirty = true;
      return;
    }
    if (tier === TIER.L3) {
      let og = 0;
      for (const o of t.organs) og += o.gain;
      const k = sw * (level * 1.6 + og * 0.25 * (0.3 + level)) * 1.2;
      this.pushSprite(x, y, L * 0.22, this.settings.minSpeckPx, em[0] * k, em[1] * k, em[2] * k, look.trailGain);
      return;
    }
    poseNodes(t, { lenM: L, heading, phase, bend, joints: tier === TIER.L0 ? b.joints : null }, this.scratch);
    const mpp = 1 / ppm;
    const k = Math.max(0.6 * t.medianR * look.softness * L, mpp * 0.5);
    const rimW = Math.max(0.03 * L, mpp * 0.9);
    const haloW = Math.max(0.045 * L, mpp * 1.5);
    const margin = haloW * 3 + k + 2 * mpp;
    const fadeSign = sign > 0 ? 1 : sign < 0 ? -1 : 0;
    const flags = b.flags & BODY_FLAG.DISEASED;
    const common = (bounds: number[], start: number, count: number, nbStart: number, nbCount: number): void => {
      this.pushInst([
        bounds[0]!, bounds[1]!, bounds[2]!, bounds[3]!,
        x, y, L, b.zl,
        start, count, nbStart, nbCount,
        look.albedo[0], look.albedo[1], look.albedo[2], look.coreAlpha * life,
        em[0] * level * 0.32, em[1] * level * 0.32, em[2] * level * 0.32, look.edgeAlpha * life,
        rimW, haloW, look.stripeFreq, look.stripeAmp,
        k, t.rMax * L, look.trailGain, look.spotDensity,
        w, fadeSign, b.seed, flags,
      ]);
    };
    if (tier === TIER.L0) {
      const base = this.pushCapsules(t.capsules, t, L);
      for (const ch of t.chunks) {
        const bounds = capsuleBounds(this.caps, (base + ch.start) * CAP_FLOATS, (base + ch.end) * CAP_FLOATS, margin);
        const nbStart = this.pushNb(ch.nb, base);
        common(bounds, base + ch.start, ch.end - ch.start, nbStart, ch.nb.length);
      }
    } else {
      const list = tier === TIER.L1 ? t.macro : t.core;
      const base = this.pushCapsules(list, t, L);
      const bounds = capsuleBounds(this.caps, base * CAP_FLOATS, (base + list.length) * CAP_FLOATS, margin);
      common(bounds, base, list.length, 0, 0);
    }
    // light organs: every organ at L0, one aggregate at L1 and L2
    if (t.organs.length === 0) return;
    const tS = this.clock;
    const gainAll = sw * glowLife * this.settings.emissionGain;
    if (tier === TIER.L0) {
      t.organs.forEach((o, i) => {
        const oc = ocols[i]!;
        const p = organIntensity(tS, o.periodS, o.phase, o.duty, o.depth, this.profile, oc.red || red);
        const kk = gainAll * o.gain * p * (0.3 + b.level) * 2.4;
        this.pushSprite(x + this.scratch.x[o.node]!, y + this.scratch.y[o.node]!, o.radius * L * 0.45, 0.8, oc.col[0] * kk, oc.col[1] * kk, oc.col[2] * kk, look.trailGain);
      });
    } else {
      let gx = 0, gy = 0, gs = 0, rr = 0;
      const col = [0, 0, 0];
      t.organs.forEach((o, i) => {
        const oc = ocols[i]!;
        const p = organIntensity(tS, o.periodS, o.phase, o.duty, o.depth, this.profile, oc.red || red);
        const g = o.gain * p;
        gx += this.scratch.x[o.node]! * o.gain; gy += this.scratch.y[o.node]! * o.gain; gs += o.gain; rr += o.radius;
        col[0] = col[0]! + oc.col[0] * g; col[1] = col[1]! + oc.col[1] * g; col[2] = col[2]! + oc.col[2] * g;
      });
      const kk = gainAll * (0.3 + b.level) * 1.6;
      this.pushSprite(x + gx / gs, y + gy / gs, (rr / t.organs.length) * L * 0.9, 0.8, col[0]! * kk, col[1]! * kk, col[2]! * kk, look.trailGain);
    }
  }

  private buildFrame(view: number[], ppm: number, dt: number): void {
    this.capN = 0; this.nbN = 0; this.instN = 0; this.spriteN = 0;
    if (this.densDirty) this.dens.fill(0);
    const cands: LodCandidate[] = [];
    const live: { b: BodyState; x: number; y: number; h: number; ph: number; bend: number }[] = [];
    const interval = Math.max(1 / 120, this.bodyInterval);
    for (const b of this.bodies.values()) {
      if (b.have === 0) continue;
      if (!b.tpl) b.tpl = this.templates(b.key, b.species);
      if (!b.tpl) continue;
      // interpolate one interval behind the newest frame, extrapolate at most 200 ms, then freeze
      let a = (this.clock - b.curAt) / interval;
      if (b.have < 2) a = 1;
      a = Math.min(Math.max(0, a), 1 + 0.2 / interval);
      const x = b.px + (b.cx - b.px) * a, y = b.py + (b.cy - b.py) * a;
      const h = b.ph + (b.ch - b.ph) * a;
      const ph = b.pPhase + (b.cPhase - b.pPhase) * Math.min(a, 1.5);
      const bend = b.pBend + (b.cBend - b.pBend) * Math.min(1, a);
      if ((b.flags & BODY_FLAG.DYING) && b.deadAt < 0) b.deadAt = this.clock;
      // emission slews to its target with the profile's time constant (review R18)
      const target = BASELINE_GLOW + b.tpl.look.rimGain * b.glowT * (0.3 + 0.7 * b.energy);
      b.level = stepEmission(b.em, target, this.clock, dt, this.profile, b.tpl.look.red, BASELINE_GLOW + b.tpl.look.rimGain);
      const r = b.tpl.extent * b.lenM * 1.6 + 6 / ppm;
      if (x + r < view[0]! || x - r > view[2]! || y + r < view[1]! || y - r > view[3]!) continue;
      cands.push({ id: b.id, sizePx: b.lenM * ppm, priority: (b.flags & BODY_FLAG.SELECTED) ? 1 : 0 });
      live.push({ b, x, y, h, ph, bend });
    }
    const tiers: Tier[] = [];
    this.stats.tiers = classify(cands, this.lod, this.settings.caps, tiers);
    // back to front by pseudo-depth (high zl is further away and hazier)
    const order = live.map((_, i) => i).sort((p, q) => live[q]!.b.zl - live[p]!.b.zl || live[p]!.b.id - live[q]!.b.id);
    for (const i of order) {
      const { b, x, y, h, ph, bend } = live[i]!;
      const tier = tiers[i]!;
      if (b.tier !== tier) {
        b.oldTier = b.tier; b.tier = tier; b.fadeAt = b.oldTier < 0 ? -1 : this.clock;
      }
      const f = b.fadeAt < 0 ? 1 : (this.clock - b.fadeAt) / FADE_S;
      if (f < 1 && b.oldTier >= 0) {
        this.drawBody(b, b.oldTier as Tier, x, y, h, ph, bend, f, -1, view, ppm);
        this.drawBody(b, tier, x, y, h, ph, bend, f, 1, view, ppm);
      } else {
        b.oldTier = -1;
        this.drawBody(b, tier, x, y, h, ph, bend, 1, 0, view, ppm);
      }
    }
    // dust motes (the dream tank's phase-0 stream), interpolated per stable slot
    if (this.nDust > 0) {
      const a = Math.min(1, (this.clock - this.dustAt) / Math.max(1 / 120, this.dustInterval));
      const [rx0, ry0, rx1, ry1] = this.dustRect;
      const zoom = Math.min(3, Math.max(0.6, ppm / 40));
      const px = zoom * Math.max(1, this.size.rw / 1280);
      for (let s = 0; s < this.nDust; s++) {
        const c = this.dustAttr[s * 2]!;
        if (c === 255) continue;
        const qx = this.dustPrev[s * 2]! + (this.dustCur[s * 2]! - this.dustPrev[s * 2]!) * a;
        const qy = this.dustPrev[s * 2 + 1]! + (this.dustCur[s * 2 + 1]! - this.dustPrev[s * 2 + 1]!) * a;
        const x = rx0 + (qx / 65535) * (rx1 - rx0), y = ry0 + (qy / 65535) * (ry1 - ry0);
        if (x < view[0]! || x > view[2]! || y < view[1]! || y > view[3]!) continue;
        const glow = this.dustAttr[s * 2 + 1]! / 255;
        const p = organIntensity(this.clock, 1 / (0.03 + 0.32 * hashId(s)), hashId(s + 7), 0.5, 0.3, this.profile, false);
        const ci = (c & 15) * 3;
        const k = (BASELINE_GLOW + glow * 2.6) * p * this.settings.emissionGain;
        this.pushSprite(x, y, 0, (0.8 + 2.0 * glow) * px, this.palette[ci]! * k, this.palette[ci + 1]! * k, this.palette[ci + 2]! * k, 0.5);
      }
    }
    this.stats.instances = this.instN;
    this.stats.capsules = this.capN;
    this.stats.sprites = this.spriteN;
  }

  private uploadFrame(): void {
    const gl = this.gl!;
    const rows = Math.max(1, Math.ceil(this.capN / CAPS_PER_ROW));
    if (!this.capTex || rows > this.capTexH) {
      if (this.capTex) gl.deleteTexture(this.capTex);
      this.capTexH = Math.max(rows, this.capTexH * 2, 4);
      this.capTex = makeTexture(gl, 2048, this.capTexH, gl.RGBA32F, gl.RGBA, gl.FLOAT, false);
    }
    if (this.capN > 0) {
      gl.bindTexture(gl.TEXTURE_2D, this.capTex);
      const full = Math.floor(this.capN / CAPS_PER_ROW);
      if (full > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 2048, full, gl.RGBA, gl.FLOAT, this.caps.subarray(0, full * CAPS_PER_ROW * CAP_FLOATS));
      const rest = this.capN - full * CAPS_PER_ROW;
      if (rest > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, full, rest * 2, 1, gl.RGBA, gl.FLOAT, this.caps.subarray(full * CAPS_PER_ROW * CAP_FLOATS, this.capN * CAP_FLOATS));
    }
    const nbRows = Math.max(1, Math.ceil(this.nbN / 2048));
    if (!this.nbTex || nbRows > this.nbTexH) {
      if (this.nbTex) gl.deleteTexture(this.nbTex);
      this.nbTexH = Math.max(nbRows, this.nbTexH * 2, 2);
      this.nbTex = makeTexture(gl, 2048, this.nbTexH, gl.R32F, gl.RED, gl.FLOAT, false);
    }
    if (this.nbN > 0) {
      gl.bindTexture(gl.TEXTURE_2D, this.nbTex);
      const full = Math.floor(this.nbN / 2048);
      if (full > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 2048, full, gl.RED, gl.FLOAT, this.nb.subarray(0, full * 2048));
      const rest = this.nbN - full * 2048;
      if (rest > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, full, rest, 1, gl.RED, gl.FLOAT, this.nb.subarray(full * 2048, this.nbN));
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.inst.subarray(0, Math.max(1, this.instN) * INST_FLOATS), gl.STREAM_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.sprites.subarray(0, Math.max(1, this.spriteN) * SPRITE_FLOATS), gl.STREAM_DRAW);
    if (this.densDirty) {
      gl.bindTexture(gl.TEXTURE_2D, this.densTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, DENS_W, DENS_H, gl.RGBA, gl.FLOAT, this.dens);
      let any = false;
      for (let i = 0; i < this.dens.length; i += 4) if (this.dens[i]! + this.dens[i + 1]! + this.dens[i + 2]! > 0) { any = true; break; }
      this.densDirty = any;
    }
  }

  private water(p: Program, t: number): void {
    p.tex('u_caustic', 7, this.causticTex);
    p.f2('u_tank', this.tank.w, this.tank.h).f1('u_time', t).f1('u_sun', this.sun).f1('u_turbidity', this.turbidity)
      .f1('u_depthScale', 36 / Math.max(4, this.tank.h));
  }

  private drawSnow(view: number[], ppm: number, t: number, near: boolean): void {
    const gl = this.gl!;
    const p = this.progs.snow!.use();
    p.f4('u_view', view[0]!, view[1]!, view[2]!, view[3]!).f1('u_ppm', ppm).f2('u_current', this.current[0], this.current[1]);
    this.water(p, t);
    gl.bindVertexArray(this.snowVao);
    const vw = view[2]! - view[0]!, vh = view[3]! - view[1]!;
    const cx = (view[0]! + view[2]!) / 2, cy = (view[1]! + view[3]!) / 2;
    const lv = Math.log2(vw / 6);
    const fl = Math.floor(lv), fr = lv - fl;
    const layers = near
      ? [{ par: 1.7, tileK: 2.2, size: 0.03, per: 2, gain: 1, over: 1, seed: 3 }]
      : [{ par: 0.5, tileK: 0.7, size: 0.0035, per: 26, gain: 0.5, over: 0, seed: 1 }, { par: 1, tileK: 1, size: 0.0055, per: 34, gain: 1, over: 0, seed: 2 }];
    for (const L of layers) {
      for (let lvl = 0; lvl < 2; lvl++) {
        const wgt = lvl === 0 ? 1 - fr : fr;
        if (wgt < 0.02) continue;
        const tile = 2 ** (fl + lvl) * L.tileK;
        const shiftX = cx * (1 - L.par), shiftY = cy * (1 - L.par);
        const ox = Math.floor((view[0]! - shiftX) / tile), oy = Math.floor((view[1]! - shiftY) / tile);
        const nx = Math.ceil(vw / tile) + 1, ny = Math.ceil(vh / tile) + 1;
        const per = Math.max(1, Math.round(L.per * this.settings.snow));
        p.f1('u_tile', tile).f2('u_camShift', shiftX, shiftY).f1('u_sizeTile', L.size).f1('u_perTile', per)
          .f2('u_tiles', nx, ny).f2('u_origin', ox, oy).f1('u_seed', L.seed + lvl * 0.37 + fl * 0.11).f1('u_minPx', L.over ? 3 : 0.6)
          .f1('u_gain', wgt * L.gain).f1('u_over', L.over);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nx * ny * per);
      }
    }
  }

  // ---------------- render ----------------
  render(nowMs: number, cam: Camera): void {
    const gl = this.gl;
    if (!gl || !this.ok) return;
    const nowS = nowMs / 1000;
    if (this.t0 < 0) this.t0 = nowS;
    const tCall = nowS - this.t0;
    // frame cap by accumulation (06 §6.1.9): locks to integer divisors of the refresh rate
    const cap = this.profile.fpsCap;
    if (cap > 0 && this.lastCall >= 0) {
      this.accum += Math.max(0, tCall - this.lastCall);
      this.lastCall = tCall;
      if (this.accum < 1 / cap - 0.004) { this.stats.skipped++; return; }
      this.accum = Math.min(this.accum - 1 / cap, 1 / cap);
    } else this.lastCall = tCall;
    const dt = this.lastRender < 0 ? 1 / 30 : Math.min(0.25, Math.max(0, tCall - this.lastRender));
    this.lastRender = tCall;
    this.clock = tCall;
    const t = tCall;
    if (this.size.outW !== this.canvas.width || this.size.outH !== this.canvas.height) this.resize(this.canvas.width, this.canvas.height);
    this.ensureTargets();
    const s = this.settings;
    const ppmOut = 2 ** cam.zeta;
    const halfW = this.size.outW / (2 * ppmOut), halfH = this.size.outH / (2 * ppmOut);
    const view = [cam.cx - halfW, cam.cy - halfH, cam.cx + halfW, cam.cy + halfH];
    const ppm = ppmOut * s.renderScale;
    let pt = this.options.profilePasses ? performance.now() : 0;
    this.buildFrame(view, ppm, dt);
    this.uploadFrame();
    pt = this.mark('build', pt);

    // pass 3: water background
    const bg = this.progs.bg!.use();
    this.fbBg!.bind();
    gl.disable(gl.BLEND);
    const gr = this.glowRect;
    bg.f4('u_view', view[0]!, view[1]!, view[2]!, view[3]!).f4('u_glowRect', gr[0], gr[1], gr[2], gr[3]).f1('u_glowOn', gr[2] > gr[0] ? 1 : 0);
    this.water(bg, t);
    bg.tex('u_density', 0, this.densTex).tex('u_glow', 1, this.glowTex);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    pt = this.mark('bg', pt);

    // passes 4 to 8: snow, bodies, sprites, near snow into the MRT scene target
    this.fbScene!.bind();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied over; outputs with alpha 0 add
    this.drawSnow(view, ppm, t, false);
    pt = this.mark('snow', pt);
    if (this.instN > 0) {
      const bp = this.progs.body!.use();
      bp.f4('u_view', view[0]!, view[1]!, view[2]!, view[3]!).f1('u_mpp', 1 / ppm).f1('u_hazeMax', s.hazeMax);
      this.water(bp, t);
      bp.tex('u_caps', 0, this.capTex).tex('u_nb', 1, this.nbTex).tex('u_blue', 2, this.blueTex);
      gl.bindVertexArray(this.bodyVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.instN);
    }
    pt = this.mark('bodies', pt);
    if (this.spriteN > 0) {
      const sp = this.progs.sprite!.use();
      sp.f4('u_view', view[0]!, view[1]!, view[2]!, view[3]!).f1('u_ppm', ppm);
      gl.bindVertexArray(this.spriteVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.spriteN);
    }
    this.drawSnow(view, ppm, t, true);
    gl.disable(gl.BLEND);
    pt = this.mark('sprites+near', pt);

    // pass 9: trails, reprojected and advected by the current
    const tp = this.progs.trail!.use();
    const prev = this.fbTrail![this.trailIdx]!, next = this.fbTrail![1 - this.trailIdx]!;
    next.bind();
    const jump = Math.abs(cam.zeta - this.prevZeta) > 1;
    const tau = jump ? 0.1 : s.trailTau;
    const pv = this.prevView ?? view;
    tp.f4('u_view', view[0]!, view[1]!, view[2]!, view[3]!).f4('u_prevView', pv[0]!, pv[1]!, pv[2]!, pv[3]!).f1('u_dt', dt)
      .f1('u_decay', Math.exp(-dt / tau)).f1('u_time', t).f2('u_current', this.current[0], this.current[1]);
    tp.tex('u_prev', 0, prev.targets[0]!.tex).tex('u_fresh', 1, this.fbScene!.targets[2]!.tex);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.trailIdx = 1 - this.trailIdx;
    const trailTex = next.targets[0]!.tex;
    this.prevView = view;
    this.prevZeta = cam.zeta;
    pt = this.mark('trail', pt);

    // pass 10: bloom
    const levels = this.fbDown.length;
    const pre = this.progs.bloomPre!.use();
    this.fbDown[0]!.bind();
    pre.tex('u_emit', 0, this.fbScene!.targets[1]!.tex).tex('u_trail', 1, trailTex).f2('u_texel', 1 / this.size.rw, 1 / this.size.rh)
      .f1('u_knee', 0.25).f1('u_threshold', 0.12).f1('u_trailGain', s.trailGain);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const down = this.progs.bloomDown!.use();
    for (let i = 1; i < levels; i++) {
      const src = this.fbDown[i - 1]!.targets[0]!;
      this.fbDown[i]!.bind();
      down.tex('u_src', 0, src.tex).f2('u_texel', 1 / src.w, 1 / src.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    const up = this.progs.bloomUp!.use();
    let low = this.fbDown[levels - 1]!.targets[0]!;
    for (let i = levels - 2; i >= 0; i--) {
      this.fbUp[i]!.bind();
      up.tex('u_src', 0, low.tex).tex('u_add', 1, this.fbDown[i]!.targets[0]!.tex).f2('u_texel', 1 / low.w, 1 / low.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      low = this.fbUp[i]!.targets[0]!;
    }
    const bloomTex = levels > 1 ? this.fbUp[0]!.targets[0]!.tex : this.fbDown[0]!.targets[0]!.tex;
    const bloomStrength = s.bloomStrength / levels;
    pt = this.mark('bloom', pt);

    // safety net input: the coarse luminance grid
    const lp = this.progs.lum!.use();
    this.fbLum!.bind();
    lp.tex('u_bg', 0, this.fbBg!.targets[0]!.tex).tex('u_body', 1, this.fbScene!.targets[0]!.tex).tex('u_emit', 2, this.fbScene!.targets[1]!.tex)
      .tex('u_trail', 3, trailTex).tex('u_bloom', 4, bloomTex).f1('u_bloomStrength', bloomStrength).f1('u_trailGain', s.trailGain)
      .f1('u_exposure', this.limiter.exposure).f2('u_tileUv', 1 / LUM_W, 1 / LUM_H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.readLuminance(t);
    pt = this.mark('lum', pt);

    // pass 11: composite to the canvas (at the internal size and blitted up when render scale < 1)
    const scaled = this.size.rw < this.size.outW;
    if (scaled) this.fbOut!.bind();
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.size.outW, this.size.outH); }
    const cp = this.progs.composite!.use();
    cp.tex('u_bg', 0, this.fbBg!.targets[0]!.tex).tex('u_body', 1, this.fbScene!.targets[0]!.tex).tex('u_emit', 2, this.fbScene!.targets[1]!.tex)
      .tex('u_trail', 3, trailTex).tex('u_bloom', 4, bloomTex).tex('u_safety', 5, this.safetyTex).tex('u_blue', 6, this.blueTex)
      .f1('u_bloomStrength', bloomStrength).f1('u_trailGain', s.trailGain).f1('u_exposure', this.limiter.exposure)
      .f1('u_ditherAmp', s.ditherAmp).f1('u_blackLift', s.blackLift);
    const k = s.staticDither || this.options.syncReadback ? 0 : this.frameNo;
    cp.f2('u_ditherOffset', (k * 37) % 64, (k * 23) % 64);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (scaled) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbOut!.fb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, this.size.rw, this.size.rh, 0, 0, this.size.outW, this.size.outH, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.bindVertexArray(null);
    this.mark('composite', pt);
    this.frameNo++;
    this.stats.rendered++;
    this.stats.exposure = this.limiter.exposure;
  }

  private readLuminance(t: number): void {
    const gl = this.gl!;
    if (this.options.syncReadback) {
      gl.readPixels(0, 0, LUM_W, LUM_H, gl.RGBA, gl.FLOAT, this.lumData);
      this.processLuminance(t);
      return;
    }
    if (this.lumFence) {
      const st = gl.clientWaitSync(this.lumFence, 0, 0);
      if (st === gl.TIMEOUT_EXPIRED) return; // still in flight
      gl.deleteSync(this.lumFence);
      this.lumFence = null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.lumPbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.lumData);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.processLuminance(t);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.lumPbo);
    gl.readPixels(0, 0, LUM_W, LUM_H, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.lumFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  }

  private processLuminance(t: number): void {
    const dt = this.lastLumT < 0 ? 1 / 30 : Math.min(0.5, Math.max(1e-3, t - this.lastLumT));
    this.lastLumT = t;
    let scene = 0;
    const n = LUM_W * LUM_H;
    for (let i = 0; i < n; i++) { this.lumDisp[i] = this.lumData[i * 4]!; scene += this.lumData[i * 4 + 1]!; }
    scene /= n;
    this.stats.meanLum = scene;
    this.limiter.update(scene, dt);
    if (this.guard.update(this.lumDisp, t, dt)) {
      this.stats.safetyTriggers = this.guard.triggers;
      console.warn('phylotank: flash safety net engaged');
    }
    let changed = false;
    for (let i = 0; i < n; i++) {
      const v = Math.round(this.guard.gain[i]! * 255);
      if (v !== this.safetyBytes[i]) { this.safetyBytes[i] = v; changed = true; }
    }
    if (changed) {
      const gl = this.gl!;
      gl.bindTexture(gl.TEXTURE_2D, this.safetyTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUM_W, LUM_H, gl.RED, gl.UNSIGNED_BYTE, this.safetyBytes);
    }
  }
}

export function createRenderer(canvas: HTMLCanvasElement, mode: ViewMode): WebGL2Renderer {
  return new WebGL2Renderer(canvas, mode);
}
