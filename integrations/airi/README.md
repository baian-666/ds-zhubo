# Local AIRI performance bridge

This overlay targets the pinned AIRI commit in airi.lock.json. It changes only stage-web.

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
This version has no real speech audio or audio-driven mouth opening.
