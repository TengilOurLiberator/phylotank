/**
 * Synthetic event logs and a replay harness for the director (06 §6.8.2). The director is a pure
 * function of (log, census, seed, config), so tests replay hours of events in Node faster than
 * real time. The generators are seeded and deterministic; the recorded "real run" logs replace
 * them once the host detectors exist.
 */
import { RngStream, TICK_HZ, type Draw, type PowerId, type SimEvent, type V2 } from '../core/index.js';
import { Director, type Census, type DirectorConfig, type ShotRecord } from './director.js';

export interface EventLog {
  name: string;
  tankW: number;
  tankH: number;
  lCeilingM: number;
  durationS: number;
  /** Sorted by tick. */
  events: SimEvent[];
  census: { t: number; c: Census }[];
}

type EvIn = Omit<SimEvent, 'eid' | 'epoch'>;

class Gen {
  readonly events: SimEvent[] = [];
  private eid = 1;
  private nextId = 1000;
  private n = 0;
  readonly rng: RngStream;
  constructor(seed: number, readonly W: number, readonly H: number) { this.rng = new RngStream(seed >>> 0, 0x5eed, 0x7e57); }
  d(): Draw { return this.rng.draw(this.n++, 0); }
  id(): number { return this.nextId++; }
  push(e: EvIn): void { this.events.push({ ...e, eid: this.eid++, epoch: 0 } as SimEvent); }
  pos(margin = 2): V2 { const d = this.d(); return [margin + d.u01() * (this.W - 2 * margin), margin + d.u01() * (this.H - 2 * margin)]; }
  sort(): SimEvent[] { this.events.sort((a, b) => a.t - b.t || a.eid - b.eid); return this.events; }

  /** A hunt from tS lasting durS with updates at 4 Hz, ending in a kill or an escape. */
  hunt(tS: number, durS: number, kill: boolean, predSize = 0.03, pred = this.id()): number {
    const prey = this.id();
    const d = this.d();
    let [x, y] = this.pos(3);
    const h = d.u01() * 6.283;
    const vx = 0.4 * (d.u01() < 0.5 ? -1 : 1);
    const vy = 0.1 * (d.u01() - 0.5) + 0 * h;
    this.push({ k: 'birth', t: Math.max(0, Math.round((tS - 1) * TICK_HZ)), id: pred, parents: [], species: 7, pos: [x, y], size: predSize, mode: 'bud' } as EvIn);
    const steps = Math.max(1, Math.floor(durS * 4));
    for (let i = 0; i <= steps; i++) {
      const t = Math.round((tS + i / 4) * TICK_HZ);
      x = Math.min(this.W - 0.5, Math.max(0.5, x + vx / 4));
      y = Math.min(this.H - 0.5, Math.max(0.5, y + vy / 4));
      const phase = i === 0 ? 'start' : i === steps ? 'end' : 'update';
      this.push({ k: 'hunt', t, phase, pred, prey, pos: [x, y], ...(i === steps ? { outcome: kill ? 'kill' : 'escape' } : {}) } as EvIn);
    }
    if (kill) {
      const t = Math.round((tS + durS) * TICK_HZ) + 1;
      this.push({ k: 'death', t, id: prey, species: 3, pos: [x, y], size: 0.01, cause: 'predation', killer: pred } as EvIn);
    }
    return pred;
  }

  school(tS: number, durS: number, species: number, n: number): void {
    let [x, y] = this.pos(4);
    const sample = [this.id(), this.id(), this.id()];
    for (let i = 0; i <= durS; i++) {
      x = Math.min(this.W - 2, Math.max(2, x + 0.1));
      const phase = i === 0 ? 'start' : i >= durS ? 'end' : 'update';
      this.push({ k: 'school', t: Math.round((tS + i) * TICK_HZ), phase, species, n, centroid: [x, y], radius: 1.5, polarisation: 0.8, sample } as EvIn);
    }
  }

  god(tS: number, power: PowerId, pos: V2, leadS = 3, major = true): void {
    const t = Math.round(tS * TICK_HZ);
    this.push({ k: 'god', t, cmdId: `c${t}`, power, author: 'god', tFire: t + Math.round(leadS * TICK_HZ), pos, radius: 3, strength: 0.8, major } as EvIn);
  }

