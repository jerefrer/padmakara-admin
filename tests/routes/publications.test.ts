import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson, testRequest } from "../helpers.ts";

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

const { mockRecordOpen, mockLastOpened } = vi.hoisted(() => ({
  mockRecordOpen: vi.fn((_userId: number, _publicationId: number) => Promise.resolve()),
  mockLastOpened: vi.fn((_userId: number, _ids: number[]) => Promise.resolve(new Map<number, Date>())),
}));

// The queries themselves run against a real database in
// tests/services/publication-opens.test.ts.
vi.mock("../../src/services/publication-opens.ts", () => ({
  recordPublicationOpen: mockRecordOpen,
  lastOpenedByPublication: mockLastOpened,
}));

vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() =>
    Promise.resolve("https://s3.example.com/signed-url"),
  ),
}));

import { db } from "../../src/db/index.ts";
import { createAccessToken } from "../../src/services/auth.ts";
import { generatePresignedDownloadUrl } from "../../src/services/s3.ts";

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

  it("should give a fingerprint of the PDF file that does not reveal its S3 key", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication()]));
    canOpen(1);

    const { body } = await testJson("/api/publications");

    const { pdfFingerprint } = body.publications[0];
    expect(pdfFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(body)).not.toContain("guide.pdf");
  });

  it("should change the fingerprint when the PDF file is replaced, and only then", async () => {
    mockFrom.mockReturnValueOnce(
      chainable([
        makePublication({ id: 1 }),
        makePublication({ id: 2, title: "Renamed", pdfS3Key: "publications/pdfs/guide.pdf" }),
        makePublication({ id: 3, pdfS3Key: "publications/pdfs/guide-fixed.pdf" }),
      ]),
    );
    canOpen(1, 2, 3);

    const { body } = await testJson("/api/publications", { headers: await userToken() });

    const byId = new Map(body.publications.map((p: any) => [p.id, p.pdfFingerprint]));
    expect(byId.get(2)).toBe(byId.get(1));
    expect(byId.get(3)).not.toBe(byId.get(1));
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

// ─── Status: Draft / Forthcoming / Published ─────────────────────────────

async function adminToken() {
  const token = await createAccessToken({ sub: 2, email: "admin@test.com", role: "admin" });
  return { Authorization: `Bearer ${token}` };
}

describe("GET /api/publications — status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockImplementation(() => ({ from: mockFrom }));
  });

  it("should never list a draft to a non-admin, even one whose audience lets them in", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication(), makePublication({ id: 4, status: "draft" })]));
    canOpen(1, 4);

    const { body } = await testJson("/api/publications", { headers: await userToken() });

    expect(body.publications.map((p: any) => p.id)).toEqual([1]);
  });

  it("should not hand a draft to the access decision for a non-admin", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication(), makeMemberPublication({ status: "draft" })]));
    canOpen(1);

    const { body } = await testJson("/api/publications");

    expect(mockOpenable).toHaveBeenCalledWith(null, [expect.objectContaining({ id: 1 })]);
    // A members-only draft is no reason to invite anyone to join.
    expect(body.hasHiddenPublications).toBe(false);
  });

  it("should list a forthcoming publication with its status so the app can show it as upcoming", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication({ id: 6, status: "forthcoming" })]));
    canOpen(6);

    const { body } = await testJson("/api/publications", { headers: await userToken() });

    expect(body.publications).toEqual([expect.objectContaining({ id: 6, status: "forthcoming" })]);
  });

  it("should not list a forthcoming publication to someone its audience keeps out", async () => {
    mockFrom.mockReturnValueOnce(chainable([makeRetreatPublication({ status: "forthcoming" })]));
    canOpen();

    const { body } = await testJson("/api/publications", { headers: await userToken() });

    expect(body.publications).toEqual([]);
  });

  it("should list a published publication as before, with its status", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication()]));
    canOpen(1);

    const { body } = await testJson("/api/publications");

    expect(body.publications).toEqual([expect.objectContaining({ id: 1, status: "published" })]);
  });

  it("should list drafts and forthcoming publications to an admin", async () => {
    mockFrom.mockReturnValueOnce(
      chainable([
        makePublication(),
        makePublication({ id: 4, status: "draft" }),
        makePublication({ id: 6, status: "forthcoming" }),
      ]),
    );
    canOpen(1, 4, 6);

    const { body } = await testJson("/api/publications", { headers: await adminToken() });

    expect(body.publications.map((p: any) => p.id).sort()).toEqual([1, 4, 6]);
  });

  it("should never list an unknown status, even to an admin", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication({ id: 4, status: "archived" })]));
    canOpen(4);

    const { body } = await testJson("/api/publications", { headers: await adminToken() });

    expect(body.publications).toEqual([]);
  });
});

