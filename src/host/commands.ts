/**
 * God-command intake (CONTRACT 13, 05 §5.9): schema validation, the epoch check, rate limits,
 * lead time to a fire tick, an automatic `beforePower` snapshot for major powers, the journal,
 * and the `god` event every view receives.
 */
import {
  isMajorPower, LEAD_MAJOR_S, LEAD_MINOR_S, POWER_IDS, TICK_HZ, type CommandResult, type GodCommand, type GodEventScheduled,
  type PowerId, type SimEvent, type Speed, type Target, type V2, type World,
} from '../core/index.js';

export class CommandError extends Error { constructor(readonly reason: string) { super(reason); } }

const SPEEDS = [0, 0.25, 1, 4, 16, 'max'] as const;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
function v2(v: unknown): V2 {
  if (!Array.isArray(v) || v.length !== 2 || !isNum(v[0]) || !isNum(v[1])) throw new CommandError('bad-position');
  return [v[0], v[1]];
}

function target(v: unknown): Target {
  const t = v as Record<string, unknown> | null;
  if (!t || typeof t !== 'object') throw new CommandError('bad-target');
  switch (t.kind) {
    case 'global': return { kind: 'global' };
    case 'point': return { kind: 'point', pos: v2(t.pos) };
    case 'circle': if (!isNum(t.radius) || t.radius <= 0 || t.radius > 1000) throw new CommandError('bad-target'); return { kind: 'circle', pos: v2(t.pos), radius: t.radius };
    case 'depthBand': if (!isNum(t.y0) || !isNum(t.y1)) throw new CommandError('bad-target'); return { kind: 'depthBand', y0: Math.min(t.y0, t.y1), y1: Math.max(t.y0, t.y1) };
    case 'stroke': if (!Array.isArray(t.points) || t.points.length < 1 || t.points.length > 256) throw new CommandError('bad-target'); return { kind: 'stroke', points: t.points.map(v2) };
    case 'species': if (!Array.isArray(t.species) || t.species.length > 64 || !t.species.every((x) => Number.isInteger(x) && (x as number) >= 0)) throw new CommandError('bad-target'); return { kind: 'species', species: t.species as number[] };
    case 'creature': if (!Number.isInteger(t.entity) || (t.entity as number) < 1) throw new CommandError('bad-target'); return { kind: 'creature', entity: t.entity as number };
    default: throw new CommandError('bad-target');
  }
}

/** Validate a decoded CBOR payload into a GodCommand. Throws CommandError with a reason. */
export function validateCommand(p: unknown): GodCommand {
  const c = p as Record<string, unknown> | null;
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new CommandError('bad-command');
  if (!isStr(c.id, 32) || c.id.length === 0) throw new CommandError('bad-id');
  if (!Number.isInteger(c.epoch) || (c.epoch as number) < 0) throw new CommandError('bad-epoch');
  const base = { id: c.id, epoch: c.epoch as number };
  switch (c.t) {
    case 'cast': {
      if (!POWER_IDS.includes(c.power as PowerId)) throw new CommandError('unknown-power');
      if (!isNum(c.intensity) || c.intensity < 0 || c.intensity > 1) throw new CommandError('bad-intensity');
      if (c.duration !== undefined && (!isNum(c.duration) || c.duration < 0 || c.duration > 3600)) throw new CommandError('bad-duration');
      if (!Number.isInteger(c.seed) || (c.seed as number) < 0 || (c.seed as number) > 0xffffffff) throw new CommandError('bad-seed');
      return { ...base, t: 'cast', power: c.power as PowerId, target: target(c.target), intensity: c.intensity, ...(c.duration !== undefined ? { duration: c.duration as number } : {}), seed: c.seed as number };
    }
    case 'release': {
      if (c.ptkg !== undefined && !(c.ptkg instanceof Uint8Array)) throw new CommandError('bad-ptkg');
      if (c.libraryId !== undefined && !isStr(c.libraryId, 64)) throw new CommandError('bad-library-id');
      if (!Number.isInteger(c.count) || (c.count as number) < 1 || (c.count as number) > 64) throw new CommandError('bad-count');
      return { ...base, t: 'release', ...(c.ptkg ? { ptkg: c.ptkg as Uint8Array } : {}), ...(c.libraryId ? { libraryId: c.libraryId as string } : {}), pos: v2(c.pos), count: c.count as number, asLeviathan: c.asLeviathan === true, founderProtection: c.founderProtection === true };
    }
    case 'speed': {
      if (!SPEEDS.includes(c.speed as (typeof SPEEDS)[number])) throw new CommandError('bad-speed');
      const u = c.until as Record<string, unknown> | undefined;
      let until: { tick?: number; wallIso?: string } | undefined;
      if (u !== undefined) {
        if (!u || typeof u !== 'object') throw new CommandError('bad-until');
        until = {};
        if (u.tick !== undefined) { if (!Number.isInteger(u.tick)) throw new CommandError('bad-until'); until.tick = u.tick as number; }
        if (u.wallIso !== undefined) { if (!isStr(u.wallIso, 40) || Number.isNaN(Date.parse(u.wallIso))) throw new CommandError('bad-until'); until.wallIso = u.wallIso; }
      }
      return { ...base, t: 'speed', speed: c.speed as Speed, ...(until ? { until } : {}), unattended: c.unattended === true };
    }
    case 'select': if (!Number.isInteger(c.entity)) throw new CommandError('bad-entity'); return { ...base, t: 'select', entity: c.entity as number, pin: c.pin === true };
    case 'snapshot': if (!isStr(c.label, 40)) throw new CommandError('bad-label'); return { ...base, t: 'snapshot', label: c.label };
    case 'rewind': if (!isStr(c.snapshotId, 96)) throw new CommandError('bad-snapshot-id'); return { ...base, t: 'rewind', snapshotId: c.snapshotId };
    case 'bookmark': if (!isStr(c.label, 40) || !isNum(c.zoom)) throw new CommandError('bad-bookmark'); return { ...base, t: 'bookmark', label: c.label, pos: v2(c.pos), zoom: c.zoom };
    case 'setting': {
      if (!isStr(c.key, 64)) throw new CommandError('bad-setting');
      const ok = isNum(c.value) || typeof c.value === 'boolean' || isStr(c.value, 256);
      if (!ok) throw new CommandError('bad-setting');
      return { ...base, t: 'setting', key: c.key, value: c.value as number | string | boolean };
    }
    default: throw new CommandError('unknown-command');
  }
}

