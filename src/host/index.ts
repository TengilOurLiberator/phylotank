/**
 * src/host: the Node sim host. Serves the views, runs one persistent world, streams the view
 * protocol over WebSocket at /ws/v1, and (later) owns persistence, the journal, throttle
 * states, governors, detectors and the CLI. CONTRACT 4.4, 12, 13, 14.1. See README.md.
 *
 * Phase 0: static files from an embedded manifest (no path traversal), Origin and Host checks
 * (05 §5.9), HELLO/WELCOME, and the same SimSession the dream-tank worker uses.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { FRAME, MAX_INBOUND_BYTES, readHeader, type WorldConfig } from '../core/index.js';
import { Pacer } from '../sim/pacer.js';
import { DEFAULT_DREAM_CONFIG, SimSession, type SessionClient } from '../sim/session.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.map': 'application/json', '.wasm': 'application/wasm',
};

/** Files are served only from this manifest, built once at start (CONTRACT 16, 05 §5.9). */
export function buildManifest(dir: string): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
      else if (MIME[extname(name)]) m.set(`/${prefix}${name}`, p);
    }
  };
  walk(dir, '');
  if (m.has('/index.html')) m.set('/', m.get('/index.html')!);
  return m;
}

export function originAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true; // non-browser clients (CLI, tests)
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}` || origin === 'http://tauri.localhost';
}
export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export interface HostOptions { port: number; staticDir: string; config?: WorldConfig; bind?: string }
export interface RunningHost { port: number; session: SimSession; stop(): Promise<void> }

export async function startHost(opts: HostOptions): Promise<RunningHost> {
  const manifest = buildManifest(opts.staticDir);
  const session = new SimSession(opts.config ?? DEFAULT_DREAM_CONFIG);
  const pacer = new Pacer({ hz: 30, onTicks: (n) => session.tick(n) });
  let port = opts.port;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!hostAllowed(req.headers.host, port)) { res.writeHead(421).end('misdirected'); return; }
    const path = (req.url ?? '/').split('?')[0]!;
    const file = manifest.get(path);
    if (!file || req.method !== 'GET') { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': "default-src 'self'; connect-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'self' file: null",
      'cache-control': 'no-cache',
    });
    res.end(readFileSync(file));
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_BYTES });
  server.on('upgrade', (req, socket, head) => {
    const okPath = (req.url ?? '').split('?')[0] === '/ws/v1';
    if (!okPath || !hostAllowed(req.headers.host, port) || !originAllowed(req.headers.origin, port)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws: WebSocket) => {
    const client: SessionClient = { send: (f) => { if (ws.readyState === ws.OPEN) ws.send(f); } };
    let hello = false;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) { ws.close(1003, 'binary frames only'); return; }
      const bytes = new Uint8Array(data as Buffer);
      try {
        const h = readHeader(bytes);
        if (h.type === FRAME.HELLO) { if (!hello) { hello = true; session.add(client, ['view']); } return; }
        if (hello) session.receive(client, bytes);
      } catch {
        ws.close(1007, 'bad frame');
      }
    });
    ws.on('close', () => session.remove(client));
  });

  await new Promise<void>((resolve) => server.listen(opts.port, opts.bind ?? '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (addr && typeof addr === 'object') port = addr.port;
  pacer.start();
  return {
    port, session,
    async stop() {
      pacer.stop();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
