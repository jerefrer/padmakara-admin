import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

// ─── Mock setup (BEFORE imports) ─────────────────────────────────────────

vi.mock("../../src/db/index.ts", () => {
  const mockFrom = vi.fn();
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  return {
    db: {
      select: mockSelect,
      _mockSelect: mockSelect,
      _mockFrom: mockFrom,
    },
  };
});

const AUDIENCE_SLUGS_BY_ID = new Map([
  [7, "free-anyone"],
  [8, "free-subscribers"],
  [9, "event-participants"],
  [13, "restricted"],
]);

const { mockOpenable } = vi.hoisted(() => ({
  mockOpenable: vi.fn(
    (_user: unknown, _pubs: { id: number; audienceId: number | null }[]) =>
      Promise.resolve(new Set<number>()),
  ),
}));

// Who can open what is tested on its own (tests/services/publication-access);
// here it only says which publications this caller may open.
vi.mock("../../src/services/publication-access.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/publication-access.ts")>();
  return {
    ...actual,
    openablePublications: mockOpenable,
    publicationAudienceSlugs: () => Promise.resolve(AUDIENCE_SLUGS_BY_ID),
  };
});

vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() =>
    Promise.resolve("https://s3.example.com/signed-url"),
  ),
}));

import { db } from "../../src/db/index.ts";
import { createAccessToken } from "../../src/services/auth.ts";

const mockSelect = (db as any)._mockSelect as ReturnType<typeof vi.fn>;
const mockFrom = (db as any)._mockFrom as ReturnType<typeof vi.fn>;

/**
 * Drizzle-style chainable thenable: awaitable at any step (`from(...)` or
 * `from(...).where(...)`), both resolving to `rows`. The test data is
 * pre-filtered for the scenario under test, so `.where()` does not actually
 * narrow — it just returns the same rows wrapped in another thenable.
 */
function chainable(rows: any[]) {
  return {
    then: (onFulfilled: any, onRejected?: any) =>
      Promise.resolve(rows).then(onFulfilled, onRejected),
    where: vi.fn(() => chainable(rows)),
  };
}

// ─── Test data factories ─────────────────────────────────────────────────

function makePublication(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    title: "Guia de Meditação",
    subtitle: null,
    description: "A guide to meditation",
    authors: ["Jigme Khyentse Rinpoche"],
    language: "pt",
    pageCount: 120,
    publicationDate: "2024-01-15",
    coverImageS3Key: "publications/covers/guide.jpg",
    pdfS3Key: "publications/pdfs/guide.pdf",
    fileSizeBytes: 5000000,
    audienceId: 7,
    status: "published",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMemberPublication(overrides: Record<string, any> = {}) {
  return makePublication({
    id: 2,
    title: "Ensinamentos Avançados",
    audienceId: 8,
    pdfS3Key: "publications/pdfs/advanced.pdf",
    ...overrides,
  });
}

function makeRetreatPublication(overrides: Record<string, any> = {}) {
  return makePublication({
    id: 3,
    title: "The Excellent Path of Liberation",
    audienceId: 9,
    pdfS3Key: "publications/pdfs/laphur.pdf",
    ...overrides,
  });
}

async function userToken() {
  const token = await createAccessToken({ sub: 1, email: "user@test.com", role: "user" });
  return { Authorization: `Bearer ${token}` };
}

/** The caller may open exactly these publication ids. */
function canOpen(...ids: number[]) {
  mockOpenable.mockResolvedValue(new Set(ids));
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("GET /api/publications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockImplementation(() => ({ from: mockFrom }));
    mockOpenable.mockResolvedValue(new Set());
  });

  it("should list only the publications the caller can open", async () => {
    mockFrom.mockReturnValueOnce(
      chainable([makePublication(), makeMemberPublication(), makeRetreatPublication()]),
    );
    canOpen(1, 3);

    const { status, body } = await testJson("/api/publications", { headers: await userToken() });

    expect(status).toBe(200);
    expect(body.publications.map((p: any) => p.id)).toEqual([1, 3]);
  });

  it("should hand the caller and every publication's audience to the access decision", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication(), makeRetreatPublication()]));
    canOpen(1);

    await testJson("/api/publications", { headers: await userToken() });

    expect(mockOpenable).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      [expect.objectContaining({ id: 1, audienceId: 7 }), expect.objectContaining({ id: 3, audienceId: 9 })],
    );
  });

  it("should flag hidden publications when a members-only one is closed to the caller", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication(), makeMemberPublication()]));
    canOpen(1);

    const { body } = await testJson("/api/publications");

    expect(body.publications).toHaveLength(1);
    expect(body.hasHiddenPublications).toBe(true);
  });

  it("should not flag hidden publications when the caller opens every members-only one", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication(), makeMemberPublication()]));
    canOpen(1, 2);

    const { body } = await testJson("/api/publications", { headers: await userToken() });

    expect(body.publications).toHaveLength(2);
    expect(body.hasHiddenPublications).toBe(false);
  });

  it("should not count an event-based publication in the become-a-member flag", async () => {
    // Joining would not open a retreat text, so a member missing it gains nothing.
    mockFrom.mockReturnValueOnce(chainable([makePublication(), makeRetreatPublication()]));
    canOpen(1);

    const { body } = await testJson("/api/publications", { headers: await userToken() });

    expect(body.publications.map((p: any) => p.id)).toEqual([1]);
    expect(body.hasHiddenPublications).toBe(false);
  });

  it("should leave out a restricted publication the caller cannot open, with no hint it exists", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication(), makePublication({ id: 5, audienceId: 13 })]));
    canOpen(1);

    const { body } = await testJson("/api/publications", { headers: await userToken() });

    expect(body.publications.map((p: any) => p.id)).toEqual([1]);
    expect(body.hasHiddenPublications).toBe(false);
  });

  it("should list a restricted publication to a caller who can open it", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication({ id: 5, audienceId: 13 })]));
    canOpen(5);

    const { body } = await testJson("/api/publications", { headers: await userToken() });

    expect(body.publications.map((p: any) => p.id)).toEqual([5]);
  });

  it("should never expose S3 keys or the internal audience in the response", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication()]));
    canOpen(1);

    const { status, body } = await testJson("/api/publications");

    expect(status).toBe(200);
    const pub = body.publications[0];
    expect(pub.pdfS3Key).toBeUndefined();
    expect(pub.coverImageS3Key).toBeUndefined();
    expect(pub.accessLevel).toBeUndefined();
    expect(pub.coverImageUrl).toBe("https://s3.example.com/signed-url");
  });

  it("should generate coverImageUrl only when coverImageS3Key exists", async () => {
    mockFrom.mockReturnValueOnce(
      chainable([
        makePublication({ coverImageS3Key: "covers/img.jpg" }),
        makePublication({ id: 4, coverImageS3Key: null }),
      ]),
    );
    canOpen(1, 4);

    const { body } = await testJson("/api/publications");

    expect(body.publications[0].coverImageUrl).toBe("https://s3.example.com/signed-url");
    expect(body.publications[1].coverImageUrl).toBeNull();
  });
});

