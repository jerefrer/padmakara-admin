import { describe, it, expect } from "vitest";
import {
  mediaVisibleTo,
  applyMediaVisibility,
  applyMediaVisibilityToAll,
  assertAudioVisible,
  assertVideoVisible,
} from "../../src/services/media-visibility.ts";
import { AppError } from "../../src/lib/errors.ts";

function makeEvent(flags: { audioPublished?: boolean; videoPublished?: boolean } = {}) {
  return {
    id: 1,
    audioPublished: true,
    videoPublished: true,
    ...flags,
    sessions: [
      { id: 10, tracks: [{ id: 100 }, { id: 101 }] },
      { id: 11, tracks: [{ id: 102 }] },
    ],
    videos: [{ id: 5 }, { id: 6 }],
    transcripts: [{ id: 9 }],
  };
}

describe("mediaVisibleTo", () => {
  it("should show both media when both flags are on", () => {
    expect(mediaVisibleTo(makeEvent(), "user")).toEqual({ audio: true, video: true });
  });

  it("should hide only audio when audioPublished is false for a regular user", () => {
    expect(mediaVisibleTo(makeEvent({ audioPublished: false }), "user")).toEqual({
      audio: false,
      video: true,
    });
  });

  it("should hide only video when videoPublished is false for an anonymous caller", () => {
    expect(mediaVisibleTo(makeEvent({ videoPublished: false }), undefined)).toEqual({
      audio: true,
      video: false,
    });
  });

  it("should show everything to admins and superadmins whatever the flags", () => {
    const hidden = makeEvent({ audioPublished: false, videoPublished: false });
    expect(mediaVisibleTo(hidden, "admin")).toEqual({ audio: true, video: true });
    expect(mediaVisibleTo(hidden, "superadmin")).toEqual({ audio: true, video: true });
  });

  it("should treat missing flags as visible", () => {
    expect(mediaVisibleTo({}, "user")).toEqual({ audio: true, video: true });
  });
});

describe("applyMediaVisibility", () => {
  it("should leave the event untouched when both media are visible", () => {
    const event = makeEvent();
    applyMediaVisibility(event, "user");
    expect(event.sessions).toHaveLength(2);
    expect(event.videos).toHaveLength(2);
  });

  it("should drop tracks and the sessions left empty when audio is hidden", () => {
    const event = makeEvent({ audioPublished: false });
    applyMediaVisibility(event, "user");
    expect(event.sessions).toEqual([]);
    expect(event.videos).toHaveLength(2);
  });

  it("should drop videos when video is hidden, keeping sessions and tracks", () => {
    const event = makeEvent({ videoPublished: false });
    applyMediaVisibility(event, "user");
    expect(event.videos).toEqual([]);
    expect(event.sessions).toHaveLength(2);
  });

  it("should keep transcripts when audio is hidden", () => {
    const event = makeEvent({ audioPublished: false });
    applyMediaVisibility(event, "user");
    expect(event.transcripts).toHaveLength(1);
  });

  it("should not touch anything for an admin", () => {
    const event = makeEvent({ audioPublished: false, videoPublished: false });
    applyMediaVisibility(event, "admin");
    expect(event.sessions).toHaveLength(2);
    expect(event.videos).toHaveLength(2);
  });

  it("should not fail on an event payload without sessions or videos", () => {
    const event = { audioPublished: false, videoPublished: false } as Record<string, unknown>;
    expect(() => applyMediaVisibility(event, "user")).not.toThrow();
  });

  it("should apply to every event of a list", () => {
    const list = [makeEvent({ audioPublished: false }), makeEvent()];
    applyMediaVisibilityToAll(list, "user");
    expect(list[0]!.sessions).toEqual([]);
    expect(list[1]!.sessions).toHaveLength(2);
  });
});

describe("assertAudioVisible / assertVideoVisible", () => {
  it("should throw a 404 for hidden audio and a regular user", () => {
    const run = () => assertAudioVisible(makeEvent({ audioPublished: false }), "user", "Track not found");
    expect(run).toThrow(AppError);
    try {
      run();
    } catch (e) {
      expect((e as AppError).statusCode).toBe(404);
      expect((e as AppError).message).toBe("Track not found");
    }
  });

  it("should not throw for hidden audio and an admin", () => {
    expect(() =>
      assertAudioVisible(makeEvent({ audioPublished: false }), "admin", "Track not found"),
    ).not.toThrow();
  });

  it("should throw a 404 for hidden video and a regular user, not for audio", () => {
    const event = makeEvent({ videoPublished: false });
    expect(() => assertVideoVisible(event, "user", "Video not found")).toThrow(AppError);
    expect(() => assertAudioVisible(event, "user", "Track not found")).not.toThrow();
  });

  it("should accept a missing event (orphan row)", () => {
    expect(() => assertAudioVisible(null, "user", "x")).not.toThrow();
    expect(() => assertVideoVisible(undefined, "user", "x")).not.toThrow();
  });
});
