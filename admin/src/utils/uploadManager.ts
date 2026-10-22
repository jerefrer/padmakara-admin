import { uploadVideoFile } from "./videoUploader";
import { isVideoFilename } from "./trackParser";
import { authFetch } from "./authFetch";
import {
  HttpStatusError,
  NetworkError,
  UploadCancelledError,
  withRetry,
  type RetryOptions,
} from "./retry";

const API_URL = "/api/admin";

// ---------------------------------------------------------------------------
// Transcript upload helpers
// ---------------------------------------------------------------------------

/**
 * Request a presigned S3 upload URL for a single PDF transcript file.
 */
async function presignTranscript(
  eventCode: string,
  filename: string,
  contentType: string,
): Promise<{ s3Key: string; uploadUrl: string }> {
  const res = await authFetch(`${API_URL}/upload/presign-transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventCode, filename, contentType }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Presign failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Upload a transcript PDF: presign → PUT to S3 → return s3Key.
 *
 * Calls `onProgress` with a 0-1 fraction during the XHR upload.
 */
export async function uploadTranscript(
  eventCode: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<{ s3Key: string }> {
  const contentType = file.type || "application/pdf";
  const { s3Key, uploadUrl } = await presignTranscript(
    eventCode,
    file.name,
    contentType,
  );

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", contentType);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`S3 upload failed: ${xhr.status} ${xhr.statusText}`));
    };

    xhr.onerror = () => reject(new Error("Network error during transcript upload"));
    xhr.send(file);
  });

  return { s3Key };
}

// ---------------------------------------------------------------------------
// Generic event-document upload helpers (images, PDFs, Office docs, etc.)
// ---------------------------------------------------------------------------

/**
 * Request a presigned S3 upload URL for a single event document (a file
 * headed for the `event_files` table rather than a track or a transcript).
 */
export async function presignFile(
  eventCode: string,
  filename: string,
  contentType: string,
  fileType: string,
): Promise<{ s3Key: string; uploadUrl: string }> {
  const res = await authFetch(`${API_URL}/upload/presign-file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventCode, filename, contentType, fileType }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Presign failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Upload a generic event document: presign → PUT to S3 → return s3Key.
 *
 * Calls `onProgress` with a 0-1 fraction during the XHR upload.
 */
export async function uploadFile(
  eventCode: string,
  file: File,
  fileType: string,
  onProgress?: (fraction: number) => void,
): Promise<{ s3Key: string }> {
  const contentType = file.type || "application/octet-stream";
  const { s3Key, uploadUrl } = await presignFile(
    eventCode,
    file.name,
    contentType,
    fileType,
  );

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", contentType);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`S3 upload failed: ${xhr.status} ${xhr.statusText}`));
    };

    xhr.onerror = () => reject(new Error("Network error during file upload"));
    xhr.send(file);
  });

  return { s3Key };
}

/**
 * An audio upload item — one file becomes one track on a session.
 *
 * Videos use a different shape (`UploadVideoItem`) because a video doesn't
 * become a track; it attaches to the event itself (event-wide, not scoped to
 * a session).
 */
export interface UploadItem {
  trackId: number;
  sessionNumber: number;
  file: File;
  filename: string;
  mediaType?: "audio" | "video";
  /** Display title used as the Bunny video name. Defaults to filename. */
  title?: string;
  /**
   * For video items: the database event ID to attach the Bunny video to.
   * The audio path uses sessionNumber + presigned-URL flow; the video path
   * needs the event's primary key to create the `event_videos` row.
   */
  eventId?: number;
  /** For video items: 0-based position among the event's videos. */
  position?: number;
}

export interface FileStatus {
  filename: string;
  size: number;
  status: "pending" | "uploading" | "transcoding" | "done" | "error";
  progress: number; // 0-1
  /** For video items: Bunny status code (0..6) while transcoding. */
  transcodeStatus?: number;
  /** Set while a transient failure is being retried (1-based retry number). */
  retryAttempt?: number;
}

