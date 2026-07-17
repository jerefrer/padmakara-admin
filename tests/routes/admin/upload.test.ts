import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testJson } from "../../helpers.ts";

// Mock S3 so the admin endpoints don't actually call AWS.
vi.mock("../../../src/services/s3.ts", () => ({
  generatePresignedUploadUrl: vi.fn(),
  buildTrackS3Key: vi.fn((eventCode: string, _sessionNumber: number, filename: string) =>
    `events/${eventCode}/${filename}`,
  ),
  buildTranscriptS3Key: vi.fn((eventCode: string, filename: string) =>
    `events/${eventCode}/transcripts/${filename}`,
  ),
}));

// db is referenced indirectly via auth/admin middleware paths, and directly
// by rename-tracks for the teacher roster used in speaker resolution.
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

// Mock Anthropic SDK so tests never call the real API.
const mockMessagesCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: mockMessagesCreate };
  }
  return { default: MockAnthropic };
});

import { createAccessToken } from "../../../src/services/auth.ts";
import { generatePresignedUploadUrl } from "../../../src/services/s3.ts";

const mockPresignUrl = generatePresignedUploadUrl as ReturnType<typeof vi.fn>;

async function adminToken() {
  return createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
}

// ---------------------------------------------------------------------------
// presign-transcript
// ---------------------------------------------------------------------------

