//! Per-user locations (05 §5.2.1). Nothing here needs admin rights.
//!
//! `PHYLOTANK_DATA_DIR` overrides the data directory (tests, portable runs).

use std::path::PathBuf;

/// `%LOCALAPPDATA%` on Windows; `$XDG_DATA_HOME` or `~/.local/share` elsewhere.
pub fn local_app_data() -> PathBuf {
    if let Some(p) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(p);
    }
    if let Some(p) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(p);
    }
    if let Some(h) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        return PathBuf::from(h).join(".local").join("share");
    }
    std::env::temp_dir()
}

/// `%LOCALAPPDATA%\Phylotank`: worlds, logs, `host.json`, WebView2 profiles.
pub fn data_dir() -> PathBuf {
    match std::env::var_os("PHYLOTANK_DATA_DIR") {
        Some(p) => PathBuf::from(p),
        None => local_app_data().join("Phylotank"),
    }
}

/// `host.json` = `{port, pid, startedAt}`, written by the tray when it starts the host.
pub fn host_json() -> PathBuf {
    data_dir().join("host.json")
}

pub fn logs_dir() -> PathBuf {
    data_dir().join("logs")
}

/// A WebView2 user data folder; the screensaver and the tray use separate ones so they never
/// fight over the profile lock (05 §5.6.2).
pub fn webview_dir(profile: &str) -> PathBuf {
    data_dir().join("WebView2").join(profile)
}

/// Where `install.ps1` puts the portable build: `%LOCALAPPDATA%\Programs\Phylotank`.
pub fn install_dir() -> PathBuf {
    local_app_data().join("Programs").join("Phylotank")
}

/// The directory of the running executable.
pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()))
}
