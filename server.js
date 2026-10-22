import { createServer } from "node:http";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { openDatabase } from "./lib/database.js";
import { AuthError, createAuthenticator } from "./lib/auth.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = resolve(ROOT, "public");
const DIST_DIR = resolve(ROOT, "dist");
const STATIC_DIR = existsSync(DIST_DIR) ? DIST_DIR : PUBLIC_DIR;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/ogg", "video/quicktime"]);
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};
const MAX_JSON_BYTES = 16 * 1024;

function loadAdapter(adapterPath = resolve(PUBLIC_DIR, "tidecloak.json")) {
  if (!existsSync(adapterPath)) return { value: null, issue: "TideCloak adapter is not configured." };
  try {
    return { value: JSON.parse(readFileSync(adapterPath, "utf8")), issue: "" };
  } catch {
    return { value: null, issue: "TideCloak adapter JSON is invalid." };
  }
}

function runtimeConfig(env, adapterResult) {
  const adapter = adapterResult.value;
  const tideUrl = (env.TIDECLOAK_URL?.trim() || adapter?.["auth-server-url"] || "")
    .replace(/\/+$/, "");
  const realm = env.TIDECLOAK_REALM?.trim() || adapter?.realm || "";
  const issuer = env.TIDECLOAK_ISSUER?.trim()
    || (tideUrl && realm ? `${tideUrl}/realms/${realm}` : "");
  const resource = adapter?.resource || "";
  const clientId = env.TIDECLOAK_CLIENT_ID?.trim() || resource;
  const audience = env.TIDECLOAK_AUDIENCE?.trim() || undefined;
  const jwk = adapter?.jwk;
  const appOrigin = (env.APP_ORIGIN || "http://localhost:3000").replace(/\/+$/, "");
  const clientOriginAuth = adapter?.[`client-origin-auth-${appOrigin}`];
  let adapterIssue = adapterResult.issue;
  if (!adapterIssue && (!jwk || !Array.isArray(jwk.keys) || jwk.keys.length === 0)) {
    adapterIssue = "The adapter is missing its embedded public JWKS; re-export it with IGA enabled.";
  } else if (!adapterIssue && !resource) {
    adapterIssue = "The adapter does not include its expected client resource.";
  } else if (!adapterIssue && clientId !== resource) {
    adapterIssue = "TIDECLOAK_CLIENT_ID does not match the adapter resource.";
  }
  const authConfigured = Boolean(!adapterIssue && issuer && clientId && resource);

  return {
    issuer,
    audience,
    clientId,
    resource,
    jwk,
    appOrigin,
    authConfigured,
    adapterIssue,
    clientOriginAuthConfigured: typeof clientOriginAuth === "string" && clientOriginAuth.length > 0,
    redirectUri: `${appOrigin}/auth/redirect`,
    gates: {
      guardianMembership: "application-quorum",
      encryptedUploads: "application-quorum",
      recordingPlayback: "application-quorum",
      recordingDeletion: "application-quorum",
      tideOrkQuorum: false,
    },
  };
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function securityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=()");
}

function requestError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function requireSameOrigin(request, appOrigin) {
  if (request.headers.origin !== appOrigin) {
    throw requestError(403, "ORIGIN_NOT_ALLOWED", "Request origin is not allowed.");
  }
}

async function readJson(request) {
  const contentType = request.headers["content-type"]?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    const error = new Error("Content-Type must be application/json.");
    error.statusCode = 415;
    error.code = "UNSUPPORTED_MEDIA_TYPE";
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Request body must be a JSON object.");
    }
    return value;
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    error.code = "INVALID_JSON";
    throw error;
  }
}

