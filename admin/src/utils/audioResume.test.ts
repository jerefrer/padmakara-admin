import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./authFetch", () => ({ authFetch: vi.fn() }));
vi.mock("./uploadManager", () => ({ uploadTracks: vi.fn() }));

import { authFetch } from "./authFetch";
import {
  fetchMissingAudio,
  isRedropOfEventFolder,
  isRedropOfPendingUpload,
  matchFilesToMissingTracks,
  pendingEntriesFor,
  reconcileEventAudio,
  uploadTracksWithResumeQueue,
  type MissingAudioTrack,
} from "./audioResume";
import {
  loadPendingAudioUpload,
  remainingEntries,
  savePendingAudioUpload,
  type PendingAudioUpload,
} from "./pendingAudioUpload";
import { uploadTracks, type UploadItem } from "./uploadManager";

const file = (name: string, bytes = 3) => new File(["x".repeat(bytes)], name, { type: "audio/mpeg" });

const track = (
  id: number,
  originalFilename: string | null,
  fileSizeBytes: number | null = null,
): MissingAudioTrack => ({
  id,
  sessionId: 10,
  sessionNumber: 2,
  trackNumber: id,
  title: `Track ${id}`,
  originalFilename,
  fileSizeBytes,
});

const queueOf = (
  entries: { trackId: number; source: string; upload?: string; size: number; uploaded?: boolean }[],
): PendingAudioUpload => ({
  version: 1,
  eventId: 7,
  eventCode: "E7",
  createdAt: "2026-10-22T10:00:00.000Z",
  entries: entries.map((e) => ({
    trackId: e.trackId,
    sessionNumber: 2,
    sourceFilename: e.source,
    uploadFilename: e.upload ?? e.source,
    size: e.size,
    uploaded: e.uploaded,
  })),
});

describe("matchFilesToMissingTracks", () => {
  it("should match only the missing tracks and leave the already uploaded files unused", () => {
    const a = file("001 A.mp3");
    const b = file("002 B.mp3");
    const c = file("003 C.mp3");

    const match = matchFilesToMissingTracks([track(2, "002 B.mp3")], [a, b, c], null);

    expect(match.items).toEqual([
      { trackId: 2, sessionNumber: 2, file: b, filename: "002 B.mp3", mediaType: "audio", title: "Track 2" },
    ]);
    expect(match.unusedFiles).toEqual([a, c]);
    expect(match.unmatchedTracks).toEqual([]);
  });

  it("should find a renamed track's file through the queue and upload it under the edited name", () => {
    const original = file("01 teaching.mp3", 5);
    const queue = queueOf([{ trackId: 4, source: "01 teaching.mp3", upload: "001 Teaching.mp3", size: 5 }]);

    const match = matchFilesToMissingTracks([track(4, "001 Teaching.mp3")], [original], queue);

    expect(match.items).toHaveLength(1);
    expect(match.items[0]!.file).toBe(original);
    expect(match.items[0]!.filename).toBe("001 Teaching.mp3");
  });

  it("should use the size to pick between files with the same name", () => {
    const day1 = file("01.mp3", 3);
    const day2 = file("01.mp3", 7);

    const match = matchFilesToMissingTracks([track(1, "01.mp3", 7)], [day1, day2], null);

    expect(match.items[0]!.file).toBe(day2);
  });

  it("should refuse an ambiguous name when no size tells the files apart", () => {
    const match = matchFilesToMissingTracks([track(1, "01.mp3")], [file("01.mp3", 3), file("01.mp3", 7)], null);

    expect(match.items).toEqual([]);
    expect(match.unmatchedTracks.map((t) => t.id)).toEqual([1]);
  });

  it("should feed each file to at most one track", () => {
    const only = file("01.mp3", 3);

    const match = matchFilesToMissingTracks([track(1, "01.mp3", 3), track(2, "01.mp3", 3)], [only], null);

    expect(match.items.map((i) => i.trackId)).toEqual([1]);
    expect(match.unmatchedTracks.map((t) => t.id)).toEqual([2]);
  });

  it("should report missing tracks whose file was not dropped", () => {
    const match = matchFilesToMissingTracks([track(1, "a.mp3"), track(2, null)], [file("a.mp3")], null);

    expect(match.unmatchedTracks.map((t) => t.id)).toEqual([2]);
  });
});

describe("isRedropOfPendingUpload", () => {
  it("should recognise a folder holding every file still waiting", () => {
    const queue = queueOf([
      { trackId: 1, source: "a.mp3", size: 3, uploaded: true },
      { trackId: 2, source: "b.mp3", size: 3 },
    ]);

    expect(isRedropOfPendingUpload([file("b.mp3"), file("c.pdf")], queue)).toBe(true);
  });

  it("should not recognise a folder missing a waiting file or with a different size", () => {
    const queue = queueOf([{ trackId: 2, source: "b.mp3", size: 3 }]);

    expect(isRedropOfPendingUpload([file("a.mp3")], queue)).toBe(false);
    expect(isRedropOfPendingUpload([file("b.mp3", 9)], queue)).toBe(false);
    expect(isRedropOfPendingUpload([file("b.mp3")], null)).toBe(false);
  });
});

