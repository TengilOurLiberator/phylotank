/**
 * Habitat presets and the terrain distance field (04 §4.1).
 *
 * The generator writes `material` on the SDF grid (0.125 m), validates it (flood fill from the
 * surface, every habitat class present) and builds the signed distance field with an exact
 * Euclidean distance transform (Felzenszwalb and Huttenlocher 2012), which uses only + - * /,
 * sqrt and floor, so it is deterministic on every engine. Terrain edits (craters, mounds,
 * barriers, ice) rewrite `material` and call `rebuildSdf`.
 */
import { clamp, hash32, MATERIAL, smoothstep, type World } from '../core/index.js';

export type HabitatName = 'basin' | 'lagoon' | 'twinBasins' | 'open';
/** 'open' is a flat, featureless tank for tests and uniform-world experiments. */
export const HABITATS: readonly HabitatName[] = ['basin', 'lagoon', 'twinBasins', 'open'];

export interface Vent { x: number; y: number; bornTick: number; output: number; permanent: boolean }
export interface TerrainInfo {
  habitat: HabitatName;
  /** Floor depth (m) per SDF column. */
  floorY: Float64Array;
  vents: Vent[];
  /** Shelf edge and trench start, as x in metres. */
  shelfEndX: number; trenchX: number;
  caves: { x: number; y: number; r: number }[];
  classes: { shelf: boolean; cave: boolean; plain: boolean; vent: boolean };
  /** Warm-water offset of the habitat (lagoon), C. */
  tOffset: number;
}

/** Value noise in [0, 1) from the world seed, lattice spacing 1. */
function vnoise1(seed: number, oct: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash32(seed, oct, i) / 4294967296;
  const b = hash32(seed, oct, i + 1) / 4294967296;
  const t = f * f * (3 - 2 * f);
  return a + (b - a) * t;
}
function fbm1(seed: number, x: number, octaves = 4): number {
  let s = 0, amp = 1, norm = 0, fx = x;
  for (let o = 0; o < octaves; o++) { s += amp * (vnoise1(seed, o, fx) * 2 - 1); norm += amp; amp *= 0.5; fx *= 2; }
  return s / norm;
}
function vnoise2(seed: number, x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const h = (a: number, b: number): number => hash32(seed, a, b) / 4294967296;
  const tx = fx * fx * (3 - 2 * fx), ty = fy * fy * (3 - 2 * fy);
  const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** Piecewise floor profile as a fraction of H, per habitat (Default numbers of 04 scaled to H). */
function floorFrac(habitat: HabitatName, u: number): number {
  const seg = (pts: readonly (readonly [number, number])[]): number => {
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1]!, [x1, y1] = pts[i]!;
      if (u <= x1) return y0 + (y1 - y0) * smoothstep(x0, x1, u);
    }
    return pts[pts.length - 1]![1];
  };
  switch (habitat) {
    case 'basin': // shelf 6-9 m, slope with caves, plain 28-31 m, trench 34-36 m (of 36)
      return seg([[0, 0.17], [0.3, 0.24], [0.42, 0.55], [0.55, 0.8], [0.76, 0.84], [0.8, 0.95], [0.92, 0.96], [0.97, 0.8], [1, 0.75]]);
    case 'lagoon': // warm and shallow, no trench
      return seg([[0, 0.2], [0.35, 0.3], [0.55, 0.45], [0.85, 0.5], [1, 0.4]]);
    case 'open': return 0.985;
    case 'twinBasins': // a sill divides the tank (allopatric speciation)
      return seg([[0, 0.2], [0.15, 0.3], [0.3, 0.8], [0.45, 0.82], [0.5, 0.4], [0.55, 0.82], [0.7, 0.8], [0.85, 0.95], [1, 0.8]]);
  }
}

function sdfIndex(world: World): { w: number; h: number; cs: number } {
  const [w, h] = world.fields.sdfGrid;
  return { w, h, cs: world.preset.widthM / w };
}