/** Token bucket: 20 commands per second per client (05 §5.9). */
export class RateLimit {
  private tokens: number;
  private last: number;
  constructor(private readonly perSec = 20, private readonly burst = 20, now = 0) { this.tokens = burst; this.last = now; }
  take(nowMs: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((nowMs - this.last) / 1000) * this.perSec);
    this.last = nowMs;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Fire tick for a cast: lead time at the achieved speed; while paused the countdown starts on resume. */
export function fireTickFor(tick: number, major: boolean, speed: number): number {
  const lead = major ? LEAD_MAJOR_S : LEAD_MINOR_S;
  const s = speed > 0 && Number.isFinite(speed) ? speed : 1;
  return tick + Math.max(1, Math.round(lead * TICK_HZ * s));
}

export function targetCentre(world: World, t: Target): { pos: V2; radius: number } {
  const W = world.preset.widthM; const H = world.preset.heightM;
  switch (t.kind) {
    case 'point': return { pos: t.pos, radius: 0 };
    case 'circle': return { pos: t.pos, radius: t.radius };
    case 'depthBand': return { pos: [W / 2, (t.y0 + t.y1) / 2], radius: (t.y1 - t.y0) / 2 };
    case 'stroke': {
      const n = t.points.length;
      const cx = t.points.reduce((a, p) => a + p[0], 0) / n; const cy = t.points.reduce((a, p) => a + p[1], 0) / n;
      return { pos: [cx, cy], radius: Math.max(...t.points.map((p) => Math.hypot(p[0] - cx, p[1] - cy))) };
    }
    default: return { pos: [W / 2, H / 2], radius: Math.hypot(W, H) / 2 };
  }
}

/** Host-made event ids live above 2^50 so they never collide with the sim's world counter. */
export const HOST_EVENT_ID_BASE = 2 ** 50;

export interface CastPlan { ev: GodEventScheduled; major: boolean; event: SimEvent }

export function planCast(world: World, cmd: GodCommand & { t: 'cast' }, speed: number, eid: number): CastPlan {
  const major = isMajorPower(cmd.power, cmd.intensity);
  const tick = world.g.tick;
  const fireTick = fireTickFor(tick, major, speed);
  const duration = cmd.duration ?? 20;
  const ev: GodEventScheduled = {
    cmdId: cmd.id, power: cmd.power, target: cmd.target, intensity: cmd.intensity, duration, seed: cmd.seed,
    issuedTick: tick, fireTick, author: 'god', envelope: { attack: Math.min(2, duration / 4), sustain: duration, release: Math.min(5, duration / 2) },
  };
  const { pos, radius } = targetCentre(world, cmd.target);
  const event = { k: 'god', t: tick, eid, epoch: world.g.epoch, cmdId: cmd.id, power: cmd.power, author: 'god', tFire: fireTick, pos, radius, strength: cmd.intensity, major } as SimEvent;
  return { ev, major, event };
}

export type { CommandResult };
