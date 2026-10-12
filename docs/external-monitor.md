# Optional monitoring outside the NAS

Local monitoring works without any external worker. It cannot send when its host, power or internet is unavailable. Install the optional worker on an independently powered host outside the home network with internet and SMTP access. Its SMTP service must also remain available independently of the NAS and home internet connection. It can be a separate self-owned machine; a paid cloud service is not required.

The NAS sends a timestamped HMAC-signed heartbeat containing only a nonce and one scoped health state: healthy, unhealthy, unknown or maintenance. No Plex owner token, library data, usernames or recipients are transferred. The worker accepts fresh, authenticated, increasing timestamps and rejects replay/forgery. Keep both hosts’ clocks synchronised.

The worker proves receipt of a recent local Plex identity probe or detects missed heartbeats. A missing heartbeat can mean an unavailable NAS, home power/internet, the app process, heartbeat route or network path. It cannot distinguish these causes and does not prove the external Plex playback path works. It stores incidents and sends SMTP independently; it never asks the unavailable NAS for configuration or recipients.

## Provision before an outage

1. Obtain the same image as the local application. Copy `compose.external.yaml` to a runtime directory on the outside host. Use a separate data directory, fresh encryption key and random heartbeat key, with UID 1000 permissions as in generic deployment. Do not share the NAS database or encryption key.
2. Copy [the configuration example](worker-config.example.json) to an ignored runtime `secrets/worker_config.json`. Replace SMTP values and add recipients and preferences **on this host before an outage**. This file contains SMTP credentials and must be protected with UID 1000 ownership and mode 0400. The application never commits or synchronises it.
3. Point `APP_IMAGE`, `WORKER_DATA_DIRECTORY`, `ENCRYPTION_KEY_PATH`, `HEARTBEAT_KEY_PATH` and `WORKER_CONFIG_PATH` at that host’s runtime files. Remove `build:` if using an installation copy without source (the external Compose has no build stanza). Run `docker compose -f compose.external.yaml --env-file .env up -d --pull never` for a transferred local image, or pull the versioned GHCR image first.
4. Provide HTTPS at `https://monitor.example.com/heartbeat`. Proxy only `/heartbeat` to worker port 3001; do not expose any NAS administration route. Nginx can use the same TLS/header pattern as `nginx.conf`, with `proxy_pass http://127.0.0.1:3001`. The worker’s `/healthz` is only process health, not a Plex status proof. The worker has no administrative browser/API.
5. In local app Settings, save this HTTPS heartbeat URL and the shared heartbeat key. The dashboard Settings shows the last accepted heartbeat delivery. Wait for successful pairing; the worker remains unknown until a first heartbeat. A paused/unconfigured local monitor reports unknown, not a healthy recovery.
6. Verify worker pairing in its database and logs, test email before relying on it, then select **External worker** as local notification authority. This suppresses local incident emails, including pre-existing queued jobs. The independently provisioned worker is the sole sender for that installation’s incidents. Do not run two outside workers with different databases and identical recipient configuration.

Example secret generation on the worker:

```sh
umask 077
openssl rand -hex 32 > YOUR_DATA_DIRECTORY/secrets/encryption_key
openssl rand -hex 32 > YOUR_DATA_DIRECTORY/secrets/heartbeat_key
```

The worker checks every 30 seconds by default. It allows 90 seconds for a heartbeat, then requires five minutes of continuous observed failure. A complete host/network loss therefore typically takes heartbeat grace plus outage threshold plus scheduling variation to confirm. Plex unhealthy heartbeats start the failure threshold without waiting for missing-heartbeat grace. Two successful checks confirm recovery. Restart gaps are unknown and not added to observed downtime.

Configure matching maintenance windows in the worker file **in advance**, especially for planned whole-host downtime. A received maintenance heartbeat pauses observation without pretending to recover an existing incident, but missed heartbeats cannot deliver updated maintenance settings during an outage. The worker’s independently provisioned UTC windows suppress email. Settings and recipients are not synchronised; restart the worker after configuration edits. Keep local authority external during testing and all planned outages.

Use **Communications → Messages → External worker configuration** to copy the effective local windows (including confirmed events) into the worker's private `monitor.maintenance`. Manually provision the same outage/recovery recipient addresses and preferences in `monitor.recipients`; linked contacts are not automatically copied. Apply NAS recipient opt-outs to this file too. Restart the worker after edits. This is a manual workflow, not an authenticated settings-sync feature.

Upgraded workers return nonce-bound HMAC-signed digests for effective maintenance and recipient configuration with accepted heartbeats. Communications displays last authenticated matches/mismatches and the acknowledgement time. Old workers or responses without a valid signature are **unknown**, never assumed matching. A heartbeat can be accepted while configuration differs. Compare while both hosts are reachable, before an outage. Worker SMTP, thresholds and other settings still require operator review; the digests compare only windows and outage/recovery recipients/preferences. The worker keeps independently provisioned configuration during NAS downtime and does not send local announcements, welcome/expiry reminders or maintenance communications. See [communications](communications.md).

## Delivery test and inspection

The same image includes `dist/server/worker-admin.js`. Queue a single synthetic or administrator-approved test to the worker’s own SMTP service:

```sh
docker compose -f compose.external.yaml exec monitor node dist/server/worker-admin.js test admin@example.com
docker compose -f compose.external.yaml exec monitor node dist/server/worker-admin.js status
```

The status command reports last heartbeat, incidents, timeline and delivery failures from the worker’s local database. It is available only to an operator with Docker access; it sends no command to the NAS. Status output is private runtime information: never attach it unredacted to a public issue. Test and status commands require the same deployed secret files as the worker.

For a safe host-outage simulation, first pair the worker and confirm its SMTP test was accepted. Stop only the **manager container** (leave the worker running); wait grace + threshold; inspect one incident/outage delivery per opted-in recipient. Start the manager, wait for two healthy heartbeats/checks, and inspect recovery. This does not change Plex shares or stop Plex itself. A short manager stop below thresholds must not email. Avoid power loss or unplugging the NAS.

Back up the worker’s SQLite database, encryption/heartbeat keys and configuration separately. Use the same consistent snapshot or stopped-container procedure as local operations. A restoration can replay a message whose SMTP acceptance was unknown. No exactly-once SMTP guarantee is made.
