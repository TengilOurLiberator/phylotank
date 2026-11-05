# Installing Phylotank

Phylotank is one evolving deep-sea tank with several views: a calm **wallpaper** (through Lively Wallpaper), a **screensaver**, a **TV** view and a **god window**. This guide is in two parts: [for everyone](#part-1-for-everyone), and [for William's PC](#part-2-williams-full-set-up), where the persistent world runs all the time.

**Status (phase 1, November 2026).** The tank is still the phase-0 skeleton: glowing motes drifting in a current, not creatures yet. The packaging around it is real, but some of it has not been tried on real hardware: those steps are marked *unverified*. The Windows files are **not code-signed**, so Windows SmartScreen will warn the first time (review R20).

## Which download do I want?

| You want | Download (from the GitHub release) | Needs |
|---|---|---|
| To look at it in a browser, no install | `phylotank-web-<version>.zip` | any modern browser with WebGL2 |
| A live wallpaper on Windows | `phylotank-lively-<version>.zip` | [Lively Wallpaper](https://github.com/rocksdanister/lively) |
| A screensaver, and the persistent world that the wallpaper, screensaver and TV all show | `phylotank-windows-<version>.zip` | Windows 10 or 11 (64-bit) with the WebView2 runtime, which Windows 11 has and Windows 10 gets through updates |
| The tank on a Google TV | nothing extra: cast a Chrome tab | Chrome on the PC, a Google TV or Chromecast on the same network |

Releases start as drafts until William publishes them; until then, the CI run's artefacts hold the same files.

---

## Part 1: for everyone

### 1. In a browser (no install)

1. Download `phylotank-web-<version>.zip` and unzip it.
2. Serve the folder over HTTP (the sim runs in a Web Worker, which browsers do not start from a file opened by double-click). Any static server works, for example from inside the folder:
   - `npx http-server -p 8000` (Node.js), or
   - `python -m http.server 8000` (Python).
3. Open `http://127.0.0.1:8000/index.html`. Other views: `wallpaper.html`, `screensaver.html`, `tv.html`, `god.html`.

Everything runs in the page: no data leaves the browser.

### 2. Wallpaper with Lively Wallpaper (Windows)

1. Install Lively Wallpaper from the Microsoft Store or from its GitHub releases page, and start it.
2. Download `phylotank-lively-<version>.zip`. Do not unzip it.
3. In Lively, select **+** (Add wallpaper), choose **Browse** (or drag the zip onto Lively's window), and pick the zip.
4. Phylotank appears in Lively's library. Select it and choose the monitor, or "Apply to all".
5. Optional: Lively's **Customise** panel for Phylotank has two settings:
   - **Tank**: *Automatic* (default: your Phylotank host's world when the tray app runs, otherwise a built-in tank), *My host only* (calm idle water until the host answers) or *Built-in tank only*.
   - **Host port**: leave at 47615 unless you changed it.

What to expect: dark water fades in at once, the built-in tank takes over within about 2 seconds, and if the Phylotank tray app (Part 2) is running, the wallpaper switches to that world on its own. Lively pauses wallpapers while a full-screen app runs. Each monitor runs its own copy, so two 4K monitors cost twice the GPU time.

*Unverified (spike 4):* that this Lively version accepts the package's web wallpaper type, how it pauses the page, and whether WebGPU is available inside it (the tank uses WebGL2 today, so it does not need WebGPU).

### 3. Screensaver (Windows)

1. Download `phylotank-windows-<version>.zip`. Right-click it, **Extract All**.
2. In the extracted `Phylotank` folder, double-click **`install.cmd`**.
   - SmartScreen may say "Windows protected your PC": choose **More info**, then **Run anyway**. The files are unsigned, not harmful; you can check them against `SHA256SUMS.txt` on the release page.
   - It needs **no administrator rights**. It copies the folder to `%LOCALAPPDATA%\Programs\Phylotank`, sets Phylotank as *your* screensaver (10 minutes, unless you had a time set), adds a Start menu entry and starts the tray app (a glowing dot in the notification area).
3. Check it: press Win+R, type `control desk.cpl,,@screensaver`, Enter. "Phylotank" should be selected, with a small animated preview. Choose **Preview** to try it; any key, click or mouse movement ends it.
   - *Unverified:* whether this list shows a screensaver installed outside `C:\Windows\System32`. If Phylotank is missing from the list, open `%LOCALAPPDATA%\Programs\Phylotank`, right-click `phylotank.scr` and choose **Install**; if it still does not appear, it is still the active screensaver (the installer set it), only not listed.
4. Options for `install.cmd` (or `install.ps1`): `-TimeoutMinutes 5`, `-NoScreensaver`, `-Autostart` (start the tray app at logon), `-NoShortcut`, `-NoStart`.

The screensaver shows the persistent world when the tray app is running, and starts it if it is installed. Without it, it shows the built-in tank, and as a last resort calm idle water: never a black screen.

**Uninstall:** run `powershell -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\Programs\Phylotank\uninstall.ps1"`. It restores your previous screensaver and removes the start-at-logon entry, the shortcut and the program folder. Your worlds and logs in `%LOCALAPPDATA%\Phylotank` stay unless you add `-RemoveData`.

### 4. TV: cast a Chrome tab to Google TV

This works with any Chromecast or Google TV, with nothing installed on the TV.

1. Make sure the PC and the TV are on the same Wi-Fi or network.
2. In Chrome on the PC, open the TV view:
   - with the Phylotank tray app running: its menu item **Open TV view (to cast a tab)**, or `http://127.0.0.1:47615/tv.html`;
   - without it: `tv.html` from the browser-only bundle (section 1).
3. Chrome menu (three dots), **Cast, save and share**, **Cast...**. In the Cast dialog open **Sources** and pick **Cast tab**, then choose your TV.
4. Make the tab full screen on the PC (F11), so the TV gets the whole picture without browser chrome or letterboxing.
5. Leave that window open and visible: do not minimise it. A hidden page stops drawing, and the TV would freeze. Put other windows beside it or on another monitor.
6. Sound: the TV view plays its ambience by default, and Chrome sends the tab's sound to the TV.

To stop: the Cast icon in Chrome's toolbar, then **Stop casting**.

Expect some banding in dark gradients and softer glows: Chrome compresses the tab as video, and dark glowing scenes are hard for video codecs (review R21). A codec-friendly cast mode (`tv.html?cast=1`) and a sideloaded Android TV app that renders on the TV itself are planned for v0.6; see [packaging/android-tv/README.md](../packaging/android-tv/README.md). *Unverified:* whether a casting tab stops the PC's screensaver from starting (it may hold a wake lock).

---

## Part 2: William's full set-up

The goal: one persistent world running on the 5090 PC from logon, shown by the wallpaper, the screensaver and the TV, with the god window a click away.

### Step 1. Install the Windows build

1. Get `phylotank-windows-<version>.zip` from the draft release, or from the latest CI run's **phylotank-windows** artefact (Actions tab, CI workflow, newest green run on `main`).
2. Extract it, then in the `Phylotank` folder open PowerShell and run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Autostart -TimeoutMinutes 10
   ```

   `-Autostart` writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Phylotank` = `"...\Phylotank.exe" --tray`, which waits 20 seconds after logon before starting the host. Leave it out if you would rather start Phylotank by hand; you can switch it later in the tray menu (**Start with Windows**).
3. The tray app starts: a glowing dot in the notification area (it may hide under the ^ arrow; drag it out to keep it visible). Its first menu line says **Host: running on port 47615** within a few seconds.

What runs: `Phylotank.exe` (the tray shell, a few MB) starts `node\node.exe web\host.mjs` at below-normal priority, restarts it if it crashes (after 1, 5, 30, then 120 seconds), and stops trying after 5 crashes in 10 minutes ("Restart host" tries again). Data and logs: `%LOCALAPPDATA%\Phylotank` (`host.json`, `logs\host.log`).

### Step 2. The god window

Tray menu, **Open god window** (or `http://127.0.0.1:47615/god.html` in any browser). In phase 1 it only watches; powers, designer and stats arrive in v0.5.

### Step 3. The wallpaper

Add `phylotank-lively-<version>.zip` to Lively as in [section 2](#2-wallpaper-with-lively-wallpaper-windows), and leave **Tank** on *Automatic*. With the tray app running, the wallpaper shows the host's world: the same world as the screensaver and the TV. Lively starts before the tray app at logon, so for the first 20 to 30 seconds after logon the wallpaper shows the built-in tank, then switches by itself.

If port 47615 was taken by another program, the tray app moves to the next free port (the menu's status line names it): set **Host port** in Lively's Customise panel to match.

### Step 4. The screensaver

`install.ps1` already made Phylotank your screensaver. Check it as in [section 3](#3-screensaver-windows), step 3. It opens one view per monitor; the primary monitor is monitor 0.

### Step 5. The TV

Tray menu, **Open TV view (to cast a tab)**, then cast the tab as in [section 4](#4-tv-cast-a-chrome-tab-to-google-tv). The sideloaded Android TV app (better picture, rendered on the TV) is planned for v0.6.x if you agree to sideload; it needs the host's LAN mode and pairing first ("Let my TV watch" in the tray), which do not exist yet. The steps for sideloading an APK are in [packaging/android-tv/README.md](../packaging/android-tv/README.md).

### Step 6. Things to check for spikes 4 and 7

These cannot be tested without your machine, Lively and your TV. Each one changes a decision, so a note of what you see helps (a GitHub issue or a line in `docs/spikes/` is enough).

| Check | How | Why |
|---|---|---|
| Lively accepts the package | step 3 above; the wallpaper shows motes | `"Type": 1` is believed to mean "web page" but is unverified |
| Built-in tank versus host world in Lively | with the tray app quit, the wallpaper should still move after 2 s; with it running, it should switch within about 10 s | whether workers run in Lively's WebView2 |
| Lively pausing | start a full-screen game, then check Task Manager's GPU column for Lively | pause mechanism |
| Two monitors | GPU use with the wallpaper on both 4K monitors | one renderer per monitor (R24) |
| Screensaver in the list | Screen Saver Settings shows "Phylotank" | `.scr` outside System32 (R25) |
| Screensaver starts while a god window or a casting tab is open | leave each open past the timeout | wake locks (R25) |
| Screensaver exit | press a key: it should vanish at once; a small nudge of the mouse should not end it | 100 ms exit, 8 px threshold |
| TV picture | cast `tv.html`, look at dark areas for banding | spike 7, route choice |

### Updating

Quit Phylotank from the tray, extract the new zip, run `install.ps1` again (with the same options). It replaces the program files and keeps your worlds and settings. For Lively, add the new zip; Lively replaces the old copy or lists both (delete the old one).

### Troubleshooting

| Symptom | Fix |
|---|---|
| The tray says "Node.js was not found" | the zip bundles `node\node.exe`; if it is missing, install Node.js 22 or later |
| The tray says the host stopped after 5 crashes | tray menu, **Open log folder**, read `host.log`; then **Restart host** |
| The wallpaper is black | Lively's Customise panel, set **Tank** to *Built-in tank only*. If it is still black, the WebView cannot run WebGL2: update the graphics driver and the WebView2 runtime |
| The wallpaper shows the built-in tank although the tray app runs | check the tray's status line for the port and set the same **Host port** in Lively |
| The screensaver never starts | an app or a browser tab may hold a wake lock: run `powercfg /requests` in an administrator terminal to see which |
| SmartScreen blocks `install.cmd` or `Phylotank.exe` | **More info**, **Run anyway** (unsigned builds, review R20); `install.ps1` removes the download mark from the installed files so it asks only once |
| `install.ps1` is blocked by the execution policy | run it through `install.cmd`, or with `powershell -ExecutionPolicy Bypass -File .\install.ps1` |

---

## Building from source

Requires Node.js 22 or later; for the Windows wrappers, Rust stable (on Windows with the MSVC toolchain).

```sh
npm ci
npm test                 # unit, contract, determinism, boundary, host and packaging tests
npm run build            # dist/
npm run host             # the host on http://127.0.0.1:47615/
node packaging/lively/build-zip.mjs                 # packaging/out/phylotank-lively-<version>.zip
cd packaging && cargo test && cargo build --release  # phylotank-scr.exe and phylotank-tray.exe (on Windows)
node packaging/windows/make-portable.mjs --bin packaging/target/release --node "C:\Program Files\nodejs\node.exe"
```

From Linux, `cargo clippy --workspace --target x86_64-pc-windows-gnu` (after `rustup target add x86_64-pc-windows-gnu`) type-checks the Windows code without building it. CI does all of this on every push (`.github/workflows/ci.yml`), and `release.yml` drafts a GitHub release for every `v*` tag.
