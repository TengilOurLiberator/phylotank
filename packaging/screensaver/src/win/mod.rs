//! The Windows side of the screensaver: `/s` (show), `/p` (preview) and `/c` (configure).

mod configure;
mod preview;
mod show;

use crate::args::Mode;

pub fn run(mode: Mode) -> ! {
    match mode {
        Mode::Show => show::run(),
        Mode::Preview(hwnd) => preview::run(hwnd as usize as windows_sys::Win32::Foundation::HWND),
        Mode::Configure(owner) => configure::run(owner.map(|h| h as usize as windows_sys::Win32::Foundation::HWND)),
    }
}

/// Exit now: the wrapper must be gone within 100 ms of input (05 §5.6.2). The OS handles
/// "On resume, display logon screen"; the WebView2 browser processes exit with their host.
pub fn fast_exit() -> ! {
    std::process::exit(0)
}
