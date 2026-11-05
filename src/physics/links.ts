/**
 * Cross-creature links: grabs (claw tips) and jaw locks (after a bite), 02 §2.4.4, solved inside
 * the substep loop of the linked creatures (REVIEW R6). Linked creatures form islands (union by
 * link); an island steps all its members substep by substep at a common substep count, and
 * solves its links between the joint solve and the velocity update, through the same
 * drag-augmented inverse masses as the joints. A link is a zero-length point constraint between
 * anchors fixed in each segment's frame; it breaks when the owner's drive drops below 0.2, when
 * its constraint force exceeds the break force, or when either segment is severed or freed.
 *
 * Parasite latches (02 §2.4.5): a PROBOSCIS mouth with its drive on pierces a touched host
 * segment when `SIGMA_PIERCE pi r^2 > H_host A_tip`; the latch holds up to 4x a grip. The
 * energy drain itself belongs to the ecosystem's ledger: it reads `latches(world)`.
 */
import { KIND, LIFE, MOUTH_SUBTYPE, ORGAN, PI, type World } from '../core/index.js';
import { SC, sincos } from './sincos.js';
import type { Work } from './work.js';

export const LINK = { GRAB: 1, JAW: 2, LATCH: 3 } as const;
export const SIGMA_GRIP = 5e4;
export const GRIP_ON = 0.5;
export const GRIP_OFF = 0.2;

export interface Link {
  type: number;
  /** Owner segment (claw or mouth) and the held segment. */
  a: number; b: number;
  /** Anchors in each segment's local frame (m). */
  ax: number; ay: number; bx: number; by: number;
  breakF: number;
  /** Peak constraint force over the last tick (N). */
  force: number;
  /** Latches: time the host segment has been scraping (s). */
  scrape?: number;
}

interface LinkState { links: Link[] }
const states = new WeakMap<World, LinkState>();
export function linkState(world: World): LinkState {
  let s = states.get(world);
  if (!s) { s = { links: [] }; states.set(world, s); }
  return s;
}

export function hasLink(world: World, a: number, b: number): boolean {
  for (const l of linkState(world).links) if ((l.a === a && l.b === b) || (l.a === b && l.b === a)) return true;
  return false;
}

/** Whether segment a already holds something (one grip or jaw lock per owner segment). */
export function ownsLink(world: World, a: number): boolean {
  for (const l of linkState(world).links) if (l.a === a) return true;
  return false;
}

/** Create a link at world point (px, py) between owner segment a and held segment b. */
export function addLink(world: World, type: number, a: number, b: number, px: number, py: number, breakF: number): void {
  const sg = world.seg.c;
  const local = (i: number): [number, number] => {
    sincos(sg.angle[i]!);
    const dx = px - sg.posX[i]!; const dy = py - sg.posY[i]!;
    return [dx * SC.c + dy * SC.s, -dx * SC.s + dy * SC.c];
  };
  const [ax, ay] = local(a); const [bx, by] = local(b);
  linkState(world).links.push({ type, a, b, ax, ay, bx, by, breakF, force: 0 });
}

/** Break force of a claw grip (02 §2.4.4). */
export function gripBreakForce(rTip: number): number { return SIGMA_GRIP * PI * rTip * rTip; }

/** Drive of the link owner: grip on claws, bite on mouths (cmd2 adapter, contract request P2). */
function drive(world: World, l: Link): number { return world.seg.c.cmd2[l.a]!; }

/** Remove broken links (end of tick). Returns the number removed. */
export function pruneLinks(world: World): number {
  const st = linkState(world);
  const sg = world.seg.c; const c = world.cr.c;
  const keep: Link[] = [];
  for (const l of st.links) {
    const oa = sg.owner[l.a]!; const ob = sg.owner[l.b]!;
    const alive = (o: number): boolean => c.life[o] === LIFE.ALIVE || c.life[o] === LIFE.CARCASS;
    const ok = alive(oa) && alive(ob) && drive(world, l) >= GRIP_OFF && l.force <= l.breakF
      && sg.damage[l.a]! < 1 && sg.damage[l.b]! < 1;
    if (ok) keep.push(l);
  }
  const removed = st.links.length - keep.length;
  st.links = keep;
  return removed;
}

