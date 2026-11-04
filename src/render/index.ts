/**
 * src/render: the one renderer for every view (CONTRACT 15). WebGL2 now, WebGPU later behind
 * the same RendererModule interface. See README.md.
 *
 * Phase 0: a dark deep-sea gradient with slow light shafts and blue-noise-style dither, and
 * DUST_FRAME records drawn as additive glowing points, interpolated per stable slot between
 * the last two frames (review R18). Pulses stay under the profile's maximum frequency.
 */
import {
  decodeCborFrame, decodeDust, FRAME, readHeader, VIEW_PROFILES,
  type Camera, type DustFrame, type RendererModule, type ViewMode, type ViewProfile,
} from '../core/index.js';
import { BG_FS, BG_VS, DOT_FS, DOT_VS } from './shaders.js';

export interface TankInfo { w: number; h: number }

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
  return s;
}
function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  return p;
}

const DEFAULT_PALETTE = new Uint8Array([
  90, 230, 255, 60, 255, 200, 120, 160, 255, 190, 120, 255, 255, 120, 220, 140, 255, 120, 255, 200, 110, 100, 200, 255,
]);

export class WebGL2Renderer implements RendererModule {
  readonly ok: boolean;
  readonly profile: ViewProfile;
  private gl: WebGL2RenderingContext | null = null;
  private bg: WebGLProgram | null = null;
  private dots: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private bufPrev: WebGLBuffer | null = null;
  private bufCur: WebGLBuffer | null = null;
  private bufAttr: WebGLBuffer | null = null;
  private n = 0;
  private prevXY = new Uint16Array(0);
  private curXY = new Uint16Array(0);
  private attr = new Uint8Array(0);
  private lastFrameAt = 0;
  private frameInterval = 66;
  private rect: [number, number, number, number] = [0, 0, 32, 18];
  private palette = new Float32Array(16 * 3);
  private widthPx = 1;
  private heightPx = 1;
  tank: TankInfo = { w: 32, h: 18 };
  /** Counters for tests and diagnostics. */
  readonly stats = { framesIn: 0, dustFrames: 0, rendered: 0, live: 0 };

  constructor(private readonly canvas: HTMLCanvasElement, mode: ViewMode) {
    this.profile = VIEW_PROFILES[mode];
    this.setPalette(DEFAULT_PALETTE);
    let ok = false;
    try {
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
      if (gl) { this.gl = gl; this.init(gl); ok = true; }
    } catch (e) {
      console.error('WebGL2 renderer failed to start', e);
    }
    this.ok = ok;
  }

