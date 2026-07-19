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

/**
 * Poll Bunny for transcoding status with backoff and a generous overall
 * timeout. Bunny's status doesn't change every second; polling fast burns
 * API calls for no benefit.
 *
 * Cadence: 3s for the first 30s, then 10s up to 5 min, then 30s up to 30 min.
 *
 * Resolves when status >= 4 (finished) or 5/6 (error). The webhook is the
 * authoritative path for backfilling duration on the track row — this poll
 * exists so admins watching the upload UI see live progress.
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
        throw new Error("Bunny transcoding failed");
      }
      if (meta.status >= 4) return meta;
    }
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) {
      throw new Error("Timed out waiting for Bunny transcoding");
    }
    await new Promise((r) => setTimeout(r, cadenceFor(elapsed)));
  }
  throw new Error("Upload cancelled");
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
  /** ID of the session that the video belongs to. The video becomes one of that session's recordings. */
  sessionId: number;
  /** 0-based position among the session's videos (order they play in). */
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
 * poll for transcoding completion → create a `session_videos` row.
 *
 * A session may have MULTIPLE videos now (each its own `session_videos` row,
 * ordered by `position`); audio tracks remain independent topic-indexed
 * slices. Resolves once the new `session_videos` row has been created — the
 * Bunny webhook backfills `durationSeconds` on that row asynchronously after
 * transcoding finishes. Rejects (and best-effort deletes the orphan video) on
 * any failure.
 */
export async function uploadVideoFile(opts: UploadVideoOpts): Promise<void> {
  const { sessionId, position, title, file, signal, onProgress, onTranscodingStart, onTranscodeStatus } = opts;

  // 1. Create the Bunny video record.
  const creds = await createBunnyVideo(title);

  // 2. TUS resumable upload.
  let createdVideoId: string | null = creds.videoId;
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
        reject(new Error("Upload cancelled"));
        return;
      }

      upload.start();
    });

    // 3. Poll Bunny until transcoding finishes (or fails).
    onTranscodingStart?.();
    await pollBunnyMeta(creds.videoId, signal, onTranscodeStatus);

    // 4. Create the session_videos row. We deliberately don't send duration
    //    or poster — the Bunny webhook backfills `durationSeconds` on this
    //    row once transcoding finishes, and the public media endpoint
    //    computes a signed thumbnail URL on the fly so the CDN hostname
    //    stays server-side.
    const res = await authFetch(`${API_URL}/session-videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, bunnyVideoId: creds.videoId, position }),
    });
    if (!res.ok) {
      throw new Error(`Create session video failed (${res.status}): ${await res.text()}`);
    }

    createdVideoId = null; // success — don't clean up
  } finally {
    if (createdVideoId) {
      await deleteBunnyVideo(createdVideoId);
    }
  }
}
