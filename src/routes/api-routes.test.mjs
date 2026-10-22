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

async function makeAuthenticatedRequest(method, path, body) {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await new SignJWT({
    azp: clientId,
    cnf: { jkt: proofJkt },
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key", typ: "JWT" })
    .setIssuer(issuer)
    .setSubject("guardian-1")
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
