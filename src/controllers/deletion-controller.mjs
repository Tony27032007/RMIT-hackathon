import { randomUUID } from "node:crypto";
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

export function createDeletionController({ db }) {
  return {
    requestDeletion(_request, response, claims, recordingId) {
      const requestId = randomUUID();
      const createdAt = new Date().toISOString();
      let requiredApprovals = 0;

      withTransaction(db, () => {
        const recording = db.prepare(`
          SELECT id, repository_id, status FROM recordings
          WHERE id = ? AND deleted_at IS NULL
        `).get(recordingId);
        if (
          !recording
          || recording.status !== "available"
          || !activeMember(db, recording.repository_id, claims.sub)
        ) {
          throw new ApiError(404, "Recording not found or account is not an active subscriber.");
        }

        const pending = db.prepare(`
          SELECT id FROM recording_deletion_requests
          WHERE recording_id = ? AND status = 'pending'
        `).get(recordingId);
        if (pending) throw new ApiError(409, "A recording deletion request is already pending.");

        const guardians = db.prepare(`
          SELECT subject_id FROM repository_members
          WHERE repository_id = ? AND status = 'active' AND subject_id != ?
          ORDER BY subject_id
        `).all(recording.repository_id, claims.sub);
        if (guardians.length === 0) {
          throw new ApiError(409, "A deletion request needs at least one other active guardian to approve it.");
        }
        requiredApprovals = guardians.length;

        db.prepare(`
          INSERT INTO recording_deletion_requests (id, recording_id, requester_subject_id, status, created_at)
          VALUES (?, ?, ?, 'pending', ?)
        `).run(requestId, recordingId, claims.sub, createdAt);
        const addGuardian = db.prepare(`
          INSERT INTO recording_deletion_request_guardians (request_id, subject_id) VALUES (?, ?)
        `);
        guardians.forEach(({ subject_id }) => addGuardian.run(requestId, subject_id));
        recordAuditEvent(db, {
          repositoryId: recording.repository_id,
          actorSubjectId: claims.sub,
          eventType: "recording.deletion_requested",
          targetType: "recording_deletion_request",
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

    listDeletionRequests(_request, response, claims, repositoryId) {
      if (!activeMember(db, repositoryId, claims.sub)) {
        throw new ApiError(404, "Repository not found or account is not an active subscriber.");
      }
      const requests = db.prepare(`
        SELECT d.id, d.recording_id, d.requester_subject_id, d.status, d.created_at, d.resolved_at,
          rec.filename,
          (SELECT COUNT(*) FROM recording_deletion_request_guardians g WHERE g.request_id = d.id)
            AS required_approvals,
          (SELECT COUNT(*) FROM recording_deletion_approvals a
            WHERE a.request_id = d.id AND a.decision = 'approve') AS approved_count,
          (SELECT a.decision FROM recording_deletion_approvals a
            WHERE a.request_id = d.id AND a.approver_subject_id = ? LIMIT 1) AS my_decision,
          (SELECT COUNT(*) FROM recording_deletion_request_guardians g WHERE g.request_id = d.id) =
          (SELECT COUNT(*) FROM recording_deletion_approvals a
            WHERE a.request_id = d.id AND a.decision = 'approve') AS approval_complete
        FROM recording_deletion_requests d
        JOIN recordings rec ON rec.id = d.recording_id
        WHERE rec.repository_id = ? AND d.status IN ('pending', 'rejected', 'cancelled')
        ORDER BY d.created_at DESC
        LIMIT 100
      `).all(claims.sub, repositoryId);
      sendJson(response, 200, { requests });
    },

    decideDeletion(_request, response, claims, requestId, body) {
      if (!["approve", "reject"].includes(body.decision)) {
        throw new ApiError(400, "decision must be approve or reject.");
      }

      const result = withTransaction(db, () => {
        const request = db.prepare(`
          SELECT d.id, d.recording_id, d.requester_subject_id, d.status, rec.repository_id
          FROM recording_deletion_requests d
          JOIN recordings rec ON rec.id = d.recording_id
          WHERE d.id = ?
        `).get(requestId);
        if (!request || request.status !== "pending") {
          throw new ApiError(404, "Pending recording deletion request not found.");
        }
        if (request.requester_subject_id === claims.sub) {
          throw new ApiError(403, "The requester cannot approve their own deletion request.");
        }
        const includedGuardian = db.prepare(`
          SELECT subject_id FROM recording_deletion_request_guardians
          WHERE request_id = ? AND subject_id = ?
        `).get(requestId, claims.sub);
        if (!includedGuardian || !activeMember(db, request.repository_id, claims.sub)) {
          throw new ApiError(403, "Only an active guardian included in this request can decide it.");
        }

        const now = new Date().toISOString();
        const inserted = db.prepare(`
          INSERT OR IGNORE INTO recording_deletion_approvals
            (request_id, approver_subject_id, decision, created_at)
          VALUES (?, ?, ?, ?)
        `).run(requestId, claims.sub, body.decision, now);
        if (inserted.changes !== 1) {
          throw new ApiError(409, "This guardian has already decided the deletion request.");
        }

        recordAuditEvent(db, {
          repositoryId: request.repository_id,
          actorSubjectId: claims.sub,
          eventType: body.decision === "approve"
            ? "recording.deletion_approval_recorded"
            : "recording.deletion_request_rejected",
          targetType: "recording_deletion_request",
          targetId: requestId,
          details: { recordingId: request.recording_id, decision: body.decision },
          createdAt: now,
        });

        if (body.decision === "reject") {
          db.prepare(`
            UPDATE recording_deletion_requests SET status = 'rejected', resolved_at = ? WHERE id = ?
          `).run(now, requestId);
          return { status: "rejected", approvalComplete: false };
        }

        const needed = db.prepare(`
          SELECT COUNT(*) AS count FROM recording_deletion_request_guardians WHERE request_id = ?
        `).get(requestId).count;
        const approved = db.prepare(`
          SELECT COUNT(*) AS count FROM recording_deletion_approvals
          WHERE request_id = ? AND decision = 'approve'
        `).get(requestId).count;
        return {
          status: approved === needed ? "awaiting_tide_policy" : "pending",
          approvalComplete: approved === needed,
        };
      });
      sendJson(response, 200, { requestId, ...result, policyStatus: "not_configured" });
    },

    deleteRecording(_request, _response, _claims, _recordingId) {
      requireGuardianQuorumPolicy();
    },
  };
}
