[![Built with TideCloak](https://tide.org/badges/built-with-tidecloak.svg)](https://tide.org/tidecloak?utm_source=github&utm_medium=readme&utm_campaign=unlocked)

# Hearth — Family video archive

A family-governed repository concept for home security camera recordings. Adult family members subscribe as guardians and share authority over their family archive.

## Product idea

- Adults in a family are linked subscribers and guardians of a repository.
- Video footage can be submitted to a repository for family members to retain and review.
- Every current subscriber must approve a new user's request before that user can join.
- Authority is shared rather than resting with one account. The concept uses guardian-linked key fragments and emergent authority.

The web interface is built with plain HTML, CSS, and JavaScript.

## TideCloak fit and limitations

TideCloak provides identity, threshold cryptography, shared policy-governed encryption, and quorum-governed identity administration. It does **not** provide this video repository or the application's unanimous-subscriber membership workflow out of the box. The application would need its own backend, repository model, membership and approval rules, and secure video storage.

Shared encryption can be built using TideCloak's policy-based encryption and Forseti authorization. The exact policy for subscriber membership and key-fragment governance must be designed and verified. A custom Forseti contract may be needed for the desired rules; contract deployment is not self-service and is currently handled by the Tide team for test-network evaluation. TideCloak's IGA quorum governs supported identity-administration changes; it is not automatically the approval workflow for joining an application repository.

## Current prototype

The current site is a browser-only interface demonstration:

- The sample recordings and guardian accounts are illustrative.
- Selected video files are previewed locally in the browser and are not uploaded or persisted.
- Invitation and approval interactions are local UI demonstrations, not authenticated subscriber consent.
- There is no backend, secure video storage, or server-side authorization yet.
- The TideCloak starter auth module is included, but a configured adapter and successful real login have not been verified.

**Do not use this prototype to store real footage or rely on it to enforce access control.** A production version needs a backend that verifies Tide tokens and DPoP proofs, plus authorized and encrypted storage for video recordings.

## Run locally

Install the package dependencies, then start the local development server:

```bash
npm install
npm run dev
```

Open the local URL printed by the development server. Without `public/tidecloak.json`, the site opens in clearly labeled preview mode. The local server also serves Tide's DPoP relay at its required routed URL with the required headers. A production host needs equivalent rewrite and header configuration.
