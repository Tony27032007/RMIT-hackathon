import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
} from "jose";

export class AuthenticationError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "AuthenticationError";
    this.status = status;
  }
}

export class TideConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "TideConfigurationError";
    this.status = 503;
  }
}

export class DpopError extends AuthenticationError {
  constructor(message) {
    super(message, 401);
    this.name = "DpopError";
  }
}

export async function loadTideConfig({
  adapterPath = process.env.TIDECLOAK_ADAPTER_PATH ?? "public/tidecloak.json",
} = {}) {
  let adapter;
  try {
    adapter = JSON.parse(await readFile(resolve(adapterPath), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new TideConfigurationError(
        `Tide adapter not found at ${adapterPath}. Export the Tide adapter with its embedded jwk before using protected APIs.`,
      );
    }
    if (error instanceof SyntaxError) {
      throw new TideConfigurationError("Tide adapter JSON is invalid.");
    }
    throw error;
  }

  if (
    typeof adapter["auth-server-url"] !== "string"
    || typeof adapter.realm !== "string"
    || typeof adapter.resource !== "string"
    || !Array.isArray(adapter.jwk?.keys)
    || adapter.jwk.keys.length === 0
  ) {
    throw new TideConfigurationError(
      "Tide adapter must include auth-server-url, realm, resource, and a non-empty embedded jwk.keys array. Remote key lookup is not allowed.",
    );
  }

  return {
    issuer: `${adapter["auth-server-url"].replace(/\/+$/, "")}/realms/${adapter.realm}`,
    clientId: adapter.resource,
    jwks: createLocalJWKSet(adapter.jwk),
  };
}

export async function verifyTideAccessToken(token, config) {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, config.jwks, {
      issuer: config.issuer,
      algorithms: ["RS256", "ES256"],
      requiredClaims: ["exp", "iat", "sub", "azp"],
      clockTolerance: 5,
    }));
  } catch {
    throw new AuthenticationError("Access token is invalid or expired.");
  }

  if (payload.azp !== config.clientId) {
    throw new AuthenticationError("Access token was issued to a different client.");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new AuthenticationError("Access token has no subject.");
  }
  return payload;
}

function readHeader(request, name) {
  const value = request.headers.get(name);
  return typeof value === "string" ? value : null;
}

export function requestHtu(request, { trustProxy = false, publicOrigin } = {}) {
  const parsed = new URL(request.url);
  const path = parsed.pathname;

  if (publicOrigin) {
    return `${new URL(publicOrigin).origin}${path}`;
  }

  let origin = parsed.origin;
  if (trustProxy) {
    const forwardedHost = readHeader(request, "x-forwarded-host")?.split(",")[0]?.trim();
    const forwardedProto = readHeader(request, "x-forwarded-proto")?.split(",")[0]?.trim();
    if (forwardedHost && forwardedProto && ["http", "https"].includes(forwardedProto)) {
      origin = `${forwardedProto}://${forwardedHost}`;
    }
  }

  return `${origin}${path}`;
}

export async function verifyDpop(request, accessToken, claims, {
  jtiStore,
  trustProxy = false,
  publicOrigin,
  now = Date.now(),
  iatSkewSeconds = 300,
} = {}) {
  const expectedJkt = claims.cnf?.jkt;
  if (typeof expectedJkt !== "string" || expectedJkt.length === 0) {
    throw new DpopError("Access token is not DPoP-bound.");
  }
  if (!/^DPoP\s/i.test(readHeader(request, "authorization") ?? "")) {
    throw new DpopError("A DPoP-bound token must use the DPoP authorization scheme.");
  }

  const proof = readHeader(request, "dpop");
  if (!proof) throw new DpopError("Missing DPoP proof header.");

  let header;
  try {
    header = decodeProtectedHeader(proof);
  } catch {
    throw new DpopError("DPoP proof is not a valid compact JWS.");
  }
  if (header.typ !== "dpop+jwt" || header.alg !== "ES256" || !header.jwk) {
    throw new DpopError("DPoP proof header is invalid.");
  }

  let payload;
  try {
    const key = await importJWK(header.jwk, header.alg);
    ({ payload } = await jwtVerify(proof, key, { algorithms: ["ES256"] }));
  } catch {
    throw new DpopError("DPoP proof signature is invalid.");
  }

  if (await calculateJwkThumbprint(header.jwk, "sha256") !== expectedJkt) {
    throw new DpopError("DPoP proof key does not match the access-token binding.");
  }

  const ath = Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from(accessToken))).toString("base64url");
  if (payload.ath !== ath) throw new DpopError("DPoP proof is not bound to this access token.");
  if (typeof payload.htm !== "string" || payload.htm.toUpperCase() !== request.method.toUpperCase()) {
    throw new DpopError("DPoP proof method does not match the request.");
  }
  if (payload.htu !== requestHtu(request, { trustProxy, publicOrigin })) {
    throw new DpopError("DPoP proof URL does not match the request.");
  }
  if (!Number.isInteger(payload.iat) || Math.abs(now / 1000 - payload.iat) > iatSkewSeconds) {
    throw new DpopError("DPoP proof timestamp is outside the allowed window.");
  }
  if (typeof payload.jti !== "string" || payload.jti.length < 1 || payload.jti.length > 200) {
    throw new DpopError("DPoP proof has an invalid jti.");
  }
  if (!jtiStore || !(await jtiStore.claim(payload.jti, now + iatSkewSeconds * 1000))) {
    throw new DpopError("DPoP proof was already used or replay protection is unavailable.");
  }
}

export async function authenticateRequest(request, {
  config,
  jtiStore,
  trustProxy = false,
  publicOrigin,
}) {
  const authorization = readHeader(request, "authorization") ?? "";
  const match = authorization.match(/^DPoP\s+(\S+)$/i);
  if (!match) throw new AuthenticationError("A DPoP Authorization header is required.");

  const claims = await verifyTideAccessToken(match[1], config);
  await verifyDpop(request, match[1], claims, { jtiStore, trustProxy, publicOrigin });
  return claims;
}
