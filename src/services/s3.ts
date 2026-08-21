import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import { config } from "../config.ts";
import type { Readable } from "stream";

const s3Client = new S3Client({
  region: config.storage.region,
  credentials: {
    accessKeyId: config.storage.accessKeyId,
    secretAccessKey: config.storage.secretAccessKey,
  },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  ...(config.storage.endpoint
    ? { endpoint: config.storage.endpoint, forcePathStyle: config.storage.forcePathStyle }
    : {}),
});

const BUCKET = config.storage.bucket;

/**
 * Env vars handed to the AWS Batch pipeline containers so their boto3 client
 * talks to the SAME object store as this backend. When S3_ENDPOINT is empty
 * (pre-R2 cutover) the container falls back to its IAM role against real S3.
 * The container reads these via make_s3_client() in run_job.py/subtitle_job.py.
 */
export function storageEnvForContainer(
  storage: {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
  } = config.storage,
): { name: string; value: string }[] {
  return [
    { name: "S3_ENDPOINT", value: storage.endpoint },
    { name: "S3_ACCESS_KEY_ID", value: storage.accessKeyId },
    { name: "S3_SECRET_ACCESS_KEY", value: storage.secretAccessKey },
    { name: "S3_REGION", value: storage.region },
  ];
}

// Bun-native S3 client, used for uploading server-generated files (ZIP
// downloads). The AWS SDK's lib-storage multipart uploader rejects Bun's Node
// streams ("Body Data is unsupported format"); Bun's built-in client speaks the
// S3 API natively, works cleanly with R2, and streams a file from disk without
// buffering the whole thing in memory.
const bunStorage = new Bun.S3Client({
  accessKeyId: config.storage.accessKeyId,
  secretAccessKey: config.storage.secretAccessKey,
  ...(config.storage.endpoint ? { endpoint: config.storage.endpoint } : {}),
  bucket: config.storage.bucket,
  region: config.storage.region,
});

/**
 * Upload a local file to storage, streaming it from disk. Used for
 * server-generated artifacts (e.g. ZIP downloads) built to a temp file.
 */
export async function uploadFile(key: string, filePath: string, contentType: string): Promise<void> {
  await bunStorage.write(key, Bun.file(filePath), { type: contentType });
}

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

/**
 * Returns true only for image (avatar / hero) S3 keys that are safe to
 * cache. Presigned URLs are bearer tokens, so caching them extends their
 * effective lifetime. Audio, transcript, read-along, and ZIP keys are
 * sensitive content and MUST NOT be cached — always generate fresh.
 *
 * Cacheable prefixes (teacher + group avatar and hero images):
 *   teachers/avatars/
 *   teachers/heroes/
 *   groups/avatars/
 *   groups/heroes/
 *
 * Everything else (events/…, downloads/…, or unrecognised) → not cached.
 */
const CACHEABLE_PREFIXES = [
  "teachers/avatars/",
  "teachers/heroes/",
  "groups/avatars/",
  "groups/heroes/",
] as const;

