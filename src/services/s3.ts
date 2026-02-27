import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import { config } from "../config.ts";
import type { Readable } from "stream";

const s3Client = new S3Client({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

const BUCKET = config.aws.s3Bucket;

export async function generatePresignedUploadUrl(
  key: string,
  contentType: string,
  expiresIn = 3600,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return await getSignedUrl(s3Client, command, { expiresIn });
}

export async function generatePresignedDownloadUrl(
  key: string,
  expiresIn = 3600,
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  });
  return await getSignedUrl(s3Client, command, { expiresIn });
}

export async function deleteObject(key: string): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: BUCKET,
    Key: key,
  });
  await s3Client.send(command);
}

export async function listObjects(
  prefix: string,
): Promise<{ key: string; size: number; lastModified: Date }[]> {
  const results: { key: string; size: number; lastModified: Date }[] = [];
  let continuationToken: string | undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });
    const response = await s3Client.send(command);

    for (const obj of response.Contents ?? []) {
      if (obj.Key && obj.Size !== undefined && obj.LastModified) {
        results.push({
          key: obj.Key,
          size: obj.Size,
          lastModified: obj.LastModified,
        });
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return results;
}

/**
 * Build a consistent S3 key for event audio files.
 * Format: events/{event_code}/{filename}
 */
export function buildTrackS3Key(
  eventCode: string,
  _sessionNumber: number,
  filename: string,
): string {
  return `events/${eventCode}/${filename}`;
}

/**
 * Build S3 key for Read Along alignment JSON files.
 * Format: events/{event_code}/read-along/{filename}.json
 */
export function buildReadAlongS3Key(
  eventCode: string,
  filename: string,
): string {
  return `events/${eventCode}/read-along/${filename}`;
}

/**
 * Build a consistent S3 key for transcript files.
 */
export function buildTranscriptS3Key(
  eventCode: string,
  filename: string,
): string {
  return `events/${eventCode}/transcripts/${filename}`;
}

/**
 * Build S3 key for ZIP download files.
 * Format: downloads/{event_code}/{request_id}.zip
 */
export function buildZipS3Key(eventCode: string, requestId: string): string {
  return `downloads/${eventCode}/${requestId}.zip`;
}

/**
 * Get an S3 object's content as a string (e.g. JSON files).
 */
export async function getObjectText(key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  });
  const response = await s3Client.send(command);
  if (!response.Body) {
    throw new Error(`No body returned for S3 object: ${key}`);
  }
  return await response.Body.transformToString("utf-8");
}

/**
 * Get an S3 object as a readable stream for ZIP generation.
 */
export async function getObjectStream(key: string): Promise<Readable> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
  });

  const response = await s3Client.send(command);

  if (!response.Body) {
    throw new Error(`No body returned for S3 object: ${key}`);
  }

  // AWS SDK v3 returns a ReadableStream (web standard)
  // We need to convert it to Node.js Readable stream
  return response.Body as unknown as Readable;
}

/**
 * Upload a readable stream to S3 using multipart upload for large files.
 */
export async function uploadStream(
  key: string,
  stream: Readable,
  contentType: string,
): Promise<void> {
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: BUCKET,
      Key: key,
      Body: stream,
      ContentType: contentType,
    },
    queueSize: 4, // Concurrent parts
    partSize: 5 * 1024 * 1024, // 5MB parts
  });

  await upload.done();
}
