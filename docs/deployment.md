# Generic Docker deployment

Use standard Docker Engine with the Compose plugin on Linux amd64. Run on a host that can reach Plex account services, the chosen Media Server and optionally your SMTP server. Only application data is mounted; no media files, Docker socket or privileged mode are needed. Use one container per database.

## Prepare the image

No image is published by default. In a clean source checkout on a Docker-capable host:

```sh
docker build --platform linux/amd64 -t plex-user-manager:local .
node scripts/docker-smoke.mjs linux/amd64
```

Alternatively, after an authorised release workflow runs, pull `ghcr.io/YOUR_IMAGE_OWNER/YOUR_REPOSITORY:VERSION`. Set `APP_IMAGE` to that exact tag or immutable digest. The workflow derives owner/repository from GitHub context; no personal owner is hardcoded. To transfer an unpublished build between hosts, use `docker save -o plex-user-manager.tar plex-user-manager:local` and `docker load -i plex-user-manager.tar`.

## Prepare runtime storage and secrets

Replace `YOUR_DATA_DIRECTORY` with an absolute deployment directory outside the source checkout. On the deployment host:

```sh
mkdir -p YOUR_DATA_DIRECTORY/data YOUR_DATA_DIRECTORY/secrets YOUR_DATA_DIRECTORY/backups
sudo chown 1000:1000 YOUR_DATA_DIRECTORY/data
sudo chmod 700 YOUR_DATA_DIRECTORY/data YOUR_DATA_DIRECTORY/secrets YOUR_DATA_DIRECTORY/backups
umask 077
openssl rand -hex 32 > YOUR_DATA_DIRECTORY/secrets/encryption_key
openssl rand -hex 32 > YOUR_DATA_DIRECTORY/secrets/bootstrap_secret
sudo chown 1000:1000 YOUR_DATA_DIRECTORY/secrets/encryption_key YOUR_DATA_DIRECTORY/secrets/bootstrap_secret
sudo chmod 400 YOUR_DATA_DIRECTORY/secrets/encryption_key YOUR_DATA_DIRECTORY/secrets/bootstrap_secret
```

Docker standalone Compose secrets are file bind mounts: file ownership/permissions on the host must allow container UID 1000 to read them. Do not rely on Compose `uid`, `gid` or `mode` changing bind-mounted secret permissions. Protect secrets from ordinary NAS/shared-folder users through host ACLs as well. Never regenerate the encryption key for an existing database. Losing that key makes encrypted credentials unrecoverable.

Copy `compose.yaml` and `.env.example` into an installation directory outside the source checkout, rename the latter `.env`, and set absolute runtime paths, the image and `PUBLIC_URL=https://plex-admin.example.com`. Keep `.env` readable only by deployment administrators. Use the dedicated subdomain’s actual origin, with no URL path, query, credentials or trailing application path.

The published-image installation only needs Compose, `.env`, persistent directories and secrets. Remove `build:` from the installation copy of Compose when source is absent. For a local image, start with `docker compose --env-file .env up -d --no-build --pull never`. For a published image, use `docker compose --env-file .env pull`, then `docker compose --env-file .env up -d --no-build`. Keep the repository’s generic Compose unchanged.

## HTTPS proxy and onboarding

The default published port binds to `127.0.0.1`, suitable for a same-host proxy. Use [the Nginx example](nginx.conf) or a compatible host reverse proxy. If a proxy on another host must connect, set `BIND_ADDRESS=NAS_ADDRESS` to a specific LAN interface and firewall that port to the proxy host. Do not forward the internal app port from the router. HTTPS terminates at the proxy; the container serves HTTP behind it.

The proxy must preserve Host, send `X-Forwarded-Proto: https`, and replace incoming forwarded headers rather than trusting browser-supplied chains. Configure `TRUSTED_PROXY` only for the actual peer the container sees, using a single IP or a narrow CIDR. A host proxy reaching a Docker bridge may be seen as the bridge gateway, not loopback; inspect the host’s Docker network and use that exact gateway address. Do not use all addresses or a count-based trust setting. Direct routes and CSRF check the configured public origin. HTTPS PUBLIC_URL enables Secure cookies even though the internal hop is HTTP.

At the HTTPS URL: establish an app administrator with the bootstrap secret; connect Plex via PIN sign-in; load/select an owned server and test its backend URL; configure optional SMTP and queue a test; then set recipients, thresholds and maintenance in Monitoring. Admin passwords must contain at least 12 characters. A Plex viewer login is never an app administrator login.

Use [operations](operations.md) for consistent backups, upgrades, restoration, secrets and troubleshooting, and [external monitoring](external-monitor.md) for separate host detection. No images, releases or deployments are performed by these instructions automatically.