/** Generate terrain into world.fields.material and .sdf. Deterministic from the world seed. */
export function generateTerrain(world: World, habitat: HabitatName): TerrainInfo {
  const { w, h, cs } = sdfIndex(world);
  const W = world.preset.widthM, H = world.preset.heightM;
  const scale = H / 36;
  const mat = world.fields.material;
  const seed = hash32(world.g.seedLo, world.g.seedHi, 0x7e44a1) >>> 0;
  const floorY = new Float64Array(w);
  for (let ix = 0; ix < w; ix++) {
    const x = (ix + 0.5) * cs;
    floorY[ix] = floorFrac(habitat, x / W) * H + (habitat === 'open' ? 0 : 0.6 * scale * fbm1(seed, x / (3 * scale)));
  }
  // Base fill: rock below the floor, irregular side walls.
  for (let iy = 0; iy < h; iy++) {
    const y = (iy + 0.5) * cs;
    const open = habitat === 'open';
    const wl = open ? 0.1 : (0.5 + 0.75 * (1 + fbm1(seed ^ 0x1111, y / (2 * scale)))) * scale;
    const wr = open ? 0.1 : (0.5 + 0.75 * (1 + fbm1(seed ^ 0x2222, y / (2 * scale)))) * scale;
    for (let ix = 0; ix < w; ix++) {
      const x = (ix + 0.5) * cs;
      const rock = y > floorY[ix]! || x < wl || x > W - wr;
      mat[iy * w + ix] = rock ? MATERIAL.ROCK : MATERIAL.WATER;
    }
  }
  const shelfEndX = (habitat === 'twinBasins' ? 0.15 : 0.3) * W;
  const trenchX = (habitat === 'lagoon' ? 1.1 : 0.8) * W;
  // Caves: metaballs carved into the slope, each with a tunnel to open water (04 §4.1 step 3).
  const caves: TerrainInfo['caves'] = [];
  if (habitat !== 'lagoon' && habitat !== 'open') {
    const nCaves = 6 + (hash32(seed, 3, 0) % 7);
    const slopeX0 = (habitat === 'basin' ? 0.32 : 0.17) * W, slopeX1 = (habitat === 'basin' ? 0.56 : 0.3) * W;
    for (let k = 0; k < nCaves; k++) {
      const r1 = hash32(seed, 4, k) / 4294967296, r2 = hash32(seed, 5, k) / 4294967296, r3 = hash32(seed, 6, k) / 4294967296;
      const cx = slopeX0 + (slopeX1 - slopeX0) * r1;
      const fy = floorY[clamp(Math.floor(cx / cs), 0, w - 1)]!;
      const r = (k === 0 ? 0.35 : 0.6 + 0.9 * r2) * scale;
      const cy = fy + r + (0.5 + 1.5 * r3) * scale;
      if (cy + r > H - 0.5) continue;
      const tunnel = (k === 0 ? 0.15 : 0.3 + 0.3 * r3) * Math.max(scale, 0.5);
      carveCircle(world, cx, cy, r);
      // tunnel up and to the right towards open water, until it reaches water
      let tx = cx, ty = cy;
      for (let step = 0; step < 200; step++) {
        tx += 0.5 * cs; ty -= 0.6 * cs;
        carveCircle(world, tx, ty, tunnel);
        const j = clamp(Math.floor(ty / cs), 0, h - 1) * w + clamp(Math.floor(tx / cs), 0, w - 1);
        if (ty < floorY[clamp(Math.floor(tx / cs), 0, w - 1)]! - tunnel && mat[j] === MATERIAL.WATER) break;
      }
      caves.push({ x: cx, y: cy, r });
    }
    // Overhangs: 2D noise threshold just above the slope
    for (let iy = 0; iy < h; iy++) {
      const y = (iy + 0.5) * cs;
      for (let ix = 0; ix < w; ix++) {
        const x = (ix + 0.5) * cs;
        if (x < slopeX0 || x > slopeX1) continue;
        const above = floorY[ix]! - y;
        if (above > 0 && above < 1.2 * scale && vnoise2(seed ^ 0x3333, x / (0.8 * scale), y / (0.8 * scale)) > 0.78) {
          mat[iy * w + ix] = MATERIAL.ROCK;
        }
      }
    }
  }
  floodFillSeal(world);
  // Surface materials: sand on the shelf, reef patches, mud on the plain, rock elsewhere.
  for (let iy = 1; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      const i = iy * w + ix;
      if (mat[i] === MATERIAL.WATER || mat[i - w] !== MATERIAL.WATER) continue;
      const x = (ix + 0.5) * cs;
      if (x < shelfEndX) mat[i] = vnoise2(seed ^ 0x4444, x / (1.5 * scale), 0) > 0.55 ? MATERIAL.REEF : MATERIAL.SAND;
      else if (x > shelfEndX + 0.25 * W && x < trenchX) mat[i] = MATERIAL.MUD;
    }
  }
  // Vents on the trench floor, at least 4 m apart (scaled).
  const vents: Vent[] = [];
  if (habitat !== 'lagoon' && habitat !== 'open') {
    const nV = 1 + (hash32(seed, 7, 0) % 3);
    const x0 = trenchX + 0.5, x1 = Math.min(0.96 * W, trenchX + 0.14 * W);
    for (let k = 0; k < nV * 8 && vents.length < nV; k++) {
      const x = x0 + (x1 - x0) * (hash32(seed, 8, k) / 4294967296);
      if (vents.some((v) => Math.abs(v.x - x) < 4 * scale)) continue;
      const ix = clamp(Math.floor(x / cs), 0, w - 1);
      const iy = surfaceRow(world, ix);
      if (iy < 0) continue;
      mat[iy * w + ix] = MATERIAL.VENT;
      vents.push({ x: (ix + 0.5) * cs, y: iy * cs, bornTick: 0, output: 1, permanent: true });
    }
  }
  rebuildSdf(world);
  const info: TerrainInfo = {
    habitat, floorY, vents, shelfEndX, trenchX, caves,
    classes: { shelf: habitat !== 'open', cave: caves.length > 0, plain: habitat !== 'lagoon', vent: vents.length > 0 },
    tOffset: habitat === 'lagoon' ? 4 : 0,
  };
  return info;
}

