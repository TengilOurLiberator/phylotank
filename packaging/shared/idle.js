// Phylotank idle water: a calm dark-water animation (gradient, slow caustics, a few drifting
// motes) at 15 fps, shown by the Lively loader and the screensaver while no tank is ready, so
// a view is never black (review R25, DESIGN R31). Self-contained, no dependencies, no network.
// Usage: var idle = phylotankIdle(canvas); idle.pause(true); idle.stop();
(function (root) {
  'use strict';
  function phylotankIdle(canvas) {
    var ctx = canvas.getContext('2d');
    var seed = 0x9e3779b9;
    function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
    var motes = [];
    for (var i = 0; i < 48; i++) {
      motes.push({ x: rnd(), y: rnd(), r: 0.6 + rnd() * 1.8, vx: (rnd() - 0.5) * 0.004, vy: -0.002 - rnd() * 0.004,
        hue: rnd() < 0.7 ? 190 : (rnd() < 0.5 ? 160 : 280), ph: rnd() * 6.283 });
    }
    var paused = false, stopped = false, timer = 0, t = 0, w = 0, h = 0;
    function size() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr * 0.5));
      h = canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr * 0.5));
    }
    function draw() {
      if (!ctx) return;
      var g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#04131f'); g.addColorStop(0.45, '#020a12'); g.addColorStop(1, '#000306');
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      for (var k = 0; k < 3; k++) {
        var cx = w * (0.25 + 0.25 * k + 0.08 * Math.sin(t * 0.05 + k * 2.1));
        var cy = h * (0.12 + 0.05 * Math.sin(t * 0.07 + k));
        var rr = Math.max(w, h) * 0.35;
        var c = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
        c.addColorStop(0, 'rgba(40,110,140,0.05)'); c.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = c; ctx.fillRect(0, 0, w, h);
      }
      for (var j = 0; j < motes.length; j++) {
        var m = motes[j];
        m.x += m.vx / 15; m.y += m.vy / 15;
        if (m.y < -0.02) { m.y = 1.02; m.x = rnd(); }
        if (m.x < -0.02) m.x = 1.02; else if (m.x > 1.02) m.x = -0.02;
        var a = 0.25 + 0.2 * Math.sin(t * 0.6 + m.ph);
        var px = m.x * w, py = m.y * h, pr = m.r * 4;
        var mg = ctx.createRadialGradient(px, py, 0, px, py, pr);
        mg.addColorStop(0, 'hsla(' + m.hue + ',80%,70%,' + a + ')'); mg.addColorStop(1, 'hsla(' + m.hue + ',80%,50%,0)');
        ctx.fillStyle = mg; ctx.fillRect(px - pr, py - pr, pr * 2, pr * 2);
      }
    }
    function tick() {
      if (stopped) return;
      timer = setTimeout(tick, 1000 / 15);
      if (paused || document.hidden) return;
      t += 1 / 15;
      draw();
    }
    size();
    window.addEventListener('resize', size);
    tick();
    return {
      pause: function (p) { paused = !!p; },
      stop: function () { stopped = true; clearTimeout(timer); window.removeEventListener('resize', size); }
    };
  }
  root.phylotankIdle = phylotankIdle;
})(typeof window !== 'undefined' ? window : this);
