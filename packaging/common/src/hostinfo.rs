//! `host.json` (05 §5.2.3 step 2): how views and the screensaver find a running host.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub port: u16,
    #[serde(default)]
    pub pid: u32,
    /// Seconds since the Unix epoch when the tray started the host.
    #[serde(default)]
    pub started_at: u64,
    /// Reserved for the view token of 05 §5.9 (not issued in v0.1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view_token_local: Option<String>,
}

pub fn parse(text: &str) -> Option<HostInfo> {
    serde_json::from_str(text).ok()
}

pub fn read(path: &Path) -> Option<HostInfo> {
    std::fs::read_to_string(path).ok().and_then(|t| parse(&t))
}

/// Write atomically (temporary file, then rename) so a reader never sees half a file.
pub fn write(path: &Path, info: &HostInfo) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(info).map_err(io::Error::other)?)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_documented_shape_and_ignores_extra_fields() {
        let h = parse(r#"{"port":47616,"pid":42,"startedAt":1700000000,"future":true}"#).unwrap();
        assert_eq!(h, HostInfo { port: 47616, pid: 42, started_at: 1_700_000_000, view_token_local: None });
        assert_eq!(parse(r#"{"port":47615}"#).unwrap().pid, 0);
        assert!(parse("{}").is_none());
        assert!(parse("not json").is_none());
    }

    #[test]
    fn round_trips_through_a_file() {
        let dir = std::env::temp_dir().join(format!("pt-hostinfo-{}", std::process::id()));
        let p = dir.join("host.json");
        let h = HostInfo { port: 50000, pid: 7, started_at: 1, view_token_local: None };
        write(&p, &h).unwrap();
        assert_eq!(read(&p), Some(h));
        assert!(std::fs::read_to_string(&p).unwrap().contains("startedAt"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
