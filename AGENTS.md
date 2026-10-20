# Project guidance

Read `docs/STATUS.md` first. It is the compact current handoff.
Use `docs/README.md` to choose a topic only when STATUS is insufficient. Read `docs/HANDOFF.md` only for original requirements and `docs/CLOUD.md` only for cloud work. Neither describes the current local deployment.

## Efficient context use

- For progress-only questions, use already verified conversation facts or the compact status. Do not rerun tests, inspect services, or read historical logs unless the user asks for fresh verification.
- Read source files only for the current task. Search headings or symbols before reading long files. Never load all historical status by default.
- Keep STATUS under 80 lines and about 4,500 characters: current deployment, at most three recent evidence bullets, blockers, next step, and source links. Replace stale entries; do not compress a diary into long lines. Keep detailed experiments in their existing topic document. Archive STATUS only for a substantial handoff change, not every edit.
- For voice experiments, audition one sample per candidate first. Repeat timing only after the voice passes the initial quality check. Keep real, simulated, and estimated results separate.
- Run required checks after code changes. Documentation-only changes need link/content checks, not the application test suite.

## Version preservation

- Before a behavior change or deployment, save a checkpoint with the pinned Node: `node scripts/version-checkpoint.mjs create before-<change>`. After verification/deployment, save another with a meaningful label and record its ID and validation scope in the relevant topic document.
- See `docs/VERSIONS.md` for the inventory and recovery steps. A successful checkpoint includes the current working tree, SQLite online backup, current/previous desktop artifacts, and dependency lock files. It does not prove the source and running services match or that a full restore was tested.
- Never equate a test report, Git HEAD, desktop build ID, or database backup alone with a complete project version. Preserve new/uncommitted files and keep secrets out of source archives.
- Checkpoint archives are local and ignored by Git. Do not delete archived desktop artifacts during disk cleanup. Keep credentials, desktop profile/imported models, external voice models, and off-device backups as explicit separate recovery requirements.

- This project builds a Chinese live-stream cohost with AIRI and DeepSeek.
- The product has one AIRI desktop entry. Keep shared renderer and browser test code, but do not recreate standalone web launchers or browser control pages unless the user requests them.
- The next milestone is a minimal voice trial for natural turn-taking, not full platform integration.
- Distinguish implemented behavior, simulated test results, and unverified plans.
- Keep model credentials in environment secrets. Never commit secrets or print them in logs.
- Run `npm run check` and `npm test` when changing the cohost prototype.
- Inspect the pinned AIRI repository's own guidance before changing its source.
- Do not keep the only copy of changes in ignored `vendor/airi`. Track reproducible patches or use a writable fork.
- Save decisions, test results, remaining blockers, and next steps in `docs/STATUS.md`.
- Reply to the user in Chinese unless they ask otherwise.
