# packaging/

Platform wrappers around the built views in `dist/`. Nothing here is part of the sim; each wrapper only opens a page served by the host (or the standalone dream tank).

| Directory | Target | Status |
|---|---|---|
| `lively/` | Lively Wallpaper web wallpaper (`wallpaper.html`) | metadata draft; spike 4 verifies the type flag, pause behaviour and iframe versus direct loading (review R24) |
| `screensaver/` | `phylotank.scr` (Rust plus wry WebView2) | argument-parser skeleton; not built in CI yet (review R25) |
| `android-tv/` | Android TV WebView wrapper | notes only; route decided by spike 7 (review R21, DESIGN Q11) |

v0.1 ships to William only as a portable zip with a start-up shortcut (review R20): no installer, no autostart key, no LAN binding, no signing yet.
