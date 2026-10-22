import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const schema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
    created_by TEXT NOT NULL,
    quota_bytes INTEGER NOT NULL CHECK(quota_bytes > 0),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS repository_members (
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    subject_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner', 'guardian')),
    status TEXT NOT NULL CHECK(status IN ('active', 'left')),
    joined_at TEXT NOT NULL,
    left_at TEXT,
    PRIMARY KEY(repository_id, subject_id)
  );

  CREATE TABLE IF NOT EXISTS membership_requests (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    requester_subject_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'rejected', 'cancelled')),
    cancellation_reason TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS one_pending_membership_request
    ON membership_requests(repository_id, requester_subject_id) WHERE status = 'pending';

  CREATE TABLE IF NOT EXISTS membership_approvals (
    request_id TEXT NOT NULL REFERENCES membership_requests(id) ON DELETE CASCADE,
    approver_subject_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('approve', 'reject')),
    created_at TEXT NOT NULL,
    PRIMARY KEY(request_id, approver_subject_id)
  );

  CREATE TABLE IF NOT EXISTS membership_request_guardians (
    request_id TEXT NOT NULL REFERENCES membership_requests(id) ON DELETE CASCADE,
    subject_id TEXT NOT NULL,
    PRIMARY KEY(request_id, subject_id)
  );

  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    uploader_subject_id TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
    s3_upload_id TEXT UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('uploading', 'available', 'failed')),
    created_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS view_requests (
    id TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    requester_subject_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'cancelled')),
    cancellation_reason TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS view_approvals (
    request_id TEXT NOT NULL REFERENCES view_requests(id) ON DELETE CASCADE,
    approver_subject_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('approve', 'reject')),
    created_at TEXT NOT NULL,
    PRIMARY KEY(request_id, approver_subject_id)
  );

  CREATE TABLE IF NOT EXISTS view_request_guardians (
    request_id TEXT NOT NULL REFERENCES view_requests(id) ON DELETE CASCADE,
    subject_id TEXT NOT NULL,
    PRIMARY KEY(request_id, subject_id)
  );

  CREATE TABLE IF NOT EXISTS dpop_jti (
    jti TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
`;

export async function openDatabase(databasePath = process.env.SQLITE_PATH ?? "data/hearth.sqlite") {
  const resolvedPath = databasePath === ":memory:" ? databasePath : resolve(databasePath);
  if (resolvedPath !== ":memory:") {
    await mkdir(dirname(resolvedPath), { recursive: true });
  }

  const db = new DatabaseSync(resolvedPath);
  db.exec(schema);
  const recordingColumns = db.prepare("PRAGMA table_info(recordings)").all().map((column) => column.name);
  if (!recordingColumns.includes("s3_upload_id")) {
    db.exec("ALTER TABLE recordings ADD COLUMN s3_upload_id TEXT");
  }
  const viewRequestColumns = db.prepare("PRAGMA table_info(view_requests)").all().map((column) => column.name);
  if (!viewRequestColumns.includes("cancellation_reason")) {
    db.exec("ALTER TABLE view_requests ADD COLUMN cancellation_reason TEXT");
  }
  return db;
}

export function createSqliteJtiStore(db) {
  const insert = db.prepare("INSERT OR IGNORE INTO dpop_jti (jti, expires_at) VALUES (?, ?)");
  const prune = db.prepare("DELETE FROM dpop_jti WHERE expires_at < ?");

  return {
    async claim(jti, expiresAtMs) {
      const now = Date.now();
      prune.run(now);
      return insert.run(jti, expiresAtMs).changes === 1;
    },
  };
}
