/** Thin WebGL2 helpers: programs with cached uniforms, textures and framebuffers. */

export class Program {
  readonly p: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();
  constructor(readonly gl: WebGL2RenderingContext, vs: string, fs: string, readonly name: string) {
    const mk = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${name} shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name} link: ${gl.getProgramInfoLog(p)}`);
    this.p = p;
  }
  use(): this { this.gl.useProgram(this.p); return this; }
  loc(n: string): WebGLUniformLocation | null {
    let l = this.locs.get(n);
    if (l === undefined) { l = this.gl.getUniformLocation(this.p, n); this.locs.set(n, l); }
    return l;
  }
  f1(n: string, a: number): this { this.gl.uniform1f(this.loc(n), a); return this; }
  f2(n: string, a: number, b: number): this { this.gl.uniform2f(this.loc(n), a, b); return this; }
  f4(n: string, a: number, b: number, c: number, d: number): this { this.gl.uniform4f(this.loc(n), a, b, c, d); return this; }
  i1(n: string, a: number): this { this.gl.uniform1i(this.loc(n), a); return this; }
  /** Bind a texture to a unit and point the sampler at it. */
  tex(n: string, unit: number, t: WebGLTexture | null): this {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(this.loc(n), unit);
    return this;
  }
}

export interface Target { tex: WebGLTexture; w: number; h: number }

export function makeTexture(gl: WebGL2RenderingContext, w: number, h: number, internal: number, format: number, type: number, linear: boolean, data: ArrayBufferView | null = null): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
  const f = linear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export class Fbo {
  readonly fb: WebGLFramebuffer;
  constructor(readonly gl: WebGL2RenderingContext, readonly targets: Target[]) {
    this.fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    targets.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t.tex, 0));
    gl.drawBuffers(targets.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incomplete: 0x${st.toString(16)}`);
  }
  bind(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.viewport(0, 0, this.targets[0]!.w, this.targets[0]!.h);
  }
  dispose(): void {
    this.gl.deleteFramebuffer(this.fb);
    for (const t of this.targets) this.gl.deleteTexture(t.tex);
  }
}
