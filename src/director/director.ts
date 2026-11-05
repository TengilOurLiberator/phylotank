/**
 * The camera director (06 §6.2): StoryBook, scoring with exposure memory, seeded selection with
 * hysteresis, shot planning, the camera rig (critically damped springs, van Wijk and Nuij zoom
 * paths, dips to dark), captions and idle drift. A pure function of the event log, the census,
 * the seed, the config and the wall-clock deltas it is given (DESIGN R19).
 */
import {
  clamp, exp, log, log2, RNG_STREAM, RngStream, sin, TAU, TICK_HZ,
  type Camera, type DirectorModule, type Id, type SimEvent, type V2, type ViewMode,
} from '../core/index.js';
import { boxesOverlap, captionBox, captionFor, speciesName, type CaptionState, type SpeciesName } from './captions.js';
import { DriftPlanner, type HeatMap } from './drift.js';
import { ExposureMemory } from './exposure.js';
import { saturate, softCap, springCritical, trapezoid, trapezoidPeak, ZoomPath, type SpringOut } from './motion.js';
import { directorParams, SHOT_PARAMS, TYPE_PARAMS, type DirectorParams, type ShotKind, type StoryType } from './params.js';
import { StoryBook, type Story } from './storybook.js';

export interface DirectorConfig {
  mode: ViewMode;
  tankW: number;
  tankH: number;
  viewWpx: number;
  viewHpx: number;
  seedLo?: number;
  seedHi?: number;
  lCeilingM?: number;
  reducedMotion?: boolean;
  calmDirector?: boolean;
  /** Open on the first shot's framing instead of gliding in from the whole tank (live views). */
  startSettled?: boolean;
  params?: Partial<DirectorParams>;
}

export interface CensusSpecies { id: number; count: number; biomassKg: number; colour?: number }
export interface Census { species: CensusSpecies[]; heat?: Uint8Array; heatW?: number; heatH?: number; heatCh?: number }

export type Transition = 'glide' | 'zoomPath' | 'dip' | 'cut0';

export interface ShotRecord {
  n: number;
  kind: ShotKind;
  storyId: number;
  storyType: StoryType | 'idle';
  primary: Id | null;
  subjects: Id[];
  tStart: number;
  tEnd: number;
  minHold: number;
  maxHold: number;
  transition: Transition;
  /** Why the previous shot ended and this one started. */
  reason: 'start' | 'idle' | 'margin' | 'ended' | 'maxHold' | 'interrupt' | 'sequence' | 'deadline' | 'subjectDied';
  score: number;
}

interface Shot {
  rec: ShotRecord;
  story: Story | null;
  seq: number;
  /** Planned duration (s). */
  dur: number;
  /** Wall time the transition is expected to finish. */
  tSettle: number;
  /** Fixed framing data. */
  r: number;
  z0: number;
  revealDelta: number;
  driftOx: number;
  holdX: number;
  holdY: number;
  hasHold: boolean;
}

export interface DirectorFrame {
  camera: Camera;
  /** Exposure multiplier for the renderer (dips to dark), 0.15 to 1. */
  dim: number;
  caption: CaptionState | null;
  captionAlpha: number;
  /** Predicted viewport for VIEWPORT prefetch (CONTRACT 12.2). */
  predicted: { cx: number; cy: number; zeta: number; leadS: number };
  shot: ShotRecord | null;
  mode: 'spring' | 'path' | 'dip';
}

/** Interrupt-class story types with a score above 8 may cut in after 2 s (06 §6.2.4 rule 3). */
const AFTERMATH_TYPES: ReadonlySet<StoryType> = new Set<StoryType>(['kill', 'extinction']);

export class Director implements DirectorModule {
  readonly p: DirectorParams;
  readonly book: StoryBook;
  readonly exposure: ExposureMemory;
  readonly shots: ShotRecord[] = [];
  readonly dips: number[] = [];
  /** Whether each dip was taken to catch a god event (those may break the 20 s spacing). */
  readonly dipForGod: boolean[] = [];
  private readonly rng: RngStream;
  private readonly drift: DriftPlanner;
  private readonly cfg: Required<Pick<DirectorConfig, 'tankW' | 'tankH' | 'viewWpx' | 'viewHpx'>>;
  private locator: ((id: Id) => V2 | null) | null = null;
  private names: (id: number) => SpeciesName = speciesName;
  private wall = 0;
  private sim = 0;
  private simTickSet = false;
  private decideAcc = 0;
  private decisions = 0;
  private started = false;
  // rig state: centre (m), zeta; velocities in screen widths/s and octaves/s
  private x = 0; private y = 0; private z = 0;
  private vx = 0; private vy = 0; private vz = 0;
  private rigMode: 'spring' | 'path' | 'dip' = 'spring';
  private path: ZoomPath | null = null;
  private pathT0 = 0; private pathT = 0;
  private pathOff = { vx: 0, vy: 0, vz: 0 };
  private dipT0 = 0; private dipDown = 1.2; private dipJumped = false; private dipFrom = 1;
  private dimV = 1;
  private shot: Shot | null = null;
  private lowSince: number | null = null;
  private featured = new Map<Id, number>();
  private segs: { type: StoryType; t0: number; t1: number }[] = [];
  private halved = new Set<StoryType>();
  private cap: CaptionState | null = null;
  private lastCapShow = -Infinity;
  private lastCapSpecies: number | null = null;
  private forceDecide = false;
  private readonly tgt = { x: 0, y: 0, zeta: 0, omega: 1 };
  private readonly so: SpringOut = { x: 0, v: 0 };
  private trackHold: [number, number] | null = null;
  private observed: { id: Id; species: number; prominence: number }[] = [];
  private readonly startSettled: boolean;
  /** Cost of the last decide() in ms, if a clock was supplied (spike and property 10). */
  lastScoreCount = 0;

  constructor(cfg: DirectorConfig) {
    const p = directorParams(cfg.mode, { reducedMotion: cfg.reducedMotion ?? false, calmDirector: cfg.calmDirector ?? false });
    this.p = { ...p, ...(cfg.params ?? {}) };
    this.cfg = { tankW: cfg.tankW, tankH: cfg.tankH, viewWpx: cfg.viewWpx, viewHpx: cfg.viewHpx };
    this.book = new StoryBook({
      maxStories: this.p.maxStories, mergeRadiusM: this.p.mergeRadiusM, mergeWindowS: this.p.mergeWindowS,
      lCeilingM: cfg.lCeilingM ?? 0.126, tankW: cfg.tankW, tankH: cfg.tankH,
    });
    // 32 m cells on the Default tank (64 m wide); scaled so every preset has about 4 x 2 cells.
    const cell = Math.min(this.p.regionCellM, cfg.tankW / 4);
    this.exposure = new ExposureMemory({ halfLife: this.p.halfLife, beta: this.p.beta, regionCellM: cell });
    this.rng = new RngStream(cfg.seedLo ?? 0, cfg.seedHi ?? 0, RNG_STREAM.VIEW_DIRECTOR);
    this.drift = new DriftPlanner(this.rng, cfg, this.p.wobble);
    this.x = cfg.tankW / 2; this.y = cfg.tankH / 2; this.z = this.zMin();
    this.startSettled = cfg.startSettled ?? false;
  }

