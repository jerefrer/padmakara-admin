import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";
import type { SlideDocument } from "../../../src/lib/slides/types.ts";
import { BUILTIN_LOGO_KEY } from "../../../src/lib/slides/defaults.ts";
import { ANDRE_EVENT, EMPTY_EVENT, slideLines } from "./slide-fixtures.ts";

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
      masterS3Key: null,
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
      hasMaster: false,
    });
  });

  it("returns hasMaster true when a master is retained", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({
      id: 5, eventId: 7, slides: null, hasBurnedSlides: false, burnStatus: "failed",
      burnError: "x", burnedIntroMs: null, masterS3Key: "masters/5.mp4",
    });
    const token = await adminToken();
    const { body } = await testJson("/api/admin/videos/5/slides", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(body.hasMaster).toBe(true);
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

  it("generates André's English intro + builtin-logo outro from full metadata", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 5, eventId: 7, videoDate: "2026-10-10" });
    mockFindFirstEvent.mockResolvedValueOnce(ANDRE_EVENT);

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/5/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body.language).toBe("en");
    expect(body.missing).toEqual([]);
    expect(body.slides.intro.map(slideLines)).toEqual([
      ["", "Padmakara"],
      ["Jigme Khyentse Rinpoche"],
      ["Jigme Khyentse Rinpoche", "", "", "Learning to let go and enjoying space", "", "", ""],
      ["October 2026", "Lisbon, Portugal"],
      ["Session 1 of 4", "10 October 2026, morning"],
      ["Event organized by", "Fundação Kangyur Rinpoche", "", "Video Production", "Padmakara Portugal"],
    ]);
    expect(body.slides.outro).toHaveLength(1);
    expect(body.slides.outro[0].lines[0]).toMatchObject({ type: "image", s3Key: BUILTIN_LOGO_KEY });
  });

  it("generates the Portuguese intro when asked", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 5, eventId: 7, videoDate: "2026-10-10" });
    mockFindFirstEvent.mockResolvedValueOnce(ANDRE_EVENT);

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/5/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ lang: "pt" }),
    });

    expect(status).toBe(200);
    expect(body.language).toBe("pt");
    expect(body.slides.intro.map(slideLines).slice(2)).toEqual([
      ["Jigme Khyentse Rinpoche", "", "", "Aprender a largar e a apreciar o espaço", "", "", ""],
      ["Outubro 2026", "Lisbon, Portugal"],
      ["Sessão 1 de 4", "10 de outubro de 2026, manhã"],
      ["Evento organizado por", "Fundação Kangyur Rinpoche", "", "Produção de vídeo", "Padmakara Portugal"],
    ]);
  });

  it("defaults to Portuguese for an event taught in Portuguese", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 5, eventId: 7, videoDate: "2026-10-10" });
    mockFindFirstEvent.mockResolvedValueOnce({ ...ANDRE_EVENT, originalLanguage: "pt" });

    const token = await adminToken();
    const { body } = await testJson("/api/admin/videos/5/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(body.language).toBe("pt");
  });

  it("uses the video's own date over the event start date, and lists what is missing", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 5, eventId: 7, videoDate: "2017-01-02" });
    mockFindFirstEvent.mockResolvedValueOnce({ ...EMPTY_EVENT, startDate: "2016-06-18" });

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/5/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    // Logo slide, the title slide and the date slide (January 2017, not June 2016).
    expect(body.slides.intro.map(slideLines)).toEqual([
      ["", "Padmakara"],
      ["Retreat"],
      ["January 2017"],
    ]);
    expect(body.missing).toEqual(["teacher", "place", "session", "organizer", "production"]);
  });

  it("omits slides whose backing data is missing, but always keeps the logo slide and the outro", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 6, eventId: 8, videoDate: null });
    mockFindFirstEvent.mockResolvedValueOnce({
      ...EMPTY_EVENT,
      id: 8,
      titleEn: "",
      eventTeachers: [{ teacher: { name: "Jigme Khyentse Rinpoche" } }],
    });

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/6/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body.slides.intro.map(slideLines)).toEqual([["", "Padmakara"], ["Jigme Khyentse Rinpoche"]]);
    expect(body.missing).toEqual(["title", "date", "place", "session", "organizer", "production"]);
    expect(body.slides.outro[0].lines[0].s3Key).toBe(BUILTIN_LOGO_KEY);
  });

  it("leaves the session slide out when two sessions share the video's date", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 5, eventId: 7, videoDate: "2026-10-10" });
    mockFindFirstEvent.mockResolvedValueOnce({
      ...ANDRE_EVENT,
      sessions: [
        { sessionNumber: 1, sessionDate: "2026-10-10", timePeriod: "morning" },
        { sessionNumber: 2, sessionDate: "2026-10-10", timePeriod: "evening" },
      ],
    });

    const token = await adminToken();
    const { body } = await testJson("/api/admin/videos/5/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(body.missing).toEqual(["session"]);
    expect(body.slides.intro).toHaveLength(5);
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

describe("POST /api/admin/videos/:id/reburn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const post = async (id = 5) => {
    const token = await adminToken();
    return testJson(`/api/admin/videos/${id}/reburn`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  };

  it("returns 404 when the video does not exist", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce(null);
    expect((await post(999)).status).toBe(404);
  });

  it("returns 409 when there is no retained master", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 5, eventId: 7, masterS3Key: null, slides: validDoc(), burnStatus: "failed" });
    expect((await post()).status).toBe(409);
    expect(mockSubmitVideoBurnJob).not.toHaveBeenCalled();
  });

  it("returns 409 when the video has no slides", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 5, eventId: 7, masterS3Key: "m.mp4", slides: null, burnStatus: "failed" });
    expect((await post()).status).toBe(409);
    expect(mockSubmitVideoBurnJob).not.toHaveBeenCalled();
  });

  it.each(["queued", "running"])("returns 409 when a burn is already %s", async (burnStatus) => {
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 5, eventId: 7, masterS3Key: "m.mp4", slides: validDoc(), burnStatus });
    expect((await post()).status).toBe(409);
    expect(mockSubmitVideoBurnJob).not.toHaveBeenCalled();
  });

  it("queues the burn and submits the job when the video is eligible", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({
      id: 5, eventId: 7, titleEn: "Teaching", titlePt: null, masterS3Key: "m.mp4", slides: validDoc(), burnStatus: "failed",
    });
    const { status, body } = await post();
    expect(status).toBe(200);
    expect(body).toEqual({ videoId: 5, jobId: "batch-job-1", burnStatus: "queued" });
    expect(mockSubmitVideoBurnJob).toHaveBeenCalledWith(
      expect.objectContaining({ videoId: 5, masterS3Key: "m.mp4", title: "Teaching" }),
    );
  });
});


