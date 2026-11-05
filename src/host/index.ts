/**
 * src/host: the Node sim host (CONTRACT 4.4, 12, 13, 14.1; 05 §5.2 to 5.5, 5.9). Serves the built
 * views from a manifest, runs one persistent world for every viewer, streams the view protocol
 * over a binary WebSocket at /ws/v1 with per-client interest management and three LOD streams,
 * takes god commands into the journal, autosaves, recovers by replay, and follows the throttle
 * state. See README.md and docs/modules/host.md.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  decodeCborFrame, decodeViewport, encodeCborFrame, FRAME, GOVERNOR_EVERY, MAX_INBOUND_BYTES, readHeader,
  type CborValue, type CommandResult, type GodCommand, type SimEvent, type ViewMode, type WorldConfig,
} from '../core/index.js';
import { envFrameFor } from '../sim/index.js';
import { DEFAULT_DREAM_CONFIG, welcomeFor } from '../sim/session.js';
import { CommandError, HOST_EVENT_ID_BASE, planCast, RateLimit, validateCommand } from './commands.js';
import { InterestStream, type Caps } from './interest.js';
import { TickScheduler } from './scheduler.js';
import {
  hostAllowed, isLoopback, isPrivatePeer, localLanHosts, originAllowed as originAllowedBy, Pairing, scopesFor, Secrets,
  type NetPolicy, type Scope,
} from './security.js';
import { censusFrame, statsFrame, summarise, type TankSummary } from './summary.js';
import { StubProbe, Throttle, type OsProbe, type ThrottleOutput } from './throttle.js';
import { HostWorld, type RecoveryReport } from './world-host.js';

export { HostWorld } from './world-host.js';
export type { RecoveryReport } from './world-host.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.map': 'application/json', '.wasm': 'application/wasm',
};
const CSP = "default-src 'self'; connect-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'self' file: null";
export const MAX_CLIENTS = 16;
export const MAX_LAN_CLIENTS = 8;
/** No ACK for this long (after a first one) means the view is frozen (Lively suspended it). */
export const FREEZE_MS = 3000;
const VIEWS: readonly ViewMode[] = ['wallpaper', 'screensaver', 'tv', 'god'];

/** Files are served only from this manifest, built once at start (CONTRACT 16, 05 §5.9). */
export function buildManifest(dir: string): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
      else if (MIME[extname(name)] && !name.startsWith('host.mjs')) m.set(`/${prefix}${name}`, p);
    }
  };
  walk(dir, '');
  if (m.has('/index.html')) m.set('/', m.get('/index.html')!);
  for (const v of VIEWS) if (m.has(`/${v}.html`)) m.set(`/${v}`, m.get(`/${v}.html`)!);
  return m;
}

/** Origin check for a localhost-only host on `port` (phase-0 signature, kept for callers). */
export function originAllowed(origin: string | undefined, port: number): boolean {
  return originAllowedBy(origin, { port, lan: false, lanGod: false, lanHosts: [] });
}

// ---------------- per-client flow control (05 §5.3.5) ----------------
export class FlowControl {
  dustRateMul = 1;
  bodyCapMul = 1;
  bodyRateMul = 1;
  private lastDegrade = -Infinity;
  private lastRecover = 0;
  bytesPerSec = 0;
  private winBytes = 0;
  private winStart = 0;
  constructor(readonly maxBytesPerSec: number) {}
  sent(n: number, nowMs: number): void {
    this.winBytes += n;
    if (nowMs - this.winStart >= 1000) {
      this.bytesPerSec = this.bytesPerSec * 0.5 + ((this.winBytes * 1000) / Math.max(1, nowMs - this.winStart)) * 0.5;
      this.winBytes = 0; this.winStart = nowMs;
    }
  }
  /** Feed the socket's buffered bytes; degrade if more than 250 ms is queued or over the byte cap. */
  check(buffered: number, nowMs: number): void {
    const rate = Math.max(this.bytesPerSec, 50_000);
    const queuedMs = (buffered / rate) * 1000;
    const congested = queuedMs > 250 || this.bytesPerSec > this.maxBytesPerSec;
    if (congested && nowMs - this.lastDegrade >= 250) {
      this.lastDegrade = nowMs;
      if (this.dustRateMul > 0.125) this.dustRateMul /= 2;
      else if (this.bodyCapMul > 0.125) this.bodyCapMul /= 2;
      else if (this.bodyRateMul > 0.125) this.bodyRateMul /= 2;
    } else if (!congested && nowMs - this.lastRecover >= 1000 && nowMs - this.lastDegrade >= 1000) {
      this.lastRecover = nowMs;
      if (this.bodyRateMul < 1) this.bodyRateMul = Math.min(1, this.bodyRateMul * 1.1);
      else if (this.bodyCapMul < 1) this.bodyCapMul = Math.min(1, this.bodyCapMul * 1.1);
      else if (this.dustRateMul < 1) this.dustRateMul = Math.min(1, this.dustRateMul * 1.1);
    }
  }
}

