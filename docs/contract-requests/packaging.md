# Requests from packaging

None of these change `docs/CONTRACT.md` types; they are host and UI behaviours the wrappers rely on. Packaging works today without them (each has a fallback, noted below), so they are not blocking.

## 1. Host: `GET /health` (owner: host)

**What.** `GET /health` answers `200`, `content-type: application/json`, `cache-control: no-store`, body `{"ok": true, "tick": <number>, "worldId": <string>, "version": "<package version>"}`. No Origin check beyond the existing Host check (the Lively loader probes it from `file://` with a no-cors fetch, so the body is never read there; the tray and the screensaver read it natively).

**Why.** 05 §5.2.3 step 5 and §5.6.1 step 2 poll it. The phase-0 host answers 404 for it.

**Fallback in place.** Every probe counts any HTTP status below 500 as "up" (`packaging/common/src/probe.rs`, `packaging/lively/loader.js`), so a 404 works too. A real `/health` lets the tray show the tick and spot a hung sim.

## 2. Host: exit cleanly on stdin EOF (owner: host)

**What.** When the host's stdin reaches EOF (or a line `{"cmd":"flush"}` arrives), write a snapshot and exit with code 0 within 4 s.

**Why.** 05 §5.2.3 step 7 (shutdown). The tray starts the host with a piped stdin and, to stop it, closes stdin, waits 3 s (`Config::stop_grace`), then kills it.

**Fallback in place.** The kill. Harmless while the host keeps no state; it loses up to one autosave interval once persistence lands.

## 3. UI: honour `?monitor=` and the Lively pause message (owner: ui)

- The screensaver loads `screensaver.html?monitor=<i>`, with 0 the primary monitor (05 §5.6.2 step 3: hero shots on the primary, wide context on the others).
- The Lively loader posts `{type: 'phylotank:pause', paused: boolean}` to its iframe when Lively reports a pause (`livelyWallpaperPlaybackChanged`). The view may stop rendering on it, as it does on `visibilitychange`.
- Optional, later: post `{type: 'phylotank:ready'}` to `window.parent` after the first good frame, so the loader can tell a blocked iframe (for example a `frame-ancestors` refusal if Lively uses an origin other than `file:`) from a working one and fall back to the built-in tank.

## 4. UI: detecting the host on other ports (owner: ui, information only)

`chooseLink` streams from the host only when the page is served on port 47615, unless `?host=` names the socket. The tray moves to the next free port when 47615 is taken (05 §5.2.3 step 2), so every URL the wrappers open on another port carries `host=ws://127.0.0.1:<port>/ws/v1` (`phylotank_common::view_url`, `loader.js` `hostWallpaperUrl`). A UI change that detects "served by a host" another way would make this unnecessary, but nothing needs to change now.