describe("GET /api/publications/:id/pdf — status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockImplementation(() => ({ from: mockFrom }));
  });

  it("should answer 404 for a draft to a non-admin, without signing a URL", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication({ status: "draft" })]));
    canOpen(1);

    const { status } = await testJson("/api/publications/1/pdf", { headers: await userToken() });

    expect(status).toBe(404);
    expect(generatePresignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("should refuse the file of a forthcoming publication to a caller its audience lets in", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication({ status: "forthcoming" })]));
    canOpen(1);

    const { status, body } = await testJson("/api/publications/1/pdf", { headers: await userToken() });

    expect(status).toBe(403);
    expect(body.code).toBe("PUBLICATION_FORTHCOMING");
    expect(generatePresignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("should refuse the file of a forthcoming public publication to a signed-out visitor", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication({ status: "forthcoming" })]));
    canOpen(1);

    const { status, body } = await testJson("/api/publications/1/pdf");

    expect(status).toBe(403);
    expect(body.code).toBe("PUBLICATION_FORTHCOMING");
  });

  it("should keep a forthcoming restricted publication a 404 for a caller not on its list", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication({ id: 5, audienceId: 13, status: "forthcoming" })]));
    canOpen();

    const { status } = await testJson("/api/publications/5/pdf", { headers: await userToken() });

    expect(status).toBe(404);
  });

  it("should serve a published publication as before", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication()]));
    canOpen(1);

    const { status, body } = await testJson("/api/publications/1/pdf");

    expect(status).toBe(200);
    expect(body.url).toBe("https://s3.example.com/signed-url");
  });

  it.each(["draft", "forthcoming"])("should serve a %s publication to an admin", async (status) => {
    mockFrom.mockReturnValueOnce(chainable([makePublication({ status })]));
    canOpen(1);

    const res = await testJson("/api/publications/1/pdf", { headers: await adminToken() });

    expect(res.status).toBe(200);
  });
});

// ─── Last opened ─────────────────────────────────────────────────────────

async function tokenFor(sub: number) {
  const token = await createAccessToken({ sub, email: `user${sub}@test.com`, role: "user" });
  return { Authorization: `Bearer ${token}` };
}

describe("GET /api/publications — lastOpenedAt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockImplementation(() => ({ from: mockFrom }));
    mockLastOpened.mockResolvedValue(new Map());
  });

  it("should give each publication the time the caller last opened it, null when never opened", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication(), makeRetreatPublication()]));
    canOpen(1, 3);
    mockLastOpened.mockResolvedValue(new Map([[3, new Date("2026-11-10T08:00:00.000Z")]]));

    const { body } = await testJson("/api/publications", { headers: await userToken() });

    const byId = Object.fromEntries(body.publications.map((p: any) => [p.id, p.lastOpenedAt]));
    expect(byId).toEqual({ 1: null, 3: "2026-11-10T08:00:00.000Z" });
  });

  it("should look up the opens of the caller only, for the publications listed to them", async () => {
    mockFrom.mockReturnValueOnce(
      chainable([makePublication(), makeMemberPublication(), makeRetreatPublication()]),
    );
    canOpen(1, 3);

    await testJson("/api/publications", { headers: await tokenFor(42) });

    expect(mockLastOpened).toHaveBeenCalledTimes(1);
    expect(mockLastOpened).toHaveBeenCalledWith(42, [1, 3]);
  });

  it("should answer null for every publication to a signed-out visitor, without looking up opens", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication()]));
    canOpen(1);

    const { body } = await testJson("/api/publications");

    expect(body.publications[0].lastOpenedAt).toBeNull();
    expect(mockLastOpened).not.toHaveBeenCalled();
  });
});

describe("POST /api/publications/:id/opened", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockImplementation(() => ({ from: mockFrom }));
    mockOpenable.mockResolvedValue(new Set());
  });

  it("should record the open for the caller and answer 204", async () => {
    mockFrom.mockReturnValueOnce(chainable([makeRetreatPublication()]));
    canOpen(3);

    const res = await testRequest("/api/publications/3/opened", {
      method: "POST",
      headers: await tokenFor(42),
    });

    expect(res.status).toBe(204);
    expect(mockRecordOpen).toHaveBeenCalledWith(42, 3);
  });

  it("should ask a signed-out visitor to sign in and record nothing", async () => {
    const res = await testRequest("/api/publications/1/opened", { method: "POST" });

    expect(res.status).toBe(401);
    expect(mockRecordOpen).not.toHaveBeenCalled();
  });

  it("should answer 404 and record nothing for a publication that does not exist", async () => {
    mockFrom.mockReturnValueOnce(chainable([]));

    const res = await testRequest("/api/publications/999/opened", {
      method: "POST",
      headers: await userToken(),
    });

    expect(res.status).toBe(404);
    expect(mockRecordOpen).not.toHaveBeenCalled();
  });

  it("should answer 404 and record nothing for a publication the caller cannot open", async () => {
    mockFrom.mockReturnValueOnce(chainable([makeMemberPublication()]));
    canOpen();

    const res = await testRequest("/api/publications/2/opened", {
      method: "POST",
      headers: await userToken(),
    });

    expect(res.status).toBe(404);
    expect(mockRecordOpen).not.toHaveBeenCalled();
  });

  it("should answer 404 and record nothing for a draft opened by a non-admin", async () => {
    mockFrom.mockReturnValueOnce(chainable([makePublication({ status: "draft" })]));
    canOpen(1);

    const res = await testRequest("/api/publications/1/opened", {
      method: "POST",
      headers: await userToken(),
    });

    expect(res.status).toBe(404);
    expect(mockRecordOpen).not.toHaveBeenCalled();
  });

  it("should return 400 for an invalid publication ID", async () => {
    const res = await testRequest("/api/publications/abc/opened", {
      method: "POST",
      headers: await userToken(),
    });

    expect(res.status).toBe(400);
  });
});
