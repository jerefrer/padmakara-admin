import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";
import type { SlideDocument } from "../../../src/lib/slides/types.ts";
import { ANDRE_EVENT, slideLines } from "./slide-fixtures.ts";

// Slides-first flow: a row prepared without a file, its session link, the
// master attached later, and slides copied from another video.

vi.mock("../../../src/db/index.ts", () => {
  const returning = vi.fn();
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const values = vi.fn(() => ({ returning }));
  return {
    db: {
      update: vi.fn(() => ({ set })),
      insert: vi.fn(() => ({ values })),
      query: {
        eventVideos: { findFirst: vi.fn(() => Promise.resolve(null)) },
        events: { findFirst: vi.fn(() => Promise.resolve(null)) },
        sessions: { findFirst: vi.fn(() => Promise.resolve(null)) },
      },
      _set: set,
      _returning: returning,
      _values: values,
    },
  };
});

vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpVersion: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() => Promise.resolve("https://example/x")),
}));
vi.mock("../../../src/services/bunny.ts", () => ({
  fetchVideo: vi.fn(),
  deleteVideo: vi.fn(),
}));
vi.mock("../../../src/services/video-burn.ts", () => ({
  submitVideoBurnJob: vi.fn(() => Promise.resolve({ jobId: "batch-job-1" })),
}));

import { db } from "../../../src/db/index.ts";
import { createAccessToken } from "../../../src/services/auth.ts";
import { submitVideoBurnJob } from "../../../src/services/video-burn.ts";

const dbx = db as unknown as {
  _set: ReturnType<typeof vi.fn>;
  _returning: ReturnType<typeof vi.fn>;
  _values: ReturnType<typeof vi.fn>;
  query: Record<"eventVideos" | "events" | "sessions", { findFirst: ReturnType<typeof vi.fn> }>;
};
const mockSubmit = submitVideoBurnJob as unknown as ReturnType<typeof vi.fn>;

async function post(path: string, payload: unknown, method = "POST") {
  const token = await createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
  return testJson(path, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

function doc(): SlideDocument {
  return {
    version: 1,
    intro: [
      {
        id: "s1",
        role: "title",
        durationMs: 4000,
        fadeMs: 800,
        lines: [{ id: "l1", type: "text", spans: [{ text: "Edited title" }], size: "xl" }],
      },
    ],
    outro: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbx.query.eventVideos.findFirst.mockResolvedValue(null);
  dbx.query.events.findFirst.mockResolvedValue(null);
  dbx.query.sessions.findFirst.mockResolvedValue(null);
});

describe("POST /api/admin/videos/prepare", () => {
  it("should create a row with slides and no file when the video is prepared", async () => {
    dbx._returning.mockResolvedValueOnce([{ id: 40, eventId: 7, slides: doc(), burnStatus: "none" }]);

    const { status } = await post("/api/admin/videos/prepare", {
      eventId: 7,
      position: 0,
      titleEn: "Day 1",
      slides: doc(),
    });

    expect(status).toBe(201);
    expect(dbx._values).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 7, bunnyVideoId: null, burnStatus: "none", slides: doc() }),
    );
    expect(dbx._values.mock.calls[0]![0]).not.toHaveProperty("masterS3Key");
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("should store the session and take the video date from it when no date is given", async () => {
    dbx.query.sessions.findFirst.mockResolvedValueOnce({ id: 3, eventId: 7, sessionDate: "2026-10-12" });
    dbx._returning.mockResolvedValueOnce([{ id: 41, eventId: 7 }]);

    const { status } = await post("/api/admin/videos/prepare", {
      eventId: 7,
      position: 0,
      sessionId: 3,
      slides: doc(),
    });

    expect(status).toBe(201);
    expect(dbx._values).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 3, videoDate: "2026-10-12" }),
    );
  });

  it("should reject a session of another event when preparing", async () => {
    dbx.query.sessions.findFirst.mockResolvedValueOnce({ id: 3, eventId: 99, sessionDate: "2026-10-12" });

    const { status, body } = await post("/api/admin/videos/prepare", {
      eventId: 7,
      position: 0,
      sessionId: 3,
      slides: doc(),
    });

    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_SESSION");
  });
});

