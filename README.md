# HomeLock

**Demo prototype — never use real security footage.** HomeLock stores video keys on its server; an operator can access recordings or bypass app workflows. Guardian votes are application-managed, not TideCloak/ORK-enforced.

#### Vision & originality
HomeLock is a shared household archive where guardians manage recordings together. It combines family membership, recording access, and collective decisions in one experience.

#### Trust constraint insight
Families may avoid sharing sensitive recordings when access is unclear or one person controls decisions. HomeLock demonstrates requests and guardian votes before viewing or deleting; this prototype does not remove operator trust or provide end-to-end security.

#### Value & impact
Households can coordinate around important recordings with clearer shared oversight. For example, a guardian requests access to a clip, and the other guardians review the request before it is opened.

#### Why TideCloak matters
TideCloak signs users in. The API verifies their identity token and DPoP-bound requests, then uses the verified subject ID to identify guardians. This provides authenticated identity for the demonstration; HomeLock itself counts votes. TideCloak's fragmented keys and `QUORUM_THRESHOLD⁠` offer a path to enforce guardian participation at the cryptographic layer.

#### Prototype & storytelling
Sign in, create a repository, invite a guardian, upload a demo video, and submit a view request. Approve the request as the required guardians, then play the video. Notice the boundary: votes and key handling are application-managed.

## Setup
Requires Docker
```sh
sudo docker run \
--name mytidecloak \
-d \
-v .:/opt/keycloak/data/h2 \
-p 8080:8080 \
-e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
-e KC_BOOTSTRAP_ADMIN_PASSWORD=password \
tideorg/tidecloak-dev:latest
```
Run command above in the root directory. Create TideCloak server for authentication handling.

---
Requires Node.js 22.13+ 

```sh
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). Run `npm test` for tests.
