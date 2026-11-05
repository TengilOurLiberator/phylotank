//! `/s`: one borderless, topmost, black window per monitor, each with a WebView2 (05 §5.6.2).
//!
//! Sources, in order: the host's `screensaver.html`, the bundled standalone tank through the
//! `phylotank` custom protocol, the inline idle animation (`crate::source`). Input ends it by
//! two independent paths: Raw Input registered with `RIDEV_INPUTSINK` on our first window
//! (so input counts even while a WebView2 child has focus, and without a global hook), decided
//! by `crate::gate::ExitGate`; and the page listeners in `crate::source::INIT_JS`.
//! `WM_ACTIVATEAPP(false)` after the grace period, `WM_DISPLAYCHANGE` and closing also exit.

use super::fast_exit;
use crate::gate::{ExitGate, Input};
use crate::source::{self, Source};
use phylotank_common::{current_port, paths, probe, statics, win::SingleInstance};
use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tao::event::{ElementState, Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::platform::windows::{WindowBuilderExtWindows, WindowExtWindows};
use tao::window::{Fullscreen, Window, WindowBuilder};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::UI::Input::{
    GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER, RIDEV_INPUTSINK, RID_INPUT,
    RIM_TYPEKEYBOARD, RIM_TYPEMOUSE,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, GetCursorPos, SetCursor, SetWindowLongPtrW, GWLP_WNDPROC, WM_ACTIVATEAPP, WM_DISPLAYCHANGE, WM_INPUT, WM_SETCURSOR,
    WM_SYSCOMMAND, WNDPROC,
};
use wry::http::{header::CONTENT_TYPE, Response, StatusCode};
use wry::{WebContext, WebView, WebViewBuilder};

enum UserEvent {
    /// The host came up after launch: load its page in every window.
    SwitchToHost(u16),
}

static GATE: Mutex<Option<ExitGate>> = Mutex::new(None);
static PREV_PROCS: Mutex<Vec<(isize, isize)>> = Mutex::new(Vec::new());

// Raw Input constants (winuser.h), kept local so the feature list stays short.
const RI_MOUSE_DOWN_MASK: u16 = 0x0001 | 0x0004 | 0x0010 | 0x0040 | 0x0100; // L, R, M, X1, X2 down
const RI_MOUSE_UP_MASK: u16 = 0x0002 | 0x0008 | 0x0020 | 0x0080 | 0x0200;
const RI_MOUSE_WHEELS: u16 = 0x0400 | 0x0800;
const RI_KEY_BREAK: u16 = 0x0001;
const SC_SCREENSAVE: usize = 0xF140;
const SC_CLOSE: usize = 0xF060;

fn cursor_pos() -> Option<(i32, i32)> {
    let mut p = POINT { x: 0, y: 0 };
    (unsafe { GetCursorPos(&mut p) } != 0).then_some((p.x, p.y))
}

fn gate_says_exit(input: Input) -> bool {
    let mut g = GATE.lock().unwrap_or_else(|e| e.into_inner());
    g.as_mut().map(|g| g.should_exit(Instant::now(), input)).unwrap_or(false)
}

fn in_grace() -> bool {
    let g = GATE.lock().unwrap_or_else(|e| e.into_inner());
    g.as_ref().map(|g| g.in_grace(Instant::now())).unwrap_or(true)
}

/// Read one WM_INPUT packet and turn it into gate inputs.
unsafe fn raw_inputs(lparam: LPARAM) -> Vec<Input> {
    let mut raw: RAWINPUT = std::mem::zeroed();
    let mut size = std::mem::size_of::<RAWINPUT>() as u32;
    let got = GetRawInputData(
        lparam as HRAWINPUT,
        RID_INPUT,
        &mut raw as *mut RAWINPUT as *mut _,
        &mut size,
        std::mem::size_of::<RAWINPUTHEADER>() as u32,
    );
    if got == u32::MAX || got == 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    if raw.header.dwType == RIM_TYPEMOUSE {
        let m = raw.data.mouse;
        let flags = m.Anonymous.Anonymous.usButtonFlags;
        if flags & RI_MOUSE_DOWN_MASK != 0 {
            out.push(Input::ButtonDown);
        }
        if flags & RI_MOUSE_UP_MASK != 0 {
            out.push(Input::ButtonUp);
        }
        if flags & RI_MOUSE_WHEELS != 0 {
            out.push(Input::Wheel);
        }
        if m.lLastX != 0 || m.lLastY != 0 {
            if let Some((x, y)) = cursor_pos() {
                out.push(Input::MouseAt { x, y });
            }
        }
    } else if raw.header.dwType == RIM_TYPEKEYBOARD {
        let k = raw.data.keyboard;
        if k.VKey != 0xFF {
            out.push(if k.Flags & RI_KEY_BREAK != 0 { Input::KeyUp } else { Input::KeyDown });
        }
    }
    out
}

/// Our window procedure in front of tao's (classic subclassing through GWLP_WNDPROC).
unsafe extern "system" fn subclass_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_INPUT => {
            for i in raw_inputs(lparam) {
                if gate_says_exit(i) {
                    fast_exit();
                }
            }
        }
        WM_ACTIVATEAPP if wparam == 0 && !in_grace() => fast_exit(),
        WM_DISPLAYCHANGE => fast_exit(),
        WM_SYSCOMMAND if (wparam & 0xFFF0) == SC_SCREENSAVE => return 0, // we are the screensaver
        WM_SYSCOMMAND if (wparam & 0xFFF0) == SC_CLOSE => fast_exit(),
        WM_SETCURSOR => {
            SetCursor(std::ptr::null_mut());
            return 1;
        }
        _ => {}
    }
    let prev = PREV_PROCS.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(h, _)| *h == hwnd as isize).map(|(_, p)| *p);
    match prev {
        Some(p) => {
            let f: WNDPROC = std::mem::transmute::<isize, WNDPROC>(p);
            CallWindowProcW(f, hwnd, msg, wparam, lparam)
        }
        None => 0,
    }
}

