import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db/database.mjs";
import { createMembershipController } from "./membership-controller.mjs";
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

  const storage = { async signDownload() { return "https://private-s3.example/recording"; } };
  return {
    db,
    memberships: createMembershipController({ db }),
    views: createViewController({ db, storage }),
  };
}

test("membership is granted only after every guardian in the request snapshot approves", async () => {
  const { db, memberships } = await setup();
  try {
    const requested = responseCapture();
    memberships.requestMembership(null, requested, { sub: "new-guardian" }, "repo-id");
    const requestId = requested.body.requestId;

    const firstVote = responseCapture();
    memberships.decideMembership(null, firstVote, { sub: "guardian-1" }, requestId, { decision: "approve" });
    assert.equal(firstVote.body.status, "pending");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM repository_members WHERE subject_id = 'new-guardian' AND status = 'active'").get().count, 0);

    const secondVote = responseCapture();
    memberships.decideMembership(null, secondVote, { sub: "guardian-2" }, requestId, { decision: "approve" });
    assert.equal(secondVote.body.status, "pending");

    const thirdVote = responseCapture();
    memberships.decideMembership(null, thirdVote, { sub: "guardian-3" }, requestId, { decision: "approve" });
    assert.equal(thirdVote.body.status, "accepted");
    assert.equal(db.prepare("SELECT status FROM repository_members WHERE subject_id = 'new-guardian'").get().status, "active");
  } finally {
    db.close();
  }
});

test("a guardian leaving cancels pending requests and clears their recorded approvals", async () => {
  const { db, memberships, views } = await setup();
  try {
    const membership = responseCapture();
    memberships.requestMembership(null, membership, { sub: "new-guardian" }, "repo-id");
    memberships.decideMembership(null, responseCapture(), { sub: "guardian-1" }, membership.body.requestId, { decision: "approve" });

    const view = responseCapture();
    views.requestView(null, view, { sub: "guardian-1" }, "recording-id");
    views.decideView(null, responseCapture(), { sub: "guardian-2" }, view.body.requestId, { decision: "approve" });

    memberships.leaveRepository(null, responseCapture(), { sub: "guardian-2" }, "repo-id");

    const memberRequest = { ...db.prepare("SELECT status, cancellation_reason FROM membership_requests WHERE id = ?")
      .get(membership.body.requestId) };
    const viewRequest = { ...db.prepare("SELECT status, cancellation_reason FROM view_requests WHERE id = ?")
      .get(view.body.requestId) };
    assert.deepEqual(memberRequest, {
      status: "cancelled",
      cancellation_reason: "Request canceled due to guardian leaving",
    });
    assert.deepEqual(viewRequest, {
      status: "cancelled",
      cancellation_reason: "Request canceled due to guardian leaving",
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM membership_approvals WHERE request_id = ?").get(membership.body.requestId).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM view_approvals WHERE request_id = ?").get(view.body.requestId).count, 0);

    const listedMembership = responseCapture();
    memberships.listMembershipRequests(null, listedMembership, { sub: "guardian-1" }, "repo-id");
    assert.equal(listedMembership.body.requests[0].cancellation_reason, "Request canceled due to guardian leaving");

    const listedViews = responseCapture();
    views.listRepositoryViewRequests(null, listedViews, { sub: "guardian-1" }, "repo-id");
    assert.equal(listedViews.body.requests[0].cancellation_reason, "Request canceled due to guardian leaving");
  } finally {
    db.close();
  }
});

test("a view link is returned only to the requester after every subscriber approves", async () => {
  const { db, views } = await setup();
  try {
    const request = responseCapture();
    views.requestView(null, request, { sub: "guardian-1" }, "recording-id");
    const requestId = request.body.requestId;

    views.decideView(null, responseCapture(), { sub: "guardian-2" }, requestId, { decision: "approve" });
    views.decideView(null, responseCapture(), { sub: "guardian-3" }, requestId, { decision: "approve" });
    assert.equal(db.prepare("SELECT status FROM view_requests WHERE id = ?").get(requestId).status, "pending");
    views.decideView(null, responseCapture(), { sub: "guardian-1" }, requestId, { decision: "approve" });

    const access = responseCapture();
    await views.getApprovedView(null, access, { sub: "guardian-1" }, requestId);
    assert.equal(access.body.expiresInSeconds, 300);
    assert.equal(access.body.url, "https://private-s3.example/recording");

    await assert.rejects(
      views.getApprovedView(null, responseCapture(), { sub: "guardian-2" }, requestId),
      (error) => error.status === 404,
    );
  } finally {
    db.close();
  }
});

test("a sole subscriber still explicitly approves their own view request", async () => {
  const { db, views } = await setup();
  try {
    db.prepare("DELETE FROM repository_members WHERE repository_id = ? AND subject_id != ?")
      .run("repo-id", "guardian-1");
    const request = responseCapture();
    views.requestView(null, request, { sub: "guardian-1" }, "recording-id");
    views.decideView(null, responseCapture(), { sub: "guardian-1" }, request.body.requestId, { decision: "approve" });
    assert.equal(db.prepare("SELECT status FROM view_requests WHERE id = ?").get(request.body.requestId).status, "approved");
  } finally {
    db.close();
  }
});
