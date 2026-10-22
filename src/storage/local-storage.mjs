import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApiError } from "../errors.mjs";

export class StorageConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "StorageConfigurationError";
    this.status = 503;
  }
}

export function createLocalStorage({
  env = process.env,
  directory = env.LOCAL_STORAGE_PATH ?? "data/recordings",
} = {}) {
  if (typeof directory !== "string" || !directory.trim()) {
    throw new StorageConfigurationError("LOCAL_STORAGE_PATH must name a local directory.");
  }

  const root = resolve(directory);
  const stagingRoot = resolve(root, ".uploads");
  const ensureRoots = async () => {
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  };

  function objectPath(objectKey) {
    if (
      typeof objectKey !== "string"
      || objectKey.startsWith("/")
      || objectKey.includes("\\")
      || objectKey.includes("\0")
    ) {
      throw new Error("Invalid local recording key.");
    }
    const segments = objectKey.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error("Invalid local recording key.");
    }
    const filePath = resolve(root, ...segments);
    const rel = relative(root, filePath);
    if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
      throw new Error("Invalid local recording key.");
    }
    return filePath;
  }

  function uploadPath(uploadId) {
    if (typeof uploadId !== "string" || !/^[0-9a-f-]{36}$/i.test(uploadId)) {
      throw new Error("Invalid local upload ID.");
    }
    return resolve(stagingRoot, uploadId);
  }

  async function etagFor(filePath) {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(filePath)) {
      size += chunk.length;
      hash.update(chunk);
    }
    return { ETag: `"${hash.digest("hex")}"`, Size: size };
  }

  return {
    async createMultipartUpload() {
      await ensureRoots();
      const id = randomUUID();
      await mkdir(uploadPath(id), { mode: 0o700 });
      return id;
    },

    async writeUploadPart(objectKey, id, partNumber, request, expectedSize) {
      objectPath(objectKey);
      if (!Number.isInteger(partNumber) || partNumber < 1 || !Number.isSafeInteger(expectedSize) || expectedSize < 1) {
        throw new Error("Invalid local upload part.");
      }
      const directoryPath = uploadPath(id);
      await mkdir(directoryPath, { recursive: false, mode: 0o700 }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
      const target = resolve(directoryPath, `${partNumber}.part`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      const hash = createHash("sha256");
      let size = 0;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > expectedSize) {
            callback(new ApiError(400, "Upload part exceeds its expected size."));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });

      try {
        await pipeline(request, meter, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
        if (size !== expectedSize) throw new ApiError(400, "Upload part size does not match its expected size.");
        await rename(temporary, target);
        return { PartNumber: partNumber, ETag: `"${hash.digest("hex")}"`, Size: size };
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },

    async listMultipartParts(_objectKey, id) {
      const directoryPath = uploadPath(id);
      let names;
      try {
        names = await readdir(directoryPath);
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
      const parts = [];
      for (const name of names) {
        const match = /^([1-9]\d*)\.part$/.exec(name);
        if (!match) continue;
        const partNumber = Number(match[1]);
        if (!Number.isSafeInteger(partNumber)) continue;
        const { ETag, Size } = await etagFor(resolve(directoryPath, name));
        parts.push({ PartNumber: partNumber, ETag, Size });
      }
      return parts.sort((left, right) => left.PartNumber - right.PartNumber);
    },

    async completeMultipartUpload(objectKey, id, parts) {
      const target = objectPath(objectKey);
      const sourceDirectory = uploadPath(id);
      if (
        !Array.isArray(parts)
        || parts.some((part, index) => (
          !Number.isInteger(part.PartNumber)
          || part.PartNumber !== index + 1
          || typeof part.ETag !== "string"
        ))
      ) {
        throw new Error("Invalid local multipart completion list.");
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      const source = Readable.from((async function* streamParts() {
        for (const part of parts) {
          const partPath = resolve(sourceDirectory, `${part.PartNumber}.part`);
          for await (const chunk of createReadStream(partPath)) yield chunk;
        }
      })());
      try {
        await pipeline(source, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
        await rename(temporary, target);
        await rm(sourceDirectory, { recursive: true, force: true });
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },

    async abortMultipartUpload(_objectKey, id) {
      await rm(uploadPath(id), { recursive: true, force: true });
    },

    async statObject(objectKey) {
      return stat(objectPath(objectKey));
    },

    createReadStream(objectKey, options) {
      return createReadStream(objectPath(objectKey), options);
    },
  };
}
