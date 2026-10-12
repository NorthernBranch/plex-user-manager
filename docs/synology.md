# Synology installation walkthrough

This guide is generic. Replace `NAS_ADDRESS`, `plex-admin.example.com`, `YOUR_DATA_DIRECTORY`, `YOUR_IMAGE_OWNER`, `YOUR_REPOSITORY` and `VERSION` only in your private runtime configuration. Do not commit real addresses, domains, secrets or filesystem paths.

## 1. Check prerequisites

In DSM **Control Panel → Info Center**, check the installed DSM version and architecture. In Package Center, confirm that **Container Manager** is available and install/update it on a supported DSM release. Container Manager commonly requires DSM 7.2 or newer; availability depends on the device. Older compatible installations using the Docker package can use SSH and Compose, but that UI path is not verified here. See [Synology’s Container Manager specification](https://www.synology.com/en-global/dsm/packages/ContainerManager) and [project documentation](https://kb.synology.com/en-global/DSM/help/ContainerManager/docker_project?version=7) for your DSM release.

This release targets Linux amd64. With temporarily enabled SSH, `uname -m` should report `x86_64` for that image target, and `docker version` / `docker compose version` must work. Container Manager availability alone does not establish image architecture support. ARM64 builds have not been verified; do not install an amd64 image natively on an ARM NAS or assume emulation is available.

The container must reach `plex.tv` over HTTPS, your selected Plex server port and the chosen SMTP service. No media directories need to be mounted. Use local storage with reliable SQLite locking. Avoid NFS/SMB application-data mounts.

## 2. Obtain an image

No image has been published as part of this implementation. Choose one:

- **Published release later:** in Container Manager Registry/Image or SSH, pull `ghcr.io/YOUR_IMAGE_OWNER/YOUR_REPOSITORY:VERSION` after the repository owner explicitly runs the manual release workflow. Pin a version or digest.
- **Build on a Docker-capable computer:** in the source checkout run `docker build --platform linux/amd64 -t plex-user-manager:local .`, then `docker save -o plex-user-manager.tar plex-user-manager:local`. Transfer that archive privately to the NAS and use Container Manager **Image → Add → Import** (wording varies by DSM), or `docker load -i plex-user-manager.tar` over SSH.
- **Build on the NAS:** use the source checkout and the same build command if its Docker tooling and available memory support a multi-stage build. Dependency downloads require internet access. This build path has not been tested on a real NAS.

Do not put credentials in build arguments. The image contains no installation secrets. CI prepares checks and image builds; it has not been executed in this local environment.

## 3. Create persistent storage

Choose an absolute private deployment directory, represented by `YOUR_DATA_DIRECTORY`, outside any source checkout. Create `data`, `secrets` and `backups` beneath it through File Station or SSH. Restrict shared-folder permissions/ACLs to deployment administrators and the service identity. With SSH:

```sh
mkdir -p YOUR_DATA_DIRECTORY/data YOUR_DATA_DIRECTORY/secrets YOUR_DATA_DIRECTORY/backups
sudo chown 1000:1000 YOUR_DATA_DIRECTORY/data
sudo chmod 700 YOUR_DATA_DIRECTORY/data YOUR_DATA_DIRECTORY/secrets YOUR_DATA_DIRECTORY/backups
```

The image runs as numeric UID/GID `1000:1000`; the mounted data directory must be writable by that identity. DSM ACLs can override POSIX permissions, so inspect both if SQLite cannot create its WAL. Do not solve permission errors with privileged mode or broad world-write permissions.

## 4. Create secrets and environment configuration

On the NAS, generate fresh values **at runtime**:

```sh
umask 077
openssl rand -hex 32 > YOUR_DATA_DIRECTORY/secrets/encryption_key
openssl rand -hex 32 > YOUR_DATA_DIRECTORY/secrets/bootstrap_secret
sudo chown 1000:1000 YOUR_DATA_DIRECTORY/secrets/encryption_key YOUR_DATA_DIRECTORY/secrets/bootstrap_secret
sudo chmod 400 YOUR_DATA_DIRECTORY/secrets/encryption_key YOUR_DATA_DIRECTORY/secrets/bootstrap_secret
```

The bootstrap secret prevents someone else claiming setup. Read it privately to complete first run; do not put it in a URL or issue. Setup consumes its claiming ability once the administrator exists. Keep the file for startup configuration validation. Back up the encryption key securely and separately from SQLite. Never regenerate it for an existing database.

Copy `compose.yaml` and `.env.example` into a private project directory. Rename the latter `.env` and edit these values:

```dotenv
APP_IMAGE=plex-user-manager:local
PUBLIC_URL=https://plex-admin.example.com
BIND_ADDRESS=127.0.0.1
APP_PORT=3000
TRUSTED_PROXY=YOUR_NARROW_PROXY_IP_OR_CIDR
DATA_DIRECTORY=YOUR_DATA_DIRECTORY/data
ENCRYPTION_KEY_PATH=YOUR_DATA_DIRECTORY/secrets/encryption_key
BOOTSTRAP_SECRET_PATH=YOUR_DATA_DIRECTORY/secrets/bootstrap_secret
```

Use the versioned GHCR image if published. Paths must be absolute after replacing placeholders. Protect `.env` with mode 0600 and DSM ACLs. Secrets in standalone Compose are bind mounts; their host ownership must permit UID 1000 to read them. Docker secret permissions are not automatically remapped.

## 5. Configure HTTPS and the reverse proxy

Use a dedicated subdomain. In DSM **Control Panel → Login Portal → Advanced → Reverse Proxy** (older DSM wording may differ), create a rule:

- Source: HTTPS, hostname `plex-admin.example.com`, port 443.
- Destination: HTTP, hostname `127.0.0.1`, port 3000 for a same-NAS proxy.
- Preserve Host and send/replace `X-Forwarded-Proto: https` and forwarded client address headers. Check DSM’s generated behavior rather than adding duplicated header chains.

In **Security → Certificate**, obtain/import a valid certificate and assign it to this reverse-proxy hostname. Configure private or public DNS appropriately. If using public access, expose only HTTPS through your router/firewall, with the bootstrap secret protected. Do not forward port 3000. A private DNS/HTTPS installation also supports the PWA.

The container may see the NAS proxy as its Docker bridge gateway. Inspect the chosen Docker network on the NAS and set `TRUSTED_PROXY` to that actual narrow peer IP/CIDR; do not blindly trust all private addresses. If a proxy on a separate host is required, bind to a specific LAN `NAS_ADDRESS` and firewall port 3000 to that proxy only. Alternatively use [Nginx](nginx.conf) on the proxy host. `PUBLIC_URL` must exactly match the HTTPS origin used by the browser; secure cookies are enabled from that setting.

See [Synology’s Login Portal guide](https://kb.synology.com/en-af/DSM/help/DSM/AdminCenter/system_login_portal?version=7) for version-specific controls. TLS termination does not require a certificate inside the app container.

## 6. Import and start the Compose project

In the private installation copy, remove `build:` if the source tree is absent. In Container Manager **Project → Create**, set a generic project name, choose the private project directory and import/select `compose.yaml`. Ensure the project loads the colocated `.env`; if your DSM version does not, use SSH with `docker compose --env-file .env` rather than pasting secrets into the repository.

Start the project. For a locally imported image over SSH:

```sh
docker compose --env-file .env up -d --no-build --pull never
docker compose ps
```

For a published image, pull that exact version first and use `up -d --no-build`. Confirm container process health. The health check only proves the application is running; Plex availability is separately tested during setup. Restart policy is `unless-stopped`; a manually stopped container remains stopped after NAS restart.

## 7. Complete administrator and Plex setup

Open `https://plex-admin.example.com` through the configured proxy. Enter the bootstrap secret, choose an app administrator username and a strong password of at least 12 characters. This login is independent of Plex. In **Settings**, start Plex sign-in, open Plex’s authentication page, authenticate the owner account, return and check sign-in. Load owned servers, select the intended server and provide a backend-reachable URL such as `http://NAS_ADDRESS:32400` or its reachable HTTPS Plex origin.

Use **Test & select server**. The backend rechecks ownership and validates the server machine identity; a shared viewer account cannot select another owner’s server. Review Users and compare with Plex Web. Before using invitations, expiry or revocation in production, validate a disposable server share because live account-service compatibility was not verified locally.

## 8. Configure and test SMTP

In **Notifications**, enter the SMTP host/port, sender and optional authentication. Use required STARTTLS (typically port 587) or implicit TLS (typically 465); certificates must validate. Save, queue a test to an address you control, and inspect Delivery history until it reports SMTP acceptance or a visible failure. Acceptance is not proof of inbox delivery; check spam/provider policies. No recipients are inferred from Plex accounts.

## 9. Configure outage alerts

In **Monitoring**, use the initial defaults: interval 30 seconds, timeout 10 seconds, continuous failure 300 seconds, recovery after two successful checks. Add administrator-defined recipients with separate outage/recovery preferences, plain-text templates and UTC maintenance windows. Save. Background checks run on the NAS even with the phone/browser closed. Review incidents, unknown restart gaps and delivery failures.

## 10. Add the PWA to a phone

Visit the HTTPS origin and sign in. In a compatible Android browser, choose Install app/Add to Home screen. On iPhone/iPad Safari use Share → Add to Home Screen. Install UI varies by browser. Icons and an offline page are cached; no authenticated API, credentials or user data is cached. Offline access changes are disabled and never replayed later. The phone does not perform backend monitoring.

## 11. Safely test outage and recovery

First use only test recipients and advise them. Stop only the Plex package/container through its normal controls, keeping the manager, NAS network and SMTP available. Wait past the failure threshold; inspect one incident and one logical outage per opted-in recipient. Start Plex again and wait for two successful checks, then inspect recovery and observed downtime. Test a shorter interruption below threshold and expect no incident email. Do not unplug power, delete shares or modify credentials as a test. Restore normal thresholds if you shorten them temporarily.

## 12. Understand or enable outside monitoring

A worker on this same NAS cannot email during whole-NAS, power or internet outages. Local monitoring still usefully detects Plex process/API failures. For host/network coverage, follow [the external worker walkthrough](external-monitor.md) on a separately powered outside host. Provision that host’s recipients, SMTP, keys and maintenance windows in advance; pair signed heartbeats; test its email; choose External notification authority locally to avoid duplicate senders. It detects heartbeat loss or reported local identity failure, not guaranteed playback. No Plex owner token leaves for the worker.

## 13. Backup, upgrade, restore and troubleshoot

Follow [operations](operations.md): take a consistent `VACUUM INTO` snapshot or stop the container and copy the full matching data directory; protect/back up the matching encryption key separately. Before upgrades, save current image/version and a pre-upgrade snapshot. Recreate with the chosen image and verify identity, SMTP and queue status. Database migrations can prevent image-only rollback; restore the matching pre-upgrade snapshot/key when needed. Plex changes already applied remain in Plex and must be reconciled.

For startup failure inspect permissions, secret lengths and the matching database key. For login/CSRF failure check HTTPS, PUBLIC_URL and actual proxy peer. For SMTP failure check TLS/auth/network and visible queue status. For Plex API shape/mutation errors inspect current Plex Web state, avoid blind destructive retries and use synthetic public bug reports. Keep all personalised runtime files and backups outside Git.
