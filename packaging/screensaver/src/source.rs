//! What the screensaver shows (05 §5.6.2 as changed by review R25: never black).
//!
//! 1. The host answers on `127.0.0.1:<port>`: its `screensaver.html?monitor=<i>`, the real world.
//! 2. Otherwise the bundled standalone views (`web\` next to the `.scr`, or in the install
//!    folder), served through the `phylotank` custom protocol so the dream tank's worker loads:
//!    `http://phylotank.localhost/screensaver.html` (wry's URL form for custom protocols on Windows).
//! 3. Otherwise the built-in idle water animation (`packaging/shared/idle.js`).
//!
//! When the host was down at launch, the screensaver asks the tray to start it and switches to
//! the host's page if it answers within [`SWITCH_WINDOW`].

use std::path::PathBuf;
use std::time::Duration;

pub const PROTOCOL: &str = "phylotank";
pub const BUNDLED_ORIGIN: &str = "http://phylotank.localhost";
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(200);
/// How long after launch a host that comes up still replaces the dream tank.
pub const SWITCH_WINDOW: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Host { port: u16 },
    Bundled { dir: PathBuf },
    Idle,
}

pub fn choose(host_up: bool, port: u16, bundled: Option<PathBuf>) -> Source {
    if host_up {
        Source::Host { port }
    } else if let Some(dir) = bundled {
        Source::Bundled { dir }
    } else {
        Source::Idle
    }
}

impl Source {
    /// The URL for monitor `i`, or `None` for the idle page (loaded as HTML).
    pub fn url(&self, monitor: usize) -> Option<String> {
        match self {
            Source::Host { port } => Some(format!("http://127.0.0.1:{port}/screensaver.html?monitor={monitor}")),
            Source::Bundled { .. } => Some(format!("{BUNDLED_ORIGIN}/screensaver.html?monitor={monitor}")),
            Source::Idle => None,
        }
    }
}

/// Pages may only navigate within the host, the bundled origin and inline documents.
pub fn navigation_allowed(url: &str, port: u16) -> bool {
    let host = format!("http://127.0.0.1:{port}/");
    let bundled = format!("{BUNDLED_ORIGIN}/");
    url.starts_with(&host) || url.starts_with(&bundled) || url.starts_with("about:") || url.starts_with("data:")
}

/// The last-resort page: the shared idle water animation, inline, no network.
pub const IDLE_HTML: &str = concat!(
    "<!doctype html><html lang=\"en-GB\"><head><meta charset=\"utf-8\"><title>Phylotank</title>",
    "<style>html,body{margin:0;height:100%;overflow:hidden;background:#000;cursor:none}",
    "canvas{position:fixed;inset:0;width:100vw;height:100vh;display:block}</style></head>",
    "<body><canvas id=\"c\"></canvas><script>",
    include_str!("../../shared/idle.js"),
    "\nphylotankIdle(document.getElementById('c'));</script></body></html>"
);

/// Injected into every page: hide the cursor, and post `exit` on input (the second, independent
/// exit path next to Raw Input; same grace period and threshold as [`crate::gate`]).
pub const INIT_JS: &str = r#"(function () {
  var t0 = Date.now(), o = null;
  function exit() { try { window.ipc.postMessage('exit'); } catch (e) {} }
  addEventListener('keydown', exit, true);
  addEventListener('pointerdown', exit, true);
  addEventListener('wheel', exit, { capture: true, passive: true });
  addEventListener('pointermove', function (e) {
    if (Date.now() - t0 < 500) return;
    if (!o) { o = [e.screenX, e.screenY]; return; }
    if (Math.abs(e.screenX - o[0]) > 8 || Math.abs(e.screenY - o[1]) > 8) exit();
  }, true);
  function hide() {
    var s = document.createElement('style');
    s.textContent = '*{cursor:none !important}';
    (document.head || document.documentElement).appendChild(s);
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', hide); else hide();
})();"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_first_then_bundled_then_idle() {
        let d = PathBuf::from("C:/x/web");
        assert_eq!(choose(true, 47615, Some(d.clone())), Source::Host { port: 47615 });
        assert_eq!(choose(false, 47615, Some(d.clone())), Source::Bundled { dir: d });
        assert_eq!(choose(false, 47615, None), Source::Idle);
    }

    #[test]
    fn urls_per_monitor() {
        assert_eq!(Source::Host { port: 47616 }.url(1).unwrap(), "http://127.0.0.1:47616/screensaver.html?monitor=1");
        assert_eq!(Source::Bundled { dir: PathBuf::new() }.url(0).unwrap(), "http://phylotank.localhost/screensaver.html?monitor=0");
        assert_eq!(Source::Idle.url(0), None);
    }

    #[test]
    fn navigation_stays_local() {
        assert!(navigation_allowed("http://127.0.0.1:47615/screensaver.html", 47615));
        assert!(navigation_allowed("http://phylotank.localhost/app.js", 47615));
        assert!(navigation_allowed("about:blank", 47615));
        assert!(!navigation_allowed("http://127.0.0.1:8080/", 47615));
        assert!(!navigation_allowed("https://example.com/", 47615));
        assert!(!navigation_allowed("http://phylotank.localhost.evil.example/", 47615));
        assert!(!navigation_allowed("file:///C:/Windows/", 47615));
    }

    #[test]
    fn the_idle_page_is_self_contained() {
        assert!(IDLE_HTML.contains("function phylotankIdle"));
        assert!(IDLE_HTML.ends_with("</html>"));
        assert!(!IDLE_HTML.contains("src=\""), "no external scripts");
        assert!(!IDLE_HTML.contains("http"), "no network");
    }
}