  private init(gl: WebGL2RenderingContext): void {
    this.bg = program(gl, BG_VS, BG_FS);
    this.dots = program(gl, DOT_VS, DOT_FS);
    this.vao = gl.createVertexArray();
    this.bufPrev = gl.createBuffer();
    this.bufCur = gl.createBuffer();
    this.bufAttr = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPrev);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.UNSIGNED_SHORT, true, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufCur);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.UNSIGNED_SHORT, true, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufAttr);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 2, gl.UNSIGNED_BYTE, 0, 0);
    gl.bindVertexArray(null);
  }

  setPalette(rgb: Uint8Array): void {
    this.palette.fill(0);
    for (let i = 0; i < Math.min(16 * 3, rgb.length); i++) this.palette[i] = (rgb[i]! / 255) ** 2.2;
  }

  resize(widthPx: number, heightPx: number, dpr = 1): void {
    void dpr;
    this.widthPx = Math.max(1, Math.floor(widthPx));
    this.heightPx = Math.max(1, Math.floor(heightPx));
    if (this.canvas.width !== this.widthPx) this.canvas.width = this.widthPx;
    if (this.canvas.height !== this.heightPx) this.canvas.height = this.heightPx;
  }

  ingest(frame: Uint8Array): void {
    this.stats.framesIn++;
    const h = readHeader(frame);
    if (h.type === FRAME.DUST_FRAME) this.ingestDust(decodeDust(frame));
    else if (h.type === FRAME.WELCOME) {
      const w = decodeCborFrame(frame).payload as { tank?: TankInfo; palette?: Uint8Array };
      if (w.tank) this.tank = { w: w.tank.w, h: w.tank.h };
      if (w.palette instanceof Uint8Array) this.setPalette(w.palette);
    }
  }

  private ingestDust(f: DustFrame): void {
    this.stats.dustFrames++;
    const now = performance.now();
    if (this.lastFrameAt > 0) this.frameInterval = 0.8 * this.frameInterval + 0.2 * Math.min(250, now - this.lastFrameAt);
    this.lastFrameAt = now;
    this.rect = f.rect;
    const n = f.n;
    if (this.curXY.length < n * 2) {
      const grow = (a: Uint16Array) => { const b = new Uint16Array(n * 2); b.set(a); return b; };
      this.prevXY = grow(this.prevXY);
      this.curXY = grow(this.curXY);
      const at = new Uint8Array(n * 2); at.set(this.attr); this.attr = at;
    }
    let live = 0;
    for (let s = 0; s < n; s++) {
      const wasEmpty = s >= this.n || this.attr[s * 2] === 255;
      const isEmpty = f.colour[s] === 255;
      // a slot that just appeared starts where it is (no streak from a previous occupant)
      this.prevXY[s * 2] = wasEmpty ? f.x[s]! : this.curXY[s * 2]!;
      this.prevXY[s * 2 + 1] = wasEmpty ? f.y[s]! : this.curXY[s * 2 + 1]!;
      this.curXY[s * 2] = f.x[s]!;
      this.curXY[s * 2 + 1] = f.y[s]!;
      this.attr[s * 2] = f.colour[s]!;
      this.attr[s * 2 + 1] = f.glow[s]!;
      if (!isEmpty) live++;
    }
    this.n = n;
    this.stats.live = live;
    const gl = this.gl;
    if (!gl) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPrev);
    gl.bufferData(gl.ARRAY_BUFFER, this.prevXY.subarray(0, n * 2), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufCur);
    gl.bufferData(gl.ARRAY_BUFFER, this.curXY.subarray(0, n * 2), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufAttr);
    gl.bufferData(gl.ARRAY_BUFFER, this.attr.subarray(0, n * 2), gl.DYNAMIC_DRAW);
  }

  render(nowMs: number, cam: Camera): void {
    const gl = this.gl;
    if (!gl || !this.bg || !this.dots) return;
    const ppm = 2 ** cam.zeta;
    const halfW = this.widthPx / (2 * ppm);
    const halfH = this.heightPx / (2 * ppm);
    const view = [cam.cx - halfW, cam.cy - halfH, cam.cx + halfW, cam.cy + halfH] as const;
    const t = nowMs / 1000;
    gl.viewport(0, 0, this.widthPx, this.heightPx);
    gl.disable(gl.BLEND);
    gl.useProgram(this.bg);
    gl.uniform4f(gl.getUniformLocation(this.bg, 'u_view'), view[0], view[1], view[2], view[3]);
    gl.uniform2f(gl.getUniformLocation(this.bg, 'u_tank'), this.tank.w, this.tank.h);
    gl.uniform1f(gl.getUniformLocation(this.bg, 'u_time'), t);
    gl.uniform1f(gl.getUniformLocation(this.bg, 'u_dayRange'), this.profile.dayNightRange);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (this.n > 0) {
      const interp = Math.min(1, (nowMs - this.lastFrameAt) / Math.max(16, this.frameInterval));
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.dots);
      gl.uniform4f(gl.getUniformLocation(this.dots, 'u_view'), view[0], view[1], view[2], view[3]);
      gl.uniform4f(gl.getUniformLocation(this.dots, 'u_rect'), this.rect[0], this.rect[1], this.rect[2], this.rect[3]);
      gl.uniform1f(gl.getUniformLocation(this.dots, 'u_t'), interp);
      gl.uniform1f(gl.getUniformLocation(this.dots, 'u_time'), t);
      gl.uniform1f(gl.getUniformLocation(this.dots, 'u_pxPerM'), ppm);
      gl.uniform1f(gl.getUniformLocation(this.dots, 'u_dpr'), Math.max(1, this.widthPx / 1280));
      gl.uniform1f(gl.getUniformLocation(this.dots, 'u_maxPulseHz'), this.profile.maxPulseHz);
      gl.uniform3fv(gl.getUniformLocation(this.dots, 'u_palette'), this.palette);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.POINTS, 0, this.n);
      gl.bindVertexArray(null);
    }
    this.stats.rendered++;
  }
}

export function createRenderer(canvas: HTMLCanvasElement, mode: ViewMode): WebGL2Renderer {
  return new WebGL2Renderer(canvas, mode);
}
