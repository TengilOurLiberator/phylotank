/**
 * The world directory (05 §5.4.1): snapshots with atomic writes and retention, and the
 * append-only journal with one CRC per record, flushed per record (05 §5.4.4).
 *
 *   <dir>/snapshots/<kind>-e<epoch>-t<tick>-j<journalSeq>[-<label>].ptk
 *   <dir>/snapshots/pinned/manual-e<epoch>-t<tick>-j<journalSeq>-<label>.ptk     kept forever
 *   <dir>/journal/j<seq>-e<epoch>-t<startTick>.jnl
 *
 * Every snapshot starts a new journal file (its `journalSeq`), so recovery replays exactly the
 * files written after the snapshot it loaded, and EVTQ in the snapshot holds what was already
 * scheduled before it.
 */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { ByteReader, ByteWriter, cborDecode, cborEncode, crc32, type CborValue, type GodEventScheduled } from '../core/index.js';

export type SnapshotKind = 'auto' | 'daily' | 'beforePower' | 'beforeRewind' | 'manual' | 'recovery';
export const SNAPSHOT_KINDS: readonly SnapshotKind[] = ['auto', 'daily', 'beforePower', 'beforeRewind', 'manual', 'recovery'];

export interface SnapshotInfo { id: string; path: string; kind: SnapshotKind; epoch: number; tick: number; journalSeq: number; label?: string; mtimeMs: number }

export type JournalRecord =
  | { kind: 'god'; tick: number; ev: GodEventScheduled }
  | { kind: 'governor'; tick: number; decision: { brainDiv?: 1 | 2 | 3 } }
  | { kind: 'hash'; tick: number; h: string }
  /** Host-side inputs that do not change the sim (speed leases, snapshots, rewinds), for audit. */
  | { kind: 'note'; tick: number; what: string; data?: CborValue };

export interface JournalFile { seq: number; epoch: number; startTick: number; path: string; records: JournalRecord[]; torn: boolean }

export interface Retention {
  keepAuto: number;
  keepDaily: number;
  keepUndo: number;
  undoMaxAgeMs: number;
  maxTotalBytes: number;
}
export const DEFAULT_RETENTION: Retention = {
  keepAuto: 6, keepDaily: 7, keepUndo: 20, undoMaxAgeMs: 7 * 24 * 3600 * 1000, maxTotalBytes: 10 * 1024 ** 3,
};

const SNAP_RE = /^(auto|daily|beforePower|beforeRewind|manual|recovery)-e(\d+)-t(\d+)-j(\d+)(?:-([a-z0-9-]{1,40}))?\.ptk$/;
const JNL_RE = /^j(\d+)-e(\d+)-t(\d+)\.jnl$/;
const JNL_MAGIC = 0x4a4b5450; // 'PTKJ'
const JNL_HEADER = 24;
/** Records larger than this are treated as corruption (commands are capped at 64 KB inbound). */
const MAX_RECORD = 1 << 20;

