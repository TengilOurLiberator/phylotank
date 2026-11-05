/**
 * MockSimLink: a stand-in host behind the SimLink interface, so the god window, designer and
 * caption views run standalone (no host, no real sim yet). It speaks the real frame codecs:
 * WELCOME, ENV, CENSUS, DUST_FRAME, BODY_ENTER/LEAVE, EVENT, STATS, INSPECT, GENOME,
 * COMMAND_RESULT; and it honours the command rules the UI depends on: epochs and stale-epoch
 * rejection, the 3 s / 1 s lead, automatic beforePower snapshots, speed leases that lapse
 * after 30 s, the unattended "max until" lease, in-place rewind with beforeRewind.
 *
 * It is a toy world, not the sim: creatures wander, breed and die by simple rules. It is
 * view-side code and may use wall time; it never feeds the real sim.
 */
import {
  decodeCborFrame, decodeGenome, decodePtkg, encodeBodyEnter, encodeBodyLeave, encodeCborFrame, encodeDust, encodeEnv,
  encodeGenome, FRAME, GENOME_FLAG_LEVIATHAN, isMajorPower, LEAD_MAJOR_S, LEAD_MINOR_S, readHeader, xxh64Parts,
  type CborValue, type GodCommand, type SimEvent, type SimLink, type TemplateId,
} from '../core/index.js';
import { mulberry32 } from './dom.js';
import { TEMPLATES, templateGenome } from './designer/templates.js';
import {
  decodeGenomeReq, encodeGenomeFrame, encodeInspect,
  type InspectDetail, type KinNode, type SnapshotInfo, type SpeciesInfo, type StatsPayload,
  ABIOTIC, type FlowKind, type FoodWeb,
} from './god/wire.js';
import { clampKnob, KNOB } from './god/knobs.js';
import { parseRenameValue } from './naming.js';

const W = 32, H = 18, HZ = 30;
const PALETTE: [number, number, number][] = [
  [120, 255, 170], [255, 120, 110], [130, 170, 255], [230, 120, 255], [255, 190, 100], [190, 130, 255], [255, 235, 120],
  [90, 230, 255], [255, 140, 210], [160, 255, 110], [255, 210, 150], [110, 200, 255], [210, 255, 200], [255, 160, 90],
  [180, 200, 255], [240, 240, 255],
];
const DEPTH: Record<string, number> = { meadowlamp: 0.18, hushmaw: 0.55, sievebell: 0.4, tetherling: 0.5, ashpicker: 0.86, deepcrown: 0.7, motefly: 0.1 };
const SPEED: Record<string, number> = { meadowlamp: 0.5, hushmaw: 0.25, sievebell: 0.12, tetherling: 0.6, ashpicker: 0.35, deepcrown: 0.3, motefly: 0.15 };
const START: Record<string, number> = { meadowlamp: 160, hushmaw: 26, sievebell: 70, tetherling: 40, ashpicker: 60, deepcrown: 8, motefly: 220 };
const ACTIONS = ['cruising', 'grazing', 'resting', 'fleeing', 'hunting', 'courting'];
const MAX_AGENTS = 1400;

interface Creature {
  id: number; sp: number; x: number; y: number; vx: number; vy: number; energy: number; health: number;
  bornTick: number; gen: number; parent: number; offspring: number; len: number; slot: number; key: [number, number];
}
interface Species extends SpeciesInfo { templ: string; speed: number; cap: number; genome: Uint8Array; key: [number, number]; drift?: number[]; namedBy?: 'user' }
/** Who eats whom in the toy world, by template: [prey template or abiotic id, share, kind]. */
const DIET: Record<string, [string | number, number, FlowKind][]> = {
  motefly: [[ABIOTIC.plants, 1, 0]],
  meadowlamp: [[ABIOTIC.plankton, 0.8, 0], [ABIOTIC.plants, 0.2, 0]],
  sievebell: [[ABIOTIC.plankton, 0.7, 0], ['motefly', 0.3, 0]],
  tetherling: [['sievebell', 0.6, 1], ['meadowlamp', 0.4, 1]],
  ashpicker: [[ABIOTIC.detritus, 0.9, 2], ['motefly', 0.1, 0]],
  hushmaw: [['meadowlamp', 0.5, 0], ['motefly', 0.2, 0], ['sievebell', 0.3, 0]],
  deepcrown: [['hushmaw', 0.6, 0], ['ashpicker', 0.25, 0], ['tetherling', 0.15, 0]],
};
/** Gene-histogram traits and their trait indices. */
const GENE_TRAITS: [string, number][] = [['ADULT_LENGTH', 0], ['DIET_PLANT', 20], ['GLOW_HUE', 32], ['MU_LOG', 16]];
interface Scheduled { cmdId: string; power: GodCommand & { t: 'cast' }; fireTick: number; major: boolean }
interface Snap { info: SnapshotInfo; state: string }

export interface MockOptions { seed?: number; autoStart?: boolean; now?: () => number; warmupTicks?: number }

