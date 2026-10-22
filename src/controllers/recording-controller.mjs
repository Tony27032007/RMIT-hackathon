import { randomUUID } from "node:crypto";
import { ApiError } from "../errors.mjs";
import { requireGuardianQuorumPolicy } from "../security/guardian-policy.mjs";

export const MAX_REPOSITORY_BYTES = 10 * 1024 * 1024 * 1024;
export const UPLOAD_PART_BYTES = 64 * 1024 * 1024;
const MAX_SIGNED_PARTS_PER_CALL = 100;

function activeMember(db, repositoryId, subjectId) {
  return db.prepare(
    "SELECT role FROM repository_members WHERE repository_id = ? AND subject_id = ? AND status = 'active'",
  ).get(repositoryId, subjectId);
}

function getRecording(db, recordingId) {
  return db.prepare(
    "SELECT id, repository_id, uploader_subject_id, object_key, filename, content_type, size_bytes, storage_upload_id, status FROM recordings WHERE id = ?",
  ).get(recordingId);
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sanitizeFilename(filename) {
  const lastPath = filename.split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!lastPath || lastPath.length > 255) throw new ApiError(400, "Filename must be between 1 and 255 characters.");
  return lastPath;
}

function expectedPartCount(sizeBytes) {
  return Math.ceil(sizeBytes / UPLOAD_PART_BYTES);
}

