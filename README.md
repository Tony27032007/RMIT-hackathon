[![Built with TideCloak](https://tide.org/badges/built-with-tidecloak.svg)](https://tide.org/tidecloak?utm_source=github&utm_medium=readme&utm_campaign=unlocked)

# Hearth — Family video archive

Hearth is a family-governed repository for home-security recordings. Adult family members subscribe as guardians and share authority over repository membership and recording views. The interface uses plain HTML, CSS, and JavaScript; the local Node.js API stores metadata in SQLite and video files on local disk.

## Responsibility model

The intended boundary separates authority and cryptography from application workflow:

### What TideCloak provides

- Authenticated guardian identities.
- Role-based access tied to protected authority.
- Quorum-governed authority changes, so one user cannot unilaterally add or remove guardians.
- Encrypted access to sensitive content, without requiring the platform to have universal plaintext access.

These guarantees depend on the realm roles, ORK/Forseti policies, and cryptographic flows being configured and verified. TideCloak authentication or a valid access token alone does not provide the custom household quorum or encrypt recordings.

### What the application provides

- Repository creation and management.
- Video upload, storage, and deletion workflows.
- Guardian invitation and approval screens.
- Request-and-approval workflows for viewing or deleting recordings.
- Audit trail and status tracking for each request.

The application presents and records these workflows; TideCloak's protected authority and policies must enforce the security decisions. An application-side approval count or SQLite record is not cryptographic authorization.

## Current implementation and security boundaries

- TideCloak-backed account authentication protects API routes. The API verifies access tokens using the adapter's embedded JWKS and validates DPoP proofs with replay protection.
- Repository creation/listing and subscriber views are available to authenticated users. Existing recording metadata and request history can be listed.
- In this prototype, repository membership checks for metadata routes are still backed by SQLite records, not Tide role claims. Tide roles/group membership and protected IGA authority have not been provisioned or linked to repositories.
- Preview mode works without a Tide adapter; its sample guardians, recordings, and approvals are browser-only demonstrations.
- Membership requests, guardian votes, recording-view requests, and recording-deletion requests are now recorded and audited. Unanimous app-side votes never change membership or grant plaintext access. Upload/continuation/completion, membership changes, playback, and actual recording deletion remain fail-closed with `503` until the ORK policy and client-side encryption are verified.
- Canceling an unfinished legacy upload does not delete a completed recording or grant access to its contents.

The built-in Tide `RelationshipAttestation` policy can restrict record encryption/decryption to a user, group, or role, but it does not itself express Hearth's requirement that every current guardian approves each membership, view, and deletion request. Hearth has not verified an ORK-enforced policy for that unanimous rule. No production policy or realm role/group mapping has been deployed and verified. Do not treat the intended quorum or encrypted-access model as an implemented guarantee.

The SQLite audit log is append-only through the application and protected from ordinary SQL updates/deletes by triggers. It is not a cryptographic or tamper-proof audit: an operator with direct database/file access can alter the database.

Local disk storage does not itself provide end-to-end encryption: machine administrators and processes with filesystem access can read stored bytes. The local storage backend only stores and streams bytes; it is not a substitute for per-recording DEKs or ORK enforcement. Do not treat any existing files or legacy S3 objects as protected by the intended design. Any previously issued legacy presigned URLs remain usable until they expire. Tide identity and DPoP protect API authentication; they do not themselves encrypt recordings or enforce custom approval rules.

The local backend writes recording files under `LOCAL_STORAGE_PATH` (default `data/recordings`) and stages multipart pieces in its `.uploads` subdirectory. SQLite remains at `SQLITE_PATH` (default `data/hearth.sqlite`). Set these paths to local directories with adequate free space; the app does not upload media to S3 or another remote storage service.

The next implementation step is to confirm the guardian-approval evidence format and custom Forseti policy/request contract with Tide, then integrate client-side per-recording DEK encryption and a verified ORK decryption flow. Re-enable these routes only after end-to-end tests prove that missing, duplicate, stale, replayed, and requester-self approvals are rejected by the ORK policy.

No production realm or local-disk production hardening is included. The Tide integration has not been exercised against a live TideCloak realm. Age verification for adult family accounts is unresolved and is not implemented. Do not use this prototype for real security footage until the threat model, cryptographic policy, operator access, and live integrations have been independently reviewed and tested.

## Run locally

Use Node.js 22.13 or later:

```bash
npm install
npm run dev
```

Open the local URL printed by the server. Optionally set `PORT`, `SQLITE_PATH`, and `LOCAL_STORAGE_PATH` in `.env` before running. Without `public/tidecloak.json`, Hearth runs in preview mode and protected API requests fail closed with `503`. To enable authenticated mode, provide a Tide-specific adapter at the configured `TIDECLOAK_ADAPTER_PATH`. It must include `auth-server-url`, `realm`, `resource`, and a non-empty embedded `jwk.keys` array. Remote JWKS fallback is intentionally not used.

The local server serves only the browser SDK modules needed by the Tide adapter from the installed dependencies. The SDK initializes with strict ES256 DPoP mode; protected browser API calls use `IAMService.secureFetch`.

## Tide login configuration

Hearth uses the current page origin with the callback URI `${origin}/auth/redirect` and silent-SSO URI `${origin}/silent-check-sso.html`. The local server serves the callback route from `public/auth/redirect.html`; the silent-check page is the SDK's shipped file. Register the exact callback URI and app origin in the TideCloak client's valid redirect URIs and web origins for each environment. For example, when Hearth runs at `http://localhost:3000`, allow `http://localhost:3000/auth/redirect` and `http://localhost:3000`. A login-status iframe `403` indicates the active app origin is not currently accepted by the realm/client configuration.

Protected API requests are verified server-side: the API validates token signature, issuer, expiration, subject, and client against the public key embedded in `tidecloak.json`, and validates the DPoP proof and replay state. The server intentionally does not fetch remote JWKS keys.

## Local video storage

The local filesystem is Hearth's storage server. When the upload workflow is enabled, multipart uploads are streamed through the authenticated API in 64 MiB parts, assembled atomically, and stored under the configured directory with restrictive file permissions. Playback uses a short-lived, HMAC-protected local URL after the access workflow is enabled; the URL expires after five minutes and is invalidated when the server restarts. Upload, playback, and membership-change API actions currently remain disabled with `503` until the Tide policy and E2EE requirements are met. Preview-mode file selection is browser-only and does not persist to the server. Do not expose the storage directory as a public web root or use this backend as a shared/production storage service.

Existing S3 objects are not copied automatically. Their metadata may remain in SQLite, but the local backend cannot read remote objects. Back up or migrate any data intentionally before changing storage configurations.

## API overview

All API routes require a valid Tide-bound access token and DPoP proof except `GET /api/health` and the short-lived bearer-capability recording URL (which is currently disabled by the policy gate).

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness check |
| `GET` | `/api/me` | Return the authenticated subject |
| `GET`, `POST` | `/api/repositories` | List the caller's repositories or create one |
| `GET` | `/api/repositories/:id/members` | List active subscribers |
| `GET`, `POST` | `/api/repositories/:id/membership-requests` | List or submit a membership request; guardian decisions are recorded but do not add members |
| `POST` | `/api/membership-requests/:id/decision` | Record an active guardian's approve/reject vote |
| `DELETE` | `/api/repositories/:id/members/me` | Leave currently fails closed with `503` |
| `GET` | `/api/repositories/:id/recordings` | List available recordings |
| `GET` | `/api/repositories/:id/audit-events` | List the latest 100 append-only repository workflow events |
| `GET` | `/api/repositories/:id/deletion-requests` | List recording deletion requests and vote status |
| `POST` | `/api/repositories/:id/recordings/uploads` | Currently fails closed with `503` until E2EE/ORK enforcement is ready |
| `POST` | `/api/recordings/:id/upload-parts` | Currently fails closed with `503` |
| `PUT` | `/api/recordings/:id/upload-parts/:partNumber` | Authenticated local-disk chunk upload; currently fails closed with `503` |
| `POST` | `/api/recordings/:id/complete` | Currently fails closed with `503` |
| `DELETE` | `/api/recordings/:id/upload` | Cancel an unfinished upload |
| `POST`, `GET` | `/api/recordings/:id/view-requests` | Create/list guardian approval requests; approvals do not grant playback |
| `POST` | `/api/recordings/:id/deletion-requests` | Request and track guardian approvals for a recording deletion |
| `GET` | `/api/repositories/:id/view-requests` | List pending, rejected, canceled, and approved view requests |
| `POST` | `/api/view-requests/:id/decision` | Record a guardian's approve/reject vote; playback remains disabled |
| `POST` | `/api/recording-deletion-requests/:id/decision` | Record a guardian's approve/reject vote; deletion remains disabled |
| `DELETE` | `/api/recordings/:id` | Actual deletion currently fails closed with `503` |
| `GET` | `/api/view-requests/:id/access` | Currently fails closed with `503`; no playback URL is issued |
| `GET` | `/api/recordings/:id/content?token=…` | Short-lived local playback capability; currently fails closed with `503` |

Run the automated checks with:

```bash
npm test
```
