/**
 * GodClient: the god window's view of the world, built only from frames (07 §0.1: no view keeps
 * world state beyond what it is sent). Sends GodCommands with ids and the current epoch, keeps
 * the speed lease alive (renew every 10 s; the host lapses it after 30 s), and resets its
 * buffers when the epoch changes (rewind, DESIGN R27).
 */
import {
  cborEncode, decodeBodyEnter, decodeCborFrame, decodeDust, decodeEnv, encodeCborFrame, FRAME, readHeader, ByteReader, HEADER_BYTES,
  type CborValue, type CommandResult, type DustFrame, type EnvFrame, type GodCommand, type SimEvent, type SimLink, type Speed,
} from '../../core/index.js';
import { Emitter } from '../dom.js';
import { NameBook, renameKey, renameValue } from '../naming.js';
import { decodeGenomeFrame, decodeInspect, encodeGenomeReq, type InspectDetail, type FoodWeb, type InspectFrame, type SnapshotInfo, type SpeciesInfo, type SpeedInfo, type StatsPayload } from './wire.js';

/** Gene drift samples kept per trait per species (one per genes update, at most this many). */
export const DRIFT_MAX = 720;
/** Okabe and Ito's colour-blind-safe categorical palette (lightened for the dark background). */
export const CVD_PALETTE: [number, number, number][] = [[230, 159, 0], [86, 180, 233], [0, 158, 115], [240, 228, 66], [0, 114, 178], [213, 94, 0], [204, 121, 167], [220, 220, 220]];

export const LEASE_RENEW_MS = 10_000;
export const RESULT_TIMEOUT_MS = 10_000;
export type Change = 'welcome' | 'dust' | 'env' | 'events' | 'stats' | 'inspect' | 'result' | 'epoch' | 'genome' | 'link';
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type CommandBody = DistributiveOmit<GodCommand, 'id' | 'epoch'>;

export interface Welcome { speciesTable?: { id: number; name: string }[]; worldId: string; epoch: number; tickHz: number; tank: { w: number; h: number; preset: string }; lCeiling: number; mock?: boolean; scopes?: string[] }

export class GodClient {
  readonly changed = new Emitter<Change>();
  welcome: Welcome | null = null;
  epoch = 0;
  tick = 0;
  env: EnvFrame | null = null;
  dust: DustFrame | null = null;
  /** slot -> {id, species} from BODY_ENTER/LEAVE (picking). */
  readonly slots = new Map<number, { id: number; species: number; genomeLo: number; genomeHi: number }>();
  events: SimEvent[] = [];
  species: SpeciesInfo[] = [];
  snapshots: SnapshotInfo[] = [];
  speed: SpeedInfo = { requested: 1, achieved: 1 };
  history: [number, number[]][] = [];
  genes: Record<string, Record<string, number[]>> = {};
  /** Gene drift heat map data (07 §3.6): trait -> species id -> [tick, 32 bins][]. */
  drift: Record<string, Record<string, [number, number[]][]>> = {};
  /** World settings and knobs as the host last reported them (STATS.settings). */
  settings: Record<string, number | string | boolean> = {};
  web: FoodWeb | null = null;
  /** User names (07 §6.4); they win over every generated name. */
  readonly names = new NameBook();
  /** Species as the host sent them, before user names are applied. */
  private rawSpecies: SpeciesInfo[] = [];
  private speciesFromStats = false;
  selected: InspectDetail | null = null;
  selectedId = -1;
  inspect: InspectFrame | null = null;
  readonly genomes = new Map<string, Uint8Array>();
  lastFrameAt = 0;
  private seq = 0;
  private pending = new Map<string, { resolve: (r: CommandResult) => void; at: number; frame: Uint8Array; retried: boolean }>();
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private leaseCmd: CommandBody | null = null;

  constructor(readonly link: SimLink, private readonly clock: () => number = () => performance.now()) {
    link.onFrame((f) => this.ingest(f));
    link.send(encodeCborFrame(FRAME.HELLO, 0, {
      view: 'god', caps: { maxBytesPerSec: 8_000_000, maxBodies: 4096, maxDust: 8192, gpu: 'webgl2' }, viewport: [0, 0, 0, 0],
    }));
  }