export interface UploadProgress {
  phase: "presigning" | "uploading" | "done" | "error";
  currentFilename: string | null;
  fileProgress: number;
  filesCompleted: number;
  filesTotal: number;
  bytesUploaded: number;
  bytesTotal: number;
  speed: number;
  error?: string;
  files: FileStatus[];
}

export type ProgressCallback = (progress: UploadProgress) => void;

/** Request presigned upload URLs for a batch of files in one session */
async function presignBatch(
  files: { filename: string; contentType: string; size: number }[],
  eventCode: string,
  sessionNumber: number,
): Promise<{ filename: string; s3Key: string; uploadUrl: string }[]> {
  const res = await authFetch(`${API_URL}/upload/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files, eventCode, sessionNumber }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new HttpStatusError(`Presign failed (${res.status}): ${text}`, res.status);
  }
  const data = await res.json();
  return data.urls;
}

/** Upload a single file via XHR PUT to a presigned URL, with progress */
function uploadFileXhr(
  url: string,
  file: File,
  onProgress: (loaded: number) => void,
  signal: { cancelled: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "audio/mpeg");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        reject(
          new HttpStatusError(
            `S3 upload failed: ${xhr.status} ${xhr.statusText}\n${xhr.responseText}`,
            xhr.status,
          ),
        );
      }
    };

    xhr.onerror = () => reject(new NetworkError("Network error during upload"));
    xhr.onabort = () => reject(new UploadCancelledError());

    // Check for cancellation before starting
    if (signal.cancelled) {
      reject(new UploadCancelledError());
      return;
    }

    // Store abort function on signal for external cancellation
    (signal as any).abort = () => xhr.abort();

    xhr.send(file);
  });
}

/** Update track record with S3 key and file size after successful upload */
async function updateTrackS3Key(
  trackId: number,
  s3Key: string,
  fileSizeBytes: number,
): Promise<void> {
  const res = await authFetch(`${API_URL}/tracks/${trackId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ s3Key, fileSizeBytes }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new HttpStatusError(`Track update failed (${res.status}): ${text}`, res.status);
  }
}

// Rolling speed calculator: average over last N samples
export class SpeedTracker {
  private samples: { time: number; bytes: number }[] = [];
  private windowMs = 5000;

  record(totalBytesUploaded: number) {
    const now = Date.now();
    this.samples.push({ time: now, bytes: totalBytesUploaded });
    // Trim old samples
    const cutoff = now - this.windowMs;
    this.samples = this.samples.filter((s) => s.time >= cutoff);
  }

  getSpeed(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const dt = (last.time - first.time) / 1000;
    if (dt === 0) return 0;
    return (last.bytes - first.bytes) / dt;
  }
}

export interface UploadTracksOptions {
  /**
   * Called once an audio item is fully done: its file is in S3 and its track
   * row carries the s3_key. Lets callers keep a persisted resume queue in step
   * with what actually reached the server.
   */
  onItemUploaded?: (item: UploadItem) => void;
  /** Retry/backoff tuning for transient failures (tests use a zero delay). */
  retry?: Pick<RetryOptions, "retries" | "baseDelayMs" | "maxDelayMs" | "sleep">;
}

/**
 * Upload all tracks to S3 sequentially with progress tracking.
 * Returns a promise that resolves when all uploads complete,
 * and a cancel function.
 *
 * Each audio file is presigned right before its own upload (a whole session
 * presigned up front could outlive the URLs' one-hour expiry on a slow
 * connection), and transient failures — a dropped connection, a 5xx — are
 * retried with exponential backoff before the upload gives up.
 */
