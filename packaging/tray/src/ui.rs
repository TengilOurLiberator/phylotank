//! The tray icon and menu (Windows). Single instance through the named mutex `Local\Phylotank`
//! (05 §5.2.3 step 2): a second launch opens the god window of the running one and exits.
//! The god window opens in the default browser in v0.1; a native WebView2 window with the
//! file-dialog capabilities of 05 §5.6.4 is v0.5 work.

use crate::launch::Options;
use crate::supervisor::{State, Supervisor};
use phylotank_common::{cmdline, current_port, paths, win};
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

enum UserEvent {
    Status(State),
    Menu(MenuEvent),
}

fn view_url(port: u16, page: &str) -> String {
    format!("http://127.0.0.1:{port}/{page}")
}

/// A 32 x 32 glowing mote, drawn in code so the build needs no image files.
fn icon() -> Option<Icon> {
    let n = 32usize;
    let mut rgba = vec![0u8; n * n * 4];
    for y in 0..n {
        for x in 0..n {
            let (dx, dy) = (x as f32 - 15.5, y as f32 - 15.5);
            let d = (dx * dx + dy * dy).sqrt() / 15.5;
            let a = (1.0 - d).clamp(0.0, 1.0).powf(1.6);
            let core = (1.0 - d * 3.0).clamp(0.0, 1.0);
            let i = (y * n + x) * 4;
            rgba[i] = (60.0 + 195.0 * core) as u8;
            rgba[i + 1] = (190.0 + 65.0 * core) as u8;
            rgba[i + 2] = 230;
            rgba[i + 3] = (255.0 * a) as u8;
        }
    }
    Icon::from_rgba(rgba, n as u32, n as u32).ok()
}

fn exe_path() -> String {
    std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

fn autostart_enabled() -> bool {
    win::autostart_get().map(|v| cmdline::program_of(&v).eq_ignore_ascii_case(&exe_path())).unwrap_or(false)
}

pub fn run(opts: Options) -> ! {
    let Some(_lock) = win::SingleInstance::acquire("Local\\Phylotank") else {
        if !opts.background && !opts.logon {
            let _ = win::open_local_url(&view_url(current_port(), "god.html"));
        }
        std::process::exit(0)
    };
    let cfg = crate::config(&opts).unwrap_or_else(|m| crate::fail(&m));
    let port = cfg.port;

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let menu_proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |e| {
        let _ = menu_proxy.send_event(UserEvent::Menu(e));
    }));

    let menu = Menu::new();
    let status = MenuItem::new("Host: starting...", false, None);
    let open_god = MenuItem::new("Open god window", true, None);
    let open_tv = MenuItem::new("Open TV view (to cast a tab)", true, None);
    let restart = MenuItem::new("Restart host", true, None);
    let autostart = CheckMenuItem::new("Start with Windows", true, autostart_enabled(), None);
    let logs = MenuItem::new("Open log folder", true, None);
    let quit = MenuItem::new("Quit Phylotank", true, None);
    let sep = || PredefinedMenuItem::separator();
    let _ = menu.append_items(&[&status, &sep(), &open_god, &open_tv, &sep(), &restart, &autostart, &logs, &sep(), &quit]);

    let status_proxy = event_loop.create_proxy();
    let mut sup = Some(Supervisor::start(cfg, move |s| {
        let _ = status_proxy.send_event(UserEvent::Status(s.clone()));
    }));
    let mut tray: Option<TrayIcon> = None;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => {
                let mut b = TrayIconBuilder::new().with_menu(Box::new(menu.clone())).with_tooltip("Phylotank");
                if let Some(i) = icon() {
                    b = b.with_icon(i);
                }
                tray = b.build().ok();
            }
            Event::UserEvent(UserEvent::Status(s)) => {
                let line = s.describe(port);
                status.set_text(&line);
                if let Some(t) = &tray {
                    let _ = t.set_tooltip(Some(format!("Phylotank\n{line}")));
                }
            }
            Event::UserEvent(UserEvent::Menu(e)) => {
                if e.id == open_god.id() {
                    let _ = win::open_local_url(&view_url(port, "god.html"));
                } else if e.id == open_tv.id() {
                    let _ = win::open_local_url(&view_url(port, "tv.html?cast=1"));
                } else if e.id == restart.id() {
                    if let Some(s) = &sup {
                        s.restart();
                    }
                } else if e.id == autostart.id() {
                    let want = autostart.is_checked();
                    let _ = win::autostart_set(want, &cmdline::command_line(&exe_path(), &["--tray"]));
                    autostart.set_checked(autostart_enabled());
                } else if e.id == logs.id() {
                    let dir = paths::logs_dir();
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = win::shell_open(&dir.to_string_lossy());
                } else if e.id == quit.id() {
                    if let Some(s) = sup.take() {
                        s.stop();
                    }
                    tray = None;
                    *control_flow = ControlFlow::Exit;
                }
            }
            _ => {}
        }
    })
}
