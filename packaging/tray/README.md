# Tray shell (`Phylotank.exe`)

A light Rust shell (tao event loop, tray-icon menu) that supervises the Node host. Build on Windows with `cargo build --release -p phylotank-tray` and rename the binary to `Phylotank.exe`. `--no-tray` runs the supervisor in the foreground on any OS.

```
Phylotank.exe [--tray | --background] [--no-tray] [--port N] [--node PATH] [--host-script PATH] [--delay S]
  --tray        started from the Run key at logon: wait 20 s, then start the host
  --background  started by the screensaver: start the host at once
```

- **Host:** `node.exe` from `node\` next to the exe, else PATH; `host.mjs` from `web\` next to the exe, else `dist/host.mjs` in a development checkout. Started as `node host.mjs --port P --static <web dir>` at below-normal priority without a console; output to `%LOCALAPPDATA%\Phylotank\logs\host.log`.
- **Supervision:** `host.json` = `{port, pid, startedAt}`; `/health` every 5 s; restart after an exit or 3 missed checks with 1, 5, 30, then 120 s backoff; after 5 crashes in 10 minutes it stops until "Restart host". Stop closes the host's stdin, waits 3 s, then kills it.
- **Menu:** status line, Open god window, Open TV view (to cast a tab), Restart host, Start with Windows (HKCU `Software\Microsoft\Windows\CurrentVersion\Run\Phylotank` = `"<exe>" --tray`), Open log folder, Quit.
- **Single instance:** named mutex `Local\Phylotank`; launching it again opens the god window.
- **Port:** 47615, or the next free one of the 10 after it; views on another port get `?host=` explicitly.

Why not full Tauri v2 yet: see decision 6 in [docs/modules/packaging.md](../../docs/modules/packaging.md). In short, nothing in v0.1 to v0.4 needs Tauri's IPC, bundler or config; the supervisor is framework-free and moves to Tauri unchanged when the v0.5 god window needs native dialogs, or v1.0 needs the NSIS bundler.
