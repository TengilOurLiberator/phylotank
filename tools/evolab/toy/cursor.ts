/**
 * A reusable Philox cursor over (stream, tick, subject): the same draws as src/core/rng's `Draw`
 * (u32 blocks in drawIndex order, the same u01 conversion) without allocating per creature per step.
 */
import { philox4x32, splitU64, type RngStream } from '../../../src/core/rng.js';

const TWO_POW_M24 = 1 / 16777216;

export class Cursor {
  private readonly buf = new Uint32Array(4);
  private idx = 4;
  private block = 0;
  private tick = 0;
  private sLo = 0;
  private sHi = 0;
  constructor(private readonly s: RngStream) {}
  reset(tick: number, subject: number): this {
    const [lo, hi] = splitU64(subject);
    this.sLo = lo; this.sHi = hi; this.tick = tick >>> 0; this.idx = 4; this.block = 0;
    return this;
  }
  u32(): number {
    if (this.idx === 4) {
      philox4x32(this.tick, this.sLo, this.sHi, this.block++, this.s.k0, this.s.k1, this.buf);
      this.idx = 0;
    }
    return this.buf[this.idx++]!;
  }
  u01(): number { return (this.u32() >>> 8) * TWO_POW_M24; }
}
