//! `Phylotank.exe`: the tray shell (05 §5.2). It starts and supervises the Node host, writes
//! `host.json`, shows a tray menu (god window, TV view for casting, restart, start with Windows,
//! logs, quit) and toggles autostart through `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
//!
//! A light tao + tray-icon shell rather than full Tauri v2: see `packaging/tray/README.md`.
//! `--no-tray` supervises in the foreground on any OS (used by the Linux tests and for debugging).
#![cfg_attr(windows, windows_subsystem = "windows")]
// restart and stop are driven by the tray menu, which exists only on Windows
#![cfg_attr(not(windows), allow(dead_code))]

mod launch;
mod supervisor;
#[cfg(windows)]
mod ui;

use phylotank_common::{paths, DEFAULT_PORT};
use std::time::Duration;
use supervisor::{Config, Supervisor};

fn fail(msg: &str) -> ! {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONWARNING, MB_OK};
        phylotank_common::win::message_box(std::ptr::null_mut(), msg, "Phylotank", MB_OK | MB_ICONWARNING);
    }
    eprintln!("{msg}");
    std::process::exit(2)
}

fn config(opts: &launch::Options) -> Result<Config, String> {
    let exe_dir = paths::exe_dir().unwrap_or_else(|| ".".into());
    let path_var = std::env::var_os("PATH");
    let node = launch::find_node(opts.node.as_deref(), &exe_dir, path_var.as_deref())
        .ok_or("Node.js was not found. Install Node.js 22 or later, or put node.exe in a \"node\" folder next to Phylotank.exe.")?;
    let script = launch::find_host_script(opts.host_script.as_deref(), &exe_dir)
        .ok_or("host.mjs was not found. Keep the \"web\" folder next to Phylotank.exe.")?;
    let preferred = opts.port.unwrap_or(DEFAULT_PORT);
    let port = launch::pick_port(preferred, launch::port_is_free)
        .ok_or_else(|| format!("Ports {preferred} to {} are all in use.", preferred.saturating_add(9)))?;
    let mut cfg = Config::new(node, launch::host_args(&script, port), port);
    cfg.initial_delay = Duration::from_secs(opts.delay_secs.unwrap_or(if opts.logon { 20 } else { 0 }));
    cfg.host_json = Some(paths::host_json());
    cfg.log = Some(paths::logs_dir().join("host.log"));
    Ok(cfg)
}

fn headless(cfg: Config) -> ! {
    let port = cfg.port;
    eprintln!("Phylotank: supervising {} {}", cfg.program.display(), cfg.args.join(" "));
    let _sup = Supervisor::start(cfg, move |s| eprintln!("{}", s.describe(port)));
    loop {
        std::thread::park();
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let opts = launch::parse(&argv).unwrap_or_else(|m| fail(&m));
    #[cfg(windows)]
    if !opts.no_tray {
        ui::run(opts);
    }
    let cfg = config(&opts).unwrap_or_else(|m| fail(&m));
    headless(cfg)
}
