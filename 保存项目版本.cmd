@echo off
cd /d "%~dp0"
"%~dp0data\toolchains\node-v26.7.0-win-x64\node.exe" "%~dp0scripts\version-checkpoint.mjs" create manual
if errorlevel 1 (
  echo Save failed. Existing checkpoints are preserved. See the error above.
) else (
  echo Version saved and verified in data\version-archives.
)
pause
