import * as tus from "tus-js-client";
import { authFetch } from "./authFetch";
import {
  MULTIPART_THRESHOLD_BYTES,
  PART_CONCURRENCY,
  decidePartRetry,
  nextPresignBatch,
  overallFraction,
  partRange,
} from "./multipartPlan";

const API_URL = "/api/admin";

interface TusCredentials {
  endpoint: string;
  videoId: string;
  libraryId: string;
  signature: string;
  expirationTime: number;
}

interface BunnyVideoMeta {
  guid: string;
  status: number; // 4 = finished, 5 = error
  durationSeconds: number;
  thumbnailFileName: string | null;
}

/** Ask the backend to create a Bunny video and return TUS upload credentials. */
async function createBunnyVideo(title: string): Promise<TusCredentials> {
  const res = await authFetch(`${API_URL}/upload/bunny/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    throw new Error(`Bunny create-video failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/** Bunny reported transcoding failure (status 5/6) — the video is unusable. */
export class TranscodeFailedError extends Error {
  constructor() {
    super("Bunny transcoding failed");
  }
}

/** The admin clicked Cancel while we were waiting on Bunny. */
export class UploadCancelledError extends Error {
  constructor() {
    super("Upload cancelled");
  }
}

/**
 * Poll Bunny for transcoding status with backoff and a generous overall
 * timeout. Bunny's status doesn't change every second; polling fast burns
 * API calls for no benefit.
 *
 * Cadence: 3s for the first 30s, then 10s up to 5 min, then 30s up to 30 min.
 *
 * Resolves when status >= 4 (finished) or throws TranscodeFailedError on 5/6.
 * The webhook is the authoritative path for backfilling duration on the row —
 * this poll exists so admins watching the upload UI see live progress.
 */
async function pollBunnyMeta(
  videoId: string,
  signal: { cancelled: boolean },
  onStatusChange?: (status: number) => void,
  timeoutMs = 30 * 60 * 1000,
): Promise<BunnyVideoMeta> {
  const start = Date.now();
  let lastReportedStatus: number | null = null;
  const cadenceFor = (elapsedMs: number): number => {
    if (elapsedMs < 30_000) return 3_000;
    if (elapsedMs < 5 * 60_000) return 10_000;
    return 30_000;
  };

  while (!signal.cancelled) {
    const res = await authFetch(`${API_URL}/upload/bunny/${videoId}`);
    if (res.ok) {
      const meta = (await res.json()) as BunnyVideoMeta;
      if (meta.status !== lastReportedStatus) {
        lastReportedStatus = meta.status;
        onStatusChange?.(meta.status);
      }
      if (meta.status === 5 || meta.status === 6) {
        throw new TranscodeFailedError();
      }
      if (meta.status >= 4) return meta;
    }
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) {
      throw new Error("Timed out waiting for Bunny transcoding");
    }
    await new Promise((r) => setTimeout(r, cadenceFor(elapsed)));
  }
  throw new UploadCancelledError();
}

/** Best-effort cleanup if upload fails before the track row is patched. */
async function deleteBunnyVideo(videoId: string): Promise<void> {
  try {
    await authFetch(`${API_URL}/upload/bunny/${videoId}`, { method: "DELETE" });
  } catch {
    // Swallow — cleanup is best-effort and the orphan can be removed manually.
  }
}

interface UploadVideoOpts {
  /** ID of the event that the video belongs to. Videos are event-wide, not scoped to a session. */
  eventId: number;
  /** 0-based position among the event's videos (order they play in). */
  position: number;
  title: string;
  file: File;
  signal: { cancelled: boolean; abort?: () => void };
  onProgress: (loaded: number, total: number) => void;
  /** Called when the file finishes uploading and Bunny starts transcoding. */
  onTranscodingStart?: () => void;
  /** Called each time Bunny's status code changes during transcoding. */
  onTranscodeStatus?: (status: number) => void;
}

/**
 * Upload a single video file end-to-end: create Bunny video → TUS upload →
 * create the `event_videos` row → poll transcoding for UI feedback.
 *
 * The row is created IMMEDIATELY after the upload completes — not after
 * transcoding. Transcoding takes longer than the poll's 30-min timeout for
 * big files, and anything that killed the poll (timeout, network blip, the
 * admin navigating away) used to delete a fully-uploaded video and lose the
 * row. Once the row exists the video is safe: the Bunny webhook backfills
 * `durationSeconds` whenever transcoding finishes. Poll failures after that
 * point are non-fatal; only a genuine transcode failure (or the admin
 * cancelling) removes the row again.
 */
export async function uploadVideoFile(opts: UploadVideoOpts): Promise<{ videoId: number | null }> {
  const { eventId, position, title, file, signal, onProgress, onTranscodingStart, onTranscodeStatus } = opts;

  // 1. Create the Bunny video record.
  const creds = await createBunnyVideo(title);

  // 2. TUS resumable upload. A failure here leaves a partial upload —
  //    the only case where deleting the Bunny video is the right cleanup.
  let orphanVideoId: string | null = creds.videoId;
  let rowId: number | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      const upload = new tus.Upload(file, {
        endpoint: creds.endpoint,
        // Spans ~9 min of consecutive failures. Multi-GB uploads run for
        // hours; giving up after seconds meant one wifi blip destroyed the
        // whole upload (the error path deletes the partial Bunny video).
        // tus resets the attempt counter once a request succeeds again.
        retryDelays: [0, 3000, 10000, 30000, 60000, 120000, 300000],
        headers: {
          AuthorizationSignature: creds.signature,
          AuthorizationExpire: String(creds.expirationTime),
          VideoId: creds.videoId,
          LibraryId: creds.libraryId,
        },
        metadata: {
          filetype: file.type || "video/mp4",
          title,
        },
        onError: (err) => reject(err),
        onProgress: (bytesUploaded, bytesTotal) => onProgress(bytesUploaded, bytesTotal),
        onSuccess: () => resolve(),
      });

      signal.abort = () => upload.abort();
      if (signal.cancelled) {
        upload.abort();
        reject(new UploadCancelledError());
        return;
      }

      upload.start();
    });

    // 3. Create the event_videos row now that the bytes are all on Bunny.
    //    No duration/poster — the webhook backfills `durationSeconds`, and
    //    the media endpoint signs thumbnail URLs on the fly.
    const res = await authFetch(`${API_URL}/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId, bunnyVideoId: creds.videoId, position, titleEn: title ?? null }),
    });
    if (!res.ok) {
      throw new Error(`Create event video failed (${res.status}): ${await res.text()}`);
    }
    rowId = ((await res.json()) as { id: number }).id;
    orphanVideoId = null; // row exists — the video is no longer an orphan
  } finally {
    if (orphanVideoId) {
      await deleteBunnyVideo(orphanVideoId);
    }
  }

  // 4. Poll Bunny for transcoding — pure UI feedback from here on.
  onTranscodingStart?.();
  try {
    await pollBunnyMeta(creds.videoId, signal, onTranscodeStatus);
  } catch (err) {
    if (err instanceof TranscodeFailedError || err instanceof UploadCancelledError) {
      // Genuinely unusable (or the admin aborted): remove the row — the
      // DELETE endpoint also removes the Bunny video when unreferenced.
      if (rowId !== null) {
        await authFetch(`${API_URL}/videos/${rowId}`, { method: "DELETE" }).catch(() => {});
      }
      throw err;
    }
    // Poll timeout or transient network error — transcoding continues on
    // Bunny's side and the webhook will backfill the duration. The upload
    // itself succeeded, so don't fail the flow or touch the video.
    console.warn("[videoUploader] transcode polling stopped early (non-fatal):", err);
  }

  // Surfaced so the caller can attach post-create state (e.g. recording that
  // the admin declared this file already carries burnt-in slides).
  return { videoId: rowId };
}

// ─── Burn-in path: upload the master to S3, then let AWS Batch merge slides ──

interface MasterUploadOpts {
  eventCode: string;
  file: File;
  contentType: string;
  signal: { cancelled: boolean; abort?: () => void };
  onProgress?: (fraction: number) => void;
}

/** Single presigned PUT of the whole file — used below the multipart threshold. */
async function uploadMasterSinglePut(opts: MasterUploadOpts): Promise<string> {
  const { eventCode, file, contentType, signal } = opts;

  // Presign a PUT for the master. Long TTL — these are multi-GB files.
  const presignRes = await authFetch(`${API_URL}/upload/video/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventCode, filename: file.name, contentType }),
  });
  if (!presignRes.ok) {
    throw new Error(`Presign master failed (${presignRes.status}): ${await presignRes.text()}`);
  }
  const { s3Key, uploadUrl } = (await presignRes.json()) as { s3Key: string; uploadUrl: string };

  // PUT the bytes straight to S3, same shape as uploadManager.uploadFile.
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    signal.abort = () => xhr.abort();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && opts.onProgress) opts.onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Master upload failed: ${xhr.status} ${xhr.statusText}`));
    xhr.onerror = () => reject(new Error("Network error during master upload"));
    xhr.onabort = () => reject(new UploadCancelledError());
    xhr.send(file);
  });
  return s3Key;
}

async function postJson<T>(path: string, body: unknown, what: string): Promise<T> {
  const res = await authFetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${what} failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/**
 * Multipart upload of a master: parts are PUT straight to S3 four at a time,
 * each retried independently with backoff, so a flaky connection costs one
 * part (64 MiB) instead of the whole file. On cancel or final failure the
 * multipart upload is aborted so S3 does not keep billing for the orphan parts.
 */
async function uploadMasterMultipart(opts: MasterUploadOpts): Promise<string> {
  const { eventCode, file, contentType, signal } = opts;

  const { uploadId, s3Key, partSize, partCount } = await postJson<{
    uploadId: string;
    s3Key: string;
    partSize: number;
    partCount: number;
  }>("/upload/video/multipart/create", { eventCode, filename: file.name, contentType, size: file.size }, "Start multipart upload");

  const inFlightXhrs = new Set<XMLHttpRequest>();
  const inFlightBytes = new Map<number, number>();
  const pending = new Set<number>();
  for (let n = 1; n <= partCount; n++) pending.add(n);
  const urls = new Map<number, string>();
  let presigning: Promise<void> | null = null;
  let confirmedBytes = 0;
  let aborted = false;
  let failure: unknown = null;
  let lastEmit = 0;

  const emit = (force = false) => {
    if (!opts.onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmit < 100) return;
    lastEmit = now;
    opts.onProgress(overallFraction(confirmedBytes, inFlightBytes.values(), file.size));
  };

  const isCancelled = () => aborted || signal.cancelled;
  signal.abort = () => {
    aborted = true;
    for (const xhr of inFlightXhrs) xhr.abort();
  };

  const presignBatch = async (first: number, force: boolean): Promise<void> => {
    const numbers = nextPresignBatch(first, partCount, (n) => pending.has(n) && !urls.has(n));
    const batch = force ? [first] : numbers;
    const { urls: signed } = await postJson<{ urls: Record<string, string> }>(
      "/upload/video/multipart/presign-parts",
      { s3Key, uploadId, partNumbers: batch },
      "Presign parts",
    );
    for (const [n, url] of Object.entries(signed)) urls.set(Number(n), url);
  };

  const getUrl = async (partNumber: number, force: boolean): Promise<string> => {
    if (force) urls.delete(partNumber);
    while (!urls.has(partNumber)) {
      if (presigning) {
        await presigning;
        continue;
      }
      presigning = presignBatch(partNumber, force).finally(() => {
        presigning = null;
      });
      await presigning;
    }
    // Presence checked by the loop above.
    return urls.get(partNumber) as string;
  };

  /** PUT one part; resolves on 2xx, rejects with an HttpFailure otherwise. */
  const putPart = (partNumber: number, url: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const { start, end } = partRange(partNumber, partSize, file.size);
      const xhr = new XMLHttpRequest();
      inFlightXhrs.add(xhr);
      const done = () => {
        inFlightXhrs.delete(xhr);
        inFlightBytes.delete(partNumber);
      };
      xhr.open("PUT", url);
      xhr.upload.onprogress = (e) => {
        inFlightBytes.set(partNumber, e.loaded);
        emit();
      };
      xhr.onload = () => {
        done();
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new PartHttpError(xhr.status));
      };
      xhr.onerror = () => {
        done();
        reject(new PartHttpError(0));
      };
      xhr.ontimeout = xhr.onerror;
      xhr.onabort = () => {
        done();
        reject(new UploadCancelledError());
      };
      xhr.send(file.slice(start, end));
    });

  const uploadPart = async (partNumber: number): Promise<void> => {
    const { start, end } = partRange(partNumber, partSize, file.size);
    let failures = 0;
    let represign = false;
    for (;;) {
      if (isCancelled()) throw new UploadCancelledError();
      try {
        await putPart(partNumber, await getUrl(partNumber, represign));
        confirmedBytes += end - start;
        pending.delete(partNumber);
        emit(true);
        return;
      } catch (err) {
        if (isCancelled() || err instanceof UploadCancelledError) throw new UploadCancelledError();
        const status = err instanceof PartHttpError ? err.status : 0;
        const decision = decidePartRetry(++failures, status);
        if (decision.action === "fail") {
          throw new Error(
            status
              ? `Part ${partNumber} of ${partCount} was rejected by storage (HTTP ${status})`
              : `Part ${partNumber} of ${partCount} failed after ${failures - 1} retries (network error)`,
          );
        }
        represign = decision.represign;
        await new Promise((r) => setTimeout(r, decision.delayMs));
      }
    }
  };

  const queue = Array.from(pending);
  const worker = async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
      if (failure || isCancelled()) return;
      try {
        await uploadPart(n);
      } catch (err) {
        failure ??= err;
        // Stop sibling parts quickly instead of letting them retry on.
        aborted = true;
        for (const xhr of inFlightXhrs) xhr.abort();
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, partCount) }, worker));
    if (failure) throw failure;
    if (signal.cancelled || aborted) throw new UploadCancelledError();
    await postJson("/upload/video/multipart/complete", { s3Key, uploadId }, "Complete multipart upload");
    emit(true);
    return s3Key;
  } catch (err) {
    // Best effort: an orphaned multipart upload keeps its parts in storage.
    await postJson("/upload/video/multipart/abort", { s3Key, uploadId }, "Abort multipart upload").catch(() => {});
    throw err;
  }
}

/** A part PUT answered with a non-2xx status (0 = no response at all). */
class PartHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Part upload failed: ${status}`);
    this.status = status;
  }
}

