# Local AIRI performance bridge

This overlay targets the pinned AIRI commit in airi.lock.json. It supports stage-web and stage-tamagotchi.

## Restore

Install the pinned AIRI web dependencies. Start the stage with npm run dev:airi.
The startup script applies scripts/patch-airi.mjs before Vite starts.
The installer checks the base commit and preserves unrelated source changes.
It rejects edits to owned overlay files that differ from the previous installation.

The canonical source is in this directory. The installer copies it into the ignored vendor checkout.
It adds one composable call to App.vue and builds apps/cohost/stage-bridge.mjs.
The browser bundle includes existing Eventa and Valibot dependencies. Their notices are in third-party/stage-bridge.
No credentials enter the renderer or the browser bundle.

## Contract

Eventa transports commands between the control page and its AIRI iframe.
Both ends check the origin and source window. The renderer validates commands with Valibot.
Commands carry a room session, sequence, bounded action name and expiry time.
The parent rejects older HTTP responses. The renderer rejects older commands within a session.
A 1500 ms heartbeat lease releases control after a connection fails.
AIRI uses its existing normalized pose store, spring and exclusive ownership.
Saved model settings remain unchanged.

## Scope

The default Live2D model supports the tested head, eye and mouth-form poses.
Other models can expose different parameters. This bridge does not invent model-specific expression files or motion groups.
The receipt reports model readiness and the requested pose. It is not a measurement of every rendered parameter.
Only one active rehearsal page is intended. Multi-window ownership needs further testing.
Windows speech runs in the cohost backend. This bridge has no audio-driven mouth opening.

## Desktop

Run npm run setup:desktop once, then npm run dev:desktop.
scripts/patch-desktop.mjs applies the tracked desktop overlay without resetting the vendor checkout.
The main process opens a sandboxed cohost console and polls the loopback cohost API.
Eventa carries validated performance commands from main to the stage renderer.
The desktop page supplies its own model-ready state. It does not use web startup resources.
The same pose driver handles expiry and disconnect release on both surfaces.
Credentials stay in the main process. The renderer receives only the bounded performance command.
Desktop settings live in the ignored data/desktop-profile directory.
The rehearsal uses AIRI voice capture and a fixed SiliconFlow proxy. Windows recognition stays available as a separate fallback.


## Shared voice bridge

use-cohost-voice.ts belongs to stage-ui and serves both stages. patch-voice.mjs installs it and hooks Stage playback.
The pinned revision check runs in patch-airi.mjs. The overlay refuses to replace unrecorded local source edits.

One stage lease owns capture and playback. The server consumes automatic decisions and streams text through polling snapshots.
AIRI detects speech, encodes recordings, invokes its transcription adapter, and chunks speech through its existing pipeline.
The local server fixes the speech provider and keeps all API credentials in the ignored .env.

Each turn confirms completed playback segments. Failed turns cannot reopen from delayed snapshots.
Stopping a lease cancels cloud requests, playback, and capture. Raw microphone audio is not saved automatically.
The cloud receives speech segments for recognition. Use headphones for the first human trial.