export class MockSimLink implements SimLink {
  readonly kind = 'worker' as const;
  readonly mock = true;
  private cb: ((f: Uint8Array) => void) | null = null;
  private rnd: () => number;
  private now: () => number;
  tick = 0;
  epoch = 0;
  private nextId = 1;
  private eid = 1;
  creatures: Creature[] = [];
  species: Species[] = [];
  private slots: (Creature | null)[] = [];
  private events: SimEvent[] = [];
  private outEvents: SimEvent[] = [];
  private history: [number, number[]][] = [];
  snapshots: Snap[] = [];
  private scheduled: Scheduled[] = [];
  private modifiers: { kind: string; x: number; y: number; r: number; until: number; strength: number; species?: number[] }[] = [];
  private vents: [number, number][] = [[24, 17.2]];
  speedReq: number | 'max' = 1;
  private until: { tick?: number; wallIso?: string } | undefined;
  private unattended = false;
  private leaseUntil = 0;
  private selected = -1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastWall = 0;
  private acc = 0;
  private frameCount = 0;
  private statsCount = 0;
  private lastSent = { dust: -1e9, insp: -1e9, stats: -1e9 };
  private hello = false;
  private snapSeq = 1;
  private enteredSlots = new Set<number>();
  private genomes = new Map<string, Uint8Array>();
  /** World settings and knobs (07 §3.9) as applied; reported in STATS.settings. */
  settings: Record<string, number | string | boolean> = {};
  private knob(id: string, def: number): number { const v = this.settings[id]; return typeof v === 'number' ? v : def; }

  constructor(opts: MockOptions = {}) {
    this.rnd = mulberry32(opts.seed ?? 0x5eed);
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.initWorld();
    const warm = opts.warmupTicks ?? HZ * 90;
    for (let i = 0; i < warm; i++) this.step();
    this.outEvents = [];
    this.takeSnapshot('Autosave', 'auto');
    if (opts.autoStart !== false && typeof setInterval !== 'undefined') {
      this.lastWall = this.now();
      this.timer = setInterval(() => this.pump(), 1000 / HZ);
    }
  }

