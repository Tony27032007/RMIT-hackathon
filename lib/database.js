import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(filename) {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filename);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      creator_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      membership_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS repositories_creator
      ON repositories(creator_user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      avatar_data BLOB,
      avatar_content_type TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repository_guardians (
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS repository_guardians_user
      ON repository_guardians(user_id, repository_id);

    CREATE TABLE IF NOT EXISTS repository_files (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      uploaded_by TEXT NOT NULL,
      display_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      storage_name TEXT NOT NULL UNIQUE,
      encryption_iv TEXT NOT NULL,
      encryption_key TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS repository_files_repository
      ON repository_files(repository_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS quorum_requests (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      request_type TEXT NOT NULL CHECK (request_type IN ('guardian-invite', 'join', 'view', 'delete')),
      actor_user_id TEXT NOT NULL,
      target_user_id TEXT,
      file_id TEXT REFERENCES repository_files(id) ON DELETE SET NULL,
      membership_version INTEGER NOT NULL,
      required_approvals INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      consumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS quorum_requests_repository
      ON quorum_requests(repository_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS quorum_request_guardians (
      request_id TEXT NOT NULL REFERENCES quorum_requests(id) ON DELETE CASCADE,
      guardian_user_id TEXT NOT NULL,
      PRIMARY KEY (request_id, guardian_user_id)
    );

    CREATE TABLE IF NOT EXISTS quorum_votes (
      request_id TEXT NOT NULL REFERENCES quorum_requests(id) ON DELETE CASCADE,
      guardian_user_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (request_id, guardian_user_id)
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      actor_user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_events_repository
      ON audit_events(repository_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS dpop_jti (
      jkt TEXT NOT NULL,
      jti TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (jkt, jti)
    );
  `);

  const repositoryColumns = new Set(
    database.prepare("PRAGMA table_info(repositories)").all().map((column) => column.name),
  );
  if (!repositoryColumns.has("membership_version")) {
    database.exec("ALTER TABLE repositories ADD COLUMN membership_version INTEGER NOT NULL DEFAULT 1");
  }
  const requestColumns = new Set(
    database.prepare("PRAGMA table_info(quorum_requests)").all().map((column) => column.name),
  );
  if (requestColumns.size && !requestColumns.has("consumed_at")) {
    database.exec("ALTER TABLE quorum_requests ADD COLUMN consumed_at TEXT");
  }
  database.exec(`
    INSERT OR IGNORE INTO repository_guardians (repository_id, user_id, joined_at)
    SELECT id, creator_user_id, created_at FROM repositories;
  `);

  const insertJti = database.prepare(
    "INSERT OR IGNORE INTO dpop_jti (jkt, jti, expires_at) VALUES (?, ?, ?)",
  );
  const deleteExpiredJtis = database.prepare("DELETE FROM dpop_jti WHERE expires_at < ?");

  return {
    database,
    jtiStore: {
      async claim(jkt, jti, expiresAt) {
        deleteExpiredJtis.run(Date.now());
        return insertJti.run(jkt, jti, expiresAt).changes === 1;
      },
    },
  };
}
