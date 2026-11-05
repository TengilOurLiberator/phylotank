<#
.SYNOPSIS
  Remove Phylotank for the current Windows user (no administrator rights).

.DESCRIPTION
  Stops the tray app, restores the previous screensaver if Phylotank is the current one,
  removes the Run key value and the Start menu shortcut, and deletes the install folder.
  Worlds and logs in %LOCALAPPDATA%\Phylotank are kept unless -RemoveData is given.
#>
[CmdletBinding()]
param(
  [switch]$RemoveData,
  [switch]$KeepFiles
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

# A registry value, or $null when the key or value is missing (safe under strict mode).
function Get-RegValue([string]$Path, [string]$Name) {
  $p = Get-ItemProperty -LiteralPath $Path -ErrorAction SilentlyContinue
  if ($p -and ($p.PSObject.Properties.Name -contains $Name)) { return $p.$Name }
  return $null
}

$appKey = 'HKCU:\Software\Phylotank'
$dest = (Get-RegValue $appKey 'InstallDir')
if (-not $dest) { $dest = Join-Path $env:LOCALAPPDATA 'Programs\Phylotank' }
$exe = Join-Path $dest 'Phylotank.exe'
$scr = Join-Path $dest 'phylotank.scr'

Get-Process -Name 'Phylotank', 'phylotank' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($dest, [StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Write-Host "Stopping Phylotank (pid $($_.Id))"; $_ | Stop-Process -Force; $_.WaitForExit(5000) | Out-Null }

$desktop = 'HKCU:\Control Panel\Desktop'
$current = (Get-RegValue $desktop 'SCRNSAVE.EXE')
$short = $scr
try { $short = (New-Object -ComObject Scripting.FileSystemObject).GetFile($scr).ShortPath } catch { }
if ($current -and (($current -eq $scr) -or ($current -eq $short) -or ($current -like '*phylotank.scr'))) {
  $prev = (Get-RegValue $appKey 'PreviousScreenSaver')
  if ($prev) {
    Set-ItemProperty -Path $desktop -Name 'SCRNSAVE.EXE' -Value $prev
    Write-Host "Screensaver restored to $prev"
  } else {
    Remove-ItemProperty -Path $desktop -Name 'SCRNSAVE.EXE' -ErrorAction SilentlyContinue
    Write-Host 'Screensaver cleared (none was set before Phylotank)'
  }
  Add-Type -Namespace Phylotank -Name Spi -MemberDefinition '[DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfo(uint a, uint b, System.IntPtr c, uint d);'
  [Phylotank.Spi]::SystemParametersInfo(17, [uint32][bool]$prev, [IntPtr]::Zero, 3) | Out-Null
}

$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValue = (Get-RegValue $run 'Phylotank')
if ($runValue -and $runValue.IndexOf($exe, [StringComparison]::OrdinalIgnoreCase) -ge 0) { Remove-ItemProperty -Path $run -Name 'Phylotank'; Write-Host 'Removed the start-at-logon entry' }

$lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'Phylotank.lnk'
if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force }

Remove-Item -Path $appKey -Recurse -Force -ErrorAction SilentlyContinue

if (-not $KeepFiles -and (Test-Path -LiteralPath $dest)) {
  Set-Location -LiteralPath $env:TEMP
  Remove-Item -LiteralPath $dest -Recurse -Force
  Write-Host "Removed $dest"
}

$data = Join-Path $env:LOCALAPPDATA 'Phylotank'
if ($RemoveData -and (Test-Path -LiteralPath $data)) {
  Remove-Item -LiteralPath $data -Recurse -Force
  Write-Host "Removed worlds and logs in $data"
} elseif (Test-Path -LiteralPath $data) {
  Write-Host "Kept your worlds and logs in $data (use -RemoveData to delete them)"
}
Write-Host 'Phylotank is uninstalled.'
