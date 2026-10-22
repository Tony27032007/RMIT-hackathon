import { createLocalJWKSet, jwtVerify } from "jose";
import { verifyDpop, DpopError } from "./dpop.js";

export class AuthError extends Error {
  constructor(code, message, statusCode = 401) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function algorithmsFor(jwk) {
  const allowed = new Set(["EdDSA", "RS256", "ES256"]);
  const inferred = jwk.keys.map((key) => {
    if (key.alg) return allowed.has(key.alg) ? key.alg : null;
    if (key.kty === "OKP" && key.crv === "Ed25519") return "EdDSA";
    if (key.kty === "RSA") return "RS256";
    if (key.kty === "EC" && key.crv === "P-256") return "ES256";
    return null;
  });
  return [...new Set(inferred.filter(Boolean))];
}

function getHeader(headers, name) {
  if (headers instanceof Headers) return headers.get(name) ?? "";
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value ?? "";
}

export function createAuthenticator({ issuer, audience, resource, jwk, appOrigin, jtiStore }) {
  if (
    !issuer
    || !resource
    || !jwk
    || !Array.isArray(jwk.keys)
    || jwk.keys.length === 0
    || !appOrigin
  ) return async () => {
    throw new AuthError("AUTH_NOT_CONFIGURED", "TideCloak verification is not configured.", 503);
  };

  const normalizedIssuer = issuer.replace(/\/+$/, "");
  const algorithms = algorithmsFor(jwk);
  if (algorithms.length === 0) return async () => {
    throw new AuthError("AUTH_NOT_CONFIGURED", "The adapter has no supported public signing key.", 503);
  };
  const jwks = createLocalJWKSet(jwk);

  return async (req) => {
    const authorization = getHeader(req.headers, "authorization");
    const match = /^DPoP ([^\s]+)$/.exec(authorization);
    if (!match) {
      throw new AuthError("DPoP_REQUIRED", "A DPoP-bound TideCloak access token is required.");
    }

    const accessToken = match[1];
    let claims;
    try {
      ({ payload: claims } = await jwtVerify(accessToken, jwks, {
        issuer: normalizedIssuer,
        ...(audience ? { audience } : {}),
        algorithms,
        clockTolerance: 5,
      }));
    } catch {
      throw new AuthError("INVALID_TOKEN", "The TideCloak access token could not be verified.");
    }

    if (typeof claims.sub !== "string" || !claims.sub) {
      throw new AuthError("INVALID_TOKEN", "The verified access token has no subject.");
    }
    if (claims.azp !== resource) {
      throw new AuthError("INVALID_TOKEN", "The access token was issued to a different client.");
    }

    const proofRequest = {
      url: new URL(req.url, appOrigin).href,
      method: req.method,
      headers: new Headers({
        authorization,
        dpop: getHeader(req.headers, "dpop"),
      }),
    };
    try {
      await verifyDpop(proofRequest, accessToken, claims, { jtiStore });
    } catch (error) {
      if (error instanceof DpopError) {
        throw new AuthError("INVALID_DPOP_PROOF", error.message);
      }
      throw error;
    }
    return { userId: claims.sub, claims };
  };
}
