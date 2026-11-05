/**
 * Carcasses ("whale falls") and feeding frenzies (06 §6.2.2, CONTRACT 11 `carcass`, `frenzy`).
 *
 * A carcass is worth a story when it is big: at least `carcassRel` of the size ceiling, at least
 * `carcassKg`, or a leviathan. It is reported once when first seen (`start`), again when the
 * crowd around it has changed (`update`, at most every `updateS`), and when it is gone (`end`,
 * with how long it lasted). `fall` is set once it lies on the floor: a whale fall.
 *
 * A frenzy is a crowd at a carcass: at least `frenzyMin` live creatures within
 * max(0.2 m, 5 body lengths) of it and at least `frenzyOverBackground` times the count the local
 * density would put there by chance. Only carcasses at least `frenzyRel` of the ceiling and four
 * times the median adult are considered, at most `maxCarcasses` per run (biggest first), so a
 * plague's thousand small corpses cost a sort, not a thousand neighbour queries. A frenzy ends
 * after two runs below half the minimum crowd, and the same carcass cannot start another within
 * `frenzyCooldownS`, so a crowd milling at the threshold does not flap.
 */
import { DIET } from '../../core/index.js';
import { CF, entityIdOf, TICK_HZ, type V2, type World } from './util.js';
import { forNear } from './scan.js';
import type { Derived, Detector, Scan } from './types.js';

export interface CarcassOptions {
  carcassRel?: number;
  carcassKg?: number;
  frenzyRel?: number;
  frenzyMin?: number;
  frenzyOverBackground?: number;
  updateS?: number;
  maxCarcasses?: number;
  frenzyCooldownS?: number;
  frenzyFeeders?: number;
}

interface Tracked { id: number; first: number; lastEmit: number; scav: number; massKg: number; pos: V2; size: number; fall: boolean; big: boolean }
interface Frenzy { first: number; lastEmit: number; n: number; low: number; ended: number }

export class CarcassDetector implements Detector {
  readonly name = 'carcass';
  private readonly o: Required<CarcassOptions>;
  private readonly tracked = new Map<number, Tracked>();
  private readonly frenzies = new Map<number, Frenzy>();

  constructor(opts: CarcassOptions = {}) {
    this.o = { carcassRel: 0.25, carcassKg: 10, frenzyRel: 0.05, frenzyMin: 5, frenzyOverBackground: 3, updateS: 30, maxCarcasses: 256, frenzyCooldownS: 60, frenzyFeeders: 3, ...opts };
  }

