// Phylotank Lively loader (05 §5.6.1 as changed by DESIGN R31).
//
// The wallpaper zip opens index.html, which runs this script at top level so that Lively's
// script calls (livelyPropertyListener, livelyWallpaperPlaybackChanged) always reach it.
//   1. Show the idle water animation at once (never black).
//   2. Probe the host at http://127.0.0.1:<port>/health (no-cors fetch: any HTTP answer counts).
//   3. Host answers: embed http://127.0.0.1:<port>/wallpaper.html in a full-window iframe and
//      fade it in over 2 s. The served page is always the host's version, so the package never
//      goes out of date with the host's protocol.
//   4. No answer within 2 s: embed the standalone dream tank shipped in the zip (tank/), which
//      runs the sim in a worker (a blob: worker when loaded from file://, see worker-shim.js).
//   5. Keep probing (1, 2, 4, 8 s, then every 10 s); switch to the host when it appears, and back
//      to the dream tank after 3 missed health checks in a row.
// Lively properties: "port" (textbox) and "source" (dropdown: auto, host only, built-in only).
(function (root) {
  'use strict';

  var DEFAULT_PORT = 47615;
  var FALLBACK_MS = 2000;
  var RETRY_MS = [1000, 2000, 4000, 8000];
  var MONITOR_MS = 10000;
  var MISSES_BEFORE_FALLBACK = 3;
  var SOURCES = ['auto', 'host', 'standalone'];

  function parsePort(v) {
    var n = Number(String(v == null ? '' : v).trim());
    return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : DEFAULT_PORT;
  }
  function parseSource(v) {
    if (typeof v === 'number') return SOURCES[v] || 'auto';
    var s = String(v == null ? '' : v).toLowerCase();
    if (/^\d+$/.test(s)) return SOURCES[Number(s)] || 'auto';
    return SOURCES.indexOf(s) >= 0 ? s : 'auto';
  }
  function retryDelay(failures) { return failures < RETRY_MS.length ? RETRY_MS[failures] : MONITOR_MS; }
  function hostBase(port) { return 'http://127.0.0.1:' + port; }
  function healthUrl(port) { return hostBase(port) + '/health'; }
  function hostWallpaperUrl(port) { return hostBase(port) + '/wallpaper.html?lively=1'; }

  function initial(source) {
    return { source: source, mounted: 'none', failures: 0, misses: 0 };
  }

  /**
   * Pure state machine. Events: {type: 'start'}, {type: 'fallback'} (2 s after start),
   * {type: 'probe', ok}. Returns {state, mount?: 'none' | 'local' | 'host', next?: ms until
   * the next probe, fallbackIn?: ms}.
   */
  function step(s, ev) {
    var n = { source: s.source, mounted: s.mounted, failures: s.failures, misses: s.misses };
    var out = { state: n };
    function mount(m) { if (n.mounted !== m) { n.mounted = m; out.mount = m; } }
    if (ev.type === 'start') {
      n.failures = 0; n.misses = 0;
      if (n.source === 'standalone') { mount('local'); return out; }
      out.next = 0;
      if (n.source === 'auto') out.fallbackIn = FALLBACK_MS;
      return out;
    }
    if (ev.type === 'fallback') {
      if (n.source === 'auto' && n.mounted === 'none') mount('local');
      return out;
    }
    if (ev.type === 'probe') {
      if (n.source === 'standalone') return out;
      if (ev.ok) {
        n.failures = 0; n.misses = 0;
        mount('host');
        out.next = MONITOR_MS;
        return out;
      }
      if (n.mounted === 'host') {
        n.misses += 1;
        if (n.misses >= MISSES_BEFORE_FALLBACK) {
          n.misses = 0; n.failures = 0;
          mount(n.source === 'auto' ? 'local' : 'none');
          out.next = retryDelay(0);
        } else {
          out.next = MONITOR_MS;
        }
        return out;
      }
      out.next = retryDelay(n.failures);
      n.failures += 1;
      return out;
    }
    return out;
  }

  var api = {
    DEFAULT_PORT: DEFAULT_PORT, FALLBACK_MS: FALLBACK_MS, MONITOR_MS: MONITOR_MS,
    parsePort: parsePort, parseSource: parseSource, retryDelay: retryDelay,
    healthUrl: healthUrl, hostWallpaperUrl: hostWallpaperUrl, initial: initial, step: step,
  };
  root.PhylotankLoader = api;
  if (typeof document === 'undefined' || !document.getElementById) return;

  // ---- DOM driver ----------------------------------------------------------------------
  var cfg = { port: DEFAULT_PORT, source: 'auto' };
  var state = initial(cfg.source);
  var probeTimer = 0, fallbackTimer = 0, generation = 0, paused = false;
  var stage = document.getElementById('stage');
  var idle = root.phylotankIdle ? root.phylotankIdle(document.getElementById('idle')) : null;
  var current = null;
  var status = { mounted: 'none', port: cfg.port, source: cfg.source, probes: 0, lastProbeOk: null };
  root.__phylotankLoader = status;

  function frameUrl(m) { return m === 'host' ? hostWallpaperUrl(cfg.port) : 'tank/wallpaper.html'; }

  function show(m) {
    status.mounted = m;
    var old = current;
    current = null;
    if (m === 'none') {
      if (idle) idle.pause(paused);
      if (old) { old.style.opacity = '0'; setTimeout(function () { old.remove(); }, 2100); }
      return;
    }
    var f = document.createElement('iframe');
    f.className = 'tank';
    f.setAttribute('allow', 'autoplay; fullscreen');
    f.setAttribute('title', 'Phylotank');
    f.src = frameUrl(m);
    f.addEventListener('load', function () {
      requestAnimationFrame(function () { f.style.opacity = '1'; });
      setTimeout(function () {
        if (old) old.remove();
        if (idle && current === f) idle.pause(true);
      }, 2100);
    });
    stage.appendChild(f);
    current = f;
  }

  function apply(out) {
    state = out.state;
    if (out.mount) show(out.mount);
    var g = generation;
    if (out.fallbackIn !== undefined) {
      clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(function () { if (g === generation) apply(step(state, { type: 'fallback' })); }, out.fallbackIn);
    }
    if (out.next !== undefined) {
      clearTimeout(probeTimer);
      probeTimer = setTimeout(function () { probe(g); }, out.next);
    }
  }

  function probe(g) {
    if (g !== generation) return;
    if (paused || document.hidden) { probeTimer = setTimeout(function () { probe(g); }, 1000); return; }
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, 1500);
    status.probes += 1;
    fetch(healthUrl(cfg.port), { mode: 'no-cors', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function () { return true; }, function () { return false; })
      .then(function (ok) {
        clearTimeout(t);
        status.lastProbeOk = ok;
        if (g === generation) apply(step(state, { type: 'probe', ok: ok }));
      });
  }

  function restart() {
    generation += 1;
    clearTimeout(probeTimer); clearTimeout(fallbackTimer);
    status.port = cfg.port; status.source = cfg.source;
    if (current) show('none');
    state = initial(cfg.source);
    apply(step(state, { type: 'start' }));
  }

  var restartTimer = 0;
  function restartSoon() { clearTimeout(restartTimer); restartTimer = setTimeout(restart, 250); }

  // Lively calls this once per property at load with the saved values, then on every change.
  root.livelyPropertyListener = function (name, val) {
    if (name === 'port') { var p = parsePort(val); if (p !== cfg.port) { cfg.port = p; restartSoon(); } }
    else if (name === 'source') { var s = parseSource(val); if (s !== cfg.source) { cfg.source = s; restartSoon(); } }
  };
  // Lively's pause notification (name and payload from its wiki; unverified, spike 4).
  root.livelyWallpaperPlaybackChanged = function (data) {
    var d = data;
    try { if (typeof d === 'string') d = JSON.parse(d); } catch (e) { d = {}; }
    paused = !!(d && (d.IsPaused || d.isPaused));
    if (idle && !current) idle.pause(paused);
    var frames = stage.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      try { frames[i].contentWindow.postMessage({ type: 'phylotank:pause', paused: paused }, '*'); } catch (e) { /* ignore */ }
    }
  };

  var q = new URLSearchParams(location.search);
  if (q.has('port')) cfg.port = parsePort(q.get('port'));
  if (q.has('source')) cfg.source = parseSource(q.get('source'));
  restart();
})(typeof window !== 'undefined' ? window : globalThis);
