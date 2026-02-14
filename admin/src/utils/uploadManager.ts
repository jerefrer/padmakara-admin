const API_URL = "/api/admin";

export interface UploadItem {
  trackId: number;
  sessionNumber: number;
  file: File;
  filename: string;
}

export interface FileStatus {
  filename: string;
  size: number;
  status: "pending" | "uploading" | "done" | "error";
  progress: number; // 0-1
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
  authToken: string,
): Promise<{ filename: string; s3Key: string; uploadUrl: string }[]> {
  const res = await fetch(`${API_URL}/upload/presign`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
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
  authToken: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/tracks/${trackId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ s3Key, fileSizeBytes }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Track update failed (${res.status}): ${text}`);
  }
}

// Rolling speed calculator: average over last N samples
class SpeedTracker {
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
  authToken: string,
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

  const promise = (async () => {
    // Phase 1: Get presigned URLs grouped by session
    const bySession = new Map<number, UploadItem[]>();
    for (const item of items) {
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

      const urls = await presignBatch(presignFiles, eventCode, sessionNumber, authToken);

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
      await updateTrackS3Key(queued.trackId, queued.s3Key, queued.file.size, authToken);

      if (fileIdx >= 0) {
        fileStatuses[fileIdx] = { ...fileStatuses[fileIdx]!, status: "done", progress: 1 };
      }
      bytesCompleted += queued.file.size;
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