/** First rock row below water in an SDF column, scanning down from the surface (-1 if none). */
export function surfaceRow(world: World, ix: number): number {
  const { w, h } = sdfIndex(world);
  const mat = world.fields.material;
  for (let iy = 1; iy < h; iy++) if (mat[iy * w + ix] !== MATERIAL.WATER && mat[(iy - 1) * w + ix] === MATERIAL.WATER) return iy;
  return -1;
}

export function carveCircle(world: World, x: number, y: number, r: number, to: number = MATERIAL.WATER): void {
  paintCircle(world, x, y, r, to, true);
}

/** Write `m` into every SDF cell within r of (x, y). With onlyRock, water cells are left alone. */
export function paintCircle(world: World, x: number, y: number, r: number, m: number, onlyRock = false, onlyWater = false): number {
  const { w, h, cs } = sdfIndex(world);
  const mat = world.fields.material;
  const ix0 = clamp(Math.floor((x - r) / cs), 0, w - 1), ix1 = clamp(Math.floor((x + r) / cs), 0, w - 1);
  const iy0 = clamp(Math.floor((y - r) / cs), 0, h - 1), iy1 = clamp(Math.floor((y + r) / cs), 0, h - 1);
  let n = 0;
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const dx = (ix + 0.5) * cs - x, dy = (iy + 0.5) * cs - y;
      if (dx * dx + dy * dy > r * r) continue;
      const i = iy * w + ix;
      const isWater = mat[i] === MATERIAL.WATER;
      if (onlyRock && isWater) continue;
      if (onlyWater && !isWater) continue;
      if (ix === 0 || ix === w - 1 || iy === h - 1) if (m === MATERIAL.WATER) continue; // keep the tank sealed
      mat[i] = m;
      n++;
    }
  }
  return n;
}

