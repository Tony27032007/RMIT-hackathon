import test from "node:test";
import assert from "node:assert/strict";
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { createS3Storage, StorageConfigurationError } from "./s3-storage.mjs";

test("requires a private bucket configuration", () => {
  assert.throws(() => createS3Storage({ env: {} }), StorageConfigurationError);
});

test("creates multipart uploads with server-side encryption and signs a bounded part URL", async () => {
  const sent = [];
  const client = {
    async send(command) {
      sent.push(command);
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload-1" };
      return {};
    },
  };
  const signed = [];
  const storage = createS3Storage({
    env: { S3_BUCKET: "private-recordings", AWS_REGION: "ap-southeast-2" },
    client,
    async presign(_client, command, options) {
      signed.push([command, options]);
      return "https://s3.example/signed-part";
    },
  });

  assert.equal(await storage.createMultipartUpload("recordings/id", "video/mp4"), "upload-1");
  assert.equal(sent[0].input.ServerSideEncryption, "AES256");
  assert.equal(sent[0].input.Bucket, "private-recordings");
  assert.equal(await storage.signUploadPart("recordings/id", "upload-1", 2), "https://s3.example/signed-part");
  assert.ok(signed[0][0] instanceof UploadPartCommand);
  assert.equal(signed[0][0].input.PartNumber, 2);
  assert.equal(signed[0][1].expiresIn, 300);
});