  noise(tS: number, ratePerS: number, durS: number): void {
    const n = Math.floor(ratePerS * durS);
    for (let i = 0; i < n; i++) {
      const d = this.d();
      const t = Math.round((tS + d.u01() * durS) * TICK_HZ);
      const sp = 1 + (d.int(5));
      if (d.u01() < 0.5) this.push({ k: 'birth', t, id: this.id(), parents: [this.id()], species: sp, pos: this.pos(1), size: 0.002, mode: 'bud' } as EvIn);
      else this.push({ k: 'death', t, id: this.id(), species: sp, pos: this.pos(1), size: 0.002, cause: 'starvation' } as EvIn);
    }
  }
}

function heat(W: number, H: number, seed: number): Census {
  const w = 64; const h = 36;
  const data = new Uint8Array(w * h * 4);
  const r = new RngStream(seed, 1, 0x4ea7);
  for (let i = 0; i < w * h; i++) {
    const d = r.draw(i, 0);
    const iy = Math.floor(i / w);
    const depth = iy / h;
    data[i * 4] = Math.floor(255 * d.u01() * (1 - depth * 0.7));
    data[i * 4 + 1] = Math.floor(255 * d.u01() * depth);
  }
  void W; void H;
  return { species: [{ id: 1, count: 200, biomassKg: 2 }], heat: data, heatW: w, heatH: h, heatCh: 4 };
}

/** "Quiet reef": sparse events, mostly noise; a school or a hunt now and then. */
export function quietReef(seed: number, durationS = 7200): EventLog {
  const g = new Gen(seed, 32, 18);
  g.noise(0, 0.5, durationS);
  for (let t = 60; t < durationS - 200; t += 600 + g.d().u01() * 300) g.school(t, 60, 2 + g.d().int(4), 40);
  for (let t = 300; t < durationS - 60; t += 900 + g.d().u01() * 400) g.hunt(t, 15, g.d().u01() < 0.5);
  return { name: 'quiet reef', tankW: 32, tankH: 18, lCeilingM: 0.126, durationS, events: g.sort(), census: [{ t: 0, c: heat(32, 18, seed) }] };
}

/** "Predator boom": hunts every few seconds, kills, schools, a giant and a carcass. */
export function predatorBoom(seed: number, durationS = 3600): EventLog {
  const g = new Gen(seed, 32, 18);
  g.noise(0, 2, durationS);
  for (let t = 5; t < durationS - 40; t += 3 + g.d().u01() * 6) g.hunt(t, 8 + g.d().u01() * 20, g.d().u01() < 0.6, g.d().u01() < 0.1 ? 0.09 : 0.03);
  for (let t = 30; t < durationS - 150; t += 240 + g.d().u01() * 120) g.school(t, 100, 2 + g.d().int(4), 60);
  for (let t = 200; t < durationS - 100; t += 600) {
    const id = g.id();
    const p = g.pos(3);
    g.push({ k: 'birth', t: Math.round(t * TICK_HZ) - 30, id, parents: [], species: 11, pos: p, size: 0.1, mode: 'bud' } as EvIn);
    for (let k = 0; k < 4; k++) g.push({ k: 'giant', t: Math.round((t + 60 * k) * TICK_HZ), id, species: 11, size: 0.1, percentile: 99.9 } as EvIn);
  }
  for (let t = 900; t < durationS - 100; t += 900) {
    const id = g.id();
    g.push({ k: 'carcass', t: Math.round(t * TICK_HZ), id, size: 0.1, pos: g.pos(3), scavengers: 4 } as EvIn);
  }
  return { name: 'predator boom', tankW: 32, tankH: 18, lCeilingM: 0.126, durationS, events: g.sort(), census: [{ t: 0, c: heat(32, 18, seed) }] };
}