/**
 * Upload a video master for the slide burn-in pipeline.
 *
 * This is the OTHER upload path, taken whenever the admin has defined intro/
 * outro slides. Rather than sending the file straight to Bunny over TUS (see
 * uploadVideoFile above), the master goes to S3 and stays there: an AWS Batch
 * job renders the slides, concatenates them around the master, and hands the
 * merged file to Bunny. Keeping the master means a later slide edit re-burns
 * from the original rather than from a Bunny re-download, so repeated edits
 * never accumulate generation loss.
 *
 * Resolves as soon as the job is queued — burning happens asynchronously and
 * the row's burnStatus reports progress. It does NOT wait for Bunny.
 */
export async function uploadVideoMaster(opts: {
  eventId: number;
  eventCode: string;
  position: number;
  title: string | null;
  file: File;
  slides: unknown;
  signal: { cancelled: boolean; abort?: () => void };
  onProgress?: (fraction: number) => void;
  onBurnQueued?: () => void;
}): Promise<{ videoId: number }> {
  const { eventId, eventCode, position, title, file, slides, signal } = opts;
  const contentType = file.type || "video/mp4";

  // 1+2. Get the master onto S3. Big files go as a multipart upload (a single
  //      PUT is capped at 5 GB and one dropped connection restarts it);
  //      smaller ones keep the single presigned PUT.
  const s3Key =
    file.size >= MULTIPART_THRESHOLD_BYTES
      ? await uploadMasterMultipart({ eventCode, file, contentType, signal, onProgress: opts.onProgress })
      : await uploadMasterSinglePut({ eventCode, file, contentType, signal, onProgress: opts.onProgress });

  if (signal.cancelled) throw new UploadCancelledError();

  // 3. Create the row (no Bunny video yet — bunnyVideoId stays null until the
  //    completion webhook fires) and queue the Batch burn job.
  const burnRes = await authFetch(`${API_URL}/videos/burn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventId, position, titleEn: title ?? null, masterS3Key: s3Key, slides }),
  });
  if (!burnRes.ok) {
    throw new Error(`Queueing burn job failed (${burnRes.status}): ${await burnRes.text()}`);
  }
  const { videoId } = (await burnRes.json()) as { videoId: number };
  opts.onBurnQueued?.();
  return { videoId };
}
