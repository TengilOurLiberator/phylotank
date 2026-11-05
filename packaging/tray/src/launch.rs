//! The tray's command line, and where the Node runtime and `host.mjs` are.
//!
//! Portable layout (built by `packaging/windows/make-portable.mjs`):
//! ```text
//! Phylotank\Phylotank.exe     this tray shell
//! Phylotank\phylotank.scr     the screensaver
//! Phylotank\node\node.exe     bundled Node runtime (optional: else `node` on PATH)
//! Phylotank\web\host.mjs      the host, next to the views it serves (dist\)
//! ```
//! In a development checkout the tray also finds `dist/host.mjs` above its own directory.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Options {
    /// Started from the `Run` key at logon: wait 20 s before starting the host.
    pub logon: bool,
    /// Started by the screensaver: start the host at once, no greeting.
    pub background: bool,
    /// No tray icon: supervise in the foreground (any OS; Ctrl+C to stop).
    pub no_tray: bool,
    pub port: Option<u16>,
    pub node: Option<PathBuf>,
    pub host_script: Option<PathBuf>,
    pub delay_secs: Option<u64>,
}

pub fn parse(args: &[String]) -> Result<Options, String> {
    let mut o = Options::default();
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        let mut value = |name: &str| it.next().cloned().ok_or_else(|| format!("{name} needs a value"));
        match a.as_str() {
            "--tray" => o.logon = true,
            "--background" => o.background = true,
            "--no-tray" => o.no_tray = true,
            "--port" => o.port = Some(value("--port")?.parse().map_err(|_| "--port needs a number from 1 to 65535".to_string())?),
            "--node" => o.node = Some(PathBuf::from(value("--node")?)),
            "--host-script" => o.host_script = Some(PathBuf::from(value("--host-script")?)),
            "--delay" => o.delay_secs = Some(value("--delay")?.parse().map_err(|_| "--delay needs whole seconds".to_string())?),
            "--help" | "-h" | "/?" => return Err(USAGE.into()),
            other => return Err(format!("unknown argument {other}\n{USAGE}")),
        }
    }
    if o.port == Some(0) {
        return Err("--port needs a number from 1 to 65535".into());
    }
    Ok(o)
}

pub const USAGE: &str =
    "usage: Phylotank.exe [--tray | --background] [--no-tray] [--port N] [--node PATH] [--host-script PATH] [--delay S]";

const NODE_EXE: &str = if cfg!(windows) { "node.exe" } else { "node" };

/// Find a program on PATH.
pub fn which(name: &str, path_var: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    std::env::split_paths(path_var?).map(|d| d.join(name)).find(|p| p.is_file())
}

/// The Node runtime: `--node`, then `node\node.exe` next to the tray, then PATH.
pub fn find_node(opt: Option<&Path>, exe_dir: &Path, path_var: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    if let Some(p) = opt {
        return p.is_file().then(|| p.to_path_buf());
    }
    let bundled = exe_dir.join("node").join(NODE_EXE);
    if bundled.is_file() {
        return Some(bundled);
    }
    which(NODE_EXE, path_var)
}

/// `host.mjs`: `--host-script`, then `web\host.mjs` next to the tray, then `dist/host.mjs` in up to
/// four parent directories (a development checkout: `packaging/target/release/`).
pub fn find_host_script(opt: Option<&Path>, exe_dir: &Path) -> Option<PathBuf> {
    if let Some(p) = opt {
        return p.is_file().then(|| p.to_path_buf());
    }
    let portable = exe_dir.join("web").join("host.mjs");
    if portable.is_file() {
        return Some(portable);
    }
    exe_dir.ancestors().take(5).map(|d| d.join("dist").join("host.mjs")).find(|p| p.is_file())
}

/// Arguments for node: the script, the port, and the static folder (the script's own folder).
pub fn host_args(script: &Path, port: u16) -> Vec<String> {
    let dir = script.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_else(|| ".".into());
    vec![script.to_string_lossy().into_owned(), "--port".into(), port.to_string(), "--static".into(), dir]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        std::iter::once("Phylotank.exe").chain(a.iter().copied()).map(String::from).collect()
    }

    #[test]
    fn parses_options() {
        assert_eq!(parse(&v(&[])).unwrap(), Options::default());
        let o = parse(&v(&["--tray", "--port", "47620", "--delay", "0"])).unwrap();
        assert!(o.logon && !o.background);
        assert_eq!(o.port, Some(47620));
        assert_eq!(o.delay_secs, Some(0));
        assert!(parse(&v(&["--background"])).unwrap().background);
        assert!(parse(&v(&["--port"])).is_err());
        assert!(parse(&v(&["--port", "0"])).is_err());
        assert!(parse(&v(&["--port", "70000"])).is_err());
        assert!(parse(&v(&["--bogus"])).is_err());
    }

    #[test]
    fn finds_the_portable_layout_first() {
        let d = std::env::temp_dir().join(format!("pt-launch-{}", std::process::id()));
        std::fs::create_dir_all(d.join("node")).unwrap();
        std::fs::create_dir_all(d.join("web")).unwrap();
        std::fs::write(d.join("node").join(NODE_EXE), "").unwrap();
        std::fs::write(d.join("web").join("host.mjs"), "").unwrap();
        assert_eq!(find_node(None, &d, None), Some(d.join("node").join(NODE_EXE)));
        assert_eq!(find_host_script(None, &d), Some(d.join("web").join("host.mjs")));
        assert_eq!(find_node(Some(&d.join("missing")), &d, None), None, "an explicit path must exist");
        let args = host_args(&d.join("web").join("host.mjs"), 47615);
        assert_eq!(args[1..3], ["--port".to_string(), "47615".to_string()]);
        assert_eq!(args[4], d.join("web").to_string_lossy());
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn finds_dist_in_a_development_checkout() {
        let d = std::env::temp_dir().join(format!("pt-launch-dev-{}", std::process::id()));
        let exe_dir = d.join("packaging").join("target").join("release");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::create_dir_all(d.join("dist")).unwrap();
        std::fs::write(d.join("dist").join("host.mjs"), "").unwrap();
        assert_eq!(find_host_script(None, &exe_dir), Some(d.join("dist").join("host.mjs")));
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn which_searches_path() {
        let d = std::env::temp_dir().join(format!("pt-which-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("prog"), "").unwrap();
        let path = std::env::join_paths([std::env::temp_dir().join("nope"), d.clone()]).unwrap();
        assert_eq!(which("prog", Some(&path)), Some(d.join("prog")));
        assert_eq!(which("other", Some(&path)), None);
        std::fs::remove_dir_all(d).unwrap();
    }
}

/// The preferred port, or the next free one of the 10 after it (05 §5.2.3 step 2).
pub fn pick_port(preferred: u16, is_free: impl Fn(u16) -> bool) -> Option<u16> {
    (0..10u16).filter_map(|i| preferred.checked_add(i)).find(|p| is_free(*p))
}

/// Whether nothing is listening on `127.0.0.1:port`.
pub fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

#[cfg(test)]
mod port_tests {
    use super::*;

    #[test]
    fn picks_the_preferred_or_the_next_free_port() {
        assert_eq!(pick_port(47615, |_| true), Some(47615));
        assert_eq!(pick_port(47615, |p| p >= 47617), Some(47617));
        assert_eq!(pick_port(47615, |_| false), None);
        assert_eq!(pick_port(65535, |p| p != 65535), None, "no wrap-around past 65535");
    }

    #[test]
    fn a_bound_port_is_not_free() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        assert!(!port_is_free(port));
        drop(l);
    }
}
