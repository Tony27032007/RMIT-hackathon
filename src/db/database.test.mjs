import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, createSqliteJtiStore } from "./database.mjs";

test("initializes the repository schema and rejects duplicate DPoP proofs", async () => {
  const db = await openDatabase(":memory:");
  try {
    const store = createSqliteJtiStore(db);
    assert.equal(await store.claim("proof-id", Date.now() + 30_000), true);
    assert.equal(await store.claim("proof-id", Date.now() + 30_000), false);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'view_requests'").get());
  } finally {
    db.close();
  }
});

test("upgrades legacy recording and view-request tables without losing data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hearth-migration-"));
  const databasePath = join(directory, "legacy.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE repositories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      quota_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE recordings (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      uploader_subject_id TEXT NOT NULL,
      object_key TEXT NOT NULL,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE view_requests (
      id TEXT PRIMARY KEY,
      recording_id TEXT NOT NULL,
      requester_subject_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    INSERT INTO recordings VALUES (
      'recording-legacy', 'repo-legacy', 'guardian-legacy',
      'repositories/repo-legacy/recordings/recording-legacy',
      'legacy.mp4', 'video/mp4', 42, 'available', '2025-01-01T00:00:00.000Z',
      '2025-01-01T00:01:00.000Z'
    );
    INSERT INTO view_requests VALUES (
      'view-legacy', 'recording-legacy', 'guardian-legacy', 'approved',
      '2025-01-01T00:02:00.000Z', '2025-01-01T00:03:00.000Z'
    );
  `);
  legacy.close();

  try {
    const db = await openDatabase(databasePath);
    try {
      const recording = db.prepare(
        "SELECT id, filename, size_bytes, s3_upload_id FROM recordings WHERE id = ?",
      ).get("recording-legacy");
      const request = db.prepare(
        "SELECT id, status, cancellation_reason FROM view_requests WHERE id = ?",
      ).get("view-legacy");
      assert.deepEqual({ ...recording }, {
        id: "recording-legacy",
        filename: "legacy.mp4",
        size_bytes: 42,
        s3_upload_id: null,
      });
      assert.deepEqual({ ...request }, {
        id: "view-legacy",
        status: "approved",
        cancellation_reason: null,
      });
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
