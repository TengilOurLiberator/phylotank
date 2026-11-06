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
  decodeBodyEnter, decodeCborFrame, encodeAck, encodeCborFrame, encodeViewport, FRAME, HOST_PORT, readHeader, VIEW_PROFILES,
  type Camera, type SimEvent, type SimLink, type ViewMode,
} from '../core/index.js';
import { audio } from '../audio/index.js';
import { createDirector, idleDrift, type Director } from '../director/index.js';
import { createRenderer } from '../render/index.js';
import { SocketLink, WorkerLink } from '../sim/client.js';
import { CaptionLayer, CaptionScheduler, captionFor } from './captions.js';
import { detectLocale, setLocale, t } from './i18n.js';
import { MockSimLink } from './mock-sim.js';
import { GodApp } from './god/app.js';
import { HostFirstLink } from './link.js';
import { GenomeTemplates } from './genomes.js';
import { TvOverlay } from './tv.js';
import { NameBook } from './naming.js';

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
  const workerUrl = new URL('sim-worker.js', loc.href).href;
  // the Lively wallpaper page tries the local host first, then dreams (DESIGN R31)
  if (mode === 'wallpaper' && sim === null && /wallpaper\.html$/.test(loc.pathname)) {
    return new HostFirstLink(`ws://127.0.0.1:${HOST_PORT}/ws/v1`, { socket: (u) => new SocketLink(u), worker: () => new WorkerLink(workerUrl) });
  }
  return new WorkerLink(workerUrl);
}

/**
 * Census heat for the director: the sim's channels [visible biomass, emissive, activity, carcasses]
 * (src/sim/frames.ts, contract request director §3) with the first two box-blurred over 5 x 5
 * cells (2.5 m on Small, about one drift view), so a waypoint scores what a view around it would
 * hold rather than one cell.
 */
export function directorHeat(h: Uint8Array, W = 64, H = 36): Uint8Array {
  const n = W * H;
  const m = new Float64Array(n), gl = new Float64Array(n);
  for (let i = 0; i < n; i++) { m[i] = h[i * 4]!; gl[i] = h[i * 4 + 1]!; }
  const bm = new Float64Array(n), bg = new Float64Array(n);
  let maxM = 0, maxG = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sm = 0, sg = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      sm += m[yy * W + xx]!; sg += gl[yy * W + xx]!;
    }
    const i = y * W + x;
    bm[i] = sm; bg[i] = sg;
    if (sm > maxM) maxM = sm;
    if (sg > maxG) maxG = sg;
  }
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = maxM > 0 ? Math.round((bm[i]! / maxM) * 255) : 0;
    out[i * 4 + 1] = maxG > 0 ? Math.round((bg[i]! / maxG) * 255) : 0;
    out[i * 4 + 2] = h[i * 4 + 2]!;
    out[i * 4 + 3] = h[i * 4 + 3]!;
  }
  return out;
}

