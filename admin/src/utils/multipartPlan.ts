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
