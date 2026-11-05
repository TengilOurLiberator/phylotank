/**
 * A running sim session that speaks the view protocol (CONTRACT 12). Shared by the browser
 * worker (dream tank) and the Node host, so both emit identical frames.
 *
 * Per client: WELCOME, then a keyframe (ENV, CENSUS, the body set and DUST_FRAME); then BODY
 * and DUST frames every DUST_EVERY ticks for its viewport, ENV and CENSUS at 1 Hz (CENSUS
 * `env.speed` and `env.fastForward` show the pacer, so a fast-forward is never silent), STATS
 * at 1 Hz for the god scope, and EVENT frames as events happen (derived events rate-limited to
 * 20 per second of 1x time). Commands (god scope only): `speed` (pacer leases), `cast` (a
 * journalled god event at a fire tick after the lead time) and `release` (a journalled release).
 */
import {
  ByteReader, CENSUS_EVERY, decodeCborFrame, decodeGenome, decodePtkg, decodeViewport, encodeCborFrame, encodeGenome,
  FRAME, G_REL, HEADER_BYTES, isMajorPower, LEAD_MAJOR_S, LEAD_MINOR_S, LEDGER_CHANNELS, POWER_IDS, PRESETS, readHeader,
  TICK_HZ, type CborValue, type GodCommand, type SimCore, type SimEvent, type TemplateId, type World, type WorldConfig,
} from '../core/index.js';
import { Detectors } from './detectors.js';
import { censusPayload, encodeGenomeFrame, envFrameFor, eventFrame, paletteBytes, ViewStream } from './frames.js';
import { drainChannels, drainEvents, schedule, sim as defaultSim, type SimConfig } from './index.js';
import type { Pacer, SpeedRequest } from './pacer.js';
import { stateOf } from './state.js';

/** BODY and DUST frame cadence: every 2nd tick (15 Hz at 1x). */
export const DUST_EVERY = 2;
/** Derived events per client per second of 1x time (CONTRACT 11). */
export const DERIVED_PER_S = 20;

/**
 * The v0.1 dream tank (DESIGN 6): a small food web of the template creatures on the Small
 * Basin. The agent cap bounds the CPU cost of the real physics and brains on one worker core
 * (docs/spikes/integration-1.md has the measured cost per agent).
 */
export const DEFAULT_DREAM_CONFIG: SimConfig = {
  preset: 'small', seedLo: 0x5eed1234, seedHi: 0x0000beef, backend: 'cpu', agentCap: 1200, founderPatches: 3,
  founders: [
    { template: 'motefly', count: 260, zone: 'surface' }, { template: 'meadowlamp', count: 50, zone: 'shelf' },
    { template: 'ashpicker', count: 24, zone: 'floor' }, { template: 'sievebell', count: 8, zone: 'surface' },
    { template: 'hushmaw', count: 5 },
  ],
};

export { paletteBytes };

export function welcomeFor(world: World, scopes: string[]): CborValue {
  const st = stateOf(world);
  return {
    worldId: `${world.g.seedHi.toString(16)}-${world.g.seedLo.toString(16)}`,
    tickHi: Math.floor(world.g.tick / 4294967296), epoch: world.g.epoch, tickHz: TICK_HZ,
    tank: { w: world.preset.widthM, h: world.preset.heightM, preset: world.preset.name },
    lCeiling: world.lCeilingM, palette: paletteBytes(),
    speciesTable: st.species.living().map((r) => ({ id: r.id, parent: r.parent, colour: r.colour, count: r.count })),
    schemaHash: 'v0.1', scopes,
  };
}

export interface SessionClient { send(frame: Uint8Array): void }

interface ClientState { scopes: string[]; stream: ViewStream; tokens: number }

/** Primitive events every view gets; births and deaths only when notable (CONTRACT 11). */
const PRIMITIVE_ALWAYS = new Set(['bite', 'mate', 'infect', 'speciation', 'extinction', 'god', 'release', 'reseed']);

/** Owns one world and fans frames out to clients. Time comes from the caller (a Pacer). */
export class SimSession {
  readonly world: World;
  readonly core: SimCore;
  readonly detectors = new Detectors();
  private readonly clients = new Map<SessionClient, ClientState>();
  private pacer: Pacer | null = null;
  /** Counts of primitive events since the last STATS frame (aggregates for stats). */
  private counts: Record<string, number> = {};

  /** `restored` is a world loaded from a snapshot (dream-tank autosave); otherwise a new one. */
  constructor(config: WorldConfig, core: SimCore = defaultSim, restored?: World) {
    if (!PRESETS[config.preset]) throw new Error(`unknown preset ${config.preset}`);
    this.core = core;
    this.world = restored ?? core.create(config);
  }

