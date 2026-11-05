/**
 * A 64 x 64 blue-noise threshold map by void and cluster (Ulichney 1993), generated once at
 * start-up so the repo ships no binary asset. Deterministic (a fixed LCG seeds the initial
 * pattern). Values are ranks 0..4095 scaled to 0..255.
 */
let cached: Uint8Array | null = null;

export function blueNoise64(): Uint8Array {
  if (cached) return cached;
  const W = 64, N = W * W;
  const sigma = 1.5;
  // toroidal gaussian energy kernel
  const lut = new Float32Array(N);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const dx = Math.min(x, W - x), dy = Math.min(y, W - y);
    lut[y * W + x] = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
  }
  const energy = new Float32Array(N);
  const on = new Uint8Array(N);
  const splat = (i: number, s: number): void => {
    const ix = i % W, iy = (i / W) | 0;
    for (let y = 0; y < W; y++) {
      const ry = ((y - iy + W) % W) * W;
      const row = y * W;
      for (let x = 0; x < W; x++) energy[row + x]! += s * lut[ry + ((x - ix + W) % W)]!;
    }
  };
  const argExt = (wantOn: number, max: boolean): number => {
    let best = -1, bv = max ? -Infinity : Infinity;
    for (let i = 0; i < N; i++) {
      if (on[i] !== wantOn) continue;
      const e = energy[i]!;
      if (max ? e > bv : e < bv) { bv = e; best = i; }
    }
    return best;
  };
  // initial pattern: about 10% on, from a fixed LCG
  let seed = 0x2545f491;
  const rnd = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const initial = Math.floor(N * 0.1);
  let count = 0;
  while (count < initial) {
    const i = Math.floor(rnd() * N);
    if (!on[i]) { on[i] = 1; splat(i, 1); count++; }
  }
  // relax: move the tightest cluster into the largest void until stable
  for (let iter = 0; iter < 200; iter++) {
    const c = argExt(1, true);
    on[c] = 0; splat(c, -1);
    const v = argExt(0, false);
    if (v === c) { on[c] = 1; splat(c, 1); break; }
    on[v] = 1; splat(v, 1);
  }
  const rank = new Int32Array(N).fill(-1);
  const proto = on.slice();
  const protoE = energy.slice();
  // phase 1: rank the initial points by removing the tightest cluster
  for (let r = count - 1; r >= 0; r--) {
    const c = argExt(1, true);
    on[c] = 0; splat(c, -1);
    rank[c] = r;
  }
  // phase 2 and 3: from the initial pattern, fill the largest void
  on.set(proto); energy.set(protoE);
  for (let r = count; r < N; r++) {
    const v = argExt(0, false);
    on[v] = 1; splat(v, 1);
    rank[v] = r;
  }
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) out[i] = Math.floor((rank[i]! * 256) / N);
  cached = out;
  return out;
}