  get isMock(): boolean { return !!this.welcome?.mock || (this.link as { mock?: boolean }).mock === true; }
  get tank(): { w: number; h: number } { return this.welcome?.tank ?? { w: 32, h: 18 }; }
  speciesName(id: number): string { return this.species.find((s) => s.id === id)?.name ?? `species ${id}`; }

  ingest(f: Uint8Array): void {
    let h;
    try { h = readHeader(f); } catch { return; }
    this.lastFrameAt = this.clock();
    this.tick = h.tick;
    switch (h.type) {
      case FRAME.WELCOME: {
        const w = decodeCborFrame(f).payload as unknown as Welcome;
        const epochChanged = this.welcome !== null && w.epoch !== this.epoch;
        if (!this.welcome || this.welcome.worldId !== w.worldId) this.names.load(String(w.worldId ?? ''));
        this.welcome = w; this.epoch = w.epoch;
        if (epochChanged) this.resetForEpoch();
        if (!this.speciesFromStats && Array.isArray(w.speciesTable)) this.setSpecies(w.speciesTable.map((x) => this.bare(x.id, x.name)));
        this.changed.emit('welcome');
        if (epochChanged) this.changed.emit('epoch');
        break;
      }
      case FRAME.DUST_FRAME: this.dust = decodeDust(f); this.changed.emit('dust'); break;
      case FRAME.BODY_ENTER: for (const e of decodeBodyEnter(f)) this.slots.set(e.slot, { id: e.id, species: e.species, genomeLo: Number(e.genomeKey & 0xffffffffn), genomeHi: Number(e.genomeKey >> 32n) }); break;
      case FRAME.BODY_LEAVE: {
        const r = new ByteReader(f, HEADER_BYTES);
        const n = r.u16();
        for (let i = 0; i < n; i++) this.slots.delete(r.u16());
        break;
      }
      case FRAME.ENV: this.env = decodeEnv(f); this.changed.emit('env'); break;
      case FRAME.CENSUS: {
        // the real host's STATS has no species list yet: CENSUS (1 Hz) keeps the god window useful
        if (this.speciesFromStats) break;
        const c = decodeCborFrame(f).payload as { species?: { id: number; count: number; biomassKg: number; colour: [number, number, number] }[] };
        if (!Array.isArray(c.species)) break;
        const known = new Map(this.rawSpecies.map((x) => [x.id, x]));
        this.setSpecies(c.species.map((x) => ({ ...(known.get(x.id) ?? this.bare(x.id, `Species ${x.id}`)), count: x.count, biomassKg: x.biomassKg, colour: x.colour })));
        this.changed.emit('stats');
        break;
      }
      case FRAME.EVENT: {
        const evs = decodeCborFrame(f).payload as unknown as SimEvent[];
        if (!Array.isArray(evs)) break;
        for (const e of evs) if (e.epoch === undefined || e.epoch === this.epoch) this.events.push(e);
        if (this.events.length > 3000) this.events.splice(0, this.events.length - 3000);
        this.changed.emit('events');
        break;
      }
      case FRAME.STATS: {
        const s = decodeCborFrame(f).payload as unknown as StatsPayload;
        if (s.epoch !== undefined && s.epoch !== this.epoch) break;
        if (s.species) { this.speciesFromStats = true; this.setSpecies(s.species); }
        if (s.settings) this.settings = { ...s.settings };
        if (s.web) this.web = s.web;
        this.snapshots = s.snapshots ?? this.snapshots;
        this.speed = s.speed ?? this.speed;
        if (s.history) this.history = s.history.slice();
        if (s.sample) { const last = this.history[this.history.length - 1]; if (!last || last[0] < s.sample[0]) this.history.push(s.sample); }
        if (this.history.length > 5000) this.history.splice(0, this.history.length - 5000);
        if (s.genes) { this.genes = s.genes; this.recordDrift(s.tick ?? this.tick, s.genes); }
        if (s.selected && s.selected.id === this.selectedId) this.selected = s.selected;
        this.changed.emit('stats');
        break;
      }
      case FRAME.INSPECT: { const i = decodeInspect(f); if (i.id === this.selectedId) { this.inspect = i; this.changed.emit('inspect'); } break; }
      case FRAME.GENOME: { const g = decodeGenomeFrame(f); this.genomes.set(`${g.lo}:${g.hi}`, g.genome); this.changed.emit('genome'); break; }
      case FRAME.COMMAND_RESULT: {
        const r = decodeCborFrame(f).payload as unknown as CommandResult;
        const p = this.pending.get(r.id);
        if (p) { this.pending.delete(r.id); p.resolve(r); }
        this.changed.emit('result');
        break;
      }
      default: break;
    }
  }

