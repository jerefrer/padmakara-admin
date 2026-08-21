import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";
import type { SlideDocument } from "../../../src/lib/slides/types.ts";
import { BUILTIN_LOGO_KEY } from "../../../src/lib/slides/defaults.ts";

// ─── Mocks (must come before route imports) ──────────────────────────────

vi.mock("../../../src/db/index.ts", () => {
  const mockReturning = vi.fn();
  const mockWhere = vi.fn(() => ({ returning: mockReturning }));
  const mockSet = vi.fn(() => ({ where: mockWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockSet }));
  const mockValues = vi.fn(() => ({ returning: mockReturning }));
  const mockInsert = vi.fn(() => ({ values: mockValues }));
  const mockFindFirstEventVideo = vi.fn(() => Promise.resolve(null));
  const mockFindFirstEvent = vi.fn(() => Promise.resolve(null));
  const mockFindManyEventVideo = vi.fn(() => Promise.resolve([]));
  return {
    db: {
      update: mockUpdate,
      insert: mockInsert,
      query: {
        eventVideos: { findFirst: mockFindFirstEventVideo, findMany: mockFindManyEventVideo },
        events: { findFirst: mockFindFirstEvent },
      },
      _update: mockUpdate,
      _set: mockSet,
      _where: mockWhere,
      _returning: mockReturning,
      _insert: mockInsert,
      _values: mockValues,
      _findFirstEventVideo: mockFindFirstEventVideo,
      _findFirstEvent: mockFindFirstEvent,
      _findManyEventVideo: mockFindManyEventVideo,
    },
  };
});

vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpVersion: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn((key: string) =>
    Promise.resolve(`https://presigned.example/${key}`),
  ),
}));

// Only exercised by the import-url "with slides" / "without slides" tests
// appended at the bottom of this file — GET/PUT/defaults/image-urls above
// never call fetchVideo or submitVideoBurnJob.
vi.mock("../../../src/services/bunny.ts", () => ({
  fetchVideo: vi.fn(() => Promise.resolve({ guid: "fetched-guid" })),
}));

vi.mock("../../../src/services/video-burn.ts", () => ({
  submitVideoBurnJob: vi.fn(() => Promise.resolve({ jobId: "batch-job-1" })),
}));

import { db } from "../../../src/db/index.ts";
import { createAccessToken } from "../../../src/services/auth.ts";
import { generatePresignedDownloadUrl } from "../../../src/services/s3.ts";
import { fetchVideo } from "../../../src/services/bunny.ts";
import { submitVideoBurnJob } from "../../../src/services/video-burn.ts";

const mockReturning = (db as any)._returning as ReturnType<typeof vi.fn>;
const mockSet = (db as any)._set as ReturnType<typeof vi.fn>;
const mockValues = (db as any)._values as ReturnType<typeof vi.fn>;
const mockFindFirstEventVideo = (db as any)._findFirstEventVideo as ReturnType<typeof vi.fn>;
const mockFindFirstEvent = (db as any)._findFirstEvent as ReturnType<typeof vi.fn>;
const mockFindManyEventVideo = (db as any)._findManyEventVideo as ReturnType<typeof vi.fn>;
const mockPresign = generatePresignedDownloadUrl as ReturnType<typeof vi.fn>;
const mockFetchVideo = fetchVideo as ReturnType<typeof vi.fn>;
const mockSubmitVideoBurnJob = submitVideoBurnJob as ReturnType<typeof vi.fn>;

async function adminToken() {
  return createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
}

function textLine(id: string, text: string, size: "sm" | "md" | "lg" | "xl" = "md") {
  return { id, type: "text" as const, spans: [{ text }], size };
}

function validDoc(): SlideDocument {
  return {
    version: 1,
    intro: [
      { id: "s1", durationMs: 4000, fadeMs: 800, lines: [textLine("l1", "Jigme Khyentse Rinpoche", "xl")] },
    ],
    outro: [],
  };
}

describe("GET /api/admin/videos/:id/slides", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null slides for a fresh video", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({
      id: 5,
      eventId: 7,
      slides: null,
      hasBurnedSlides: false,
      burnStatus: "none",
      burnError: null,
      burnedIntroMs: null,
    });

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/5/slides", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body).toEqual({
      slides: null,
      hasBurnedSlides: false,
      burnStatus: "none",
      burnError: null,
      burnedIntroMs: null,
    });
  });

  it("returns 404 when the video does not exist", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce(null);

    const token = await adminToken();
    const { status } = await testJson("/api/admin/videos/999/slides", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(404);
  });
});

