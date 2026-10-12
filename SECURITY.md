# Security reporting

Enable GitHub private vulnerability reporting for the repository, then use **Security → Report a vulnerability**. If that feature is unavailable, open an issue requesting a private reporting channel without disclosing exploit details, tokens or installation information. There is no hardcoded personal reporting address.

Report affected versions, a synthetic reproduction and expected impact. Do not attach real environment files, databases, tokens, account identities or network details. Rotate compromised Plex tokens, SMTP credentials, heartbeat keys and application sessions using their providers and deployment tooling.

The app administrator is independent of Plex identities. First-run setup requires a bootstrap secret. Session cookies are HttpOnly, same-site and secure on public HTTPS; write operations require same-origin and CSRF validation. Login attempts are rate-limited. Plex and SMTP credentials and heartbeat keys are AES-256-GCM encrypted, using a deployment key outside SQLite. App metadata and email recipient records are sensitive operational data, not field-level encrypted: protect the volume and backups.

No telemetry or external frontend dependencies are used. The app contacts Plex account services, the configured server, configured SMTP service and optionally a configured external worker. Administrators can configure private server and SMTP addresses; only administrators can edit integrations. Do not expose setup without protecting the bootstrap secret. Do not disable TLS verification. Do not grant broad proxy trust or mount media files or the Docker socket.

Only one process/container should own an application database. SQLite WAL must be on local storage with working filesystem locks, not an NFS/SMB mount. SMTP delivery can be duplicated after ambiguous remote acceptance; no exactly-once guarantee is made. Account-service sharing APIs have no public stability guarantee. Review `docs/plex-api.md` and use a test share for live compatibility validation.
