# Cohost contracts

Shared boundary definitions for the local cohost runtime and AIRI overlays.

- `speech.ts`: effective speech configuration and supported providers.
- `status.ts`: validated, read-only status events and replica revision rules.

The backend imports these files with Node's TypeScript stripping. Overlay scripts copy them into AIRI so both consumers use the same source. Keep UI imports, provider secrets, model calls, and avatar implementation details out of this package. Eventa and Valibot versions match the pinned AIRI checkout.

Status is a view of the running session, not a command queue or persistent model memory. Reconnect from a snapshot; never infer missing events or replay voice actions from this channel.