  // ---------------- adapter API (see docs/contract-requests/director.md) ----------------
  setLocator(fn: ((id: Id) => V2 | null) | null): void { this.locator = fn; }
  setNames(fn: (id: number) => SpeciesName): void { this.names = fn; }
  setSimTick(tick: number): void { this.sim = tick / TICK_HZ; this.simTickSet = true; }
  resize(viewWpx: number, viewHpx: number): void { this.cfg.viewWpx = viewWpx; this.cfg.viewHpx = viewHpx; }
  setCensus(c: Census): void {
    if (c.heat && c.heatW && c.heatH) {
      const hm: HeatMap = { w: c.heatW, h: c.heatH, ch: c.heatCh ?? 4, data: c.heat };
      this.drift.heat = hm;
    }
  }
  /** Bodies on screen this frame with their prominence (min(1, area fraction x 4)), from the renderer. */
  observe(list: { id: Id; species: number; prominence: number }[]): void { this.observed = list; }
  get wallTime(): number { return this.wall; }
  get simTime(): number { return this.sim; }

  // ---------------- DirectorModule ----------------
  update(events: readonly SimEvent[], dtWall: number, current: Camera): Camera {
    return this.step(events, dtWall, current).camera;
  }
  caption(): string | null {
    const c = this.cap;
    if (!c || this.wall < c.tShow || this.wall > c.tEnd) return null;
    return c.text.line1 ? `${c.text.line1}\n${c.text.line2}` : c.text.line2;
  }

  /** One frame: ingest events, decide at 2 Hz, move the rig. */
  step(events: readonly SimEvent[], dtWall: number, current?: Camera): DirectorFrame {
    if (!this.started) {
      this.started = true;
      if (current && current.zeta > 0) { this.x = current.cx; this.y = current.cy; this.z = current.zeta; }
      this.clampView();
      this.decide();
      this.forceDecide = false;
      if (this.startSettled && !current && this.shot) {
        // twice: the first pass clamps the centre for the whole-tank view the rig starts in
        this.shotTarget(this.shot, this.wall);
        this.z = this.tgt.zeta;
        this.shotTarget(this.shot, this.wall);
        this.x = this.tgt.x; this.y = this.tgt.y; this.z = this.tgt.zeta;
        this.clampView();
      }
    }
    let maxT = -Infinity;
    for (const ev of events) {
      if (this.p.stories) {
        const s = this.book.ingest(ev);
        if (s && s.type === 'disaster') this.forceDecide = true;
        if (s && this.shot && this.shot.story && s === this.shot.story && s.ended && ev.k === 'death') this.forceDecide = true;
      }
      if (ev.t > maxT) maxT = ev.t;
    }
    const dt = dtWall > 0 ? dtWall : 0;
    this.wall += dt;
    if (!this.simTickSet) this.sim += dt;
    if (maxT / TICK_HZ > this.sim) this.sim = maxT / TICK_HZ;
    this.decideAcc += dt;
    const period = 1 / this.p.tickHz;
    if (this.forceDecide || this.decideAcc >= period) {
      this.decideAcc = this.forceDecide ? this.decideAcc : this.decideAcc - period;
      if (this.decideAcc > period) this.decideAcc = 0;
      this.forceDecide = false;
      this.decide();
    }
    // Rig: substep long gaps so the springs stay exact and the limits hold.
    let left = Math.min(dt, 1);
    while (left > 1e-9) {
      const h = Math.min(left, 1 / 30);
      this.rigClock += h;
      this.rigStep(h);
      left -= h;
    }
    this.rigClock = this.wall;
    if (dt > 0) this.accumulateExposure(dt);
    this.updateCaption();
    if (this.shot) this.shot.rec.tEnd = this.wall;
    return this.frame();
  }

  frame(): DirectorFrame {
    const c = this.cap;
    let alpha = 0;
    if (c && this.wall >= c.tShow && this.wall <= c.tEnd) {
      const cp = this.p.captions!;
      alpha = Math.min(1, (this.wall - c.tShow) / cp.fadeInS, (c.tEnd - this.wall) / cp.fadeOutS);
    }
    const tg = this.tgt;
    const ex = (tg.x - this.x) / this.swM();
    const ey = (tg.y - this.y) / this.swM();
    const dist = Math.sqrt(ex * ex + ey * ey);
    const lead = clamp(Math.max(dist / this.p.panLimit, Math.abs(tg.zeta - this.z) / this.p.zoomLimit), 0, 10);
    return {
      camera: { cx: this.x, cy: this.y, zeta: this.z },
      dim: this.dimV,
      caption: alpha > 0 ? c : null,
      captionAlpha: alpha,
      predicted: { cx: tg.x, cy: tg.y, zeta: tg.zeta, leadS: this.rigMode === 'path' ? Math.max(0, this.pathT0 + this.pathT - this.wall) : lead },
      shot: this.shot ? this.shot.rec : null,
      mode: this.rigMode,
    };
  }

  // ---------------- geometry ----------------
  /** Metres per screen width at the current zoom. */
  private swM(z = this.z): number { return this.cfg.viewWpx / exp2(z); }
  private zMin(): number {
    const m = this.p.marginFrac * this.cfg.tankH;
    return log2(Math.max(this.cfg.viewWpx / (this.cfg.tankW + 2 * m), this.cfg.viewHpx / (this.cfg.tankH + 2 * m)));
  }
  private zMax(): number { return log2(this.cfg.viewHpx / this.p.minVisH); }
  private clampCentre(x: number, y: number, z: number, out: { x: number; y: number }): void {
    const m = this.p.marginFrac * this.cfg.tankH;
    const hw = this.cfg.viewWpx / exp2(z) / 2;
    const hh = this.cfg.viewHpx / exp2(z) / 2;
    const xlo = hw - m; const xhi = this.cfg.tankW + m - hw;
    const ylo = hh - m; const yhi = this.cfg.tankH + m - hh;
    out.x = xlo > xhi ? this.cfg.tankW / 2 : clamp(x, xlo, xhi);
    out.y = ylo > yhi ? this.cfg.tankH / 2 : clamp(y, ylo, yhi);
  }
  private clampView(): void {
    const zmin = this.zMin();
    if (this.z < zmin) { this.z = zmin; if (this.vz < 0) this.vz = 0; }
    const zmax = this.zMax();
    if (this.z > zmax) { this.z = zmax; if (this.vz > 0) this.vz = 0; }
    const o = { x: 0, y: 0 };
    this.clampCentre(this.x, this.y, this.z, o);
    if (o.x !== this.x) { this.x = o.x; this.vx = 0; }
    if (o.y !== this.y) { this.y = o.y; this.vy = 0; }
  }
  private zetaForVisH(visH: number): number { return log2(this.cfg.viewHpx / visH); }
  /** Van Wijk path length (screen widths) from the current view to a target view. */
  travel(x: number, y: number, z: number): number {
    const path = new ZoomPath(this.x, this.y, this.swM(), x, y, this.swM(z), this.p.rho);
    return path.S;
  }

  // ---------------- subjects ----------------
  private subjectPos(id: Id | undefined, fallback: V2): V2 {
    if (id === undefined) return fallback;
    const l = this.locator ? this.locator(id) : null;
    if (l) return l;
    return this.book.where(id) ?? fallback;
  }

