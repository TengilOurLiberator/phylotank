/**
 * QR code encoder (ISO/IEC 18004), byte mode, error correction L or M, versions 1 to 40, written
 * here so sharing works offline with no dependency. Follows the standard construction: function
 * patterns, Reed-Solomon over GF(256) with 0x11D, block interleaving, the zigzag data placement,
 * the eight masks with a penalty score, BCH-coded format and version bits.
 */
export type Ecc = 'L' | 'M';
const ECC_PER_BLOCK: Record<Ecc, number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
};
const NUM_BLOCKS: Record<Ecc, number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
};
const FORMAT_BITS: Record<Ecc, number> = { L: 1, M: 0 };

export function rawDataModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const na = Math.floor(ver / 7) + 2; r -= (25 * na - 10) * na - 55; if (ver >= 7) r -= 36; }
  return r;
}
export function dataCodewords(ver: number, ecc: Ecc): number {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecc][ver]! * NUM_BLOCKS[ecc][ver]!;
}
/** Largest byte payload per version. */
export function byteCapacity(ver: number, ecc: Ecc): number {
  const bits = dataCodewords(ver, ecc) * 8 - 4 - (ver < 10 ? 8 : 16);
  return Math.floor(bits / 8);
}

export function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z & 0xff;
}
export function rsDivisor(degree: number): number[] {
  const r = new Array(degree).fill(0) as number[];
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j]!, root); if (j + 1 < r.length) r[j]! ^= r[j + 1]!; }
    root = gfMul(root, 2);
  }
  return r;
}
export function rsRemainder(data: readonly number[], div: readonly number[]): number[] {
  const r = new Array(div.length).fill(0) as number[];
  for (const b of data) {
    const f = b ^ r.shift()!;
    r.push(0);
    div.forEach((c, i) => { r[i]! ^= gfMul(c, f); });
  }
  return r;
}

export interface Qr { version: number; size: number; ecc: Ecc; mask: number; modules: boolean[][] }

export function encodeQr(data: Uint8Array, ecc: Ecc = 'L'): Qr {
  let ver = 1;
  while (ver <= 40 && byteCapacity(ver, ecc) < data.length) ver++;
  if (ver > 40) throw new Error('data too long for a QR code');
  // bit stream
  const bits: number[] = [];
  const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4);
  put(data.length, ver < 10 ? 8 : 16);
  for (const b of data) put(b, 8);
  const cap = dataCodewords(ver, ecc) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const cw: number[] = [];
  for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]!; cw.push(v); }
  const all = interleave(cw, ver, ecc);
  const size = ver * 4 + 17;
  const mods: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false) as boolean[]);
  const fn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false) as boolean[]);
  const setF = (x: number, y: number, dark: boolean) => { mods[y]![x] = dark; fn[y]![x] = true; };
  drawFunction(ver, size, setF);
  drawFormat(0, ecc, size, setF);
  // data
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const up = ((right + 1) & 2) === 0;
        const y = up ? size - 1 - vert : vert;
        if (!fn[y]![x] && i < all.length * 8) { mods[y]![x] = ((all[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }
  }
  let best = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(mods, fn, m);
    drawFormat(m, ecc, size, setF);
    const s = penalty(mods);
    if (s < bestScore) { bestScore = s; best = m; }
    applyMask(mods, fn, m);
  }
  applyMask(mods, fn, best);
  drawFormat(best, ecc, size, setF);
  return { version: ver, size, ecc, mask: best, modules: mods };
}

function interleave(data: number[], ver: number, ecc: Ecc): number[] {
  const nb = NUM_BLOCKS[ecc][ver]!, el = ECC_PER_BLOCK[ecc][ver]!;
  const raw = Math.floor(rawDataModules(ver) / 8);
  const nShort = nb - (raw % nb);
  const shortLen = Math.floor(raw / nb);
  const div = rsDivisor(el);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = data.slice(k, k + shortLen - el + (i < nShort ? 0 : 1));
    k += dat.length;
    const e = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(e));
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) blocks.forEach((b, j) => { if (i !== shortLen - el || j >= nShort) out.push(b[i]!); });
  return out;
}

export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const na = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (na * 2 - 2)) * 2;
  const r = [6];
  for (let pos = ver * 4 + 10; r.length < na; pos -= step) r.splice(1, 0, pos);
  return r;
}

function drawFunction(ver: number, size: number, set: (x: number, y: number, d: boolean) => void): void {
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  const ap = alignmentPositions(ver);
  const n = ap.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ap[i]! + dx, ap[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, bit); set(b, a, bit);
    }
  }
}

export function formatBits(mask: number, ecc: Ecc): number {
  const data = (FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
function drawFormat(mask: number, ecc: Ecc, size: number, set: (x: number, y: number, d: boolean) => void): void {
  const bits = formatBits(mask, ecc);
  const b = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, b(i));
  set(8, 7, b(6)); set(8, 8, b(7)); set(7, 8, b(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, b(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, b(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, b(i));
  set(8, size - 8, true);
}

function maskBit(m: number, x: number, y: number): boolean {
  switch (m) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}
function applyMask(mods: boolean[][], fn: boolean[][], m: number): void {
  for (let y = 0; y < mods.length; y++) for (let x = 0; x < mods.length; x++) if (!fn[y]![x] && maskBit(m, x, y)) mods[y]![x] = !mods[y]![x];
}
/** Penalty rules N1 (runs), N2 (2x2 blocks) and N4 (balance); N3 is omitted (any mask decodes). */
function penalty(mods: boolean[][]): number {
  const n = mods.length;
  let s = 0, dark = 0;
  for (let y = 0; y < n; y++) {
    let runX = 1, runY = 1;
    for (let x = 0; x < n; x++) {
      if (mods[y]![x]) dark++;
      if (x > 0) {
        if (mods[y]![x] === mods[y]![x - 1]) { runX++; if (runX === 5) s += 3; else if (runX > 5) s++; } else runX = 1;
        if (mods[x]![y] === mods[x - 1]![y]) { runY++; if (runY === 5) s += 3; else if (runY > 5) s++; } else runY = 1;
      }
      if (x > 0 && y > 0) { const c = mods[y]![x]; if (c === mods[y]![x - 1] && c === mods[y - 1]![x] && c === mods[y - 1]![x - 1]) s += 3; }
    }
  }
  const k = Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1;
  return s + Math.max(0, k) * 10;
}

/** Draw a QR code with a 4-module quiet zone. */
export function drawQr(ctx: CanvasRenderingContext2D, qr: Qr, px: number): void {
  const n = qr.size + 8;
  const s = Math.max(1, Math.floor(px / n));
  ctx.canvas.width = ctx.canvas.height = s * n;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, s * n, s * n);
  ctx.fillStyle = '#000';
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.modules[y]![x]) ctx.fillRect((x + 4) * s, (y + 4) * s, s, s);
}
