# HomeLock project specification

## Purpose

Build HomeLock, a family-governed archive for home-security recordings. A household creates a repository, invites or approves guardians, uploads recordings, and requests guardian approval before recordings can be viewed or deleted.

The project should work locally for development and testing, with recording files stored on the local filesystem and repository/workflow metadata stored in SQLite. Do not treat a local prototype as suitable for real security footage until its security properties and live TideCloak integration have been independently tested.

## Product requirements

### Accounts and sign-in

- Use TideCloak for authenticated user identities. Prefer TideCloak as the user directory; keep only the repository-specific application metadata in SQLite.
- Initialize the Tide IAM SDK once during application startup.
- Support sign-in, sign-out, callback handling, and graceful `initError`, `authError`, and `tokenExpired` states.
- The normal callback is `${origin}/auth/redirect`. That URL must resolve to a real callback page or application route.
- Keep callback and silent-SSO URLs consistent with the configured TideCloak client for each environment.

### Repositories and guardians

- An authenticated user can create a repository and manage its application metadata.
- Repository membership is made up of authenticated guardian identities.
- A user can ask to join a repository. The request must be visible on that repository to its current guardians.
- Every current guardian must approve a membership request before the applicant becomes a member. A rejection prevents the request from succeeding.
- Membership changes, including adding or removing guardians, must be governed by TideCloak-protected authority and the verified quorum policy. A SQLite vote count is not authorization.
- Repository membership and role checks must be performed server-side. Never rely on UI state or a client-supplied user ID, role, approval count, or repository membership claim without verifying its authority.

### Recordings

- A guardian can upload a recording to a repository, see its status and metadata, request access to view it, and request its deletion.
- Videos are stored on local disk for the development/testing configuration. SQLite stores recording metadata and workflow state, not video bytes.
- The browser should encrypt video content before upload. The API and storage operator must not need universal plaintext access.
- A view request must be approved by every other current guardian before the requester can decrypt or view the recording.
- A deletion request must be approved by every current guardian before the application deletes the recording and its associated metadata.
- Show clear request status, required and received approvals, decisions, and audit activity. Distinguish an application-recorded vote from authorization enforced by TideCloak.
- In-progress upload cancellation must not be confused with deletion of a completed recording.

### Repository key and cryptographic access

- Each repository has its own cryptographic key authority; do not reuse one global key across repositories.
- Fragment the repository key across the repository's guardians. No single guardian or application server should be able to reconstruct/use the repository key alone.
- Use TideCloak's ORK and a verified policy to require the necessary guardian participation when key material is used to decrypt a recording. The desired policy is unanimous approval by the applicable current guardians.
- Use a per-recording data-encryption key (DEK) for recording bytes and protect that DEK using the repository's guarded key authority. Keep plaintext and usable key material on the client only as required for the authorized operation.
- Use Tide-supported encryption inputs and outputs: encrypt/decrypt a `string` or `Uint8Array`, not an arbitrary JavaScript object. Define and test the exact serialization and encoding at the encryption boundary.
- Configure and verify all required Tide tag roles and policies for encryption and decryption. A valid login token, a UI approval, or a generic role check alone is not proof that quorum was enforced.
- Do not enable upload, playback/decryption, membership changes, or completed-recording deletion until the applicable Tide/ORK policy has been confirmed and end-to-end tests show the policy rejects missing, duplicate, stale, replayed, and requester-self approvals.

## Responsibility boundary

### TideCloak is responsible for

- Authenticated guardian identities.
- Roles and protected authority associated with repositories.
- Enforcing quorum-governed changes so one user cannot unilaterally add or remove guardians.
- Enforcing access to cryptographic operations so the platform does not need universal plaintext access.
- Enforcing the verified guardian participation policy for key use.

### HomeLock is responsible for

- Repository creation and application-level management.
- Video upload, local storage, and deletion workflows.
- Guardian invitation, join-request, and approval screens.
- Requests and status tracking for viewing and deleting recordings.
- Application metadata and an audit trail for requests and decisions.

HomeLock may record workflow state, but its database and UI are not security authorities. Security-sensitive outcomes must be checked and enforced by the API and TideCloak/ORK policy.

## Security and backend requirements

