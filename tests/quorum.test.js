import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createHomeLockServer } from "../server.js";

const appOrigin = "http://127.0.0.1:3000";
const clientId = "homelock-client";
const subjects = ["guardian-alice", "guardian-bob", "guardian-carol"];
const temporaryDirectory = mkdtempSync(join(tmpdir(), "homelock-quorum-test-"));
let app;
let baseUrl;
let proofKey;
let proofPrivateKey;
let proofJwk;
let signingPrivateKey;
let signingJwk;
let jkt;

before(async () => {
  const { publicKey: signingKey, privateKey: privateSigningKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  signingPrivateKey = privateSigningKey;
  signingJwk = await exportJWK(signingKey);
  signingJwk.kid = "test-signing-key";
  signingJwk.alg = "RS256";
  signingJwk.use = "sig";
  const proofPair = await generateKeyPair("ES256", { extractable: true });
  proofKey = proofPair.publicKey;
  proofPrivateKey = proofPair.privateKey;
  proofJwk = await exportJWK(proofKey);
  jkt = await calculateJwkThumbprint(proofJwk, "sha256");

  const adapterPath = join(temporaryDirectory, "tidecloak.json");
  writeFileSync(adapterPath, JSON.stringify({
    "auth-server-url": "https://identity.example",
    realm: "homelocker",
    resource: clientId,
    jwk: { keys: [signingJwk] },
  }));
  app = createHomeLockServer({
    env: { APP_ORIGIN: appOrigin, TIDECLOAK_AUDIENCE: clientId },
    databasePath: ":memory:",
    adapterPath,
    recordingsPath: join(temporaryDirectory, "recordings"),
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  if (app) {
    await new Promise((resolve, reject) => {
      app.server.close((error) => error ? reject(error) : resolve());
    });
    app.database.close();
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

async function authenticatedRequest(subject, path, method, body, headers = {}) {
  const token = await new SignJWT({ azp: clientId, cnf: { jkt } })
    .setProtectedHeader({ alg: "RS256", kid: signingJwk.kid })
    .setIssuer("https://identity.example/realms/homelocker")
    .setAudience(clientId)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingPrivateKey);
  const proof = await new SignJWT({
    jti: randomUUID(),
    htm: method,
    htu: (() => {
      const requestUrl = new URL(path, appOrigin);
      return `${requestUrl.origin}${requestUrl.pathname}`;
    })(),
    iat: Math.floor(Date.now() / 1000),
    ath: createHash("sha256").update(token).digest("base64url"),
  })
    .setProtectedHeader({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: { kty: proofJwk.kty, crv: proofJwk.crv, x: proofJwk.x, y: proofJwk.y },
    })
    .sign(proofPrivateKey);
  return fetch(new URL(path, baseUrl), {
    method,
    headers: {
      authorization: `DPoP ${token}`,
      dpop: proof,
      origin: appOrigin,
      ...headers,
    },
    ...(body !== undefined ? { body } : {}),
  });
}

async function jsonRequest(subject, path, method, body) {
  return authenticatedRequest(subject, path, method, JSON.stringify(body), {
    "content-type": "application/json",
  });
}

async function readJson(response) {
  return response.json();
}

test("app quorum snapshots guardians, enforces exact votes, and invalidates stale requests", async () => {
  const createResponse = await jsonRequest(subjects[0], "/api/repositories", "POST", {
    name: "Quorum test",
    description: "",
  });
  assert.equal(createResponse.status, 201);
  const { repository } = await readJson(createResponse);
  const prefix = `/api/repositories/${repository.id}`;

  const inviteResponse = await jsonRequest(subjects[0], `${prefix}/requests`, "POST", {
    type: "guardian-invite",
    userId: subjects[1],
  });
  assert.equal(inviteResponse.status, 201);
  const invite = (await readJson(inviteResponse)).request;
  assert.equal(invite.requiredApprovals, 1);
  const inviteVote = await jsonRequest(subjects[0], `${prefix}/requests/${invite.id}/votes`, "POST", {
    decision: "approve",
  });
  assert.equal(inviteVote.status, 200);
  assert.equal((await readJson(inviteVote)).request.status, "approved");

  const guardiansResponse = await jsonRequest(subjects[1], `${prefix}/members`, "GET");
  assert.equal(guardiansResponse.status, 200);
  assert.deepEqual((await readJson(guardiansResponse)).guardians, subjects.slice(0, 2));

  const videoPlaintext = Buffer.from("home-lock encrypted video payload");
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(videoPlaintext), cipher.final(), cipher.getAuthTag()]);
  const uploadResponse = await authenticatedRequest(
    subjects[0],
    `${prefix}/files`,
    "POST",
    encrypted,
    {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent("entry-camera.mp4"),
      "x-file-content-type": "video/mp4",
      "x-encryption-iv": iv.toString("base64url"),
      "x-encryption-key": key.toString("base64url"),
    },
  );
  assert.equal(uploadResponse.status, 201);
  const { file } = await readJson(uploadResponse);

  const viewResponse = await jsonRequest(subjects[1], `${prefix}/requests`, "POST", {
    type: "view",
    fileId: file.id,
  });
  assert.equal(viewResponse.status, 201);
  const viewRequest = (await readJson(viewResponse)).request;
  assert.equal(viewRequest.requiredApprovals, 1);
  const selfVote = await jsonRequest(subjects[1], `${prefix}/requests/${viewRequest.id}/votes`, "POST", {
    decision: "approve",
  });
  assert.equal(selfVote.status, 403);
  assert.equal((await readJson(selfVote)).error, "NOT_AN_APPROVER");

  const approvedView = await jsonRequest(subjects[0], `${prefix}/requests/${viewRequest.id}/votes`, "POST", {
    decision: "approve",
  });
  assert.equal(approvedView.status, 200);
  assert.equal((await readJson(approvedView)).request.status, "approved");

  const contentResponse = await authenticatedRequest(
    subjects[1],
    `${prefix}/files/${file.id}/content?requestId=${viewRequest.id}`,
    "GET",
  );
  assert.equal(contentResponse.status, 200);
  const delivered = Buffer.from(await contentResponse.arrayBuffer());
  const deliveredKey = Buffer.from(contentResponse.headers.get("x-homelock-encryption-key"), "base64url");
  const deliveredIv = Buffer.from(contentResponse.headers.get("x-homelock-encryption-iv"), "base64url");
  assert.equal(deliveredKey.toString("base64url"), key.toString("base64url"));
  assert.equal(deliveredIv.toString("base64url"), iv.toString("base64url"));
  const decipher = createDecipheriv("aes-256-gcm", deliveredKey, deliveredIv);
  decipher.setAuthTag(delivered.subarray(-16));
  const plaintext = Buffer.concat([
    decipher.update(delivered.subarray(0, -16)),
    decipher.final(),
  ]);
  assert.deepEqual(plaintext, videoPlaintext);
  const replayedView = await authenticatedRequest(
    subjects[1],
    `${prefix}/files/${file.id}/content?requestId=${viewRequest.id}`,
    "GET",
  );
  assert.equal(replayedView.status, 409);
  assert.equal((await readJson(replayedView)).error, "VIEW_REQUEST_CONSUMED");

  const deleteResponse = await jsonRequest(subjects[1], `${prefix}/requests`, "POST", {
    type: "delete",
    fileId: file.id,
  });
  assert.equal(deleteResponse.status, 201);
  const deletion = (await readJson(deleteResponse)).request;
  assert.equal(deletion.requiredApprovals, 2);
  const firstDeleteVote = await jsonRequest(subjects[1], `${prefix}/requests/${deletion.id}/votes`, "POST", {
    decision: "approve",
  });
  assert.equal((await readJson(firstDeleteVote)).request.status, "pending");
  const finalDeleteVote = await jsonRequest(subjects[0], `${prefix}/requests/${deletion.id}/votes`, "POST", {
    decision: "approve",
  });
  assert.equal((await readJson(finalDeleteVote)).request.status, "approved");

  const uploadAgain = await authenticatedRequest(
    subjects[0],
    `${prefix}/files`,
    "POST",
    encrypted,
    {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent("entry-camera.mp4"),
      "x-file-content-type": "video/mp4",
      "x-encryption-iv": iv.toString("base64url"),
      "x-encryption-key": key.toString("base64url"),
    },
  );
  const secondFile = (await readJson(uploadAgain)).file;
  const staleViewResponse = await jsonRequest(subjects[1], `${prefix}/requests`, "POST", {
    type: "view",
    fileId: secondFile.id,
  });
  const staleView = (await readJson(staleViewResponse)).request;
  assert.equal(staleView.status, "pending");

  const leaveResponse = await authenticatedRequest(subjects[0], `${prefix}/members/me`, "DELETE");
  assert.equal(leaveResponse.status, 200);
  const requestsResponse = await authenticatedRequest(subjects[1], `${prefix}/requests`, "GET");
  const requests = (await readJson(requestsResponse)).requests;
  assert.equal(requests.find((request) => request.id === staleView.id).status, "expired");

  const staleVote = await jsonRequest(subjects[0], `${prefix}/requests/${staleView.id}/votes`, "POST", {
    decision: "approve",
  });
  assert.equal(staleVote.status, 409);
  assert.equal((await readJson(staleVote)).error, "REQUEST_NOT_PENDING");
});

test("one-guardian view requests are approved without a self-vote; invite rejection blocks membership", async () => {
  const createResponse = await jsonRequest(subjects[2], "/api/repositories", "POST", {
    name: "Solo test",
    description: "",
  });
  const { repository } = await readJson(createResponse);
  const prefix = `/api/repositories/${repository.id}`;

  const inviteResponse = await jsonRequest(subjects[2], `${prefix}/requests`, "POST", {
    type: "guardian-invite",
    userId: subjects[0],
  });
  const invite = (await readJson(inviteResponse)).request;
  const rejectedResponse = await jsonRequest(subjects[2], `${prefix}/requests/${invite.id}/votes`, "POST", {
    decision: "reject",
  });
  assert.equal((await readJson(rejectedResponse)).request.status, "rejected");
  const memberResponse = await authenticatedRequest(subjects[0], `${prefix}/members`, "GET");
  assert.equal(memberResponse.status, 404);
});

test("non-members can request to join and become guardians only after the full roster approves", async () => {
  const createResponse = await jsonRequest(subjects[0], "/api/repositories", "POST", {
    name: "Join test",
    description: "",
  });
  const { repository } = await readJson(createResponse);
  const prefix = `/api/repositories/${repository.id}`;
  const joinResponse = await jsonRequest(subjects[2], `${prefix}/requests`, "POST", {
    type: "join",
  });
  assert.equal(joinResponse.status, 201);
  const joinRequest = (await readJson(joinResponse)).request;
  assert.equal(joinRequest.requiredApprovals, 1);

  const voteResponse = await jsonRequest(subjects[0], `${prefix}/requests/${joinRequest.id}/votes`, "POST", {
    decision: "approve",
  });
  assert.equal((await readJson(voteResponse)).request.status, "approved");
  const membersResponse = await authenticatedRequest(subjects[2], `${prefix}/members`, "GET");
  assert.equal(membersResponse.status, 200);
  assert.deepEqual((await readJson(membersResponse)).guardians, [subjects[0], subjects[2]]);
});
