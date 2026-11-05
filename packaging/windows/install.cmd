@echo off
rem Install Phylotank for this Windows user (no admin rights). Options are passed on to
rem install.ps1, for example:  install.cmd -Autostart   or   install.cmd -NoScreensaver
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 pause