/** Stream periods in wall milliseconds (CONTRACT 12.2 rates). */
export const PERIOD_MS = { body: 1000 / 15, dust: 1000 / 15, glow: 500, env: 1000, census: 1000, stats: 1000 } as const;
type StreamName = keyof typeof PERIOD_MS;

export interface HostClient {
  readonly id: number;
  readonly view: ViewMode;
  readonly scopes: Scope[];
  readonly lan: boolean;
  readonly stream: InterestStream;
  readonly flow: FlowControl;
  paused: boolean;
  lastAckMs: number | null;
  frozen: boolean;
  selected: number | null;
  readonly due: Record<StreamName, number>;
  readonly lastTick: Record<StreamName, number>;
  events: SimEvent[];
  eventBudget: number;
  readonly rate: RateLimit;
  send(frame: Uint8Array): void;
  buffered(): number;
}

export interface HostOptions {
  port: number;
  staticDir: string;
  config?: WorldConfig;
  /** World directory; omit for an in-memory world. */
  worldDir?: string;
  /** Directory for secrets.json (default: the world directory; in memory without one). */
  secretsDir?: string;
  /** Explicit bind address. Default 127.0.0.1, or 0.0.0.0 with `lan`. */
  bind?: string;
  /** "Let my TV watch": LAN binding with pairing (off by default, REVIEW R20). */
  lan?: boolean;
  /** God commands from LAN peers: a second, separate switch. */
  lanGod?: boolean;
  autosaveMs?: number;
  probe?: OsProbe;
  /** Start ticking immediately (default true). */
  autostart?: boolean;
  log?: (msg: string) => void;
  now?: () => number;
}

export interface RunningHost {
  readonly port: number;
  hw: HostWorld;
  /** The god token (for the "Open in browser" link fragment; never logged). */
  godToken: string;
  pairing: Pairing;
  secrets: Secrets;
  throttle: Throttle;
  scheduler: TickScheduler;
  clients(): readonly HostClient[];
  summary(): TankSummary;
  /** Apply a validated god command as the god window would (tests, the shell). */
  command(cmd: GodCommand, from?: HostClient): CommandResult;
  /** Run one streaming pass now (tests). */
  pump(): void;
  recovery: RecoveryReport;
  stop(): Promise<void>;
}

const peerAllowed = (peer: string | undefined, p: NetPolicy): boolean => isLoopback(peer) || (p.lan && isPrivatePeer(peer));