  /** Attach the pacer that drives this session, for `speed` commands and the speed display. */
  attachPacer(p: Pacer): void { this.pacer = p; }

  add(c: SessionClient, scopes: string[]): void {
    const st: ClientState = { scopes, stream: new ViewStream(this.world), tokens: DERIVED_PER_S };
    this.clients.set(c, st);
    if (scopes.includes('god')) this.pacer?.setAttended(true);
    c.send(encodeCborFrame(FRAME.WELCOME, this.world.g.tick, welcomeFor(this.world, scopes)));
    c.send(envFrameFor(this.world));
    c.send(encodeCborFrame(FRAME.CENSUS, this.world.g.tick, censusPayload(this.world, this.speedEnv())));
    for (const f of st.stream.frames(this.world)) c.send(f);
  }

  remove(c: SessionClient): void {
    const st = this.clients.get(c);
    if (st?.scopes.includes('god')) this.pacer?.setAttended(false);
    this.clients.delete(c);
  }

  /** Handle one inbound frame from a client (HELLO is handled by the transport). */
  receive(c: SessionClient, bytes: Uint8Array): void {
    const st = this.clients.get(c);
    if (!st) return;
    const h = readHeader(bytes);
    if (h.type === FRAME.VIEWPORT) {
      const v = decodeViewport(bytes);
      st.stream.setViewport(v.rect, v.pxPerM, v.paused, v.resync);
    } else if (h.type === FRAME.COMMAND) {
      const { payload } = decodeCborFrame(bytes);
      const cmd = payload as unknown as GodCommand;
      const id = typeof cmd.id === 'string' ? cmd.id.slice(0, 32) : '';
      const res = st.scopes.includes('god') ? this.command(cmd) : { ok: false, reason: 'scope' };
      c.send(encodeCborFrame(FRAME.COMMAND_RESULT, this.world.g.tick, { id, ...res } as CborValue));
    } else if (h.type === FRAME.GENOME_REQ) {
      const r = new ByteReader(bytes, HEADER_BYTES);
      const n = Math.min(64, r.u16());
      for (let i = 0; i < n; i++) {
        const lo = r.u32();
        const hi = r.u32();
        const key = (BigInt(hi) << 32n) | BigInt(lo);
        const e = stateOf(this.world).store.byGenomeKey(key);
        if (e) c.send(encodeGenomeFrame(this.world.g.tick, key, e.bytes));
      }
    }
    // ACK is accepted and ignored (no flow control yet).
  }

  /** Apply a god command (CONTRACT 13). Returns the COMMAND_RESULT fields. */
  command(cmd: GodCommand): { ok: boolean; reason?: string; fireTick?: number } {
    const w = this.world;
    if (cmd.epoch !== w.g.epoch) return { ok: false, reason: 'stale-epoch' };
    const speedX = this.speedX();
    switch (cmd.t) {
      case 'speed': {
        if (!this.pacer) return { ok: false, reason: 'no-pacer' };
        const req: SpeedRequest = { speed: cmd.speed };
        if (cmd.until?.tick !== undefined) req.untilTick = cmd.until.tick;
        if (cmd.until?.wallIso !== undefined) req.untilWallIso = cmd.until.wallIso;
        if (cmd.unattended) req.unattended = true;
        const refusal = this.pacer.request(req);
        return refusal ? { ok: false, reason: refusal } : { ok: true };
      }
      case 'cast': {
        if (!POWER_IDS.includes(cmd.power)) return { ok: false, reason: 'unknown-power' };
        const lead = isMajorPower(cmd.power, cmd.intensity) ? LEAD_MAJOR_S : LEAD_MINOR_S;
        const fireTick = w.g.tick + Math.max(1, Math.round(lead * TICK_HZ * speedX));
        const dur = cmd.duration ?? 60;
        schedule(w, {
          tick: fireTick, kind: 'god', ev: {
            cmdId: cmd.id, power: cmd.power, target: cmd.target, intensity: cmd.intensity, duration: dur, seed: cmd.seed >>> 0,
            issuedTick: w.g.tick, fireTick, author: 'god',
            envelope: { attack: Math.min(5, dur * 0.1), sustain: dur * 0.8, release: Math.min(10, dur * 0.1) },
          },
        });
        return { ok: true, fireTick };
      }
      case 'release': {
        let genome: Uint8Array;
        try {
          if (cmd.ptkg) {
            const p = decodePtkg(cmd.ptkg);
            const g = p.payload.genome ?? p.payload.designs?.[0]?.genome;
            if (!g) return { ok: false, reason: 'empty-ptkg' };
            genome = encodeGenome(decodeGenome(g, { verifyCrc: true }));
          } else {
            genome = encodeGenome(stateOf(w).modules.genome.template((cmd.libraryId ?? 'motefly') as TemplateId));
          }
        } catch (e) {
          return { ok: false, reason: `bad-design: ${String(e).slice(0, 80)}` };
        }
        const lead = cmd.asLeviathan ? LEAD_MAJOR_S : LEAD_MINOR_S;
        const fireTick = w.g.tick + Math.max(1, Math.round(lead * TICK_HZ * speedX));
        const count = Math.max(1, Math.min(64, Math.floor(cmd.count)));
        schedule(w, {
          tick: fireTick, kind: 'release',
          release: { cmdId: cmd.id, genome, pos: cmd.pos, count, asLeviathan: cmd.asLeviathan, founderProtection: cmd.founderProtection },
        });
        return { ok: true, fireTick };
      }
      default:
        return { ok: false, reason: 'not-implemented' };
    }
  }

