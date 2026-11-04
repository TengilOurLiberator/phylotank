# Screensaver wrapper (`phylotank.scr`)

Rust plus wry (WebView2). `src/main.rs` holds the `.scr` argument parser with its tests; the window, monitor handling, input-exit and host start-up are still to do (05 §5.6.2). Build later with `cargo build --release` and rename the binary to `phylotank.scr`.

Open items for spike 4 (review R25): whether the Screen Saver Settings list shows an `.scr` outside System32; whether a god window or a casting Chrome tab holds a wake lock that stops the screensaver; first-frame time when the host is cold (show the idle animation, never black).