describe("PUT /api/admin/videos/:id/slides", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists and round-trips a valid document", async () => {
    const doc = validDoc();
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 5, eventId: 7, burnStatus: "none" });
    mockReturning.mockResolvedValueOnce([
      {
        id: 5,
        eventId: 7,
        slides: doc,
        hasBurnedSlides: false,
        burnStatus: "none",
        burnError: null,
        burnedIntroMs: null,
      },
    ]);

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/5/slides", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slides: doc }),
    });

    expect(status).toBe(200);
    expect(body.slides).toEqual(doc);
    expect(body.burnStatus).toBe("none");
  });

  it("resets burnStatus from 'done' to 'pending' when slides change", async () => {
    const doc = validDoc();
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 5, eventId: 7, burnStatus: "done" });
    mockReturning.mockResolvedValueOnce([
      {
        id: 5,
        eventId: 7,
        slides: doc,
        hasBurnedSlides: true,
        burnStatus: "pending",
        burnError: null,
        burnedIntroMs: 12000,
      },
    ]);

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/5/slides", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slides: doc }),
    });

    expect(status).toBe(200);
    expect(body.burnStatus).toBe("pending");
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ burnStatus: "pending", slides: doc }),
    );
  });

  it("leaves burnStatus untouched when the video was not yet burned", async () => {
    const doc = validDoc();
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 5, eventId: 7, burnStatus: "none" });
    mockReturning.mockResolvedValueOnce([
      { id: 5, eventId: 7, slides: doc, hasBurnedSlides: false, burnStatus: "none", burnError: null, burnedIntroMs: null },
    ]);

    const token = await adminToken();
    await testJson("/api/admin/videos/5/slides", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slides: doc }),
    });

    const setArg = mockSet.mock.calls[0]?.[0];
    expect(setArg.burnStatus).toBeUndefined();
  });

  it("returns 404 when the video does not exist", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce(null);

    const token = await adminToken();
    const { status } = await testJson("/api/admin/videos/999/slides", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slides: validDoc() }),
    });

    expect(status).toBe(404);
  });

  it("rejects an invalid line size enum", async () => {
    const doc = validDoc();
    (doc.intro[0]!.lines[0] as any).size = "huge";

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/5/slides", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slides: doc }),
    });

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(mockFindFirstEventVideo).not.toHaveBeenCalled();
  });

  it("rejects a sequence with more than 20 slides", async () => {
    const doc = validDoc();
    doc.intro = Array.from({ length: 21 }, (_, i) => ({
      id: `s${i}`,
      durationMs: 4000,
      fadeMs: 800,
      lines: [textLine(`l${i}`, "x")],
    }));

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/5/slides", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slides: doc }),
    });

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a span with text over 300 characters", async () => {
    const doc = validDoc();
    (doc.intro[0]!.lines[0] as any).spans = [{ text: "x".repeat(301) }];

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/5/slides", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slides: doc }),
    });

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/admin/videos/:id/slides/defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generates the expected 5-slide intro + builtin-logo outro from full metadata", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 5, eventId: 7, videoDate: null });
    mockFindFirstEvent.mockResolvedValueOnce({
      id: 7,
      startDate: "2016-06-18",
      organizer: "Padmakara Portugal",
      creditLines: ["Filmagem, arquivo e edição"],
      copyrightHolder: "Padmakara",
      eventType: { nameEn: "Teachings", namePt: "Ensinamentos" },
      eventTeachers: [{ teacher: { name: "Jigme Khyentse Rinpoche" } }],
      eventPlaces: [{ place: { name: "CCA", location: "Loulé, Portugal" } }],
    });

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/5/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body.slides.intro).toHaveLength(5);
    expect(body.slides.intro[0].lines[0].spans[0].text).toBe("Jigme Khyentse Rinpoche");
    expect(body.slides.outro).toHaveLength(1);
    expect(body.slides.outro[0].lines).toHaveLength(1);
    expect(body.slides.outro[0].lines[0]).toMatchObject({
      type: "image",
      s3Key: BUILTIN_LOGO_KEY,
    });
  });

  it("uses the video's own date over the event start date", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 5, eventId: 7, videoDate: "2017-01-02" });
    mockFindFirstEvent.mockResolvedValueOnce({
      id: 7,
      startDate: "2016-06-18",
      organizer: null,
      creditLines: [],
      copyrightHolder: null,
      eventType: null,
      eventTeachers: [],
      eventPlaces: [],
    });

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/5/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    // Only the date slide can exist here (no teacher/type/organizer/credits).
    expect(body.slides.intro).toHaveLength(1);
    expect(body.slides.intro[0].lines[0].spans[0].text).toBe("2 January 2017");
  });

  it("omits slides whose backing data is missing, but always keeps the builtin outro", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 6, eventId: 8, videoDate: null });
    mockFindFirstEvent.mockResolvedValueOnce({
      id: 8,
      startDate: null,
      organizer: null,
      creditLines: [],
      copyrightHolder: null,
      eventType: null,
      eventTeachers: [{ teacher: { name: "Jigme Khyentse Rinpoche" } }],
      eventPlaces: [],
    });

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/6/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    // Only the teacher slide survives: no event type, no date, no
    // organizer/place, no credits/copyright.
    expect(body.slides.intro).toHaveLength(1);
    expect(body.slides.intro[0].lines[0].spans[0].text).toBe("Jigme Khyentse Rinpoche");
    expect(body.slides.outro).toHaveLength(1);
    expect(body.slides.outro[0].lines[0].s3Key).toBe(BUILTIN_LOGO_KEY);
  });

  it("returns 404 when the video does not exist", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce(null);

    const token = await adminToken();
    const { status } = await testJson("/api/admin/videos/999/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${await adminToken()}` },
    });

    expect(status).toBe(404);
  });

  it("returns 404 when the parent event does not exist", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 5, eventId: 7, videoDate: null });
    mockFindFirstEvent.mockResolvedValueOnce(null);

    const token = await adminToken();
    const { status } = await testJson("/api/admin/videos/5/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(404);
  });
});

