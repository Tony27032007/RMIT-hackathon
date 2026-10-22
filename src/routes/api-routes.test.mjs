import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { openDatabase } from "../db/database.mjs";
import { createApiRouter } from "./api-routes.mjs";

const issuer = "https://identity.example/realms/hearth";
const clientId = "hearth-client";
const host = "localhost:3000";
const accessKeys = await generateKeyPair("RS256");
const accessJwk = {
  ...(await exportJWK(accessKeys.publicKey)),
  kid: "test-access-key",
  alg: "RS256",
  use: "sig",
};
const proofKeys = await generateKeyPair("ES256", { extractable: true });
const proofJwk = await exportJWK(proofKeys.publicKey);
const proofJkt = await calculateJwkThumbprint(proofJwk);
const compactProofJwk = {
  crv: proofJwk.crv,
  kty: proofJwk.kty,
  x: proofJwk.x,
  y: proofJwk.y,
};

async function makeAuthenticatedRequest(method, path, body, subject = "guardian-1") {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await new SignJWT({
    azp: clientId,
    cnf: { jkt: proofJkt },
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key", typ: "JWT" })
    .setIssuer(issuer)
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(accessKeys.privateKey);
  const ath = Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from(accessToken))).toString("base64url");
  const proof = await new SignJWT({
    ath,
    htm: method,
    htu: `http://${host}${path}`,
    iat: now,
    jti: crypto.randomUUID(),
  })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: compactProofJwk })
    .sign(proofKeys.privateKey);
  const serializedBody = body === undefined ? "" : JSON.stringify(body);

  return {
    url: path,
    method,
    headers: {
      host,
      authorization: `DPoP ${accessToken}`,
      dpop: proof,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    async *[Symbol.asyncIterator]() {
      if (serializedBody) yield Buffer.from(serializedBody);
    },
  };
}

function captureResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = "") {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

test("router authenticates protected repository APIs and dispatches valid requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hearth-router-"));
  const adapterPath = join(directory, "tidecloak.json");
  const adapter = {
    "auth-server-url": "https://identity.example",
    realm: "hearth",
    resource: clientId,
    jwk: { keys: [accessJwk] },
  };
  await writeFile(adapterPath, JSON.stringify(adapter));
  const db = await openDatabase(":memory:");
  const routeApi = createApiRouter({
    db,
    env: { TIDECLOAK_ADAPTER_PATH: adapterPath },
  });

  try {
    const created = captureResponse();
    assert.equal(
      await routeApi(
        await makeAuthenticatedRequest("POST", "/api/repositories", { name: "Family Home" }),
        created,
        "/api/repositories",
      ),
      true,
    );
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().repository.name, "Family Home");
    const repositoryId = created.json().repository.id;
    const now = new Date().toISOString();
    const insertMember = db.prepare(`
      INSERT INTO repository_members (repository_id, subject_id, role, status, joined_at)
      VALUES (?, ?, 'guardian', 'active', ?)
    `);
    insertMember.run(repositoryId, "guardian-2", now);
    insertMember.run(repositoryId, "guardian-3", now);
    db.prepare(`
      INSERT INTO recordings
        (id, repository_id, uploader_subject_id, object_key, filename, content_type, size_bytes, status, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)
    `).run(
      "10000000-0000-4000-8000-000000000009",
      repositoryId,
      "guardian-1",
      `repositories/${repositoryId}/recordings/10000000-0000-4000-8000-000000000009`,
      "camera.mp4",
      "video/mp4",
      1024,
      now,
      now,
    );

    await assert.rejects(
      routeApi(
        await makeAuthenticatedRequest("POST", `/api/repositories/${repositoryId}/recordings/uploads`, {
          filename: "camera.mp4",
          contentType: "video/mp4",
          sizeBytes: 1024,
        }),
        captureResponse(),
        `/api/repositories/${repositoryId}/recordings/uploads`,
      ),
      (error) => error.status === 503 && /guardian-quorum/.test(error.message),
    );
    const membershipRequest = captureResponse();
    await routeApi(
      await makeAuthenticatedRequest(
        "POST",
        `/api/repositories/${repositoryId}/membership-requests`,
        {},
        "new-guardian",
      ),
      membershipRequest,
      `/api/repositories/${repositoryId}/membership-requests`,
    );
    assert.equal(membershipRequest.statusCode, 201);
    assert.equal(membershipRequest.json().policyStatus, "not_configured");
    const applicantRequests = captureResponse();
    await routeApi(
      await makeAuthenticatedRequest(
        "GET",
        `/api/repositories/${repositoryId}/membership-requests`,
        undefined,
        "new-guardian",
      ),
      applicantRequests,
      `/api/repositories/${repositoryId}/membership-requests`,
    );
    assert.equal(applicantRequests.json().requests[0].id, membershipRequest.json().requestId);
    const requests = captureResponse();
    await routeApi(
      await makeAuthenticatedRequest("GET", `/api/repositories/${repositoryId}/membership-requests`),
      requests,
      `/api/repositories/${repositoryId}/membership-requests`,
    );
    assert.equal(requests.json().requests[0].requester_subject_id, "new-guardian");
    assert.equal(requests.json().requests[0].approval_complete, 0);
    const audit = captureResponse();
    await routeApi(
      await makeAuthenticatedRequest("GET", `/api/repositories/${repositoryId}/audit-events`),
      audit,
      `/api/repositories/${repositoryId}/audit-events`,
    );
    assert.deepEqual(
      audit.json().events.map((event) => event.event_type),
      ["membership.requested", "repository.created"],
    );

    const recordingId = "10000000-0000-4000-8000-000000000009";
    const viewRequest = captureResponse();
    await routeApi(
      await makeAuthenticatedRequest("POST", `/api/recordings/${recordingId}/view-requests`, {}),
      viewRequest,
      `/api/recordings/${recordingId}/view-requests`,
    );
    assert.equal(viewRequest.statusCode, 201);
    assert.equal(viewRequest.json().requiredApprovals, 2);
    for (const [subject, expectedStatus] of [
      ["guardian-2", "pending"],
      ["guardian-3", "awaiting_tide_policy"],
    ]) {
      const vote = captureResponse();
      await routeApi(
        await makeAuthenticatedRequest(
          "POST",
          `/api/view-requests/${viewRequest.json().requestId}/decision`,
          { decision: "approve" },
          subject,
        ),
        vote,
        `/api/view-requests/${viewRequest.json().requestId}/decision`,
      );
      assert.equal(vote.json().status, expectedStatus);
    }

    const access = captureResponse();
    await assert.rejects(
      routeApi(
        await makeAuthenticatedRequest(
          "GET",
          `/api/view-requests/${viewRequest.json().requestId}/access`,
        ),
        access,
        `/api/view-requests/${viewRequest.json().requestId}/access`,
      ),
      (error) => error.status === 503 && /guardian-quorum/.test(error.message),
    );

    const deletionRequest = captureResponse();
    await routeApi(
      await makeAuthenticatedRequest("POST", `/api/recordings/${recordingId}/deletion-requests`, {}),
      deletionRequest,
      `/api/recordings/${recordingId}/deletion-requests`,
    );
    assert.equal(deletionRequest.statusCode, 201);
    assert.equal(deletionRequest.json().requiredApprovals, 2);
    const deletionVote = captureResponse();
    await routeApi(
      await makeAuthenticatedRequest(
        "POST",
        `/api/recording-deletion-requests/${deletionRequest.json().requestId}/decision`,
        { decision: "reject" },
        "guardian-2",
      ),
      deletionVote,
      `/api/recording-deletion-requests/${deletionRequest.json().requestId}/decision`,
    );
    assert.equal(deletionVote.json().status, "rejected");
    const deletionList = captureResponse();
    await routeApi(
      await makeAuthenticatedRequest("GET", `/api/repositories/${repositoryId}/deletion-requests`),
      deletionList,
      `/api/repositories/${repositoryId}/deletion-requests`,
    );
    assert.equal(deletionList.json().requests[0].status, "rejected");

    await assert.rejects(
      routeApi(
        await makeAuthenticatedRequest("DELETE", `/api/recordings/${recordingId}`),
        captureResponse(),
        `/api/recordings/${recordingId}`,
      ),
      (error) => error.status === 503 && /guardian-quorum/.test(error.message),
    );
    const requestId = "10000000-0000-4000-8000-000000000002";
    await assert.rejects(
      routeApi(
        await makeAuthenticatedRequest("GET", `/api/view-requests/${requestId}/access`),
        captureResponse(),
        `/api/view-requests/${requestId}/access`,
      ),
      (error) => error.status === 503 && /guardian-quorum/.test(error.message),
    );
    await assert.rejects(
      routeApi(
        { method: "GET", url: `/api/recordings/${requestId}/content?token=invalid`, headers: {} },
        captureResponse(),
        `/api/recordings/${requestId}/content`,
      ),
      (error) => error.status === 503 && /guardian-quorum/.test(error.message),
    );

    const listed = captureResponse();
    await routeApi(
      await makeAuthenticatedRequest("GET", "/api/repositories"),
      listed,
      "/api/repositories",
    );
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().repositories.length, 1);
    assert.equal(listed.json().repositories[0].name, "Family Home");

    const account = captureResponse();
    await routeApi(
      await makeAuthenticatedRequest("GET", "/api/me"),
      account,
      "/api/me",
    );
    assert.equal(account.statusCode, 200);
    assert.equal(account.json().subject, "guardian-1");
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("router rejects protected requests without a configured Tide adapter", async () => {
  const db = await openDatabase(":memory:");
  const routeApi = createApiRouter({
    db,
    env: { TIDECLOAK_ADAPTER_PATH: join(tmpdir(), "missing-hearth-adapter.json") },
  });

  try {
    const response = captureResponse();
    await assert.rejects(
      routeApi({ method: "GET", url: "/api/repositories", headers: { host } }, response, "/api/repositories"),
      (error) => error.status === 503,
    );
    assert.equal(response.statusCode, 0);
  } finally {
    db.close();
  }
});
