/**
 * S3 helpers for the burn container. Talks to the SAME object store as the
 * backend (S3 today, R2 after migration) via S3_ENDPOINT/S3_ACCESS_KEY_ID/
 * S3_SECRET_ACCESS_KEY/S3_REGION — the same env vars storageEnvForContainer()
 * in src/services/s3.ts hands every other Batch pipeline container.
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

// A single PUT stops at 5 GB, and merged videos are often larger. 64 MiB parts
// reach 640 GB within the 10,000-part limit, well above the 200 GiB scratch disk.
export const UPLOAD_PART_BYTES = 64 * 1024 * 1024;

export interface StorageConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
}

export function makeS3Client(cfg: StorageConfig): S3Client {
  return new S3Client({
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // Empty S3_ENDPOINT (pre-R2 cutover) falls back to real AWS S3 via the
    // container's IAM role — mirrors storageEnvForContainer()'s contract.
    ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
  });
}

export async function downloadToFile(
  client: S3Client,
  bucket: string,
  key: string,
  destPath: string,
): Promise<void> {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`No body for s3://${bucket}/${key}`);
  await pipeline(res.Body as unknown as Readable, createWriteStream(destPath));
}

export async function downloadText(client: S3Client, bucket: string, key: string): Promise<string> {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`No body for s3://${bucket}/${key}`);
  return await res.Body.transformToString("utf-8");
}

export async function uploadFile(
  client: S3Client,
  bucket: string,
  key: string,
  srcPath: string,
  contentType: string,
): Promise<void> {
  await new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: createReadStream(srcPath),
      ContentType: contentType,
    },
    partSize: UPLOAD_PART_BYTES,
    leavePartsOnError: false,
  }).done();
}

export async function presignGet(
  client: S3Client,
  bucket: string,
  key: string,
  expiresIn: number,
): Promise<string> {
  return await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}
