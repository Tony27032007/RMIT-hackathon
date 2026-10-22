[![Built with TideCloak](https://tide.org/badges/built-with-tidecloak.svg)](https://tide.org/tidecloak?utm_source=github&utm_medium=readme&utm_campaign=unlocked)

# Hearth — Family video archive

Hearth is a family-governed repository for home-security recordings. Adult family members subscribe as guardians and share authority over repository membership and recording views. The interface uses plain HTML, CSS, and JavaScript; the local API is Node.js with SQLite metadata and private S3-compatible object storage.

## Current capabilities

- TideCloak-backed account authentication for protected API routes, including access-token verification against the adapter's embedded JWKS and DPoP proof validation with replay protection.
- Create and list repositories, view their active subscribers, request membership by repository ID, and leave a repository.
- Require every active subscriber at request time to approve a new member. A rejection is terminal. The requester is added only after every required approval.
- Upload videos directly to a private S3-compatible bucket using multipart uploads. SQLite reserves quota transactionally and enforces a 10 GiB total per repository. Completed recordings are not deleted by the app.
- Request a recording view. Every active subscriber in the approval snapshot, including the requester, must approve; only the requester then receives a five-minute presigned download URL.
- When a guardian leaves, pending membership and view requests that included that guardian are canceled with the reason `Request canceled due to guardian leaving`, and their recorded approvals are cleared.
- Preview mode remains available without a Tide adapter; its sample guardians, recordings, and approvals are browser-only demonstrations.

## Important security boundaries

The membership and view quorums are enforced by Hearth's SQLite-backed application logic. They are **not** an ORK-enforced cryptographic quorum or a custom Forseti policy. A compromised or malicious backend operator could bypass these app-level decisions.

S3 server-side encryption (`AES256`) is requested for stored objects. Video bytes are **not end-to-end encrypted** by this prototype, so storage encryption does not prevent the S3 account or a sufficiently privileged service operator from accessing objects. Tide identity and DPoP protect API authentication; they do not themselves encrypt recordings or enforce the custom approval rules.

No Tide adapter, production realm, S3 bucket, or AWS credentials are included. The integration has not been exercised against a live TideCloak realm or S3 service. Age verification for adult family accounts is unresolved and is not implemented. Do not use this prototype for real security footage until the threat model, cryptographic policy, operator access, and live integrations have been independently reviewed and tested.

## Run locally

Use Node.js 22.13 or later:

```bash
npm install
cp .env.example .env
npm run dev
```

Open the local URL printed by the server. Without `public/tidecloak.json`, Hearth runs in preview mode and protected API requests fail closed with `503`. To enable authenticated mode, provide a Tide-specific adapter at the configured `TIDECLOAK_ADAPTER_PATH`. It must include `auth-server-url`, `realm`, `resource`, and a non-empty embedded `jwk.keys` array. Remote JWKS fallback is intentionally not used.

The local server serves only the browser SDK modules needed by the Tide adapter from the installed dependencies. The SDK initializes with strict ES256 DPoP mode; protected browser API calls use `IAMService.secureFetch`.

## S3 setup

Configure a private bucket and the AWS SDK credential chain/profile in the local environment. Never commit credentials. `.env.example` shows the supported settings. The app server does not store video bytes.

For browser multipart uploads and playback, configure bucket CORS for the exact local origin (normally `http://localhost:3000`):

- Allowed methods: `PUT`, `GET`, and `HEAD`.
- Allowed headers: `*`.
- Expose response headers: `ETag`, `Accept-Ranges`, `Content-Range`, `Content-Length`, and `Content-Type`.

The browser requires access to `ETag` to complete multipart uploads. Confirm the bucket remains private and that presigned URLs are the only object access granted to the browser. Upload parts use 64 MiB chunks; signed upload and download URLs expire after five minutes.

## API overview

All routes require a valid Tide-bound access token and DPoP proof except `GET /api/health`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness check |
| `GET` | `/api/me` | Return the authenticated subject |
| `GET`, `POST` | `/api/repositories` | List the caller's repositories or create one |
| `GET` | `/api/repositories/:id/members` | List active subscribers |
| `GET`, `POST` | `/api/repositories/:id/membership-requests` | List pending/canceled requests or request membership |
| `POST` | `/api/membership-requests/:id/decision` | Approve or reject membership |
| `DELETE` | `/api/repositories/:id/members/me` | Leave a repository |
| `GET` | `/api/repositories/:id/recordings` | List available recordings |
| `POST` | `/api/repositories/:id/recordings/uploads` | Reserve quota and start multipart upload |
| `POST` | `/api/recordings/:id/upload-parts` | Sign a bounded batch of upload parts |
| `POST` | `/api/recordings/:id/complete` | Verify uploaded parts and finalize |
| `DELETE` | `/api/recordings/:id/upload` | Cancel an unfinished upload |
| `POST`, `GET` | `/api/recordings/:id/view-requests` | Request a view or list its requests |
| `GET` | `/api/repositories/:id/view-requests` | List pending, approved, and canceled view requests |
| `POST` | `/api/view-requests/:id/decision` | Approve or reject a view request |
| `GET` | `/api/view-requests/:id/access` | Give the approved requester a short-lived download URL |

Run the automated checks with:

```bash
npm test
```