/** "God session": 30 min of disasters, including pairs at opposite ends and minor powers. */
export function godSession(seed: number, durationS = 1800): EventLog {
  const g = new Gen(seed, 32, 18);
  g.noise(0, 1, durationS);
  for (let t = 10; t < durationS - 60; t += 20 + g.d().u01() * 15) g.hunt(t, 10, g.d().u01() < 0.5);
  const powers: PowerId[] = ['meteor', 'plague', 'coldSnap', 'cull', 'bloom', 'vent', 'heatwave'];
  let i = 0;
  for (let t = 40; t < durationS - 30; t += 45 + g.d().u01() * 60) {
    const p = powers[i++ % powers.length]!;
    const major = p !== 'bloom' && p !== 'vent';
    g.god(t, p, g.pos(2), major ? 3 : 1, major);
    if (i % 5 === 0) g.god(t + 0.5, 'meteor', [g.W - 3, g.H - 3], 3, true); // a second one far away
    g.push({ k: 'massDeath', t: Math.round((t + (major ? 6 : 4)) * TICK_HZ), centroid: [10, 9], radius: 3, deaths: 30, z: 6 } as EvIn);
  }
  return { name: 'god session', tankW: 32, tankH: 18, lCeilingM: 0.126, durationS, events: g.sort(), census: [{ t: 0, c: heat(32, 18, seed) }] };
}

/** A mixed 2 h log with every story type, for the variety and caption properties. */
export function mixedLog(seed: number, durationS = 7200): EventLog {
  const g = new Gen(seed, 32, 18);
  g.noise(0, 1, durationS);
  const tk = (t: number): number => Math.round(t * TICK_HZ);
  for (let t = 5; t < durationS - 40; t += 6 + g.d().u01() * 12) g.hunt(t, 8 + g.d().u01() * 15, g.d().u01() < 0.5, g.d().u01() < 0.08 ? 0.09 : 0.03);
  for (let t = 60; t < durationS - 150; t += 300 + g.d().u01() * 200) g.school(t, 90, 2 + g.d().int(6), 50);
  let sp = 100;
  for (let t = 120; t < durationS - 200; t += 200 + g.d().u01() * 200) {
    const kind = g.d().int(8);
    const p = g.pos(2);
    const id = g.id();
    g.push({ k: 'birth', t: tk(t) - 60, id, parents: [], species: sp, pos: p, size: 0.05, mode: 'bud' } as EvIn);
    switch (kind) {
      case 0: g.push({ k: 'speciation', t: tk(t), parent: sp, child: sp + 1, founders: [id, g.id(), g.id()], pos: p } as EvIn); sp += 2; break;
      case 1: g.push({ k: 'record', t: tk(t), kind: 'size', id, value: 0.11, prev: 0.1 } as EvIn); break;
      case 2: g.push({ k: 'novelty', t: tk(t), id, species: sp, morphCluster: 3, distance: 2 } as EvIn); break;
      case 3: g.push({ k: 'outbreak', t: tk(t), phase: 'start', strain: 1, host: sp, prevalence: 0.2, growth: 0.05, centroid: p, radius: 2 } as EvIn); break;
      case 4: {
        g.push({ k: 'endangered', t: tk(t), species: sp, remaining: 1, ids: [id] } as EvIn);
        g.push({ k: 'death', t: tk(t + 40), id, species: sp, pos: p, size: 0.05, cause: 'age' } as EvIn);
        g.push({ k: 'extinction', t: tk(t + 40) + 1, species: sp, lastId: id, pos: p } as EvIn);
        sp++;
        break;
      }
      case 5: g.push({ k: 'carcass', t: tk(t), id, size: 0.1, pos: p, scavengers: 5 } as EvIn); break;
      case 6: g.push({ k: 'giant', t: tk(t), id, species: sp, size: 0.1, percentile: 99.9 } as EvIn); break;
      default: g.push({ k: 'massDeath', t: tk(t), centroid: p, radius: 3, deaths: 40, z: 7 } as EvIn); break;
    }
  }
  const powers: PowerId[] = ['meteor', 'bloom', 'coldSnap', 'plague', 'vent'];
  let i = 0;
  for (let t = 400; t < durationS - 60; t += 500 + g.d().u01() * 300) {
    const p = powers[i++ % powers.length]!;
    const major = p === 'meteor' || p === 'plague' || p === 'coldSnap';
    g.god(t, p, g.pos(2), major ? 3 : 1, major);
  }
  return { name: 'mixed', tankW: 32, tankH: 18, lCeilingM: 0.126, durationS, events: g.sort(), census: [{ t: 0, c: heat(32, 18, seed) }] };
}

