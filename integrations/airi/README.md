# AIRI desktop integration

The project supports the Electron desktop app at the AIRI commit in `airi.lock.json`.
The standalone web launcher and browser console have been removed.

## Setup and replay

Get the pinned source with `scripts/local.ps1 setup:airi`.
Install desktop dependencies with `scripts/local.ps1 setup:desktop`, then run `build:desktop`.
Use `启动小鲸鱼.cmd` for daily use. Use `dev:desktop` for source debugging.

This directory holds the canonical overlays. `scripts/patch-desktop.mjs` applies the shared and desktop patches.
Owned files must match the previous overlay before replacement. The scripts preserve unrelated upstream edits.
Shared patches still prepare some upstream web files used by the original AIRI workspace. They do not launch a web app.
The desktop build no longer generates the removed browser parent bridge.

## Runtime

The main process, renderer, and backend exchange bounded Eventa commands and shared status updates.
One media owner controls capture and playback. Playback follows the actual audio clock and releases on interruption.
The desktop keeps its existing `localhost:5174` origin and `data/desktop-profile` data.
Settings, character cards, speech configuration, and session data use the backend repositories.
Credentials stay in the local environment. They do not enter renderer bundles or Git archives.

## Shared code and checks

Vue components, speech pipelines, pose control, and browser-based regression fixtures remain shared AIRI code.
A browser test does not imply a supported standalone web product.
Check the pinned upstream guide before changing its source. Keep reproducible changes here and in `scripts/patch-*.mjs`.

Run the relevant checks described in [AIRI checks](../../docs/AIRI-CHECKS.md).
Current deployment and test boundaries are in [STATUS](../../docs/STATUS.md).
Version recovery is in [VERSIONS](../../docs/VERSIONS.md).