async function readBinary(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw requestError(413, "UPLOAD_TOO_LARGE", "The encrypted file exceeds the 50 MB limit.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function currentGuardians(database, repositoryId) {
  return database.prepare(`
    SELECT user_id AS userId
    FROM repository_guardians
    WHERE repository_id = ?
    ORDER BY user_id
  `).all(repositoryId).map((row) => row.userId);
}

function hasGuardian(database, repositoryId, userId) {
  return Boolean(database.prepare(`
    SELECT 1 FROM repository_guardians WHERE repository_id = ? AND user_id = ?
  `).get(repositoryId, userId));
}

function expirePendingRequests(database, repositoryId, exceptRequestId = null) {
  database.prepare(`
    UPDATE quorum_requests
    SET status = 'expired', resolved_at = ?
    WHERE repository_id = ? AND status = 'pending'
      AND (? IS NULL OR id != ?)
  `).run(new Date().toISOString(), repositoryId, exceptRequestId, exceptRequestId);
}

function audit(database, repositoryId, actorUserId, eventType, details = {}) {
  database.prepare(`
    INSERT INTO audit_events (id, repository_id, actor_user_id, event_type, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), repositoryId, actorUserId, eventType, JSON.stringify(details), new Date().toISOString());
}

function getRepository(database, repositoryId) {
  return database.prepare(`
    SELECT id, name, description, membership_version AS membershipVersion
    FROM repositories WHERE id = ?
  `).get(repositoryId);
}

function getFile(database, repositoryId, fileId) {
  return database.prepare(`
    SELECT id, repository_id AS repositoryId, uploaded_by AS uploadedBy,
      display_name AS displayName, content_type AS contentType,
      storage_name AS storageName, encryption_iv AS encryptionIv,
      encryption_key AS encryptionKey, size_bytes AS sizeBytes, created_at AS createdAt
    FROM repository_files WHERE id = ? AND repository_id = ?
  `).get(fileId, repositoryId);
}

function createQuorumRequest(database, {
  repositoryId,
  requestType,
  actorUserId,
  targetUserId = null,
  fileId = null,
}) {
  const repository = getRepository(database, repositoryId);
  if (!repository) throw requestError(404, "NOT_FOUND", "Repository not found.");

  const guardians = currentGuardians(database, repositoryId);
  const voters = requestType === "view"
    ? guardians.filter((userId) => userId !== actorUserId)
    : guardians;
  const requestId = randomUUID();
  const createdAt = new Date().toISOString();
  const status = voters.length === 0 && requestType === "view" ? "approved" : "pending";
  database.prepare(`
    INSERT INTO quorum_requests
      (id, repository_id, request_type, actor_user_id, target_user_id, file_id,
       membership_version, required_approvals, status, created_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    requestId,
    repositoryId,
    requestType,
    actorUserId,
    targetUserId,
    fileId,
    repository.membershipVersion,
    voters.length,
    status,
    createdAt,
    status === "approved" ? createdAt : null,
  );
  const addVoter = database.prepare(`
    INSERT INTO quorum_request_guardians (request_id, guardian_user_id) VALUES (?, ?)
  `);
  for (const voter of voters) addVoter.run(requestId, voter);
  return {
    id: requestId,
    repositoryId,
    type: requestType,
    actorUserId,
    targetUserId,
    fileId,
    membershipVersion: repository.membershipVersion,
    requiredApprovals: voters.length,
    status,
    createdAt,
  };
}

function listQuorumRequests(database, repositoryId, userId) {
  return database.prepare(`
    SELECT q.id, q.request_type AS type, q.actor_user_id AS actorUserId,
      q.target_user_id AS targetUserId, q.file_id AS fileId,
      q.membership_version AS membershipVersion,
      q.required_approvals AS requiredApprovals, q.status, q.created_at AS createdAt,
      q.consumed_at AS consumedAt,
      (SELECT COUNT(*) FROM quorum_votes v
       WHERE v.request_id = q.id AND v.decision = 'approve') AS approvals,
      (SELECT COUNT(*) FROM quorum_votes v
       WHERE v.request_id = q.id AND v.decision = 'reject') AS rejections,
      (SELECT decision FROM quorum_votes v
       WHERE v.request_id = q.id AND v.guardian_user_id = ?) AS myVote,
      EXISTS (
        SELECT 1 FROM quorum_request_guardians rg
        JOIN repository_guardians g ON g.repository_id = q.repository_id
          AND g.user_id = rg.guardian_user_id
        WHERE rg.request_id = q.id AND rg.guardian_user_id = ?
      ) AS canVote
    FROM quorum_requests q
    WHERE q.repository_id = ?
    ORDER BY q.created_at DESC
    LIMIT 100
  `).all(userId, userId, repositoryId);
}

function servePublic(request, response, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: "INVALID_PATH", message: "Invalid request path." });
    return;
  }
  if (decoded.split("/").some((part) => part.startsWith("."))) {
    sendJson(response, 404, { error: "NOT_FOUND", message: "Not found." });
    return;
  }

  const staticPath = decoded === "/auth/redirect"
    ? "/auth/redirect.html"
    : decoded === "/"
      ? "/index.html"
      : decoded;
  const target = resolve(STATIC_DIR, `.${staticPath}`);
  if (target !== STATIC_DIR && !target.startsWith(`${STATIC_DIR}${sep}`)) {
    sendJson(response, 404, { error: "NOT_FOUND", message: "Not found." });
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    sendJson(response, 404, { error: "NOT_FOUND", message: "Not found." });
    return;
  }

  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(target)] || "application/octet-stream",
    "Cache-Control": target.endsWith("tidecloak.json") ? "no-store" : "no-cache",
  });
  if (request.method === "HEAD") {
    response.end();
  } else {
    createReadStream(target).pipe(response);
  }
}

