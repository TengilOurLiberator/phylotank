/**
 * Parent-diff encoding of genomes for the snapshot's GENO section (DESIGN R17, CONTRACT 6.8).
 *
 * Canonical genome bytes keep records sorted by innovation id, so a child usually differs from
 * its parent in a few bytes at a few places, plus inserted or deleted records. The patch is a
 * byte-level edit script against the parent:
 *   u32 childLength, then ops: u8 0 COPY u32 parentOffset u32 length | u8 1 INSERT u32 length bytes
 * built greedily: the longest common prefix and suffix are copied, and the middle is matched in
 * 16-byte blocks against a hash of parent blocks (a small rsync). Deterministic and exact; the
 * host owns the section format around it.
 */
const enum Op { COPY = 0, INSERT = 1 }
const BLOCK = 16;

function u32(out: number[], v: number): void { out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); }
function rd32(b: Uint8Array, o: number): number { return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0; }
function blockKey(b: Uint8Array, o: number): string {
  let s = '';
  for (let i = 0; i < BLOCK; i++) s += String.fromCharCode(b[o + i]!);
  return s;
}

export function diffEncode(parent: Uint8Array, child: Uint8Array): Uint8Array {
  const out: number[] = [];
  u32(out, child.length);
  let pre = 0;
  while (pre < parent.length && pre < child.length && parent[pre] === child[pre]) pre++;
  let suf = 0;
  while (suf < parent.length - pre && suf < child.length - pre && parent[parent.length - 1 - suf] === child[child.length - 1 - suf]) suf++;
  if (pre > 0) { out.push(Op.COPY); u32(out, 0); u32(out, pre); }
  // middle: block matching against the parent
  const index = new Map<string, number>();
  for (let o = 0; o + BLOCK <= parent.length; o += BLOCK) { const k = blockKey(parent, o); if (!index.has(k)) index.set(k, o); }
  const end = child.length - suf;
  let lit: number[] = [];
  const flush = (): void => { if (lit.length) { out.push(Op.INSERT); u32(out, lit.length); for (const x of lit) out.push(x); lit = []; } };
  let i = pre;
  while (i < end) {
    const p = i + BLOCK <= end ? index.get(blockKey(child, i)) : undefined;
    if (p === undefined) { lit.push(child[i]!); i++; continue; }
    let len = BLOCK;
    while (i + len < end && p + len < parent.length && child[i + len] === parent[p + len]) len++;
    flush();
    out.push(Op.COPY); u32(out, p); u32(out, len);
    i += len;
  }
  flush();
  if (suf > 0) { out.push(Op.COPY); u32(out, parent.length - suf); u32(out, suf); }
  return Uint8Array.from(out);
}

export function diffDecode(parent: Uint8Array, patch: Uint8Array): Uint8Array {
  const n = rd32(patch, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (let i = 4; i < patch.length;) {
    const op = patch[i++]!;
    if (op === Op.COPY) {
      const at = rd32(patch, i), len = rd32(patch, i + 4); i += 8;
      if (at + len > parent.length || o + len > n) throw new Error('bad genome patch');
      out.set(parent.subarray(at, at + len), o); o += len;
    } else if (op === Op.INSERT) {
      const len = rd32(patch, i); i += 4;
      if (i + len > patch.length || o + len > n) throw new Error('bad genome patch');
      out.set(patch.subarray(i, i + len), o); o += len; i += len;
    } else throw new Error('bad genome patch op');
  }
  if (o !== n) throw new Error('genome patch length mismatch');
  return out;
}
