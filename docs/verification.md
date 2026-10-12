# Verification record

Updated 12 October 2026. Tests use synthetic data: no real Plex sign-in, invitations, access changes or external email are performed.

## Current local checks

| Check                           | Result                                                                                                                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prettier, TypeScript and ESLint | Formatting, strict frontend/backend type checks and lint pass                                                                                                                                                                                |
| Unit/integration tests          | 73 passing tests, including malformed Plex collection envelopes, expiry retry and unconfirmed revocation readback, restriction parsing and stale-preview rejection                                                                           |
| Browser tests                   | 10 passing desktop/mobile Chromium checks cover layout, dialog accessibility, offline mutation blocking, static-only caching, restriction prefilling, before/after previews, intentional clearing and unsupported filter syntax; APIs mocked |
| Production build                | Backend compilation and frontend production build pass                                                                                                                                                                                       |
| Compiled application smoke      | File-based secrets, frontend/API, bootstrap, persisted administrator/session across a real process restart on a different port, CSRF logout and login                                                                                        |
| Compiled external worker smoke  | Signed heartbeat, forgery rejection, independent incident/delivery state across restart, unknown gaps and recovery; no external email sent                                                                                                   |
| Privacy                         | Current repository files and generated text scanned for selected patterns; synthetic screenshots inspected separately                                                                                                                        |
| Local Docker runtime            | Cannot rerun locally because no accessible Docker daemon is available; this does not negate the confirmed prior CI result below                                                                                                              |

Local checks use Node 22.20; its built-in SQLite emits an experimental warning. The Docker base is Node 24 LTS pinned by digest; CI selects Node 24. `package.json` and the smoke scripts provide repeatable commands. Unit/integration tests use a mock Plex adapter or synthetic HTTP responses and a loopback test SMTP service. Browser tests mock authenticated APIs. These are not live Plex/provider compatibility checks.

## Confirmed prior GitHub CI result

The GitHub Actions job and step summaries for **Checks run 38268022966** were inspected through the GitHub API. The job completed successfully, including dependency installation, `npm run check`, both compiled-process smoke tests, desktop/mobile browser tests, privacy checks and **`node scripts/docker-smoke.mjs linux/amd64`**. This confirms that the corrected amd64 image built and its non-root, read-only, administrator setup and persisted-restart smoke checks passed in CI.

That successful run predates the validation and restriction-editor changes in this update. It is evidence for the earlier revision, not a claim that CI has run on the new changes. The next push triggers the prepared Checks workflow. No release or registry publication is performed by that workflow.

The earlier smoke failures came from mounting a host-owned mode-0700 secret directory and retaining an ephemeral published port across restart. The script now mounts synthetic secret files individually, re-reads the published port after restart, uses bounded readiness checks and prints only safe state and fixed startup messages. Production secret files retain the documented UID-1000 ownership and mode-0400 permissions.

## Privacy scope and exception

At the owner's explicit request, `.github/CODEOWNERS` contains their public GitHub handle. This is a narrow exception to the original no-usernames rule for code ownership metadata. It does not authorise personal or infrastructure information elsewhere.

The privacy checker is heuristic: it does not detect every kind of personal information, prove the entire Git history is clean, or inspect image pixels. The current synthetic screenshots were reviewed, but no complete historical-secret or historical-screenshot audit is claimed. Runtime configuration, databases, secrets and backups must stay outside Git.

## Remaining live verification

- Use a Plex owner account and a disposable share to check real sign-in, invitations, library edits, restrictions, invitation statuses and server-specific revocation. Confirm another server's shares, friendship and Home membership remain intact.
- Test production SMTP acceptance and actual inbox delivery with controlled recipients.
- Verify a real DSM/Container Manager installation, storage ACLs, HTTPS proxy headers/trust, phone PWA installation and outage/recovery timing.
- Linux arm64 remains unverified; prepared image workflows target amd64.
- No GHCR release publication is claimed. Publishing remains a separate, manually authorised workflow.

Plex collection validation now requires the supported envelope and valid records/counts before treating absence as authoritative. Empty or malformed successful responses cannot complete a revocation expiry; the scheduler records a failure and retries within its bound. Content filters are prefilled, reviewed before replacement, checked for external changes on the backend and reconciled afterwards. Unsupported existing filter syntax is blocked from editing in this app.
