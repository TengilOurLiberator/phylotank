/**
 * Landing page: the embedded demo tank. The tank is the real app from dist/ (copied to
 * `tank/` by site/build.mjs), running its sim in a Web Worker inside an iframe. It starts
 * when the frame scrolls into view, unless the visitor prefers reduced motion or reduced
 * data, in which case it waits for the Start button. Stop unloads the iframe completely,
 * so nothing keeps running in the background.
 */
const frame = document.getElementById('demo-frame');
const startBtn = document.getElementById('demo-start') as HTMLButtonElement | null;
const stopBtn = document.getElementById('demo-stop') as HTMLButtonElement | null;
const poster = document.getElementById('demo-poster');
const state = document.getElementById('demo-state');
const SRC = 'tank/index.html?sim=worker&embed=1';

function start(): void {
  if (!frame || frame.querySelector('iframe')) return;
  const f = document.createElement('iframe');
  f.src = SRC;
  f.title = 'Phylotank demo tank, running in your browser';
  f.setAttribute('loading', 'lazy');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  f.tabIndex = -1;
  frame.appendChild(f);
  if (poster) poster.hidden = true;
  if (startBtn) startBtn.hidden = true;
  if (stopBtn) { stopBtn.hidden = false; }
  if (state) state.textContent = 'The demo tank is running.';
}

function stop(): void {
  frame?.querySelector('iframe')?.remove();
  if (poster) poster.hidden = false;
  if (startBtn) { startBtn.hidden = false; startBtn.focus(); }
  if (stopBtn) stopBtn.hidden = true;
  if (state) state.textContent = 'The demo tank is stopped.';
}

startBtn?.addEventListener('click', start);
stopBtn?.addEventListener('click', stop);

const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
const params = new URLSearchParams(window.location.search);
if (frame && !reduce && !saveData && params.get('demo') !== 'off') {
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); start(); }
    }, { rootMargin: '200px' });
    io.observe(frame);
  } else {
    start();
  }
}
