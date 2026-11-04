# Lively Wallpaper package

`LivelyInfo.json` plus the contents of `dist/` zipped together make a Lively web wallpaper. `"Type": 1` is believed to mean "web page" but is **unverified** (review R24); spike 4 checks it on William's machine, together with:

- whether a web worker loads from Lively's local file mapping (the dream tank needs `sim-worker.js`); if not, the wallpaper must load from the host at `http://127.0.0.1:47615/wallpaper.html`;
- how Lively pauses a wallpaper (the page also stops on `visibilitychange`);
- one renderer per monitor (two 4K monitors double the cost);
- WebGPU availability inside Lively's WebView2.

Build by hand for now: `npm run build`, then zip `dist/*` with this `LivelyInfo.json` at the zip root.
