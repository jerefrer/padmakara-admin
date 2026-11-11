/**
 * Pure helpers for the multipart upload routes (video masters and track audio).
 */

export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;

/** S3 allows at most 10,000 parts per multipart upload. */
export const MAX_PARTS = 10_000;
/** Default part size; raised only when the file would need more than MAX_PARTS. */
export const DEFAULT_PART_SIZE = 64 * MIB;
/** S3 caps a single part at 5 GiB. */
const MAX_PART_SIZE = 5 * GIB;
/** Upper bound on a master file accepted by the create route. */
export const MAX_MASTER_SIZE = 200 * GIB;
/**
 * Part size for track audio. Small enough that one part gets through on a
 * slow or flaky line (8 MiB is about two minutes at 0.5 Mbit/s), and above
 * the 5 MiB minimum S3 sets for every part but the last.
 */
export const AUDIO_PART_SIZE = 8 * MIB;

/**
 * Part size for a file of `size` bytes: `basePartSize` (64 MiB by default),
 * raised (in whole MiB) if the file would otherwise need more than MAX_PARTS parts.
 */
export function planParts(
  size: number,
  basePartSize = DEFAULT_PART_SIZE,
): { partSize: number; partCount: number } {
  let partSize = basePartSize;
  if (Math.ceil(size / partSize) > MAX_PARTS) {
    partSize = Math.ceil(size / MAX_PARTS / MIB) * MIB;
  }
  if (partSize > MAX_PART_SIZE) throw new RangeError("File too large for multipart upload");
  return { partSize, partCount: Math.max(1, Math.ceil(size / partSize)) };
}

/**
 * True only for keys the video-master presign route can produce:
 * `events/{eventCode}/masters/{timestamp}-{filename}`. Keeps the multipart
 * routes from signing arbitrary keys in the bucket.
 */
export function isVideoMasterKey(key: string): boolean {
  if (key.length > 1200) return false;
  if (key.split("/").some((seg) => seg === ".." || seg === ".")) return false;
  return /^events\/.+\/masters\/[^/].*$/.test(key);
}

/**
 * True only for keys the audio multipart create route can produce:
 * `events/{eventCode}/{filename}` (see buildTrackS3Key), one file directly
 * under the event, nothing nested.
 */
export function isTrackAudioKey(key: string): boolean {
  if (key.length > 1200) return false;
  const segments = key.split("/");
  if (segments.some((seg) => seg === ".." || seg === ".")) return false;
  return segments.length === 3 && segments[0] === "events" && segments[1] !== "" && segments[2] !== "";
}

/**
 * Check the parts S3 holds are exactly 1..N with no gaps or duplicates and
 * return them sorted. Returns null when they are not contiguous (or none).
 */
export function contiguousParts<T extends { partNumber: number }>(parts: T[]): T[] | null {
  if (parts.length === 0) return null;
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  return sorted.every((p, i) => p.partNumber === i + 1) ? sorted : null;
}
