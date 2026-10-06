# Project guidance

Read `docs/HANDOFF.md`, `docs/STATUS.md`, and `docs/CLOUD.md` before continuing work.

- This project builds a Chinese live-stream cohost with AIRI and DeepSeek.
- The next milestone is a minimal voice trial for natural turn-taking, not full platform integration.
- Distinguish implemented behavior, simulated test results, and unverified plans.
- Keep model credentials in environment secrets. Never commit secrets or print them in logs.
- Run `npm run check` and `npm test` when changing the cohost prototype.
- Inspect the pinned AIRI repository's own guidance before changing its source.
- Do not keep the only copy of changes in ignored `vendor/airi`. Track reproducible patches or use a writable fork.
- Save decisions, test results, remaining blockers, and next steps in `docs/STATUS.md`.
- Reply to the user in Chinese unless they ask otherwise.