export function isCacheableKey(key: string): boolean {
  return CACHEABLE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * In-memory cache of presigned GET URLs for IMAGE keys only. Key = s3
 * object key. We hand out the same URL for ~half its expiry window so
 * successive API calls return an identical URL — that lets the browser (and
 * expo-image's URL-based cache on web) reuse the cached image instead of
 * refetching the same bytes under a new signature on every navigation.
 *
 * The s3Key already embeds the upload timestamp (`avatars/{id}-{ts}.jpg`),
 * so when the admin replaces an image the key changes and we automatically
 * generate a fresh presigned URL — no manual invalidation needed.
 *
 * Audio, transcript, read-along, and ZIP keys bypass this cache entirely
 * (see `isCacheableKey`).
 */
interface CachedUrl {
  url: string;
  expiresAt: number; // epoch ms when WE consider it stale (≈ half the actual S3 expiry)
}
const presignedDownloadCache = new Map<string, CachedUrl>();
const MAX_CACHE_ENTRIES = 5_000;

export async function generatePresignedDownloadUrl(
  key: string,
  expiresIn = 3600,
): Promise<string> {
  const now = Date.now();

  if (isCacheableKey(key)) {
    const cached = presignedDownloadCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.url;
    }
  }

  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  const url = await getSignedUrl(s3Client, command, { expiresIn });

  if (isCacheableKey(key)) {
    // Hand the URL out for half its lifetime so the client never receives an
    // about-to-expire URL (which could fail on slow connections).
    const cacheTtlMs = (expiresIn / 2) * 1000;
    presignedDownloadCache.set(key, { url, expiresAt: now + cacheTtlMs });

    // Soft cap on the cache size — drop the oldest entries when we exceed it.
    if (presignedDownloadCache.size > MAX_CACHE_ENTRIES) {
      const overflow = presignedDownloadCache.size - MAX_CACHE_ENTRIES;
      const it = presignedDownloadCache.keys();
      for (let i = 0; i < overflow; i++) {
        const k = it.next().value;
        if (k) presignedDownloadCache.delete(k);
      }
    }
  }

  return url;
}

/**
 * Like generatePresignedDownloadUrl but tells the browser to attach the
 * file as a download (and use the given filename) instead of streaming
 * inline. Not cached — the filename can vary per request and these URLs
 * are short-lived by design.
 */
export async function generatePresignedAttachmentUrl(
  key: string,
  filename: string,
  expiresIn = 600,
): Promise<string> {
  const safe = filename.replace(/"/g, "");
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${safe}"`,
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
 * Server-side copy of an object from another bucket into the app bucket.
 * Both buckets must be in the same region — no bytes leave AWS, no egress.
 */
export async function copyObjectIntoAppBucket(
  sourceBucket: string,
  sourceKey: string,
  destKey: string,
): Promise<void> {
  const command = new CopyObjectCommand({
    Bucket: BUCKET,
    Key: destKey,
    CopySource: encodeURIComponent(`${sourceBucket}/${sourceKey}`),
  });
  await s3Client.send(command);
}

/**
 * Upload a buffer directly to S3.
 */
export async function putObject(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<void> {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  });
  await s3Client.send(command);
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
 * Build a consistent S3 key for generic event document files.
 * Format: events/{event_code}/{file_type}/{filename}
 */
export function buildEventFileS3Key(
  eventCode: string,
  fileType: string,
  filename: string,
): string {
  return `events/${eventCode}/${fileType}/${filename}`;
}

/**
 * Build S3 key for ZIP download files.
 * Format: downloads/{event_code}/{filename}.zip
 */
export function buildZipS3Key(eventCode: string, requestId: string, filename?: string): string {
  const name = filename || requestId;
  return `downloads/${eventCode}/${name}.zip`;
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
 * Get an S3 object's raw bytes plus its stored content type. Used for small
 * objects the API has to hand straight back to a client (e.g. serving an
 * image back to the admin for re-cropping), where buffering is simpler and
 * cheaper than plumbing a stream through.
 */
export async function getObjectBytes(
  key: string,
): Promise<{ body: Uint8Array; contentType: string }> {
  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  if (!response.Body) {
    throw new Error(`No body returned for S3 object: ${key}`);
  }
  return {
    body: await response.Body.transformToByteArray(),
    contentType: response.ContentType || "application/octet-stream",
  };
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

/**
 * Build S3 key for teacher avatar images.
 * Format: teachers/avatars/{teacherId}-{timestamp}.{ext}
 */
export function buildTeacherAvatarS3Key(teacherId: number, ext: string): string {
  return `teachers/avatars/${teacherId}-${Date.now()}.${ext}`;
}

/**
 * Build S3 key for teacher hero/banner images (desktop, 2400px wide).
 * Format: teachers/heroes/{teacherId}-{timestamp}.{ext}
 */
export function buildTeacherHeroS3Key(teacherId: number, ext: string): string {
  return `teachers/heroes/${teacherId}-${Date.now()}.${ext}`;
}

/**
 * Build S3 key for the mobile-sized teacher hero variant (1200px wide).
 * Generated alongside the desktop hero so phone clients fetch a smaller
 * image. Format: teachers/heroes/{teacherId}-{timestamp}-m.{ext}
 */
export function buildTeacherHeroMobileS3Key(teacherId: number, ext: string): string {
  return `teachers/heroes/${teacherId}-${Date.now()}-m.${ext}`;
}

/**
 * Build S3 key for retreat-group avatar images.
 * Format: groups/avatars/{groupId}-{timestamp}.{ext}
 */
export function buildGroupAvatarS3Key(groupId: number, ext: string): string {
  return `groups/avatars/${groupId}-${Date.now()}.${ext}`;
}

/**
 * Build S3 key for retreat-group hero/banner images (desktop, 2400px wide).
 * Format: groups/heroes/{groupId}-{timestamp}.{ext}
 */
export function buildGroupHeroS3Key(groupId: number, ext: string): string {
  return `groups/heroes/${groupId}-${Date.now()}.${ext}`;
}

/**
 * Build S3 key for the mobile-sized group hero variant (1200px wide).
 * Format: groups/heroes/{groupId}-{timestamp}-m.{ext}
 */
export function buildGroupHeroMobileS3Key(groupId: number, ext: string): string {
  return `groups/heroes/${groupId}-${Date.now()}-m.${ext}`;
}