describe("isRedropOfEventFolder", () => {
  it("should treat the event's own folder as a resume", () => {
    const files = [file("001 A.mp3"), file("002 B.mp3")];
    const match = matchFilesToMissingTracks([track(2, "002 B.mp3")], files, null);

    expect(isRedropOfEventFolder(match, new Set(["001 A.mp3", "002 B.mp3"]), null)).toBe(true);
  });

  it("should recognise renamed, already uploaded files through the queue", () => {
    const files = [file("01 a.mp3"), file("002 B.mp3")];
    const queue = queueOf([
      { trackId: 1, source: "01 a.mp3", upload: "001 A.mp3", size: 3, uploaded: true },
      { trackId: 2, source: "002 B.mp3", size: 3 },
    ]);
    const match = matchFilesToMissingTracks([track(2, "002 B.mp3")], files, queue);

    expect(isRedropOfEventFolder(match, new Set(["001 A.mp3", "002 B.mp3"]), queue)).toBe(true);
  });

  it("should treat a folder with unknown files as new sessions", () => {
    const files = [file("002 B.mp3"), file("new talk.mp3")];
    const match = matchFilesToMissingTracks([track(2, "002 B.mp3")], files, null);

    expect(isRedropOfEventFolder(match, new Set(["002 B.mp3"]), null)).toBe(false);
  });

  it("should not resume when nothing matches a missing track", () => {
    const match = matchFilesToMissingTracks([], [file("001 A.mp3")], null);

    expect(isRedropOfEventFolder(match, new Set(["001 A.mp3"]), null)).toBe(false);
  });
});

describe("pendingEntriesFor", () => {
  it("should record audio items with the dropped file's name and skip videos", () => {
    const items: UploadItem[] = [
      { trackId: 3, sessionNumber: 1, file: file("01 raw.mp3", 4), filename: "001 Edited.mp3", mediaType: "audio" },
      { trackId: -1, sessionNumber: 1, file: file("talk.mp4"), filename: "talk.mp4", mediaType: "video" },
    ];

    expect(pendingEntriesFor(items)).toEqual([
      { trackId: 3, sessionNumber: 1, uploadFilename: "001 Edited.mp3", sourceFilename: "01 raw.mp3", size: 4 },
    ]);
  });
});

describe("fetchMissingAudio", () => {
  beforeEach(() => vi.mocked(authFetch).mockReset());

  it("should return the event's keyless tracks", async () => {
    vi.mocked(authFetch).mockResolvedValue(
      new Response(JSON.stringify({ tracks: [track(1, "a.mp3")] }), { status: 200 }),
    );

    await expect(fetchMissingAudio(7)).resolves.toEqual([track(1, "a.mp3")]);
    expect(authFetch).toHaveBeenCalledWith("/api/admin/events/7/missing-audio");
  });

  it("should throw when the check fails", async () => {
    vi.mocked(authFetch).mockResolvedValue(new Response("nope", { status: 500 }));

    await expect(fetchMissingAudio(7)).rejects.toThrow("500");
  });
});

describe("reconcileEventAudio", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    localStorage.clear();
  });

  const respondWith = (tracks: MissingAudioTrack[]) =>
    vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({ tracks }), { status: 200 }));

  it("should clear the resume queue when every track has audio", async () => {
    savePendingAudioUpload(7, "E7", [
      { trackId: 1, sessionNumber: 1, uploadFilename: "a.mp3", sourceFilename: "a.mp3", size: 3 },
    ]);
    respondWith([]);

    const result = await reconcileEventAudio(7);

    expect(result).toEqual({ missing: [], queue: null });
    expect(loadPendingAudioUpload(7)).toBeNull();
  });

  it("should keep only the still-missing tracks in the resume queue", async () => {
    savePendingAudioUpload(7, "E7", [
      { trackId: 1, sessionNumber: 1, uploadFilename: "a.mp3", sourceFilename: "a.mp3", size: 3 },
      { trackId: 2, sessionNumber: 1, uploadFilename: "b.mp3", sourceFilename: "b.mp3", size: 3 },
    ]);
    respondWith([track(2, "b.mp3")]);

    const result = await reconcileEventAudio(7);

    expect(result.missing.map((t) => t.id)).toEqual([2]);
    expect(remainingEntries(result.queue).map((e) => e.trackId)).toEqual([2]);
  });
});

describe("uploadTracksWithResumeQueue", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(uploadTracks).mockReset();
  });

  it("should record the queue before uploading and tick off each finished track", () => {
    const items: UploadItem[] = [
      { trackId: 1, sessionNumber: 1, file: file("a.mp3"), filename: "a.mp3", mediaType: "audio" },
      { trackId: 2, sessionNumber: 1, file: file("b.mp3"), filename: "b.mp3", mediaType: "audio" },
    ];
    let queuedBeforeUpload: number[] = [];
    vi.mocked(uploadTracks).mockImplementation((_items, _code, _onProgress, options) => {
      queuedBeforeUpload = remainingEntries(loadPendingAudioUpload(7)).map((e) => e.trackId);
      options?.onItemUploaded?.(items[0]!);
      return { promise: Promise.resolve(), cancel: () => {} };
    });

    uploadTracksWithResumeQueue(7, "E7", items, () => {});

    expect(queuedBeforeUpload).toEqual([1, 2]);
    expect(remainingEntries(loadPendingAudioUpload(7)).map((e) => e.trackId)).toEqual([2]);
  });
});
