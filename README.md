# HomeLock

HomeLock is a local-development prototype for a family-governed archive. It uses TideCloak to authenticate users, Node.js for the API, SQLite for repository/workflow metadata, and private local storage for encrypted video uploads.

> **Demo only — never use real security footage.** HomeLock now counts approvals in application code using SQLite. The server stores video decryption keys and can bypass the app workflow. This is not TideCloak/ORK-enforced quorum, end-to-end key governance, or tamper-proof authorization.

## Run locally

Requirements: Node.js 22.13 or later (the app uses Node's built-in `node:sqlite` module).
Configure the root `.env` with the TideCloak settings described below. Keep this local file
uncommitted; `.env` is ignored by git.

```sh
sudo docker run \
  --name mytidecloak \
  -d \
  -v .:/opt/keycloak/data/h2 \
  -p 8080:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=password \
  tideorg/tidecloak-dev:latest

npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Without a TideCloak adapter, sign-in and protected API requests remain unavailable; the app does not create preview identities.

The SQLite database is created at `data/homelock.sqlite`. Encrypted video files are stored under `data/recordings/`, outside the web root. Uploads are limited to 50 MB and accepted video MIME types. The Node API serves the Vite-built app and API from one origin.

## TideCloak authentication

1. Keep the public adapter export at `public/tidecloak.json`. It contains public client/realm configuration and public verification keys; it is ignored by git in this workspace.
2. Set `TIDECLOAK_URL`, `TIDECLOAK_REALM`, `TIDECLOAK_CLIENT_ID`, and `APP_ORIGIN` in `.env` to match the adapter and app origin. Never put credentials or private keys in the adapter or source control.
3. Register `${APP_ORIGIN}/auth/redirect` and the app origin in TideCloak. The server provides `/auth/redirect`, `/silent-check-sso.html`, and the DPoP relay.
4. The API verifies the access-token signature, issuer, expiry, subject, authorized party, and configured audience. It also verifies the DPoP signature, token binding, method, URL, time window, and replay identifier.

HomeLock uses the verified OIDC `sub` claim as its application user ID. SQLite stores only app-specific repository membership and workflow information; TideCloak remains the identity provider.

## Application-managed guardian quorum

Thresholds are derived on the server from the current `repository_guardians` rows—not from a client-supplied count:

```js
const QUORUM_THRESHOLD = currentGuardians.length;
const VIEW_THRESHOLD = currentGuardians.length - 1; // the requester does not approve their own view
```

- The repository creator is its first guardian.
- Guardian invitations and join requests require approval from every guardian in the request's roster snapshot.
- Viewing a video requires approval from every other guardian; the requesting guardian is excluded. A one-guardian repository therefore needs zero additional view approvals.
- An approved view request is consumed on first retrieval, so its approval cannot be replayed for a second fetch.
- Deletion requires approval from every guardian, including the requester.
- One rejection rejects the request. Each snapshotted guardian may vote once.
- Every request records the membership version and voter snapshot. Adding or removing a guardian increments the version and expires other pending requests. Votes are accepted only from a snapshotted user who is still a current guardian.
- Guardians can leave voluntarily. The last guardian cannot leave; a membership change invalidates pending requests.
- Direct file deletion and direct membership mutation endpoints are refused; they must go through a quorum request.

These are **application-level votes**. An operator with access to the server or SQLite can alter the roster/votes or bypass checks. They do not prove cryptographic guardian approval, and they are not equivalent to Tide/ORK policy enforcement.

## Video handling and trust boundary

The browser encrypts each uploaded video with a fresh AES-256-GCM key. After an approved view request, the API returns the ciphertext and key to the requesting guardian's browser for decryption. **The application stores each file key in SQLite**, so the app host/database operator can access the video. Browser encryption here only keeps uploaded file bytes from being plaintext on disk; it is not end-to-end protection against the HomeLock operator.

Files must remain outside the public web root and are addressed only by generated IDs. SQLite stores file metadata, workflow requests, guardian snapshots, votes, and audit events. The audit trail is not tamper-proof against a database operator.

## Current app state

- TideCloak sign-in, sign-out, callback, JWT verification, and DPoP verification are implemented.
- Authenticated users can create repositories, whose creator becomes the first guardian.
- Current guardians can invite other TideCloak subject IDs; non-members can submit join requests by repository ID.
- Guardians can upload supported video files, request viewing/deletion, and approve or reject pending requests.
- All workflow routes enforce membership and quorum checks server-side; the browser does not send a threshold or approval count.
- The candidate [HomeLockGuardianQuorum.cs](./contracts/HomeLockGuardianQuorum.cs) is **not used** by this app-level implementation and has not been deployed or verified.

## Test and build

```sh
npm test
npm run build
```

Tests cover authenticated APIs, application-computed quorum, requester exclusion from view votes, rejection, file encryption/decryption after approval, membership-change expiry, and DPoP validation. These tests validate HomeLock code only; they do not certify Tide/ORK security.
