import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { recordAuditEvent } from "../audit.mjs";
import { ApiError } from "../errors.mjs";
import { requireGuardianQuorumPolicy } from "../security/guardian-policy.mjs";

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function withTransaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function activeMember(db, repositoryId, subjectId) {
  return db.prepare(
    "SELECT role FROM repository_members WHERE repository_id = ? AND subject_id = ? AND status = 'active'",
  ).get(repositoryId, subjectId);
}

export function createViewController({ db, storage }) {
  const contentLinkKey = randomBytes(32);

  function createContentToken(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", contentLinkKey).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  function readContentToken(token) {
    if (typeof token !== "string") throw new ApiError(403, "Recording link is invalid or expired.");
    const [encoded, suppliedSignature, extra] = token.split(".");
    if (!encoded || !suppliedSignature || extra !== undefined) {
      throw new ApiError(403, "Recording link is invalid or expired.");
    }
    const expectedSignature = createHmac("sha256", contentLinkKey).update(encoded).digest();
    let actualSignature;
    let payload;
    try {
      actualSignature = Buffer.from(suppliedSignature, "base64url");
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw new ApiError(403, "Recording link is invalid or expired.");
    }
    if (
      !payload
      || typeof payload !== "object"
      || typeof payload.requestId !== "string"
      || typeof payload.recordingId !== "string"
      || typeof payload.subjectId !== "string"
      || actualSignature.length !== expectedSignature.length
      || !timingSafeEqual(actualSignature, expectedSignature)
      || !Number.isSafeInteger(payload.expiresAt)
      || payload.expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      throw new ApiError(403, "Recording link is invalid or expired.");
    }
    return payload;
  }

  return {
    requestView(_request, response, claims, recordingId) {
      const requestId = randomUUID();
      const createdAt = new Date().toISOString();
      let requiredApprovals = 0;

      withTransaction(db, () => {
        const recording = db.prepare(
          "SELECT id, repository_id, status FROM recordings WHERE id = ?",
        ).get(recordingId);
        if (
          !recording
          || recording.status !== "available"
          || !activeMember(db, recording.repository_id, claims.sub)
        ) {
          throw new ApiError(404, "Recording not found or account is not an active subscriber.");
        }
        const pending = db.prepare(`
          SELECT id FROM view_requests
          WHERE recording_id = ? AND requester_subject_id = ? AND status IN ('pending', 'approved')
        `).get(recordingId, claims.sub);
        if (pending) throw new ApiError(409, "A view request is already pending or awaiting Tide enforcement.");

        const guardians = db.prepare(`
          SELECT subject_id FROM repository_members
          WHERE repository_id = ? AND status = 'active' AND subject_id != ?
          ORDER BY subject_id
        `).all(recording.repository_id, claims.sub);
        if (guardians.length === 0) {
          throw new ApiError(409, "A view request needs at least one other active guardian to approve it.");
        }
        requiredApprovals = guardians.length;

        db.prepare(`
          INSERT INTO view_requests (id, recording_id, requester_subject_id, status, created_at)
          VALUES (?, ?, ?, 'pending', ?)
        `).run(requestId, recordingId, claims.sub, createdAt);
        const snapshot = db.prepare(
          "INSERT INTO view_request_guardians (request_id, subject_id) VALUES (?, ?)",
        );
        guardians.forEach(({ subject_id }) => snapshot.run(requestId, subject_id));
        recordAuditEvent(db, {
          repositoryId: recording.repository_id,
          actorSubjectId: claims.sub,
          eventType: "recording.view_requested",
          targetType: "view_request",
          targetId: requestId,
          details: { recordingId, requiredApprovals },
          createdAt,
        });
      });

      sendJson(response, 201, {
        requestId,
        status: "pending",
        requiredApprovals,
        policyStatus: "not_configured",
      });
    },

    listViewRequests(_request, response, claims, recordingId) {
      const recording = db.prepare(
        "SELECT repository_id FROM recordings WHERE id = ? AND status = 'available'",
      ).get(recordingId);
      if (!recording || !activeMember(db, recording.repository_id, claims.sub)) {
        throw new ApiError(404, "Recording not found or account is not an active subscriber.");
      }

      const requests = db.prepare(`
        SELECT v.id, v.requester_subject_id, v.status, v.cancellation_reason, v.created_at, v.resolved_at,
          (SELECT COUNT(*) FROM view_request_guardians g WHERE g.request_id = v.id) AS required_approvals,
          (SELECT COUNT(*) FROM view_approvals a WHERE a.request_id = v.id AND a.decision = 'approve') AS approved_count
        FROM view_requests v WHERE v.recording_id = ? ORDER BY v.created_at DESC
      `).all(recordingId);
      sendJson(response, 200, { requests });
    },

    listRepositoryViewRequests(_request, response, claims, repositoryId) {
      if (!activeMember(db, repositoryId, claims.sub)) {
        throw new ApiError(404, "Repository not found or account is not an active subscriber.");
      }
      const requests = db.prepare(`
        SELECT v.id, v.recording_id, v.requester_subject_id, v.status, v.cancellation_reason, v.created_at,
          rec.filename,
          (SELECT COUNT(*) FROM view_request_guardians g WHERE g.request_id = v.id) AS required_approvals,
          (SELECT COUNT(*) FROM view_approvals a WHERE a.request_id = v.id AND a.decision = 'approve') AS approved_count,
          (SELECT a.decision FROM view_approvals a
            WHERE a.request_id = v.id AND a.approver_subject_id = ? LIMIT 1) AS my_decision,
          (SELECT COUNT(*) FROM view_request_guardians g WHERE g.request_id = v.id) =
          (SELECT COUNT(*) FROM view_approvals a WHERE a.request_id = v.id AND a.decision = 'approve')
            AS approval_complete
        FROM view_requests v
        JOIN recordings rec ON rec.id = v.recording_id
        WHERE rec.repository_id = ? AND v.status IN ('pending', 'approved', 'cancelled', 'rejected')
        ORDER BY v.created_at DESC
      `).all(claims.sub, repositoryId);
      sendJson(response, 200, { requests });
    },

    decideView(_request, response, claims, requestId, body) {
      if (!["approve", "reject"].includes(body.decision)) {
        throw new ApiError(400, "decision must be approve or reject.");
      }

      const status = withTransaction(db, () => {
        const request = db.prepare(`
          SELECT v.id, v.recording_id, v.requester_subject_id, v.status, rec.repository_id
          FROM view_requests v JOIN recordings rec ON rec.id = v.recording_id
          WHERE v.id = ?
        `).get(requestId);
        if (!request || request.status !== "pending") throw new ApiError(404, "Pending view request not found.");

        const requiredGuardian = db.prepare(
          "SELECT subject_id FROM view_request_guardians WHERE request_id = ? AND subject_id = ?",
        ).get(requestId, claims.sub);
        if (!requiredGuardian || !activeMember(db, request.repository_id, claims.sub)) {
          throw new ApiError(403, "Only an active subscriber included in this request can decide it.");
        }

        const inserted = db.prepare(`
          INSERT OR IGNORE INTO view_approvals (request_id, approver_subject_id, decision, created_at)
          VALUES (?, ?, ?, ?)
        `).run(requestId, claims.sub, body.decision, new Date().toISOString());
        if (inserted.changes !== 1) throw new ApiError(409, "This subscriber has already decided the view request.");

        recordAuditEvent(db, {
          repositoryId: request.repository_id,
          actorSubjectId: claims.sub,
          eventType: body.decision === "approve" ? "recording.view_approval_recorded" : "recording.view_request_rejected",
          targetType: "view_request",
          targetId: requestId,
          details: { recordingId: request.recording_id, decision: body.decision },
        });
        if (body.decision === "reject") {
          db.prepare("UPDATE view_requests SET status = 'rejected', resolved_at = ? WHERE id = ?")
            .run(new Date().toISOString(), requestId);
          return "rejected";
        }

        const needed = db.prepare(
          "SELECT COUNT(*) AS count FROM view_request_guardians WHERE request_id = ?",
        ).get(requestId).count;
        const approved = db.prepare(
          "SELECT COUNT(*) AS count FROM view_approvals WHERE request_id = ? AND decision = 'approve'",
        ).get(requestId).count;
        if (approved === needed) {
          return "awaiting_tide_policy";
        }
        return "pending";
      });

      sendJson(response, 200, { requestId, status });
    },

    async getApprovedView(_request, response, claims, requestId) {
      requireGuardianQuorumPolicy();
      const access = db.prepare(`
        SELECT v.status, v.requester_subject_id, v.recording_id, rec.filename, rec.repository_id
        FROM view_requests v JOIN recordings rec ON rec.id = v.recording_id
        WHERE v.id = ? AND rec.status = 'available'
      `).get(requestId);
      if (!access || access.requester_subject_id !== claims.sub || access.status !== "approved") {
        throw new ApiError(404, "Approved view request not found.");
      }
      if (!activeMember(db, access.repository_id, claims.sub)) {
        throw new ApiError(403, "Only an active subscriber can retrieve recording access.");
      }

      const expiresAt = Math.floor(Date.now() / 1000) + 300;
      const token = createContentToken({
        requestId,
        recordingId: access.recording_id,
        subjectId: claims.sub,
        expiresAt,
      });
      const url = `/api/recordings/${access.recording_id}/content?token=${encodeURIComponent(token)}`;
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      response.end(JSON.stringify({ url, expiresInSeconds: 300 }));
    },

    async streamApprovedView(request, response, recordingId, token) {
      requireGuardianQuorumPolicy();
      const grant = readContentToken(token);
      if (grant.recordingId !== recordingId) {
        throw new ApiError(403, "Recording link is invalid or expired.");
      }
      const access = db.prepare(`
        SELECT v.id, v.status, v.requester_subject_id, rec.object_key, rec.filename,
          rec.content_type, rec.repository_id
        FROM view_requests v JOIN recordings rec ON rec.id = v.recording_id
        WHERE v.id = ? AND v.recording_id = ? AND rec.status = 'available'
      `).get(grant.requestId, recordingId);
      if (
        !access
        || access.status !== "approved"
        || access.requester_subject_id !== grant.subjectId
        || !activeMember(db, access.repository_id, grant.subjectId)
      ) {
        throw new ApiError(403, "Recording access is no longer approved.");
      }

      let file;
      try {
        file = await storage.statObject(access.object_key);
      } catch (error) {
        if (error.code === "ENOENT") throw new ApiError(404, "Recording file not found.");
        throw error;
      }

      const range = request.headers.range;
      let start = 0;
      let end = file.size - 1;
      let status = 200;
      if (range !== undefined) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2]) || file.size === 0) {
          response.writeHead(416, { "Content-Range": `bytes */${file.size}` }).end();
          return;
        }
        if (match[1]) {
          start = Number(match[1]);
          end = match[2] ? Number(match[2]) : file.size - 1;
        } else {
          const suffixLength = Number(match[2]);
          start = Math.max(0, file.size - suffixLength);
        }
        if (
          !Number.isSafeInteger(start)
          || !Number.isSafeInteger(end)
          || start < 0
          || end < start
          || start >= file.size
        ) {
          response.writeHead(416, { "Content-Range": `bytes */${file.size}` }).end();
          return;
        }
        end = Math.min(end, file.size - 1);
        status = 206;
      }

      const headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        "Content-Type": access.content_type,
        "Content-Disposition": `inline; filename="${access.filename.replace(/[\u0000-\u001f\u007f"\\]/g, "_")}"`,
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      };
      if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${file.size}`;
      response.writeHead(status, headers);
      await pipeline(storage.createReadStream(access.object_key, { start, end }), response);
    },
  };
}
