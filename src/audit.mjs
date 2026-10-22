import { randomUUID } from "node:crypto";

export function recordAuditEvent(db, {
  repositoryId,
  actorSubjectId,
  eventType,
  targetType,
  targetId,
  details = {},
  createdAt = new Date().toISOString(),
}) {
  db.prepare(`
    INSERT INTO audit_events
      (id, repository_id, actor_subject_id, event_type, target_type, target_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    repositoryId,
    actorSubjectId,
    eventType,
    targetType,
    targetId,
    JSON.stringify(details),
    createdAt,
  );
}
