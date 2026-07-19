import * as tus from "tus-js-client";
import { authFetch } from "./authFetch";

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
export async function uploadVideoFile(opts: UploadVideoOpts): Promise<void> {
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
}
