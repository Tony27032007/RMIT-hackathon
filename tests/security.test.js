import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { AuthError, createAuthenticator } from "../lib/auth.js";

const clientId = "homelock-client";
const appOrigin = "http://127.0.0.1:3000";
const { publicKey: signingKey, privateKey: signingPrivateKey } = await generateKeyPair("RS256", {
  extractable: true,
});
const signingJwk = await exportJWK(signingKey);
signingJwk.kid = "homelock-test-key";
signingJwk.alg = "RS256";
signingJwk.use = "sig";
const { publicKey: proofKey, privateKey: proofPrivateKey } = await generateKeyPair("ES256", {
  extractable: true,
});
const proofJwk = await exportJWK(proofKey);
const jkt = await calculateJwkThumbprint(proofJwk, "sha256");
let issuer;
issuer = "https://identity.example/realms/homelock";

async function createToken({ aud = clientId, sub = "tide-subject-1", bound = true } = {}) {
  const payload = { azp: clientId };
  if (bound) payload.cnf = { jkt };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: signingJwk.kid })
    .setIssuer(issuer)
    .setAudience(aud)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingPrivateKey);
}

async function createProof(token, { jti = crypto.randomUUID(), method = "GET", htu = `${appOrigin}/api/repositories`, iat = Math.floor(Date.now() / 1000) } = {}) {
  const ath = Buffer.from(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  )).toString("base64url");
  return new SignJWT({ jti, htm: method, htu, iat, ath })
    .setProtectedHeader({
      alg: "ES256",
      typ: "dpop+jwt",
      jwk: { kty: proofJwk.kty, crv: proofJwk.crv, x: proofJwk.x, y: proofJwk.y },
    })
    .sign(proofPrivateKey);
}

function request(token, proof, { method = "GET", url = `${appOrigin}/api/repositories` } = {}) {
  const headers = new Headers({
    authorization: `DPoP ${token}`,
    dpop: proof,
  });
  return { method, url, headers };
}

function createStore() {
  const used = new Set();
  return {
    async claim(keyThumbprint, proofId) {
      const key = `${keyThumbprint}:${proofId}`;
      if (used.has(key)) return false;
      used.add(key);
      return true;
    },
  };
}

function authenticator(store = createStore(), tokenIssuer = issuer) {
  return createAuthenticator({
    issuer: tokenIssuer,
    audience: clientId,
    resource: clientId,
    jwk: { keys: [signingJwk] },
    appOrigin,
    jtiStore: store,
  });
}

test("accepts a valid Tide JWT and its request-bound DPoP proof", async () => {
  const token = await createToken();
  const proof = await createProof(token);
  const identity = await authenticator()(request(token, proof));
  assert.equal(identity.userId, "tide-subject-1");
});

test("accepts an EdDSA token verified against the adapter's embedded key", async () => {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const embeddedKey = await exportJWK(publicKey);
  embeddedKey.kid = "homelock-eddsa-key";
  embeddedKey.alg = "EdDSA";
  embeddedKey.use = "sig";
  const token = await new SignJWT({ azp: clientId, cnf: { jkt } })
    .setProtectedHeader({ alg: "EdDSA", kid: embeddedKey.kid })
    .setIssuer(issuer)
    .setAudience(clientId)
    .setSubject("tide-subject-eddsa")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const proof = await createProof(token);
  const verify = createAuthenticator({
    issuer,
    audience: clientId,
    resource: clientId,
    jwk: { keys: [embeddedKey] },
    appOrigin,
    jtiStore: createStore(),
  });
  const identity = await verify(request(token, proof));
  assert.equal(identity.userId, "tide-subject-eddsa");
});

test("rejects an incorrect JWT audience before accepting its proof", async () => {
  const token = await createToken({ aud: "another-client" });
  const proof = await createProof(token);
  await assert.rejects(authenticator()(request(token, proof)), (error) => {
    assert.ok(error instanceof AuthError);
    assert.equal(error.code, "INVALID_TOKEN");
    return true;
  });
});

test("rejects a token that is not DPoP-bound", async () => {
  const token = await createToken({ bound: false });
  const proof = await createProof(token);
  await assert.rejects(authenticator()(request(token, proof)), (error) => {
    assert.equal(error.code, "INVALID_DPOP_PROOF");
    return true;
  });
});

test("rejects a DPoP proof replay", async () => {
  const token = await createToken();
  const proof = await createProof(token, { jti: "one-use-proof" });
  const verify = authenticator();
  await verify(request(token, proof));
  await assert.rejects(verify(request(token, proof)), (error) => {
    assert.equal(error.code, "INVALID_DPOP_PROOF");
    return true;
  });
});

test("rejects a proof for a different request method", async () => {
  const token = await createToken();
  const proof = await createProof(token, { method: "POST" });
  await assert.rejects(authenticator()(request(token, proof)), (error) => {
    assert.equal(error.code, "INVALID_DPOP_PROOF");
    return true;
  });
});

test("fails closed when Tide verification is not configured", async () => {
  const verify = createAuthenticator({ appOrigin, jtiStore: createStore() });
  await assert.rejects(verify(request("unused", "unused")), (error) => {
    assert.ok(error instanceof AuthError);
    assert.equal(error.code, "AUTH_NOT_CONFIGURED");
    assert.equal(error.statusCode, 503);
    return true;
  });
});
