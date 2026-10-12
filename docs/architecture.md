# Architecture

The React PWA is served with the API from the Node process. No build-time installation configuration enters the frontend. The production image contains compiled backend and frontend plus production dependencies, running as numeric UID/GID 1000 without capabilities.

| Module                                              | Responsibility                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `server/auth.ts`                                    | Bootstrap claiming, scrypt password hashing, rate limiting, sessions, same-origin/CSRF |
| `server/config.ts`, `server/crypto.ts`              | Runtime schemas, file secrets and authenticated encryption                             |
| `server/store.ts`                                   | SQLite WAL, transactional migration, key validation, metadata and queue persistence    |
| `server/plex.ts`                                    | Validated Plex account/PMS adapter, timeouts, safe errors, retry boundaries            |
| `server/access.ts`                                  | Per-server mutations, refresh/reconcile, bulk previews, persistent expiry execution    |
| `server/monitor.ts`                                 | Incident state machine, timeline, logical notification creation                        |
| `server/email.ts`                                   | Per-recipient SMTP queue, TLS, retries, stale and recovery ordering                    |
| `server/heartbeat.ts`, `server/external-monitor.ts` | Scoped signed heartbeats, replay checks, independent host detection                    |
| `server/index.ts`, `server/worker.ts`               | Separate local and external process lifecycles                                         |

Access operations are serialised within the process. Bulk preview records the selected server, share ID and before-state, expires in five minutes and is consumed once. Each user is refreshed before applying; externally changed shares are skipped. Mutation reconciliation can fail even after Plex accepted a request; the app reports that ambiguity rather than pretending to succeed. Expiry marks work running before calling Plex and re-fetches on restart: already-absent shares complete without a second deletion. Failures back off up to five attempts and remain visible.

Monitoring transitions healthy → suspected failure → confirmed outage → recovery pending → recovered. A failure during recovery keeps the existing incident. Short interruptions create no incident notification. Incidents and recipient jobs are created transactionally. A restart or excessive probe gap resets failure continuity; existing incidents remain open and downtime excludes unobserved intervals. The UI marks pre-probe state unknown. Observed downtime counts intervals following failing probes, not a claim about exact failure/playback duration.

Each delivery is unique by incident, kind and recipient. Recovery is ordered after an accepted outage to the same address, except for explicit recovery-only preferences. Pending/failed outage jobs are superseded at recovery. An outage already sending finishes first; failed uncertain acceptance is visible and can produce duplicates on retry. Recipient removal or opt-out suppresses queued messages before sending. Queue attempts use stable Message-IDs but do not guarantee deduplication by the SMTP provider. Five failed attempts produce a visible terminal failure; administrator retry is explicit, and stale outages cannot be retried. Probes, expiry processing, heartbeats and SMTP delivery use separate loops so a slow access or mail request cannot stall health observation.

Maintenance suppresses logical notifications when confirmed/recovered, and suppresses queued notifications reaching delivery during maintenance. Suppression does not send delayed alerts. The local queue suppresses outage/recovery delivery when external authority is selected. The external worker has its own independent configuration, encryption key and SQLite database; it never queries the unavailable NAS for recipients or SMTP settings.

One process must own each database; this is not an HA cluster. Sessions, email recipients, notes, audits and incident metadata are sensitive runtime data. Only integration credentials are field-level encrypted. Use local-volume permissions, encrypted backup storage and TLS to protect the remainder. No production operation reads Plex media files.
