import { randomUUID } from "node:crypto";
import { ApiError } from "./recording-controller.mjs";

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

        const guardians = db.prepare(`
          SELECT subject_id FROM repository_members
          WHERE repository_id = ? AND status = 'active'
          ORDER BY subject_id
        `).all(recording.repository_id);
        if (guardians.length === 0) throw new ApiError(409, "Recording has no active guardians to approve a view.");
        requiredApprovals = guardians.length;

        db.prepare(`
          INSERT INTO view_requests (id, recording_id, requester_subject_id, status, created_at)
          VALUES (?, ?, ?, 'pending', ?)
        `).run(requestId, recordingId, claims.sub, createdAt);
        const snapshot = db.prepare(
          "INSERT INTO view_request_guardians (request_id, subject_id) VALUES (?, ?)",
        );
        guardians.forEach(({ subject_id }) => snapshot.run(requestId, subject_id));
      });

      sendJson(response, 201, { requestId, status: "pending", requiredApprovals });
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
            WHERE a.request_id = v.id AND a.approver_subject_id = ? LIMIT 1) AS my_decision
        FROM view_requests v
        JOIN recordings rec ON rec.id = v.recording_id
        WHERE rec.repository_id = ? AND v.status IN ('pending', 'approved', 'cancelled')
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
          db.prepare("UPDATE view_requests SET status = 'approved', resolved_at = ? WHERE id = ?")
            .run(new Date().toISOString(), requestId);
          return "approved";
        }
        return "pending";
      });

      sendJson(response, 200, { requestId, status });
    },

    async getApprovedView(_request, response, claims, requestId) {
      const access = db.prepare(`
        SELECT v.status, v.requester_subject_id, rec.object_key, rec.filename, rec.repository_id
        FROM view_requests v JOIN recordings rec ON rec.id = v.recording_id
        WHERE v.id = ? AND rec.status = 'available'
      `).get(requestId);
      if (!access || access.requester_subject_id !== claims.sub || access.status !== "approved") {
        throw new ApiError(404, "Approved view request not found.");
      }
      if (!activeMember(db, access.repository_id, claims.sub)) {
        throw new ApiError(403, "Only an active subscriber can retrieve recording access.");
      }

      const url = await storage.signDownload(access.object_key, access.filename);
      sendJson(response, 200, { url, expiresInSeconds: 300 });
    },
  };
}
