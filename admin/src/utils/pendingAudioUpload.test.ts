import { describe, it, expect, beforeEach } from "vitest";
import {
  clearPendingAudioUpload,
  listPendingAudioUploads,
  loadPendingAudioUpload,
  markPendingAudioUploaded,
  prunePendingAudioUpload,
  remainingEntries,
  savePendingAudioUpload,
  type PendingAudioEntry,
  type StorageLike,
} from "./pendingAudioUpload";

const entry = (trackId: number, name: string, size = 100): PendingAudioEntry => ({
  trackId,
  sessionNumber: 1,
  uploadFilename: name,
  sourceFilename: name,
  size,
});

const fixedNow = () => new Date("2026-10-22T10:00:00Z");

describe("pendingAudioUpload", () => {
  beforeEach(() => localStorage.clear());

  it("should return null when the event has no queue", () => {
    expect(loadPendingAudioUpload(1)).toBeNull();
  });

  it("should persist a queue per event and read it back", () => {
    savePendingAudioUpload(7, "E7", [entry(1, "a.mp3"), entry(2, "b.mp3")], localStorage, fixedNow);

    const queue = loadPendingAudioUpload(7);

    expect(queue).toMatchObject({ eventId: 7, eventCode: "E7", createdAt: "2026-10-22T10:00:00.000Z" });
    expect(queue!.entries.map((e) => e.trackId)).toEqual([1, 2]);
    expect(loadPendingAudioUpload(8)).toBeNull();
  });

  it("should merge a second save into the existing queue", () => {
    savePendingAudioUpload(7, "E7", [entry(1, "a.mp3")]);
    savePendingAudioUpload(7, "E7", [entry(1, "a2.mp3"), entry(2, "b.mp3")]);

    const queue = loadPendingAudioUpload(7)!;

    expect(queue.entries.map((e) => [e.trackId, e.sourceFilename])).toEqual([
      [1, "a2.mp3"],
      [2, "b.mp3"],
    ]);
  });

  it("should flag uploaded tracks but keep them for folder recognition", () => {
    savePendingAudioUpload(7, "E7", [entry(1, "a.mp3"), entry(2, "b.mp3")]);

    markPendingAudioUploaded(7, 1);
    const queue = loadPendingAudioUpload(7)!;

    expect(queue.entries).toHaveLength(2);
    expect(remainingEntries(queue).map((e) => e.trackId)).toEqual([2]);
  });

  it("should clear the queue once every track is uploaded", () => {
    savePendingAudioUpload(7, "E7", [entry(1, "a.mp3")]);

    markPendingAudioUploaded(7, 1);

    expect(loadPendingAudioUpload(7)).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("should prune entries whose tracks the server no longer reports missing", () => {
    savePendingAudioUpload(7, "E7", [entry(1, "a.mp3"), entry(2, "b.mp3"), entry(3, "c.mp3")]);

    const remaining = prunePendingAudioUpload(7, new Set([3]));

    expect(remainingEntries(remaining).map((e) => e.trackId)).toEqual([3]);
  });

  it("should clear the queue when pruning leaves nothing", () => {
    savePendingAudioUpload(7, "E7", [entry(1, "a.mp3")]);

    expect(prunePendingAudioUpload(7, new Set())).toBeNull();
    expect(loadPendingAudioUpload(7)).toBeNull();
  });

  it("should list every event's queue and ignore unrelated keys", () => {
    localStorage.setItem("accessToken", "x");
    savePendingAudioUpload(7, "E7", [entry(1, "a.mp3")]);
    savePendingAudioUpload(9, "E9", [entry(4, "d.mp3")]);

    const ids = listPendingAudioUploads().map((q) => q.eventId).sort();

    expect(ids).toEqual([7, 9]);
  });

  it("should ignore corrupted stored data", () => {
    localStorage.setItem("padmakara.pendingAudioUpload.7", "{not json");

    expect(loadPendingAudioUpload(7)).toBeNull();
  });

  it("should remove a queue on demand", () => {
    savePendingAudioUpload(7, "E7", [entry(1, "a.mp3")]);

    clearPendingAudioUpload(7);

    expect(loadPendingAudioUpload(7)).toBeNull();
  });

  it("should not throw when storage is unavailable", () => {
    const broken: StorageLike = {
      length: 0,
      key: () => null,
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };

    expect(() => savePendingAudioUpload(7, "E7", [entry(1, "a.mp3")], broken)).not.toThrow();
    expect(loadPendingAudioUpload(7, broken)).toBeNull();
    expect(() => markPendingAudioUploaded(7, 1, broken)).not.toThrow();
    expect(() => clearPendingAudioUpload(7, broken)).not.toThrow();
    expect(loadPendingAudioUpload(7, null)).toBeNull();
  });
});
