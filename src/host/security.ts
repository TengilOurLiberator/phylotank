/**
 * Who may connect and what they may do (05 §5.9, REVIEW R20).
 *
 * - Bind to 127.0.0.1 unless LAN serving is switched on ("Let my TV watch"); then only
 *   loopback, RFC 1918, link-local and IPv6 ULA peers are accepted.
 * - Origin and Host checks defeat cross-site WebSockets and DNS rebinding.
 * - Scopes: loopback views from an allowed origin get `view` implicitly; `god` needs the god
 *   token; LAN devices get `view` only, through pairing (a 6-digit code approved by the god
 *   window or tray), and god over LAN needs a second, separate switch.
 * Tokens are 128-bit random, compared in constant time, and stored hashed for paired devices.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { networkInterfaces, hostname } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from './store.js';

export type Scope = 'view' | 'god';

export interface NetPolicy {
  port: number;
  /** LAN serving on (binds 0.0.0.0). */
  lan: boolean;
  /** God commands from LAN peers (second, warned switch). */
  lanGod: boolean;
  /** Extra Host header values accepted when LAN is on (the machine's LAN addresses, name.local). */
  lanHosts: string[];
}

export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '');
  return a === '::1' || /^127\./.test(a);
}

/** RFC 1918, link-local (169.254/16, fe80::/10) and ULA (fc00::/7), plus loopback. */
export function isPrivatePeer(addr: string | undefined): boolean {
  if (!addr) return false;
  if (isLoopback(addr)) return true;
  const a = addr.replace(/^::ffff:/, '').toLowerCase();
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (m) {
    const [o1, o2] = [Number(m[1]), Number(m[2])];
    return o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168) || (o1 === 169 && o2 === 254);
  }
  return /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
}

/** The machine's private addresses and mDNS name, for the Host allow-list when LAN is on. */
export function localLanHosts(port: number): string[] {
  const out: string[] = [`${hostname().toLowerCase()}.local:${port}`];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.internal || !isPrivatePeer(ni.address)) continue;
      out.push(ni.family === 'IPv6' ? `[${ni.address}]:${port}` : `${ni.address}:${port}`);
    }
  }
  return out;
}

export function hostAllowed(host: string | undefined, p: NetPolicy): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  if (h === `127.0.0.1:${p.port}` || h === `localhost:${p.port}` || h === `[::1]:${p.port}`) return true;
  return p.lan && p.lanHosts.map((x) => x.toLowerCase()).includes(h);
}

export function originAllowed(origin: string | undefined, p: NetPolicy): boolean {
  if (origin === undefined) return true; // non-browser clients; they still need a token off loopback
  const o = origin.toLowerCase();
  if (o === `http://127.0.0.1:${p.port}` || o === `http://localhost:${p.port}` || o === 'http://tauri.localhost' || o === `http://[::1]:${p.port}`) return true;
  return p.lan && p.lanHosts.some((h) => o === `http://${h.toLowerCase()}`);
}