export async function startHost(opts: HostOptions): Promise<RunningHost> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => performance.now());
  const manifest = buildManifest(opts.staticDir);
  const hw = HostWorld.open({ ...(opts.worldDir ? { dir: opts.worldDir } : {}), config: opts.config ?? DEFAULT_DREAM_CONFIG });
  const secretsDir = opts.secretsDir ?? opts.worldDir;
  const secrets = new Secrets(secretsDir);
  const pairing = new Pairing(secrets);
  const throttle = new Throttle();
  const probe = opts.probe ?? new StubProbe();
  const policy: NetPolicy = { port: opts.port, lan: opts.lan === true, lanGod: opts.lanGod === true, lanHosts: [] };
  const clients = new Map<WebSocket, HostClient>();
  let nextClientId = 1;
  let hostEventId = HOST_EVENT_ID_BASE;
  let lease: { speed: number | 'max'; untilTick?: number; untilWallMs?: number; unattended: boolean; owner: number | null } = { speed: 1, unattended: false, owner: null };
  let lastSummary: TankSummary = summarise(hw.world);
  let lastSaveTick: number | null = hw.tick;
  let lastDaily = new Date().toDateString();
  const bookmarks: { label: string; pos: [number, number]; zoom: number }[] = [];
  let tOut: ThrottleOutput = throttle.out;
  let autosaveMs = opts.autosaveMs ?? 600_000;
  let lastAutosave = now();

  const scheduler = new TickScheduler({ hz: 30, run: (n) => runTicks(n), now });

  function runTicks(n: number): number {
    const done = hw.step(n);
    governor();
    if (lease.untilTick !== undefined && hw.tick >= lease.untilTick) endLease('until-tick');
    return done;
  }

  /** Governors decide only on GOVERNOR_EVERY ticks and journal the decision (CONTRACT 4.4, R16). */
  function governor(): void {
    const t = hw.tick;
    if (t % GOVERNOR_EVERY !== 0) return;
    const ms = scheduler.recentTickMs;
    if (ms.length < 30) return;
    const p95 = [...ms].sort((a, b) => a - b)[Math.floor(ms.length * 0.95)]!;
    const want: 1 | 2 | 3 = p95 > 25 ? 3 : p95 > 15 ? 2 : 1;
    if (want !== hw.world.g.brainDiv) hw.schedule({ tick: t, kind: 'governor', decision: { brainDiv: want } });
  }

  function effectiveSpeed(): number | 'max' {
    const cap = tOut.maxSpeed;
    if (cap <= 0) return 0;
    if (lease.speed === 'max') return cap === Infinity ? 'max' : cap;
    return Math.min(lease.speed, cap);
  }
  function applySpeed(): void {
    const s = effectiveSpeed();
    if (s !== scheduler.speedValue) scheduler.setSpeed(s);
  }
  function endLease(why: string): void {
    hw.note('lease-end', { why });
    lease = { speed: 1, unattended: false, owner: null };
    applySpeed();
  }

  function visibility(): { watching: boolean; wallpaper: boolean; screensaver: boolean } {
    let watching = false; let wallpaper = false; let screensaver = false;
    for (const c of clients.values()) {
      if (c.paused || c.frozen) continue;
      if (c.view === 'god' || c.view === 'tv') watching = true;
      else if (c.view === 'screensaver') screensaver = true;
      else wallpaper = true;
    }
    return { watching, wallpaper, screensaver };
  }

  function updateThrottle(): void {
    const before = tOut.state;
    tOut = throttle.update(now(), probe.sample(), visibility());
    if (tOut.state !== before) log(`throttle: ${before} -> ${tOut.state}`);
    if (lease.untilWallMs !== undefined && Date.now() >= lease.untilWallMs) endLease('until-wall');
    applySpeed();
  }

  // ---------------- streaming ----------------
  function streamsAllowed(c: HostClient): boolean {
    if (c.paused || c.frozen) return false;
    if (tOut.state === 'yield' || tOut.state === 'evicted') return c.view === 'screensaver';
    return true;
  }

  function sendTo(c: HostClient, f: Uint8Array, t: number): void { c.send(f); c.flow.sent(f.length, t); }
  function resetDue(c: HostClient): void { for (const k of Object.keys(c.due) as StreamName[]) { c.due[k] = 0; c.lastTick[k] = -1; } }

  function pump(): void {
    const t = now();
    const w = hw.world;
    for (const c of clients.values()) {
      if (c.lastAckMs !== null && t - c.lastAckMs > FREEZE_MS) c.frozen = true;
      c.flow.check(c.buffered(), t);
      if (!streamsAllowed(c)) continue;
      c.stream.bodyCapMul = c.flow.bodyCapMul;
      const slow = tOut.streaming === 'reduced' ? 2 : 1;
      const isDue = (s: StreamName, mul = 1): boolean => {
        if (t < c.due[s]) return false;
        if (c.lastTick[s] === w.g.tick && s !== 'stats') return false;
        c.due[s] = t + (PERIOD_MS[s] * slow) / Math.max(mul, 1e-3);
        c.lastTick[s] = w.g.tick;
        return true;
      };
      const bodyDue = isDue('body', c.flow.bodyRateMul);
      const dustDue = isDue('dust', c.flow.dustRateMul);
      if (bodyDue || dustDue) for (const f of c.stream.update(w)) sendTo(c, f, t);
      if (bodyDue && c.stream.bodies.extent > 0) sendTo(c, c.stream.bodyFrame(w), t);
      if (dustDue) sendTo(c, c.stream.dustFrameBytes(w), t);
      if (isDue('glow')) sendTo(c, c.stream.glowFrame(w), t);
      if (isDue('env')) sendTo(c, envFrameFor(w), t);
      if (isDue('census')) sendTo(c, censusFrame(lastSummary), t);
      if (c.scopes.includes('god') && isDue('stats')) {
        sendTo(c, statsFrame(lastSummary, { achievedHz: scheduler.achievedHz, speed: scheduler.speedValue, throttle: tOut.state, clients: clients.size, stepErrors: hw.stepErrors, lastSaveTick }), t);
      }
      // events: at most 20 per wall second per view (CONTRACT 11)
      c.eventBudget = Math.min(20, c.eventBudget + (20 * PERIOD_MS.body) / 1000);
      if (c.events.length > 0 && c.eventBudget >= 1) {
        const n = Math.min(c.events.length, Math.floor(c.eventBudget));
        const batch = c.events.splice(0, n);
        c.eventBudget -= n;
        sendTo(c, encodeCborFrame(FRAME.EVENT, w.g.tick, batch as unknown as CborValue), t);
      }
      if (c.events.length > 200) c.events.splice(0, c.events.length - 200);
    }
  }

  /** Births, deaths and bites reach views only as aggregates (CONTRACT 11). */
  const notable = (ev: SimEvent): boolean => ev.k !== 'birth' && ev.k !== 'death' && ev.k !== 'bite';
  hw.onEvents((evs) => {
    const keep = evs.filter(notable);
    if (keep.length === 0) return;
    for (const c of clients.values()) c.events.push(...keep);
  });

  function resyncAll(): void {
    for (const c of clients.values()) {
      c.stream.reset();
      resetDue(c);
      c.send(encodeCborFrame(FRAME.WELCOME, hw.tick, welcomeFor(hw.world, c.scopes)));
    }
  }

  // ---------------- commands ----------------
  function command(cmd: GodCommand, from?: HostClient): CommandResult {
    const res = (r: Omit<CommandResult, 'id'>): CommandResult => ({ id: cmd.id, ...r });
    if (from && !from.scopes.includes('god')) return res({ ok: false, reason: 'forbidden' });
    if (cmd.epoch !== hw.epoch) return res({ ok: false, reason: 'stale-epoch' });
    try {
      switch (cmd.t) {
        case 'cast': {
          const s = scheduler.speedValue;
          const plan = planCast(hw.world, cmd, s === 'max' ? Math.max(1, scheduler.achievedHz / 30) : s, ++hostEventId);
          let snapshotId: string | undefined;
          if (plan.major) {
            // the undo point is the present before the command enters the journal (DESIGN R27)
            snapshotId = hw.save('beforePower', cmd.power)?.id;
            lastSaveTick = hw.tick;
          }
          hw.scheduleGod(plan.ev);
          hw.emitHostEvents([plan.event]);
          return res({ ok: true, eventId: plan.event.eid, fireTick: plan.ev.fireTick, ...(snapshotId ? { snapshotId } : {}) });
        }
        case 'release':
          // needs genome import, development and a sim journal kind for releases (contract request)
          return res({ ok: false, reason: 'release-unsupported' });
        case 'speed': {
          if (cmd.unattended && !cmd.until) return res({ ok: false, reason: 'unattended-needs-until' });
          const untilWallMs = cmd.until?.wallIso ? Date.parse(cmd.until.wallIso) : undefined;
          lease = {
            speed: cmd.speed, unattended: cmd.unattended === true, owner: from?.id ?? null,
            ...(cmd.until?.tick !== undefined ? { untilTick: cmd.until.tick } : {}), ...(untilWallMs !== undefined ? { untilWallMs } : {}),
          };
          hw.note('speed', { speed: cmd.speed, unattended: lease.unattended, until: (cmd.until ?? null) as unknown as CborValue });
          applySpeed();
          return res({ ok: true });
        }
        case 'select':
          if (from) {
            from.selected = cmd.entity;
            from.stream.salience = (id) => (id === cmd.entity ? 10 : 0);
          }
          return res({ ok: true });
        case 'snapshot': {
          const info = hw.save('manual', cmd.label);
          lastSaveTick = hw.tick;
          return res({ ok: true, ...(info ? { snapshotId: info.id } : {}) });
        }
        case 'rewind': {
          const info = hw.rewind(cmd.snapshotId);
          lastSaveTick = hw.tick;
          resyncAll();
          return res({ ok: true, snapshotId: info.id });
        }
        case 'bookmark':
          bookmarks.push({ label: cmd.label, pos: cmd.pos, zoom: cmd.zoom });
          hw.note('bookmark', { label: cmd.label, pos: cmd.pos, zoom: cmd.zoom });
          return res({ ok: true });
        case 'setting': {
          if (cmd.key === 'autosaveMin' && typeof cmd.value === 'number' && cmd.value >= 2 && cmd.value <= 60) {
            autosaveMs = cmd.value * 60_000;
            hw.note('setting', { key: cmd.key, value: cmd.value });
            return res({ ok: true });
          }
          if (cmd.key === 'backgroundSpeed' && typeof cmd.value === 'number' && cmd.value >= 0 && cmd.value <= 1) {
            throttle.cfg.backgroundSpeed = cmd.value;
            hw.note('setting', { key: cmd.key, value: cmd.value });
            return res({ ok: true });
          }
          return res({ ok: false, reason: 'unknown-setting' });
        }
      }
    } catch (e) {
      return res({ ok: false, reason: e instanceof CommandError ? e.reason : `error: ${(e as Error).message}`.slice(0, 120) });
    }
  }

  // ---------------- HTTP ----------------
  let port = opts.port;
  const json = (res: ServerResponse, code: number, v: unknown, extra: Record<string, string> = {}): void => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }).end(JSON.stringify(v));
  };
  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> => new Promise((resolve) => {
    let n = 0; const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => { n += d.length; if (n > 4096) { req.destroy(); resolve({}); } else parts.push(d); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}') as Record<string, unknown>); } catch { resolve({}); } });
  });
  const bearer = (req: IncomingMessage): string | undefined => {
    const a = req.headers.authorization;
    return typeof a === 'string' && a.startsWith('Bearer ') ? a.slice(7) : undefined;
  };

  async function http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const peer = req.socket.remoteAddress;
    if (!peerAllowed(peer, policy)) { res.writeHead(403).end(); return; }
    if (!hostAllowed(req.headers.host, policy)) { res.writeHead(421).end('misdirected'); return; }
    const path = (req.url ?? '/').split('?')[0]!;
    const origin = req.headers.origin;
    if (path === '/health') {
      // the Lively loader probes from a file:// (null) origin; it learns only that the host is up
      if (origin === 'null' || origin?.startsWith('file:')) { json(res, 200, { ok: true }, { 'access-control-allow-origin': 'null' }); return; }
      if (!originAllowedBy(origin, policy)) { res.writeHead(403).end(); return; }
      json(res, 200, { ok: true, tick: hw.tick, epoch: hw.epoch, state: tOut.state, clients: clients.size, achievedHz: Math.round(scheduler.achievedHz * 10) / 10 });
      return;
    }
    if (path.startsWith('/pair/')) {
      if (!originAllowedBy(origin, policy)) { res.writeHead(403).end(); return; }
      if (path === '/pair/request' && req.method === 'POST') {
        if (!policy.lan) { json(res, 403, { error: 'lan-off' }); return; }
        const body = await readBody(req);
        const r = pairing.request(peer ?? '', typeof body.name === 'string' ? body.name : 'TV');
        if ('error' in r) { json(res, 429, r); return; }
        log(`pairing: "${r.name}" wants to watch, code ${r.code.slice(0, 3)} ${r.code.slice(3)}`);
        json(res, 200, { pairId: r.id, code: r.code });
        return;
      }
      if (path === '/pair/status' && req.method === 'GET') {
        const id = new URL(req.url ?? '', 'http://x').searchParams.get('pairId') ?? '';
        json(res, 200, pairing.status(id, peer ?? ''));
        return;
      }
      // approval, listing and revocation need the god token, from loopback only
      const god = isLoopback(peer) && (scopesFor(peer, bearer(req), secrets, policy) ?? []).includes('god');
      if (!god) { json(res, 403, { error: 'forbidden' }); return; }
      if (path === '/pair/pending') { json(res, 200, pairing.pending().map(({ id, code, name, createdMs }) => ({ id, code, name, createdMs }))); return; }
      if (path === '/pair/devices') { json(res, 200, secrets.devices().map(({ id, name, pairedIso }) => ({ id, name, pairedIso }))); return; }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      const body = await readBody(req);
      if (path === '/pair/approve') { json(res, 200, { ok: pairing.approve(String(body.pairId ?? ''), String(body.code ?? '')) }); return; }
      if (path === '/pair/deny') { json(res, 200, { ok: pairing.deny(String(body.pairId ?? '')) }); return; }
      if (path === '/pair/revoke') {
        const ok = secrets.revoke(String(body.deviceId ?? ''));
        // drop LAN viewers whose token no longer resolves
        if (ok) for (const [ws, c] of clients) if (c.lan) ws.close(4001, 'revoked');
        json(res, 200, { ok });
        return;
      }
      res.writeHead(404).end();
      return;
    }
    const file = manifest.get(path);
    if (!file || req.method !== 'GET') { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'content-security-policy': CSP, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    res.end(readFileSync(file));
  }
  const server = createServer((req, res) => { http(req, res).catch(() => { if (!res.headersSent) res.writeHead(500).end(); }); });

  // ---------------- WebSocket ----------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_BYTES });
  server.on('upgrade', (req, socket, head) => {
    const okPath = (req.url ?? '').split('?')[0] === '/ws/v1';
    if (!okPath || !peerAllowed(req.socket.remoteAddress, policy) || !hostAllowed(req.headers.host, policy) || !originAllowedBy(req.headers.origin, policy)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  function hello(ws: WebSocket, peer: string | undefined, bytes: Uint8Array): HostClient | null {
    const lan = !isLoopback(peer);
    const p = decodeCborFrame(bytes).payload as { view?: unknown; token?: unknown; caps?: Partial<Caps> } | null;
    const view = VIEWS.includes(p?.view as ViewMode) ? (p!.view as ViewMode) : 'wallpaper';
    const scopes = scopesFor(peer, typeof p?.token === 'string' ? p.token : undefined, secrets, policy);
    if (!scopes) { ws.send(encodeCborFrame(FRAME.ERROR, hw.tick, { code: 'unauthorised', message: 'pair this device first' })); ws.close(4003, 'unauthorised'); return null; }
    const lanCount = [...clients.values()].filter((c) => c.lan).length;
    if (clients.size >= MAX_CLIENTS || (lan && lanCount >= MAX_LAN_CLIENTS)) { ws.send(encodeCborFrame(FRAME.ERROR, hw.tick, { code: 'busy', message: 'too many viewers' })); ws.close(1013, 'busy'); return null; }
    const caps: Partial<Caps> = {};
    const pc = p?.caps ?? {};
    if (typeof pc.maxBodies === 'number' && pc.maxBodies >= 0) caps.maxBodies = Math.min(pc.maxBodies, 20_000);
    if (typeof pc.maxDust === 'number' && pc.maxDust >= 0) caps.maxDust = Math.min(pc.maxDust, 300_000);
    if (typeof pc.maxBytesPerSec === 'number' && pc.maxBytesPerSec > 0) caps.maxBytesPerSec = pc.maxBytesPerSec;
    if (lan) caps.maxBytesPerSec = Math.min(caps.maxBytesPerSec ?? 1_000_000, 1_000_000); // 8 Mbps hard cap on the LAN
    const stream = new InterestStream(caps);
    const c: HostClient = {
      id: nextClientId++, view, scopes, lan, stream, flow: new FlowControl(stream.caps.maxBytesPerSec), paused: false,
      lastAckMs: null, frozen: false, selected: null,
      due: { body: 0, dust: 0, glow: 0, env: 0, census: 0, stats: 0 },
      lastTick: { body: -1, dust: -1, glow: -1, env: -1, census: -1, stats: -1 },
      events: [], eventBudget: 20, rate: new RateLimit(20, 20, now()),
      send: (f) => { if (ws.readyState === ws.OPEN) ws.send(f); },
      buffered: () => ws.bufferedAmount,
    };
    clients.set(ws, c);
    c.send(encodeCborFrame(FRAME.WELCOME, hw.tick, welcomeFor(hw.world, scopes)));
    return c;
  }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const peer = req.socket.remoteAddress;
    let client: HostClient | null = null;
    const helloTimer = setTimeout(() => { if (!client) ws.close(1008, 'no hello'); }, 5000);
    ws.on('message', (data, isBinary) => {
      if (!isBinary) { ws.close(1003, 'binary frames only'); return; }
      const bytes = new Uint8Array(data as Buffer);
      try {
        const h = readHeader(bytes);
        if (!client) {
          if (h.type !== FRAME.HELLO) { ws.close(1008, 'hello first'); return; }
          client = hello(ws, peer, bytes);
          if (client) { clearTimeout(helloTimer); updateThrottle(); pump(); }
          return;
        }
        const c = client;
        switch (h.type) {
          case FRAME.VIEWPORT: {
            const v = decodeViewport(bytes);
            const wasPaused = c.paused;
            c.paused = v.paused;
            c.stream.setViewport(v, now());
            if (v.resync) resetDue(c);
            if (wasPaused !== c.paused) updateThrottle();
            break;
          }
          case FRAME.ACK:
            c.lastAckMs = now();
            if (c.frozen) { c.frozen = false; c.stream.reset(); resetDue(c); }
            break;
          case FRAME.COMMAND: {
            const payload = decodeCborFrame(bytes).payload as { id?: unknown } | null;
            const id = typeof payload?.id === 'string' ? payload.id.slice(0, 32) : '';
            let result: CommandResult;
            if (!c.rate.take(now())) result = { id, ok: false, reason: 'rate-limited' };
            else if (!c.scopes.includes('god')) result = { id, ok: false, reason: 'forbidden' };
            else {
              try { result = command(validateCommand(payload), c); } catch (e) { result = { id, ok: false, reason: e instanceof CommandError ? e.reason : 'bad-command' }; }
            }
            c.send(encodeCborFrame(FRAME.COMMAND_RESULT, hw.tick, result as unknown as CborValue));
            break;
          }
          case FRAME.BYE: ws.close(1000, 'bye'); break;
          default: break; // unknown and server-only types are ignored (CONTRACT 12.1)
        }
      } catch {
        ws.close(1007, 'bad frame');
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      const c = clients.get(ws);
      clients.delete(ws);
      // a lease lapses when the god window that set it closes, unless it is unattended (DESIGN R29)
      if (c && lease.owner === c.id && !lease.unattended) endLease('owner-closed');
      updateThrottle();
    });
  });

  // ---------------- timers ----------------
  const streamTimer = setInterval(() => { try { pump(); } catch (e) { log(`stream error: ${(e as Error).message}`); } }, 1000 / 30);
  const secondTimer = setInterval(() => {
    try {
      lastSummary = summarise(hw.world);
      updateThrottle();
      const t = now();
      if (hw.store && t - lastAutosave >= autosaveMs) {
        lastAutosave = t;
        const today = new Date().toDateString();
        hw.save(today !== lastDaily ? 'daily' : 'auto');
        lastDaily = today;
        lastSaveTick = hw.tick;
      }
    } catch (e) { log(`host timer error: ${(e as Error).message}`); }
  }, 1000);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.bind ?? (policy.lan ? '0.0.0.0' : '127.0.0.1'), () => resolve());
  });
  const addr = server.address();
  if (addr && typeof addr === 'object') port = addr.port;
  policy.port = port;
  if (policy.lan) policy.lanHosts = localLanHosts(port);
  updateThrottle();
  if (opts.autostart !== false) scheduler.start();

  return {
    get port() { return port; },
    hw, godToken: secrets.godToken, pairing, secrets, throttle, scheduler, recovery: hw.recovery,
    clients: () => [...clients.values()],
    summary: () => (lastSummary = summarise(hw.world)),
    command, pump,
    async stop() {
      scheduler.stop();
      clearInterval(streamTimer);
      clearInterval(secondTimer);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
      // shutdown snapshot (05 §5.4.3); if this is cut short, the journal covers the gap
      if (hw.store) hw.save('auto');
      hw.close();
    },
  };
}
