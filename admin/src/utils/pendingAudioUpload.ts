/**
 * Browser-persisted queue of an event's audio files, so an interrupted bulk
 * upload (tab closed, network gone, Cancel) can be resumed later.
 *
 * File handles cannot survive a reload, so the queue only remembers which
 * track each dropped file feeds and whether it already reached the server.
 * Resuming means asking the admin to drop the same folder again and
 * uploading only the files whose tracks are still keyless.
 *
 * The source filename matters because the admin may rename a track before
 * the upload (rename-before-upload is why the upload is two-phase): the
 * track's `originalFilename` then holds the edited name, while the file on
 * disk keeps its original one. Uploaded entries are kept (flagged) until the
 * whole queue is done so a re-dropped folder can still be recognised file by
 * file.
 *
 * Stored in localStorage (one small JSON entry per event); every access is
 * guarded because storage can be unavailable (private mode, blocked site
 * data). Losing the queue only loses the rename mapping — the server's list
 * of keyless tracks still drives the repair.
 */

export interface PendingAudioEntry {
  trackId: number;
  sessionNumber: number;
  /** Name the file is uploaded under — the track's `originalFilename`. */
  uploadFilename: string;
  /** Name of the file on the admin's disk, as dropped. */
  sourceFilename: string;
  /** Size in bytes, used to tell same-named files apart. */
  size: number;
  /** True once the file is in S3 and the track carries its s3_key. */
  uploaded?: boolean;
}

export interface PendingAudioUpload {
  version: 1;
  eventId: number;
  eventCode: string;
  /** ISO timestamp of when the queue was first written. */
  createdAt: string;
  entries: PendingAudioEntry[];
}

const KEY_PREFIX = "padmakara.pendingAudioUpload.";

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

const keyFor = (eventId: number) => `${KEY_PREFIX}${eventId}`;

function isPendingAudioUpload(value: unknown): value is PendingAudioUpload {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<PendingAudioUpload>;
  return (
    v.version === 1 &&
    typeof v.eventId === "number" &&
    typeof v.eventCode === "string" &&
    Array.isArray(v.entries)
  );
}

/** Entries still waiting for their audio. */
export function remainingEntries(queue: PendingAudioUpload | null): PendingAudioEntry[] {
  return (queue?.entries ?? []).filter((e) => !e.uploaded);
}

/** The event's queue, or null when there is none or nothing is left to upload. */
export function loadPendingAudioUpload(
  eventId: number,
  storage: StorageLike | null = defaultStorage(),
): PendingAudioUpload | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(keyFor(eventId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPendingAudioUpload(parsed) && remainingEntries(parsed).length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function clearPendingAudioUpload(
  eventId: number,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.removeItem(keyFor(eventId));
  } catch {
    // Storage unavailable — nothing to clear.
  }
}

function write(queue: PendingAudioUpload, storage: StorageLike | null): void {
  if (!storage) return;
  try {
    if (remainingEntries(queue).length === 0) storage.removeItem(keyFor(queue.eventId));
    else storage.setItem(keyFor(queue.eventId), JSON.stringify(queue));
  } catch {
    // Quota exceeded or storage blocked: resuming falls back to matching by
    // the tracks' own filenames.
  }
}

/**
 * Record files about to be uploaded for an event. Merges with an existing
 * queue for the same event (a second drop before the first finished), the
 * newest entry winning for a given track.
 */
export function savePendingAudioUpload(
  eventId: number,
  eventCode: string,
  entries: PendingAudioEntry[],
  storage: StorageLike | null = defaultStorage(),
  now: () => Date = () => new Date(),
): void {
  const existing = loadPendingAudioUpload(eventId, storage);
  const byTrack = new Map<number, PendingAudioEntry>();
  for (const e of existing?.entries ?? []) byTrack.set(e.trackId, e);
  for (const e of entries) byTrack.set(e.trackId, { ...e, uploaded: false });
  write(
    {
      version: 1,
      eventId,
      eventCode,
      createdAt: existing?.createdAt ?? now().toISOString(),
      entries: [...byTrack.values()],
    },
    storage,
  );
}

/** Flag one track as done once its audio is on the server. */
export function markPendingAudioUploaded(
  eventId: number,
  trackId: number,
  storage: StorageLike | null = defaultStorage(),
): void {
  const queue = loadPendingAudioUpload(eventId, storage);
  if (!queue) return;
  write(
    {
      ...queue,
      entries: queue.entries.map((e) => (e.trackId === trackId ? { ...e, uploaded: true } : e)),
    },
    storage,
  );
}

/**
 * Align the queue with the server: an entry is still pending only while its
 * track is missing audio (a track uploaded elsewhere, or deleted, is done).
 * Clears the queue when nothing is left. Returns what remains.
 */
export function prunePendingAudioUpload(
  eventId: number,
  missingTrackIds: ReadonlySet<number>,
  storage: StorageLike | null = defaultStorage(),
): PendingAudioUpload | null {
  const queue = loadPendingAudioUpload(eventId, storage);
  if (!queue) return null;
  const pruned = {
    ...queue,
    entries: queue.entries.map((e) =>
      missingTrackIds.has(e.trackId) ? e : { ...e, uploaded: true },
    ),
  };
  write(pruned, storage);
  return remainingEntries(pruned).length > 0 ? pruned : null;
}

/** Every event that has a pending queue in this browser. */
export function listPendingAudioUploads(
  storage: StorageLike | null = defaultStorage(),
): PendingAudioUpload[] {
  if (!storage) return [];
  const out: PendingAudioUpload[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(KEY_PREFIX)) continue;
      const eventId = Number(key.slice(KEY_PREFIX.length));
      const queue = Number.isInteger(eventId) ? loadPendingAudioUpload(eventId, storage) : null;
      if (queue) out.push(queue);
    }
  } catch {
    // Storage unavailable — report nothing.
  }
  return out;
}
