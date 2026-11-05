# packaging/

Platform wrappers around the built views in `dist/`. Nothing here is part of the sim; each wrapper only opens a page served by the host, or the bundled standalone dream tank. Design notes: [docs/modules/packaging.md](../docs/modules/packaging.md). User guide: [docs/INSTALL.md](../docs/INSTALL.md).

| Directory | Target | Status |
|---|---|---|
| `lively/` | Lively Wallpaper web wallpaper | loader (host first, dream-tank fallback), zip builder, `file://` check; Lively itself unverified (spike 4) |
| `screensaver/` | `phylotank.scr` (Rust, wry and tao, WebView2) | `/s` `/p` `/c`, Raw Input exit, host page then bundled views then idle; type-checks for Windows here, built in CI |
| `tray/` | `Phylotank.exe` tray shell (Rust, tao and tray-icon) | supervises the Node host, `host.json`, logs, HKCU Run autostart toggle; built in CI |
| `common/` | shared Rust crate | health probe, restart policy, static file resolver, Win32 helpers |
| `windows/` | portable zip, `install.ps1`, `uninstall.ps1` | per-user, no admin rights |
| `android-tv/` | Google TV notes | tab casting documented; app not started (v0.6) |
| `shared/` | `idle.js` animation, `zip.mjs` | used by the Lively package and the screensaver |

Build everything (outputs in `packaging/out/`, ignored by git):

```sh
npm run build                                         # dist/
node packaging/lively/build-zip.mjs                   # phylotank-lively-<v>.zip
NODE_PATH=$(npm root -g) node packaging/lively/check-package.cjs   # headless check of the zip from file://
cd packaging && cargo test                            # host-agnostic Rust tests (any OS)
cargo clippy --workspace --target x86_64-pc-windows-gnu           # Windows code, from Linux
cargo build --release                                 # on Windows: target/release/phylotank-scr.exe, phylotank-tray.exe
node packaging/windows/make-portable.mjs --bin packaging/target/release --node "C:\path\to\node.exe"
```

v0.1 ships to William only as a portable zip (review R20): no installer, no signing, autostart opt-in only, no LAN binding.