describe("POST /api/admin/upload/presign-transcript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a valid body and returns s3Key + uploadUrl", async () => {
    mockPresignUrl.mockResolvedValueOnce("https://s3.example.com/presigned-url");

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventCode: "20240418-JKR-PP3-CCA",
        filename: "Session 1 Transcript.pdf",
        contentType: "application/pdf",
      }),
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      s3Key: expect.stringContaining("transcripts/Session 1 Transcript.pdf"),
      uploadUrl: "https://s3.example.com/presigned-url",
    });
  });

  it("accepts filenames with accented characters, parentheses, and brackets", async () => {
    mockPresignUrl.mockResolvedValueOnce("https://s3.example.com/presigned-url");

    const token = await adminToken();
    const { status } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventCode: "20240418-JKR-PP3-CCA",
        filename: "Réunion été (17 April AM) [TIB].pdf",
        contentType: "application/pdf",
      }),
    });

    // Should pass validation (S3 mock may or may not add more detail)
    expect(status).toBe(200);
  });

  it("rejects path traversal in filename (../)", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventCode: "20240418-JKR-PP3-CCA",
        filename: "../../etc/evil",
        contentType: "application/pdf",
      }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockPresignUrl).not.toHaveBeenCalled();
  });

  it("rejects filename with a forward slash", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventCode: "20240418-JKR-PP3-CCA",
        filename: "some/path/file.pdf",
        contentType: "application/pdf",
      }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockPresignUrl).not.toHaveBeenCalled();
  });

  it("rejects filename with a backslash", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventCode: "20240418-JKR-PP3-CCA",
        filename: "some\\path\\file.pdf",
        contentType: "application/pdf",
      }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockPresignUrl).not.toHaveBeenCalled();
  });

  it("rejects filename starting with a dot", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventCode: "20240418-JKR-PP3-CCA",
        filename: ".hidden-file.pdf",
        contentType: "application/pdf",
      }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockPresignUrl).not.toHaveBeenCalled();
  });

  it("rejects a body missing the filename field", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventCode: "20240418-JKR-PP3-CCA",
        contentType: "application/pdf",
      }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockPresignUrl).not.toHaveBeenCalled();
  });

  it("rejects a body missing the eventCode field", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        filename: "transcript.pdf",
        contentType: "application/pdf",
      }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockPresignUrl).not.toHaveBeenCalled();
  });

  it("rejects invalid (non-JSON) body", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "not json",
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockPresignUrl).not.toHaveBeenCalled();
  });

  it("returns 401 without auth token", async () => {
    const { status } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      body: JSON.stringify({
        eventCode: "20240418-JKR-PP3-CCA",
        filename: "transcript.pdf",
        contentType: "application/pdf",
      }),
    });

    expect(status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    const token = await createAccessToken({ sub: 2, email: "user@test.com", role: "user" });
    const { status } = await testJson("/api/admin/upload/presign-transcript", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        eventCode: "20240418-JKR-PP3-CCA",
        filename: "transcript.pdf",
        contentType: "application/pdf",
      }),
    });

    expect(status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// infer-sessions
// ---------------------------------------------------------------------------

describe("POST /api/admin/upload/infer-sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a valid array of track filenames and returns inferred sessions", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/infer-sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        filenames: [
          "001 JKR - The daily practice-(17 April AM).mp3",
          "002 JKR - The daily practice part 2-(17 April AM).mp3",
          "001 TRAD - A pratica diaria.mp3",
        ],
      }),
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      totalTracks: 3,
      originalTracks: expect.any(Number),
      translationTracks: expect.any(Number),
      sessions: expect.any(Array),
    });
  });

  it("rejects path traversal in a filename inside the array (../)", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/infer-sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        filenames: [
          "001 JKR - Good track.mp3",
          "../../etc/passwd",
        ],
      }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
  });

  it("rejects a filename with a forward slash inside the array", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/infer-sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        filenames: ["dir/subdir/track.mp3"],
      }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
  });

  it("rejects a body missing the filenames field", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/infer-sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
  });

  it("rejects an empty filenames array", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/infer-sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ filenames: [] }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
  });

  it("rejects invalid (non-JSON) body", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/infer-sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "not json",
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
  });

  it("returns 401 without auth token", async () => {
    const { status } = await testJson("/api/admin/upload/infer-sessions", {
      method: "POST",
      body: JSON.stringify({ filenames: ["001 JKR - track.mp3"] }),
    });

    expect(status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    const token = await createAccessToken({ sub: 2, email: "user@test.com", role: "user" });
    const { status } = await testJson("/api/admin/upload/infer-sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ filenames: ["001 JKR - track.mp3"] }),
    });

    expect(status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// rename-tracks (stateless — used by EventCreate before an event ID exists)
// ---------------------------------------------------------------------------

const VALID_TRACKS = [
  {
    rowKey: "1-1",
    originalFilename: "001 JKR - The practice.mp3",
    title: "001 JKR - The practice",
    speaker: "JKR",
  },
  {
    rowKey: "1-2",
    originalFilename: "002 JKR - The practice part 2.mp3",
    title: "002 JKR - The practice part 2",
    speaker: null,
  },
];

function makeAnthropicResponse(jsonText: string) {
  return {
    content: [{ type: "text", text: jsonText }],
  };
}

describe("POST /api/admin/upload/rename-tracks", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV, ANTHROPIC_API_KEY: "test-key-123" };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("returns track suggestions from AI response", async () => {
    const trackSuggestions = [
      { rowKey: "1-1", title: "The Practice" },
      { rowKey: "1-2", title: "The Practice Part 2", speaker: "JKR" },
    ];
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(JSON.stringify({ tracks: trackSuggestions })),
    );

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instruction: "Capitalise each word", tracks: VALID_TRACKS }),
    });

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
    const { status, body } = await testJson("/api/admin/upload/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        instruction: "Rename the event title to Spring Retreat 2025",
        event: { titleEn: "spring retreat" },
        tracks: VALID_TRACKS,
      }),
    });

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
    const { status, body } = await testJson("/api/admin/upload/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        instruction: "Title-case the session titles",
        sessions: [{ rowKey: "s0", titleEn: "morning session" }],
        tracks: VALID_TRACKS,
      }),
    });

    expect(status).toBe(200);
    expect((body as any).sessions).toEqual([
      { rowKey: "s0", titleEn: "Morning Session" },
    ]);
  });

  it("strips markdown code fences from AI response", async () => {
    const trackSuggestions = [{ rowKey: "1-1", title: "Clean Title" }];
    const fencedText = "```json\n" + JSON.stringify({ tracks: trackSuggestions }) + "\n```";
    mockMessagesCreate.mockResolvedValueOnce(makeAnthropicResponse(fencedText));

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instruction: "Clean titles", tracks: VALID_TRACKS }),
    });

    expect(status).toBe(200);
    expect((body as any).tracks).toEqual(trackSuggestions);
  });

  it("returns 400 VALIDATION_ERROR when body is missing instruction", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tracks: VALID_TRACKS }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_ERROR when tracks array is empty", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instruction: "Fix titles", tracks: [] }),
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns 400 VALIDATION_ERROR for non-JSON body", async () => {
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "not json at all",
    });

    expect(status).toBe(400);
    expect((body as any).code).toBe("VALIDATION_ERROR");
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns 500 when ANTHROPIC_API_KEY is not configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const token = await adminToken();
    const { status } = await testJson("/api/admin/upload/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instruction: "Fix titles", tracks: VALID_TRACKS }),
    });

    expect(status).toBe(500);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns 500 when AI response is not valid JSON", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse("This is not JSON at all"),
    );

    const token = await adminToken();
    const { status } = await testJson("/api/admin/upload/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instruction: "Fix titles", tracks: VALID_TRACKS }),
    });

    expect(status).toBe(500);
  });

  it("returns 401 without an auth token", async () => {
    const { status } = await testJson("/api/admin/upload/rename-tracks", {
      method: "POST",
      body: JSON.stringify({ instruction: "Fix titles", tracks: VALID_TRACKS }),
    });

    expect(status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    const token = await createAccessToken({ sub: 2, email: "user@test.com", role: "user" });
    const { status } = await testJson("/api/admin/upload/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instruction: "Fix titles", tracks: VALID_TRACKS }),
    });

    expect(status).toBe(403);
  });

  // This is the endpoint the admin create-form UI's AI bulk-edit box actually
  // calls (SessionTrackTable.tsx), so speaker resolution has to work here —
  // not only on the unused POST /admin/events/:id/rename-tracks variant.
  it("keeps an exact teacher abbreviation as-is", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(JSON.stringify({ tracks: [{ rowKey: "1-1", speaker: "PWR" }] })),
    );
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/rename-tracks", {
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
        JSON.stringify({ tracks: [{ rowKey: "1-1", speaker: "Pema Wangyal Rinpoche" }] }),
      ),
    );
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/rename-tracks", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instruction: "Set speaker to Pema", tracks: VALID_TRACKS }),
    });
    expect(status).toBe(200);
    expect((body as any).tracks[0]).toMatchObject({ rowKey: "1-1", speaker: "PWR" });
    expect((body as any).tracks[0].speakerUnmatched).toBeUndefined();
  });

  it("flags an unmatched speaker with speakerUnmatched: true", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      makeAnthropicResponse(
        JSON.stringify({ tracks: [{ rowKey: "1-1", speaker: "Some Unknown Person" }] }),
      ),
    );
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/upload/rename-tracks", {
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
});
