/**
 * Tests for POST /api/admin/events/:id/rename-tracks
 *
 * The event-scoped variant requires an existing event ID in the URL, but
 * the route itself does not look up the event in the database — it validates
 * the body and calls Anthropic. The DB mock only needs to satisfy the auth
 * middleware's user lookup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testJson } from "../../helpers.ts";

// ─── Mocks (must come before any imports that trigger route registration) ─────

vi.mock("../../../src/db/index.ts", () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
      teachers: {
        findMany: vi.fn(() =>
          Promise.resolve([
            { abbreviation: "PWR", name: "Pema Wangyal Rinpoche" },
            { abbreviation: "JKR", name: "Jigme Khyentse Rinpoche" },
          ]),
        ),
      },
    },
    select: vi.fn(),
  },
}));

vi.mock("../../../src/services/s3.ts", () => ({
  generatePresignedUploadUrl: vi.fn(),
  buildTrackS3Key: vi.fn(),
  buildTranscriptS3Key: vi.fn(),
}));

const mockMessagesCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: mockMessagesCreate };
  }
  return { default: MockAnthropic };
});

import { db } from "../../../src/db/index.ts";
import { createAccessToken } from "../../../src/services/auth.ts";

const mockTeachersFindMany = (db as any).query.teachers.findMany as ReturnType<
  typeof vi.fn
>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function adminToken() {
  return createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
}

function makeAnthropicResponse(jsonText: string) {
  return { content: [{ type: "text", text: jsonText }] };
}

const VALID_TRACKS = [
  {
    rowKey: "1-1",
    originalFilename: "001 JKR - Opening teachings.mp3",
    title: "001 JKR - Opening teachings",
    speaker: "JKR",
  },
  {
    rowKey: "1-2",
    originalFilename: "002 KPS - Prayers.mp3",
    title: "002 KPS - Prayers",
    speaker: null,
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/admin/events/:id/rename-tracks", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV, ANTHROPIC_API_KEY: "test-key-123" };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("returns AI track suggestions for a valid request", async () => {
    const trackSuggestions = [
      { rowKey: "1-1", titleEn: "Opening Teachings" },
      { rowKey: "1-2", titleEn: "Prayers", speaker: "KPS" },
    ];
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(JSON.stringify({ tracks: trackSuggestions })),
    );

    const token = await adminToken();
    const { status, body } = await testJson(
      "/api/admin/events/42/rename-tracks",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          instruction: "Capitalise each word in the title",
          tracks: VALID_TRACKS,
        }),
      },
    );

    expect(status).toBe(200);
    expect((body as any).tracks).toMatchObject(trackSuggestions);
    expect((body as any).sessions).toEqual([]);
    expect((body as any).event).toBeUndefined();
    expect(mockMessagesCreate).toHaveBeenCalledOnce();
  });

  it("returns event field suggestions for an event-focused instruction", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(
        JSON.stringify({ event: { titleEn: "Spring Retreat 2025" }, tracks: [] }),
      ),
    );

    const token = await adminToken();
    const { status, body } = await testJson(
      "/api/admin/events/42/rename-tracks",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          instruction: "Rename the event title to Spring Retreat 2025",
          event: { titleEn: "spring retreat" },
          tracks: VALID_TRACKS,
        }),
      },
    );

    expect(status).toBe(200);
    expect((body as any).event).toEqual({ titleEn: "Spring Retreat 2025" });
    expect((body as any).sessions).toEqual([]);
  });

  it("returns session title suggestions for a session-focused instruction", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(
        JSON.stringify({
          sessions: [{ rowKey: "s0", titleEn: "Morning Session" }],
          tracks: [],
        }),
      ),
    );

    const token = await adminToken();
    const { status, body } = await testJson(
      "/api/admin/events/42/rename-tracks",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          instruction: "Title-case the session titles",
          sessions: [{ rowKey: "s0", titleEn: "morning session" }],
          tracks: VALID_TRACKS,
        }),
      },
    );

    expect(status).toBe(200);
    expect((body as any).sessions).toEqual([
      { rowKey: "s0", titleEn: "Morning Session" },
    ]);
  });

  it("strips markdown code fences wrapping the JSON object", async () => {
    const trackSuggestions = [{ rowKey: "1-1", titleEn: "Opening Teachings" }];
    const withFences =
      "```json\n" + JSON.stringify({ tracks: trackSuggestions }) + "\n```";
    mockMessagesCreate.mockResolvedValueOnce(makeAnthropicResponse(withFences));

    const token = await adminToken();
    const { status, body } = await testJson(
      "/api/admin/events/42/rename-tracks",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ instruction: "Clean up", tracks: VALID_TRACKS }),
      },
    );

    expect(status).toBe(200);
    expect((body as any).tracks).toEqual(trackSuggestions);
  });

  it("returns 400 VALIDATION_ERROR when instruction is missing", async () => {
    const token = await adminToken();
    const { status, body } = await testJson(
      "/api/admin/events/42/rename-tracks",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tracks: VALID_TRACKS }),
      },
    );

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_ERROR when tracks array is missing", async () => {
    const token = await adminToken();
    const { status, body } = await testJson(
      "/api/admin/events/42/rename-tracks",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ instruction: "Fix titles" }),
      },
    );

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_ERROR when there are no tracks, videos or sessions to work on", async () => {
    const token = await adminToken();
    const { status, body } = await testJson(
      "/api/admin/events/42/rename-tracks",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ instruction: "Fix titles", tracks: [] }),
      },
    );

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("accepts an empty tracks array when the payload carries videos (video-only event)", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(
        JSON.stringify({
          videos: [{ rowKey: "9", titleEn: "Morning Teachings", videoDate: "2019-10-09" }],
        }),
      ),
    );
    const token = await adminToken();
    const { status, body } = await testJson(
      "/api/admin/events/42/rename-tracks",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          instruction: "Give the videos readable titles and extract their dates",
          tracks: [],
          videos: [{ rowKey: "9", title: "20219-10-09-KPS-TEACHINGS-MORNING-UBP" }],
        }),
      },
    );

    expect(status).toBe(200);
    expect((body as any).videos).toEqual([
      { rowKey: "9", titleEn: "Morning Teachings", videoDate: "2019-10-09" },
    ]);
  });

  it("accepts a track with an empty originalFilename (nullable DB column)", async () => {
    // Regression: `tracks.original_filename` is a nullable DB column, and
    // EventEdit sends `originalFilename: tk.originalFilename ?? ""` for legacy
    // tracks with no original filename recorded. The schema used to require
    // `.min(1)` on both `originalFilename` and `title`, so this legacy shape
    // failed Zod validation with a 400 before ever reaching the AI service.
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(JSON.stringify({ tracks: [] })),
    );

    const token = await adminToken();
    const { status, body } = await testJson(
      "/api/admin/events/42/rename-tracks",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          instruction: "Fix titles",
          tracks: [
            {
              rowKey: "1-1",
              originalFilename: "",
              title: "001 JKR - Opening teachings",
              speaker: null,
            },
          ],
        }),
      },
    );

    expect(status).toBe(200);
    expect((body as any).tracks).toEqual([]);
    expect(mockMessagesCreate).toHaveBeenCalledOnce();
  });

  it("returns 400 VALIDATION_ERROR for non-JSON body", async () => {
    const token = await adminToken();
    const { status, body } = await testJson(
      "/api/admin/events/42/rename-tracks",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: "not json",
      },
    );

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns 500 when ANTHROPIC_API_KEY is not set", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const token = await adminToken();
    const { status } = await testJson("/api/admin/events/42/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instruction: "Fix titles", tracks: VALID_TRACKS }),
    });

    expect(status).toBe(500);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns 422 quoting the AI when it answers in prose instead of JSON", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse("Sorry, I cannot do that — which tracks did you mean?"),
    );

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/events/42/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instruction: "Fix titles", tracks: VALID_TRACKS }),
    });

    expect(status).toBe(422);
    expect((body as any).code).toBe("AI_NEEDS_CLARIFICATION");
    // The admin needs the model's own words, not a generic parse failure.
    expect((body as any).error).toContain("which tracks did you mean");
  });

  it("returns 422 when the AI response is valid JSON but is an array, not an object", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(JSON.stringify([{ rowKey: "1-1", title: "Oops" }])),
    );

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/events/42/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instruction: "Fix titles", tracks: VALID_TRACKS }),
    });

    expect(status).toBe(422);
    expect((body as any).code).toBe("AI_NEEDS_CLARIFICATION");
  });

  it("returns 401 without an auth token", async () => {
    const { status } = await testJson("/api/admin/events/42/rename-tracks", {
      method: "POST",
      body: JSON.stringify({ instruction: "Fix titles", tracks: VALID_TRACKS }),
    });

    expect(status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    const token = await createAccessToken({
      sub: 2,
      email: "user@test.com",
      role: "user",
    });
    const { status } = await testJson("/api/admin/events/42/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instruction: "Fix titles", tracks: VALID_TRACKS }),
    });

    expect(status).toBe(403);
  });

  it("keeps an exact teacher abbreviation as-is", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(
        JSON.stringify({ tracks: [{ rowKey: "1-1", speaker: "PWR" }] }),
      ),
    );
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/events/42/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instruction: "Set speaker to PWR", tracks: VALID_TRACKS }),
    });
    expect(status).toBe(200);
    expect((body as any).tracks[0]).toMatchObject({ rowKey: "1-1", speaker: "PWR" });
    expect((body as any).tracks[0].speakerUnmatched).toBeUndefined();
  });

  it("resolves a full teacher name to its abbreviation", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(
        JSON.stringify({
          tracks: [{ rowKey: "1-1", speaker: "Pema Wangyal Rinpoche" }],
        }),
      ),
    );
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/events/42/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instruction: "Set speaker to Pema", tracks: VALID_TRACKS }),
    });
    expect(status).toBe(200);
    expect((body as any).tracks[0]).toMatchObject({ rowKey: "1-1", speaker: "PWR" });
    expect((body as any).tracks[0].speakerUnmatched).toBeUndefined();
  });

  it("resolves a partial, differently-cased teacher name to its abbreviation", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(
        JSON.stringify({ tracks: [{ rowKey: "1-1", speaker: "pema wangyal" }] }),
      ),
    );
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/events/42/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        instruction: "Set speaker to pema wangyal",
        tracks: VALID_TRACKS,
      }),
    });
    expect(status).toBe(200);
    expect((body as any).tracks[0]).toMatchObject({ rowKey: "1-1", speaker: "PWR" });
    expect((body as any).tracks[0].speakerUnmatched).toBeUndefined();
  });

  it("flags an unmatched speaker", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(
        JSON.stringify({ tracks: [{ rowKey: "1-1", speaker: "Some Unknown Person" }] }),
      ),
    );
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/events/42/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instruction: "x", tracks: VALID_TRACKS }),
    });
    expect(status).toBe(200);
    expect((body as any).tracks[0]).toMatchObject({
      speaker: "Some Unknown Person",
      speakerUnmatched: true,
    });
  });

  it("does not resolve an empty speaker to the first teacher in the roster", async () => {
    // Regression: `"".trim()` -> `""`, and `name.includes("")` is true for
    // every teacher, so an empty speaker used to silently resolve to
    // whichever teacher happened to be first in the roster (PWR).
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(JSON.stringify({ tracks: [{ rowKey: "1-1", speaker: "" }] })),
    );
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/events/42/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instruction: "Clear the speaker", tracks: VALID_TRACKS }),
    });
    expect(status).toBe(200);
    expect((body as any).tracks[0].speaker).toBe("");
    expect((body as any).tracks[0].speakerUnmatched).toBeUndefined();
  });

  it("does not misattribute a speaker via a short abbreviation substring match", async () => {
    // Regression: `q.includes(t.abbreviation.toLowerCase())` over-matched
    // because real abbreviations are 2 letters (RR, CK, ST). The phrase below
    // contains "st" (inside "history") but is not about the "ST" teacher —
    // under the old logic this silently resolved to "ST".
    mockTeachersFindMany.mockResolvedValueOnce([
      { abbreviation: "PWR", name: "Pema Wangyal Rinpoche" },
      { abbreviation: "JKR", name: "Jigme Khyentse Rinpoche" },
      { abbreviation: "ST", name: "Sonam Thaye Rinpoche" },
    ]);
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(
        JSON.stringify({
          tracks: [{ rowKey: "1-1", speaker: "History of the lineage" }],
        }),
      ),
    );
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/events/42/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instruction: "x", tracks: VALID_TRACKS }),
    });
    expect(status).toBe(200);
    expect((body as any).tracks[0]).toMatchObject({
      speaker: "History of the lineage",
      speakerUnmatched: true,
    });
  });
});
