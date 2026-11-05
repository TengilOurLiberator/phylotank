Phylotank {{VERSION}} for Windows (portable, unsigned)
=====================================================

An artificial-life deep-sea tank. This folder holds:

  Phylotank.exe   the tray app: runs your persistent tank (the host) in the background
  phylotank.scr   the screensaver
  web\            the views and the host (host.mjs)
  node\           the Node.js runtime, if bundled (otherwise Node 22+ must be installed)

Install for this user only (no admin rights):

  Double-click install.cmd, or in PowerShell:
    powershell -ExecutionPolicy Bypass -File .\install.ps1 [-Autostart] [-NoScreensaver] [-TimeoutMinutes 10]

It copies this folder to %LOCALAPPDATA%\Programs\Phylotank, sets Phylotank as your
screensaver, adds a Start menu shortcut and starts the tray app. -Autostart also starts it
at logon (HKCU Run key). Uninstall with uninstall.ps1 in the installed folder; your worlds
in %LOCALAPPDATA%\Phylotank stay unless you add -RemoveData.

The files are not code-signed yet, so Windows SmartScreen may warn on first start
("More info", then "Run anyway"). Full guide: docs/INSTALL.md in the repository.

Pages served by the tray's host:
  http://127.0.0.1:47615/god.html          god window
  http://127.0.0.1:47615/wallpaper.html    wallpaper view (for Lively)
  http://127.0.0.1:47615/tv.html?cast=1    TV view, to cast a Chrome tab to Google TV
