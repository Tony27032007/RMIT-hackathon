import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { createHash, randomUUID } from "node:crypto";
import { createHomeLockServer } from "../server.js";

let server;
let database;
let baseUrl;

before(async () => {
  ({ server, database } = createHomeLockServer({
    env: { APP_ORIGIN: "http://127.0.0.1:3000" },
    databasePath: ":memory:",
    adapterPath: resolve("tests/fixtures/missing-tidecloak.json"),
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  database?.close();
});

test("health response identifies application-managed quorum workflows", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.authConfigured, false);
  assert.equal(body.gates.guardianMembership, "application-quorum");
  assert.equal(body.gates.encryptedUploads, "application-quorum");
  assert.equal(body.gates.recordingPlayback, "application-quorum");
  assert.equal(body.gates.recordingDeletion, "application-quorum");
  assert.equal(body.gates.tideOrkQuorum, false);
});

test("configuration endpoint labels application-managed quorum", async () => {
  const response = await fetch(`${baseUrl}/api/config`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.authConfigured, false);
  assert.equal(body.redirectUri, "http://127.0.0.1:3000/auth/redirect");
  assert.equal(body.clientOriginAuthConfigured, false);
  assert.equal(body.quorumMode, "homeLock-application-managed");
  assert.match(body.notice, /not Tide\/ORK/);
});

test("configured OAuth callback path serves the built callback page", async () => {
  const response = await fetch(`${baseUrl}/auth/redirect?state=test&code=not-a-real-code`);
  const page = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(page, /Completing login/);
  const callbackScriptPath = /src="([^"]*\/assets\/redirect-[^"]+\.js)"/.exec(page)?.[1];
  assert.ok(callbackScriptPath, "the callback page should load its compiled Tide handler");
  const callbackScriptResponse = await fetch(new URL(callbackScriptPath, baseUrl));
  assert.equal(callbackScriptResponse.status, 200);
  assert.match(await callbackScriptResponse.text(), /initIAM/);
});

test("repository endpoints fail closed without configured Tide identity verification", async () => {
  const response = await fetch(`${baseUrl}/api/repositories`);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error, "AUTH_NOT_CONFIGURED");
});

test("protected workflows still require verified Tide authentication", async () => {
  for (const [path, method] of [
    [`/api/repositories/${randomUUID()}/files`, "GET"],
    [`/api/repositories/${randomUUID()}/members`, "GET"],
    [`/api/repositories/${randomUUID()}/requests`, "GET"],
  ]) {
    const response = await fetch(`${baseUrl}${path}`, { method });
    const body = await response.json();
    assert.equal(response.status, 503, `${method} ${path} must require configured identity verification`);
    assert.equal(body.error, "AUTH_NOT_CONFIGURED");
  }
});

test("repository creation rejects a cross-origin browser request", async () => {
  const response = await fetch(`${baseUrl}/api/repositories`, {
    method: "POST",
    headers: {
      origin: "https://unexpected.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Test" }),
  });
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.error, "ORIGIN_NOT_ALLOWED");
});

