/**
 * src/ui: the view shell for every mode, the god window, the designer, the library,
 * onboarding, input and localisation. CONTRACT 13, 14.2, 15. See README.md.
 *
 * Phase 0: bootView() wires a sim link (dream-tank worker, or the host socket), the WebGL2
 * renderer and the camera, with the per-mode frame cap. The god page shows a placeholder.
 */
import { encodeCborFrame, FRAME, HOST_PORT, VIEW_PROFILES, type Camera, type SimLink, type ViewMode } from '../core/index.js';
import { audio } from '../audio/index.js';
import { director, idleDrift } from '../director/index.js';
import { createRenderer } from '../render/index.js';
import { SocketLink, WorkerLink } from '../sim/client.js';

export const MODES: readonly ViewMode[] = ['wallpaper', 'screensaver', 'tv', 'god'];

export interface ViewHandle {
  readonly mode: ViewMode;
  readonly link: SimLink;
  stop(): void;
}

declare global {
  interface Window { __phylotank?: Record<string, unknown> }
}

/** Choose the sim source (CONTRACT 15): ?host= wins, then the host's own origin, else the worker. */
export function chooseLink(loc: Location): SimLink {
  const q = new URLSearchParams(loc.search);
  const host = q.get('host');
  if (host) return new SocketLink(host);
  if (q.get('sim') !== 'worker' && loc.port === String(HOST_PORT)) {
    return new SocketLink(`${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws/v1`);
  }
  return new WorkerLink(new URL('sim-worker.js', loc.href).href);
}

export function bootView(mode: ViewMode, root: HTMLElement): ViewHandle {
  const profile = VIEW_PROFILES[mode];
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block;background:#000';
  root.appendChild(canvas);
  const renderer = createRenderer(canvas, mode);
  const link = chooseLink(window.location);
  link.onFrame((f) => renderer.ingest(f));
  link.send(encodeCborFrame(FRAME.HELLO, 0, {
    view: mode, caps: { maxBytesPerSec: 4_000_000, maxBodies: 0, maxDust: 8192, gpu: 'webgl2' },
    viewport: [0, 0, 0, 0],
  }));
  if (mode === 'god') {
    const note = document.createElement('div');
    note.textContent = 'Phylotank god window (phase 0): watching only. Powers, designer and stats arrive in v0.5.';
    note.style.cssText = 'position:fixed;left:16px;top:12px;font:14px system-ui,sans-serif;color:#9fd8e8;opacity:.8';
    root.appendChild(note);
  }
  if (profile.audioDefault) void audio.start();

  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    renderer.resize(canvas.clientWidth * dpr, canvas.clientHeight * dpr, dpr);
  };
  resize();
  window.addEventListener('resize', resize);

  let cam: Camera = { cx: 16, cy: 9, zeta: 5 };
  let running = true;
  let last = 0;
  const minInterval = profile.fpsCap > 0 ? 1000 / profile.fpsCap - 1 : 0;
  const t0 = performance.now();
  const stats = { mode, link: link.kind, glOk: renderer.ok, renderer: renderer.stats };
  window.__phylotank = stats;
  const frame = (now: number): void => {
    if (!running) return;
    requestAnimationFrame(frame);
    if (document.hidden) return;
    if (now - last < minInterval) return;
    last = now;
    const tS = (now - t0) / 1000;
    const drift = idleDrift(tS, renderer.tank.w, renderer.tank.h, canvas.width, canvas.height);
    cam = profile.camera === 'idleDrift' ? drift : director.update([], 0, drift);
    renderer.render(now, cam);
  };
  requestAnimationFrame(frame);

  return {
    mode, link,
    stop() { running = false; link.close(); window.removeEventListener('resize', resize); },
  };
}