describe("POST /api/admin/videos/:id/slides/image-urls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function imageLine(id: string, s3Key: string) {
    return { id, type: "image" as const, s3Key, alt: "" };
  }

  function docWithImages(): SlideDocument {
    return {
      version: 1,
      intro: [
        { id: "s1", durationMs: 4000, fadeMs: 800, lines: [imageLine("l1", "events/E1/slides/photo.png")] },
      ],
      outro: [
        { id: "s2", durationMs: 4000, fadeMs: 800, lines: [imageLine("l2", BUILTIN_LOGO_KEY)] },
      ],
    };
  }

  it("returns presigned URLs for keys present in the video's own document", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 5, eventId: 7, slides: docWithImages() });

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/5/slides/image-urls", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ s3Keys: ["events/E1/slides/photo.png"] }),
    });

    expect(status).toBe(200);
    expect(body.urls).toEqual({
      "events/E1/slides/photo.png": "https://presigned.example/events/E1/slides/photo.png",
    });
    expect(mockPresign).toHaveBeenCalledTimes(1);
    expect(mockPresign).toHaveBeenCalledWith("events/E1/slides/photo.png");
  });

  it("omits a key that is not in the document — the security property", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 5, eventId: 7, slides: docWithImages() });

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/5/slides/image-urls", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        s3Keys: ["events/E1/slides/photo.png", "some/other/bucket/secret.png"],
      }),
    });

    expect(status).toBe(200);
    // Only the key that's actually in the document comes back...
    expect(body.urls).toEqual({
      "events/E1/slides/photo.png": "https://presigned.example/events/E1/slides/photo.png",
    });
    // ...the caller-supplied key that isn't in the document is silently
    // dropped, not errored, and is never handed to the presigner.
    expect(body.urls["some/other/bucket/secret.png"]).toBeUndefined();
    expect(mockPresign).not.toHaveBeenCalledWith("some/other/bucket/secret.png");
  });

  it("skips builtin keys even though they appear in the document", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 5, eventId: 7, slides: docWithImages() });

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/5/slides/image-urls", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ s3Keys: [BUILTIN_LOGO_KEY] }),
    });

    expect(status).toBe(200);
    expect(body.urls).toEqual({});
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it("rejects a request with more than 40 keys", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/5/slides/image-urls", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ s3Keys: Array.from({ length: 41 }, (_, i) => `key-${i}`) }),
    });

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(mockFindFirstEventVideo).not.toHaveBeenCalled();
  });

  it("returns 404 when the video does not exist", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce(null);

    const token = await adminToken();
    const { status } = await testJson("/api/admin/videos/999/slides/image-urls", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ s3Keys: [] }),
    });

    expect(status).toBe(404);
  });
});

