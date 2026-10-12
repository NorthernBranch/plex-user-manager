# Backups, upgrades, restore and troubleshooting

## Consistent backups

SQLite uses WAL. Do not copy just a live `app.db`; committed work can still be in `app.db-wal`. Keep application data on local filesystem storage with reliable locking, not an SMB/NFS share. Backup archives may be copied to another device after the snapshot completes.

Online snapshot (destination must not already exist):

```sh
docker compose exec manager node dist/server/backup.js /data/app.db /data/backup-YYYYMMDD.db
```

Move that completed snapshot into protected backup storage on the host. The `VACUUM INTO` helper captures a consistent database including committed WAL changes. No token is needed on the command line. Test backups periodically; they contain sensitive metadata, password hashes, sessions, recipients and encrypted credentials.

Alternatively, stop the container, copy the complete data directory including any WAL/SHM sidecars, then start it. For the external worker, snapshot `/data/worker.db` or stop its container and copy its data directory.

Back up **the deployment encryption key separately from the database**, plus Compose, runtime `.env`, bootstrap secret and any external heartbeat key/config. Use encrypted backup storage, narrow permissions and a known restore location. Credentials cannot be recovered without the exact key used when the snapshot was created. Treat existing session cookies in database backups as sensitive.

## Restore

1. Stop the relevant container. Keep the previous data directory as an offline rollback copy.
2. Restore a consistent database snapshot as `data/app.db` (or worker `worker.db`) into a clean directory. Do not mix old WAL/SHM files with a VACUUM snapshot. When restoring a complete stopped-directory backup, restore its matching sidecars together.
3. Restore the matching encryption key and runtime configuration. Set database-directory ownership to UID/GID 1000 and directory mode 0700; secrets must be readable by UID 1000 and protected from other users/ACLs.
4. Start the compatible application version, inspect health and log in. Check integration identity, SMTP test and monitor state. Unobserved time is unknown; suspected failure continuity resets. Existing confirmed incidents remain open.
5. Review expiries before restoring service: overdue jobs will execute after startup. For a restoration requiring manual review, initially block outgoing Plex account-service traffic or restore in an isolated environment, then review/update due jobs before enabling normal access. SMTP acceptance just before backup/crash can be ambiguous and retry can duplicate delivery.

## Upgrade and migrations

Before upgrading, take a consistent database backup and preserve the current image tag/digest and matching secrets. Pull/build the new version, update runtime `APP_IMAGE`, then recreate the project. Start only one process per database. Verify health, sign-in, selected Plex identity, queue status and a requested SMTP test.

Schema migrations run transactionally at startup using SQLite `user_version`; this release uses schema version 2. The 1→2 upgrade preserves existing data, adds contacts/preferences, membership observations, drafts/events, durable jobs, expiry revisions and private queue bodies. Existing standalone outage/recovery recipients remain administrator-provisioned and unverified; new categories and automatic welcome/expiry reminders start off. No encryption-key rotation, environment change or reset is required. Follow [the communications upgrade checklist](communications.md).

A newer database schema fails closed when opened by an older image. Future migrations must be ordered; a migration can make rollback impossible without restoring a pre-upgrade snapshot. Reverting only the container image is not a database rollback. Restore the pre-upgrade snapshot **and its matching key**, accepting loss of administrative/runtime changes since that backup. Plex changes already applied cannot be undone by a SQLite restore; reconcile with live Plex first. Restored communication schedules may be overdue: latest-due reminders and announcements can dispatch after startup; accepted SMTP mail cannot be recalled. Review drafts, recipients and queue state in an isolated restore before enabling outgoing traffic.

Keep the pinned Node image digest and npm lockfile current through reviewed dependency updates and rerun all checks. No automatic update/publish daemon is included. The release workflow only publishes when explicitly dispatched.

## Safe local outage simulation

Notify test recipients in advance and configure only addresses you control. Leave the manager/SMTP connection running. Stop just the Plex service through its normal package/container controls, or temporarily firewall the manager’s connection to Plex while preserving app and SMTP traffic. Restore that connection after the configured threshold. Do not change credentials, delete users or power off storage.

Verify suspected failure, one confirmed incident, one logical outage per opted-in recipient and delivery status. Restart Plex/unblock the route, wait for the configured consecutive successes, then verify recovery and observed downtime. Test a shorter interruption separately and expect no outage/recovery email. A queued outage not accepted before recovery is superseded; its recipient should not get a recovery message unless they explicitly opted for recovery-only notifications. Restore production thresholds after shorter test thresholds.

## Troubleshooting

| Symptom                                            | Check                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Container exits immediately                        | Secret files readable by UID 1000; 64-character hex encryption key; bootstrap at least 32 characters; writable data; correct key for existing database |
| App health check passes but Plex shows failure     | Health check is process health only; verify backend-to-Plex URL, selected identity and server token                                                    |
| No owned server available                          | Authenticate the owner account; shared users are not permitted to select a server                                                                      |
| Unsupported response or share mutation unconfirmed | Account API compatibility or Plex eventual consistency; refresh and inspect Plex Web; never repeatedly retry a destructive action blindly              |
| Login/CSRF errors behind proxy                     | Exact PUBLIC_URL origin, HTTPS certificate, preserved Host, replaced forwarded headers, narrow actual proxy peer and browser using that origin         |
| Secure cookie missing on public deployment         | PUBLIC_URL must be HTTPS; inspect browser cookie flags and reverse proxy configuration                                                                 |
| PWA install unavailable                            | Valid HTTPS and manifest/icons; browser-specific install support; do not use bare HTTP LAN addresses                                                   |
| SMTP remains pending                               | Configure SMTP; STARTTLS/465 mode and verified certificates; provider access/network; queue checks every five seconds                                  |
| SMTP failed after retries                          | Inspect visible safe error, provider limits, TLS and authentication; queue a test, then explicitly retry eligible failed jobs                          |
| No email for brief outage                          | Intended threshold/recovery behavior; inspect timeline and settings                                                                                    |
| No email in maintenance or external mode           | Intended suppression; outside worker has independently provisioned recipients/SMTP                                                                     |
| Unknown after restart                              | Intended: no uninterrupted-failure assumption; wait for a new probe                                                                                    |
| Expiry remains pending/failed                      | Correct server selected; network/Plex permissions; refresh and set a new expiry for a terminal failed job                                              |
| External worker stays unknown                      | First pairing missing, local setup incomplete or monitoring disabled; check accepted heartbeat and clocks                                              |
| Duplicate SMTP mail after interruption             | Possible remote acceptance ambiguity; stable Message-ID does not enforce recipient/provider deduplication                                              |

Application logs intentionally avoid raw integration responses and installation values. Do not paste runtime configuration, database dumps, screenshots of real users or provider logs into public issues. Use a synthetic reproduction and report exact application versions.

For communication problems, inspect Communications source status, address verification/consent, address-wide unsubscribe, confirmed membership, UTC schedule, dispatch job failures and per-recipient suppression reasons. Different users sharing an address cannot receive personal welcome/user expiry mail. An expected maintenance end needs explicit completion and does not prove recovery. External digest mismatch/unknown state requires checking and updating the worker's private configuration while reachable; NAS preference changes do not automatically update it. See [communications](communications.md).