export function bootView(mode: ViewMode, root: HTMLElement): ViewHandle {
  const profile = VIEW_PROFILES[mode];
  const q = new URLSearchParams(window.location.search);
  const lang = q.get('lang');
  setLocale(lang === 'sv' || lang === 'en' || lang === 'xx' ? lang : detectLocale(navigator));
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block;background:#000';
  root.appendChild(canvas);
  const renderer = createRenderer(canvas, mode);
  const link = chooseLink(window.location, mode);
  // real bodies: regrow every creature from its genome with develop() (GENOME_REQ / GENOME)
  const genomes = new GenomeTemplates();
  renderer.setTemplateSource(genomes.source);
  let builtSeen = 0;
  const feedGenomes = (f: Uint8Array): void => {
    try {
      const h = readHeader(f);
      if (h.type === FRAME.WELCOME) {
        const w = decodeCborFrame(f).payload as { lCeiling?: number };
        if (typeof w.lCeiling === 'number') genomes.lCeilingM = w.lCeiling;
        return;
      }
      if (h.type !== FRAME.BODY_ENTER && h.type !== FRAME.GENOME) return;
      for (const req of genomes.ingest(f)) link.send(req);
      if (genomes.built !== builtSeen) { builtSeen = genomes.built; renderer.setTemplateSource(genomes.source); }
    } catch { /* a malformed frame never breaks the view */ }
  };
  let god: GodApp | null = null;
  let tankH = 18;
  const species = new Map<number, string>();
  const entitySpecies = new Map<number, number>();
  // the wallpaper profile has no captions, so it never gets a caption element (UX-T30)
  const captions = profile.captions && q.get('captions') !== 'off' ? new CaptionScheduler(profile.captions.holdS, profile.captions.minGapS) : null;
  const captionLayer = captions ? new CaptionLayer(root, profile) : null;
  let lastSpeed: unknown = 1;
  // user species names win in every view (07 §6.4); this viewer's mirror of the host's record
  const names = new NameBook();
  const nameOf = (id: number): string => { const n = names.get(id); return n ? `${n.genus} ${n.epithet}` : species.get(id) ?? `species ${id}`; };
  const tv = mode === 'tv' ? new TvOverlay(root, {
    tank: () => renderer.tank, speciesName: nameOf,
    viewSize: () => ({ w: canvas.width, h: canvas.height }),
    setSound: (v) => { const a = audio as typeof audio & { setVolume?: (x: number) => void }; if (v === 0) a.stop(); else { void a.start(); a.setVolume?.(v / 10); } },
  }) : null;
  let epoch = -1;
  // the camera director (06 §6.2): built on the first CENSUS so its first waypoint already knows
  // where the life is; wallpaper mode is calm idle drift only (DESIGN R30, D13)
  let dir: Director | null = null;
  let dirTank = '';
  const pendingEvents: SimEvent[] = [];
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const feedDirector = (f: Uint8Array): void => {
    if (mode === 'god') return;
    try {
      const hd = readHeader(f);
      if (hd.type === FRAME.EVENT) {
        const evs = decodeCborFrame(f).payload as unknown as SimEvent[];
        if (Array.isArray(evs)) { pendingEvents.push(...evs); if (pendingEvents.length > 4096) pendingEvents.splice(0, pendingEvents.length - 4096); }
        return;
      }
      if (hd.type !== FRAME.CENSUS) return;
      const c = decodeCborFrame(f).payload as { species?: { id: number; count: number; biomassKg: number }[]; heat?: Uint8Array };
      const key = `${renderer.tank.w}x${renderer.tank.h}`;
      if (!dir || key !== dirTank) {
        dirTank = key;
        dir = createDirector({
          mode, tankW: renderer.tank.w, tankH: renderer.tank.h, viewWpx: canvas.width || 1280, viewHpx: canvas.height || 720,
          lCeilingM: genomes.lCeilingM, reducedMotion, startSettled: true,
        });
        dir.setLocator((id) => renderer.locate(Number(id)));
        (window as unknown as { __phylotankDirector?: Director }).__phylotankDirector = dir;
      }
      dir.setSimTick(hd.tick);
      const h = c.heat instanceof Uint8Array && c.heat.length === 64 * 36 * 4 ? c.heat : null;
      dir.setCensus({ species: c.species ?? [], heat: h ? directorHeat(h) : undefined, heatW: 64, heatH: 36, heatCh: 4 });
    } catch { /* a malformed frame never breaks the view */ }
  };

  let lastTick = 0;
  if (mode === 'god') {
    god = new GodApp(root, link, canvas); // sends its own HELLO
    const client = god.client;
    link.onFrame((f) => { renderer.ingest(f); client.ingest(f); feedGenomes(f); lastTick = client.tick; });
  } else {
    link.onFrame((f) => {
      renderer.ingest(f);
      feedGenomes(f);
      feedDirector(f);
      tv?.ingest(f);
      try { lastTick = readHeader(f).tick; } catch { /* ignore */ }
      if (!captions) return;
      try {
        const hd = readHeader(f);
        if (hd.type === FRAME.WELCOME) {
          const w = decodeCborFrame(f).payload as { tank?: { h: number }; epoch?: number; worldId?: string; speciesTable?: { id: number; name: string }[] };
          if (w.tank) tankH = w.tank.h;
          if (w.worldId !== undefined) names.load(String(w.worldId));
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
            const c = captionFor(ev, nameOf, tankH, (id) => entitySpecies.get(id));
            if (c) captions.offer({ ...c, at: now });
          }
        }
      } catch { /* a malformed frame never breaks the view */ }
    });
    link.send(encodeCborFrame(FRAME.HELLO, 0, {
      view: mode, caps: { maxBytesPerSec: 4_000_000, maxBodies: 2_000, maxDust: 8192, gpu: 'webgl2' },
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
  // the dream tank saves its world when the page goes away (best effort, v0.1 autosave)
  window.addEventListener('pagehide', () => { try { link.send(encodeCborFrame(FRAME.BYE, lastTick, {})); } catch { /* closing */ } });

  let cam: Camera = { cx: 16, cy: 9, zeta: 5 };
  let running = true;
  let last = 0;
  const minInterval = profile.fpsCap > 0 ? 1000 / profile.fpsCap - 1 : 0;
  const t0 = performance.now();
  const stats: Record<string, unknown> = { mode, mock: (link as { mock?: boolean }).mock === true, glOk: renderer.ok, renderer: renderer.stats };
  Object.defineProperty(stats, 'genomeTemplates', { get: () => genomes.built, enumerable: true });
  Object.defineProperty(stats, 'link', { get: () => link.kind, enumerable: true });
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
      const dtS = Math.min(0.25, (now - lastFrameAt) / 1000);
      if (dir) {
        dir.resize(canvas.width, canvas.height);
        cam = dir.step(pendingEvents.splice(0), dtS).camera;
      } else {
        cam = idleDrift(tS, renderer.tank.w, renderer.tank.h, canvas.width, canvas.height);
      }
      if (tv) cam = tv.camera(cam, Math.min(0.1, (now - lastFrameAt) / 1000));
      lastFrameAt = now;
      if (captions && captionLayer) { const c = captions.update(now / 1000); captionLayer.show(tv && !tv.captionsOn ? null : c); }
    }
    renderer.render(now, cam);
    stats.camera = cam;
    // VIEWPORT at most 10 Hz when the view moves, ACK at 2 Hz (CONTRACT 12.2)
    if (now - lastVp > 100) {
      const ppm = 2 ** cam.zeta, hw = canvas.width / (2 * ppm), hh = canvas.height / (2 * ppm);
      const rect: [number, number, number, number] = [cam.cx - hw, cam.cy - hh, cam.cx + hw, cam.cy + hh];
      const key = rect.map((v) => v.toFixed(2)).join(',');
      if (key !== lastVpKey) { lastVpKey = key; link.send(encodeViewport(lastTick, { rect, pxPerM: ppm, paused: false, resync: false, leadS: 0 })); }
      lastVp = now;
    }
    if (now - lastAck > 500 && lastTick > 0) { lastAck = now; link.send(encodeAck(lastTick)); }
  };
  let lastVp = 0, lastAck = 0, lastVpKey = '', lastFrameAt = performance.now();
  if (tv) (window as unknown as { __phylotankTv?: TvOverlay }).__phylotankTv = tv;
  // screensaver and TV: the view, its captions and the overlay form the main landmark (axe "region");
  // the wallpaper gets no extra DOM at all
  if (mode === 'tv' || mode === 'screensaver') {
    const main = document.createElement('main');
    main.setAttribute('aria-label', 'Phylotank');
    canvas.replaceWith(main);
    main.append(canvas);
    if (captionLayer) main.append(captionLayer.el);
    if (tv) main.append(tv.el, tv.modeEl);
  }
  requestAnimationFrame(frame);

  return {
    mode, link,
    stop() { running = false; link.close(); window.removeEventListener('resize', resize); },
  };
}
