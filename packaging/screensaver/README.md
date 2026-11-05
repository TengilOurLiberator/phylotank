# Screensaver (`phylotank.scr`)

Rust with wry 0.57 and tao 0.37 on the system WebView2 runtime. Build on Windows with `cargo build --release -p phylotank-scr` (in `packaging/`) and rename `target/release/phylotank-scr.exe` to `phylotank.scr`; CI does this and puts it in the portable zip. Build with the MSVC toolchain: it links the WebView2 loader statically. A `x86_64-pc-windows-gnu` build (for example cross-built from Linux with MinGW-w64, about 720 KiB) imports `WebView2Loader.dll` instead, which must then sit next to the `.scr`. On Linux, `cargo test` runs the argument parser, the exit gate and the source logic, and `cargo clippy --target x86_64-pc-windows-gnu` checks the Windows code.

| Argument | Behaviour |
|---|---|
| none, `/c`, `/c:<hwnd>` | message box: settings live in the god window; offers to open it |
| `/p <hwnd>`, `/p:<hwnd>` | GDI child window of `<hwnd>`: dark gradient and drifting motes at 15 fps; exits when the parent goes away |
| `/s` | one borderless topmost window with a WebView2 per monitor (primary first, `?monitor=<i>`) |

`/s` shows, in order: the host's `screensaver.html` (port from `%LOCALAPPDATA%\Phylotank\host.json`, default 47615, 200 ms probe); else the bundled views from `web\` next to the `.scr` or in `%LOCALAPPDATA%\Programs\Phylotank\web`, served as `http://phylotank.localhost/` through a custom protocol; else an inline idle animation. With the host down it also starts `Phylotank.exe --background` and switches to the host page if the host answers within 10 s.

Exit: Raw Input (`RIDEV_INPUTSINK`, mouse and keyboard, on the first window) through `gate::ExitGate`: any key, button or wheel press at once (releases never), mouse moves only after 500 ms and beyond 8 px from the start position; page listeners posting `exit` over wry IPC; `WM_ACTIVATEAPP(false)` after the grace period, `WM_DISPLAYCHANGE`, close. The process exits directly (`std::process::exit`), well inside the 100 ms budget. Pages may navigate only within the host, the bundled origin and inline documents. WebView2 profile: `%LOCALAPPDATA%\Phylotank\WebView2\scr`.

Open items for spike 4 (review R25): whether Screen Saver Settings lists an `.scr` outside System32 (`install.ps1` sets `SCRNSAVE.EXE` per user; the fallback is right-click, Install); whether a god window or a casting Chrome tab holds a wake lock that keeps the screensaver from starting; exit latency and first-frame time on the real machine; x64 only (the window subclassing uses `SetWindowLongPtrW`).
