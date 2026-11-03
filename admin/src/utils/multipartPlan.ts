/**
 * Pure helpers for the S3 multipart upload of video masters: byte ranges,
 * retry/backoff decisions and progress arithmetic. No I/O, so they are unit
 * tested directly; the XHR/fetch engine lives in videoUploader.ts.
 */

/** Files at or above this size use multipart; smaller ones keep the single PUT. */
export const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024;

/** Parts uploaded in parallel. */
export const PART_CONCURRENCY = 4;

/** Part numbers presigned per API call (the server accepts at most 100). */
export const PRESIGN_BATCH_SIZE = 100;

/** Wait before retry n (1-based) of a single part: 1s, 2s, 4s, 8s, 16s, 30s. */
export const PART_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;

/** Byte range [start, end) of a 1-based part number. */
export function partRange(
  partNumber: number,
  partSize: number,
  fileSize: number,
): { start: number; end: number } {
  const start = (partNumber - 1) * partSize;
  return { start, end: Math.min(start + partSize, fileSize) };
}

export type PartRetryDecision =
  | { action: "retry"; delayMs: number; represign: boolean }
  | { action: "fail" };

/**
 * What to do after a failed attempt of a part. `failures` is the number of
 * failed attempts so far (1 after the first failure); `status` is the HTTP
 * status, or 0 when the request never got a response.
 *
 * Network errors, 408/429 and 5xx are retried. A 403 means the presigned URL
 * expired (or was rejected), so the retry fetches a fresh URL. Any other 4xx
 * is a real error and fails immediately.
 */
export function decidePartRetry(failures: number, status: number): PartRetryDecision {
  if (failures > PART_RETRY_DELAYS_MS.length) return { action: "fail" };
  const delayMs = PART_RETRY_DELAYS_MS[failures - 1];
  if (status === 403) return { action: "retry", delayMs, represign: true };
  if (status === 0 || status === 408 || status === 429 || status >= 500) {
    return { action: "retry", delayMs, represign: false };
  }
  return { action: "fail" };
}

/** Next batch of part numbers to presign: `first` plus the pending ones after it. */
export function nextPresignBatch(
  first: number,
  partCount: number,
  isPending: (partNumber: number) => boolean,
  batchSize = PRESIGN_BATCH_SIZE,
): number[] {
  const batch: number[] = [first];
  for (let n = first + 1; n <= partCount && batch.length < batchSize; n++) {
    if (isPending(n)) batch.push(n);
  }
  return batch;
}

/** Overall fraction in [0, 1]: confirmed bytes plus in-flight bytes of each part. */
export function overallFraction(
  confirmedBytes: number,
  inFlight: Iterable<number>,
  totalBytes: number,
): number {
  if (totalBytes <= 0) return 0;
  let bytes = confirmedBytes;
  for (const b of inFlight) bytes += b;
  return Math.min(1, bytes / totalBytes);
}

// ─── Resume support ──────────────────────────────────────────────────────────

/** A stored multipart session older than this is dropped (S3 may have expired it). */
export const RESUME_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;

/** The multipart session persisted in localStorage so a reload can resume it. */
export interface ResumeEntry {
  uploadId: string;
  s3Key: string;
  partSize: number;
  partCount: number;
  createdAt: number;
}

/**
 * localStorage key identifying "the same file for the same target": event,
 * target row (when attaching to a prepared video), and the file's name, size
 * and modification time.
 */
export function resumeStorageKey(opts: {
  eventCode: string;
  videoId?: number | null;
  name: string;
  size: number;
  lastModified: number;
}): string {
  const target = opts.videoId != null ? `video-${opts.videoId}` : "new";
  return `padmakara.videoUpload:${opts.eventCode}:${target}:${opts.size}:${opts.lastModified}:${opts.name}`;
}

/**
 * Parse and validate a stored entry. Returns null for missing/corrupt data,
 * entries older than RESUME_MAX_AGE_MS (or dated in the future), and entries
 * whose part plan does not match the file size.
 */
export function parseResumeEntry(raw: string | null, now: number, fileSize: number): ResumeEntry | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.uploadId !== "string" || v.uploadId === "") return null;
  if (typeof v.s3Key !== "string" || v.s3Key === "") return null;
  if (typeof v.partSize !== "number" || !Number.isInteger(v.partSize) || v.partSize <= 0) return null;
  if (typeof v.partCount !== "number" || !Number.isInteger(v.partCount) || v.partCount <= 0) return null;
  if (typeof v.createdAt !== "number") return null;
  const age = now - v.createdAt;
  if (age < 0 || age > RESUME_MAX_AGE_MS) return null;
  if (Math.max(1, Math.ceil(fileSize / v.partSize)) !== v.partCount) return null;
  return { uploadId: v.uploadId, s3Key: v.s3Key, partSize: v.partSize, partCount: v.partCount, createdAt: v.createdAt };
}

/**
 * Part numbers S3 already holds in full, i.e. present with exactly the size we
 * would send. A part with a different size is re-uploaded (S3 keeps the latest).
 */
export function partsToSkip(
  listed: { partNumber: number; size: number }[],
  partSize: number,
  partCount: number,
  fileSize: number,
): number[] {
  const done = new Set<number>();
  for (const p of listed) {
    if (p.partNumber < 1 || p.partNumber > partCount) continue;
    const { start, end } = partRange(p.partNumber, partSize, fileSize);
    if (p.size === end - start) done.add(p.partNumber);
  }
  return [...done].sort((a, b) => a - b);
}

/** Bytes covered by the given (already uploaded) part numbers. */
export function bytesOfParts(parts: Iterable<number>, partSize: number, fileSize: number): number {
  let total = 0;
  for (const n of parts) {
    const { start, end } = partRange(n, partSize, fileSize);
    total += end - start;
  }
  return total;
}