  run(scan: Scan, out: Derived[]): void {
    const w = scan.world; const c = w.cr.c; const t = scan.tick;
    const lc = w.lCeilingM;
    const bigL = this.o.carcassRel * lc;
    const eligibleL = Math.max(this.o.frenzyRel * lc, 4 * scan.medianAdultM);
    // candidates: big ones and frenzy-eligible ones, biggest first, bounded
    const cand: number[] = [];
    for (let i = 0; i < scan.nCarcass; i++) {
      const s = scan.carcass[i]!;
      const L = c.length[s]!;
      if (L >= eligibleL || L >= bigL || c.massKg[s]! >= this.o.carcassKg || (c.flags[s]! & CF.LEVIATHAN) !== 0) cand.push(s);
    }
    cand.sort((a, b) => c.length[b]! - c.length[a]! || a - b);
    if (cand.length > this.o.maxCarcasses) cand.length = this.o.maxCarcasses;
    const seen = new Set<number>();
    const H = w.preset.heightM;
    // does the ecology record diets at all? (early exit on the first creature that has eaten)
    let dietKnown = false;
    for (let i = 0; i < scan.nAlive && !dietKnown && cand.length > 0; i++) {
      const o = 7 * scan.alive[i]!;
      for (let k = 0; k < 7; k++) if (c.diet[o + k]! > 0) { dietKnown = true; break; }
    }
    const meatEater = (o: number): boolean => {
      const b = 7 * o; let sum = 0;
      for (let k = 0; k < 7; k++) sum += Math.max(0, c.diet[b + k]!);
      return sum > 0 && (Math.max(0, c.diet[b + DIET.CARCASS]!) + Math.max(0, c.diet[b + DIET.LIVE_PREY]!)) >= 0.25 * sum;
    };
    for (const s of cand) {
      const id = entityIdOf(w, s);
      seen.add(id);
      const L = c.length[s]!;
      const x = c.posX[s]!; const y = c.posY[s]!;
      const r = Math.max(0.2, 5 * L);
      let feeding = 0;
      const n = forNear(scan, x, y, r, (o) => { if (meatEater(o)) feeding++; });
      const pos: V2 = [x, y];
      const big = L >= bigL || c.massKg[s]! >= this.o.carcassKg || (c.flags[s]! & CF.LEVIATHAN) !== 0;
      const fall = y >= H - Math.max(0.3, 2 * L) && Math.abs(c.velY[s]!) < 0.005;
      if (big) {
        const k = this.tracked.get(id);
        if (!k) {
          this.tracked.set(id, { id, first: t, lastEmit: t, scav: n, massKg: c.massKg[s]!, pos, size: L, fall, big });
          out.push({ k: 'carcass', phase: 'start', id, size: L, pos, scavengers: n, massKg: c.massKg[s]!, fall, feeding, novelty: L >= lc ? 1 : Math.min(1, L / lc), durationS: 0 });
        } else {
          const changed = Math.abs(n - k.scav) >= 3 || fall !== k.fall || c.massKg[s]! < 0.75 * k.massKg;
          if (changed && t - k.lastEmit >= this.o.updateS * TICK_HZ) {
            k.lastEmit = t; k.scav = n; k.massKg = c.massKg[s]!; k.fall = fall;
            out.push({ k: 'carcass', phase: 'update', id, size: L, pos, scavengers: n, massKg: c.massKg[s]!, fall, feeding, durationS: (t - k.first) / TICK_HZ });
          }
          k.pos = pos; k.size = L;
        }
      }
      // frenzy
      const R = Math.max(1, 4 * r);
      const ring = forNear(scan, x, y, R) - n;
      const expected = (ring / (Math.PI * (R * R - r * r))) * Math.PI * r * r;
      const crowd = n >= this.o.frenzyMin && n >= this.o.frenzyOverBackground * expected && (!dietKnown || feeding >= this.o.frenzyFeeders);
      const f = this.frenzies.get(id);
      if (crowd && (!f || f.ended >= 0)) {
        if (f && t - f.ended < this.o.frenzyCooldownS * TICK_HZ) continue;
        this.frenzies.set(id, { first: t, lastEmit: t, n, low: 0, ended: -1 });
        out.push({ k: 'frenzy', phase: 'start', carcass: id, n, pos, feeding, size: L, durationS: 0, novelty: Math.min(1, n / (4 * this.o.frenzyMin)) });
      } else if (f && f.ended < 0 && crowd) {
        f.low = 0;
        if (t - f.lastEmit >= 10 * TICK_HZ && n !== f.n) {
          f.lastEmit = t; f.n = n;
          out.push({ k: 'frenzy', phase: 'update', carcass: id, n, pos, feeding, size: L, durationS: (t - f.first) / TICK_HZ });
        }
      } else if (f && f.ended < 0 && n < Math.max(2, this.o.frenzyMin >> 1) && ++f.low >= 2) {
        f.ended = t;
        out.push({ k: 'frenzy', phase: 'end', carcass: id, n, pos, feeding, size: L, durationS: (t - f.first) / TICK_HZ });
      } else if (f && f.ended < 0 && n >= Math.max(2, this.o.frenzyMin >> 1)) f.low = 0;
    }
    for (const [id, k] of [...this.tracked]) {
      if (seen.has(id)) continue;
      this.tracked.delete(id);
      out.push({ k: 'carcass', phase: 'end', id, size: k.size, pos: k.pos, scavengers: 0, massKg: 0, fall: k.fall, durationS: (t - k.first) / TICK_HZ });
    }
    for (const [id, f] of [...this.frenzies]) {
      if (seen.has(id)) continue;
      this.frenzies.delete(id);
      if (f.ended < 0) out.push({ k: 'frenzy', phase: 'end', carcass: id, n: 0, pos: [0, 0], durationS: (t - f.first) / TICK_HZ });
    }
  }
}

export type { World };
