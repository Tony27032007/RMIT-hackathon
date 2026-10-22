import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import {
  AuthenticationError,
  DpopError,
  verifyDpop,
  verifyTideAccessToken,
} from "./tide-auth.mjs";

const issuer = "https://identity.example/realms/hearth";
const clientId = "hearth-client";
const now = Math.floor(Date.now() / 1000);
const accessKeys = await generateKeyPair("RS256");
const accessPublicJwk = { ...(await exportJWK(accessKeys.publicKey)), kid: "access-key", alg: "RS256", use: "sig" };
const proofKeys = await generateKeyPair("ES256", { extractable: true });
const proofPublicJwk = await exportJWK(proofKeys.publicKey);
const proofJkt = await calculateJwkThumbprint(proofPublicJwk);
const config = { issuer, clientId, jwks: createLocalJWKSet({ keys: [accessPublicJwk] }) };

async function makeAccessToken(overrides = {}) {
  return new SignJWT({
    azp: clientId,
    cnf: { jkt: proofJkt },
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "access-key", typ: "JWT" })
    .setIssuer(issuer)
    .setSubject("guardian-1")
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(accessKeys.privateKey);
}

async function makeProof(accessToken, {
  jti = crypto.randomUUID(),
  htm = "GET",
  htu = "http://localhost:3000/api/me",
  ath,
} = {}) {
  const tokenHash = ath ?? Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from(accessToken))).toString("base64url");
  return new SignJWT({
    ath: tokenHash,
    htm,
    htu,
    iat: now,
    jti,
  })
    .setProtectedHeader({
      alg: "ES256",
      typ: "dpop+jwt",
      jwk: {
        crv: proofPublicJwk.crv,
        kty: proofPublicJwk.kty,
        x: proofPublicJwk.x,
        y: proofPublicJwk.y,
      },
    })
    .sign(proofKeys.privateKey);
}

function requestFor(token, proof, authorizationScheme = "DPoP") {
  return new Request("http://localhost:3000/api/me", {
    method: "GET",
    headers: {
      authorization: `${authorizationScheme} ${token}`,
      dpop: proof,
    },
  });
}

function memoryJtiStore() {
  const seen = new Set();
  return {
    async claim(jti) {
      if (seen.has(jti)) return false;
      seen.add(jti);
      return true;
    },
  };
}

test("verifies Tide JWT against the configured embedded key and client", async () => {
  const token = await makeAccessToken();
  const claims = await verifyTideAccessToken(token, config);
  assert.equal(claims.sub, "guardian-1");
});

test("rejects a token from the wrong client", async () => {
  const token = await makeAccessToken({ azp: "another-client" });
  await assert.rejects(verifyTideAccessToken(token, config), AuthenticationError);
});

test("validates DPoP proof binding, method, URL, and replay protection", async () => {
  const token = await makeAccessToken();
  const proof = await makeProof(token);
  const store = memoryJtiStore();
  const request = requestFor(token, proof);

  await verifyDpop(request, token, { cnf: { jkt: proofJkt } }, { jtiStore: store });
  await assert.rejects(
    verifyDpop(request, token, { cnf: { jkt: proofJkt } }, { jtiStore: store }),
    DpopError,
  );
});

test("rejects a DPoP-bound token presented as Bearer", async () => {
  const token = await makeAccessToken();
  const proof = await makeProof(token);
  await assert.rejects(
    verifyDpop(requestFor(token, proof, "Bearer"), token, { cnf: { jkt: proofJkt } }, { jtiStore: memoryJtiStore() }),
    DpopError,
  );
});

test("rejects mismatched DPoP method and URL", async () => {
  const token = await makeAccessToken();
  const store = memoryJtiStore();
  const wrongMethod = await makeProof(token, { htm: "POST" });
  await assert.rejects(
    verifyDpop(requestFor(token, wrongMethod), token, { cnf: { jkt: proofJkt } }, { jtiStore: store }),
    DpopError,
  );

  const wrongUrl = await makeProof(token, { htu: "http://localhost:3000/api/other" });
  await assert.rejects(
    verifyDpop(requestFor(token, wrongUrl), token, { cnf: { jkt: proofJkt } }, { jtiStore: memoryJtiStore() }),
    DpopError,
  );
});

test("refuses an unbound token and unavailable replay protection", async () => {
  const token = await makeAccessToken();
  const proof = await makeProof(token);
  await assert.rejects(
    verifyDpop(requestFor(token, proof), token, {}, { jtiStore: memoryJtiStore() }),
    DpopError,
  );
  await assert.rejects(
    verifyDpop(requestFor(token, proof), token, { cnf: { jkt: proofJkt } }),
    DpopError,
  );
});
