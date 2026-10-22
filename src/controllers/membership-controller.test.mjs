import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db/database.mjs";
import { createMembershipController } from "./membership-controller.mjs";
import { createDeletionController } from "./deletion-controller.mjs";
import { createViewController } from "./view-controller.mjs";

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
  const db = await openDatabase(":memory:");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO repositories (id, name, created_by, quota_bytes, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("repo-id", "Family Home", "guardian-1", 10 * 1024 ** 3, now);
  const addMember = db.prepare(
    "INSERT INTO repository_members (repository_id, subject_id, role, status, joined_at) VALUES (?, ?, ?, 'active', ?)",
  );
  addMember.run("repo-id", "guardian-1", "owner", now);
  addMember.run("repo-id", "guardian-2", "guardian", now);
  addMember.run("repo-id", "guardian-3", "guardian", now);
  db.prepare(`
    INSERT INTO recordings (id, repository_id, uploader_subject_id, object_key, filename, content_type, size_bytes, status, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)
  `).run("recording-id", "repo-id", "guardian-1", "recordings/file-1", "clip.mp4", "video/mp4", 1024, now, now);

  const storage = {
    async statObject() { return { size: 1024 }; },
    createReadStream() { throw new Error("Playback must remain behind the policy gate."); },
  };
  return {
    db,
    memberships: createMembershipController({ db }),
    views: createViewController({ db, storage }),
  };
}

test("unanimous membership votes are audited but do not change authority before Tide policy is available", async () => {
  const { db, memberships } = await setup();
  try {
    const requested = responseCapture();
    memberships.requestMembership(null, requested, { sub: "new-guardian" }, "repo-id");
    assert.equal(requested.status, 201);
    const requestId = requested.body.requestId;

    for (const subject of ["guardian-1", "guardian-2", "guardian-3"]) {
      const decision = responseCapture();
      memberships.decideMembership(
        null,
        decision,
        { sub: subject },
        requestId,
        { decision: "approve" },
      );
      assert.equal(decision.body.status, subject === "guardian-3" ? "awaiting_tide_policy" : "pending");
    }

    const requestRow = db.prepare(
      "SELECT status FROM membership_requests WHERE id = ?",
    ).get(requestId);
    assert.equal(requestRow.status, "pending");
    assert.throws(
      () => memberships.leaveRepository(null, responseCapture(), { sub: "guardian-2" }, "repo-id"),
      (error) => error.status === 503 && /guardian-quorum/.test(error.message),
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM repository_members WHERE status = 'active'").get().count, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM membership_approvals").get().count, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 4);
  } finally {
    db.close();
  }
});

test("view requests and guardian votes are tracked while plaintext access remains fail closed", async () => {
  const { db, views } = await setup();
  let signedDownloads = 0;
  const securedViews = createViewController({
    db,
    storage: {
      async statObject() { signedDownloads += 1; return { size: 1024 }; },
      createReadStream() { signedDownloads += 1; throw new Error("Unexpected stream."); },
    },
  });
  try {
    const requested = responseCapture();
    views.requestView(null, requested, { sub: "guardian-1" }, "recording-id");
    assert.equal(requested.status, 201);
    const requestId = requested.body.requestId;
    assert.equal(requested.body.requiredApprovals, 2);

    for (const subject of ["guardian-2", "guardian-3"]) {
      const decision = responseCapture();
      views.decideView(
        null,
        decision,
        { sub: subject },
        requestId,
        { decision: "approve" },
      );
      assert.equal(
        decision.body.status,
        subject === "guardian-3" ? "awaiting_tide_policy" : "pending",
      );
    }
    assert.equal(
      db.prepare("SELECT status FROM view_requests WHERE id = ?").get(requestId).status,
      "pending",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM view_approvals").get().count, 2);
    await assert.rejects(
      securedViews.getApprovedView(null, responseCapture(), { sub: "guardian-1" }, requestId),
      (error) => error.status === 503,
    );
    assert.equal(signedDownloads, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 3);
  } finally {
    db.close();
  }
});

test("recording deletion request votes are audited and never delete content without Tide enforcement", async () => {
  const { db } = await setup();
  const deletions = createDeletionController({ db });
  try {
    const requested = responseCapture();
    deletions.requestDeletion(null, requested, { sub: "guardian-1" }, "recording-id");
    assert.equal(requested.status, 201);
    const requestId = requested.body.requestId;
    assert.equal(requested.body.requiredApprovals, 2);

    for (const subject of ["guardian-2", "guardian-3"]) {
      const decision = responseCapture();
      deletions.decideDeletion(
        null,
        decision,
        { sub: subject },
        requestId,
        { decision: "approve" },
      );
      assert.equal(
        decision.body.status,
        subject === "guardian-3" ? "awaiting_tide_policy" : "pending",
      );
    }
    assert.equal(
      db.prepare("SELECT deleted_at FROM recordings WHERE id = ?").get("recording-id").deleted_at,
      null,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM recording_deletion_approvals").get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 3);
  } finally {
    db.close();
  }
});