  /** Framing for a shot at wall time t: writes this.tgt. */
  private shotTarget(sh: Shot, t: number): void {
    const tg = this.tgt;
    const kind = sh.rec.kind;
    const sp = SHOT_PARAMS[kind];
    tg.omega = sp.omega;
    if (kind === 'drift' || !sh.story) {
      this.drift.target(t, this.driftDt, (x, y) => this.exposure.regionLoad(x, y, this.wall), tg);
      this.driftDt = 0;
      tg.omega = 0.4;
      this.finishTarget();
      return;
    }
    const s = sh.story;
    let cx = s.pos[0];
    let cy = s.pos[1];
    let r = sh.r;
    if (kind === 'track' && !s.ended) {
      const a = this.subjectPos(s.subjects[0], s.pos);
      if (s.subjects.length >= 2 && (s.type === 'hunt' || s.type === 'giantKill' || s.type === 'mating')) {
        const b = this.subjectPos(s.subjects[1], s.pos);
        cx = (a[0] + b[0]) / 2; cy = (a[1] + b[1]) / 2;
        const ex = a[0] - b[0]; const ey = a[1] - b[1];
        r = Math.max(r, 0.5 * Math.sqrt(ex * ex + ey * ey) + 0.3);
      } else { cx = a[0]; cy = a[1]; }
      // look-ahead 0.5 s and lead room in the heading direction
      cx += s.vel[0] * 0.5; cy += s.vel[1] * 0.5;
    }
    if (sh.hasHold && (kind === 'aftermath' || s.ended)) { cx = sh.holdX; cy = sh.holdY; }
    const dtShot = Math.max(0, t - sh.rec.tStart);
    let visH = (2 * r) / sp.fill;
    let z = this.zetaForVisH(visH);
    if (kind === 'establish') {
      z += 0.1 * sin((TAU * dtShot) / 20);
      cx += sh.driftOx * dtShot * 0.02 * this.swM(z);
    } else if (kind === 'pushIn') {
      const f = clamp((t - sh.tSettle) / Math.max(1, sh.dur - (sh.tSettle - sh.rec.tStart)), 0, 1);
      const e = f * f * (3 - 2 * f);
      z = this.zetaForVisH(visH) + e * log2(0.5 / 0.2);
    } else if (kind === 'reveal') {
      const pull = Math.max(0, t - sh.tSettle - 2.5) * 0.3;
      z = this.zetaForVisH(visH) + Math.max(0, sh.revealDelta - pull);
    } else if (kind === 'aftermath') {
      z = sh.z0 - 0.1 * dtShot;
    }
    if (kind === 'track') {
      const visW = this.swM(z);
      const sx = s.vel[0];
      const speed = Math.abs(sx);
      if (speed > 1e-3) cx += Math.sign(sx) * 0.12 * visW * Math.min(1, speed / 0.05);
      // dead zone: hold the target while the subject stays within 15% of the screen width
      if (this.trackHold) {
        const dx = cx - this.trackHold[0];
        const dy = cy - this.trackHold[1];
        if (Math.sqrt(dx * dx + dy * dy) < 0.075 * visW) { cx = this.trackHold[0]; cy = this.trackHold[1]; }
        else this.trackHold = [cx, cy];
      } else this.trackHold = [cx, cy];
    }
    visH = this.cfg.viewHpx / exp2(z);
    // keep subjects out of the caption band (lower third) while captions are on
    if (this.p.captions) cy += 0.1 * visH;
    tg.x = cx; tg.y = cy; tg.zeta = z;
    if (s.type === 'disaster' && kind === 'establish') this.frameUnionOfDisasters();
    this.finishTarget();
  }

