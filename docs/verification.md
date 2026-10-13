# Verification record

Updated 13 October 2026 for the 0.2.0 library-count validation and API response-handling fixes. Automated checks use synthetic data only; no real Plex sign-in, invitations, access changes or external email are performed by those checks.

## Local verification

| Check                        | Result and scope                                                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prettier, TypeScript, ESLint | Required formatting, strict frontend/backend type checks and lint                                                                                                                                                                                                                          |
| Unit/integration suite       | 134 tests covering access/auth/monitoring, schema preservation/rollback, communications/expiry persistence and SMTP ambiguity, plus library-count semantics, authenticated Users routing through synthetic adapter responses, HTML gateway errors, redirects and mutation retry prevention |
| Browser suite                | 18 desktop/mobile Chromium checks: layout, dialog/access editor, restriction preview/prefill, offline mutation blocking, static-only caching, Communications navigation, scanner-safe fragments, HTML gateway errors and API redirects; authenticated APIs are mocked                      |
| Production build             | Compiled backend and React frontend                                                                                                                                                                                                                                                        |
| Compiled app smoke           | One-origin frontend/API, file secrets, bootstrap/session persistence across a real process restart, CSRF/logout and no-store                                                                                                                                                               |
| Compiled worker smoke        | Signed heartbeat/forgery rejection, independent persisted incidents/queue, restart gaps and recovery without contacting the NAS; SMTP targets a closed loopback port                                                                                                                       |
| Test SMTP                    | Loopback SMTP service confirms individual outage and announcement envelopes, isolated recipients and queue acceptance; no real recipients                                                                                                                                                  |
| Privacy                      | Current repository files and generated text checked; synthetic desktop/mobile screenshots inspected separately                                                                                                                                                                             |
| Local Docker smoke           | Blocked: Docker CLI exists but the local Linux engine pipe is unavailable. No local container execution is claimed                                                                                                                                                                         |

See `package.json` for repeatable commands: `npm run check`, `npm run test:browser`, `npm run privacy`, and the compiled-process/Docker smoke scripts. The pinned Node 24 LTS Docker image and lockfile remain unchanged except the application version. Local execution uses Node 22.20, whose built-in SQLite emits an experimental warning; CI uses Node 24.

Clock-sensitive tests use injected timestamps and a fake Date clock. Plex integration uses a mock adapter or synthetic HTTP responses, including fail-closed collection validation and malformed revocation readback. The file-backed communications test closes/reopens SQLite with the same key and resumes running dispatch/interrupted SMTP work without an extra logical queue entry. These tests are not live Plex or provider compatibility evidence.

## GitHub CI and image verification

The Checks workflow runs dependency installation, formatting/types/lint/tests/build, both compiled-process smoke tests, desktop/mobile browser tests, privacy checks and `node scripts/docker-smoke.mjs linux/amd64` on each push/PR. It does not publish images or releases. For a deployment, inspect the completed **Checks run attached to the exact source commit**; a passing older run is not verification of a newer image.

The amd64 Docker smoke checks the non-root/read-only container, synthetic file secrets, bootstrap and persisted restart. Current job status and commit attribution remain in GitHub Actions rather than a permanently cached “latest CI” claim in documentation. A passing run for an earlier revision does not verify this response-handling update.

Separate manual checks on a private installation exercised owner PIN sign-in,
owned-server selection, backend Plex identity probes, HTTPS, an administrator-only
forward-auth policy, and consistent SQLite backup/key validation. Those checks
are limited to that installation; they do not validate access mutations or every
Plex account response. A read-only diagnosis identified a library validation
failure: the outer library count was compared with the number of server wrappers.
The correction is covered by synthetic adapter and authenticated route tests;
live verification of the deployed correction is still pending.

## Privacy scope

The owner explicitly requested their public GitHub handle in `.github/CODEOWNERS`; that is a narrow code-ownership metadata exception. It permits no other personal or infrastructure details. Runtime `.env`, secrets, databases, backups and configuration stay outside Git. Link tokens are hashed in their token table; private queue bodies are encrypted and omitted from API history. New documentation and fixtures use synthetic identities and generic placeholders.

The privacy checker is heuristic and does not cover every personal identifier, the entire Git history or image pixels. Current synthetic screenshots are reviewed separately. No complete historical secret/screenshot audit is claimed.

## Remaining live verification and limitations

- Recheck owner sign-in and server selection for each installation. Use a disposable share to verify real user/invitation response shapes, permission changes, restrictions and selected-server revocation. Confirm other shares, friendships and Home membership remain intact.
- Real Plex invite IDs may change at acceptance. Automatic welcome requires identical observed stable account/share IDs; existing/changed-ID/managed cases use explicit manual welcome. No name/email matching or fabricated acceptance is used.
- Verify production SMTP acceptance and actual inbox arrival using controlled recipients, including HTTPS recipient links. SMTP cannot guarantee exactly-once delivery after ambiguous acceptance/crash, despite stable Message-IDs.
- Container startup, protected secret files, HTTPS and proxy trust were checked on one private installation. Other DSM versions/ACLs, phone installation and real outage timing remain unverified.
- External windows/recipients/preferences are manually provisioned in advance. Signed acknowledgements compare only those settings; mismatched/stale/missing acknowledgements are not treated as a current match. Apply NAS opt-outs on the worker too. Whole-NAS outage notification remains independent of NAS availability.
- Linux arm64 is unverified. No registry image/release publication or external deployment is claimed. Build the current amd64 source or explicitly authorise the prepared release workflow.

See [communications](communications.md), [upgrade/restore](operations.md) and [Synology installation](synology.md) for configuration and safe validation steps.