  private bare(id: number, name: string): SpeciesInfo {
    return { id, name, count: 0, biomassKg: 0, colour: [180, 200, 210], parent: -1, bornTick: 0, origin: 'natural', glyph: id % 24, prefDepth: 0.5 };
  }
  /** Colour-vision-safe chart palette instead of genetic hues (07 §6.1). */
  chartPalette = false;
  setChartPalette(on: boolean): void { this.chartPalette = on; this.setSpecies(this.rawSpecies); this.changed.emit('stats'); }
  /** Apply user names over the host's species list (William's renames win). */
  private setSpecies(list: SpeciesInfo[]): void {
    this.rawSpecies = list;
    this.species = list.map((x) => {
      const name = this.names.display(x, list);
      const common = this.names.common(x);
      const colour = this.chartPalette ? CVD_PALETTE[x.id % CVD_PALETTE.length]! : x.colour;
      return name === x.name && common === x.common && colour === x.colour ? x : { ...x, name, colour, ...(common ? { common } : {}) };
    });
  }
  /** Generated (host) name of a species, before user names. */
  generatedName(id: number): string { return this.rawSpecies.find((s) => s.id === id)?.name ?? this.speciesName(id); }
  /**
   * Rename a species (07 §6.4). The name is shown at once and kept on this viewer whatever the
   * host says; the result tells the UI whether the host recorded it too.
   */
  rename(id: number, n: { genus: string; epithet: string; common?: string; wholeGenus?: boolean }): Promise<CommandResult> {
    this.names.rename(id, n, this.rawSpecies, this.tick);
    this.setSpecies(this.rawSpecies);
    this.changed.emit('stats');
    return this.send({ t: 'setting', key: renameKey(id), value: renameValue(n) });
  }
  private recordDrift(tick: number, genes: Record<string, Record<string, number[]>>): void {
    for (const [trait, bySp] of Object.entries(genes)) {
      const d = (this.drift[trait] ??= {});
      for (const [sp, bins] of Object.entries(bySp)) {
        const arr = (d[sp] ??= []);
        const last = arr[arr.length - 1];
        if (last && last[0] >= tick) continue;
        arr.push([tick, bins.slice()]);
        if (arr.length > DRIFT_MAX) arr.splice(0, arr.length - DRIFT_MAX);
      }
    }
  }

  private resetForEpoch(): void {
    this.drift = {};
    this.events = [];
    this.history = [];
    this.dust = null;
    this.slots.clear();
    this.inspect = null;
    this.selected = null;
    this.selectedId = -1; // the creature may not exist in the restored world
  }

