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

// ─── Section visibility: transcripts, texts, topics ──────────────────────

import {
  contentVisibleTo,
  applyContentVisibility,
  applyTrackReadAlongVisibility,
  assertTranscriptsVisible,
  assertTextsVisible,
} from "../../src/services/media-visibility.ts";

function makeFullEvent(flags: Record<string, boolean> = {}) {
  return {
    id: 1,
    ...flags,
    mainThemesEn: "Main EN",
    mainThemesPt: "Main PT",
    sessionThemesEn: "Session EN",
    sessionThemesPt: "Session PT",
    sessions: [{ id: 10, tracks: [{ id: 100, readAlongS3Key: "k.json", hasReadAlong: true }] }],
    videos: [{ id: 5 }],
    transcripts: [{ id: 9 }],
    eventFiles: [{ id: 7 }],
    eventPublications: [{ publication: { id: 3 } }],
    relatedPublications: [{ id: 3 }],
  };
}

describe("contentVisibleTo", () => {
  it("should show every section when no flag is false", () => {
    expect(contentVisibleTo({}, "user")).toEqual({
      audio: true, video: true, transcripts: true, texts: true, topics: true,
    });
  });

  it("should hide only the sections whose flag is false for a regular user", () => {
    expect(
      contentVisibleTo({ transcriptsPublished: false, topicsPublished: false }, undefined),
    ).toEqual({ audio: true, video: true, transcripts: false, texts: true, topics: false });
  });

  it("should show everything to admins whatever the flags", () => {
    const hidden = {
      audioPublished: false, videoPublished: false, transcriptsPublished: false,
      textsPublished: false, topicsPublished: false,
    };
    expect(Object.values(contentVisibleTo(hidden, "admin")).every(Boolean)).toBe(true);
    expect(Object.values(contentVisibleTo(hidden, "superadmin")).every(Boolean)).toBe(true);
  });
});

describe("applyContentVisibility", () => {
  it("should leave transcripts and read-along out when transcripts are hidden", () => {
    const event = makeFullEvent({ transcriptsPublished: false });
    applyContentVisibility(event, "user");
    expect(event.transcripts).toEqual([]);
    expect(event.sessions[0]!.tracks[0]!.readAlongS3Key).toBeUndefined();
    expect(event.sessions[0]!.tracks[0]!.hasReadAlong).toBe(false);
    expect(event.eventFiles).toHaveLength(1);
    expect(event.mainThemesEn).toBe("Main EN");
  });

  it("should leave files and linked publications out when texts are hidden", () => {
    const event = makeFullEvent({ textsPublished: false });
    applyContentVisibility(event, "user");
    expect(event.eventFiles).toEqual([]);
    expect(event.eventPublications).toEqual([]);
    expect(event.relatedPublications).toEqual([]);
    expect(event.transcripts).toHaveLength(1);
  });

  it("should null the four theme fields when topics are hidden", () => {
    const event = makeFullEvent({ topicsPublished: false });
    applyContentVisibility(event, "user");
    expect(event.mainThemesEn).toBeNull();
    expect(event.mainThemesPt).toBeNull();
    expect(event.sessionThemesEn).toBeNull();
    expect(event.sessionThemesPt).toBeNull();
    expect(event.sessions).toHaveLength(1);
  });

  it("should still strip audio and video like before", () => {
    const event = makeFullEvent({ audioPublished: false, videoPublished: false });
    applyContentVisibility(event, "user");
    expect(event.sessions).toEqual([]);
    expect(event.videos).toEqual([]);
  });

  it("should not touch anything for an admin", () => {
    const event = makeFullEvent({
      transcriptsPublished: false, textsPublished: false, topicsPublished: false,
    });
    applyContentVisibility(event, "admin");
    expect(event.transcripts).toHaveLength(1);
    expect(event.eventFiles).toHaveLength(1);
    expect(event.mainThemesEn).toBe("Main EN");
    expect(event.sessions[0]!.tracks[0]!.readAlongS3Key).toBe("k.json");
  });

  it("should not fail on a payload without the sections", () => {
    expect(() =>
      applyContentVisibility({ transcriptsPublished: false, textsPublished: false }, "user"),
    ).not.toThrow();
  });
});

describe("applyTrackReadAlongVisibility", () => {
  it("should clear the read-along of a track when the event's transcripts are hidden", () => {
    const track = { id: 1, readAlongS3Key: "k.json", hasReadAlong: true };
    applyTrackReadAlongVisibility(track, { transcriptsPublished: false }, "user");
    expect(track.readAlongS3Key).toBeUndefined();
    expect(track.hasReadAlong).toBe(false);
  });

  it("should keep the read-along for an admin", () => {
    const track = { id: 1, readAlongS3Key: "k.json" };
    applyTrackReadAlongVisibility(track, { transcriptsPublished: false }, "admin");
    expect(track.readAlongS3Key).toBe("k.json");
  });
});

describe("assertTranscriptsVisible / assertTextsVisible", () => {
  it("should throw a 404 for hidden transcripts and a regular user", () => {
    expect(() =>
      assertTranscriptsVisible({ transcriptsPublished: false }, "user", "Transcript not found"),
    ).toThrow(AppError);
    expect(() =>
      assertTranscriptsVisible({ transcriptsPublished: false }, "admin", "x"),
    ).not.toThrow();
  });

  it("should throw a 404 for hidden texts and a regular user", () => {
    expect(() => assertTextsVisible({ textsPublished: false }, "user", "File not found")).toThrow(AppError);
    expect(() => assertTextsVisible({ textsPublished: false }, "superadmin", "x")).not.toThrow();
    expect(() => assertTextsVisible(null, "user", "x")).not.toThrow();
  });
});