  private speedX(): number {
    const s = this.pacer?.status();
    if (!s) return 1;
    return s.speed === 'max' ? Math.max(1, s.achievedX) : Math.max(1, s.speed);
  }

  private speedEnv(): Record<string, CborValue> {
    const s = this.pacer?.status();
    return { speed: s ? s.speed : 1, fastForward: s ? s.fastForward : false, achievedX: s ? s.achievedX : 1 };
  }

  tick(n: number): void {
    for (let i = 0; i < n; i++) {
      this.core.step(this.world);
      const t = this.world.g.tick;
      const prim = drainEvents(this.world);
      for (const e of prim) this.counts[e.k] = (this.counts[e.k] ?? 0) + 1;
      const derived = this.detectors.observe(this.world, prim);
      if (this.clients.size === 0) continue;
      if (prim.length > 0 || derived.length > 0) this.sendEvents(prim, derived);
      if (t % DUST_EVERY === 0) {
        for (const [c, st] of this.clients) if (!st.stream.paused) for (const f of st.stream.frames(this.world)) c.send(f);
      }
      if (t % CENSUS_EVERY === 0) {
        this.broadcast(envFrameFor(this.world));
        this.broadcast(encodeCborFrame(FRAME.CENSUS, t, censusPayload(this.world, this.speedEnv())));
        let stats: CborValue | null = null;
        for (const [c, st] of this.clients) {
          st.tokens = Math.min(DERIVED_PER_S, st.tokens + DERIVED_PER_S / this.speedX());
          if (st.scopes.includes('god')) { stats ??= this.statsPayload(); c.send(encodeCborFrame(FRAME.STATS, t, stats)); }
        }
      }
    }
  }

  private notable(e: SimEvent): boolean {
    if (PRIMITIVE_ALWAYS.has(e.k)) return true;
    const big = G_REL * this.world.lCeilingM;
    if (e.k === 'death') return e.killer !== undefined || e.cause === 'disaster' || e.size >= big;
    if (e.k === 'birth') return e.size >= 0.25 * big;
    return false;
  }

  private sendEvents(prim: SimEvent[], derived: SimEvent[]): void {
    const t = this.world.g.tick;
    const base = prim.filter((e) => this.notable(e));
    for (const [c, st] of this.clients) {
      const take = Math.max(0, Math.min(derived.length, Math.floor(st.tokens)));
      st.tokens -= take;
      const evs = take > 0 ? base.concat(derived.slice(0, take)) : base;
      if (evs.length > 0) c.send(eventFrame(t, evs));
    }
  }

  private statsPayload(): CborValue {
    const w = this.world;
    const st = stateOf(w);
    const audit = st.modules.ecosystem.audit(w);
    const ch = drainChannels(w);
    const counts = this.counts;
    this.counts = {};
    return {
      tick: w.g.tick, population: { live: w.g.liveCount, eggs: w.g.eggCount, carcasses: w.g.carcassCount, cap: w.agentCap },
      species: st.species.living().length, events: counts, deferredBirths: st.deferredBirths,
      ledger: { ok: audit.ok, totalQ: audit.totalQ, expectedQ: audit.expectedQ, pools: audit.pools },
      channels: Object.fromEntries(LEDGER_CHANNELS.map((n, i) => [n, ch[i]!])),
      pacer: this.pacer ? (this.pacer.status() as unknown as CborValue) : null,
    };
  }

  private broadcast(frame: Uint8Array): void { for (const c of this.clients.keys()) c.send(frame); }
}
