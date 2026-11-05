<#
.SYNOPSIS
  Install Phylotank for the current Windows user. Needs no administrator rights.

.DESCRIPTION
  Copies the portable folder to %LOCALAPPDATA%\Programs\Phylotank (or -Destination), removes
  the downloaded-file mark so SmartScreen asks once rather than every time, sets phylotank.scr
  as the current user's screensaver (HKCU\Control Panel\Desktop\SCRNSAVE.EXE), adds a Start
  menu shortcut, optionally adds the HKCU Run key, and starts the tray app.
  Everything is per-user; nothing is written to Program Files, System32 or HKLM.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Autostart -TimeoutMinutes 10
#>
[CmdletBinding()]
param(
  [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Programs\Phylotank'),
  # Do not make Phylotank the screensaver.
  [switch]$NoScreensaver,
  # Screensaver wait in minutes; 0 keeps the current setting (or 10 if none is set).
  [int]$TimeoutMinutes = 0,
  # Start the tray app at logon (HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Phylotank).
  [switch]$Autostart,
  [switch]$NoShortcut,
  # Do not start the tray app after installing.
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

# A registry value, or $null when the key or value is missing (safe under strict mode).
function Get-RegValue([string]$Path, [string]$Name) {
  $p = Get-ItemProperty -LiteralPath $Path -ErrorAction SilentlyContinue
  if ($p -and ($p.PSObject.Properties.Name -contains $Name)) { return $p.$Name }
  return $null
}

$src = $PSScriptRoot
foreach ($f in 'Phylotank.exe', 'phylotank.scr', 'web\host.mjs', 'web\screensaver.html') {
  if (-not (Test-Path -LiteralPath (Join-Path $src $f))) { throw "Missing $f next to install.ps1. Unpack the whole zip first." }
}
$hasNode = (Test-Path -LiteralPath (Join-Path $src 'node\node.exe')) -or [bool](Get-Command node.exe -ErrorAction SilentlyContinue)
if (-not $hasNode) { Write-Warning 'Node.js was not found and this build does not bundle it. Install Node.js 22 or later (per-user installs work), or the host will not start.' }

$dest = [System.IO.Path]::GetFullPath($Destination)
$exe = Join-Path $dest 'Phylotank.exe'
$scr = Join-Path $dest 'phylotank.scr'

# Stop a running copy so its files can be replaced.
Get-Process -Name 'Phylotank', 'phylotank' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($dest, [StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Write-Host "Stopping running Phylotank (pid $($_.Id))"; $_ | Stop-Process -Force; $_.WaitForExit(5000) | Out-Null }

if ([System.IO.Path]::GetFullPath($src).TrimEnd('\') -ne $dest.TrimEnd('\')) {
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Write-Host "Copying to $dest"
  Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force
}
# Files from a downloaded zip carry the Mark of the Web; remove it from our own files only.
Get-ChildItem -LiteralPath $dest -Recurse -File | Unblock-File

$appKey = 'HKCU:\Software\Phylotank'
New-Item -Path $appKey -Force | Out-Null
Set-ItemProperty -Path $appKey -Name 'InstallDir' -Value $dest

if (-not $NoScreensaver) {
  $desktop = 'HKCU:\Control Panel\Desktop'
  $current = (Get-RegValue $desktop 'SCRNSAVE.EXE')
  # Windows wants a path without spaces here on some versions: use the 8.3 short path if there is one.
  $short = $scr
  try { $short = (New-Object -ComObject Scripting.FileSystemObject).GetFile($scr).ShortPath } catch { }
  if ($current -and ($current -ne $short) -and ($current -ne $scr) -and -not (Get-RegValue $appKey 'PreviousScreenSaver')) {
    Set-ItemProperty -Path $appKey -Name 'PreviousScreenSaver' -Value $current
  }
  Set-ItemProperty -Path $desktop -Name 'SCRNSAVE.EXE' -Value $short
  Set-ItemProperty -Path $desktop -Name 'ScreenSaveActive' -Value '1'
  $timeout = (Get-RegValue $desktop 'ScreenSaveTimeOut')
  if ($TimeoutMinutes -gt 0) { Set-ItemProperty -Path $desktop -Name 'ScreenSaveTimeOut' -Value ([string]($TimeoutMinutes * 60)) }
  elseif (-not $timeout) { Set-ItemProperty -Path $desktop -Name 'ScreenSaveTimeOut' -Value '600' }
  # Tell Windows the setting changed (SPI_SETSCREENSAVEACTIVE, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE).
  Add-Type -Namespace Phylotank -Name Spi -MemberDefinition '[DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfo(uint a, uint b, System.IntPtr c, uint d);'
  [Phylotank.Spi]::SystemParametersInfo(17, 1, [IntPtr]::Zero, 3) | Out-Null
  Write-Host "Screensaver set to $short"
  Write-Host '  If Screen Saver Settings does not list it, right-click phylotank.scr and choose Install (unverified on this Windows build: spike 4).'
}

if (-not $NoShortcut) {
  $lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'Phylotank.lnk'
  $sh = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $sh.TargetPath = $exe
  $sh.WorkingDirectory = $dest
  $sh.Description = 'Phylotank: your evolving deep-sea tank'
  $sh.Save()
  Write-Host "Start menu shortcut: $lnk"
}

$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if ($Autostart) {
  Set-ItemProperty -Path $run -Name 'Phylotank' -Value ('"' + $exe + '" --tray')
  Write-Host 'Phylotank will start at logon (turn this off from the tray menu: Start with Windows).'
}

if (-not $NoStart) {
  Start-Process -FilePath $exe -WorkingDirectory $dest
  Write-Host 'Phylotank is starting: look for the glowing dot in the notification area.'
}

Write-Host ''
Write-Host 'Installed. Next steps (docs\INSTALL.md has the details):'
Write-Host '  - Wallpaper: in Lively Wallpaper, add phylotank-lively-*.zip (it shows this tank while the tray app runs).'
Write-Host '  - Screensaver settings: control desk.cpl,,@screensaver'
Write-Host '  - God window: http://127.0.0.1:47615/god.html'
