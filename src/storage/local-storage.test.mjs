import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createLocalStorage } from "./local-storage.mjs";

test("stores multipart recording data on local disk and assembles it in order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hearth-local-storage-"));
  const storage = createLocalStorage({ directory });
  const objectKey = "repositories/repo-id/recordings/recording-id";
  try {
    const uploadId = await storage.createMultipartUpload(objectKey, "video/mp4");
    const first = Buffer.from("part one");
    const second = Buffer.from("part two");
    const uploadedSecond = await storage.writeUploadPart(
      objectKey,
      uploadId,
      2,
      Readable.from([second]),
      second.length,
    );
    const uploadedFirst = await storage.writeUploadPart(
      objectKey,
      uploadId,
      1,
      Readable.from([first]),
      first.length,
    );
    assert.equal(uploadedFirst.Size, first.length);
    assert.equal(uploadedSecond.Size, second.length);
    assert.deepEqual(
      (await storage.listMultipartParts(objectKey, uploadId)).map(({ PartNumber }) => PartNumber),
      [1, 2],
    );

    await storage.completeMultipartUpload(objectKey, uploadId, [
      { PartNumber: 1, ETag: uploadedFirst.ETag },
      { PartNumber: 2, ETag: uploadedSecond.ETag },
    ]);
    assert.deepEqual(await readFile(join(directory, objectKey)), Buffer.concat([first, second]));
    assert.equal((await storage.statObject(objectKey)).size, first.length + second.length);
    const rangedChunks = [];
    for await (const chunk of storage.createReadStream(objectKey, { start: 5, end: 8 })) {
      rangedChunks.push(chunk);
    }
    assert.equal(Buffer.concat(rangedChunks).toString(), "onep");
    assert.deepEqual(await storage.listMultipartParts(objectKey, uploadId), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("aborts local uploads and rejects object keys that escape the configured directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hearth-local-storage-"));
  const storage = createLocalStorage({ directory });
  try {
    const uploadId = await storage.createMultipartUpload("repositories/repo/recordings/recording", "video/mp4");
    await storage.abortMultipartUpload("repositories/repo/recordings/recording", uploadId);
    assert.deepEqual(await storage.listMultipartParts("repositories/repo/recordings/recording", uploadId), []);
    assert.throws(() => storage.createReadStream("../outside"), /Invalid local recording key/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects upload parts whose byte count differs from the reserved size", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hearth-local-storage-"));
  const storage = createLocalStorage({ directory });
  const objectKey = "repositories/repo/recordings/recording";
  try {
    const uploadId = await storage.createMultipartUpload(objectKey, "video/mp4");
    await assert.rejects(
      storage.writeUploadPart(objectKey, uploadId, 1, Readable.from([Buffer.from("too large")]), 2),
      /exceeds its expected size/,
    );
    assert.deepEqual(await storage.listMultipartParts(objectKey, uploadId), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