export function createRecordingController({ db, storage }) {
  return {
    async startUpload(_request, response, claims, repositoryId, body) {
      requireGuardianQuorumPolicy();
      if (typeof body.filename !== "string" || typeof body.contentType !== "string") {
        throw new ApiError(400, "filename and contentType are required.");
      }
      const filename = sanitizeFilename(body.filename);
      const contentType = body.contentType.trim().toLowerCase();
      const sizeBytes = body.sizeBytes;
      if (!contentType.startsWith("video/") || contentType.length > 120) {
        throw new ApiError(400, "Only video content types are accepted.");
      }
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_REPOSITORY_BYTES) {
        throw new ApiError(400, "Recording size must be between 1 byte and the 10 GiB repository limit.");
      }
      if (!activeMember(db, repositoryId, claims.sub)) {
        throw new ApiError(404, "Repository not found or account is not an active subscriber.");
      }

      const repository = db.prepare("SELECT quota_bytes FROM repositories WHERE id = ?").get(repositoryId);
      if (!repository) throw new ApiError(404, "Repository not found.");

      const recordingId = randomUUID();
      const objectKey = `repositories/${repositoryId}/recordings/${recordingId}`;
      const uploadId = await storage.createMultipartUpload(objectKey, contentType);
      let transactionOpen = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
        if (!activeMember(db, repositoryId, claims.sub)) {
          throw new ApiError(404, "Repository not found or account is not an active subscriber.");
        }
        const used = db.prepare(
          "SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM recordings WHERE repository_id = ? AND status IN ('uploading', 'available')",
        ).get(repositoryId).bytes;
        if (used + sizeBytes > repository.quota_bytes || used + sizeBytes > MAX_REPOSITORY_BYTES) {
          throw new ApiError(413, "This recording would exceed the repository's 10 GiB total storage limit.");
        }

        db.prepare(`
          INSERT INTO recordings
            (id, repository_id, uploader_subject_id, object_key, filename, content_type, size_bytes, storage_upload_id, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?)
        `).run(recordingId, repositoryId, claims.sub, objectKey, filename, contentType, sizeBytes, uploadId, new Date().toISOString());
        db.exec("COMMIT");
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) db.exec("ROLLBACK");
        await storage.abortMultipartUpload(objectKey, uploadId);
        throw error;
      }

      sendJson(response, 201, {
        recordingId,
        partSizeBytes: UPLOAD_PART_BYTES,
        partCount: expectedPartCount(sizeBytes),
      });
    },

    async signUploadParts(_request, response, claims, recordingId, body) {
      requireGuardianQuorumPolicy();
      const recording = getRecording(db, recordingId);
      if (
        !recording
        || recording.status !== "uploading"
        || !activeMember(db, recording.repository_id, claims.sub)
      ) {
        throw new ApiError(404, "Upload not found.");
      }
      if (recording.uploader_subject_id !== claims.sub) {
        throw new ApiError(403, "Only the account that started this upload can continue it.");
      }
      if (
        !Array.isArray(body.partNumbers)
        || body.partNumbers.length < 1
        || body.partNumbers.length > MAX_SIGNED_PARTS_PER_CALL
        || body.partNumbers.some((part) => !Number.isInteger(part) || part < 1 || part > expectedPartCount(recording.size_bytes))
        || new Set(body.partNumbers).size !== body.partNumbers.length
      ) {
        throw new ApiError(400, `partNumbers must contain 1-${MAX_SIGNED_PARTS_PER_CALL} unique valid part numbers.`);
      }

      const parts = await Promise.all(body.partNumbers.map(async (partNumber) => ({
        partNumber,
        url: `/api/recordings/${recordingId}/upload-parts/${partNumber}`,
      })));
      sendJson(response, 200, { parts });
    },

    async uploadPart(request, response, claims, recordingId, partNumber) {
      requireGuardianQuorumPolicy();
      const recording = getRecording(db, recordingId);
      if (
        !recording
        || recording.status !== "uploading"
        || !activeMember(db, recording.repository_id, claims.sub)
      ) {
        throw new ApiError(404, "Upload not found.");
      }
      if (recording.uploader_subject_id !== claims.sub) {
        throw new ApiError(403, "Only the account that started this upload can continue it.");
      }
      if (request.headers["content-type"] !== "application/octet-stream") {
        throw new ApiError(415, "Upload parts must use application/octet-stream.");
      }
      const count = expectedPartCount(recording.size_bytes);
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) {
        throw new ApiError(400, "Upload part number is outside the reserved recording size.");
      }
      const expectedSize = Math.min(
        UPLOAD_PART_BYTES,
        recording.size_bytes - (partNumber - 1) * UPLOAD_PART_BYTES,
      );
      const contentLength = request.headers["content-length"];
      if (contentLength !== undefined && Number(contentLength) !== expectedSize) {
        throw new ApiError(400, "Upload part size does not match the reserved recording size.");
      }

      const part = await storage.writeUploadPart(
        recording.object_key,
        recording.storage_upload_id,
        partNumber,
        request,
        expectedSize,
      );
      sendJson(response, 200, { partNumber: part.PartNumber, etag: part.ETag });
    },

    async completeUpload(_request, response, claims, recordingId, body) {
      requireGuardianQuorumPolicy();
      const recording = getRecording(db, recordingId);
      if (!recording || !activeMember(db, recording.repository_id, claims.sub)) {
        throw new ApiError(404, "Upload not found.");
      }
      if (recording.status === "available") {
        sendJson(response, 200, { recordingId, status: "available" });
        return;
      }
      if (recording.status !== "uploading" || recording.uploader_subject_id !== claims.sub) {
        throw new ApiError(403, "Only the account that started this active upload can complete it.");
      }

      const count = expectedPartCount(recording.size_bytes);
      if (
        !Array.isArray(body.parts)
        || body.parts.length !== count
        || body.parts.some((part, index) => (
          !part
          || part.PartNumber !== index + 1
          || typeof part.ETag !== "string"
          || part.ETag.length < 1
          || part.ETag.length > 200
          || /[\r\n]/.test(part.ETag)
        ))
      ) {
        throw new ApiError(400, `Exactly ${count} ordered parts with ETags are required to complete this upload.`);
      }

      const uploadedParts = await storage.listMultipartParts(recording.object_key, recording.storage_upload_id);
      if (
        uploadedParts.length !== count
        || uploadedParts.some((part, index) => (
          part.PartNumber !== index + 1
          || part.ETag !== body.parts[index].ETag
          || !Number.isSafeInteger(part.Size)
          || part.Size < 1
        ))
        || uploadedParts.reduce((total, part) => total + part.Size, 0) !== recording.size_bytes
      ) {
        throw new ApiError(400, "Uploaded part sizes or ETags do not match the reserved recording size.");
      }

      await storage.completeMultipartUpload(
        recording.object_key,
        recording.storage_upload_id,
        body.parts.map(({ PartNumber, ETag }) => ({ PartNumber, ETag })),
      );
      db.prepare(
        "UPDATE recordings SET status = 'available', storage_upload_id = NULL, completed_at = ? WHERE id = ? AND status = 'uploading'",
      ).run(new Date().toISOString(), recordingId);
      sendJson(response, 200, { recordingId, status: "available" });
    },

    async cancelUpload(_request, response, claims, recordingId) {
      const recording = getRecording(db, recordingId);
      if (!recording || recording.status !== "uploading") {
        throw new ApiError(404, "Active upload not found.");
      }
      if (recording.uploader_subject_id !== claims.sub) {
        throw new ApiError(403, "Only the account that started this upload can cancel it.");
      }

      await storage.abortMultipartUpload(recording.object_key, recording.storage_upload_id);
      db.prepare("UPDATE recordings SET status = 'failed', storage_upload_id = NULL WHERE id = ?").run(recordingId);
      sendJson(response, 200, { recordingId, status: "cancelled" });
    },
  };
}