  /** Send a god command; resolves with the host's COMMAND_RESULT (or a timeout result). */
  send(body: CommandBody): Promise<CommandResult> {
    const id = `c${Date.now().toString(36)}${(this.seq++).toString(36)}`.slice(0, 32);
    const cmd = { ...body, id, epoch: this.epoch } as GodCommand;
    const frame = encodeCborFrame(FRAME.COMMAND, this.tick, cmd as unknown as CborValue);
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, at: this.clock(), frame, retried: false });
      this.link.send(frame);
    });
  }

  /** Idempotent retry by id within 10 s, then give up (07 §8). Call from a timer. */
  sweep(): void {
    const now = this.clock();
    for (const [id, p] of this.pending) {
      if (!p.retried && now - p.at > 2000) { p.retried = true; this.link.send(p.frame); }
      if (now - p.at > RESULT_TIMEOUT_MS) { this.pending.delete(id); p.resolve({ id, ok: false, reason: 'timeout' }); }
    }
  }

  /** Speed lease (DESIGN R29): anything but 1x is renewed every 10 s while this window lives. */
  setSpeed(speed: Speed, opts: { until?: { tick?: number; wallIso?: string }; unattended?: boolean } = {}): Promise<CommandResult> {
    const body: CommandBody = { t: 'speed', speed, ...(opts.until ? { until: opts.until } : {}), ...(opts.unattended ? { unattended: true } : {}) };
    this.leaseCmd = speed === 1 ? null : body;
    if (this.leaseTimer) { clearInterval(this.leaseTimer); this.leaseTimer = null; }
    if (this.leaseCmd && typeof setInterval !== 'undefined') this.leaseTimer = setInterval(() => { if (this.leaseCmd) void this.send(this.leaseCmd); }, LEASE_RENEW_MS);
    return this.send(body);
  }
  renewLease(): void { if (this.leaseCmd) void this.send(this.leaseCmd); }
  get leaseActive(): boolean { return this.leaseCmd !== null; }

  select(id: number): void {
    this.selectedId = id;
    this.selected = null;
    this.inspect = null;
    void this.send({ t: 'select', entity: id, pin: false });
    this.changed.emit('inspect');
  }
  requestGenome(lo: number, hi: number): void {
    if (!this.genomes.has(`${lo}:${hi}`)) this.link.send(encodeGenomeReq(this.tick, [[lo, hi]]));
  }

  /** Nearest creature to a world point, from the last dust frame (CPU picking). */
  pick(wx: number, wy: number, maxDistM: number): { slot: number; id: number; species: number } | null {
    const d = this.dust;
    if (!d) return null;
    const [x0, y0, x1, y1] = d.rect;
    let best = -1, bestD = maxDistM * maxDistM;
    for (let s = 0; s < d.n; s++) {
      if (d.colour[s] === 255) continue;
      const x = x0 + (d.x[s]! / 65535) * (x1 - x0), y = y0 + (d.y[s]! / 65535) * (y1 - y0);
      const dd = (x - wx) ** 2 + (y - wy) ** 2;
      if (dd < bestD) { bestD = dd; best = s; }
    }
    if (best < 0) return null;
    const info = this.slots.get(best);
    return info ? { slot: best, id: info.id, species: info.species } : null;
  }
  /** World position of an entity from the last dust frame. */
  positionOf(id: number): [number, number] | null {
    const d = this.dust;
    if (!d) return null;
    for (const [slot, info] of this.slots) {
      if (info.id !== id || slot >= d.n || d.colour[slot] === 255) continue;
      const [x0, y0, x1, y1] = d.rect;
      return [x0 + (d.x[slot]! / 65535) * (x1 - x0), y0 + (d.y[slot]! / 65535) * (y1 - y0)];
    }
    return null;
  }
  /** Count creatures and species inside a predicate on world position (power preview). */
  countWhere(test: (x: number, y: number, species: number) => boolean): { n: number; species: Map<number, number> } {
    const d = this.dust;
    const species = new Map<number, number>();
    let n = 0;
    if (!d) return { n, species };
    const [x0, y0, x1, y1] = d.rect;
    for (let s = 0; s < d.n; s++) {
      if (d.colour[s] === 255) continue;
      const sp = this.slots.get(s)?.species ?? -1;
      const x = x0 + (d.x[s]! / 65535) * (x1 - x0), y = y0 + (d.y[s]! / 65535) * (y1 - y0);
      if (test(x, y, sp)) { n++; species.set(sp, (species.get(sp) ?? 0) + 1); }
    }
    return { n, species };
  }

  close(): void {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    try { this.link.send(new Uint8Array([FRAME.BYE, 0, 0, 1, 0, 0, 0, 0])); } catch { /* closing */ }
    this.link.close();
  }
}

/** Sim day, time of day and season from the tick and ENV (DAY_S 1200 s, 20-day year). */
export function clockOf(tick: number, env: EnvFrame | null, tickHz = 30): { day: number; hh: number; mm: number; season: 'spring' | 'summer' | 'autumn' | 'winter' } {
  const dayS = 1200;
  const s = tick / tickHz;
  const day = Math.floor(s / dayS) + 1;
  const phase = env ? env.dayPhase : (s / dayS) % 1;
  const mins = Math.floor(phase * 24 * 60);
  const yp = env ? env.yearPhase : (s / (dayS * 20)) % 1;
  const season = (['spring', 'summer', 'autumn', 'winter'] as const)[Math.floor(yp * 4) % 4]!;
  return { day, hh: Math.floor(mins / 60), mm: mins % 60, season };
}
void cborEncode;
