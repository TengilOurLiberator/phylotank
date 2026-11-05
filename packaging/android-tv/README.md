# Google TV and Android TV

Three candidate routes (DESIGN Q11 default: tab casting in v0.6, the app as v0.6.x if William agrees to sideload; review R21). Spike 7 decides on William's Google TV; it has not run (no TV here).

| Route | Install on the TV | Picture | Status |
|---|---|---|---|
| A. Cast a Chrome tab from the PC | nothing | video-coded by Chrome: dark gradients and pinpoint glows suffer | **works today** (steps in [docs/INSTALL.md](../../docs/INSTALL.md#4-tv-cast-a-chrome-tab-to-google-tv)) |
| B1. Sideloaded TV browser opens `http://<pc>:47615/tv.html` | a browser APK | rendered on the TV | blocked: the host binds `127.0.0.1` only and refuses other `Host` headers until LAN serving and pairing land (05 §5.9, v0.6) |
| B2. Sideloaded Phylotank TV app (Kotlin WebView) | `phylotank-tv.apk` | rendered on the TV with WebGL2, TV profile | not started (plan below) |
| C. Host-encoded video (NVENC, 10-bit HEVC or AV1) played by a small app | an APK | best gradients, costs the TV nothing | idea only; unverified that the Chromecast HD decodes AV1 in this path |

## The TV-mode URL

- Served by the host: `http://127.0.0.1:47615/tv.html`. The tray's "Open TV view (to cast a tab)" opens `tv.html?cast=1`. Without a host, `tv.html` from the browser-only bundle or `npm run dev` runs the dream tank.
- The TV profile (CONTRACT 15, `VIEW_PROFILES.tv`): director camera, captions held 6 s and at least 25 s apart, audio on by default, 30 fps cap.
- `?cast=1` is reserved for the codec-friendly cast sub-profile of 05 §5.6.3 (fixed 1920 x 1080 at 30 fps, glows 1.5x larger, about half the dust, 1 to 2 LSB of animated dither, no trails under 2 px). The renderer does not read it yet; today it is ignored.
- `?host=ws://<host>:<port>/ws/v1` forces the host stream; `?sim=worker` forces the dream tank.

## Route B2: the sideloaded app (v0.6.x plan)

About 300 lines of Kotlin in `apps/tv-android` (05 §5.6.3). Nothing is written yet.

- One fullscreen `Activity` with a `WebView`: `javaScriptEnabled`, `domStorageEnabled`, `mediaPlaybackRequiresUserGesture = false` (so audio starts), hardware acceleration on, `FLAG_KEEP_SCREEN_ON` while the tank shows.
- Manifest: `android.intent.category.LEANBACK_LAUNCHER`, a 320 x 180 banner, `uses-feature android.software.leanback` and `android.hardware.touchscreen required="false"`. Android 9 and later block cleartext HTTP by default, so a network security config allows cleartext to private LAN addresses only (the host speaks plain HTTP on the LAN; a view token is low-value, 05 §5.9).
- Finds the host by mDNS (`_phylotank._tcp`), shows the 6-digit pairing code, stores the per-device view token; never god scope.
- D-pad and media keys map to the overlay: next shot, follow, audio on or off.
- Limits from 05 §5.6.3 for the Chromecast with Google TV HD (Mali-G31 MP2, 1.5 GB): WebGL2 only, at most 800 bodies and 15k dust, 1280 x 720 internal, bloom at quarter resolution, 30 fps, under 400 MB; step down if frame time stays above 40 ms for 5 s.

### Sideloading an APK (once there is one)

1. On the TV: Settings, System, About, then select "Android TV OS build" seven times to turn on developer options.
2. Settings, System, Developer options: turn on USB debugging (Chromecast with Google TV) or Wireless debugging (newer Google TV devices, which pair with a code).
3. On the PC, with Android platform tools: `adb connect <tv-ip>:5555` (for wireless debugging, `adb pair <tv-ip>:<pairing-port>` first), accept the prompt on the TV, then `adb install -r phylotank-tv.apk`.
4. Without a PC: install the "Downloader" app from the Play Store, allow it under Settings, Apps, Security and restrictions, Unknown sources, and open the APK's URL in it.
5. The app appears in the TV's apps row. Turn developer options off again afterwards if you like.

The menu names above are from memory of Google TV builds and may differ slightly by device and version.

## Spike 7 measurements still owed (render with packaging)

On the TV itself: frame time of route B2 at the TV profile; banding on a slow dark-glow test scene for routes A, B2 and, if possible, C side by side; bitrate (median at most 2.8 Mbps, never above 8 Mbps for route B); whether a casting Chrome tab keeps rendering when its window is covered, and whether it holds a wake lock that stops the PC's screensaver (R25).
