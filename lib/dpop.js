import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
} from "jose";
import { createHash } from "node:crypto";

export class DpopError extends Error {
  constructor(message) {
    super(message);
    this.name = "DpopError";
    this.statusCode = 401;
  }
}

export async function verifyDpop(req, accessToken, claims, { jtiStore, now = Date.now } = {}) {
  const jkt = claims.cnf?.jkt;
  if (typeof jkt !== "string" || !jkt) {
    throw new DpopError("Access token is not sender-constrained.");
  }

  if (!/^DPoP /i.test(req.headers.get("authorization") ?? "")) {
    throw new DpopError("A sender-constrained token requires the DPoP authorization scheme.");
  }

  const proof = req.headers.get("dpop");
  if (!proof) throw new DpopError("Missing DPoP proof header.");

  let header;
  try {
    header = decodeProtectedHeader(proof);
  } catch {
    throw new DpopError("DPoP proof is not a compact JWS.");
  }
  if (header.typ !== "dpop+jwt" || header.alg !== "ES256") {
    throw new DpopError("Unsupported DPoP proof type or algorithm.");
  }
  const jwk = header.jwk;
  if (
    !jwk
    || jwk.kty !== "EC"
    || jwk.crv !== "P-256"
    || typeof jwk.x !== "string"
    || typeof jwk.y !== "string"
    || "d" in jwk
  ) {
    throw new DpopError("DPoP proof must contain a public P-256 key.");
  }

  let payload;
  try {
    const key = await importJWK(jwk, "ES256");
    ({ payload } = await jwtVerify(proof, key, { algorithms: ["ES256"] }));
  } catch {
    throw new DpopError("DPoP proof signature is invalid.");
  }

  if (await calculateJwkThumbprint(jwk, "sha256") !== jkt) {
    throw new DpopError("DPoP proof key does not match the access-token binding.");
  }
  const expectedAth = createHash("sha256").update(accessToken).digest("base64url");
  if (payload.ath !== expectedAth) {
    throw new DpopError("DPoP proof is not bound to this access token.");
  }
  if (typeof payload.htm !== "string" || payload.htm.toUpperCase() !== req.method.toUpperCase()) {
    throw new DpopError("DPoP proof method does not match the request.");
  }

  const requestUrl = new URL(req.url);
  const expectedHtu = `${requestUrl.origin}${requestUrl.pathname}`;
  if (payload.htu !== expectedHtu) {
    throw new DpopError("DPoP proof URL does not match the request.");
  }

  const iat = typeof payload.iat === "number" ? payload.iat : NaN;
  if (!Number.isFinite(iat) || Math.abs(now() / 1000 - iat) > 300) {
    throw new DpopError("DPoP proof is outside the accepted time window.");
  }
  if (typeof payload.jti !== "string" || payload.jti.length < 1 || payload.jti.length > 256) {
    throw new DpopError("DPoP proof has an invalid identifier.");
  }
  if (!(await jtiStore.claim(jkt, payload.jti, now() + 300_000))) {
    throw new DpopError("DPoP proof has already been used.");
  }
}
