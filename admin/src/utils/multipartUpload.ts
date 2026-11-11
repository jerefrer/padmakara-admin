import { authFetch } from "./authFetch";
import {
  PART_CONCURRENCY,
  decidePartRetry,
  nextPresignBatch,
  overallFraction,
  partRange,
  parseResumeEntry,
  partsToSkip,
  bytesOfParts,
  type ResumeEntry,
} from "./multipartPlan";
import { HttpStatusError, NetworkError, UploadCancelledError } from "./retry";

/**
 * The S3 multipart engine shared by video masters and track audio: parts are
 * PUT straight to S3 four at a time, each retried independently with backoff,
 * so a flaky connection costs one part instead of the whole file. The session
 * is kept in localStorage, so choosing the same file again (after a reload, or
 * a failure) resumes from the parts S3 already holds.
 */

const API_URL = "/api/admin";

export interface MultipartUploadOpts {
  /** Route prefix under /api/admin, e.g. "/upload/audio/multipart". */
  routeBase: string;
  /** Body of the `${routeBase}/create` call. */
  createBody: Record<string, unknown>;
  /** localStorage key identifying this file for this target (see resumeStorageKey). */
  storageKey: string;
  file: File;
  signal: { cancelled: boolean; abort?: () => void };
  onProgress?: (fraction: number) => void;
  /** Called once when an earlier partial upload is resumed, with the fraction already on S3. */
  onResume?: (fraction: number) => void;
  /** Wait between part retries; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** A part PUT answered with a non-2xx status (0 = no response at all). */
class PartHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Part upload failed: ${status}`);
    this.status = status;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function postJson<T>(path: string, body: unknown, what: string): Promise<T> {
  const res = await authFetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new HttpStatusError(`${what} failed (${res.status}): ${await res.text()}`, res.status);
  }
  return (await res.json()) as T;
}

function loadResumeEntry(storageKey: string, fileSize: number): ResumeEntry | null {
  try {
    const raw = localStorage.getItem(storageKey);
    const entry = parseResumeEntry(raw, Date.now(), fileSize);
    if (raw && !entry) localStorage.removeItem(storageKey);
    return entry;
  } catch {
    return null;
  }
}

function saveResumeEntry(storageKey: string, entry: ResumeEntry): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(entry));
  } catch {
    // Storage blocked or full: the upload still works, it just cannot resume.
  }
}

function clearResumeEntry(storageKey: string): void {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

/** Parts S3 holds for a stored session, or null when the upload no longer exists. */
async function listExistingParts(
  routeBase: string,
  session: ResumeEntry,
): Promise<{ partNumber: number; size: number }[] | null> {
  const res = await authFetch(`${API_URL}${routeBase}/list-parts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ s3Key: session.s3Key, uploadId: session.uploadId }),
  });
  if (res.status === 404) return null; // NO_SUCH_UPLOAD
  if (!res.ok) {
    throw new HttpStatusError(`List uploaded parts failed (${res.status}): ${await res.text()}`, res.status);
  }
  return ((await res.json()) as { parts: { partNumber: number; size: number }[] }).parts;
}

/**
 * Upload `file` as an S3 multipart upload and resolve with its key. Throws
 * UploadCancelledError on cancel (and aborts the upload), NetworkError when a
 * part keeps failing without a response, HttpStatusError when storage or the
 * API refuses a request. Only a cancel discards the parts already sent.
 */
export async function uploadMultipart(opts: MultipartUploadOpts): Promise<string> {
  const { routeBase, storageKey, file, signal } = opts;
  const sleep = opts.sleep ?? defaultSleep;

  // Resume a stored session if S3 still has it; otherwise start a new one.
  let session = loadResumeEntry(storageKey, file.size);
  let skipped: number[] = [];
  if (session) {
    const listed = await listExistingParts(routeBase, session);
    if (listed === null) {
      clearResumeEntry(storageKey);
      session = null;
    } else {
      skipped = partsToSkip(listed, session.partSize, session.partCount, file.size);
    }
  }
  if (!session) {
    const created = await postJson<{
      uploadId: string;
      s3Key: string;
      partSize: number;
      partCount: number;
    }>(`${routeBase}/create`, opts.createBody, "Start multipart upload");
    session = { ...created, createdAt: Date.now() };
    saveResumeEntry(storageKey, session);
  }
  const { uploadId, s3Key, partSize, partCount } = session;

  const inFlightXhrs = new Set<XMLHttpRequest>();
  const inFlightBytes = new Map<number, number>();
  const pending = new Set<number>();
  for (let n = 1; n <= partCount; n++) pending.add(n);
  for (const n of skipped) pending.delete(n);
  const urls = new Map<number, string>();
  let presigning: Promise<void> | null = null;
  let confirmedBytes = bytesOfParts(skipped, partSize, file.size);
  if (skipped.length > 0) {
    opts.onResume?.(confirmedBytes / file.size);
    opts.onProgress?.(overallFraction(confirmedBytes, [], file.size));
  }
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
      `${routeBase}/presign-parts`,
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

  /** PUT one part; resolves on 2xx, rejects with a PartHttpError otherwise. */
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
          throw status
            ? new HttpStatusError(
                `Part ${partNumber} of ${partCount} was rejected by storage (HTTP ${status})`,
                status,
              )
            : new NetworkError(
                `Part ${partNumber} of ${partCount} failed after ${failures - 1} retries (network error)`,
              );
        }
        represign = decision.represign;
        await sleep(decision.delayMs);
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
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, queue.length) }, worker));
    if (failure) throw failure;
    if (signal.cancelled || aborted) throw new UploadCancelledError();
    await postJson(`${routeBase}/complete`, { s3Key, uploadId }, "Complete multipart upload");
    clearResumeEntry(storageKey);
    emit(true);
    return s3Key;
  } catch (err) {
    // Only an explicit cancel throws the parts away. Any other failure (a
    // long network outage, a frozen background tab) keeps the S3 upload and
    // the stored session, so choosing the same file again resumes it. Stale
    // sessions expire client-side after 6 days.
    if (err instanceof UploadCancelledError) {
      // Best effort: an orphaned multipart upload keeps its parts in storage.
      await postJson(`${routeBase}/abort`, { s3Key, uploadId }, "Abort multipart upload").catch(() => {});
      clearResumeEntry(storageKey);
    }
    throw err;
  }
}