export function newToken(): string { return randomBytes(16).toString('base64url'); }
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
export function tokensEqual(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export interface PairedDevice { id: string; name: string; tokenHash: string; pairedIso: string }
interface SecretsFile { god: string; view: string; devices: PairedDevice[] }

/** Tokens and paired devices, persisted user-only in `<dir>/secrets.json` (or in memory). */
export class Secrets {
  private data: SecretsFile;
  constructor(private readonly dir?: string) {
    const path = dir ? join(dir, 'secrets.json') : null;
    if (path && existsSync(path)) {
      const v = JSON.parse(readFileSync(path, 'utf8')) as Partial<SecretsFile>;
      this.data = { god: v.god ?? newToken(), view: v.view ?? newToken(), devices: Array.isArray(v.devices) ? v.devices : [] };
    } else {
      this.data = { god: newToken(), view: newToken(), devices: [] };
    }
    this.save();
  }
  get godToken(): string { return this.data.god; }
  get viewToken(): string { return this.data.view; }
  devices(): readonly PairedDevice[] { return this.data.devices; }
  addDevice(name: string): { device: PairedDevice; token: string } {
    const token = newToken();
    const device: PairedDevice = { id: randomBytes(6).toString('hex'), name: name.slice(0, 40), tokenHash: sha(token), pairedIso: new Date().toISOString() };
    this.data.devices.push(device);
    this.save();
    return { device, token };
  }
  revoke(id: string): boolean {
    const n = this.data.devices.length;
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    this.save();
    return this.data.devices.length < n;
  }
  deviceFor(token: string | undefined): PairedDevice | undefined {
    if (typeof token !== 'string' || token.length > 64) return undefined;
    const h = sha(token);
    return this.data.devices.find((d) => tokensEqual(d.tokenHash, h));
  }
  private save(): void {
    if (!this.dir) return;
    const path = join(this.dir, 'secrets.json');
    atomicWrite(path, new TextEncoder().encode(JSON.stringify(this.data, null, 2)), this.dir);
    try { chmodSync(path, 0o600); } catch { /* Windows ACLs are the shell's job */ }
  }
}

/** Scopes for a connecting client, or null to refuse. */
export function scopesFor(peer: string | undefined, token: string | undefined, secrets: Secrets, p: NetPolicy): Scope[] | null {
  const loop = isLoopback(peer);
  if (!loop && !(p.lan && isPrivatePeer(peer))) return null;
  const god = tokensEqual(token, secrets.godToken);
  if (loop) return god ? ['view', 'god'] : ['view'];
  if (god && p.lanGod) return ['view', 'god'];
  if (secrets.deviceFor(token)) return ['view'];
  return null;
}

export interface PairRequest { id: string; code: string; name: string; peer: string; createdMs: number; state: 'pending' | 'approved' | 'denied'; token?: string; deviceId?: string }

/**
 * LAN pairing: the TV asks, shows a 6-digit code; the tray or god window shows the same code and
 * approves. At most 5 attempts per minute per peer and 20 overall; requests expire after 2 min.
 */
export class Pairing {
  private readonly reqs = new Map<string, PairRequest>();
  private readonly attempts: { peer: string; ms: number }[] = [];
  constructor(private readonly secrets: Secrets, private readonly now: () => number = Date.now) {}

  request(peer: string, name: string): PairRequest | { error: string } {
    const t = this.now();
    this.expire(t);
    while (this.attempts.length && t - this.attempts[0]!.ms > 60_000) this.attempts.shift();
    if (this.attempts.filter((a) => a.peer === peer).length >= 5 || this.attempts.length >= 20) return { error: 'rate-limited' };
    this.attempts.push({ peer, ms: t });
    const req: PairRequest = {
      id: randomBytes(9).toString('base64url'), code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
      name: name.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').slice(0, 40) || 'TV', peer, createdMs: t, state: 'pending',
    };
    this.reqs.set(req.id, req);
    return req;
  }
  pending(): PairRequest[] { this.expire(this.now()); return [...this.reqs.values()].filter((r) => r.state === 'pending'); }
  approve(id: string, code: string): boolean {
    this.expire(this.now());
    const r = this.reqs.get(id);
    if (!r || r.state !== 'pending' || !tokensEqual(code, r.code)) return false;
    const { device, token } = this.secrets.addDevice(r.name);
    r.state = 'approved'; r.token = token; r.deviceId = device.id;
    return true;
  }
  deny(id: string): boolean { const r = this.reqs.get(id); if (!r) return false; r.state = 'denied'; return true; }
  /** The TV polls this; the token is handed out once. */
  status(id: string, peer: string): { state: string; token?: string } {
    this.expire(this.now());
    const r = this.reqs.get(id);
    if (!r || r.peer !== peer) return { state: 'unknown' };
    if (r.state === 'approved' && r.token) { const token = r.token; this.reqs.delete(id); return { state: 'approved', token }; }
    return { state: r.state };
  }
  private expire(t: number): void { for (const [k, r] of this.reqs) if (t - r.createdMs > 120_000) this.reqs.delete(k); }
}
