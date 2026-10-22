import { randomUUID } from "node:crypto";
import { ApiError, MAX_REPOSITORY_BYTES } from "./recording-controller.mjs";

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function activeMember(db, repositoryId, subjectId) {
  return db.prepare(
    "SELECT role FROM repository_members WHERE repository_id = ? AND subject_id = ? AND status = 'active'",
  ).get(repositoryId, subjectId);
}

export function createRepositoryController({ db }) {
  return {
    list(_request, response, claims) {
      const repositories = db.prepare(`
        SELECT r.id, r.name, r.created_by, r.quota_bytes, r.created_at,
          COALESCE(SUM(CASE WHEN rec.status IN ('uploading', 'available') THEN rec.size_bytes ELSE 0 END), 0) AS used_bytes,
          (SELECT COUNT(*) FROM repository_members m2
            WHERE m2.repository_id = r.id AND m2.status = 'active') AS subscriber_count
        FROM repositories r
        JOIN repository_members m ON m.repository_id = r.id
        LEFT JOIN recordings rec ON rec.repository_id = r.id
        WHERE m.subject_id = ? AND m.status = 'active'
        GROUP BY r.id
        ORDER BY r.created_at
      `).all(claims.sub);
      sendJson(response, 200, { repositories });
    },

    create(_request, response, claims, body) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 120) throw new ApiError(400, "Repository name must be between 1 and 120 characters.");

      const id = randomUUID();
      const now = new Date().toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "INSERT INTO repositories (id, name, created_by, quota_bytes, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(id, name, claims.sub, MAX_REPOSITORY_BYTES, now);
        db.prepare(
          "INSERT INTO repository_members (repository_id, subject_id, role, status, joined_at) VALUES (?, ?, 'owner', 'active', ?)",
        ).run(id, claims.sub, now);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      sendJson(response, 201, {
        repository: { id, name, createdBy: claims.sub, quotaBytes: MAX_REPOSITORY_BYTES, createdAt: now },
      });
    },

    listRecordings(_request, response, claims, repositoryId) {
      if (!activeMember(db, repositoryId, claims.sub)) {
        throw new ApiError(404, "Repository not found or account is not an active subscriber.");
      }
      const recordings = db.prepare(`
        SELECT id, repository_id, uploader_subject_id, filename, content_type, size_bytes, created_at, completed_at
        FROM recordings
        WHERE repository_id = ? AND status = 'available'
        ORDER BY completed_at DESC
      `).all(repositoryId);
      sendJson(response, 200, { recordings });
    },

    listMembers(_request, response, claims, repositoryId) {
      if (!activeMember(db, repositoryId, claims.sub)) {
        throw new ApiError(404, "Repository not found or account is not an active subscriber.");
      }
      const members = db.prepare(`
        SELECT subject_id, role, joined_at
        FROM repository_members
        WHERE repository_id = ? AND status = 'active'
        ORDER BY joined_at, subject_id
      `).all(repositoryId);
      sendJson(response, 200, { members });
    },
  };
}