  /** Two disasters at once: frame them together (06 §6.8.2 property 8). */
  private frameUnionOfDisasters(): void {
    const pend: Story[] = [];
    for (const s of this.book.stories.values()) {
      if (s.type !== 'disaster' || s.tFire === undefined) continue;
      if (s.tFire + 2 >= this.sim && s.tStart <= this.sim) pend.push(s);
    }
    if (pend.length < 2) return;
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const s of pend) {
      x0 = Math.min(x0, s.pos[0] - s.radius); x1 = Math.max(x1, s.pos[0] + s.radius);
      y0 = Math.min(y0, s.pos[1] - s.radius); y1 = Math.max(y1, s.pos[1] + s.radius);
    }
    const tg = this.tgt;
    tg.x = (x0 + x1) / 2; tg.y = (y0 + y1) / 2;
    const aspect = this.cfg.viewWpx / this.cfg.viewHpx;
    const visH = Math.max(y1 - y0, (x1 - x0) / aspect) * 1.2;
    tg.zeta = Math.min(tg.zeta, this.zetaForVisH(visH));
  }

  private finishTarget(): void {
    const tg = this.tgt;
    // Targets stop 0.05 octaves short of the whole-habitat view, so the corridor the centre may
    // move in never closes to a point (it would stop any lateral motion dead, D9).
    tg.zeta = clamp(tg.zeta, this.zMin() + 0.05, this.zMax());
    const o = { x: 0, y: 0 };
    // clamp for the wider of the current and the target view, so the way there stays inside too
    this.clampCentre(tg.x, tg.y, Math.min(tg.zeta, this.z), o);
    tg.x = o.x; tg.y = o.y;
  }

  // ---------------- scoring ----------------
  /** Score S of a story at the current time (06 §6.2.4). */
  score(s: Story, isCurrent: boolean): number {
    return this.score0(s, isCurrent) * this.travelFactor(s, isCurrent);
  }

  /** Travel factor T = exp(-u / u0), exempt for disasters and the current story. */
  private travelFactor(s: Story, isCurrent: boolean): number {
    if (s.type === 'disaster' || isCurrent) return 1;
    const tp = TYPE_PARAMS[s.type];
    const r = Math.max(0.3, s.radius);
    const z = clamp(this.zetaForVisH((2 * r) / SHOT_PARAMS[tp.shots[0]!].fill), this.zMin(), this.zMax());
    return exp(-this.travel(s.pos[0], s.pos[1], z) / this.p.travelU0);
  }

  /** The score without the travel factor: an upper bound of S, since T <= 1. */
  private score0(s: Story, isCurrent: boolean): number {
    const tp = TYPE_PARAMS[s.type];
    let W = tp.w;
    if (s.type !== 'disaster') W *= this.p.weightScale;
    if (this.halved.has(s.type) && s.type !== 'disaster') W *= 0.5;
    const tLast = s.tFire !== undefined ? Math.max(s.tLast, s.tFire) : s.tLast;
    const tau = tp.tau === Infinity ? (s.ended ? 30 : Infinity) : tp.tau;
    const age = Math.max(0, this.sim - tLast);
    if (age > 12 * tau) return 0; // A < 1e-5: not worth the exposure lookups
    const A = tau === Infinity ? 1 : exp(-age / tau);
    const base = W * (1 + this.p.a * log(1 + Math.max(0, s.magnitude) / tp.m0));
    // Disasters are exempt from novelty as well as travel: every god event must be filmed.
    const N = s.type === 'disaster' ? 1 : this.exposure.novelty(s.subjects, s.species, s.type, s.pos[0], s.pos[1], this.wall);
    const V = s.ended && !AFTERMATH_TYPES.has(s.type) && s.type !== 'disaster' ? 0.5 : 1;
    const sh = this.shot;
    const Q = isCurrent && sh && this.wall - sh.rec.tStart < sh.dur ? 1.3 : 1;
    return base * A * N * V * Q;
  }

  private repeatBlocked(s: Story): boolean {
    if (TYPE_PARAMS[s.type].repeatOk) return false;
    const id = s.subjects[0];
    if (id === undefined) return false;
    const t = this.featured.get(id);
    return t !== undefined && this.wall - t < this.p.repeatWindowS;
  }

  private updateDiversity(): void {
    const t0 = this.wall - this.p.diversityWindowS;
    while (this.segs.length > 0 && this.segs[0]!.t1 < t0) this.segs.shift();
    const per = new Map<StoryType, number>();
    let total = 0;
    for (const g of this.segs) {
      const d = Math.max(0, g.t1 - Math.max(g.t0, t0));
      per.set(g.type, (per.get(g.type) ?? 0) + d);
      total += d;
    }
    if (total < 120) return;
    for (const [type, d] of per) {
      const f = d / total;
      if (f > this.p.diversityHigh) this.halved.add(type);
      else if (f < this.p.diversityLow) this.halved.delete(type);
    }
    for (const type of [...this.halved]) if (!per.has(type)) this.halved.delete(type);
  }

  // ---------------- decisions (2 Hz) ----------------
  /** One director tick (normally called by step at 2 Hz; public for the cost test). */
  decide(): void {
    this.decisions++;
    this.exposure.prune(this.wall);
    if ((this.decisions & 127) === 0) {
      this.book.prune(this.sim, (st) => 12 * (TYPE_PARAMS[st.type].tau === Infinity ? 30 : TYPE_PARAMS[st.type].tau));
    }
    this.updateDiversity();
    const cur = this.shot;
    const curStory = cur?.story ?? null;
    // subject died mid-shot: the shot becomes aftermath in place (no camera jump)
    if (cur && curStory && curStory.ended && cur.rec.kind === 'track' && !cur.hasHold) {
      cur.hasHold = true; cur.holdX = this.x; cur.holdY = this.y;
      this.startShot(curStory, 'aftermath', 'subjectDied', cur.seq, this.score(curStory, true), true);
      return;
    }
    if (!this.p.stories) { if (!cur) this.startIdle('start'); return; }
    const cands = this.cands;
    cands.length = 0;
    let best = 0;
    let curS = 0;
    let n = 0;
    // Pass 1: the cheap upper bound S0 (no travel); pass 2: the travel factor in descending S0
    // order, stopping once S0 falls below the candidate cut, which no later story can reach.
    const pre = this.pre;
    pre.length = 0;
    let np = 0;
    for (const s of this.book.stories.values()) {
      n++;
      const isCur = s === curStory;
      if (!isCur && s.type === 'disaster' && s.tFire !== undefined && s.tStart > this.sim + 1) continue;
      const S0 = this.score0(s, isCur);
      s.score = S0;
      if (isCur) { curS = S0; continue; }
      if (S0 < 1e-3 || this.repeatBlocked(s)) continue;
      let slot = this.prePool[np];
      if (!slot) { slot = { s, S: S0 }; this.prePool[np] = slot; } else { slot.s = s; slot.S = S0; }
      np++;
      pre.push(slot);
    }
    pre.sort((a, b) => b.S - a.S || a.s.id - b.s.id);
    let evals = 0;
    for (const c of pre) {
      if (c.S < this.p.candidateFrac * best) break;
      // bounded cost: only the 64 best upper bounds are refined (decision D6)
      if (++evals > 64) break;
      const S = c.S * this.travelFactor(c.s, false);
      c.s.score = S;
      if (S > best) best = S;
      cands.push({ s: c.s, S });
    }
    this.lastScoreCount = n;
    const top = Math.max(best, curS);
    if (top < this.p.idleThreshold) { if (this.lowSince === null) this.lowSince = this.wall; } else this.lowSince = null;
    const elapsed = cur ? this.wall - cur.rec.tStart : Infinity;
    const minHold = cur ? cur.rec.minHold : 0;
    // 1. interrupts (and god deadlines, which may cut in before 2 s so the camera is there by tFire)
    let intr: { s: Story; S: number } | null = null;
    for (const c of cands) {
      const tp = TYPE_PARAMS[c.s.type];
      // a god event still to fire (or just fired) always cuts in: it must be on screen by tFire
      const pendingGod = c.s.type === 'disaster' && c.s.tFire !== undefined && c.s.tFire + 0.5 >= this.sim;
      if (pendingGod) {
        const cs = curStory;
        const curPending = cs && cs.type === 'disaster' && cs.tFire !== undefined && cs.tFire + 2 >= this.sim && cur!.rec.kind === 'establish';
        if (curPending) {
          // the establishing shot frames every pending disaster together; re-plan the move once
          if (!this.unionSeen.has(c.s.id)) {
            this.unionSeen.add(c.s.id);
            this.shotTarget(cur!, this.wall);
            this.planTransition(false, Math.max(0.3, c.s.tFire! - this.sim), c.s.pos);
            cur!.rec.transition = this.lastTransition;
          }
          continue;
        }
        if (!intr || intr.s.type !== 'disaster' || (c.s.tFire! < (intr.s.tFire ?? Infinity))) intr = c;
        continue;
      }
      if (intr && intr.s.type === 'disaster' && intr.s.tFire !== undefined && intr.s.tFire + 0.5 >= this.sim) continue;
      if (!tp.interrupt || c.S <= this.p.interruptScore) continue;
      if (curStory && curStory.type === 'disaster' && c.s.type !== 'disaster') continue;
      if (curStory && TYPE_PARAMS[curStory.type].interrupt && c.S <= curS && c.s.type !== 'disaster') continue;
      if (c.s.type === 'disaster' && c.s.tFire !== undefined && c.s.tFire + 2 < this.sim) continue;
      if (curStory && curStory.type === 'disaster' && c.s.type === 'disaster' && curStory.tFire !== undefined &&
          curStory.tFire > this.sim && (c.s.tFire ?? 0) >= curStory.tFire) continue;
      if (!intr || c.S > intr.S) intr = c;
    }
    if (intr) {
      const deadline = intr.s.type === 'disaster' && intr.s.tFire !== undefined && intr.s.tFire >= this.sim;
      if (elapsed >= this.p.interruptAfterS || deadline) {
        this.startShot(intr.s, TYPE_PARAMS[intr.s.type].shots[0]!, deadline ? 'deadline' : 'interrupt', 0, intr.S, false);
        return;
      }
    }
    // 2. idle
    if (!cur || cur.rec.kind === 'drift') {
      const pick = this.pick(cands, best);
      if (pick && pick.S >= this.p.idleThreshold && (!cur || elapsed >= 5 || pick.S > 2)) {
        this.startShot(pick.s, TYPE_PARAMS[pick.s.type].shots[0]!, cur ? 'idle' : 'start', 0, pick.S, false);
      } else if (!cur) this.startIdle('start');
      return;
    }
    if (this.lowSince !== null && this.wall - this.lowSince >= this.p.idleAfterS && elapsed >= minHold) {
      this.startIdle('idle');
      return;
    }
    // 3. the current story ended: aftermath hold of 3 s, then move on
    if (curStory && curStory.ended && !AFTERMATH_TYPES.has(curStory.type) && cur.rec.kind !== 'aftermath') {
      const tEnd = curStory.tLast;
      if (this.sim - tEnd >= this.p.aftermathHoldS && elapsed >= Math.min(minHold, 3)) {
        this.moveOn(cands, best, 'ended');
        return;
      }
    }
    // 4. planned duration reached: next shot of the sequence, or another story
    if (elapsed >= cur.dur) {
      const seq = curStory ? TYPE_PARAMS[curStory.type].shots : [];
      if (curStory && cur.seq + 1 < seq.length) {
        this.startShot(curStory, seq[cur.seq + 1]!, 'sequence', cur.seq + 1, curS, true);
        return;
      }
      this.moveOn(cands, best, 'maxHold');
      return;
    }
    // 5. a better story by the switch margin, after the minimum hold
    if (elapsed >= minHold) {
      const pick = this.pick(cands, best);
      if (pick && pick.S > (1 + this.p.switchMargin) * curS) {
        this.startShot(pick.s, TYPE_PARAMS[pick.s.type].shots[0]!, 'margin', 0, pick.S, false);
      }
    }
  }

  private moveOn(cands: { s: Story; S: number }[], best: number, reason: ShotRecord['reason']): void {
    const pick = this.pick(cands, best);
    if (pick && pick.S >= this.p.idleThreshold) this.startShot(pick.s, TYPE_PARAMS[pick.s.type].shots[0]!, reason, 0, pick.S, false);
    else this.startIdle(reason);
  }

  /** Seeded softmax over ln S among stories with S >= 0.6 S_best (06 §6.2.4 rule 1). */
  private pick(cands: { s: Story; S: number }[], best: number): { s: Story; S: number } | null {
    if (best <= 0) return null;
    const lim = this.p.candidateFrac * best;
    const pool = cands.filter((c) => c.S >= lim);
    pool.sort((a, b) => b.S - a.S || a.s.id - b.s.id);
    // softmax over ln S with temperature T: weights (S / S_best)^(1/T)
    const invT = 1 / this.p.softmaxTemp;
    let tot = 0;
    const w = this.w;
    w.length = pool.length;
    for (let i = 0; i < pool.length; i++) { const v = exp(invT * log(pool[i]!.S / best)); w[i] = v; tot += v; }
    const u = this.rng.draw(this.decisions, 1).u01x53() * tot;
    let acc = 0;
    for (let i = 0; i < pool.length; i++) { acc += w[i]!; if (u < acc) return pool[i]!; }
    return pool[pool.length - 1] ?? null;
  }

  private startIdle(reason: ShotRecord['reason']): void {
    this.trackHold = null;
    const rec: ShotRecord = {
      n: this.shots.length, kind: 'drift', storyId: 0, storyType: 'idle', primary: null, subjects: [],
      tStart: this.wall, tEnd: this.wall, minHold: 0, maxHold: Infinity, transition: 'glide', reason, score: 0,
    };
    this.closeSeg();
    this.shots.push(rec);
    this.shot = { rec, story: null, seq: 0, dur: Infinity, tSettle: this.wall, r: 1, z0: this.z, revealDelta: 0, driftOx: 0, holdX: 0, holdY: 0, hasHold: false };
    this.shotTarget(this.shot, this.wall);
    this.planTransition(false);
  }

  private closeSeg(): void {
    const cur = this.shot;
    if (cur && cur.story) this.segs.push({ type: cur.story.type, t0: cur.rec.tStart, t1: this.wall });
  }

  private startShot(s: Story, kind: ShotKind, reason: ShotRecord['reason'], seq: number, S: number, sameStory: boolean): void {
    const d = this.rng.draw(this.decisions, 2);
    const sp = SHOT_PARAMS[kind];
    const hs = this.p.holdScale;
    let [mn, mx] = sp.hold;
    mn *= hs; mx *= hs;
    if (s.type === 'lastOfSpecies' && !s.ended) mx *= 1.5;
    const dur = mn + (mx - mn) * d.u01();
    this.closeSeg();
    const rec: ShotRecord = {
      n: this.shots.length, kind, storyId: s.id, storyType: s.type, primary: s.subjects[0] ?? null,
      subjects: s.subjects.slice(0, 4), tStart: this.wall, tEnd: this.wall, minHold: mn, maxHold: mx,
      transition: 'glide', reason, score: S,
    };
    const prev = this.shot;
    const r = Math.max(kind === 'track' ? 0.3 : 0.5, s.radius);
    const sh: Shot = {
      rec, story: s, seq, dur, tSettle: this.wall, r, z0: this.z,
      revealDelta: kind === 'reveal' ? 2 + 2 * d.u01() : 0,
      driftOx: d.u01() < 0.5 ? -1 : 1,
      holdX: s.pos[0], holdY: s.pos[1], hasHold: kind === 'aftermath' || (sameStory && prev?.hasHold === true),
    };
    if (kind === 'aftermath' && sameStory && prev) { sh.holdX = prev.holdX; sh.holdY = prev.holdY; }
    if (kind === 'aftermath' && reason === 'subjectDied') { sh.holdX = this.x; sh.holdY = this.y; sh.z0 = this.z; }
    if (!sameStory) this.trackHold = null;
    this.shot = sh;
    this.shots.push(rec);
    if (rec.primary !== null && !TYPE_PARAMS[s.type].repeatOk) this.featured.set(rec.primary, this.wall);
    else if (rec.primary !== null && !this.featured.has(rec.primary)) this.featured.set(rec.primary, this.wall);
    if (this.featured.size > 4096) {
      for (const [id, t] of this.featured) if (this.wall - t > this.p.repeatWindowS) this.featured.delete(id);
    }
    this.shotTarget(sh, this.wall);
    if (kind === 'aftermath' && !sameStory) sh.z0 = this.tgt.zeta;
    const deadline = s.type === 'disaster' && s.tFire !== undefined ? Math.max(0.3, s.tFire - this.sim) : null;
    if (s.type === 'disaster') { this.unionSeen.add(s.id); if (this.unionSeen.size > 256) this.unionSeen.clear(); }
    this.planTransition(sameStory, deadline);
    rec.transition = this.lastTransition;
    if (this.cap && this.cap.storyId !== s.id && this.wall < this.cap.tShow) this.cap = null;
    if (this.cap && this.cap.storyId !== s.id && this.wall < this.cap.tEnd) {
      this.cap.tEnd = Math.min(this.cap.tEnd, this.wall + this.p.captions!.fadeOutS);
    }
  }

  private lastTransition: Transition = 'glide';
  /** Until this wall time the springs run at least at omega 2 (a god event is due). */
  private urgentUntil = -Infinity;
  private readonly pre: { s: Story; S: number }[] = [];
  private readonly prePool: { s: Story; S: number }[] = [];
  private readonly cands: { s: Story; S: number }[] = [];
  private readonly w: number[] = [];
  private readonly unionSeen = new Set<number>();

  /** Choose glide, zoom path or dip for the move to the new shot (06 §6.2.6). */
  private planTransition(sameStory: boolean, deadline: number | null = null, focusPos: V2 | null = null): void {
    const tg = this.tgt;
    const u = new ZoomPath(this.x, this.y, this.swM(), tg.x, tg.y, this.swM(tg.zeta), this.p.rho).S;
    const sh = this.shot!;
    const focus = focusPos ?? (sh.story ? sh.story.pos : null);
    const lastDip = this.dips[this.dips.length - 1] ?? -Infinity;
    // A god event overrides the dip spacing once the previous dip has fully faded back in
    // (decision D7): it is the one thing the director must not miss.
    const canDip = this.wall - lastDip >= this.p.dipMinGapS || deadline !== null;
    let tr: Transition = 'glide';
    let plan: { path: ZoomPath; T: number } | null = null;
    if (this.rigMode === 'dip' && !this.dipJumped) {
      tr = 'dip'; // already dipping: the jump will land on the new target
    } else if (deadline !== null && focus && (this.urgentUntil = this.wall + deadline + 2) > 0 &&
        (this.rigMode === 'path' || !this.glideSees(focus[0], focus[1], tg.zeta, deadline - 0.2))) {
      // a god event would be missed by a glide: dip if allowed, else the zoom path (it rises
      // early, so the event is usually in view long before the path ends), else a fast glide
      if (canDip) tr = 'dip';
      else if (!this.p.glidesOnly && (plan = this.bestPath(this.p.pathMaxS * 1.5))) tr = 'zoomPath';
    } else if (sameStory || u < this.p.glideMaxU) {
      // a path in flight to another story is re-planned from here, carrying its velocity; one
      // that cannot be re-planned (or one for the same story) finishes first: it ends at rest
      if (!sameStory && this.rigMode === 'path' && (plan = this.bestPath(this.p.pathMaxS * 1.5))) tr = 'zoomPath';
    } else {
      plan = !this.p.glidesOnly && u <= this.p.zoomPathMaxU ? this.bestPath(this.p.pathMaxS) : null;
      if (plan && (deadline === null || plan.T <= deadline + 0.5)) tr = 'zoomPath';
      else if (canDip) tr = 'dip';
      else if (!this.p.glidesOnly && u <= this.p.zoomPathMaxU * 1.5 && (plan = this.bestPath(this.p.pathMaxS * 1.5))) tr = 'zoomPath';
      else tr = 'glide';
    }
    const pathT = plan ? plan.T : 0;
    const path = plan ? plan.path : null;
    this.lastTransition = tr;
    if (tr === 'zoomPath' && path) {
      this.rigMode = 'path';
      this.path = path;
      this.pathT0 = this.rigClock;
      this.pathT = pathT;
      this.pathOff = { vx: this.vx, vy: this.vy, vz: this.vz };
      sh.tSettle = this.wall + pathT;
    } else if (tr === 'dip') {
      if (this.rigMode !== 'dip' || this.dipJumped) {
        this.dipFrom = this.dimV; // a god dip may start while the last one is still fading in
        this.rigMode = 'dip';
        this.dipT0 = this.rigClock;
        this.dipJumped = false;
        this.dipDown = deadline !== null ? clamp(deadline - 0.3, 0.4, this.p.dipDownS) : this.p.dipDownS;
        this.dips.push(this.wall);
        this.dipForGod.push(deadline !== null);
      }
      sh.tSettle = this.dipT0 + this.dipDown + 0.5;
    } else {
      // a path in flight for the same story finishes (it ends at rest); then the springs take over
      const lead = Math.max(u / Math.max(0.05, this.p.panLimit), 0);
      sh.tSettle = this.wall + Math.min(8, lead * 0.5);
    }
  }

  /**
   * Duration of a zoom path: speed limits at the peak rates, and acceleration limits on the
   * ramps (0.3 T) and from the turn of the zoom rate mid-path (rho^2 sdot^2 / ln 2 octaves/s^2).
   */
  private pathTime(path: ZoomPath): number {
    const ls = this.p.pathLimitScale;
    const la = this.p.pathAccelScale;
    const pk = path.peakRates();
    const warp = trapezoidPeak(0.3);
    const S = path.S;
    // the carried velocity reverses through v0 (1 - t) e^-t, adding up to 0.14 v0 against the path
    const zl = Math.max(0.3 * this.p.zoomLimit * ls, this.p.zoomLimit * ls - 0.2 * Math.abs(this.vz));
    const pl = Math.max(0.3 * this.p.panLimit * ls, this.p.panLimit * ls - 0.2 * Math.sqrt(this.vx * this.vx + this.vy * this.vy));
    return Math.max(S / this.p.pathV, this.p.pathMinS,
      (S * warp * pk.zoom) / (Math.LN2 * zl * 0.95),
      (S * warp * pk.pan) / (pl * 0.95),
      Math.sqrt((S * warp * pk.zoom) / (0.3 * Math.LN2 * this.p.zoomAccelLimit * la * 0.55)),
      Math.sqrt((S * warp * pk.pan) / (0.3 * this.p.accelLimit * la * 0.55)),
      (S * warp * path.rho) / Math.sqrt(Math.LN2 * this.p.zoomAccelLimit * la * 0.8));
  }

  /** Whether a point is inside the current view, with an inset fraction on each side. */
  private inView(x: number, y: number, inset: number): boolean {
    const hw = (this.swM() / 2) * (1 - 2 * inset);
    const hh = (this.cfg.viewHpx / exp2(this.z) / 2) * (1 - 2 * inset);
    return Math.abs(x - this.x) <= hw && Math.abs(y - this.y) <= hh;
  }

  /** Whether a glide (a pessimistic model: slow zoom, fast pan) has (fx, fy) on screen at time T. */
  private glideSees(fx: number, fy: number, tz: number, T: number): boolean {
    let x = this.x; let y = this.y; let z = this.z;
    const tx = this.tgt.x; const ty = this.tgt.y;
    const aspect = this.cfg.viewHpx / this.cfg.viewWpx;
    const n = Math.max(1, Math.ceil(T / 0.1));
    for (let i = 0; i < n; i++) {
      const t = i * 0.1;
      const w = this.cfg.viewWpx / exp2(z);
      const k = t > 0.5 ? 0.7 : 0.2;
      const dz = tz - z;
      z += Math.sign(dz) * Math.min(Math.abs(dz), this.p.zoomLimit * k * 0.1);
      const dx = tx - x; const dy = ty - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const step = Math.min(d, this.p.panLimit * 1.2 * w * 0.1); // pans may run fast: pessimistic
      if (d > 0) { x += (dx * step) / d; y += (dy * step) / d; }
    }
    const w = this.cfg.viewWpx / exp2(z);
    return Math.abs(fx - x) <= 0.42 * w && Math.abs(fy - y) <= 0.42 * w * aspect;
  }

  /**
   * The flattest-needed van Wijk path to the target: rho 1.4 first, then smaller (a lower rho
   * rises less above the endpoints), keeping the first whose clamped, velocity-carrying course
   * stays within the path limits and takes at most maxT seconds.
   */
  private bestPath(maxT: number): { path: ZoomPath; T: number } | null {
    const tg = this.tgt;
    for (const rho of [this.p.rho, 0.7, 0.35]) {
      const path = new ZoomPath(this.x, this.y, this.swM(), tg.x, tg.y, this.swM(tg.zeta), rho);
      const T = this.pathTime(path);
      if (T <= maxT && this.pathFits(path, T)) return { path, T };
    }
    return null;
  }

  /**
   * Simulate following `path` over T seconds at 30 Hz the way rigStep does (carried velocity,
   * then the habitat clamp) and check speeds and accelerations against the path limits.
   */
  private pathFits(path: ZoomPath, T: number): boolean {
    const o = { x: 0, y: 0, w: 0 };
    const c = { x: 0, y: 0 };
    const p = this.p;
    const zmin = this.zMin();
    const vMax = p.panLimit * p.pathLimitScale * 0.97;
    const zMax = p.zoomLimit * p.pathLimitScale * 0.97;
    const aMax = p.accelLimit * p.pathAccelScale * 0.9;
    const azMax = p.zoomAccelLimit * p.pathAccelScale * 0.9;
    let px = this.x; let py = this.y; let pz = this.z;
    let pvx = this.vx; let pvy = this.vy; let pvz = this.vz;
    const dt = 1 / 30; // the clamp's kinks last one frame, so check at the frame rate
    const n = Math.ceil(T / dt) + 1;
    for (let i = 1; i <= n; i++) {
      const t = Math.min(T, i * dt);
      path.at(path.S * trapezoid(t, T, 0.3), o);
      const k = t * exp(-t / 1.5);
      let z = log2(this.cfg.viewWpx / o.w) + this.vz * k;
      if (z < zmin) z = zmin;
      this.clampCentre(o.x + this.vx * k * o.w, o.y + this.vy * k * o.w, z, c);
      const W = this.cfg.viewWpx / exp2(pz);
      const vx = (c.x - px) / W / dt; const vy = (c.y - py) / W / dt; const vz = (z - pz) / dt;
      if (Math.sqrt(vx * vx + vy * vy) > vMax || Math.abs(vz) > zMax) return false;
      const ax = (vx - pvx) / dt; const ay = (vy - pvy) / dt;
      if (Math.sqrt(ax * ax + ay * ay) > aMax * 1.5 || Math.abs((vz - pvz) / dt) > azMax * 1.5) return false;
      if (Math.abs(Math.sqrt(vx * vx + vy * vy) - Math.sqrt(pvx * pvx + pvy * pvy)) / dt > aMax || Math.abs(vz - pvz) / dt > azMax) return false;
      px = c.x; py = c.y; pz = z; pvx = vx; pvy = vy; pvz = vz;
    }
    return true;
  }

  // ---------------- rig (every frame) ----------------
  private driftDt = 0;
  /** The rig's own clock: the end of the substep being integrated (paths and dips use it). */
  private rigClock = 0;
  private rigStep(dt: number): void {
    const sh = this.shot;
    if (!sh) return;
    this.driftDt = dt;
    if (this.rigMode === 'path' && this.path) {
      const t = this.rigClock - this.pathT0;
      const pt = this.path.at(this.path.S * trapezoid(t, this.pathT, 0.3));
      // the velocity carried in decays as an impulse response v0 t e^(-t / 1.5): no jerk, and its
      // initial deceleration (2 v0 / 1.5) stays inside the path acceleration limits
      const k = exp(-t / 1.5);
      const sw = this.cfg.viewWpx / pt.w;
      const zeta = log2(sw);
      const ox = this.pathOff.vx * t * k * pt.w;
      const oy = this.pathOff.vy * t * k * pt.w;
      const oz = this.pathOff.vz * t * k;
      const nx = pt.x + ox; const ny = pt.y + oy; const nz = zeta + oz;
      const W = this.swM();
      const px = this.x; const py = this.y; const pz = this.z;
      this.x = nx; this.y = ny; this.z = nz;
      this.clampView();
      // velocities from the actual (clamped) motion, so a re-plan carries what the eye saw
      this.vx = (this.x - px) / W / dt; this.vy = (this.y - py) / W / dt; this.vz = (this.z - pz) / dt;
      if (t >= this.pathT) { this.rigMode = 'spring'; this.path = null; }
      this.shotTarget(sh, this.wall);
      this.dimV = 1;
      return;
    }
    this.shotTarget(sh, this.wall);
    if (this.rigMode === 'dip') {
      const t = this.rigClock - this.dipT0;
      if (!this.dipJumped) {
        const f = clamp(t / this.dipDown, 0, 1);
        this.dimV = this.dipFrom - (this.dipFrom - this.p.dipFloor) * f * f * (3 - 2 * f);
        if (t >= this.dipDown) {
          this.dipJumped = true;
          this.x = this.tgt.x; this.y = this.tgt.y; this.z = this.tgt.zeta;
          this.vx = 0; this.vy = 0; this.vz = 0;
          this.dipT0 = this.rigClock;
          this.clampView();
          return;
        }
      } else {
        const f = clamp(t / this.p.dipUpS, 0, 1);
        this.dimV = this.p.dipFloor + (1 - this.p.dipFloor) * f * f * (3 - 2 * f);
        if (f >= 1) { this.rigMode = 'spring'; this.dimV = 1; }
      }
      if (!this.dipJumped) {
        // Ease to a stop under the dark: decelerate within the limits.
        this.brake(dt);
        return;
      }
    } else this.dimV = 1;
    this.springStep(dt);
  }

  private brake(dt: number): void {
    const W = this.swM();
    const a = this.p.accelLimit * dt;
    const sp = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    const f = sp > a ? (sp - a) / sp : 0;
    const nvx = this.vx * f; const nvy = this.vy * f;
    this.x += 0.5 * (this.vx + nvx) * dt * W; this.y += 0.5 * (this.vy + nvy) * dt * W;
    this.vx = nvx; this.vy = nvy;
    const za = this.p.zoomAccelLimit * dt;
    const nvz = Math.abs(this.vz) > za ? this.vz - Math.sign(this.vz) * za : 0;
    this.z += 0.5 * (this.vz + nvz) * dt;
    this.vz = nvz;
    this.clampView();
  }

  private springStep(dt: number): void {
    const tg = this.tgt;
    const p = this.p;
    const omega = this.wall < this.urgentUntil ? Math.max(tg.omega, 2) : tg.omega;
    const drift = this.shot?.rec.kind === 'drift';
    const panLim = drift ? Math.min(p.panLimit, 0.04) : p.panLimit;
    const zoomLim = drift ? Math.min(p.zoomLimit, 0.12) : p.zoomLimit;
    const W = this.swM();
    // errors in screen widths and octaves, saturated so the spring's speed stays near the limit
    const ePan = (2 * panLim) / omega;
    const eZoom = (2 * zoomLim) / omega;
    let ex = (tg.x - this.x) / W;
    let ey = (tg.y - this.y) / W;
    const em = Math.sqrt(ex * ex + ey * ey);
    if (em > 0) { const k = saturate(em, ePan) / em; ex *= k; ey *= k; }
    const ez = saturate(tg.zeta - this.z, eZoom);
    const so = this.so;
    springCritical(0, this.vx, ex, omega, dt, so); let dx = so.x; let nvx = so.v;
    springCritical(0, this.vy, ey, omega, dt, so); let dy = so.x; let nvy = so.v;
    springCritical(0, this.vz, ez, omega, dt, so); let dz = so.x; let nvz = so.v;
    // soft speed cap and acceleration clamp (property 4)
    let limited = false;
    const sp = Math.sqrt(nvx * nvx + nvy * nvy);
    if (sp > 0) {
      const c = softCap(sp, panLim);
      if (c < sp) { nvx *= c / sp; nvy *= c / sp; limited = true; }
    }
    // soft walls: never approach the habitat edge faster than the camera can stop within its limit
    {
      const bx = this.wallBrake(this.x, nvx, W, dt, true, this.vz);
      const by = this.wallBrake(this.y, nvy, W, dt, false, this.vz);
      if (bx !== nvx || by !== nvy) { nvx = bx; nvy = by; limited = true; }
    }
    const ax = nvx - this.vx; const ay = nvy - this.vy;
    const am = Math.sqrt(ax * ax + ay * ay);
    // 10% inside the limit: the speed a viewer sees also changes with the zoom (W changes)
    const amax = 0.9 * p.accelLimit * dt;
    if (am > amax) { nvx = this.vx + (ax * amax) / am; nvy = this.vy + (ay * amax) / am; limited = true; }
    if (limited) { dx = 0.5 * (this.vx + nvx) * dt; dy = 0.5 * (this.vy + nvy) * dt; }
    let zl = false;
    const cz = softCap(nvz, zoomLim);
    if (cz !== nvz) { nvz = cz; zl = true; }
    // soft floor and ceiling for the zoom: brake towards zMin / zMax within the zoom accel limit
    {
      const room = nvz < 0 ? this.z - this.zMin() : this.zMax() - this.z;
      const vmax = Math.sqrt(2 * p.zoomAccelLimit * 0.5 * Math.max(0, room - Math.abs(nvz) * dt));
      if (Math.abs(nvz) > vmax) {
        const floor = Math.max(vmax, Math.abs(nvz) - p.zoomAccelLimit * dt);
        nvz = Math.sign(nvz) * floor; zl = true;
      }
    }
    // zooming out closes the habitat walls on the camera (0.5 ln 2 |vz| screen widths/s each):
    // the zoom yields so no wall closes faster than the pan can brake for it (D9)
    if (nvz < 0) {
      const m = p.marginFrac * this.cfg.tankH;
      const hw = this.cfg.viewWpx / exp2(this.z) / 2;
      const hh = this.cfg.viewHpx / exp2(this.z) / 2;
      const aspect = this.cfg.viewHpx / this.cfg.viewWpx;
      const walls: [number, number, number][] = [
        [(this.cfg.tankW + m - hw - this.x) / W, nvx, 1], [(this.x - (hw - m)) / W, -nvx, 1],
        [(this.cfg.tankH + m - hh - this.y) / W, nvy, aspect], [(this.y - (hh - m)) / W, -nvy, aspect],
      ];
      let vzMin = -Infinity;
      for (const [d, toward, k] of walls) {
        const wsMax = Math.max(0, Math.sqrt(2 * p.accelLimit * 0.35 * Math.max(0, d)) - Math.max(0, toward));
        vzMin = Math.max(vzMin, -wsMax / (0.5 * Math.LN2 * k));
      }
      if (nvz < vzMin) { nvz = vzMin; zl = true; }
    }
    const zmax = 0.9 * p.zoomAccelLimit * dt;
    if (Math.abs(nvz - this.vz) > zmax) { nvz = this.vz + Math.sign(nvz - this.vz) * zmax; zl = true; }
    if (zl) dz = 0.5 * (this.vz + nvz) * dt;
    this.x += dx * W; this.y += dy * W; this.z += dz;
    this.vx = nvx; this.vy = nvy; this.vz = nvz;
    this.clampView();
  }

  /**
   * Cap the velocity (screen widths/s) on one axis so the camera never meets a habitat wall
   * faster than it can stop: the braking curve v = sqrt(a d), counting the walls' own approach
   * while the camera zooms out (each wall closes at 0.5 ln 2 |vz| screen widths/s).
   */
  private wallBrake(c: number, v: number, W: number, dt: number, isX: boolean, vz: number): number {
    const m = this.p.marginFrac * this.cfg.tankH;
    const half = (isX ? this.cfg.viewWpx : this.cfg.viewHpx) / exp2(this.z) / 2;
    const extent = isX ? this.cfg.tankW : this.cfg.tankH;
    const ws = vz < 0 ? 0.5 * Math.LN2 * -vz * (isX ? 1 : this.cfg.viewHpx / this.cfg.viewWpx) : 0;
    const a = this.p.accelLimit;
    let out = v;
    for (const dir of [1, -1]) {
      const d = dir > 0 ? (extent + m - half - c) / W : (c - (half - m)) / W;
      const vmax = Math.sqrt(2 * a * 0.35 * Math.max(0, d - 2 * (Math.abs(v) + ws) * dt)) - ws;
      const toward = dir * out;
      if (toward > vmax) {
        const want = dir * vmax;
        const lim = a * dt;
        out = out + clamp(want - out, -lim, lim);
      }
    }
    return out;
  }

  // ---------------- exposure and captions ----------------
  private incAcc = 0;
  private accumulateExposure(dt: number): void {
    const now = this.wall;
    const W = this.swM();
    const H = this.cfg.viewHpx / exp2(this.z);
    const x0 = this.x - W / 2; const x1 = this.x + W / 2;
    const y0 = this.y - H / 2; const y1 = this.y + H / 2;
    const ex = this.exposure;
    ex.region.add(ex.regionKey(this.x, this.y), dt * this.dimV, now);
    const sh = this.shot;
    if (sh && sh.story) {
      ex.type.add(sh.story.type, dt, now);
      const pid = sh.story.subjects[0];
      if (pid !== undefined) ex.entity.add(pid, dt, now);
      for (const sp of sh.story.species) ex.species.add(sp, dt, now);
    }
    // incidental appearances: every story subject in view, weighted by prominence (at 4 Hz)
    this.incAcc += dt;
    if (this.incAcc < 0.25) return;
    dt = this.incAcc;
    this.incAcc = 0;
    const area = W * H;
    for (const s of this.book.stories.values()) {
      if (sh && s === sh.story) continue;
      if (s.pos[0] < x0 || s.pos[0] > x1 || s.pos[1] < y0 || s.pos[1] > y1) continue;
      const id = s.subjects[0];
      const size = id !== undefined ? this.book.sizes.get(id) ?? 0.05 : s.radius;
      const prom = Math.min(1, ((size * size) / area) * 4);
      if (prom < 1e-3) continue;
      if (id !== undefined) ex.entity.add(id, dt * prom, now);
      for (const sp of s.species) ex.species.add(sp, dt * prom, now);
    }
    for (const o of this.observed) {
      if (o.prominence <= 0) continue;
      ex.entity.add(o.id, dt * Math.min(1, o.prominence), now);
      ex.species.add(o.species, dt * Math.min(1, o.prominence), now);
    }
  }

  /** Subject's screen box in normalised coordinates (0..1, y down). */
  subjectBox(): [number, number, number, number] | null {
    const sh = this.shot;
    if (!sh || !sh.story) return null;
    const s = sh.story;
    const p = s.ended || sh.hasHold ? (sh.hasHold ? [sh.holdX, sh.holdY] as V2 : s.pos) : this.subjectPos(s.subjects[0], s.pos);
    const W = this.swM();
    const H = this.cfg.viewHpx / exp2(this.z);
    const r = Math.min(sh.r, s.radius);
    return [
      (p[0] - r - (this.x - W / 2)) / W, (p[1] - r - (this.y - H / 2)) / H,
      (p[0] + r - (this.x - W / 2)) / W, (p[1] + r - (this.y - H / 2)) / H,
    ];
  }

  private updateCaption(): void {
    const cp = this.p.captions;
    if (!cp) { this.cap = null; return; }
    const c = this.cap;
    if (c && this.wall <= c.tEnd) {
      // never over the subject: fade out early if the subject swims under the caption
      if (this.wall >= c.tShow) {
        const b = this.subjectBox();
        if (b && boxesOverlap(b, captionBox(c.side))) c.tEnd = Math.min(c.tEnd, this.wall);
      }
      return;
    }
    const sh = this.shot;
    if (!sh || !sh.story || this.rigMode !== 'spring') return;
    if (this.wall < sh.tSettle + cp.settleS) return;
    if (this.wall - this.lastCapShow < cp.minGapS) return;
    const text = captionFor(sh.story, this.names);
    if (!text) return;
    if (text.species !== null && text.species === this.lastCapSpecies) return;
    if (this.capFor === sh.rec.n) return;
    const b = this.subjectBox();
    if (!b) return;
    const centre = (b[0] + b[2]) / 2;
    const side: 'left' | 'right' = centre > 0.5 ? 'left' : 'right';
    if (boxesOverlap(b, captionBox(side))) return;
    this.capFor = sh.rec.n;
    const tShow = this.wall;
    this.cap = { text, tShow, tEnd: tShow + cp.fadeInS + cp.holdS + cp.fadeOutS, side, storyId: sh.story.id };
    this.captions.push({ ...this.cap });
    this.lastCapShow = tShow;
    this.lastCapSpecies = text.species;
  }
  private capFor = -1;
  /** Every caption shown (for tests and the replay viewer). */
  readonly captions: CaptionState[] = [];
}

function exp2(z: number): number { return exp(z * Math.LN2); }

/** Make a director for a view mode. The wallpaper's director is idle drift only (William's Q10). */
export function createDirector(cfg: DirectorConfig): Director {
  return new Director(cfg);
}
