@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\local.ps1" build:desktop
if errorlevel 1 (
  echo Build failed. The previous desktop build is still selected.
) else (
  echo Build ready. Close the desktop before opening it again.
)
pause
