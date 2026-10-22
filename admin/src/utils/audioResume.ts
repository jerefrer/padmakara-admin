/**
 * Reconciliation and resume helpers for the two-phase bulk audio upload.
 *
 * Phase 1 creates every track row (no s3_key) so the admin can rename before
 * anything is uploaded; phase 2 uploads the audio one file at a time and
 * backfills s3_key. When phase 2 stops early, the server's list of keyless
 * tracks is the source of truth for what is left; these helpers fetch it and
 * match re-dropped files to it so only the missing ones are uploaded.
 */
import { authFetch } from "./authFetch";
import {
  uploadTracks,
  type ProgressCallback,
  type UploadItem,
  type UploadTracksOptions,
} from "./uploadManager";
import {
  clearPendingAudioUpload,
  markPendingAudioUploaded,
  prunePendingAudioUpload,
  remainingEntries,
  savePendingAudioUpload,
  type PendingAudioEntry,
  type PendingAudioUpload,
} from "./pendingAudioUpload";

export interface MissingAudioTrack {
  id: number;
  sessionId: number;
  sessionNumber: number;
  trackNumber: number;
  title: string;
  originalFilename: string | null;
  /** Size of the file dropped when the row was created, when known. */
  fileSizeBytes: number | null;
}

/** Tracks of an event that still have no audio, in session/track order. */
export async function fetchMissingAudio(eventId: number): Promise<MissingAudioTrack[]> {
  const res = await authFetch(`/api/admin/events/${eventId}/missing-audio`);
  if (!res.ok) throw new Error(`Could not check the event's audio (${res.status})`);
  const json = (await res.json()) as { tracks?: MissingAudioTrack[] };
  return json.tracks ?? [];
}

export interface AudioReconciliation {
  /** Tracks still without audio, per the server. */
  missing: MissingAudioTrack[];
  /** What is left of this browser's resume queue (null when none). */
  queue: PendingAudioUpload | null;
}

/**
 * Compare the event's tracks with what was meant to be uploaded: fetch the
 * keyless tracks and align the persisted queue with them (clearing it when
 * the event is complete). Call it whenever an upload ends, however it ended.
 */
export async function reconcileEventAudio(eventId: number): Promise<AudioReconciliation> {
  const missing = await fetchMissingAudio(eventId);
  if (missing.length === 0) {
    clearPendingAudioUpload(eventId);
    return { missing, queue: null };
  }
  const queue = prunePendingAudioUpload(eventId, new Set(missing.map((t) => t.id)));
  return { missing, queue };
}

/**
 * `uploadTracks`, with the audio items recorded in the event's resume queue
 * first and ticked off as each one reaches the server — so closing the tab
 * mid-way still leaves a precise record of what is left.
 */
export function uploadTracksWithResumeQueue(
  eventId: number,
  eventCode: string,
  items: UploadItem[],
  onProgress: ProgressCallback,
  options: UploadTracksOptions = {},
): { promise: Promise<void>; cancel: () => void } {
  savePendingAudioUpload(eventId, eventCode, pendingEntriesFor(items));
  return uploadTracks(items, eventCode, onProgress, {
    ...options,
    onItemUploaded: (item) => {
      markPendingAudioUploaded(eventId, item.trackId);
      options.onItemUploaded?.(item);
    },
  });
}

/** Queue entries for the audio items of an upload that is about to start. */
export function pendingEntriesFor(items: UploadItem[]): PendingAudioEntry[] {
  return items
    .filter((i) => i.mediaType !== "video" && i.trackId > 0)
    .map((i) => ({
      trackId: i.trackId,
      sessionNumber: i.sessionNumber,
      uploadFilename: i.filename,
      sourceFilename: i.file.name,
      size: i.file.size,
    }));
}

export interface ResumeMatch {
  /** One upload item per missing track that found its file. */
  items: UploadItem[];
  /** Missing tracks no dropped file could be matched to. */
  unmatchedTracks: MissingAudioTrack[];
  /** Dropped files that fed no missing track (already uploaded, or unrelated). */
  unusedFiles: File[];
}

/**
 * Match dropped files to the tracks that still lack audio.
 *
 * For each missing track, candidate names are, in order: the source filename
 * recorded in the pending queue (covers tracks renamed before upload), then
 * the track's own `originalFilename`. Among files with that name, one with
 * the recorded size (queue entry, else the track's `fileSizeBytes`) wins;
 * otherwise a name is only trusted when it is unambiguous (a folder can hold
 * several "01.mp3" in different sub-folders).
 * A file feeds at most one track. Items are uploaded under the track's
 * `originalFilename` so the S3 key is the one the first upload would have used.
 */
export function matchFilesToMissingTracks(
  missing: MissingAudioTrack[],
  files: File[],
  queue: PendingAudioUpload | null,
): ResumeMatch {
  const byName = new Map<string, File[]>();
  for (const f of files) {
    const list = byName.get(f.name) ?? [];
    list.push(f);
    byName.set(f.name, list);
  }
  const queued = new Map((queue?.entries ?? []).map((e) => [e.trackId, e] as const));
  const used = new Set<File>();

  const pick = (name: string | null | undefined, size: number | undefined): File | undefined => {
    if (!name) return undefined;
    const candidates = (byName.get(name) ?? []).filter((f) => !used.has(f));
    if (size !== undefined) {
      const sized = candidates.find((f) => f.size === size);
      if (sized) return sized;
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  };

  const items: UploadItem[] = [];
  const unmatchedTracks: MissingAudioTrack[] = [];
  for (const track of missing) {
    const entry = queued.get(track.id);
    const size = entry?.size ?? track.fileSizeBytes ?? undefined;
    const file = pick(entry?.sourceFilename, size) ?? pick(track.originalFilename, size);
    if (!file) {
      unmatchedTracks.push(track);
      continue;
    }
    used.add(file);
    items.push({
      trackId: track.id,
      sessionNumber: track.sessionNumber,
      file,
      filename: track.originalFilename || entry?.uploadFilename || file.name,
      mediaType: "audio",
      title: track.title,
    });
  }

  return { items, unmatchedTracks, unusedFiles: files.filter((f) => !used.has(f)) };
}

/**
 * Whether a set of dropped files is the folder of an interrupted upload:
 * every file the queue still waits for is present (by name and size). Lets
 * the create page recognise the folder of an event that already exists.
 */
export function isRedropOfPendingUpload(files: File[], queue: PendingAudioUpload | null): boolean {
  const remaining = remainingEntries(queue);
  if (remaining.length === 0) return false;
  const present = new Set(files.map((f) => `${f.name}\u0000${f.size}`));
  return remaining.every((e) => present.has(`${e.sourceFilename}\u0000${e.size}`));
}

/**
 * Whether a folder dropped on an existing event is that event's own folder
 * dropped again, rather than new sessions: it feeds at least one missing
 * track, and every other file is already known to the event (a track's
 * filename, or a file recorded in the pending queue). Such a drop resumes the
 * upload instead of creating the sessions a second time.
 */
export function isRedropOfEventFolder(
  match: ResumeMatch,
  eventFilenames: ReadonlySet<string>,
  queue: PendingAudioUpload | null,
): boolean {
  if (match.items.length === 0) return false;
  const queuedNames = new Set((queue?.entries ?? []).map((e) => e.sourceFilename));
  return match.unusedFiles.every((f) => eventFilenames.has(f.name) || queuedNames.has(f.name));
}
