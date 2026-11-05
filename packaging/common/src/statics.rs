//! Serving the bundled standalone views (the dream tank) to a WebView through a custom
//! protocol, so the page has a real origin and its Web Worker loads (from `file://` it does
//! not: measured in `docs/spikes/packaging-4.md`). Path handling is strict: no `..`, no
//! backslashes, no drive letters, no hidden files.

use std::path::{Path, PathBuf};

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Decode `%XX` escapes; rejects malformed escapes, NUL and invalid UTF-8.
pub fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let v = hex(*b.get(i + 1)?)? * 16 + hex(*b.get(i + 2)?)?;
            out.push(v);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    if out.contains(&0) {
        return None;
    }
    String::from_utf8(out).ok()
}

/// Map a URL path (query and fragment allowed) to a file under `root`, or `None`.
pub fn resolve(root: &Path, url_path: &str) -> Option<PathBuf> {
    let p = url_path.split(['?', '#']).next().unwrap_or("");
    let p = percent_decode(p)?;
    let rel = p.strip_prefix('/').unwrap_or(&p);
    let rel = if rel.is_empty() { "index.html" } else { rel };
    let mut out = root.to_path_buf();
    for seg in rel.split('/') {
        if seg.is_empty() || seg.starts_with('.') || seg.contains(['\\', ':', '*', '?', '"', '<', '>', '|']) {
            return None;
        }
        out.push(seg);
    }
    out.is_file().then_some(out)
}

pub fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("map") => "application/json",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("wasm") => "application/wasm",
        Some("ico") => "image/x-icon",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// The folder of bundled standalone views to use, if any: `<exe dir>\web`, then the install
/// directory's `web` (for a `.scr` copied to System32). A folder counts only if it has the
/// screensaver page, the app bundle and the sim worker.
pub fn bundled_web_dir(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|d| ["screensaver.html", "app.js", "sim-worker.js"].iter().all(|f| d.join(f).is_file())).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> PathBuf {
        let d = std::env::temp_dir().join(format!("pt-statics-{}-{:?}", std::process::id(), std::thread::current().id()));
        std::fs::create_dir_all(d.join("sub")).unwrap();
        for f in ["index.html", "screensaver.html", "app.js", "sim-worker.js", "sub/a b.js", ".secret"] {
            std::fs::write(d.join(f), "x").unwrap();
        }
        d
    }

    #[test]
    fn resolves_plain_paths_with_queries() {
        let d = tree();
        assert_eq!(resolve(&d, "/screensaver.html?monitor=1"), Some(d.join("screensaver.html")));
        assert_eq!(resolve(&d, "/"), Some(d.join("index.html")));
        assert_eq!(resolve(&d, "/sub/a%20b.js#x"), Some(d.join("sub").join("a b.js")));
        assert_eq!(resolve(&d, "/missing.js"), None);
        assert_eq!(resolve(&d, "/sub"), None, "directories are not files");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn refuses_traversal_and_odd_names() {
        let d = tree();
        for bad in [
            "/../etc/passwd",
            "/sub/../app.js",
            "/%2e%2e/x",
            "/sub\\..\\app.js",
            "/C:/Windows/win.ini",
            "//app.js",
            "/.secret",
            "/app.js%00",
            "/%zz",
        ] {
            assert_eq!(resolve(&d, bad), None, "{bad}");
        }
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn mime_types() {
        assert_eq!(mime(Path::new("a.HTML")), "text/html; charset=utf-8");
        assert_eq!(mime(Path::new("sim-worker.js")), "text/javascript; charset=utf-8");
        assert_eq!(mime(Path::new("x.bin")), "application/octet-stream");
    }

    #[test]
    fn bundled_dir_needs_the_three_files() {
        let d = tree();
        let empty = std::env::temp_dir().join("pt-statics-none-here");
        assert_eq!(bundled_web_dir(&[empty.clone(), d.clone()]), Some(d.clone()));
        assert_eq!(bundled_web_dir(&[empty]), None);
        std::fs::remove_dir_all(d).unwrap();
    }
}