/**
 * Islands of linked creatures: returns, for each creature slot in a linked island, the
 * island's lowest slot, and the island member lists in ascending slot order.
 */
export function islands(world: World): Map<number, number[]> {
  const sg = world.seg.c;
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const l of linkState(world).links) {
    const a = sg.owner[l.a]!; const b = sg.owner[l.b]!;
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a); const rb = find(b);
    if (ra !== rb) { if (ra < rb) parent.set(rb, ra); else parent.set(ra, rb); }
  }
  const out = new Map<number, number[]>();
  const members = [...parent.keys()].sort((x, y) => x - y);
  for (const m of members) {
    const r = find(m);
    let list = out.get(r);
    if (!list) { list = []; out.set(r, list); }
    list.push(m);
  }
  return out;
}

/** Solve the links of one island for one substep (hard point constraints, one pass in order). */
export function solveLinks(world: World, wk: Work, members: readonly number[], h: number): void {
  const sg = world.seg.c;
  const { ai, th } = wk;
  const set = new Set(members);
  for (const l of linkState(world).links) {
    if (!set.has(sg.owner[l.a]!)) continue;
    const a = l.a; const b = l.b;
    sincos(th[a]!); const ca = SC.c; const sa = SC.s;
    sincos(th[b]!); const cb = SC.c; const sb = SC.s;
    const rax = l.ax * ca - l.ay * sa; const ray = l.ax * sa + l.ay * ca;
    const rbx = l.bx * cb - l.by * sb; const rby = l.bx * sb + l.by * cb;
    const dx = sg.posX[a]! + rax - sg.posX[b]! - rbx; const dy = sg.posY[a]! + ray - sg.posY[b]! - rby;
    const C = Math.sqrt(dx * dx + dy * dy);
    if (C < 1e-15) continue;
    const nx = dx / C; const ny = dy / C;
    const ga0 = nx; const ga1 = ny; const ga2 = rax * ny - ray * nx;
    const gb0 = -nx; const gb1 = -ny; const gb2 = -(rbx * ny - rby * nx);
    const oa = a * 6; const ob = b * 6;
    const pa0 = ai[oa]! * ga0 + ai[oa + 1]! * ga1 + ai[oa + 2]! * ga2;
    const pa1 = ai[oa + 1]! * ga0 + ai[oa + 3]! * ga1 + ai[oa + 4]! * ga2;
    const pa2 = ai[oa + 2]! * ga0 + ai[oa + 4]! * ga1 + ai[oa + 5]! * ga2;
    const pb0 = ai[ob]! * gb0 + ai[ob + 1]! * gb1 + ai[ob + 2]! * gb2;
    const pb1 = ai[ob + 1]! * gb0 + ai[ob + 3]! * gb1 + ai[ob + 4]! * gb2;
    const pb2 = ai[ob + 2]! * gb0 + ai[ob + 4]! * gb1 + ai[ob + 5]! * gb2;
    const wsum = ga0 * pa0 + ga1 * pa1 + ga2 * pa2 + gb0 * pb0 + gb1 * pb1 + gb2 * pb2;
    const dl = -C / wsum;
    sg.posX[a] = sg.posX[a]! + pa0 * dl; sg.posY[a] = sg.posY[a]! + pa1 * dl; th[a] = th[a]! + pa2 * dl;
    sg.posX[b] = sg.posX[b]! + pb0 * dl; sg.posY[b] = sg.posY[b]! + pb1 * dl; th[b] = th[b]! + pb2 * dl;
    const F = Math.abs(dl) / (h * h);
    if (F > l.force) l.force = F;
  }
}

/** Reset the per-tick peak forces. */
export function resetLinkForces(world: World): void { for (const l of linkState(world).links) l.force = 0; }

/** Grab candidates: a claw segment with its grip drive on, touching another creature. */
export function tryGrab(world: World, i: number, j: number, px: number, py: number): void {
  const sg = world.seg.c;
  if ((sg.organs[i]! & ORGAN.CLAW) === 0 || sg.cmd2[i]! < GRIP_ON || ownsLink(world, i)) return;
  addLink(world, LINK.GRAB, i, j, px, py, gripBreakForce(sg.radius[i]!));
}