describe("add slides later (empty slide document through the burn path)", () => {
  const emptyDoc = (): SlideDocument => ({ version: 1, intro: [], outro: [] });

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps queued once-values from earlier suites.
    mockReturning.mockReset();
    mockFindFirstEventVideo.mockReset();
    mockFindFirstEvent.mockResolvedValue({ id: 7, eventCode: "E7" });
    mockFindManyEventVideo.mockResolvedValue([]);
    mockSubmitVideoBurnJob.mockResolvedValue({ jobId: "batch-job-1" });
  });

  it("POST /burn accepts an empty document, retains the master and queues the job", async () => {
    mockReturning.mockResolvedValueOnce([{ id: 40, eventId: 7 }]);
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/burn", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ eventId: 7, masterS3Key: "uploads/m.mp4", slides: emptyDoc(), position: 0, titleEn: "Talk" }),
    });
    expect(status).toBe(201);
    expect(body).toEqual({ videoId: 40, jobId: "batch-job-1", burnStatus: "queued" });
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({ masterS3Key: "uploads/m.mp4", slides: emptyDoc(), burnStatus: "pending" }),
    );
    expect(mockValues.mock.calls[0]![0]).not.toHaveProperty("hasBurnedSlides");
    expect(mockSubmitVideoBurnJob).toHaveBeenCalledWith(
      expect.objectContaining({ videoId: 40, masterS3Key: "uploads/m.mp4", slides: emptyDoc() }),
    );
  });

  it("POST /import-url with an empty document takes the burn container path, not Bunny", async () => {
    mockReturning.mockResolvedValueOnce([{ id: 41, eventId: 7, bunnyVideoId: null, burnStatus: "pending" }]);
    const token = await adminToken();
    const { status } = await testJson("/api/admin/videos/import-url", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ eventId: 7, url: "https://example.com/talk.mp4", slides: emptyDoc() }),
    });
    expect(status).toBe(201);
    expect(mockFetchVideo).not.toHaveBeenCalled();
    expect(mockSubmitVideoBurnJob).toHaveBeenCalledWith(
      expect.objectContaining({ videoId: 41, masterSourceUrl: "https://example.com/talk.mp4", slides: emptyDoc() }),
    );
  });

  it("PUT /:id/slides on a done empty-document burn flips to pending and still reports no burnt-in slides", async () => {
    const doc = validDoc();
    mockFindFirstEventVideo.mockResolvedValueOnce({ id: 5, eventId: 7, burnStatus: "done", slides: emptyDoc() });
    mockReturning.mockResolvedValueOnce([
      {
        id: 5, eventId: 7, slides: doc, hasBurnedSlides: false, burnStatus: "pending",
        burnError: null, burnedIntroMs: 0, masterS3Key: "uploads/m.mp4",
      },
    ]);
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/videos/5/slides", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slides: doc }),
    });
    expect(status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ burnStatus: "pending", slides: doc }));
    expect(body).toMatchObject({ hasBurnedSlides: false, hasMaster: true, burnedIntroMs: 0, burnStatus: "pending" });
  });

  it("POST /:id/reburn accepts a row whose stored document is empty (object, not null)", async () => {
    mockFindFirstEventVideo.mockResolvedValueOnce({
      id: 5, eventId: 7, titleEn: "T", titlePt: null, masterS3Key: "m.mp4", slides: emptyDoc(), burnStatus: "pending",
    });
    const token = await adminToken();
    const { status } = await testJson("/api/admin/videos/5/reburn", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
  });
});
