//! `phylotank.scr`: the Windows screensaver wrapper (05 §5.6.2, review R25).
//!
//! Build with `cargo build --release -p phylotank-scr` and rename `phylotank-scr.exe` to
//! `phylotank.scr`. `/s` opens the host's `screensaver.html` full screen on every monitor in a
//! WebView2 (wry and tao), falling back to the bundled standalone tank and then to an idle
//! animation; `/p <hwnd>` draws a small GDI animation into the settings dialog; `/c` points at
//! the god window. Input ends it through Raw Input (`RIDEV_INPUTSINK`) and page listeners.
#![cfg_attr(windows, windows_subsystem = "windows")]
// the gate and source logic is only wired up on Windows; elsewhere it is exercised by its tests
#![cfg_attr(not(windows), allow(dead_code))]

mod args;
mod gate;
mod source;
#[cfg(windows)]
mod win;

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let mode = args::parse(&argv);
    #[cfg(windows)]
    win::run(mode);
    #[cfg(not(windows))]
    {
        eprintln!("phylotank.scr is a Windows screensaver; parsed {mode:?}. Nothing to do on this OS.");
        std::process::exit(2);
    }
}
