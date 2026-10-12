# Plex capability research

Research performed 12 October 2026, before adapter implementation. These links describe integration evidence; they are not evidence of a live test against an installation.

## Authentication

[Plex’s authentication guidance](https://forums.plex.tv/t/authenticating-with-plex/609370) describes creating a strong PIN, sending the user to the Plex authentication application and polling for the token. The backend implements that supported PIN flow. The PIN ID stays on the backend. Only the sign-in URL with its temporary PIN code reaches the browser; the returned token never reaches client storage or a token-bearing URL.

[Current official PMS documentation](https://developer.plex.tv/pms/) also documents a newer public-key JWT flow with short-lived tokens. This release uses the existing opaque-token PIN flow rather than implementing JWT registration and renewal. Reauthenticate if Plex invalidates the app token; no Plex password is collected. Integration disconnect removes locally stored credentials; revoke the app authorisation in Plex account settings if the credential itself must be invalidated.

The app first establishes its own password administrator. Plex sign-in is only accessible to that administrator; it cannot establish application administrator rights. Resources from `/api/v2/resources` are validated and filtered to owned Media Servers. Selection re-fetches ownership and probes `/identity`, validating both machine identity and version. Server URLs can be administrator-provided local origins, because advertised resource connections may not be reachable from Docker.

## Sharing API evidence

[Maintained Python PlexAPI source](https://github.com/pushingkarmaorg/python-plexapi/blob/master/plexapi/myplex.py) implements account users, requested invitations, library-section mapping and server-share creation/update. This adapter follows those account-service paths and validates legacy XML responses. Account library section IDs are distinct from local PMS section keys; mutations use the account IDs.

[PSPlex’s share-removal implementation](https://www.powershellgallery.com/packages/PSPlex/1.0.12/Content/Public%5CRemove-PlexShare.ps1) and [an integration’s recorded API inspection](https://github.com/snapetech/iptvtunerr/blob/main/docs/how-to/reverse-engineer-plex-livetv-access.md) provide evidence for deletion of a single share through `/api/v2/shared_servers/{shareId}`. The app resolves that ID from a fresh selected-server share, never from a username alone. It never calls account/friend deletion or Home removal. There is no fallback to a broader destructive operation if share deletion fails.

[Plex’s library-access documentation](https://support.plex.tv/articles/201105738-creating-and-managing-server-shares/) describes invitations by username/email, pending access and Plex Pass restrictions. It states that removing access does not remove friendship. This release exposes normal shares and invitations, including managed shares if returned by account users. Managed creation and Home membership remain unsupported within the app.

### Implemented requests

| Service          | Requests                                                | Purpose                               |
| ---------------- | ------------------------------------------------------- | ------------------------------------- |
| Plex account     | POST/GET `/api/v2/pins`                                 | PIN sign-in                           |
| Plex account     | GET `/api/v2/user`, `/api/v2/resources`                 | Subscription and owned servers        |
| Plex account     | GET `/api/users/`, `/api/invites/requested`             | Accounts and sent invitations         |
| Plex account     | GET `/api/servers/{machineId}`                          | Account library IDs                   |
| Plex account     | GET `/api/servers/{machineId}/shared_servers/{shareId}` | Current shared sections               |
| Plex account     | POST `/api/servers/{machineId}/shared_servers`          | Invitation                            |
| Plex account     | PUT `/api/servers/{machineId}/shared_servers/{shareId}` | Library update                        |
| Plex account     | DELETE `/api/v2/shared_servers/{shareId}`               | Selected server share only            |
| Plex account     | PUT `/api/v2/sharings/{userId}`                         | Account-wide content filters          |
| Selected PMS     | GET `/identity`                                         | API availability and machine identity |
| App-owned SQLite | Notes, presets, expiry, incidents, delivery, audit      | App metadata only                     |

Restrictions use rating and allowed-label filters. The adapter does not present download/Live TV permissions as equivalent operations. Existing raw filters are displayed before replacement. Plex Pass is checked on the backend. Managed and pending accounts must use Plex Web for restrictions. Account-scoped filters can affect the same user’s other shares: confirm explicitly.

Sharing endpoints are not a publicly versioned contract. They can return different shapes, reject JSON payloads in some versions or delay reconciliation. This release treats those conditions as errors/unconfirmed changes. Never read an HTTP 2xx as proof of a requested state: access edits and revocations refresh and reconcile. Invitation acceptance is controlled by the recipient, and the app reports requests as accepted by Plex with recipient acceptance still pending.

GET requests have a timeout and at most three attempts; mutation requests have one attempt. Monitoring probes have exactly one timeout-bound attempt. Redirects are rejected so credentials cannot follow a redirect to another host. Remote bodies, response URLs and tokens are never included in errors or logs. Live validation still requires an owned Plex account and a disposable invited user.
