import { uploadVideoFile } from "./videoUploader";
import { isVideoFilename } from "./trackParser";
import { authFetch } from "./authFetch";

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

interface PresignedFile {
  trackId: number;
  filename: string;
  s3Key: string;
  uploadUrl: string;
  file: File;
}

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
    throw new Error(`Presign failed (${res.status}): ${text}`);
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
      else reject(new Error(`S3 upload failed: ${xhr.status} ${xhr.statusText}\n${xhr.responseText}`));
    };

    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));

    // Check for cancellation before starting
    if (signal.cancelled) {
      reject(new Error("Upload cancelled"));
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
    throw new Error(`Track update failed (${res.status}): ${text}`);
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

/**
 * Upload all tracks to S3 sequentially with progress tracking.
 * Returns a promise that resolves when all uploads complete,
 * and a cancel function.
 */
export function uploadTracks(
  items: UploadItem[],
  eventCode: string,
  onProgress: ProgressCallback,
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

  const promise = (async () => {
    // Phase 1: Get presigned URLs grouped by session (audio only)
    const bySession = new Map<number, UploadItem[]>();
    for (const item of audioItems) {
      const group = bySession.get(item.sessionNumber) ?? [];
      group.push(item);
      bySession.set(item.sessionNumber, group);
    }

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

    // Request presigned URLs per session batch
    const uploadQueue: PresignedFile[] = [];

    for (const [sessionNumber, sessionItems] of bySession) {
      if (signal.cancelled) throw new Error("Upload cancelled");

      const presignFiles = sessionItems.map((item) => ({
        filename: item.filename,
        contentType: item.file.type || "audio/mpeg",
        size: item.file.size,
      }));

      const urls = await presignBatch(presignFiles, eventCode, sessionNumber);

      // Match presigned URLs back to items by filename
      for (const url of urls) {
        const item = sessionItems.find((i) => i.filename === url.filename);
        if (item) {
          uploadQueue.push({
            trackId: item.trackId,
            filename: item.filename,
            s3Key: url.s3Key,
            uploadUrl: url.uploadUrl,
            file: item.file,
          });
        }
      }
    }

    // Phase 2: Upload files sequentially
    const speedTracker = new SpeedTracker();
    let bytesCompleted = 0;
    let filesCompleted = 0;

    for (const queued of uploadQueue) {
      if (signal.cancelled) throw new Error("Upload cancelled");

      const fileStart = bytesCompleted;
      const fileIdx = fileStatuses.findIndex((f) => f.filename === queued.filename);
      if (fileIdx >= 0) {
        fileStatuses[fileIdx] = { ...fileStatuses[fileIdx]!, status: "uploading", progress: 0 };
      }

      onProgress({
        phase: "uploading",
        currentFilename: queued.filename,
        fileProgress: 0,
        filesCompleted,
        filesTotal: items.length,
        bytesUploaded: bytesCompleted,
        bytesTotal,
        speed: speedTracker.getSpeed(),
        files: fileStatuses,
      });

      await uploadFileXhr(
        queued.uploadUrl,
        queued.file,
        (loaded) => {
          const totalUploaded = fileStart + loaded;
          const pct = loaded / queued.file.size;
          speedTracker.record(totalUploaded);
          if (fileIdx >= 0) {
            fileStatuses[fileIdx] = { ...fileStatuses[fileIdx]!, progress: pct };
          }
          onProgress({
            phase: "uploading",
            currentFilename: queued.filename,
            fileProgress: pct,
            filesCompleted,
            filesTotal: items.length,
            bytesUploaded: totalUploaded,
            bytesTotal,
            speed: speedTracker.getSpeed(),
            files: fileStatuses,
          });
        },
        signal,
      );

      // Update track record with S3 key
      await updateTrackS3Key(queued.trackId, queued.s3Key, queued.file.size);

      if (fileIdx >= 0) {
        fileStatuses[fileIdx] = { ...fileStatuses[fileIdx]!, status: "done", progress: 1 };
      }
      bytesCompleted += queued.file.size;
      filesCompleted++;
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
        filesCompleted: 0,
        filesTotal: items.length,
        bytesUploaded: 0,
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