/** Edge cases (property 8): subject dies mid-shot, leaves the habitat edge, two disasters, a gap. */
export function edgeCases(seed: number): EventLog {
  const g = new Gen(seed, 32, 18);
  // a long hunt whose predator is killed mid-shot by a giant
  const pred = g.hunt(10, 30, false);
  g.push({ k: 'death', t: Math.round(22 * TICK_HZ), id: pred, species: 7, pos: [16, 9], size: 0.03, cause: 'predation', killer: g.id() } as EvIn);
  // a hunt that runs along the edge of the habitat
  {
    const p = g.id(); const q = g.id();
    for (let i = 0; i <= 80; i++) {
      g.push({ k: 'hunt', t: Math.round((60 + i / 4) * TICK_HZ), phase: i === 0 ? 'start' : i === 80 ? 'end' : 'update', pred: p, prey: q, pos: [31.9 + i * 0.01, 0.05], ...(i === 80 ? { outcome: 'escape' } : {}) } as EvIn);
    }
  }
  // two disasters at once at opposite ends
  g.god(120, 'meteor', [2, 2], 3, true);
  g.god(120, 'plague', [30, 16], 3, true);
  // a 30 s stream gap from 200 to 230 s (nothing at all), then a hunt
  g.hunt(232, 10, true);
  return { name: 'edge cases', tankW: 32, tankH: 18, lCeilingM: 0.126, durationS: 300, events: g.sort(), census: [] };
}

/** An event storm: `perS` events per second for `durS` seconds (StoryBook bound test). */
export function storm(seed: number, perS: number, durS: number): EventLog {
  const g = new Gen(seed, 32, 18);
  for (let s = 0; s < durS; s++) {
    for (let k = 0; k < perS; k++) {
      const t = Math.round((s + k / perS) * TICK_HZ);
      const pred = g.id();
      g.push({ k: 'hunt', t, phase: 'start', pred, prey: pred + 1, pos: g.pos(1) } as EvIn);
    }
  }
  return { name: 'storm', tankW: 32, tankH: 18, lCeilingM: 0.126, durationS: durS, events: g.sort(), census: [] };
}

export interface ReplayResult {
  director: Director;
  shots: ShotRecord[];
  /** Per recorded frame: t, x, y, zeta, dim, mode (0 spring, 1 path, 2 dip). */
  frames: Float64Array;
  nFrames: number;
  /** Wall seconds of each frame where a caption was visible, with its box overlap flag. */
  captionOverlap: number;
}

/** Replay a log through a director at a fixed frame rate (speed 1: one wall second = 30 ticks). */
export function replay(log: EventLog, cfg: Partial<DirectorConfig> & { seedLo?: number }, fps = 30, record = true): ReplayResult {
  const d = new Director({ mode: 'screensaver', tankW: log.tankW, tankH: log.tankH, viewWpx: 1920, viewHpx: 1080, lCeilingM: log.lCeilingM, ...cfg });
  const dt = 1 / fps;
  const n = Math.ceil(log.durationS * fps);
  const frames = new Float64Array(record ? n * 6 : 0);
  let ei = 0;
  let ci = 0;
  const batch: SimEvent[] = [];
  let overlap = 0;
  for (let i = 0; i < n; i++) {
    const tNext = (i + 1) * dt;
    const tickLimit = tNext * TICK_HZ;
    batch.length = 0;
    while (ei < log.events.length && log.events[ei]!.t <= tickLimit) batch.push(log.events[ei++]!);
    while (ci < log.census.length && log.census[ci]!.t <= tNext) d.setCensus(log.census[ci++]!.c);
    const f = d.step(batch, dt);
    if (record) {
      const o = i * 6;
      frames[o] = d.wallTime; frames[o + 1] = f.camera.cx; frames[o + 2] = f.camera.cy; frames[o + 3] = f.camera.zeta;
      frames[o + 4] = f.dim; frames[o + 5] = f.mode === 'spring' ? 0 : f.mode === 'path' ? 1 : 2;
    }
    if (f.caption) {
      const b = d.subjectBox();
      const cb = f.caption.side === 'left' ? [0.05, 0.75, 0.5, 0.95] : [0.5, 0.75, 0.95, 0.95];
      if (b && b[0] < cb[2]! && cb[0]! < b[2] && b[1] < cb[3]! && cb[1]! < b[3]) overlap++;
    }
  }
  return { director: d, shots: d.shots, frames, nFrames: record ? n : 0, captionOverlap: overlap };
}
