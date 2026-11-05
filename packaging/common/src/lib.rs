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
