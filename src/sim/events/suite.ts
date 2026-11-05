/**
 * The event suite: runs every detector of this pass over one shared scan, once per `every`
 * ticks (1 s of sim time by default), and sees every primitive event as it comes. It measures
 * its own cost per detector when given a clock (the host passes `performance.now`; sim code
 * never reads a clock, CONTRACT 4.2), so the cost per tick can be reported in STATS.
 */
import { CENSUS_EVERY, type SimEvent, type World } from '../../core/index.js';
import { BloomDetector, type BloomOptions } from './bloom.js';
import { CarcassDetector, type CarcassOptions } from './carcass.js';
import { LineageDetector, type LineageOptions } from './lineage.js';
import { MigrationDetector, type MigrationOptions } from './migration.js';
import { NoveltyDetector, type NoveltyOptions } from './novelty.js';
import { OutbreakDetector, type OutbreakOptions } from './outbreak.js';
import { RecordDetector, type RecordOptions } from './records.js';
import { RoleDetector, type RoleOptions } from './roles.js';
import { Scanner } from './scan.js';
import type { Derived, Detector } from './types.js';

export interface SuiteOptions {
  /** Ticks between state runs. */
  every?: number;
  /** Wall clock in ms for cost accounting (optional; never used for results). */
  clock?: () => number;
  /** Detectors to leave out, by name. */
  disable?: string[];
  carcass?: CarcassOptions;
  migration?: MigrationOptions;
  bloom?: BloomOptions;
  records?: RecordOptions;
  novelty?: NoveltyOptions;
  outbreak?: OutbreakOptions;
  roles?: RoleOptions;
  lineage?: LineageOptions;
}

export interface DetectorCost { name: string; runs: number; totalMs: number; maxMs: number; meanMs: number; perTickMs: number }

export class EventSuite {
  readonly every: number;
  readonly detectors: Detector[];
  readonly scanner = new Scanner(1);
  private readonly clock: (() => number) | undefined;
  private readonly cost = new Map<string, { runs: number; total: number; max: number }>();
  private lastRun = -Infinity;
  private ticksSeen = 0;
  private firstTick = -1;

  constructor(opts: SuiteOptions = {}) {
    this.every = opts.every ?? CENSUS_EVERY;
    this.clock = opts.clock;
    const everyS = this.every / 30;
    const all: Detector[] = [
      new CarcassDetector(opts.carcass),
      new MigrationDetector({ everyS, ...opts.migration }),
      new BloomDetector({ everyS, ...opts.bloom }),
      new RecordDetector(opts.records),
      new NoveltyDetector(opts.novelty),
      new OutbreakDetector({ everyS, ...opts.outbreak }),
      new RoleDetector(opts.roles),
      new LineageDetector(opts.lineage),
    ];
    const off = new Set(opts.disable ?? []);
    this.detectors = all.filter((d) => !off.has(d.name));
    for (const d of [{ name: 'scan' }, ...this.detectors]) this.cost.set(d.name, { runs: 0, total: 0, max: 0 });
  }

  get<T extends Detector>(name: string): T | undefined { return this.detectors.find((d) => d.name === name) as T | undefined; }

  /** Primitive events as they come (any order of calls with `run`). */
  observe(world: World, events: readonly SimEvent[]): Derived[] {
    const out: Derived[] = [];
    if (events.length === 0) return out;
    for (const d of this.detectors) if (d.observe) this.timed(d.name, () => d.observe!(world, events, out));
    return out;
  }

  /** The state detectors, if `every` ticks have passed since the last run (or `force`). */
  run(world: World, force = false): Derived[] {
    const t = world.g.tick;
    if (this.firstTick < 0) this.firstTick = t;
    this.ticksSeen = Math.max(this.ticksSeen, t - this.firstTick);
    if (!force && t - this.lastRun < this.every) return [];
    this.lastRun = t;
    const out: Derived[] = [];
    const scan = this.timed('scan', () => this.scanner.scan(world));
    for (const d of this.detectors) if (d.run) this.timed(d.name, () => d.run!(scan, out));
    return out;
  }

  private timed<T>(name: string, f: () => T): T {
    if (!this.clock) return f();
    const t0 = this.clock();
    const r = f();
    const dt = this.clock() - t0;
    const c = this.cost.get(name)!;
    c.runs++; c.total += dt; if (dt > c.max) c.max = dt;
    return r;
  }

  /** Forget the measured costs (after a warm-up, say). */
  resetCosts(): void { for (const c of this.cost.values()) { c.runs = 0; c.total = 0; c.max = 0; } }

  /** Measured cost per detector (empty without a clock). `perTickMs` amortises over `every`. */
  costs(): DetectorCost[] {
    if (!this.clock) return [];
    return [...this.cost].map(([name, c]) => ({
      name, runs: c.runs, totalMs: c.total, maxMs: c.max, meanMs: c.runs ? c.total / c.runs : 0,
      perTickMs: c.runs ? c.total / c.runs / this.every : 0,
    }));
  }
}