describe("GET /api/publications/:id/pdf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockImplementation(() => ({ from: mockFrom }));
    mockOpenable.mockResolvedValue(new Set());
  });

  it("should give a presigned URL to a caller who can open the publication", async () => {
    mockFrom.mockReturnValueOnce(chainable([makeRetreatPublication()]));
    canOpen(3);

    const { status, body } = await testJson("/api/publications/3/pdf", { headers: await userToken() });

    expect(status).toBe(200);
    expect(body.url).toBe("https://s3.example.com/signed-url");
    expect(body.expiresIn).toBe(3600);
    expect(mockOpenable).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      [expect.objectContaining({ id: 3, audienceId: 9 })],
    );
  });

  it("should give a presigned URL without sign-in when the publication is open to anyone", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication()]));
    canOpen(1);

    const { status } = await testJson("/api/publications/1/pdf");

    expect(status).toBe(200);
  });

  it("should ask a signed-out visitor to sign in when the publication is closed to them", async () => {
    mockFrom.mockReturnValueOnce(chainable([makeMemberPublication()]));

    const { status, body } = await testJson("/api/publications/2/pdf");

    expect(status).toBe(401);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("should refuse a signed-in caller who cannot open the publication", async () => {
    mockFrom.mockReturnValueOnce(chainable([makeRetreatPublication()]));

    const { status, body } = await testJson("/api/publications/3/pdf", { headers: await userToken() });

    expect(status).toBe(403);
    expect(body.code).toBe("FORBIDDEN");
  });

  it("should answer 404, not 403, to a signed-in caller refused a restricted publication", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication({ id: 5, audienceId: 13 })]));

    const { status, body } = await testJson("/api/publications/5/pdf", { headers: await userToken() });

    expect(status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
  });

  it("should answer 404, not 401, to a signed-out visitor refused a restricted publication", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication({ id: 5, audienceId: 13 })]));

    const { status } = await testJson("/api/publications/5/pdf");

    expect(status).toBe(404);
  });

  it("should return 404 for a publication that does not exist", async () => {
    mockFrom.mockReturnValueOnce(chainable([]));

    const { status, body } = await testJson("/api/publications/999/pdf");

    expect(status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
  });

  it("should return 400 for an invalid publication ID", async () => {
    const { status } = await testJson("/api/publications/abc/pdf");
    expect(status).toBe(400);
  });
});
