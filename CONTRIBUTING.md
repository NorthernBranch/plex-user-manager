# Contributing

Use synthetic accounts, library titles, addresses and server identities in every public artifact. Never include real tokens, infrastructure, screenshots, logs or runtime configuration in issues, pull requests or commits.

At the repository owner's explicit request, `.github/CODEOWNERS` includes their public GitHub handle. This is a narrow exception for code ownership metadata; it does not permit personal or installation details elsewhere. The privacy script checks selected patterns, not every kind of personal information, historical commits or binary images. Review those separately before publishing.

Use Node 24 LTS, `npm ci`, then `npm run check`. Prettier is installed and required: use `npm run format` before submitting. `npm run test:browser` needs Chromium (`npx playwright install chromium`). `npm run privacy` checks repository files and build output without printing matched values. Inspect screenshots manually as well. A package-manager peer-resolution workaround is recorded in `.npmrc`; `npm ci` uses that same resolver reproducibly.

Backend modules isolate authentication, secrets/storage, Plex integration, access reconciliation, monitoring and email. Keep network calls inside adapters. Validate incoming and remote data, never log remote response bodies or credentials, and preserve per-server access boundaries. Add tests for state transitions and meaningful failure cases. Do not write tests that contact a real Plex account or SMTP recipient.

Change schema using ordered transactional migrations in `server/store.ts`. Do not edit an already released migration. Document backup and rollback requirements for each schema change. Run `node scripts/docker-smoke.mjs linux/amd64` where Docker is available; containers must remain non-root, without privileges or Docker socket access.

The release workflow is manual. Running it publishes an image; do so only with repository-owner authorisation. Image names derive from GitHub context. The normal checks workflow builds and smoke-tests without publishing.