- Browser → sends bearer token to the HomeLock API.
- API → verifies the JWT using the configured realm's trusted JWKS, including signature, issuer, expiry, subject, and intended client/audience as applicable.
- API → performs server-side role and repository authorization checks before returning privileged data or performing privileged operations.
- Never trust client input blindly. The client cannot decide that a user is a guardian, that quorum is complete, that a key operation succeeded, or that a recording may be read/deleted.
- Keep secrets and private key material out of browser bundles, source control, logs, and ordinary metadata.
- Use HTTPS outside local development. Restrict CORS/origins and callback URLs to the intended application origins.
- If DPoP is enabled by the Tide integration, validate the proof server-side, bind it to the request and token, and reject replayed proofs.
- Store uploaded files outside the public web root, use safe generated storage names, restrict filesystem permissions, validate upload size/type, and prevent path traversal.
- Use short-lived, scoped capabilities only where required for media transfer; never expose a direct path to stored files.
- Keep an audit record of repository and workflow actions. Explain that a SQLite audit log is not tamper-proof against someone with direct database/file access.
- Fail closed when identity verification, authorization, quorum enforcement, or cryptographic policy is unavailable. Return an explicit error instead of success-shaped fallback behavior.

## Proposed starter layout

Use this lightweight browser application layout as the starting point. Add server/API and database modules where needed; do not force backend code into the browser files.

```text
my-app/
├─ index.html
├─ main.js
├─ tidecloak.json
├─ public/
│  └─ auth/
│     └─ redirect.html
├─ package.json
└─ vite.config.js
```

Never commit credentials or private keys. The Tide adapter/configuration file must contain only the public client/realm configuration and public verification keys intended for the browser/application. Keep any server-only configuration in environment variables or a non-public server-side file.

## Redirect URI

- Default: `${origin}/auth/redirect`
- If you don't create `public/auth/redirect.html` (or custom route), post-auth the browser will 404.
- You can override `redirectUri` in `initIAM({ ...config, redirectUri })`, but the route/file **must exist**.
- Register the exact callback URL and application origin in the TideCloak client's valid redirect URI and web-origin settings.
- Also provide the SDK's required silent-SSO page, commonly `public/silent-check-sso.html`, and register/use its exact URL where required by the SDK.

## Backend Validation Pattern

- Browser → sends bearer token to your API
- API → verifies JWT via your realm's JWKS (never trust client input blindly)
- API → responds with privileged data only if verification & role checks pass

For a DPoP-enabled configuration, also validate the DPoP proof, request binding, and replay protection. Never use browser-only role checks as the backend authorization boundary.

## Common Pitfalls

- Missing `public/silent-check-sso.html`
- Missing redirect route/file for default or custom `redirectUri`
- Encrypting objects instead of **string/Uint8Array**
- Missing required tag roles for E2EE
- Not handling `tokenExpired` (edge sessions, long-lived tabs)
- Treating a recorded SQLite approval or UI vote as Tide/ORK-enforced quorum
- Treating local-disk storage or authenticated transport as end-to-end encryption
- Serving recordings directly from a public directory or trusting a client-supplied file path
- Assuming that successful Tide login alone provisions repository roles or enforces a custom unanimous-guardian rule

## Local development and test expectations

- Use port `3000` by default for local development and browser/API testing. Keep it configurable through the standard Vite/server configuration.
- Keep recording bytes on local disk and metadata in SQLite for the local test configuration; do not require S3 or another hosted storage service for core local workflows.
- Provide a clear preview/demo mode if TideCloak is unavailable, but make it unmistakable that preview identities, approvals, and recordings are not authenticated or persisted security state.
- Include automated tests for token verification, authorization, repository membership, request/vote transitions, upload validation/storage, encryption boundaries, and fail-closed behavior.
- Include end-to-end tests for the real Tide login callback and cryptographic quorum policy before claiming protected workflows are complete.

## Completion criteria

The project is complete only when:

1. Users can sign in through the configured TideCloak realm and return through a working callback page.
2. A user can create a repository and authenticated guardians can see its membership and workflow state.
3. A join request appears on the repository and only becomes membership after every current guardian approves it and TideCloak enforces the required authority change.
4. Recordings are encrypted in the browser before local upload, and stored bytes do not reveal plaintext to the application server or filesystem operator.
5. A requester can view/decrypt a recording only after all required guardians participate and the Tide/ORK policy authorizes key use.
6. A completed recording is deleted only after the verified deletion quorum authorizes it.
7. The app records request/decision status and audit events without presenting application-side records as cryptographic proof.
8. Negative tests prove that unauthenticated, unauthorized, incomplete-quorum, replayed, stale, or malformed requests fail closed.

Until the unanimous-guardian Tide/ORK policy is verified and deployed, the project must clearly label sensitive workflows as unavailable and must not bypass the policy gate to make the UI appear functional.

## Open integration dependency

The exact Tide/ORK contract for binding distinct current guardian approvals to a repository key operation and membership change must be confirmed with TideCloak and tested against the target realm/network version. A built-in relationship policy that checks a user, group, or role is not by itself proof that every current guardian approved a specific operation. Keep the security gate closed until the required policy and evidence format are verified.