describe("POST /api/admin/videos/:id/master", () => {
  it("should queue the burn with the stored slides when the master is attached", async () => {
    dbx.query.eventVideos.findFirst.mockResolvedValueOnce({
      id: 40, eventId: 7, titleEn: "Day 1", slides: doc(), masterS3Key: null, bunnyVideoId: null,
    });

    const { status, body } = await post("/api/admin/videos/40/master", {
      masterS3Key: "events/E7/masters/1-a.mp4",
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ videoId: 40, burnStatus: "queued" });
    expect(mockSubmit).toHaveBeenCalledWith({
      videoId: 40,
      masterS3Key: "events/E7/masters/1-a.mp4",
      slides: doc(),
      title: "Day 1",
    });
    expect(dbx._set).toHaveBeenCalledWith(
      expect.objectContaining({ masterS3Key: "events/E7/masters/1-a.mp4", burnStatus: "pending" }),
    );
  });

  it("should refuse when the video already has a file", async () => {
    dbx.query.eventVideos.findFirst.mockResolvedValueOnce({
      id: 40, eventId: 7, slides: doc(), masterS3Key: "k", bunnyVideoId: null,
    });

    const { status } = await post("/api/admin/videos/40/master", { masterS3Key: "events/E7/masters/1-a.mp4" });

    expect(status).toBe(409);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("should keep the master and answer 502 when the burn cannot be queued", async () => {
    dbx.query.eventVideos.findFirst.mockResolvedValueOnce({
      id: 40, eventId: 7, slides: doc(), masterS3Key: null, bunnyVideoId: null,
    });
    mockSubmit.mockRejectedValueOnce(new Error("batch down"));

    const { status, body } = await post("/api/admin/videos/40/master", { masterS3Key: "events/E7/masters/1-a.mp4" });

    expect(status).toBe(502);
    expect(body.code).toBe("BURN_SUBMIT_FAILED");
    expect(dbx._set).toHaveBeenCalledWith(expect.objectContaining({ burnStatus: "failed" }));
  });
});

describe("PATCH /api/admin/videos/:id with a session", () => {
  it("should date an undated video from its session and expose sessionId", async () => {
    dbx.query.eventVideos.findFirst.mockResolvedValueOnce({ id: 40, eventId: 7, videoDate: null });
    dbx.query.sessions.findFirst.mockResolvedValueOnce({ id: 2, eventId: 7, sessionDate: "2026-10-11" });
    dbx._returning.mockResolvedValueOnce([{ id: 40, eventId: 7, sessionId: 2, videoDate: "2026-10-11" }]);

    const { status, body } = await post("/api/admin/videos/40", { sessionId: 2 }, "PATCH");

    expect(status).toBe(200);
    expect(body.sessionId).toBe(2);
    expect(dbx._set).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 2, videoDate: "2026-10-11" }));
  });

  it("should keep an explicit video date when the session changes", async () => {
    dbx.query.eventVideos.findFirst.mockResolvedValueOnce({ id: 40, eventId: 7, videoDate: "2026-10-10" });
    dbx.query.sessions.findFirst.mockResolvedValueOnce({ id: 2, eventId: 7, sessionDate: "2026-10-11" });
    dbx._returning.mockResolvedValueOnce([{ id: 40, eventId: 7, sessionId: 2 }]);

    await post("/api/admin/videos/40", { sessionId: 2 }, "PATCH");

    expect(dbx._set.mock.calls[0]![0]).not.toHaveProperty("videoDate");
  });
});

describe("slides defaults use the video's session", () => {
  it("should number the session slide from the linked session, not the date", async () => {
    // Two sessions on the same day: the date alone cannot tell them apart.
    const twoOnOneDay = {
      ...ANDRE_EVENT,
      sessions: [
        { id: 1, sessionNumber: 1, sessionDate: "2026-10-10", timePeriod: "morning" },
        { id: 2, sessionNumber: 2, sessionDate: "2026-10-10", timePeriod: "evening" },
      ],
    };
    dbx.query.eventVideos.findFirst.mockResolvedValueOnce({
      id: 40, eventId: 7, videoDate: "2026-10-10", sessionId: 2,
    });
    dbx.query.events.findFirst.mockResolvedValueOnce(twoOnOneDay);

    const { body } = await post("/api/admin/videos/40/slides/defaults", {});

    const session = body.slides.intro.find((s: { role?: string }) => s.role === "session");
    expect(slideLines(session)).toEqual(["Session 2 of 2", "10 October 2026, evening"]);
  });
});

describe("POST /api/admin/videos/:id/slides/copy", () => {
  it("should keep every edit, including the session slide, and flag the session slide for review", async () => {
    const source: SlideDocument = {
      version: 1,
      intro: [
        ...doc().intro,
        {
          id: "s2",
          role: "session",
          durationMs: 4000,
          fadeMs: 800,
          lines: [{ id: "l2", type: "text", spans: [{ text: "Session 1 of 4" }], size: "lg" }],
        },
      ],
      outro: [],
    };
    dbx.query.eventVideos.findFirst
      .mockResolvedValueOnce({ id: 41, eventId: 7, videoDate: null, sessionId: 3 })
      .mockResolvedValueOnce({ id: 40, eventId: 7, slides: source });

    const { status, body } = await post("/api/admin/videos/41/slides/copy", { sourceVideoId: 40 });

    expect(status).toBe(200);
    expect(body.sessionSlide).toBe("flagged");
    expect(slideLines(body.slides.intro[0])).toEqual(["Edited title"]);
    expect(slideLines(body.slides.intro[1])).toEqual(["Session 1 of 4"]);
    expect(body.slides.intro[1].needsReview).toBe(true);
    expect(body.slides.intro[0].needsReview).toBeUndefined();
  });

  it("should refuse a source video from another event", async () => {
    dbx.query.eventVideos.findFirst
      .mockResolvedValueOnce({ id: 41, eventId: 7 })
      .mockResolvedValueOnce({ id: 40, eventId: 8, slides: doc() });

    const { status } = await post("/api/admin/videos/41/slides/copy", { sourceVideoId: 40 });

    expect(status).toBe(404);
  });
});
