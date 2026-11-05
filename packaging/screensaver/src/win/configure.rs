//! `/c[:hwnd]`: the screensaver has no settings of its own; they live in the god window.

use phylotank_common::{current_port, probe, win};
use std::time::Duration;
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IDOK, MB_ICONINFORMATION, MB_OK, MB_OKCANCEL};

pub fn run(owner: Option<HWND>) -> ! {
    let owner = owner.unwrap_or_else(|| unsafe { GetForegroundWindow() });
    let port = current_port();
    let text = "Phylotank screensaver\n\n\
        It shows your Phylotank tank when the Phylotank tray app is running, and a built-in \
        tank otherwise. Any key, click or mouse movement ends it.\n\n\
        Its settings (camera, captions, audio) live in the Phylotank god window. Open it now?";
    if win::message_box(owner, text, "Phylotank", MB_OKCANCEL | MB_ICONINFORMATION) == IDOK {
        if probe::probe(port, Duration::from_millis(500)).is_up() {
            let _ = win::open_local_url(&phylotank_common::view_url(port, "god.html"));
        } else {
            win::message_box(
                owner,
                "The Phylotank host is not running. Start Phylotank from its folder or the Start menu, then try again.",
                "Phylotank",
                MB_OK | MB_ICONINFORMATION,
            );
        }
    }
    std::process::exit(0)
}