/** Any water cell not 4-connected to the open surface row becomes rock (no sealed pockets). */
export function floodFillSeal(world: World): void {
  const { w, h } = sdfIndex(world);
  const mat = world.fields.material;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let ix = 0; ix < w; ix++) if (mat[ix] === MATERIAL.WATER) { seen[ix] = 1; stack.push(ix); }
  while (stack.length > 0) {
    const i = stack.pop()!;
    const ix = i % w, iy = (i - ix) / w;
    const nb = [ix > 0 ? i - 1 : -1, ix < w - 1 ? i + 1 : -1, iy > 0 ? i - w : -1, iy < h - 1 ? i + w : -1];
    for (const j of nb) if (j >= 0 && !seen[j] && mat[j] === MATERIAL.WATER) { seen[j] = 1; stack.push(j); }
  }
  for (let i = 0; i < w * h; i++) if (mat[i] === MATERIAL.WATER && !seen[i]) mat[i] = MATERIAL.ROCK;
}

const INF = 1e20;
/** 1D squared distance transform of f (Felzenszwalb and Huttenlocher), in place into d. */
function dt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) { k--; s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dq = q - v[k]!;
    d[q] = dq * dq + f[v[k]!]!;
  }
}
/** Exact squared Euclidean distance (in cells) to the nearest cell where mask is 1. */
function edt2(mask: Uint8Array, w: number, h: number): Float64Array {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const out = new Float64Array(w * h);
  for (let ix = 0; ix < w; ix++) {
    for (let iy = 0; iy < h; iy++) f[iy] = mask[iy * w + ix] ? 0 : INF;
    dt1(f, h, d, v, z);
    for (let iy = 0; iy < h; iy++) out[iy * w + ix] = d[iy]!;
  }
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) f[ix] = out[iy * w + ix]!;
    dt1(f, w, d, v, z);
    for (let ix = 0; ix < w; ix++) out[iy * w + ix] = d[ix]!;
  }
  return out;
}

/** Rebuild the signed distance field from `material` (positive in water, negative in solid). */
export function rebuildSdf(world: World): void {
  const { w, h, cs } = sdfIndex(world);
  const mat = world.fields.material;
  const solid = new Uint8Array(w * h), water = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) { if (mat[i] === MATERIAL.WATER) water[i] = 1; else solid[i] = 1; }
  const dOut = edt2(solid, w, h), dIn = edt2(water, w, h);
  const sdf = world.fields.sdf;
  for (let i = 0; i < w * h; i++) {
    sdf[i] = water[i] ? (Math.sqrt(dOut[i]!) - 0.5) * cs : -(Math.sqrt(dIn[i]!) - 0.5) * cs;
  }
}

/** Bilinear SDF sample at (x, y) with its gradient (per metre), written to out[0..2]. */
export function sampleSdf(world: World, x: number, y: number, out: Float64Array): void {
  const { w, h, cs } = sdfIndex(world);
  const s = world.fields.sdf;
  let gx = x / cs - 0.5, gy = y / cs - 0.5;
  gx = gx < 0 ? 0 : gx > w - 1.000001 ? w - 1.000001 : gx;
  gy = gy < 0 ? 0 : gy > h - 1.000001 ? h - 1.000001 : gy;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  const fx = gx - ix, fy = gy - iy;
  const i = iy * w + ix;
  const s00 = s[i]!, s10 = s[i + 1]!, s01 = s[i + w]!, s11 = s[i + w + 1]!;
  out[0] = (s00 * (1 - fx) + s10 * fx) * (1 - fy) + (s01 * (1 - fx) + s11 * fx) * fy;
  out[1] = ((s10 - s00) * (1 - fy) + (s11 - s01) * fy) / cs;
  out[2] = ((s01 - s00) * (1 - fx) + (s11 - s10) * fx) / cs;
}