test("authenticated users can create and list their own repositories", async () => {
  const appOrigin = "http://127.0.0.1:3000";
  const issuer = "https://identity.example/realms/homelocker";
  const clientId = "homelock-client";
  const subject = "tide-user-123";
  const adapterDir = mkdtempSync(join(tmpdir(), "homelock-api-test-"));
  const adapterPath = join(adapterDir, "tidecloak.json");
  const { publicKey: signingKey, privateKey: signingPrivateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const signingJwk = await exportJWK(signingKey);
  signingJwk.kid = "test-signing-key";
  signingJwk.alg = "RS256";
  signingJwk.use = "sig";
  const { publicKey: proofKey, privateKey: proofPrivateKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const proofJwk = await exportJWK(proofKey);
  const jkt = await calculateJwkThumbprint(proofJwk, "sha256");
  writeFileSync(adapterPath, JSON.stringify({
    "auth-server-url": "https://identity.example",
    realm: "homelocker",
    resource: clientId,
    jwk: { keys: [signingJwk] },
  }));
  const authenticatedApp = createHomeLockServer({
    env: {
      APP_ORIGIN: appOrigin,
      TIDECLOAK_AUDIENCE: clientId,
    },
    databasePath: ":memory:",
    adapterPath,
  });

  try {
    await new Promise((resolve) => authenticatedApp.server.listen(0, "127.0.0.1", resolve));
    const token = await new SignJWT({ azp: clientId, cnf: { jkt } })
      .setProtectedHeader({ alg: "RS256", kid: signingJwk.kid })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signingPrivateKey);

    async function authenticatedRequest(path, method, body) {
      const proof = await new SignJWT({
        jti: randomUUID(),
        htm: method,
        htu: `${appOrigin}${path}`,
        iat: Math.floor(Date.now() / 1000),
        ath: createHash("sha256").update(token).digest("base64url"),
      })
        .setProtectedHeader({
          typ: "dpop+jwt",
          alg: "ES256",
          jwk: { kty: proofJwk.kty, crv: proofJwk.crv, x: proofJwk.x, y: proofJwk.y },
        })
        .sign(proofPrivateKey);
      return fetch(`http://127.0.0.1:${authenticatedApp.server.address().port}${path}`, {
        method,
        headers: {
          authorization: `DPoP ${token}`,
          dpop: proof,
          origin: appOrigin,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    }

    const createResponse = await authenticatedRequest("/api/repositories", "POST", {
      name: "Family archive",
      description: "Home metadata",
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.repository.name, "Family archive");

    const listResponse = await authenticatedRequest("/api/repositories", "GET");
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json();
    assert.equal(listed.repositories.length, 1);
    assert.equal(listed.repositories[0].id, created.repository.id);
    const detailResponse = await authenticatedRequest(
      `/api/repositories/${created.repository.id}`,
      "GET",
    );
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.repository.id, created.repository.id);
    assert.equal(detail.currentUserId, subject);
    assert.deepEqual(detail.files, []);
    assert.deepEqual(detail.guardians, [{ userId: subject }]);
    assert.equal(detail.gates.fileUpload, "application-quorum");
    assert.equal(detail.gates.fileRemoval, "application-quorum");
    assert.equal(detail.gates.guardianMembership, "application-quorum");

    const otherRepositoryId = randomUUID();
    authenticatedApp.database.prepare(`
      INSERT INTO repositories (id, creator_user_id, name, description, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(otherRepositoryId, "another-user", "Private repository", "", new Date().toISOString());
    const forbiddenDetailResponse = await authenticatedRequest(
      `/api/repositories/${otherRepositoryId}`,
      "GET",
    );
    assert.equal(forbiddenDetailResponse.status, 404);
    assert.equal((await forbiddenDetailResponse.json()).error, "NOT_FOUND");
    assert.equal(
      authenticatedApp.database.prepare("SELECT actor_user_id FROM audit_events WHERE repository_id = ?")
        .get(created.repository.id).actor_user_id,
      subject,
    );
  } finally {
    await new Promise((resolve, reject) => {
      authenticatedApp.server.close((error) => error ? reject(error) : resolve());
    });
    authenticatedApp.database.close();
    rmSync(adapterDir, { recursive: true, force: true });
  }
});

test("DPoP relay is served byte-exact with the required relay header", async () => {
  const response = await fetch(`${baseUrl}/tide_dpop/iss/abcd/aud/1234/tide_dpop_auth.html`);
  const body = Buffer.from(await response.arrayBuffer());
  const expected = readFileSync(new URL("../public/tide_dpop_auth.html", import.meta.url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("allow-csp-from"), "*");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'self'; script-src 'unsafe-inline'");
  assert.equal(createHash("sha256").update(body).digest("hex"), createHash("sha256").update(expected).digest("hex"));
});