unsafe fn subclass(hwnd: HWND) {
    let prev = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, subclass_proc as *const () as usize as isize);
    PREV_PROCS.lock().unwrap_or_else(|e| e.into_inner()).push((hwnd as isize, prev));
}

/// Mouse and keyboard Raw Input to `target`, also while another window has focus.
unsafe fn register_raw_input(target: HWND) -> bool {
    let devices = [
        RAWINPUTDEVICE { usUsagePage: 0x01, usUsage: 0x02, dwFlags: RIDEV_INPUTSINK, hwndTarget: target }, // mouse
        RAWINPUTDEVICE { usUsagePage: 0x01, usUsage: 0x06, dwFlags: RIDEV_INPUTSINK, hwndTarget: target }, // keyboard
    ];
    RegisterRawInputDevices(devices.as_ptr(), devices.len() as u32, std::mem::size_of::<RAWINPUTDEVICE>() as u32) != 0
}

/// Start the tray (which starts the host) if it is installed next to us or in the install folder.
fn start_tray_in_background() -> bool {
    let candidates: Vec<PathBuf> =
        [paths::exe_dir(), Some(paths::install_dir())].into_iter().flatten().map(|d| d.join("Phylotank.exe")).collect();
    for exe in candidates {
        if exe.is_file() {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            if Command::new(&exe).arg("--background").creation_flags(DETACHED_PROCESS).spawn().is_ok() {
                return true;
            }
        }
    }
    false
}

fn serve_bundled(dir: &Path, path: &str) -> Response<Cow<'static, [u8]>> {
    match statics::resolve(dir, path).and_then(|p| std::fs::read(&p).ok().map(|b| (p, b))) {
        Some((p, bytes)) => Response::builder()
            .header(CONTENT_TYPE, statics::mime(&p))
            .header("Cache-Control", "no-cache")
            .body(Cow::Owned(bytes))
            .unwrap_or_else(|_| Response::new(Cow::Borrowed(&b""[..]))),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Cow::Borrowed(&b"not found"[..]))
            .unwrap_or_else(|_| Response::new(Cow::Borrowed(&b""[..]))),
    }
}

