import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db/database.mjs";
import { createRecordingController } from "./recording-controller.mjs";

function responseCapture() {
  return {
    status: 0,
    body: null,
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = JSON.parse(body);
    },
  };
}

async function setup() {
  const storageCalls = [];
  const storage = {
    async createMultipartUpload(key, contentType) {
      storageCalls.push(["create", key, contentType]);
      return "upload-id";
    },
    async writeUploadPart(key, uploadId, partNumber, _request, _expectedSize) {
      storageCalls.push(["write-part", key, uploadId, partNumber]);
      return { PartNumber: partNumber, ETag: `"local-${partNumber}"`, Size: 1024 };
    },
    async listMultipartParts() { storageCalls.push(["list"]); return []; },
    async completeMultipartUpload() { storageCalls.push(["complete"]); },
    async abortMultipartUpload(key, uploadId) {
      storageCalls.push(["abort", key, uploadId]);
    },
  };

  const db = await openDatabase(":memory:");
  db.prepare("INSERT INTO repositories (id, name, created_by, quota_bytes, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("repo-1", "Family Home", "guardian-1", 20_000, new Date().toISOString());
  db.prepare("INSERT INTO repository_members (repository_id, subject_id, role, status, joined_at) VALUES (?, ?, ?, ?, ?)")
    .run("repo-1", "guardian-1", "owner", "active", new Date().toISOString());
  return { db, storage, storageCalls, controller: createRecordingController({ db, storage }) };
}

test("fails closed for upload initiation, part signing, and completion before touching storage", async () => {
  const { db, controller, storageCalls } = await setup();
  try {
    const recordingId = "10000000-0000-4000-8000-000000000001";
    db.prepare(`
      INSERT INTO recordings
        (id, repository_id, uploader_subject_id, object_key, filename, content_type, size_bytes, storage_upload_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?)
    `).run(recordingId, "repo-1", "guardian-1", "recordings/legacy", "camera.mp4", "video/mp4", 1024, "upload-id", new Date().toISOString());

    const operations = [
      () => controller.startUpload(null, responseCapture(), { sub: "guardian-1" }, "repo-1", {
        filename: "camera.mp4",
        contentType: "video/mp4",
        sizeBytes: 1024,
      }),
      () => controller.signUploadParts(null, responseCapture(), { sub: "guardian-1" }, recordingId, { partNumbers: [1] }),
      () => controller.completeUpload(null, responseCapture(), { sub: "guardian-1" }, recordingId, {
        parts: [{ PartNumber: 1, ETag: '"etag-1"' }],
      }),
    ];
    for (const operation of operations) {
      await assert.rejects(operation, (error) => error.status === 503 && /guardian-quorum/.test(error.message));
    }
    assert.deepEqual(storageCalls, []);
    assert.equal(db.prepare("SELECT status FROM recordings WHERE id = ?").get(recordingId).status, "uploading");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM recordings").get().count, 1);
  } finally {
    db.close();
  }
});
