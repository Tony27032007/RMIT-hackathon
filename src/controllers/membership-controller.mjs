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

export function createMembershipController({ db }) {
  return {
    requestMembership(_request, response, claims, repositoryId) {
      const requestId = randomUUID();
      const createdAt = new Date().toISOString();
      withTransaction(db, () => {
        const repository = db.prepare("SELECT id FROM repositories WHERE id = ?").get(repositoryId);
        if (!repository) throw new ApiError(404, "Repository not found.");
        if (activeMember(db, repositoryId, claims.sub)) {
          throw new ApiError(409, "This account is already subscribed to the repository.");
        }
        const pending = db.prepare(
          "SELECT id FROM membership_requests WHERE repository_id = ? AND requester_subject_id = ? AND status = 'pending'",
        ).get(repositoryId, claims.sub);
        if (pending) throw new ApiError(409, "A membership request is already pending.");

        const guardians = db.prepare(
          "SELECT subject_id FROM repository_members WHERE repository_id = ? AND status = 'active' ORDER BY subject_id",
        ).all(repositoryId);
        if (guardians.length === 0) throw new ApiError(409, "Repository has no active guardians to approve requests.");

        db.prepare(`
          INSERT INTO membership_requests (id, repository_id, requester_subject_id, status, created_at)
          VALUES (?, ?, ?, 'pending', ?)
        `).run(requestId, repositoryId, claims.sub, createdAt);
        const snapshot = db.prepare(
          "INSERT INTO membership_request_guardians (request_id, subject_id) VALUES (?, ?)",
        );
        guardians.forEach(({ subject_id }) => snapshot.run(requestId, subject_id));
      });

      sendJson(response, 201, { requestId, status: "pending" });
    },

    listMembershipRequests(_request, response, claims, repositoryId) {
      if (!activeMember(db, repositoryId, claims.sub)) {
        throw new ApiError(404, "Repository not found or account is not an active subscriber.");
      }
      const requests = db.prepare(`
        SELECT r.id, r.requester_subject_id, r.status, r.cancellation_reason, r.created_at, r.resolved_at,
          (SELECT COUNT(*) FROM membership_request_guardians g WHERE g.request_id = r.id) AS required_approvals,
          (SELECT COUNT(*) FROM membership_approvals a WHERE a.request_id = r.id AND a.decision = 'approve') AS approved_count,
          (SELECT a.decision FROM membership_approvals a
            WHERE a.request_id = r.id AND a.approver_subject_id = ? LIMIT 1) AS my_decision
        FROM membership_requests r
        WHERE r.repository_id = ? AND r.status IN ('pending', 'cancelled')
        ORDER BY r.created_at DESC
        LIMIT 100
      `).all(claims.sub, repositoryId);
      sendJson(response, 200, { requests });
    },

    decideMembership(_request, response, claims, requestId, body) {
      if (!["approve", "reject"].includes(body.decision)) {
        throw new ApiError(400, "decision must be approve or reject.");
      }

      const result = withTransaction(db, () => {
        const request = db.prepare(
          "SELECT id, repository_id, requester_subject_id, status FROM membership_requests WHERE id = ?",
        ).get(requestId);
        if (!request || request.status !== "pending") throw new ApiError(404, "Pending membership request not found.");
        if (request.requester_subject_id === claims.sub) {
          throw new ApiError(403, "An applicant cannot approve their own membership request.");
        }

        const required = db.prepare(
          "SELECT subject_id FROM membership_request_guardians WHERE request_id = ? AND subject_id = ?",
        ).get(requestId, claims.sub);
        if (!required || !activeMember(db, request.repository_id, claims.sub)) {
          throw new ApiError(403, "Only an active subscriber included in this request's approval set can decide it.");
        }

        const inserted = db.prepare(`
          INSERT OR IGNORE INTO membership_approvals (request_id, approver_subject_id, decision, created_at)
          VALUES (?, ?, ?, ?)
        `).run(requestId, claims.sub, body.decision, new Date().toISOString());
        if (inserted.changes !== 1) throw new ApiError(409, "This subscriber has already decided the request.");

        const now = new Date().toISOString();
        if (body.decision === "reject") {
          db.prepare(
            "UPDATE membership_requests SET status = 'rejected', resolved_at = ? WHERE id = ?",
          ).run(now, requestId);
          return "rejected";
        }

        const needed = db.prepare(
          "SELECT COUNT(*) AS count FROM membership_request_guardians WHERE request_id = ?",
        ).get(requestId).count;
        const approved = db.prepare(
          "SELECT COUNT(*) AS count FROM membership_approvals WHERE request_id = ? AND decision = 'approve'",
        ).get(requestId).count;
        if (approved === needed) {
          db.prepare(
            "UPDATE membership_requests SET status = 'accepted', resolved_at = ? WHERE id = ?",
          ).run(now, requestId);
          db.prepare(`
            INSERT INTO repository_members (repository_id, subject_id, role, status, joined_at, left_at)
            VALUES (?, ?, 'guardian', 'active', ?, NULL)
            ON CONFLICT(repository_id, subject_id) DO UPDATE SET
              role = 'guardian', status = 'active', joined_at = excluded.joined_at, left_at = NULL
          `).run(request.repository_id, request.requester_subject_id, now);
          return "accepted";
        }
        return "pending";
      });

      sendJson(response, 200, { requestId, status: result });
    },

    leaveRepository(_request, response, claims, repositoryId) {
      const now = new Date().toISOString();
      withTransaction(db, () => {
        const member = activeMember(db, repositoryId, claims.sub);
        if (!member) throw new ApiError(404, "Active repository membership not found.");

        const others = db.prepare(
          "SELECT subject_id, role FROM repository_members WHERE repository_id = ? AND status = 'active' AND subject_id != ? ORDER BY joined_at, subject_id",
        ).all(repositoryId, claims.sub);
        if (others.length === 0) throw new ApiError(409, "The last guardian cannot leave the repository.");

        db.prepare(
          "UPDATE repository_members SET status = 'left', left_at = ? WHERE repository_id = ? AND subject_id = ?",
        ).run(now, repositoryId, claims.sub);

        if (member.role === "owner") {
          db.prepare(
            "UPDATE repository_members SET role = 'owner' WHERE repository_id = ? AND subject_id = ?",
          ).run(repositoryId, others[0].subject_id);
        }

        const affectedMembership = db.prepare(`
          SELECT DISTINCT r.id
          FROM membership_requests r
          JOIN membership_request_guardians g ON g.request_id = r.id
          WHERE r.repository_id = ? AND r.status = 'pending' AND g.subject_id = ?
        `).all(repositoryId, claims.sub);
        const affectedViews = db.prepare(`
          SELECT DISTINCT v.id
          FROM view_requests v
          JOIN recordings rec ON rec.id = v.recording_id
          JOIN view_request_guardians g ON g.request_id = v.id
          WHERE rec.repository_id = ? AND v.status = 'pending' AND g.subject_id = ?
        `).all(repositoryId, claims.sub);

        const cancelMembership = db.prepare(`
          UPDATE membership_requests SET status = 'cancelled',
            cancellation_reason = 'Request canceled due to guardian leaving', resolved_at = ?
          WHERE id = ? AND status = 'pending'
        `);
        const cancelView = db.prepare(`
          UPDATE view_requests SET status = 'cancelled',
            cancellation_reason = 'Request canceled due to guardian leaving', resolved_at = ?
          WHERE id = ? AND status = 'pending'
        `);
        affectedMembership.forEach(({ id }) => cancelMembership.run(now, id));
        affectedViews.forEach(({ id }) => cancelView.run(now, id));

        const resetMembership = db.prepare("DELETE FROM membership_approvals WHERE request_id = ?");
        const resetView = db.prepare("DELETE FROM view_approvals WHERE request_id = ?");
        affectedMembership.forEach(({ id }) => resetMembership.run(id));
        affectedViews.forEach(({ id }) => resetView.run(id));
      });
      sendJson(response, 200, { repositoryId, status: "left" });
    },
  };
}
