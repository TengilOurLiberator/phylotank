/**
 * New roles: a lineage switching diet role (CONTRACT 11 `newRole`).
 *
 * A creature's role comes from its intake EMA (`diet`, CONTRACT 5.1): grazer (phytoplankton,
 * mats and plant creatures), detritivore, scavenger (carcasses), predator (live prey) or
 * parasite (hosts); the largest share if it is at least `dominance`, else omnivore. A species'
 * role is the same rule on the mean of its feeding members' shares, and is established once it
 * has held for `holdRuns` runs in a row (hysteresis), with at least `minFeeding` feeders.
 *
 * Reported: an established species switching role, and a new species whose first established
 * role differs from its parent species' (the lineage switched when it split). `novelty` is 1
 * when no species seen before ever held that role, 0.5 otherwise. Founders' roles are silent.
 * At most `maxSpecies` species are followed.
 */
import { DIET } from '../../core/index.js';
import { TICK_HZ, type V2 } from './util.js';
import { hasState, stateOf } from '../state.js';
import type { Derived, Detector, Scan } from './types.js';

export type Role = 'grazer' | 'detritivore' | 'scavenger' | 'predator' | 'parasite' | 'omnivore';
const ROLES: readonly Role[] = ['grazer', 'detritivore', 'scavenger', 'predator', 'parasite'];

export interface RoleOptions {
  dominance?: number;
  holdRuns?: number;
  minFeeding?: number;
  maxSpecies?: number;
  /** Parent species lookup; defaults to the sim's species registry. */
  parentOf?: (species: number) => number | undefined;
}

/** Role shares from one diet vector (7 lanes at `off`). Returns null if it has not eaten. */
export function roleShares(diet: Float32Array, off: number, out = new Float64Array(5)): Float64Array | null {
  const g = Math.max(0, diet[off + DIET.PHYTO]!) + Math.max(0, diet[off + DIET.MAT]!) + Math.max(0, diet[off + DIET.PLANT_CREATURE]!);
  const d = Math.max(0, diet[off + DIET.DETRITUS]!); const k = Math.max(0, diet[off + DIET.CARCASS]!);
  const p = Math.max(0, diet[off + DIET.LIVE_PREY]!); const h = Math.max(0, diet[off + DIET.HOST]!);
  const sum = g + d + k + p + h;
  if (!(sum > 1e-12)) return null;
  out[0] = g / sum; out[1] = d / sum; out[2] = k / sum; out[3] = p / sum; out[4] = h / sum;
  return out;
}

export function roleOf(shares: Float64Array, dominance: number): Role {
  let best = 0;
  for (let i = 1; i < 5; i++) if (shares[i]! > shares[best]!) best = i;
  return shares[best]! >= dominance ? ROLES[best]! : 'omnivore';
}

interface SpRole { established: Role | null; cand: Role | null; runs: number; since: number }

export class RoleDetector implements Detector {
  readonly name = 'newRole';
  private readonly o: Required<Omit<RoleOptions, 'parentOf'>>;
  private readonly parentOf: (species: number) => number | undefined;
  private readonly sp = new Map<number, SpRole>();
  private readonly held = new Set<Role>();
  private readonly roleMemory = new Map<number, Role>();

  constructor(opts: RoleOptions = {}) {
    const { parentOf, ...rest } = opts;
    this.o = { dominance: 0.5, holdRuns: 3, minFeeding: 5, maxSpecies: 1024, ...rest };
    this.parentOf = parentOf ?? (() => undefined);
    this.registry = parentOf === undefined;
  }
  private readonly registry: boolean;

  private parent(scan: Scan, species: number): number | undefined {
    if (this.registry) {
      if (!hasState(scan.world)) return undefined;
      const r = stateOf(scan.world).species.get(species);
      return r && r.parent > 0 ? r.parent : undefined;
    }
    return this.parentOf(species);
  }

  /** The established role of a species (tests, stats). */
  roleOfSpecies(species: number): Role | null { return this.sp.get(species)?.established ?? this.roleMemory.get(species) ?? null; }

  run(scan: Scan, out: Derived[]): void {
    const w = scan.world; const c = w.cr.c; const t = scan.tick;
    const acc = new Map<number, { s: Float64Array; n: number; tr: number; x: number; y: number }>();
    const tmp = new Float64Array(5);
    for (let i = 0; i < scan.nAlive; i++) {
      const s = scan.alive[i]!;
      const sh = roleShares(c.diet, 7 * s, tmp);
      if (!sh) continue;
      const sp = c.species[s]!;
      let a = acc.get(sp);
      if (!a) { a = { s: new Float64Array(5), n: 0, tr: 0, x: 0, y: 0 }; acc.set(sp, a); }
      for (let k = 0; k < 5; k++) a.s[k]! += sh[k]!;
      a.n++; a.tr += c.trophic[s]!; a.x += c.posX[s]!; a.y += c.posY[s]!;
    }
    for (const [sp, a] of acc) {
      if (a.n < this.o.minFeeding) continue;
      for (let k = 0; k < 5; k++) a.s[k] = a.s[k]! / a.n;
      const role = roleOf(a.s, this.o.dominance);
      let r = this.sp.get(sp);
      if (!r) {
        if (this.sp.size >= this.o.maxSpecies) this.sp.delete(this.sp.keys().next().value as number);
        r = { established: null, cand: null, runs: 0, since: t }; this.sp.set(sp, r);
      }
      if (role === r.cand) r.runs++; else { r.cand = role; r.runs = 1; }
      if (r.runs < this.o.holdRuns || role === r.established) continue;
      const before = r.established;
      const parent = before === null ? this.parent(scan, sp) : undefined;
      const parentRole = parent !== undefined ? this.roleOfSpecies(parent) : null;
      const novel = !this.held.has(role);
      this.held.add(role);
      const pos: V2 = [a.x / a.n, a.y / a.n];
      if (before !== null) {
        out.push({ k: 'newRole', species: sp, role, prevRole: before, trophic: a.tr / a.n, lineage: false, n: a.n, pos, size: scan.species.get(sp)?.maxLen ?? 0, novelty: novel ? 1 : 0.5, durationS: (t - r.since) / TICK_HZ });
      } else if (parentRole !== null && parentRole !== role) {
        out.push({ k: 'newRole', species: sp, role, prevRole: parentRole, trophic: a.tr / a.n, lineage: true, n: a.n, pos, size: scan.species.get(sp)?.maxLen ?? 0, novelty: novel ? 1 : 0.5, durationS: 0 });
      }
      r.established = role; r.since = t;
      this.roleMemory.set(sp, role);
      if (this.roleMemory.size > 4 * this.o.maxSpecies) this.roleMemory.delete(this.roleMemory.keys().next().value as number);
    }
    for (const sp of [...this.sp.keys()]) if (!scan.species.has(sp)) this.sp.delete(sp);
  }
}