export function uploadTracks(
  items: UploadItem[],
  eventCode: string,
  onProgress: ProgressCallback,
  options: UploadTracksOptions = {},
): { promise: Promise<void>; cancel: () => void } {
  const signal = { cancelled: false };
  const bytesTotal = items.reduce((sum, item) => sum + item.file.size, 0);

  // Build initial file status list from items
  const fileStatuses: FileStatus[] = items.map((item) => ({
    filename: item.filename,
    size: item.file.size,
    status: "pending",
    progress: 0,
  }));

  // Split audio (S3) from video (Bunny TUS). Audio is batched per session
  // for presigned URLs; video uploads run sequentially after audio finishes.
  const audioItems = items.filter(
    (i) => (i.mediaType ?? (isVideoFilename(i.filename) ? "video" : "audio")) === "audio",
  );
  const videoItems = items.filter(
    (i) => (i.mediaType ?? (isVideoFilename(i.filename) ? "video" : "audio")) === "video",
  );

  // Declared outside the upload body so the error report below can say how
  // many files really made it before the failure.
  let bytesCompleted = 0;
  let filesCompleted = 0;

  const promise = (async () => {
    onProgress({
      phase: "presigning",
      currentFilename: null,
      fileProgress: 0,
      filesCompleted: 0,
      filesTotal: items.length,
      bytesUploaded: 0,
      bytesTotal,
      speed: 0,
      files: fileStatuses,
    });

    // Upload audio files sequentially: presign → PUT to S3 → backfill s3_key.
    const speedTracker = new SpeedTracker();

    for (const item of audioItems) {
      if (signal.cancelled) throw new UploadCancelledError();

      const fileStart = bytesCompleted;
      const fileIdx = fileStatuses.findIndex((f) => f.filename === item.filename);
      if (fileIdx >= 0) {
        fileStatuses[fileIdx] = { ...fileStatuses[fileIdx]!, status: "uploading", progress: 0 };
      }

      const emit = (fileProgress: number, bytesUploaded: number) =>
        onProgress({
          phase: "uploading",
          currentFilename: item.filename,
          fileProgress,
          filesCompleted,
          filesTotal: items.length,
          bytesUploaded,
          bytesTotal,
          speed: speedTracker.getSpeed(),
          files: fileStatuses,
        });

      emit(0, bytesCompleted);

      const contentType = item.file.type || "audio/mpeg";
      const s3Key = await withRetry(
        async () => {
          const [url] = await presignBatch(
            [{ filename: item.filename, contentType, size: item.file.size }],
            eventCode,
            item.sessionNumber,
          );
          if (!url) throw new Error(`Presign returned no URL for ${item.filename}`);
          await uploadFileXhr(
            url.uploadUrl,
            item.file,
            (loaded) => {
              const totalUploaded = fileStart + loaded;
              const pct = loaded / item.file.size;
              speedTracker.record(totalUploaded);
              if (fileIdx >= 0) {
                fileStatuses[fileIdx] = { ...fileStatuses[fileIdx]!, progress: pct };
              }
              emit(pct, totalUploaded);
            },
            signal,
          );
          return url.s3Key;
        },
        {
          ...options.retry,
          signal,
          onRetry: (attempt) => {
            // A failed attempt restarts the file from zero.
            if (fileIdx >= 0) {
              fileStatuses[fileIdx] = {
                ...fileStatuses[fileIdx]!,
                progress: 0,
                retryAttempt: attempt,
              };
            }
            emit(0, fileStart);
          },
        },
      );

      // The file is in S3 now: always record it, even if the admin cancels
      // meanwhile — otherwise the object is orphaned and the track stays
      // keyless. So no cancellation signal on this step.
      await withRetry(
        () => updateTrackS3Key(item.trackId, s3Key, item.file.size),
        options.retry,
      );

      if (fileIdx >= 0) {
        fileStatuses[fileIdx] = {
          ...fileStatuses[fileIdx]!,
          status: "done",
          progress: 1,
          retryAttempt: undefined,
        };
      }
      bytesCompleted += item.file.size;
      filesCompleted++;
      options.onItemUploaded?.(item);
    }

    // Phase 3: Upload video items sequentially via Bunny TUS.
    for (const item of videoItems) {
      if (signal.cancelled) throw new Error("Upload cancelled");

      const fileStart = bytesCompleted;
      const fileIdx = fileStatuses.findIndex((f) => f.filename === item.filename);
      if (fileIdx >= 0) {
        fileStatuses[fileIdx] = { ...fileStatuses[fileIdx]!, status: "uploading", progress: 0 };
      }

      onProgress({
        phase: "uploading",
        currentFilename: item.filename,
        fileProgress: 0,
        filesCompleted,
        filesTotal: items.length,
        bytesUploaded: bytesCompleted,
        bytesTotal,
        speed: speedTracker.getSpeed(),
        files: fileStatuses,
      });

      if (typeof item.eventId !== "number") {
        throw new Error(
          `Video upload requires an eventId on the upload item (filename: ${item.filename})`,
        );
      }
      await uploadVideoFile({
        eventId: item.eventId,
        position: item.position ?? 0,
        title: item.title ?? item.filename,
        file: item.file,
        signal,
        onProgress: (loaded, total) => {
          const totalUploaded = fileStart + loaded;
          const pct = total > 0 ? loaded / total : 0;
          speedTracker.record(totalUploaded);
          if (fileIdx >= 0) {
            fileStatuses[fileIdx] = { ...fileStatuses[fileIdx]!, progress: pct };
          }
          onProgress({
            phase: "uploading",
            currentFilename: item.filename,
            fileProgress: pct,
            filesCompleted,
            filesTotal: items.length,
            bytesUploaded: totalUploaded,
            bytesTotal,
            speed: speedTracker.getSpeed(),
            files: fileStatuses,
          });
        },
        onTranscodingStart: () => {
          if (fileIdx >= 0) {
            fileStatuses[fileIdx] = {
              ...fileStatuses[fileIdx]!,
              status: "transcoding",
              progress: 1,
            };
          }
          // Count the upload bytes as completed so the overall bar advances —
          // transcoding doesn't have its own byte-level progress.
          onProgress({
            phase: "uploading",
            currentFilename: item.filename,
            fileProgress: 1,
            filesCompleted,
            filesTotal: items.length,
            bytesUploaded: fileStart + item.file.size,
            bytesTotal,
            speed: speedTracker.getSpeed(),
            files: fileStatuses,
          });
        },
        onTranscodeStatus: (status) => {
          if (fileIdx >= 0) {
            fileStatuses[fileIdx] = {
              ...fileStatuses[fileIdx]!,
              transcodeStatus: status,
            };
          }
          onProgress({
            phase: "uploading",
            currentFilename: item.filename,
            fileProgress: 1,
            filesCompleted,
            filesTotal: items.length,
            bytesUploaded: fileStart + item.file.size,
            bytesTotal,
            speed: speedTracker.getSpeed(),
            files: fileStatuses,
          });
        },
      });

      if (fileIdx >= 0) {
        fileStatuses[fileIdx] = { ...fileStatuses[fileIdx]!, status: "done", progress: 1 };
      }
      bytesCompleted += item.file.size;
      filesCompleted++;
    }

    onProgress({
      phase: "done",
      currentFilename: null,
      fileProgress: 1,
      filesCompleted: items.length,
      filesTotal: items.length,
      bytesUploaded: bytesTotal,
      bytesTotal,
      speed: speedTracker.getSpeed(),
      files: fileStatuses,
    });
  })().catch((err) => {
    // Mark any uploading file as error
    for (let i = 0; i < fileStatuses.length; i++) {
      if (fileStatuses[i]!.status === "uploading") {
        fileStatuses[i] = { ...fileStatuses[i]!, status: "error", progress: 0 };
      }
    }
    if (!signal.cancelled) {
      onProgress({
        phase: "error",
        currentFilename: null,
        fileProgress: 0,
        filesCompleted,
        filesTotal: items.length,
        bytesUploaded: bytesCompleted,
        bytesTotal,
        speed: 0,
        error: err.message,
        files: fileStatuses,
      });
    }
    throw err;
  });

  return {
    promise,
    cancel: () => {
      signal.cancelled = true;
      if ((signal as any).abort) (signal as any).abort();
    },
  };
}