const pad = (n: number, w: number): string => String(n).padStart(w, '0');
export function sanitiseLabel(s: string): string {
  return s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** Write bytes atomically: tmp file, fsync, rename over the target, fsync the directory. */
export function atomicWrite(path: string, bytes: Uint8Array, dir: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { const dfd = openSync(dir, 'r'); try { fsyncSync(dfd); } finally { closeSync(dfd); } } catch { /* directories cannot be fsynced on Windows */ }
}

export class WorldStore {
  readonly snapDir: string;
  readonly pinnedDir: string;
  readonly jnlDir: string;
  private fd: number | null = null;
  private current: { seq: number; epoch: number; startTick: number } | null = null;

  constructor(readonly dir: string, readonly retention: Retention = DEFAULT_RETENTION) {
    this.snapDir = join(dir, 'snapshots');
    this.pinnedDir = join(this.snapDir, 'pinned');
    this.jnlDir = join(dir, 'journal');
    for (const d of [dir, this.snapDir, this.pinnedDir, this.jnlDir]) mkdirSync(d, { recursive: true });
    // leftovers of a write interrupted by a crash are never valid snapshots
    for (const d of [this.snapDir, this.pinnedDir]) for (const f of readdirSync(d)) if (f.endsWith('.tmp')) rmSync(join(d, f), { force: true });
  }

  // ---------- snapshots ----------
  listSnapshots(): SnapshotInfo[] {
    const out: SnapshotInfo[] = [];
    for (const d of [this.snapDir, this.pinnedDir]) {
      for (const f of readdirSync(d)) {
        const m = SNAP_RE.exec(f);
        if (!m) continue;
        const path = join(d, f);
        out.push({
          id: f.replace(/\.ptk$/, ''), path, kind: m[1] as SnapshotKind, epoch: Number(m[2]), tick: Number(m[3]),
          journalSeq: Number(m[4]), ...(m[5] ? { label: m[5] } : {}), mtimeMs: statSync(path).mtimeMs,
        });
      }
    }
    // newest first: epoch, then tick, then write time
    return out.sort((a, b) => b.epoch - a.epoch || b.tick - a.tick || b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1));
  }

  find(id: string): SnapshotInfo | undefined { return this.listSnapshots().find((s) => s.id === id); }

  writeSnapshot(bytes: Uint8Array, kind: SnapshotKind, epoch: number, tick: number, journalSeq: number, label?: string): SnapshotInfo {
    const lab = label ? sanitiseLabel(label) : '';
    const name = `${kind}-e${pad(epoch, 4)}-t${pad(tick, 12)}-j${pad(journalSeq, 6)}${lab ? `-${lab}` : ''}.ptk`;
    const dir = kind === 'manual' ? this.pinnedDir : this.snapDir;
    const path = join(dir, name);
    atomicWrite(path, bytes, dir);
    this.prune();
    return { id: name.replace(/\.ptk$/, ''), path, kind, epoch, tick, journalSeq, ...(lab ? { label: lab } : {}), mtimeMs: statSync(path).mtimeMs };
  }

  readSnapshot(info: SnapshotInfo): Uint8Array { return new Uint8Array(readFileSync(info.path)); }

  /** Retention (05 §5.4.3, DESIGN R27). Manual snapshots are never evicted. */
  prune(nowMs = Date.now()): string[] {
    const r = this.retention;
    const all = this.listSnapshots();
    const removed: string[] = [];
    const drop = (s: SnapshotInfo): void => { rmSync(s.path, { force: true }); removed.push(s.id); };
    const byKind = (k: SnapshotKind): SnapshotInfo[] => all.filter((s) => s.kind === k);
    byKind('auto').slice(r.keepAuto).forEach(drop);
    byKind('recovery').slice(2).forEach(drop);
    byKind('daily').slice(r.keepDaily).forEach(drop);
    for (const k of ['beforePower', 'beforeRewind'] as const) {
      byKind(k).forEach((s, i) => { if (i >= r.keepUndo || nowMs - s.mtimeMs > r.undoMaxAgeMs) drop(s); });
    }
    // total size cap: oldest unpinned first, never the newest snapshot
    let left = this.listSnapshots();
    let total = left.reduce((a, s) => a + statSync(s.path).size, 0);
    const evictable = left.filter((s) => s.kind !== 'manual').slice(1).reverse();
    for (const s of evictable) {
      if (total <= r.maxTotalBytes) break;
      total -= statSync(s.path).size;
      drop(s);
    }
    // journal files older than every remaining snapshot's journal can go
    left = this.listSnapshots();
    if (left.length > 0) {
      const minSeq = Math.min(...left.map((s) => s.journalSeq));
      for (const j of this.listJournals()) if (j.seq < minSeq && j.seq !== this.current?.seq) rmSync(j.path, { force: true });
    }
    return removed;
  }

  // ---------- journal ----------
  listJournals(): { seq: number; epoch: number; startTick: number; path: string }[] {
    return readdirSync(this.jnlDir).flatMap((f) => {
      const m = JNL_RE.exec(f);
      return m ? [{ seq: Number(m[1]), epoch: Number(m[2]), startTick: Number(m[3]), path: join(this.jnlDir, f) }] : [];
    }).sort((a, b) => a.seq - b.seq);
  }

  nextSeq(): number {
    const js = this.listJournals();
    return Math.max(this.current?.seq ?? 0, js.length ? js[js.length - 1]!.seq : 0) + 1;
  }

  /** Close the current journal file and start a new one. Returns its sequence number. */
  rotate(epoch: number, startTick: number): number {
    this.closeJournal();
    const seq = this.nextSeq();
    const path = join(this.jnlDir, `j${pad(seq, 6)}-e${pad(epoch, 4)}-t${pad(startTick, 12)}.jnl`);
    const fd = openSync(path, 'a', 0o600);
    const w = new ByteWriter(JNL_HEADER);
    w.u32(JNL_MAGIC).u32(1).u32(seq).u32(epoch).u64n(startTick);
    writeSync(fd, w.finish());
    fsyncSync(fd);
    this.fd = fd;
    this.current = { seq, epoch, startTick };
    return seq;
  }

  get currentSeq(): number { return this.current?.seq ?? 0; }

  append(rec: JournalRecord): void {
    if (this.fd === null) throw new Error('journal not open');
    const payload = cborEncode(rec as unknown as CborValue);
    const w = new ByteWriter(payload.length + 8);
    w.u32(payload.length).u32(crc32(payload)).bytes(payload);
    writeSync(this.fd, w.finish());
    fsyncSync(this.fd);
  }

  closeJournal(): void {
    if (this.fd !== null) { closeSync(this.fd); this.fd = null; }
  }

  /** Read every journal file; a torn or corrupt tail ends that file's records (crash mid-write). */
  readJournals(): JournalFile[] {
    return this.listJournals().map((j) => ({ ...j, ...readJournalBytes(new Uint8Array(readFileSync(j.path))) }));
  }

  close(): void { this.closeJournal(); }
  exists(): boolean { return existsSync(this.snapDir); }
}

export function readJournalBytes(bytes: Uint8Array): { records: JournalRecord[]; torn: boolean } {
  const records: JournalRecord[] = [];
  if (bytes.length < JNL_HEADER) return { records, torn: bytes.length > 0 };
  const r = new ByteReader(bytes);
  if (r.u32() !== JNL_MAGIC) return { records, torn: true };
  r.skip(JNL_HEADER - 4);
  while (r.remaining() > 0) {
    if (r.remaining() < 8) return { records, torn: true };
    const len = r.u32();
    const crc = r.u32();
    if (len > MAX_RECORD || len > r.remaining()) return { records, torn: true };
    const payload = r.bytes(len);
    if (crc32(payload) !== crc) return { records, torn: true };
    try {
      const rec = cborDecode(payload, { maxDepth: 16 }) as unknown as JournalRecord;
      if (!rec || typeof rec !== 'object' || typeof rec.tick !== 'number' || typeof rec.kind !== 'string') return { records, torn: true };
      records.push(rec);
    } catch { return { records, torn: true }; }
  }
  return { records, torn: false };
}
