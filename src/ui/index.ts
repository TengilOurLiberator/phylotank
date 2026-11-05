/**
 * src/ui: the view shell for every mode, the god window, the designer, the library,
 * onboarding, input and localisation. CONTRACT 13, 14.2, 15. See README.md and docs/modules/ui.md.
 *
 * bootView() wires a sim link, the WebGL2 renderer and the per-mode camera and frame cap.
 *  - wallpaper: no UI at all (no DOM text, ever), idle-drift camera.
 *  - screensaver, tv: captions only, rate limited by the profile (5 s hold / 45 s gap, 6 s / 25 s).
 *  - god: the full god window (./god/app.ts).
 * Link choice: ?host= wins, then the host's own origin, else the dream-tank worker; the god
 * window (and ?sim=mock anywhere) uses the in-page MockSimLink so it works standalone.
 */
import {
  decodeBodyEnter, decodeCborFrame, encodeCborFrame, FRAME, HOST_PORT, readHeader, VIEW_PROFILES,
  type Camera, type SimEvent, type SimLink, type ViewMode,
} from '../core/index.js';
import { audio } from '../audio/index.js';
import { director, idleDrift } from '../director/index.js';
import { createRenderer } from '../render/index.js';
import { SocketLink, WorkerLink } from '../sim/client.js';
import { CaptionLayer, CaptionScheduler, captionFor } from './captions.js';
import { detectLocale, setLocale, t } from './i18n.js';
import { MockSimLink } from './mock-sim.js';
import { GodApp } from './god/app.js';

export const MODES: readonly ViewMode[] = ['wallpaper', 'screensaver', 'tv', 'god'];

export interface ViewHandle {
  readonly mode: ViewMode;
  readonly link: SimLink;
  stop(): void;
}

declare global {
  interface Window { __phylotank?: Record<string, unknown> }
}

/** Choose the sim source (CONTRACT 15): ?host= wins, then the host's own origin, else worker or mock. */
export function chooseLink(loc: Location, mode: ViewMode = 'wallpaper'): SimLink {
  const q = new URLSearchParams(loc.search);
  const host = q.get('host');
  if (host) return new SocketLink(host);
  const sim = q.get('sim');
  if (sim !== 'worker' && sim !== 'mock' && loc.port === String(HOST_PORT)) {
    return new SocketLink(`${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws/v1`);
  }
  if (sim === 'mock' || (mode === 'god' && sim !== 'worker')) return new MockSimLink();
  return new WorkerLink(new URL('sim-worker.js', loc.href).href);
}

export function bootView(mode: ViewMode, root: HTMLElement): ViewHandle {
  const profile = VIEW_PROFILES[mode];
  const q = new URLSearchParams(window.location.search);
  const lang = q.get('lang');
  setLocale(lang === 'sv' || lang === 'en' ? lang : detectLocale(navigator));
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block;background:#000';
  root.appendChild(canvas);
  const renderer = createRenderer(canvas, mode);
  const link = chooseLink(window.location, mode);
  let god: GodApp | null = null;
  let tankH = 18;
  const species = new Map<number, string>();
  const entitySpecies = new Map<number, number>();
  // the wallpaper profile has no captions, so it never gets a caption element (UX-T30)
  const captions = profile.captions && q.get('captions') !== 'off' ? new CaptionScheduler(profile.captions.holdS, profile.captions.minGapS) : null;
  const captionLayer = captions ? new CaptionLayer(root, profile) : null;
  let lastSpeed: unknown = 1;
  let epoch = -1;

  if (mode === 'god') {
    god = new GodApp(root, link, canvas); // sends its own HELLO
    const client = god.client;
    link.onFrame((f) => { renderer.ingest(f); client.ingest(f); });
  } else {
    link.onFrame((f) => {
      renderer.ingest(f);
      if (!captions) return;
      try {
        const hd = readHeader(f);
        if (hd.type === FRAME.WELCOME) {
          const w = decodeCborFrame(f).payload as { tank?: { h: number }; epoch?: number; speciesTable?: { id: number; name: string }[] };
          if (w.tank) tankH = w.tank.h;
          for (const s of w.speciesTable ?? []) species.set(s.id, s.name);
          if (epoch >= 0 && w.epoch !== undefined && w.epoch !== epoch) captions.offer({ text: t('caption.rewound', { when: '' }).trim(), priority: 1, at: performance.now() / 1000 });
          if (w.epoch !== undefined) epoch = w.epoch;
        } else if (hd.type === FRAME.STATS) {
          const s = decodeCborFrame(f).payload as { species?: { id: number; name: string }[]; speed?: { requested: unknown } };
          for (const sp of s.species ?? []) species.set(sp.id, sp.name);
          const req = s.speed?.requested;
          if (req !== undefined && req !== lastSpeed) {
            // "never fast-forward silently" (Q2): one caption per change in captioned views
            if (req !== 1 && req !== 0) captions.offer({ text: t('caption.speed', { x: req === 'max' ? 'max' : String(req) }), priority: 0.9, at: performance.now() / 1000 });
            lastSpeed = req;
          }
        } else if (hd.type === FRAME.BODY_ENTER) {
          for (const e of decodeBodyEnter(f)) entitySpecies.set(e.id, e.species);
          if (entitySpecies.size > 20000) entitySpecies.clear();
        } else if (hd.type === FRAME.EVENT) {
          const evs = decodeCborFrame(f).payload as unknown as SimEvent[];
          const now = performance.now() / 1000;
          for (const ev of Array.isArray(evs) ? evs : []) {
            const c = captionFor(ev, (id) => species.get(id) ?? `species ${id}`, tankH, (id) => entitySpecies.get(id));
            if (c) captions.offer({ ...c, at: now });
          }
        }
      } catch { /* a malformed frame never breaks the view */ }
    });
    link.send(encodeCborFrame(FRAME.HELLO, 0, {
      view: mode, caps: { maxBytesPerSec: 4_000_000, maxBodies: 0, maxDust: 8192, gpu: 'webgl2' },
      viewport: [0, 0, 0, 0],
    }));
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
  const stats: Record<string, unknown> = { mode, link: link.kind, mock: (link as { mock?: boolean }).mock === true, glOk: renderer.ok, renderer: renderer.stats };
  if (captions) stats.captions = captions.history;
  if (god) (window as unknown as { __phylotankGod?: GodApp }).__phylotankGod = god;
  window.__phylotank = stats;
  const frame = (now: number): void => {
    if (!running) return;
    requestAnimationFrame(frame);
    if (document.hidden) return;
    if (now - last < minInterval) return;
    last = now;
    const tS = (now - t0) / 1000;
    if (god) {
      god.frame(now);
      cam = god.camera();
    } else {
      const drift = idleDrift(tS, renderer.tank.w, renderer.tank.h, canvas.width, canvas.height);
      cam = profile.camera === 'idleDrift' ? drift : director.update([], 0, drift);
      if (captions && captionLayer) captionLayer.show(captions.update(now / 1000));
    }
    renderer.render(now, cam);
  };
  requestAnimationFrame(frame);

  return {
    mode, link,
    stop() { running = false; link.close(); window.removeEventListener('resize', resize); },
  };
}