describe("POST /api/admin/videos/import-url", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirstEvent.mockResolvedValue({ id: 7, eventCode: "E7" });
    mockFindManyEventVideo.mockResolvedValue([]);
    mockFetchVideo.mockResolvedValue({ guid: "fetched-guid" });
    mockSubmitVideoBurnJob.mockResolvedValue({ jobId: "batch-job-1" });
  });

  it("without slides: imports straight to Bunny, unchanged from before burn-in existed", async () => {
    mockReturning.mockResolvedValueOnce([
      { id: 30, eventId: 7, bunnyVideoId: "fetched-guid", position: 0, titleEn: "dharma talk" },
    ]);

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/import-url", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ eventId: 7, url: "https://example.com/videos/dharma%20talk.mp4" }),
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({ id: 30, bunnyVideoId: "fetched-guid" });
    expect(mockFetchVideo).toHaveBeenCalledWith(
      "https://example.com/videos/dharma%20talk.mp4",
      "dharma talk",
    );
    expect(mockSubmitVideoBurnJob).not.toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 7, bunnyVideoId: "fetched-guid", position: 0 }),
    );
  });

  it("with slides: creates a pending-burn row and submits a burn job with masterSourceUrl instead of calling Bunny directly", async () => {
    const doc = validDoc();
    mockReturning.mockResolvedValueOnce([
      {
        id: 31,
        eventId: 7,
        bunnyVideoId: null,
        position: 0,
        titleEn: "dharma talk",
        slides: doc,
        burnStatus: "pending",
      },
    ]);

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/import-url", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        eventId: 7,
        url: "https://example.com/videos/dharma%20talk.mp4",
        slides: doc,
      }),
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({ id: 31, bunnyVideoId: null, burnStatus: "pending" });

    // No direct-to-Bunny fetch — the burn container downloads the source
    // URL itself (MASTER_SOURCE_URL).
    expect(mockFetchVideo).not.toHaveBeenCalled();

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 7,
        bunnyVideoId: null,
        slides: doc,
        burnStatus: "pending",
      }),
    );

    expect(mockSubmitVideoBurnJob).toHaveBeenCalledWith(
      expect.objectContaining({
        videoId: 31,
        masterSourceUrl: "https://example.com/videos/dharma%20talk.mp4",
        slides: doc,
      }),
    );
  });

  it("with slides: presigns a URL pointing at the app's own private S3 bucket before handing it to the burn job", async () => {
    const doc = validDoc();
    mockPresign.mockResolvedValue("https://presigned.example/signed-url");
    mockReturning.mockResolvedValueOnce([
      { id: 32, eventId: 7, bunnyVideoId: null, position: 0, titleEn: "video", slides: doc, burnStatus: "pending" },
    ]);

    const token = await adminToken();
    const { status } = await testJson("/api/admin/videos/import-url", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        eventId: 7,
        url: "https://padmakara-pt-app.s3.eu-west-3.amazonaws.com/Videos_for_app_testing/2025-04-JKR-CCA/2025-04-14-JKR-Mind_Training-Morning-CCA.mp4",
        slides: doc,
      }),
    });

    expect(status).toBe(201);
    expect(mockPresign).toHaveBeenCalledWith(
      "Videos_for_app_testing/2025-04-JKR-CCA/2025-04-14-JKR-Mind_Training-Morning-CCA.mp4",
      12 * 3600,
    );
    expect(mockSubmitVideoBurnJob).toHaveBeenCalledWith(
      expect.objectContaining({ masterSourceUrl: "https://presigned.example/signed-url" }),
    );
  });

  it("with slides: keeps the row and returns 502 when the burn job fails to queue", async () => {
    const doc = validDoc();
    mockReturning
      .mockResolvedValueOnce([
        { id: 33, eventId: 7, bunnyVideoId: null, position: 0, titleEn: null, slides: doc, burnStatus: "pending" },
      ])
      .mockResolvedValueOnce([
        { id: 33, eventId: 7, bunnyVideoId: null, burnStatus: "failed", burnError: "Batch unavailable" },
      ]);
    mockSubmitVideoBurnJob.mockRejectedValueOnce(new Error("Batch unavailable"));

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/import-url", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ eventId: 7, url: "https://example.com/v.mp4", slides: doc }),
    });

    expect(status).toBe(502);
    expect(body.code).toBe("BURN_SUBMIT_FAILED");
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ burnStatus: "failed", burnError: "Batch unavailable" }),
    );
  });

  it("returns 404 when the event does not exist, before touching Bunny or the burn job", async () => {
    mockFindFirstEvent.mockResolvedValue(null);

    const token = await adminToken();
    const { status } = await testJson("/api/admin/videos/import-url", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ eventId: 99, url: "https://example.com/v.mp4", slides: validDoc() }),
    });

    expect(status).toBe(404);
    expect(mockFetchVideo).not.toHaveBeenCalled();
    expect(mockSubmitVideoBurnJob).not.toHaveBeenCalled();
  });

  it("rejects a malformed slide document with a validation error", async () => {
    const doc = validDoc();
    (doc.intro[0]!.lines[0] as any).size = "huge";

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/import-url", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ eventId: 7, url: "https://example.com/v.mp4", slides: doc }),
    });

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(mockFetchVideo).not.toHaveBeenCalled();
    expect(mockSubmitVideoBurnJob).not.toHaveBeenCalled();
  });
});
