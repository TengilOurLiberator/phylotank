/**
 * One persistent world on the host: the World, its journal, snapshots and recovery
 * (05 §5.4, 5.5). Every input that can change the sim goes through `schedule`, which journals
 * it (flushed) before the sim sees it, so a crash at any point replays to the same state.
 * Wall time never enters the sim here: autosave cadence and leases are decided by the caller.
 */
import {
  HASH_EVERY, hashWorld, toHex64, type CborValue, type GodEventScheduled, type SimEvent, type World, type WorldConfig,
} from '../core/index.js';
import { drainEvents, schedule as simSchedule, type JournalEntry } from '../sim/index.js';
import { hostCore } from './core.js';
import { decodeWorld, encodeWorld, prepareSnapshot, SIM_BUILD_HASH, type DecodedWorld } from './snapshot.js';
import { HostWorker } from './worker.js';
import { WorldStore, type JournalRecord, type Retention, type SnapshotInfo, type SnapshotKind } from './store.js';

export interface RecoveryReport {
  created: boolean;
  base?: string;
  failed: { id: string; reason: string }[];
  replayedTicks: number;
  replayedInputs: number;
  hashChecks: number;
  /** First journalled hash that did not match, if any; replay stops there. */
  mismatchAt?: number;
  /** Inputs that could not be replayed (different build, or after a mismatch). */
  unreplayable: JournalRecord[];
  tornJournals: number;
}

export interface HostWorldOptions {
  /** World directory; omit for an in-memory world (tests, the dream config). */
  dir?: string;
  config: WorldConfig;
  retention?: Retention;
  /** Load and replay only: write no snapshot and open no journal (CLI `replay`). */
  readOnly?: boolean;
  /** Wall clock for snapshot metadata only. */
  wallIso?: () => string;
}

function toEntry(r: JournalRecord): JournalEntry | null {
  if (r.kind === 'god') return { tick: r.tick, kind: 'god', ev: r.ev };
  if (r.kind === 'governor') return { tick: r.tick, kind: 'governor', decision: r.decision };
  if (r.kind === 'release') return { tick: r.tick, kind: 'release', release: r.release };
  return null;
}

export class HostWorld {
  world: World;
  readonly store: WorldStore | null;
  /** Journal inputs scheduled for the current tick or later (mirrors the sim's queue, for EVTQ). */
  private pending: JournalEntry[] = [];
  readonly recovery: RecoveryReport;
  stepErrors = 0;
  lastStepError = '';
  private readonly listeners = new Set<(ev: SimEvent[]) => void>();
  private readonly wallIso: () => string;
  private worker: HostWorker | null = null;
  /** Background snapshot writes that failed (disk full and the like); the journal still covers them. */
  saveErrors: string[] = [];
  /** Bumped when the world object is replaced (rewind), so late hashes of the old one are dropped. */
  private worldGen = 0;
  /** Snapshot bytes of the newest save, kept in RAM for device-loss style resets. */
  lastSnapshot: { info: SnapshotInfo | null; bytes: Uint8Array } | null = null;

  private constructor(world: World, store: WorldStore | null, recovery: RecoveryReport, wallIso: () => string) {
    this.world = world;
    this.store = store;
    this.recovery = recovery;
    this.wallIso = wallIso;
  }

  /** Open (recover) the world in `dir`, or create it from `config` if the directory is empty. */
  static open(o: HostWorldOptions): HostWorld {
    const wallIso = o.wallIso ?? (() => new Date().toISOString());
    if (!o.dir) {
      return new HostWorld(hostCore().create(o.config), null, { created: true, failed: [], replayedTicks: 0, replayedInputs: 0, hashChecks: 0, unreplayable: [], tornJournals: 0 }, wallIso);
    }
    const store = new WorldStore(o.dir, o.retention);
    const report: RecoveryReport = { created: false, failed: [], replayedTicks: 0, replayedInputs: 0, hashChecks: 0, unreplayable: [], tornJournals: 0 };
    let base: { info: SnapshotInfo; d: DecodedWorld } | null = null;
    for (const info of store.listSnapshots()) {
      try {
        base = { info, d: decodeWorld(store.readSnapshot(info)) };
        break;
      } catch (e) {
        report.failed.push({ id: info.id, reason: (e as Error).message });
      }
    }
    if (!base) {
      if (o.readOnly) throw new Error(`no readable snapshot in ${o.dir}`);
      report.created = true;
      const hw = new HostWorld(hostCore().create(o.config), store, report, wallIso);
      hw.save('auto');
      return hw;
    }
    report.base = base.info.id;
    const hw = new HostWorld(base.d.world, store, report, wallIso);
    for (const e of base.d.pending) hw.queue(e);
    hw.replay(base.info, base.d);
    // A clean base for the next crash: snapshot the recovered state, which also rotates the journal.
    if (!o.readOnly) hw.save(report.replayedTicks > 0 || report.failed.length > 0 ? 'recovery' : 'auto');
    return hw;
  }

