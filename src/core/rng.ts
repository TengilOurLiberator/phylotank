/**
 * Philox4x32-10 counter-based RNG (Random123, Salmon et al. 2011), CONTRACT 4.1.
 *
 * key     = [seedLo ^ streamId, seedHi]
 * counter = [tick >>> 0, subjectLo, subjectHi, drawIndex]
 *
 * There is no shared mutable RNG state in the sim: a draw is a pure function of
 * (seed, stream, tick, subject, drawIndex). The same function will exist in WGSL.
 */
import { cos, log, sin, TAU } from './dmath.js';

const M0 = 0xd2511f53;
const M1 = 0xcd9e8d57;
const W0 = 0x9e3779b9;
const W1 = 0xbb67ae85;

/** High 32 bits of the 64-bit product of two u32 values. */
export function mulhi32(a: number, b: number): number {
  const aLo = a & 0xffff;
  const aHi = a >>> 16;
  const bLo = b & 0xffff;
  const bHi = b >>> 16;
  const ll = aLo * bLo;
  const lh = aLo * bHi;
  const hl = aHi * bLo;
  const hh = aHi * bHi;
  const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);
  return (hh + (lh >>> 16) + (hl >>> 16) + (mid >>> 16)) >>> 0;
}

/** Philox4x32-10. Writes 4 u32 words into out[0..3]. */
export function philox4x32(
  c0: number, c1: number, c2: number, c3: number, k0: number, k1: number, out: Uint32Array,
): void {
  let x0 = c0 >>> 0, x1 = c1 >>> 0, x2 = c2 >>> 0, x3 = c3 >>> 0;
  let a = k0 >>> 0, b = k1 >>> 0;
  for (let round = 0; round < 10; round++) {
    if (round > 0) { a = (a + W0) >>> 0; b = (b + W1) >>> 0; }
    const hi0 = mulhi32(M0, x0);
    const lo0 = Math.imul(M0, x0) >>> 0;
    const hi1 = mulhi32(M1, x2);
    const lo1 = Math.imul(M1, x2) >>> 0;
    x0 = (hi1 ^ x1 ^ a) >>> 0;
    x1 = lo1;
    x2 = (hi0 ^ x3 ^ b) >>> 0;
    x3 = lo0;
  }
  out[0] = x0; out[1] = x1; out[2] = x2; out[3] = x3;
}

const TWO_POW_32 = 4294967296;
const TWO_POW_M24 = 1 / 16777216;
const TWO_POW_M53 = 1 / 9007199254740992;

/** Split a non-negative safe integer into [lo, hi] u32 words. */
export function splitU64(n: number): [number, number] {
  return [n % TWO_POW_32 >>> 0, Math.floor(n / TWO_POW_32) >>> 0];
}

/** A key for one RNG stream of one world. */
export class RngStream {
  readonly k0: number;
  readonly k1: number;
  constructor(seedLo: number, seedHi: number, readonly streamId: number) {
    this.k0 = (seedLo ^ streamId) >>> 0;
    this.k1 = seedHi >>> 0;
  }
  /** Open a cursor over the draws of one subject in one tick. */
  draw(tick: number, subject: number): Draw {
    return new Draw(this, tick, subject);
  }
  /** Raw block access, for kernels that index draws directly. */
  block(tick: number, subject: number, drawIndex: number, out: Uint32Array): void {
    const [lo, hi] = splitU64(subject);
    philox4x32(tick >>> 0, lo, hi, drawIndex >>> 0, this.k0, this.k1, out);
  }
}

/** Sequential cursor over (stream, tick, subject). Deterministic, allocation-free after creation. */
export class Draw {
  private readonly buf = new Uint32Array(4);
  private idx = 4;
  private block = 0;
  private readonly sLo: number;
  private readonly sHi: number;
  private spare = NaN;
  constructor(private readonly s: RngStream, private readonly tick: number, subject: number) {
    const [lo, hi] = splitU64(subject);
    this.sLo = lo;
    this.sHi = hi;
  }
  u32(): number {
    if (this.idx === 4) {
      philox4x32(this.tick >>> 0, this.sLo, this.sHi, this.block++, this.s.k0, this.s.k1, this.buf);
      this.idx = 0;
    }
    return this.buf[this.idx++]!;
  }
  /** Uniform in [0, 1) with 24 bits (matches the WGSL conversion). */
  u01(): number { return (this.u32() >>> 8) * TWO_POW_M24; }
  /** Uniform in [0, 1) with 53 bits. */
  u01x53(): number {
    const a = this.u32() >>> 5;
    const b = this.u32() >>> 6;
    return (a * 67108864 + b) * TWO_POW_M53;
  }
  /** Integer in [0, n). */
  int(n: number): number { return Math.floor(this.u01x53() * n); }
  bool(p = 0.5): boolean { return this.u01() < p; }
  /** Standard normal by Box-Muller with deterministic math. */
  normal(): number {
    if (this.spare === this.spare) { const v = this.spare; this.spare = NaN; return v; }
    const u1 = 1 - this.u01x53();
    const u2 = this.u01x53();
    const r = Math.sqrt(-2 * log(u1));
    const t = TAU * u2;
    this.spare = r * sin(t);
    return r * cos(t);
  }
}

/** All sim streams of one world, created once. */
export class RngStreams {
  private readonly cache = new Map<number, RngStream>();
  constructor(readonly seedLo: number, readonly seedHi: number) {}
  stream(id: number): RngStream {
    let s = this.cache.get(id);
    if (!s) { s = new RngStream(this.seedLo, this.seedHi, id); this.cache.set(id, s); }
    return s;
  }
  draw(streamId: number, tick: number, subject: number): Draw {
    return this.stream(streamId).draw(tick, subject);
  }
}
