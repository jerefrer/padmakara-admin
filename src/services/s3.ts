import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config.ts";

const s3Client = new S3Client({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
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
 * Build a consistent S3 key for retreat audio files.
 * Format: retreats/{retreat_event_code}/{session_number}/{filename}
 */
export function buildTrackS3Key(
  eventCode: string,
  sessionNumber: number,
  filename: string,
): string {
  return `retreats/${eventCode}/session-${sessionNumber}/${filename}`;
}

/**
 * Build a consistent S3 key for transcript files.
 */
export function buildTranscriptS3Key(
  eventCode: string,
  filename: string,
): string {
  return `retreats/${eventCode}/transcripts/${filename}`;
}
