import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export class StorageConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "StorageConfigurationError";
    this.status = 503;
  }
}

export function createS3Storage({
  env = process.env,
  client,
  presign = getSignedUrl,
} = {}) {
  const bucket = env.S3_BUCKET;
  if (!bucket) {
    throw new StorageConfigurationError("S3_BUCKET is required before recording uploads can be used.");
  }

  const s3 = client ?? new S3Client({
    region: env.AWS_REGION ?? "ap-southeast-2",
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
  });

  return {
    async createMultipartUpload(objectKey, contentType) {
      const result = await s3.send(new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: objectKey,
        ContentType: contentType,
        ServerSideEncryption: "AES256",
      }));
      if (!result.UploadId) throw new Error("S3 did not return a multipart upload ID.");
      return result.UploadId;
    },

    async signUploadPart(objectKey, uploadId, partNumber) {
      return presign(
        s3,
        new UploadPartCommand({ Bucket: bucket, Key: objectKey, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn: 300 },
      );
    },

    async completeMultipartUpload(objectKey, uploadId, parts) {
      await s3.send(new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: objectKey,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }));
    },

    async listMultipartParts(objectKey, uploadId) {
      const result = await s3.send(new ListPartsCommand({ Bucket: bucket, Key: objectKey, UploadId: uploadId }));
      return result.Parts ?? [];
    },

    async abortMultipartUpload(objectKey, uploadId) {
      await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: objectKey, UploadId: uploadId }));
    },

    async signDownload(objectKey, filename) {
      return presign(
        s3,
        new GetObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          ResponseContentDisposition: `attachment; filename="${filename.replace(/["\\\r\n]/g, "_")}"`,
        }),
        { expiresIn: 300 },
      );
    },
  };
}