export function createHomeLockServer({ env = process.env, databasePath, adapterPath, recordingsPath } = {}) {
  const dataDir = resolve(ROOT, "data");
  const recordingsDir = resolve(recordingsPath || resolve(dataDir, "recordings"));
  mkdirSync(recordingsDir, { recursive: true, mode: 0o700 });
  const adapterResult = loadAdapter(adapterPath);
  const config = runtimeConfig(env, adapterResult);
  const dbPath = databasePath || env.HOMELOCK_DB_PATH || resolve(dataDir, "homelock.sqlite");
  const { database, jtiStore } = openDatabase(dbPath);
  const authenticate = createAuthenticator({ ...config, jtiStore });

  const server = createServer(async (request, response) => {
    securityHeaders(response);
    const url = new URL(request.url, config.appOrigin);

    if (url.pathname.startsWith("/api/")) {
      try {
        if (request.method === "GET" && url.pathname === "/api/health") {
          sendJson(response, 200, {
            status: "ok",
            authConfigured: config.authConfigured,
            gates: config.gates,
          });
          return;
        }

        const leaveMatch = /^\/api\/repositories\/([a-f0-9-]{36})\/members\/me$/.exec(url.pathname);
        if (leaveMatch && request.method === "DELETE") {
          requireSameOrigin(request, config.appOrigin);
          const identity = await authenticate(request);
          const repository = getRepository(database, leaveMatch[1]);
          if (!repository || !hasGuardian(database, repository.id, identity.userId)) {
            sendJson(response, 404, { error: "NOT_FOUND", message: "Repository not found." });
            return;
          }
          if (currentGuardians(database, repository.id).length <= 1) {
            throw requestError(409, "LAST_GUARDIAN", "The last guardian cannot leave this repository.");
          }
          database.exec("BEGIN IMMEDIATE");
          try {
            database.prepare(`
              DELETE FROM repository_guardians WHERE repository_id = ? AND user_id = ?
            `).run(repository.id, identity.userId);
            database.prepare(`
              UPDATE repositories SET membership_version = membership_version + 1 WHERE id = ?
            `).run(repository.id);
            expirePendingRequests(database, repository.id);
            audit(database, repository.id, identity.userId, "guardian.left");
            database.exec("COMMIT");
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
          sendJson(response, 200, {
            left: true,
            notice: "Pending requests expired after repository membership changed.",
          });
          return;
        }

        const requestsMatch = /^\/api\/repositories\/([a-f0-9-]{36})\/requests$/.exec(url.pathname);
        if (requestsMatch && (request.method === "GET" || request.method === "POST")) {
          const identity = await authenticate(request);
          const repository = getRepository(database, requestsMatch[1]);
          if (!repository) {
            sendJson(response, 404, { error: "NOT_FOUND", message: "Repository not found." });
            return;
          }
          const isGuardian = hasGuardian(database, repository.id, identity.userId);
          if (request.method === "GET") {
            if (!isGuardian) {
              sendJson(response, 404, { error: "NOT_FOUND", message: "Repository not found." });
              return;
            }
            sendJson(response, 200, {
              requests: listQuorumRequests(database, repository.id, identity.userId),
              guardians: currentGuardians(database, repository.id),
            });
            return;
          }

          requireSameOrigin(request, config.appOrigin);
          const input = await readJson(request);
          const requestType = input.type;
          if (!["guardian-invite", "join", "view", "delete"].includes(requestType)) {
            throw requestError(400, "INVALID_REQUEST_TYPE", "Unsupported repository request type.");
          }
          if (requestType === "join" ? isGuardian : !isGuardian) {
            throw requestError(403, "GUARDIAN_REQUIRED", "Join requests are for non-members; other requests require guardian membership.");
          }

          let targetUserId = null;
          let fileId = null;
          if (requestType === "guardian-invite") {
            targetUserId = typeof input.userId === "string" ? input.userId.trim() : "";
            if (!targetUserId || targetUserId.length > 256) {
              throw requestError(400, "INVALID_USER_ID", "Provide a TideCloak user ID up to 256 characters.");
            }
            if (hasGuardian(database, repository.id, targetUserId)) {
              throw requestError(409, "ALREADY_GUARDIAN", "That user is already a repository guardian.");
            }
          } else if (requestType === "join") {
            targetUserId = identity.userId;
          } else {
            fileId = typeof input.fileId === "string" ? input.fileId : "";
            if (!getFile(database, repository.id, fileId)) {
              throw requestError(404, "FILE_NOT_FOUND", "File not found.");
            }
          }

          database.exec("BEGIN IMMEDIATE");
          let quorumRequest;
          try {
            const duplicate = database.prepare(`
              SELECT id FROM quorum_requests
              WHERE repository_id = ? AND status = 'pending'
                AND request_type = ? AND actor_user_id = ?
                AND COALESCE(target_user_id, '') = COALESCE(?, '')
                AND COALESCE(file_id, '') = COALESCE(?, '')
            `).get(repository.id, requestType, identity.userId, targetUserId, fileId);
            if (duplicate) {
              throw requestError(409, "REQUEST_ALREADY_PENDING", "An equivalent request is already pending.");
            }
            quorumRequest = createQuorumRequest(database, {
              repositoryId: repository.id,
              requestType,
              actorUserId: identity.userId,
              targetUserId,
              fileId,
            });
            audit(database, repository.id, identity.userId, `request.${requestType}`, {
              requestId: quorumRequest.id,
              targetUserId,
              fileId,
              requiredApprovals: quorumRequest.requiredApprovals,
            });
            database.exec("COMMIT");
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
          sendJson(response, 201, {
            request: quorumRequest,
            notice: "Votes are recorded by HomeLock application code and SQLite, not Tide/ORK.",
          });
          return;
        }

        const directMemberMatch = /^\/api\/repositories\/([a-f0-9-]{36})\/members$/.exec(url.pathname);
        if (directMemberMatch && request.method === "GET") {
          const identity = await authenticate(request);
          if (!hasGuardian(database, directMemberMatch[1], identity.userId)) {
            sendJson(response, 404, { error: "NOT_FOUND", message: "Repository not found." });
            return;
          }
          sendJson(response, 200, { guardians: currentGuardians(database, directMemberMatch[1]) });
          return;
        }
        if (directMemberMatch && request.method === "POST") {
          requireSameOrigin(request, config.appOrigin);
          const identity = await authenticate(request);
          if (!hasGuardian(database, directMemberMatch[1], identity.userId)) {
            sendJson(response, 404, { error: "NOT_FOUND", message: "Repository not found." });
            return;
          }
          throw requestError(409, "QUORUM_REQUEST_REQUIRED", "Use a guardian-invite request and collect all guardian approvals.");
        }

        const voteMatch = /^\/api\/repositories\/([a-f0-9-]{36})\/requests\/([a-f0-9-]{36})\/votes$/.exec(url.pathname);
        if (voteMatch && request.method === "POST") {
          requireSameOrigin(request, config.appOrigin);
          const identity = await authenticate(request);
          const input = await readJson(request);
          if (!input || (input.decision !== "approve" && input.decision !== "reject")) {
            throw requestError(400, "INVALID_DECISION", "Decision must be approve or reject.");
          }

          const repositoryId = voteMatch[1];
          const requestId = voteMatch[2];
          const quorumRequest = database.prepare(`
            SELECT id, request_type AS type, actor_user_id AS actorUserId,
              target_user_id AS targetUserId, file_id AS fileId,
              membership_version AS membershipVersion,
              required_approvals AS requiredApprovals, status
            FROM quorum_requests WHERE id = ? AND repository_id = ?
          `).get(requestId, repositoryId);
          const repository = getRepository(database, repositoryId);
          if (!quorumRequest || !repository) {
            sendJson(response, 404, { error: "NOT_FOUND", message: "Request not found." });
            return;
          }
          if (quorumRequest.status !== "pending") {
            throw requestError(409, "REQUEST_NOT_PENDING", `This request is ${quorumRequest.status}.`);
          }
          const isExpectedVoter = Boolean(database.prepare(`
            SELECT 1 FROM quorum_request_guardians
            WHERE request_id = ? AND guardian_user_id = ?
          `).get(requestId, identity.userId));
          if (!isExpectedVoter || !hasGuardian(database, repositoryId, identity.userId)) {
            throw requestError(403, "NOT_AN_APPROVER", "Only a current guardian included in this request may vote.");
          }
          if (quorumRequest.membershipVersion !== repository.membershipVersion) {
            database.prepare(`
              UPDATE quorum_requests SET status = 'expired', resolved_at = ?
              WHERE id = ? AND status = 'pending'
            `).run(new Date().toISOString(), requestId);
            throw requestError(409, "REQUEST_EXPIRED", "Repository membership changed; this request has expired.");
          }
          if (database.prepare(`
            SELECT 1 FROM quorum_votes WHERE request_id = ? AND guardian_user_id = ?
          `).get(requestId, identity.userId)) {
            throw requestError(409, "ALREADY_VOTED", "Each guardian may vote only once on a request.");
          }

          let finalStatus = "pending";
          let approvals = 0;
          let rejections = 0;
          let stagedDeletionPath = null;
          database.exec("BEGIN IMMEDIATE");
          try {
            database.prepare(`
              INSERT INTO quorum_votes (request_id, guardian_user_id, decision, created_at)
              VALUES (?, ?, ?, ?)
            `).run(requestId, identity.userId, input.decision, new Date().toISOString());
            approvals = database.prepare(`
              SELECT COUNT(*) AS count FROM quorum_votes
              WHERE request_id = ? AND decision = 'approve'
            `).get(requestId).count;
            rejections = database.prepare(`
              SELECT COUNT(*) AS count FROM quorum_votes
              WHERE request_id = ? AND decision = 'reject'
            `).get(requestId).count;
            if (rejections > 0) {
              finalStatus = "rejected";
            } else if (approvals >= quorumRequest.requiredApprovals) {
              finalStatus = "approved";
            }

            if (finalStatus !== "pending") {
              database.prepare(`
                UPDATE quorum_requests SET status = ?, resolved_at = ? WHERE id = ?
              `).run(finalStatus, new Date().toISOString(), requestId);
            }
            if (finalStatus === "approved"
              && (quorumRequest.type === "guardian-invite" || quorumRequest.type === "join")) {
              database.prepare(`
                INSERT INTO repository_guardians (repository_id, user_id, joined_at)
                VALUES (?, ?, ?)
              `).run(repositoryId, quorumRequest.targetUserId, new Date().toISOString());
              database.prepare(`
                UPDATE repositories SET membership_version = membership_version + 1 WHERE id = ?
              `).run(repositoryId);
              expirePendingRequests(database, repositoryId, requestId);
              audit(database, repositoryId, identity.userId, "guardian.added", {
                requestId,
                userId: quorumRequest.targetUserId,
              });
            } else if (finalStatus === "approved" && quorumRequest.type === "delete") {
              const file = getFile(database, repositoryId, quorumRequest.fileId);
              if (!file) throw requestError(409, "FILE_NOT_FOUND", "The file was already removed.");
              const storagePath = resolve(recordingsDir, repositoryId, file.storageName);
              if (!storagePath.startsWith(`${resolve(recordingsDir)}${sep}`)) {
                throw requestError(500, "INVALID_STORAGE_PATH", "The file storage path is invalid.");
              }
              stagedDeletionPath = `${storagePath}.${requestId}.deleting`;
              renameSync(storagePath, stagedDeletionPath);
              database.prepare("DELETE FROM repository_files WHERE id = ?").run(file.id);
              audit(database, repositoryId, identity.userId, "file.deleted", {
                requestId,
                fileId: file.id,
              });
            } else if (finalStatus === "approved" && quorumRequest.type === "view") {
              audit(database, repositoryId, identity.userId, "file.view-approved", {
                requestId,
                fileId: quorumRequest.fileId,
              });
            } else if (finalStatus === "rejected") {
              audit(database, repositoryId, identity.userId, `request.${quorumRequest.type}.rejected`, {
                requestId,
              });
            }
            audit(database, repositoryId, identity.userId, "request.vote", {
              requestId,
              decision: input.decision,
              approvals,
              requiredApprovals: quorumRequest.requiredApprovals,
              status: finalStatus,
            });
            database.exec("COMMIT");
          } catch (error) {
            database.exec("ROLLBACK");
            if (stagedDeletionPath && existsSync(stagedDeletionPath)) {
              renameSync(stagedDeletionPath, stagedDeletionPath.slice(0, -`.${requestId}.deleting`.length));
            }
            throw error;
          }
          if (stagedDeletionPath) {
            try {
              unlinkSync(stagedDeletionPath);
            } catch (error) {
              console.error("[homelock] approved file deletion needs cleanup", {
                requestId,
                error: error?.code || error?.name || "Error",
              });
              throw requestError(500, "FILE_CLEANUP_FAILED", "Quorum approved deletion, but encrypted file cleanup failed. Contact the app operator.");
            }
          }
          sendJson(response, 200, {
            request: { ...quorumRequest, status: finalStatus, approvals, rejections },
            notice: "This decision is application-recorded; it is not Tide/ORK authorization.",
          });
          return;
        }

        const filesMatch = /^\/api\/repositories\/([a-f0-9-]{36})\/files$/.exec(url.pathname);
        if (filesMatch && request.method === "GET") {
          const identity = await authenticate(request);
          if (!hasGuardian(database, filesMatch[1], identity.userId)) {
            sendJson(response, 404, { error: "NOT_FOUND", message: "Repository not found." });
            return;
          }
          const files = database.prepare(`
            SELECT id, display_name AS name, content_type AS contentType,
              size_bytes AS sizeBytes, uploaded_by AS uploadedBy, created_at AS createdAt
            FROM repository_files WHERE repository_id = ?
            ORDER BY created_at DESC
          `).all(filesMatch[1]);
          sendJson(response, 200, { files });
          return;
        }

        if (filesMatch && request.method === "POST") {
          requireSameOrigin(request, config.appOrigin);
          const identity = await authenticate(request);
          const repositoryId = filesMatch[1];
          if (!hasGuardian(database, repositoryId, identity.userId)) {
            sendJson(response, 404, { error: "NOT_FOUND", message: "Repository not found." });
            return;
          }
          const contentType = request.headers["content-type"]?.split(";")[0].trim().toLowerCase();
          if (contentType !== "application/octet-stream") {
            throw requestError(415, "UNSUPPORTED_MEDIA_TYPE", "Upload encrypted video as application/octet-stream.");
          }
          let displayName;
          try {
            displayName = decodeURIComponent(request.headers["x-file-name"] || "");
          } catch {
            throw requestError(400, "INVALID_FILE_NAME", "File name encoding is invalid.");
          }
          displayName = basename(displayName).replace(/[\u0000-\u001f\u007f]/g, "").trim();
          const declaredType = request.headers["x-file-content-type"] || "";
          const encryptionIv = request.headers["x-encryption-iv"] || "";
          const encryptionKey = request.headers["x-encryption-key"] || "";
          const ivBytes = Buffer.from(encryptionIv, "base64url");
          const keyBytes = Buffer.from(encryptionKey, "base64url");
          if (!displayName || displayName.length > 200 || !VIDEO_TYPES.has(declaredType)
            || ivBytes.length !== 12 || keyBytes.length !== 32) {
            throw requestError(400, "INVALID_UPLOAD_METADATA", "Provide a supported video, AES-256 key, and 12-byte AES-GCM IV.");
          }
          const encryptedBytes = await readBinary(request, MAX_UPLOAD_BYTES);
          if (encryptedBytes.length < 17) {
            throw requestError(400, "INVALID_UPLOAD", "Encrypted video data is empty or malformed.");
          }

          const fileId = randomUUID();
          const storageName = `${fileId}.enc`;
          const repositoryDirectory = resolve(recordingsDir, repositoryId);
          mkdirSync(repositoryDirectory, { recursive: true, mode: 0o700 });
          const storagePath = resolve(repositoryDirectory, storageName);
          const createdAt = new Date().toISOString();
          database.exec("BEGIN IMMEDIATE");
          try {
            writeFileSync(storagePath, encryptedBytes, { flag: "wx", mode: 0o600 });
            database.prepare(`
              INSERT INTO repository_files
                (id, repository_id, uploaded_by, display_name, content_type, storage_name,
                 encryption_iv, encryption_key, size_bytes, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              fileId,
              repositoryId,
              identity.userId,
              displayName,
              declaredType,
              storageName,
              encryptionIv,
              encryptionKey,
              encryptedBytes.length,
              createdAt,
            );
            audit(database, repositoryId, identity.userId, "file.uploaded", {
              fileId,
              name: displayName,
              sizeBytes: encryptedBytes.length,
            });
            database.exec("COMMIT");
          } catch (error) {
            database.exec("ROLLBACK");
            if (existsSync(storagePath)) unlinkSync(storagePath);
            throw error;
          }
          sendJson(response, 201, {
            file: {
              id: fileId,
              name: displayName,
              contentType: declaredType,
              sizeBytes: encryptedBytes.length,
              createdAt,
            },
            notice: "The browser encrypts uploads, but the app stores each file key in SQLite and controls release with application votes. Demo use only.",
          });
          return;
        }

        const fileContentMatch = /^\/api\/repositories\/([a-f0-9-]{36})\/files\/([a-f0-9-]{36})\/content$/.exec(url.pathname);
        if (fileContentMatch && request.method === "GET") {
          const identity = await authenticate(request);
          const repository = getRepository(database, fileContentMatch[1]);
          const requestId = url.searchParams.get("requestId");
          const viewRequest = requestId && database.prepare(`
            SELECT id, membership_version AS membershipVersion, status, consumed_at AS consumedAt
            FROM quorum_requests WHERE id = ? AND repository_id = ?
              AND file_id = ? AND request_type = 'view' AND actor_user_id = ?
          `).get(requestId, fileContentMatch[1], fileContentMatch[2], identity.userId);
          if (!repository || !hasGuardian(database, fileContentMatch[1], identity.userId)) {
            sendJson(response, 404, { error: "NOT_FOUND", message: "File not found." });
            return;
          }
          if (!viewRequest || viewRequest.status !== "approved"
            || viewRequest.membershipVersion !== repository.membershipVersion) {
            throw requestError(403, "VIEW_NOT_APPROVED", "A current approved view request is required before accessing this file.");
          }
          const file = getFile(database, fileContentMatch[1], fileContentMatch[2]);
          if (!file) {
            sendJson(response, 404, { error: "FILE_NOT_FOUND", message: "File not found." });
            return;
          }
          const storagePath = resolve(recordingsDir, file.repositoryId, file.storageName);
          if (!storagePath.startsWith(`${resolve(recordingsDir)}${sep}`) || !existsSync(storagePath)) {
            throw requestError(404, "FILE_NOT_FOUND", "File data is unavailable.");
          }
          database.exec("BEGIN IMMEDIATE");
          try {
            const consumed = database.prepare(`
              UPDATE quorum_requests SET consumed_at = ?
              WHERE id = ? AND status = 'approved' AND consumed_at IS NULL
                AND membership_version = ?
            `).run(new Date().toISOString(), viewRequest.id, repository.membershipVersion);
            if (consumed.changes !== 1) {
              throw requestError(409, "VIEW_REQUEST_CONSUMED", "This approved view request has already been used.");
            }
            audit(database, repository.id, identity.userId, "file.view-consumed", {
              requestId,
              fileId: file.id,
            });
            database.exec("COMMIT");
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
          response.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "no-store",
            "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.displayName)}`,
            "X-HomeLock-Content-Type": file.contentType,
            "X-HomeLock-Encryption-IV": file.encryptionIv,
            "X-HomeLock-Encryption-Key": file.encryptionKey,
            "X-Content-Options": "nosniff",
          });
          createReadStream(storagePath).pipe(response);
          return;
        }

        const directFileDeleteMatch = /^\/api\/repositories\/([a-f0-9-]{36})\/files\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (directFileDeleteMatch && request.method === "DELETE") {
          requireSameOrigin(request, config.appOrigin);
          const identity = await authenticate(request);
          if (!hasGuardian(database, directFileDeleteMatch[1], identity.userId)) {
            sendJson(response, 404, { error: "NOT_FOUND", message: "Repository not found." });
            return;
          }
          throw requestError(409, "QUORUM_REQUEST_REQUIRED", "Create a deletion request and collect approval from every current guardian.");
        }

        if (request.method === "GET" && url.pathname === "/api/config") {
          sendJson(response, 200, {
            authConfigured: config.authConfigured,
            redirectUri: config.redirectUri,
            gates: config.gates,
            authIssue: config.adapterIssue || null,
            clientOriginAuthConfigured: config.clientOriginAuthConfigured,
            quorumMode: "homeLock-application-managed",
            notice: "Votes are enforced by the HomeLock API and stored in SQLite; they are not Tide/ORK-enforced authorization.",
          });
          return;
        }

        if (url.pathname === "/api/repositories" && request.method === "GET") {
          const identity = await authenticate(request);
          const rows = database.prepare(`
            SELECT r.id, r.name, r.description, r.created_at AS createdAt,
              r.membership_version AS membershipVersion
            FROM repositories r
            JOIN repository_guardians g ON g.repository_id = r.id
            WHERE g.user_id = ?
            ORDER BY created_at DESC
          `).all(identity.userId);
          sendJson(response, 200, { repositories: rows });
          return;
        }

        if (url.pathname === "/api/repositories" && request.method === "POST") {
          requireSameOrigin(request, config.appOrigin);
          const identity = await authenticate(request);
          const input = await readJson(request);
          const name = typeof input.name === "string" ? input.name.trim() : "";
          const description = typeof input.description === "string" ? input.description.trim() : "";
          if (!name || name.length > 80 || description.length > 500) {
            sendJson(response, 400, {
              error: "INVALID_REPOSITORY",
              message: "Provide a repository name (1–80 characters) and description (up to 500 characters).",
            });
            return;
          }

          const id = randomUUID();
          const createdAt = new Date().toISOString();
          database.exec("BEGIN IMMEDIATE");
          try {
            database.prepare(`
              INSERT INTO repositories (id, creator_user_id, name, description, created_at)
              VALUES (?, ?, ?, ?, ?)
            `).run(id, identity.userId, name, description, createdAt);
            database.prepare(`
              INSERT INTO repository_guardians (repository_id, user_id, joined_at)
              VALUES (?, ?, ?)
            `).run(id, identity.userId, createdAt);
            audit(database, id, identity.userId, "repository.created");
            database.exec("COMMIT");
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }

          sendJson(response, 201, {
            repository: { id, name, description, createdAt, membershipVersion: 1 },
            notice: "You are the first guardian. Approval workflows are enforced by this application, not Tide/ORK.",
          });
          return;
        }

        const repositoryDetailMatch = /^\/api\/repositories\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (repositoryDetailMatch && request.method === "GET") {
          const identity = await authenticate(request);
          const repository = getRepository(database, repositoryDetailMatch[1]);
          if (!repository || !hasGuardian(database, repository.id, identity.userId)) {
            sendJson(response, 404, { error: "NOT_FOUND", message: "Repository not found." });
            return;
          }
          const files = database.prepare(`
            SELECT id, display_name AS name, content_type AS contentType,
              size_bytes AS sizeBytes, uploaded_by AS uploadedBy, created_at AS createdAt
            FROM repository_files WHERE repository_id = ?
            ORDER BY created_at DESC
          `).all(repository.id);
          const guardians = currentGuardians(database, repository.id);
          sendJson(response, 200, {
            repository,
            currentUserId: identity.userId,
            files,
            guardians: guardians.map((userId) => ({ userId })),
            requests: listQuorumRequests(database, repository.id, identity.userId),
            gates: {
              fileUpload: "application-quorum",
              fileRemoval: "application-quorum",
              guardianMembership: "application-quorum",
              tideOrkQuorum: false,
            },
          });
          return;
        }

        sendJson(response, 404, { error: "NOT_FOUND", message: "API endpoint not found." });
      } catch (error) {
        if (error instanceof AuthError) {
          sendJson(response, error.statusCode, { error: error.code, message: error.message });
          return;
        }
        if (error?.statusCode) {
          sendJson(response, error.statusCode, {
            error: error.code || "REQUEST_ERROR",
            message: error.message,
          });
          return;
        }
        console.error("[homelock] API request failed", {
          method: request.method,
          path: url.pathname,
          error: error?.name || "Error",
          code: error?.code || null,
          message: error?.message || "Unknown error",
        });
        sendJson(response, 500, { error: "INTERNAL_ERROR", message: "The request could not be completed." });
      }
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "Method not allowed." });
      return;
    }
    if (/^\/tide_dpop\/iss\/[a-f0-9]+\/aud\/[a-f0-9]+\/tide_dpop_auth\.html$/i.test(url.pathname)) {
      const relayPath = resolve(PUBLIC_DIR, "tide_dpop_auth.html");
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'",
        "Allow-CSP-From": "*",
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(relayPath).pipe(response);
      return;
    }
    servePublic(request, response, url.pathname);
  });

  return { server, database, config };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, database, config } = createHomeLockServer();
  const port = Number.parseInt(process.env.PORT || "3000", 10);
  server.listen(port, "0.0.0.0", () => {
    console.log(`[homelock] listening on ${port}; Tide auth configured: ${config.authConfigured}`);
  });
  const close = () => server.close(() => {
    database.close();
    process.exit(0);
  });
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
