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

function setup({ quotaBytes = 20_000, uploadedSize = 1024 } = {}) {
  const dbPromise = openDatabase(":memory:");
  const storageCalls = [];
  const storage = {
    async createMultipartUpload(key, contentType) {
      storageCalls.push(["create", key, contentType]);
      return "upload-id";
    },
    async signUploadPart(key, uploadId, partNumber) {
      storageCalls.push(["sign", key, uploadId, partNumber]);
      return `https://s3.example/${partNumber}`;
    },
    async listMultipartParts() {
      return [{ PartNumber: 1, ETag: '"etag-1"', Size: uploadedSize }];
    },
    async completeMultipartUpload(key, uploadId, parts) {
      storageCalls.push(["complete", key, uploadId, parts]);
    },
    async abortMultipartUpload(key, uploadId) {
      storageCalls.push(["abort", key, uploadId]);
    },
  };

  return dbPromise.then((db) => {
    db.prepare("INSERT INTO repositories (id, name, created_by, quota_bytes, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("repo-1", "Family Home", "guardian-1", quotaBytes, new Date().toISOString());
    db.prepare("INSERT INTO repository_members (repository_id, subject_id, role, status, joined_at) VALUES (?, ?, ?, ?, ?)")
      .run("repo-1", "guardian-1", "owner", "active", new Date().toISOString());
    return { db, storage, storageCalls, controller: createRecordingController({ db, storage }) };
  });
}

test("reserves quota, signs numbered upload parts, and completes after checking S3 parts", async () => {
  const { db, controller, storageCalls } = await setup();
  try {
    const start = responseCapture();
    await controller.startUpload(null, start, { sub: "guardian-1" }, "repo-1", {
      filename: "../../camera.mp4",
      contentType: "video/mp4",
      sizeBytes: 1024,
    });
    assert.equal(start.status, 201);
    assert.equal(start.body.partCount, 1);

    const id = start.body.recordingId;
    const signed = responseCapture();
    await controller.signUploadParts(null, signed, { sub: "guardian-1" }, id, { partNumbers: [1] });
    assert.deepEqual(signed.body.parts, [{ partNumber: 1, url: "https://s3.example/1" }]);

    const completed = responseCapture();
    await controller.completeUpload(null, completed, { sub: "guardian-1" }, id, {
      parts: [{ PartNumber: 1, ETag: '"etag-1"' }],
    });
    assert.equal(completed.body.status, "available");
    assert.equal(db.prepare("SELECT status FROM recordings WHERE id = ?").get(id).status, "available");
    assert.equal(storageCalls.filter(([action]) => action === "complete").length, 1);
  } finally {
    db.close();
  }
});

test("does not reserve a recording when it would exceed repository quota", async () => {
  const { db, controller, storageCalls } = await setup({ quotaBytes: 1000 });
  try {
    await assert.rejects(
      controller.startUpload(null, responseCapture(), { sub: "guardian-1" }, "repo-1", {
        filename: "camera.mp4",
        contentType: "video/mp4",
        sizeBytes: 1001,
      }),
      (error) => error.status === 413,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM recordings").get().count, 0);
    assert.equal(storageCalls.at(-1)[0], "abort");
  } finally {
    db.close();
  }
});

test("rejects upload continuation by a different subscriber and rejects mismatched part sizes", async () => {
  const { db, controller } = await setup({ uploadedSize: 2048 });
  try {
    const start = responseCapture();
    await controller.startUpload(null, start, { sub: "guardian-1" }, "repo-1", {
      filename: "camera.mp4",
      contentType: "video/mp4",
      sizeBytes: 1024,
    });
    const id = start.body.recordingId;

    await assert.rejects(
      controller.signUploadParts(null, responseCapture(), { sub: "guardian-2" }, id, { partNumbers: [1] }),
      (error) => error.status === 404,
    );
    await assert.rejects(
      controller.completeUpload(null, responseCapture(), { sub: "guardian-1" }, id, {
        parts: [{ PartNumber: 1, ETag: '"etag-1"' }],
      }),
      (error) => error.status === 400,
    );
  } finally {
    db.close();
  }
});