  private replay(info: SnapshotInfo, d: DecodedWorld): void {
    const store = this.store!;
    const r = this.recovery;
    const files = store.readJournals().filter((j) => j.seq >= info.journalSeq && j.epoch === d.world.g.epoch);
    r.tornJournals = files.filter((f) => f.torn).length;
    const records = files.flatMap((f) => f.records);
    if (d.header.simHash !== SIM_BUILD_HASH) {
      r.unreplayable = records.filter((x) => x.kind === 'god' || x.kind === 'governor');
      return;
    }
    const hashes = new Map<number, string>();
    let target = this.world.g.tick;
    for (const rec of records) {
      if (rec.kind === 'hash') hashes.set(rec.tick, rec.h);
      const e = toEntry(rec);
      if (e && e.tick >= this.world.g.tick) { this.queue(e); r.replayedInputs++; }
      // a hash describes the world at g.tick == rec.tick; an input applies while stepping its tick
      target = Math.max(target, rec.kind === 'god' || rec.kind === 'governor' ? rec.tick + 1 : rec.tick);
    }
    const start = this.world.g.tick;
    let fails = 0;
    while (this.world.g.tick < target) {
      if (!this.stepOnce()) { if (++fails > 2) break; continue; }
      fails = 0;
      const h = hashes.get(this.world.g.tick);
      if (h !== undefined) {
        r.hashChecks++;
        if (toHex64(hashWorld(this.world)) !== h) { r.mismatchAt = this.world.g.tick; break; }
      }
    }
    r.replayedTicks = this.world.g.tick - start;
    if (r.mismatchAt !== undefined) {
      r.unreplayable = records.filter((x) => (x.kind === 'god' || x.kind === 'governor') && x.tick >= r.mismatchAt!);
    }
    drainEvents(this.world);
  }

  /** Hash checkpoints and background saves on a worker thread running `bundlePath` (dist/host.mjs). */
  useWorker(bundlePath: string | undefined): boolean {
    if (!this.store) return false;
    this.worker = new HostWorker((tick, h, gen) => {
      if (gen === this.worldGen && this.store) this.store.append({ kind: 'hash', tick, h });
    }, bundlePath);
    return this.worker.threaded;
  }

  get tick(): number { return this.world.g.tick; }
  get epoch(): number { return this.world.g.epoch; }