fn build_webview(
    window: &Window,
    ctx: &mut WebContext,
    source: &Source,
    monitor: usize,
    port: u16,
    bundled: Option<PathBuf>,
) -> wry::Result<WebView> {
    let mut b = WebViewBuilder::new_with_web_context(ctx)
        .with_background_color((0, 0, 0, 255))
        .with_devtools(false)
        .with_autoplay(false)
        .with_initialization_script(source::INIT_JS)
        .with_navigation_handler(move |url| source::navigation_allowed(&url, port))
        .with_ipc_handler(|req| {
            if req.body().as_str() == "exit" {
                fast_exit();
            }
        });
    if let Some(dir) = bundled {
        b = b.with_custom_protocol(source::PROTOCOL.into(), move |_id, req| serve_bundled(&dir, req.uri().path()));
    }
    b = match source.url(monitor) {
        Some(u) => b.with_url(u),
        None => b.with_html(source::IDLE_HTML),
    };
    b.build(window)
}

pub fn run() -> ! {
    let start = Instant::now();
    let Some(_lock) = SingleInstance::acquire("Local\\PhylotankScreensaver") else { std::process::exit(0) };
    *GATE.lock().unwrap_or_else(|e| e.into_inner()) = Some(ExitGate::new(start, cursor_pos()));

    let port = current_port();
    let host_up = probe::probe(port, source::PROBE_TIMEOUT).is_up();
    let candidates: Vec<PathBuf> = [paths::exe_dir(), Some(paths::install_dir())].into_iter().flatten().map(|d| d.join("web")).collect();
    let bundled = statics::bundled_web_dir(&candidates);
    let source = source::choose(host_up, port, bundled.clone());

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    if !host_up && start_tray_in_background() {
        let proxy = event_loop.create_proxy();
        std::thread::spawn(move || {
            while start.elapsed() < source::SWITCH_WINDOW {
                std::thread::sleep(Duration::from_millis(500));
                if probe::probe(port, source::PROBE_TIMEOUT).is_up() {
                    let _ = proxy.send_event(UserEvent::SwitchToHost(port));
                    return;
                }
            }
        });
    }

    let mut monitors: Vec<_> = event_loop.available_monitors().collect();
    if let Some(primary) = event_loop.primary_monitor() {
        // the primary monitor is monitor 0, which gets the director's hero shots
        if let Some(i) = monitors.iter().position(|m| m.position() == primary.position()) {
            monitors.swap(0, i);
        }
    }
    let mut ctx = WebContext::new(Some(paths::webview_dir("scr")));
    let mut windows: Vec<(Window, WebView)> = Vec::new();
    for (i, m) in monitors.into_iter().enumerate() {
        let window = match WindowBuilder::new()
            .with_title("Phylotank")
            .with_decorations(false)
            .with_always_on_top(true)
            .with_skip_taskbar(true)
            .with_background_color((0, 0, 0, 255))
            .with_fullscreen(Some(Fullscreen::Borderless(Some(m))))
            .build(&event_loop)
        {
            Ok(w) => w,
            Err(_) => continue,
        };
        window.set_cursor_visible(false);
        match build_webview(&window, &mut ctx, &source, i, port, bundled.clone()) {
            Ok(wv) => windows.push((window, wv)),
            Err(_) => {
                // a window without a WebView still blanks its monitor and still takes input
                if let Ok(wv) = build_webview(&window, &mut ctx, &Source::Idle, i, port, None) {
                    windows.push((window, wv));
                }
            }
        }
    }
    if windows.is_empty() {
        std::process::exit(1);
    }
    unsafe {
        for (w, _) in &windows {
            subclass(w.hwnd() as HWND);
        }
        // tao registered Raw Input for its own device events; this replaces it (one target per usage)
        register_raw_input(windows[0].0.hwnd() as HWND);
    }
    let switchable = !matches!(source, Source::Host { .. });

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event, .. } => match event {
                WindowEvent::CloseRequested | WindowEvent::Destroyed => fast_exit(),
                WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => fast_exit(),
                WindowEvent::MouseInput { state: ElementState::Pressed, .. } | WindowEvent::MouseWheel { .. } => fast_exit(),
                WindowEvent::CursorMoved { .. } => {
                    if let Some((x, y)) = cursor_pos() {
                        if gate_says_exit(Input::MouseAt { x, y }) {
                            fast_exit();
                        }
                    }
                }
                _ => {}
            },
            Event::UserEvent(UserEvent::SwitchToHost(port)) if switchable => {
                for (i, (_, wv)) in windows.iter().enumerate() {
                    if let Some(u) = (Source::Host { port }).url(i) {
                        let _ = wv.load_url(&u);
                    }
                }
            }
            _ => {}
        }
    })
}