  onFrame(cb: (f: Uint8Array) => void): void { this.cb = cb; }
  close(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  send(frame: Uint8Array): void {
    const h = readHeader(frame);
    if (h.type === FRAME.HELLO) { this.hello = true; this.sendWelcome(); return; }
    if (h.type === FRAME.COMMAND) {
      const { payload } = decodeCborFrame(frame);
      this.emitFrame(encodeCborFrame(FRAME.COMMAND_RESULT, this.tick, this.command(payload as unknown as GodCommand) as unknown as CborValue));
      return;
    }
    if (h.type === FRAME.GENOME_REQ) {
      for (const [lo, hi] of decodeGenomeReq(frame)) {
        const g = this.genomes.get(`${lo}:${hi}`);
        if (g) this.emitFrame(encodeGenomeFrame(this.tick, lo, hi, g));
      }
    }
  }

  private emitFrame(f: Uint8Array): void { this.cb?.(f); }

  // ---------------- world ----------------
  private initWorld(empty = false): void {
    if (empty) return;
    TEMPLATES.filter((t) => t.id !== 'blank').forEach((t, i) => {
      const g = encodeGenome(templateGenome(t.id));
      this.addSpecies({ name: `${t.genus} ${t.epithet}`, common: t.name, templ: t.id, genome: g, origin: 'template', parent: -1, palette: i });
    });
    for (const s of this.species) {
      for (let i = 0; i < START[s.templ]!; i++) this.spawn(s.id, this.rnd() * W, (s.prefDepth + (this.rnd() - 0.5) * 0.25) * H, -1, 0);
    }
  }

  private addSpecies(o: { name: string; common?: string; templ: string; genome: Uint8Array; origin: Species['origin']; parent: number; palette?: number; leviathan?: boolean }): Species {
    const id = this.species.length;
    const pi = (o.palette ?? id) % PALETTE.length;
    const [lo, hi] = xxh64Parts(o.genome);
    const key: [number, number] = [lo >>> 0, hi >>> 0];
    this.genomes.set(`${key[0]}:${key[1]}`, o.genome);
    const sp: Species = {
      id, name: o.name, ...(o.common ? { common: o.common } : {}), count: 0, biomassKg: 0, colour: PALETTE[pi]!, parent: o.parent,
      bornTick: this.tick, origin: o.origin, glyph: id % 24, prefDepth: DEPTH[o.templ] ?? 0.4, templ: o.templ,
      speed: SPEED[o.templ] ?? 0.3, cap: Math.max(20, (START[o.templ] ?? 40) * 1.6), genome: o.genome, key, ...(o.leviathan ? { leviathan: true } : {}),
    };
    this.species.push(sp);
    return sp;
  }

  private spawn(sp: number, x: number, y: number, parent: number, gen: number): Creature | null {
    if (this.creatures.length >= MAX_AGENTS) return null;
    let slot = this.slots.indexOf(null);
    if (slot < 0) { slot = this.slots.length; this.slots.push(null); }
    const s = this.species[sp]!;
    const c: Creature = {
      id: this.nextId++, sp, x: clamp(x, 0.2, W - 0.2), y: clamp(y, 0.3, H - 0.3), vx: 0, vy: 0, energy: 0.6 + 0.4 * this.rnd(), health: 1,
      bornTick: this.tick, gen, parent, offspring: 0, len: s.templ === 'deepcrown' ? 0.12 : s.leviathan ? 0.4 : 0.02, slot, key: s.key,
    };
    this.slots[slot] = c;
    this.creatures.push(c);
    return c;
  }

  private kill(c: Creature, cause: 'predation' | 'starvation' | 'age' | 'disease' | 'disaster'): void {
    this.slots[c.slot] = null;
    c.health = 0;
    if (cause === 'disaster' || this.rnd() < 0.02) this.event({ k: 'death', id: c.id, species: c.sp, pos: [c.x, c.y], size: c.len, cause });
  }

  private event(e: EvIn): void {
    const ev = { ...e, t: this.tick, eid: this.eid++, epoch: this.epoch } as SimEvent;
    this.events.push(ev);
    if (this.events.length > 4000) this.events.splice(0, 1000);
    this.outEvents.push(ev);
  }

  /** One sim tick of the toy world. */
  step(): void {
    this.tick++;
    const t = this.tick;
    for (const c of this.creatures) {
      if (c.health <= 0) continue;
      const s = this.species[c.sp]!;
      const targetY = s.prefDepth * H;
      const wander = 0.04 * s.speed;
      c.vx += (this.rnd() - 0.5) * wander;
      c.vy += (this.rnd() - 0.5) * wander + (targetY - c.y) * 0.0006;
      for (const m of this.modifiers) if (m.kind === 'currentShift') c.vx += 0.0015 * m.strength;
      const v = Math.hypot(c.vx, c.vy), vmax = s.speed * 0.06;
      if (v > vmax) { c.vx *= vmax / v; c.vy *= vmax / v; }
      c.x += c.vx; c.y += c.vy;
      if (c.x < 0.2) { c.x = 0.2; c.vx = Math.abs(c.vx); } else if (c.x > W - 0.2) { c.x = W - 0.2; c.vx = -Math.abs(c.vx); }
      if (c.y < 0.3) { c.y = 0.3; c.vy = Math.abs(c.vy); } else if (c.y > H - 0.3) { c.y = H - 0.3; c.vy = -Math.abs(c.vy); }
    }
    if (t % HZ === 0) this.ecology();
    for (let i = this.scheduled.length - 1; i >= 0; i--) {
      const s = this.scheduled[i]!;
      if (t >= s.fireTick) { this.scheduled.splice(i, 1); this.fire(s); }
    }
    this.modifiers = this.modifiers.filter((m) => m.until > t);
    if (t % (HZ * 5) === 0) {
      this.history.push([t, this.species.flatMap((s) => [s.id, s.count])]);
      if (this.history.length > 2000) this.history.shift();
    }
  }

  private ecology(): void {
    const counts = new Array(this.species.length).fill(0) as number[];
    for (const c of this.creatures) if (c.health > 0) counts[c.sp]!++;
    const bloomAt = (c: Creature) => this.modifiers.some((m) => (m.kind === 'bloom' || m.kind === 'nutrientFlood') && Math.hypot(c.x - m.x, c.y - m.y) < m.r);
    const births: [number, number, number, number, number][] = [];
    for (const c of this.creatures) {
      if (c.health <= 0) continue;
      const s = this.species[c.sp]!;
      const crowd = counts[c.sp]! / s.cap;
      const ageS = (this.tick - c.bornTick) / HZ;
      const graze = s.templ === 'meadowlamp' || s.templ === 'motefly' || s.templ === 'sievebell' ? this.knob('eco.plankton', 1) : 1;
      c.energy = clamp(c.energy + (bloomAt(c) ? 0.08 : 0.02) * Math.sqrt(graze) - 0.025 * crowd * this.knob('life.metabolic', 1) + (this.rnd() - 0.5) * 0.04, 0, 1);
      for (const m of this.modifiers) {
        if (m.kind === 'plague' && (!m.species || m.species.includes(c.sp)) && this.rnd() < 0.01 * m.strength) { c.health -= 0.5; }
        if ((m.kind === 'coldSnap' || m.kind === 'heatwave') && this.rnd() < 0.002 * m.strength) c.health -= 0.3;
      }
      if (c.health <= 0) { this.kill(c, 'disease'); continue; }
      if (c.energy <= 0.01 && this.rnd() < 0.2) { this.kill(c, 'starvation'); continue; }
      if (ageS > 300 && this.rnd() < 0.004 * (ageS / 300)) { this.kill(c, 'age'); continue; }
      if (c.energy > 0.7 && this.rnd() < 0.035 * (1 - Math.min(1, crowd)) * (s.templ === 'deepcrown' ? 0.2 : 1)) {
        c.energy -= 0.3; c.offspring++;
        births.push([c.sp, c.x, c.y, c.id, c.gen + 1]);
      }
    }
    this.creatures = this.creatures.filter((c) => c.health > 0);
    for (const [sp, x, y, parent, gen] of births) this.spawn(sp, x + (this.rnd() - 0.5) * 0.3, y + (this.rnd() - 0.5) * 0.3, parent, gen);
    for (const s of this.species) {
      const before = s.count;
      s.count = 0; s.biomassKg = 0;
      if (before > 0) s.extinctTick = undefined as unknown as number;
    }
    for (const c of this.creatures) { const s = this.species[c.sp]!; s.count++; s.biomassKg += 31 * c.len ** 3; }
    for (const s of this.species) {
      if (s.count === 0 && s.extinctTick === undefined && (this.tick - s.bornTick) > HZ * 5) {
        s.extinctTick = this.tick;
        this.event({ k: 'extinction', species: s.id, lastId: 0, pos: [W / 2, s.prefDepth * H] });
      }
      if (s.count > 0) delete (s as Partial<Species>).extinctTick;
    }
    // gene drift: a small random walk per species, scaled by the mutation knob; Deepcrown's
    // adult size creeps up (07 §3.6's example), so the drift heat map has something to show
    const mut = this.knob('life.mutation', 1);
    for (const s of this.species) {
      if (s.count === 0) continue;
      const d = (s.drift ??= GENE_TRAITS.map(() => 0));
      GENE_TRAITS.forEach(([name], i) => {
        d[i] = clamp(d[i]! + (this.rnd() - 0.5) * 0.006 * mut + (name === 'ADULT_LENGTH' && s.templ === 'deepcrown' ? 0.0005 * mut : 0), -0.4, 0.4);
      });
    }
    // natural events, at a calm rate
    const r = this.rnd();
    const live = this.creatures;
    if (live.length > 0) {
      const c = live[Math.floor(this.rnd() * live.length)]!;
      if (r < 0.06) {
        const preds = live.filter((x) => this.species[x.sp]!.templ === 'hushmaw' || this.species[x.sp]!.templ === 'deepcrown');
        const p = preds[Math.floor(this.rnd() * preds.length)];
        if (p) this.event({ k: 'hunt', phase: 'start', pred: p.id, prey: c.id, pos: [p.x, p.y] });
      } else if (r < 0.09) {
        this.event({ k: 'school', phase: 'start', species: c.sp, n: 12, centroid: [c.x, c.y], radius: 1.5, polarisation: 0.8, sample: [c.id] });
      } else if (r < 0.1) {
        this.event({ k: 'giant', id: c.id, species: c.sp, size: c.len * 1.6, percentile: 99.7 });
      } else if (r < 0.1 + 0.012 * Math.min(3, this.knob('life.mutation', 1)) && this.species.length < 24) {
        const parent = this.species[c.sp]!;
        if (parent.count > 40) {
          const g = decodeGenome(parent.genome);
          g.traits[0] = Math.min(65535, g.traits[0]! + 900);
          g.traits[32] = (g.traits[32]! + 4000) % 65535;
          const child = this.addSpecies({ name: `${parent.name.split(' ')[0]} ${EPITHETS[this.species.length % EPITHETS.length]}`, templ: parent.templ, genome: encodeGenome(g), origin: 'natural', parent: parent.id });
          const founders = live.filter((x) => x.sp === parent.id).slice(0, Math.floor(parent.count / 3));
          for (const f of founders) f.sp = child.id;
          this.event({ k: 'speciation', parent: parent.id, child: child.id, founders: founders.slice(0, 4).map((f) => f.id), pos: [c.x, c.y] });
        }
      }
    }
  }

  // ---------------- commands ----------------
  private command(cmd: GodCommand): { id: string; ok: boolean; reason?: string; eventId?: number; fireTick?: number; snapshotId?: string } {
    const id = typeof cmd.id === 'string' ? cmd.id.slice(0, 32) : '';
    if (cmd.epoch !== this.epoch) return { id, ok: false, reason: 'stale-epoch' };
    switch (cmd.t) {
      case 'speed': {
        const sp = cmd.speed;
        this.speedReq = sp === 0 || sp === 0.25 || sp === 1 || sp === 4 || sp === 16 || sp === 'max' ? sp : 1;
        this.until = cmd.until; this.unattended = !!cmd.unattended && !!cmd.until;
        this.leaseUntil = this.now() + 30_000;
        if (this.speedReq !== 1 && this.speedReq !== 0) this.event({ k: 'record', kind: 'speed', id: 0, value: this.speedReq === 'max' ? 999 : this.speedReq, prev: 1 });
        return { id, ok: true };
      }
      case 'cast': {
        const major = isMajorPower(cmd.power, cmd.intensity);
        const lead = major ? LEAD_MAJOR_S : LEAD_MINOR_S;
        const fireTick = this.tick + Math.max(1, Math.round(lead * HZ * this.achieved()));
        let snapshotId: string | undefined;
        if (major) snapshotId = this.takeSnapshot(`Before ${cmd.power}`, 'beforePower');
        this.scheduled.push({ cmdId: id, power: cmd, fireTick, major });
        return { id, ok: true, fireTick, eventId: this.eid, ...(snapshotId ? { snapshotId } : {}) };
      }
      case 'release': {
        if (!cmd.ptkg) return { id, ok: false, reason: 'library releases need the host library' };
        let name = 'Designed species', genome: Uint8Array;
        try {
          const p = decodePtkg(cmd.ptkg);
          genome = p.payload.genome!;
          const g = decodeGenome(genome);
          if (cmd.asLeviathan) { g.flags |= GENOME_FLAG_LEVIATHAN; genome = encodeGenome(g); }
          name = `${p.payload.meta.name.genus} ${p.payload.meta.name.epithet}`;
        } catch (e) { return { id, ok: false, reason: `bad design: ${(e as Error).message}` }; }
        let snapshotId: string | undefined;
        if (cmd.asLeviathan) snapshotId = this.takeSnapshot('Before leviathan release', 'beforePower');
        const sp = this.addSpecies({ name, templ: 'meadowlamp', genome, origin: 'designed', parent: -1, ...(cmd.asLeviathan ? { leviathan: true } : {}) });
        sp.prefDepth = clamp(cmd.pos[1] / H, 0.05, 0.95);
        const n = Math.max(1, Math.min(500, Math.round(cmd.count)));
        for (let i = 0; i < n; i++) this.spawn(sp.id, cmd.pos[0] + (this.rnd() - 0.5) * 2, cmd.pos[1] + (this.rnd() - 0.5) * 1.2, -1, 0);
        this.event({ k: 'release', cmdId: id, species: sp.id, count: n, pos: cmd.pos, leviathan: cmd.asLeviathan });
        return { id, ok: true, eventId: this.eid - 1, ...(snapshotId ? { snapshotId } : {}) };
      }
      case 'select': this.selected = cmd.entity; return { id, ok: true };
      case 'snapshot': return { id, ok: true, snapshotId: this.takeSnapshot(cmd.label || 'Bookmark', 'manual') };
      case 'bookmark': {
        const snapshotId = this.takeSnapshot(cmd.label || 'Bookmark', 'manual');
        return { id, ok: true, snapshotId };
      }
      case 'rewind': {
        const s = this.snapshots.find((x) => x.info.id === cmd.snapshotId);
        if (!s) return { id, ok: false, reason: 'no such snapshot' };
        const present = this.takeSnapshot('Before rewind', 'beforeRewind');
        this.restore(s);
        this.epoch++;
        const p = this.snapshots.find((x) => x.info.id === present);
        if (p) p.info.parentId = s.info.id;
        this.scheduled = [];
        this.sendWelcome();
        return { id, ok: true, snapshotId: present };
      }
      case 'setting': return { id, ...this.setting(cmd.key, cmd.value) };
      default: return { id, ok: false, reason: 'unknown command' };
    }
  }

  /** Settings, knobs, renames and new worlds; unknown keys are refused like the real host does. */
  private setting(key: string, value: number | string | boolean): { ok: boolean; reason?: string } {
    const m = /^species\.(\d+)\.name$/.exec(key);
    if (m) {
      const sp = this.species[Number(m[1])];
      const n = parseRenameValue(value);
      if (!sp || !n) return { ok: false, reason: 'bad-name' };
      const oldGenus = sp.name.split(' ')[0];
      const targets = n.wholeGenus ? this.species.filter((x) => x.name.split(' ')[0] === oldGenus) : [sp];
      for (const x of targets) {
        const from = x.name;
        x.name = x === sp ? `${n.genus} ${n.epithet}` : `${n.genus} ${x.name.split(' ').slice(1).join(' ')}`;
        if (x === sp && n.common) x.common = n.common;
        x.namedBy = 'user';
        this.event({ k: 'rename', species: x.id, from, to: x.name } as unknown as EvIn);
      }
      return { ok: true };
    }
    if (key === 'world.new') {
      let o: { empty?: boolean } = {};
      try { o = JSON.parse(String(value)) as { empty?: boolean }; } catch { return { ok: false, reason: 'bad-setting' }; }
      this.takeSnapshot('Before new world', 'beforeRewind');
      this.creatures = []; this.species = []; this.slots = []; this.history = []; this.events = []; this.modifiers = []; this.scheduled = [];
      this.enteredSlots.clear();
      this.initWorld(o.empty === true);
      this.epoch++;
      this.sendWelcome();
      return { ok: true };
    }
    if (key === 'views.captions') { this.settings[key] = value === true; return { ok: true }; }
    const k = KNOB.get(key);
    if (!k || !k.live) return { ok: false, reason: 'unknown-setting' };
    const v = clampKnob(k, value);
    this.settings[key] = v;
    this.event({ k: 'setting', key, value: v } as unknown as EvIn);
    return { ok: true };
  }

  /** Energy flows over the last window (07 §3.6), from the toy diet table and live biomass. */
  private foodWeb(): FoodWeb {
    const flows: [number, number, number, FlowKind][] = [];
    for (const eater of this.species) {
      if (eater.count === 0) continue;
      const diet = DIET[eater.templ] ?? DIET.meadowlamp!;
      const intake = 0.02 + eater.biomassKg * 0.8;
      for (const [prey, share, kind] of diet) {
        if (typeof prey === 'number') { flows.push([prey, eater.id, intake * share, kind]); continue; }
        const preys = this.species.filter((x) => x.templ === prey && x.count > 0 && x.id !== eater.id);
        const tot = preys.reduce((a, x) => a + x.count, 0);
        for (const p of preys) flows.push([p.id, eater.id, (intake * share * p.count) / tot, kind]);
      }
    }
    return { windowS: 600, flows: flows.map(([a, b, f, k]) => [a, b, Math.round(f * 1e4) / 1e4, k]) };
  }

  private fire(s: Scheduled): void {
    const c = s.power;
    const tg = c.target;
    const pos: [number, number] = tg.kind === 'point' || tg.kind === 'circle' ? tg.pos : tg.kind === 'depthBand' ? [W / 2, (tg.y0 + tg.y1) / 2] : [W / 2, H / 2];
    const radius = tg.kind === 'circle' ? tg.radius : tg.kind === 'point' ? 1 + 5 * c.intensity : W;
    this.event({ k: 'god', cmdId: s.cmdId, power: c.power, author: 'god', tFire: this.tick, pos, radius, strength: c.intensity, major: s.major });
    const species = tg.kind === 'species' ? tg.species : undefined;
    const dur = HZ * (c.duration ?? 60);
    switch (c.power) {
      case 'meteor': {
        let deaths = 0;
        for (const x of this.creatures) if (Math.hypot(x.x - pos[0], x.y - pos[1]) < radius) { this.kill(x, 'disaster'); deaths++; }
        this.creatures = this.creatures.filter((x) => x.health > 0);
        this.event({ k: 'massDeath', centroid: pos, radius, deaths, z: 4 });
        break;
      }
      case 'cull': {
        for (const x of this.creatures) if ((!species || species.includes(x.sp)) && this.rnd() < 0.1 + 0.8 * c.intensity) this.kill(x, 'disaster');
        this.creatures = this.creatures.filter((x) => x.health > 0);
        break;
      }
      case 'bless': for (const x of this.creatures) if (!species || species.includes(x.sp) || (tg.kind === 'creature' && tg.entity === x.id)) x.energy = Math.min(1, x.energy + 0.1 + 0.9 * c.intensity); break;
      case 'vent': this.vents.push(pos); break;
      default: this.modifiers.push({ kind: c.power, x: pos[0], y: pos[1], r: radius, until: this.tick + dur, strength: c.intensity, ...(species ? { species } : {}) });
    }
  }

  private takeSnapshot(name: string, kind: SnapshotInfo['kind']): string {
    const id = `s${this.snapSeq++}`;
    const state = JSON.stringify({
      tick: this.tick, nextId: this.nextId, creatures: this.creatures, history: this.history,
      species: this.species.map((s) => ({ ...s, genome: Array.from(s.genome) })), events: this.events, vents: this.vents,
    });
    const info: SnapshotInfo = { id, name, tick: this.tick, epoch: this.epoch, kind, life: this.creatures.length, species: this.species.filter((s) => s.count > 0).length };
    this.snapshots.push({ info, state });
    const ofKind = this.snapshots.filter((s) => s.info.kind === kind);
    if (kind !== 'manual' && ofKind.length > 20) this.snapshots.splice(this.snapshots.indexOf(ofKind[0]!), 1);
    return id;
  }

  private restore(s: Snap): void {
    const st = JSON.parse(s.state) as { tick: number; nextId: number; creatures: Creature[]; history: [number, number[]][]; species: (Species & { genome: number[] })[]; events: SimEvent[]; vents: [number, number][] };
    this.tick = st.tick; this.nextId = st.nextId; this.creatures = st.creatures; this.history = st.history; this.events = st.events; this.vents = st.vents;
    this.species = st.species.map((x) => ({ ...x, genome: new Uint8Array(x.genome) }));
    this.slots = [];
    for (const c of this.creatures) { while (this.slots.length <= c.slot) this.slots.push(null); this.slots[c.slot] = c; }
    this.enteredSlots.clear();
    this.modifiers = [];
  }

  // ---------------- pacing and frames ----------------
  achieved(): number {
    if (this.speedReq === 0) return 0;
    if (this.speedReq === 'max') return 37.5;
    return this.speedReq;
  }

  private checkLease(): void {
    const wall = this.now();
    if (this.speedReq === 1) return;
    if (this.unattended && this.until) {
      const end = this.until.wallIso ? Date.parse(this.until.wallIso) : NaN;
      if ((Number.isFinite(end) && Date.now() >= end) || (this.until.tick !== undefined && this.tick >= this.until.tick)) { this.speedReq = 1; this.unattended = false; this.until = undefined; }
      return;
    }
    if (wall > this.leaseUntil) { this.speedReq = 1; this.until = undefined; }
  }

  /** Advance by wall time and emit frames (timer-driven, or called by tests). */
  pump(dtMs?: number): void {
    const wall = this.now();
    const dt = dtMs ?? Math.min(250, wall - this.lastWall);
    this.lastWall = wall;
    this.checkLease();
    this.acc += (dt / 1000) * HZ * this.achieved();
    const n = Math.min(400, Math.floor(this.acc));
    this.acc -= n;
    for (let i = 0; i < n; i++) this.step();
    if (!this.hello) return;
    this.frameCount++;
    // frame cadences follow wall time, so a busy page still gets 1 Hz stats
    const due = (k: 'dust' | 'insp' | 'stats', every: number) => { if (wall - this.lastSent[k] >= every || dtMs !== undefined) { this.lastSent[k] = wall; return true; } return false; };
    this.sendBodies();
    if (due('dust', 60)) this.emitFrame(this.dustFrame());
    if (this.outEvents.length > 0) {
      const evs = this.outEvents.slice(-40);
      this.outEvents = [];
      this.emitFrame(encodeCborFrame(FRAME.EVENT, this.tick, evs as unknown as CborValue));
    }
    if (this.selected >= 0 && due('insp', 100)) this.sendInspect();
    if (due('stats', 1000)) { this.sendEnv(); this.sendStats(false); }
  }

  private sendWelcome(): void {
    const pal = new Uint8Array(PALETTE.length * 3);
    PALETTE.forEach((c, i) => pal.set(c, i * 3));
    this.emitFrame(encodeCborFrame(FRAME.WELCOME, this.tick, {
      worldId: 'mock-founding-waters', tickHi: 0, epoch: this.epoch, tickHz: HZ, tank: { w: W, h: H, preset: 'small' },
      lCeiling: 0.126, palette: pal, speciesTable: this.species.map((s) => ({ id: s.id, name: s.name })), schemaHash: 'mock', scopes: ['view', 'god'], mock: true,
    }));
    this.enteredSlots.clear();
    this.sendEnv();
    this.sendStats(true);
    this.emitFrame(this.dustFrame());
    // recent history for the timeline (the host keeps an event log; views get the tail)
    const tail = this.events.filter((e) => e.k !== 'death' && e.k !== 'birth').slice(-80);
    if (tail.length) this.emitFrame(encodeCborFrame(FRAME.EVENT, this.tick, tail as unknown as CborValue));
  }

  private sendEnv(): void {
    const day = (this.tick / (HZ * 1200)) % 1, year = (this.tick / (HZ * 1200 * 20)) % 1;
    const night = this.modifiers.some((m) => m.kind === 'longNight');
    const temp = 14 + this.modifiers.reduce((s, m) => s + (m.kind === 'coldSnap' ? -10 * m.strength : m.kind === 'heatwave' ? 10 * m.strength : 0), 0);
    this.emitFrame(encodeEnv({ tick: this.tick, dayPhase: day, yearPhase: year, surfaceLight: night ? 0.1 : 0.5 + 0.5 * Math.sin(day * Math.PI * 2), surfaceTempC: temp, turbidity: 0.1, ySurface: 0, modes: [0.3, -0.2] }));
    this.emitFrame(encodeCborFrame(FRAME.CENSUS, this.tick, { species: this.species.map((s) => ({ id: s.id, count: s.count, biomassKg: s.biomassKg, colour: s.colour })), env: { tempC: temp } } as unknown as CborValue));
  }

  private sendBodies(): void {
    const enter = [];
    const leave: number[] = [];
    for (let s = 0; s < this.slots.length; s++) {
      const c = this.slots[s];
      if (c && !this.enteredSlots.has(s)) {
        this.enteredSlots.add(s);
        enter.push({ slot: s, id: c.id, genomeKey: (BigInt(c.key[1]) << 32n) | BigInt(c.key[0]), species: c.sp, log2Length: Math.log2(c.len), maturity: 255, energy: Math.round(c.energy * 255), lod: 0, flags: 0 });
      } else if (!c && this.enteredSlots.has(s)) { this.enteredSlots.delete(s); leave.push(s); }
    }
    if (leave.length) {
      const w = leave.slice(0, 2000);
      this.emitFrame(encodeBodyLeave(this.tick, w));
    }
    for (let i = 0; i < enter.length; i += 1500) this.emitFrame(encodeBodyEnter(this.tick, enter.slice(i, i + 1500)));
  }

  private dustFrame(): Uint8Array {
    const n = this.slots.length;
    const x = new Uint16Array(n), y = new Uint16Array(n), colour = new Uint8Array(n).fill(255), glow = new Uint8Array(n);
    for (let s = 0; s < n; s++) {
      const c = this.slots[s];
      if (!c) continue;
      x[s] = Math.round((c.x / W) * 65535); y[s] = Math.round((c.y / H) * 65535);
      colour[s] = c.sp % PALETTE.length;
      glow[s] = Math.round(90 + 140 * c.energy + (this.species[c.sp]!.leviathan ? 25 : 0));
    }
    return encodeDust({ tick: this.tick, rect: [0, 0, W, H], n, x, y, colour, glow });
  }

  private sendStats(full: boolean): void {
    const live = this.species;
    const payload: StatsPayload = {
      tick: this.tick, epoch: this.epoch,
      speed: { requested: this.speedReq, achieved: this.achieved(), ...(this.until ? { until: this.until } : {}), ...(this.unattended ? { unattended: true } : {}), leaseLeftS: Math.max(0, (this.leaseUntil - this.now()) / 1000) },
      population: this.creatures.length,
      species: live.map((s) => {
        const { templ: _t, speed: _s, cap: _c, genome: _g, key: _k, drift: _d, ...info } = s;
        void _t; void _s; void _c; void _g; void _k; void _d;
        return info;
      }),
      snapshots: this.snapshots.map((s) => s.info),
      sample: [this.tick, this.species.flatMap((s) => [s.id, s.count])],
      env: { tempC: 14, light: 0.6, vents: this.vents },
      settings: { ...this.settings },
      web: this.foodWeb(),
    };
    if (full) payload.history = this.history;
    if (this.statsCount++ % 5 === 0 || full) payload.genes = this.geneHists();
    const sel = this.creatures.find((c) => c.id === this.selected);
    if (sel) payload.selected = this.detail(sel);
    this.emitFrame(encodeCborFrame(FRAME.STATS, this.tick, payload as unknown as CborValue));
  }

  private geneHists(): Record<string, Record<string, number[]>> {
    const out: Record<string, Record<string, number[]>> = {};
    GENE_TRAITS.forEach(([name, idx], ti) => {
      out[name] = {};
      for (const s of this.species) {
        if (s.count === 0) continue;
        const centre = clamp(decodeGenome(s.genome).traits[idx]! / 65535 + (s.drift?.[ti] ?? 0), 0.02, 0.98);
        const bins = new Array(32).fill(0) as number[];
        const r = mulberry32(s.id * 977 + idx + this.statsCount * 7919);
        for (let i = 0; i < s.count; i++) {
          const v = clamp(centre + (r() + r() + r() - 1.5) * 0.06, 0, 0.9999);
          bins[Math.floor(v * 32)]!++;
        }
        out[name]![String(s.id)] = bins;
      }
    });
    return out;
  }

  private detail(c: Creature): InspectDetail {
    const ancestors: KinNode[] = [];
    let p = c.parent;
    while (p > 0 && ancestors.length < 6) {
      const a = this.creatures.find((x) => x.id === p);
      ancestors.push({ id: p, gen: a ? a.gen : Math.max(0, c.gen - ancestors.length - 1), alive: !!a, species: c.sp });
      p = a ? a.parent : -1;
    }
    const children = this.creatures.filter((x) => x.parent === c.id).slice(0, 12).map((x) => ({ id: x.id, gen: x.gen, alive: true, species: x.sp }));
    const ageS = (this.tick - c.bornTick) / HZ;
    const r = mulberry32(c.sp * 31 + 7);
    const inputs = ['BIAS', 'ENERGY', 'GUT', 'HEALTH', 'PAIN', 'DEPTH', 'LIGHT', 'SPEED', 'DAY_SIN', 'EYE L', 'EYE R', 'CHEMO', 'LATERAL'];
    const outputs = ['CPG_FREQ', 'CPG_AMP', 'CPG_TURN', 'MATE', 'LAY_BUD', 'EMIT', 'MOUTH', 'BITE'];
    const hidden = 10;
    const nNodes = inputs.length + outputs.length + hidden;
    const edges: [number, number, number][] = [];
    for (let i = 0; i < 46; i++) {
      const src = Math.floor(r() * (inputs.length + hidden));
      const s2 = src < inputs.length ? src : src + outputs.length;
      const dst = inputs.length + Math.floor(r() * (outputs.length + hidden));
      if (s2 !== dst) edges.push([s2, dst, Math.round((r() * 2 - 1) * 100) / 100]);
    }
    void nNodes;
    return {
      id: c.id, species: c.sp, energy: c.energy, health: c.health, ageS, lengthM: c.len * Math.min(1, 0.4 + ageS / 200), adult: ageS > 120,
      generation: c.gen, offspring: c.offspring, action: ACTIONS[(c.id + Math.floor(this.tick / 90)) % ACTIONS.length]!, parents: c.parent > 0 ? [c.parent] : [],
      ancestors, collapsed: Math.max(0, c.gen - ancestors.length - 1), children, genomeLo: c.key[0], genomeHi: c.key[1], pos: [c.x, c.y],
      brain: { inputs, outputs, hidden, edges },
    };
  }

  private sendInspect(): void {
    const c = this.creatures.find((x) => x.id === this.selected);
    if (!c) return;
    const n = 13 + 8 + 10;
    const act = new Int8Array(n);
    const t = this.tick / HZ;
    for (let i = 0; i < n; i++) act[i] = Math.round(127 * Math.sin(t * (0.5 + (i % 7) * 0.37) + i * 1.7) * (i < 13 ? 0.6 + 0.4 * c.energy : 1));
    act[1] = Math.round(c.energy * 127);
    this.emitFrame(encodeInspect(this.tick, c.id, act, new Float32Array([act[13]! / 127, act[14]! / 127])));
  }

  /** Test helper: the events emitted since the last call. */
  drainEvents(): SimEvent[] { const e = this.outEvents; this.outEvents = []; return e; }
  get templatesSeen(): TemplateId[] { return this.species.map((s) => s.templ as TemplateId); }
}

type EvIn = SimEvent extends infer E ? (E extends SimEvent ? Omit<E, 't' | 'eid' | 'epoch'> : never) : never;
const EPITHETS = ['caerula', 'spinata', 'lenta', 'velox', 'profunda', 'gigantea', 'tenebrosa', 'lucida', 'minor', 'gracilis'];
function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