export const SIGMA_PIERCE = 4e5;
export const H_HOST = 2e5;

/** Latch candidates: a proboscis mouth (subtype from the Phenotype, adapter for P2). */
export function tryLatch(world: World, wk: Work, i: number, j: number, px: number, py: number): boolean {
  const sg = world.seg.c;
  if (sg.kind[i] !== KIND.MOUTH || wk.subtype[i] !== MOUTH_SUBTYPE.PROBOSCIS) return false;
  if (sg.cmd2[i]! < GRIP_ON || ownsLink(world, i) || wk.latchCool[i]! > 0) return false;
  const r = sg.radius[i]!;
  // piercing stress against the host's hardness H (1 + 20 armour); the host armour is not in
  // the segment pool yet, so only unarmoured hardness is tested
  if (SIGMA_PIERCE <= H_HOST) return false;
  addLink(world, LINK.LATCH, i, j, px, py, 4 * gripBreakForce(r));
  return true;
}

/** Current parasite latches: (parasite slot, host slot, host segment). */
export function latches(world: World): { parasite: number; host: number; hostSeg: number }[] {
  const sg = world.seg.c;
  const out: { parasite: number; host: number; hostSeg: number }[] = [];
  for (const l of linkState(world).links) if (l.type === LINK.LATCH) out.push({ parasite: sg.owner[l.a]!, host: sg.owner[l.b]!, hostSeg: l.b });
  return out;
}

/** Scraping threshold: tangential slip of the latched host segment, in host body lengths per second
 * (0.2 m/s for the 20 cm reference fish, 02 §2.4.5), held for `SCRAPE_S`. */
export const SCRAPE_BL_PER_S = 1;
export const SCRAPE_S = 0.5;
/** A scraped-off parasite is dislodged: it cannot latch again for this long, s. */
export const SCRAPE_COOLDOWN_S = 2;

/**
 * Parasite removal by scraping (02 §2.4.5): a latch breaks when its host segment has slipped
 * against terrain, a wall or another creature faster than `SCRAPE_BL_PER_S` host lengths per
 * second for `SCRAPE_S` without a break. Call after contacts. Returns the removed latches.
 */
export function scrapeLatches(world: World, wk: Work, dt: number): Link[] {
  const st = linkState(world);
  const sg = world.seg.c; const c = world.cr.c;
  const gone: Link[] = [];
  const keep: Link[] = [];
  for (const l of st.links) {
    if (l.type !== LINK.LATCH) { keep.push(l); continue; }
    const host = sg.owner[l.b]!;
    const L = c.length[host]! > 0 ? c.length[host]! : 0.01;
    if (wk.slip[l.b]! > SCRAPE_BL_PER_S * L) l.scrape = (l.scrape ?? 0) + dt; else l.scrape = 0;
    if (l.scrape >= SCRAPE_S - 1e-9) { gone.push(l); wk.latchCool[l.a] = SCRAPE_COOLDOWN_S; } else keep.push(l);
  }
  st.links = keep;
  return gone;
}

/** Count down the re-latch cooldowns (once per tick). */
export function coolLatches(world: World, wk: Work, dt: number): void {
  const hw = world.seg.highWater;
  for (let i = 0; i < hw; i++) if (wk.latchCool[i]! > 0) wk.latchCool[i] = Math.max(0, wk.latchCool[i]! - dt);
}

/** The brain's itch input (03, PH2-6): fraction of a creature's segments that hold a latch. */
export function itch(world: World, slot: number): number {
  const c = world.cr.c; const sg = world.seg.c;
  const n = c.segCount[slot]!;
  if (n === 0) return 0;
  const s0 = c.segStart[slot]!;
  const hit = new Set<number>();
  for (const l of linkState(world).links) if (l.type === LINK.LATCH && l.b >= s0 && l.b < s0 + n && sg.owner[l.b] === slot) hit.add(l.b);
  return hit.size / n;
}