  onEvents(cb: (ev: SimEvent[]) => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  private queue(e: JournalEntry): void {
    simSchedule(this.world, e);
    this.pending.push(e);
    this.pending.sort((a, b) => a.tick - b.tick);
  }

  /** Journal (flushed) and schedule a sim input. */
  schedule(e: JournalEntry): void {
    if (e.tick < this.world.g.tick) throw new Error(`cannot schedule for past tick ${e.tick}`);
    if (this.store) {
      const rec: JournalRecord = e.kind === 'god' ? { kind: 'god', tick: e.tick, ev: e.ev }
        : e.kind === 'governor' ? { kind: 'governor', tick: e.tick, decision: e.decision }
        : { kind: 'release', tick: e.tick, release: e.release };
      this.store.append(rec);
    }
    this.queue(e);
  }

  scheduleGod(ev: GodEventScheduled): void { this.schedule({ tick: ev.fireTick, kind: 'god', ev }); }

  /** Journal a host-side note (not replayed). */
  note(what: string, data?: CborValue): void {
    this.store?.append({ kind: 'note', tick: this.world.g.tick, what, ...(data !== undefined ? { data } : {}) });
  }

  pendingEntries(): readonly JournalEntry[] { return this.pending; }

  private stepOnce(): boolean {
    const w = this.world;
    const t = w.g.tick;
    try {
      hostCore().step(w);
    } catch (e) {
      // A module stub that throws must not take the host down; the tick is retried without the
      // input that was already consumed, which replay reproduces identically.
      this.stepErrors++;
      this.lastStepError = (e as Error).message;
    }
    while (this.pending.length > 0 && this.pending[0]!.tick <= t) this.pending.shift();
    return w.g.tick > t;
  }

  /** Run n ticks; journals a state hash every HASH_EVERY ticks. Returns ticks actually advanced. */
  step(n: number): number {
    let done = 0;
    let fails = 0;
    while (done < n) {
      // a tick that threw is retried (its consumed input is gone); give up after repeated failures
      if (!this.stepOnce()) { if (++fails > 2) break; continue; }
      fails = 0;
      done++;
      if (this.store && this.world.g.tick % HASH_EVERY === 0) {
        if (this.worker) this.worker.hash(this.world, this.worldGen);
        else this.store.append({ kind: 'hash', tick: this.world.g.tick, h: toHex64(hashWorld(this.world)) });
      }
    }
    const ev = drainEvents(this.world);
    if (ev.length > 0) for (const l of this.listeners) l(ev);
    return done;
  }

  /** Emit host-made events (god, release, detectors) to listeners with world ids. */
  emitHostEvents(ev: SimEvent[]): void { for (const l of this.listeners) l(ev); }
  nextEventId(): number { return this.world.g.nextEventId++; }

  /**
   * Snapshot the present and start a new journal file. With `background` and a worker thread, only
   * the copy happens now (a few ms); hashing, compression and the atomic write finish on the worker.
   * Rotating the journal first is safe: if the write never lands, recovery uses the previous
   * snapshot and replays the new journal file too.
   */
  saveInBackground(kind: SnapshotKind, label?: string): SnapshotInfo | null {
    if (!this.store || !this.worker?.threaded) return this.save(kind, label);
    const w = this.world;
    const seq = this.store.nextSeq();
    const prepared = prepareSnapshot(w, { kind, ...(label !== undefined ? { label } : {}), journalSeq: seq, pending: this.pending, wallIso: this.wallIso() });
    const { dir, ...info } = this.store.snapshotTarget(kind, w.g.epoch, w.g.tick, seq, label);
    const got = this.store.rotate(w.g.epoch, w.g.tick);
    if (got !== seq) throw new Error(`journal sequence ${got} != snapshot sequence ${seq}`);
    this.worker.snapshot(prepared, info.path, dir)
      .then(() => { this.store?.prune(); })
      .catch((e: Error) => { this.saveErrors.push(`${info.id}: ${e.message}`); });
    return info;
  }

  /** Write a snapshot of the present (atomic, synchronous) and start a new journal file. */
  save(kind: SnapshotKind, label?: string): SnapshotInfo | null {
    const w = this.world;
    const seq = this.store ? this.store.nextSeq() : 0;
    const bytes = encodeWorld(w, { kind, ...(label !== undefined ? { label } : {}), journalSeq: seq, pending: this.pending, wallIso: this.wallIso() });
    if (!this.store) { this.lastSnapshot = { info: null, bytes }; return null; }
    const info = this.store.writeSnapshot(bytes, kind, w.g.epoch, w.g.tick, seq, label);
    const got = this.store.rotate(w.g.epoch, w.g.tick);
    if (got !== seq) throw new Error(`journal sequence ${got} != snapshot sequence ${seq}`);
    this.lastSnapshot = { info, bytes };
    return info;
  }

  listSnapshots(): SnapshotInfo[] { return this.store?.listSnapshots() ?? []; }

  /**
   * Rewind in place (DESIGN R27): save the present as `beforeRewind`, load the snapshot, bump the
   * epoch past every epoch seen so far, and start a fresh journal. Views must resync.
   */
  rewind(snapshotId: string): SnapshotInfo {
    if (!this.store) throw new Error('rewind needs a world directory');
    const target = this.store.find(snapshotId);
    if (!target) throw new Error(`no snapshot ${snapshotId}`);
    const d = decodeWorld(this.store.readSnapshot(target));
    const before = this.save('beforeRewind');
    const maxEpoch = Math.max(this.world.g.epoch, ...this.store.listSnapshots().map((s) => s.epoch));
    this.world = d.world;
    this.worldGen++;
    this.world.g.epoch = maxEpoch + 1;
    this.pending = [];
    for (const e of d.pending) this.queue(e);
    this.note('rewind', { to: snapshotId, before: before?.id ?? '' });
    return this.save('auto')!;
  }

  /** Wait for background writes and stop the worker; the journal stays open. */
  async closeWorkerOnly(): Promise<void> { const w = this.worker; this.worker = null; await w?.close(); }
  close(): void { void this.worker?.close(); this.worker = null; this.store?.close(); }
}
