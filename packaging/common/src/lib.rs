//! Code shared by the Phylotank screensaver (`phylotank.scr`) and the tray shell (`Phylotank.exe`).
//!
//! Everything here except [`win`] is host-agnostic, so `cargo test` exercises it on Linux CI:
//! where the host lives ([`paths`], [`hostinfo`]), whether it answers ([`probe`]), how the tray
//! restarts it ([`policy`]), how the bundled standalone views are served ([`statics`]) and how a
//! `Run` key command line is quoted ([`cmdline`]).

pub mod cmdline;
pub mod hostinfo;
pub mod paths;
pub mod policy;
pub mod probe;
pub mod statics;
#[cfg(windows)]
pub mod win;

/// The host's default loopback port (CONTRACT `HOST_PORT`; its IANA status is unverified).
pub const DEFAULT_PORT: u16 = 47615;

/// The port to use: the one in `host.json` when the tray wrote one, else the default.
pub fn current_port() -> u16 {
    hostinfo::read(&paths::host_json()).map(|h| h.port).filter(|p| *p != 0).unwrap_or(DEFAULT_PORT)
}

/// A view page on the loopback host, e.g. `view_url(47615, "tv.html?cast=1")`.
///
/// The view shell streams from the host only when it is served on the default port unless
/// `?host=` names the socket (`src/ui` `chooseLink`), so other ports get an explicit `host=`.
pub fn view_url(port: u16, page: &str) -> String {
    let base = format!("http://127.0.0.1:{port}/{page}");
    if port == DEFAULT_PORT {
        return base;
    }
    let sep = if page.contains('?') { '&' } else { '?' };
    format!("{base}{sep}host=ws%3A%2F%2F127.0.0.1%3A{port}%2Fws%2Fv1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_urls_name_the_socket_only_off_the_default_port() {
        assert_eq!(view_url(47615, "god.html"), "http://127.0.0.1:47615/god.html");
        assert_eq!(view_url(47616, "god.html"), "http://127.0.0.1:47616/god.html?host=ws%3A%2F%2F127.0.0.1%3A47616%2Fws%2Fv1");
        assert_eq!(view_url(47617, "tv.html?cast=1"), "http://127.0.0.1:47617/tv.html?cast=1&host=ws%3A%2F%2F127.0.0.1%3A47617%2Fws%2Fv1");
    }
}
