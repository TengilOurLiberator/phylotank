# Android TV notes

Three candidate routes (DESIGN Q11, review R21), decided by spike 7 on William's Google TV:

1. **Tab casting** from Chrome (v0.6 default): no install, but dark gradients and pinpoint glows suffer under the video codec.
2. **Sideloaded WebView app** (Kotlin): loads `http://<pc>:47615/tv.html` after pairing (05 §5.9: 6-digit code, view-only token, LAN binding only while "Let my TV watch" is on) and renders locally with WebGL2 at the TV profile.
3. **Host-encoded video**: the host encodes the TV view with NVENC as 10-bit HEVC or AV1 and a small app plays it (unverified that the Chromecast with Google TV HD decodes AV1 in this path).

Measure on the device: frame time of route 2 at the TV profile, banding on a slow dark-glow test scene for all three, and bitrate (median at most 2.8 Mbps, never above 8 Mbps for route 2).
