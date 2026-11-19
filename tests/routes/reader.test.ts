import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson, testRequest } from "../helpers.ts";

// ─── Mock setup (BEFORE imports) ─────────────────────────────────────────

const { mockCanOpen, mockOpenable, state } = vi.hoisted(() => ({
  mockCanOpen: vi.fn((_caller: { id: number; role: string }, _ref: { type: string; id: number }) =>
    Promise.resolve(true),
  ),
  mockOpenable: vi.fn((_caller: { id: number; role: string }, _refs: { type: string; id: number }[]) =>
    Promise.resolve(new Map<string, unknown>()),
  ),
  state: {
    getReaderPosition: vi.fn((_u: number, _t: string, _d: number) =>
      Promise.resolve(null as { page: number; updatedAt: Date } | null),
    ),
    saveReaderPosition: vi.fn((_u: number, _t: string, _d: number, page: number, at: Date) =>
      Promise.resolve({ page, updatedAt: at }),
    ),
    listDocumentPageBookmarks: vi.fn((_u: number, _t: string, _d: number) =>
      Promise.resolve([] as { page: number; createdAt: Date }[]),
    ),
    addPageBookmark: vi.fn((_u: number, _t: string, _d: number, page: number) =>
      Promise.resolve({ page, createdAt: new Date("2026-11-19T10:00:00.000Z") }),
    ),
    removePageBookmark: vi.fn((_u: number, _t: string, _d: number, _p: number) => Promise.resolve()),
    listUserPageBookmarks: vi.fn((_u: number) =>
      Promise.resolve([] as { documentType: string; documentId: number; page: number; createdAt: Date }[]),
    ),
  },
}));

// Who can open which document is tested in tests/services/reader-document-access;
// the queries run against a real database in tests/migrations/reader-state.
vi.mock("../../src/services/reader-document-access.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/reader-document-access.ts")>();
  return { ...actual, canOpenReaderDocument: mockCanOpen, openableReaderDocuments: mockOpenable };
});
vi.mock("../../src/services/reader-state.ts", () => state);

import { createAccessToken } from "../../src/services/auth.ts";

async function tokenFor(sub: number, role = "user") {
  const token = await createAccessToken({ sub, email: `user${sub}@test.com`, role });
  return { Authorization: `Bearer ${token}` };
}

function jsonBody(body: unknown) {
  return { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCanOpen.mockResolvedValue(true);
  mockOpenable.mockResolvedValue(new Map());
});

describe("reader routes — authentication", () => {
  it.each([
    ["GET", "/api/reader/publication/1"],
    ["PUT", "/api/reader/publication/1/position"],
    ["PUT", "/api/reader/publication/1/bookmarks/3"],
    ["DELETE", "/api/reader/publication/1/bookmarks/3"],
    ["GET", "/api/reader/bookmarks"],
  ])("should answer 401 to a signed-out %s %s", async (method, path) => {
    const res = await testRequest(path, { method });

    expect(res.status).toBe(401);
    expect(mockCanOpen).not.toHaveBeenCalled();
  });
});

describe("GET /api/reader/:type/:id", () => {
  it("should return the caller's position and bookmarks in the document", async () => {
    state.getReaderPosition.mockResolvedValueOnce({ page: 12, updatedAt: new Date("2026-11-19T09:00:00.000Z") });
    state.listDocumentPageBookmarks.mockResolvedValueOnce([
      { page: 3, createdAt: new Date("2026-11-18T09:00:00.000Z") },
      { page: 12, createdAt: new Date("2026-11-19T09:00:00.000Z") },
    ]);

    const { status, body } = await testJson("/api/reader/publication/5", { headers: await tokenFor(42) });

    expect(status).toBe(200);
    expect(body).toEqual({
      position: { page: 12, updatedAt: "2026-11-19T09:00:00.000Z" },
      bookmarks: [
        { page: 3, createdAt: "2026-11-18T09:00:00.000Z" },
        { page: 12, createdAt: "2026-11-19T09:00:00.000Z" },
      ],
    });
    expect(mockCanOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }), { type: "publication", id: 5 });
    expect(state.getReaderPosition).toHaveBeenCalledWith(42, "publication", 5);
    expect(state.listDocumentPageBookmarks).toHaveBeenCalledWith(42, "publication", 5);
  });

  it("should answer a null position when none was saved", async () => {
    const { body } = await testJson("/api/reader/transcript/9", { headers: await tokenFor(42) });

    expect(body).toEqual({ position: null, bookmarks: [] });
  });

  it("should answer 404 and read nothing for a document the caller cannot open", async () => {
    mockCanOpen.mockResolvedValueOnce(false);

    const res = await testRequest("/api/reader/transcript/9", { headers: await tokenFor(42) });

    expect(res.status).toBe(404);
    expect(state.getReaderPosition).not.toHaveBeenCalled();
    expect(state.listDocumentPageBookmarks).not.toHaveBeenCalled();
  });

  it.each([["video/1"], ["publication/abc"], ["publication/0"], ["publication/-3"]])(
    "should answer 400 for %s",
    async (doc) => {
      const res = await testRequest(`/api/reader/${doc}`, { headers: await tokenFor(42) });

      expect(res.status).toBe(400);
      expect(mockCanOpen).not.toHaveBeenCalled();
    },
  );
});

describe("PUT /api/reader/:type/:id/position", () => {
  it("should save the page at the time the device sent, for the caller", async () => {
    const res = await testJson("/api/reader/publication/5/position", {
      method: "PUT",
      ...jsonBody({ page: 12, updatedAt: "2026-11-19T09:00:00.000Z" }),
      headers: { "Content-Type": "application/json", ...(await tokenFor(42)) },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ position: { page: 12, updatedAt: "2026-11-19T09:00:00.000Z" } });
    expect(state.saveReaderPosition).toHaveBeenCalledWith(
      42,
      "publication",
      5,
      12,
      new Date("2026-11-19T09:00:00.000Z"),
    );
  });

  it("should answer the position the server kept when it is more recent", async () => {
    state.saveReaderPosition.mockResolvedValueOnce({ page: 40, updatedAt: new Date("2026-11-19T10:00:00.000Z") });

    const { body } = await testJson("/api/reader/transcript/9/position", {
      method: "PUT",
      ...jsonBody({ page: 3, updatedAt: "2026-11-19T08:00:00.000Z" }),
      headers: { "Content-Type": "application/json", ...(await tokenFor(42)) },
    });

    expect(body.position).toEqual({ page: 40, updatedAt: "2026-11-19T10:00:00.000Z" });
  });

  it("should date the position now when the device sends no time", async () => {
    const before = Date.now();

    await testJson("/api/reader/publication/5/position", {
      method: "PUT",
      ...jsonBody({ page: 2 }),
      headers: { "Content-Type": "application/json", ...(await tokenFor(42)) },
    });

    const at = state.saveReaderPosition.mock.calls[0]![4];
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it.each([[{ page: 0 }], [{ page: 1.5 }], [{ page: "3" }], [{}], [{ page: 3, updatedAt: "yesterday" }], [{ page: 100_001 }]])(
    "should answer 400 and save nothing for %j",
    async (payload) => {
      const res = await testRequest("/api/reader/publication/5/position", {
        method: "PUT",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json", ...(await tokenFor(42)) },
      });

      expect(res.status).toBe(400);
      expect(state.saveReaderPosition).not.toHaveBeenCalled();
    },
  );

  it("should answer 404 and save nothing for a document the caller cannot open", async () => {
    mockCanOpen.mockResolvedValueOnce(false);

    const res = await testRequest("/api/reader/publication/5/position", {
      method: "PUT",
      body: JSON.stringify({ page: 4 }),
      headers: { "Content-Type": "application/json", ...(await tokenFor(42)) },
    });

    expect(res.status).toBe(404);
    expect(state.saveReaderPosition).not.toHaveBeenCalled();
  });
});

describe("PUT and DELETE /api/reader/:type/:id/bookmarks/:page", () => {
  it("should bookmark the page for the caller", async () => {
    const { status, body } = await testJson("/api/reader/publication/5/bookmarks/12", {
      method: "PUT",
      headers: await tokenFor(42),
    });

    expect(status).toBe(200);
    expect(body).toEqual({ bookmark: { page: 12, createdAt: "2026-11-19T10:00:00.000Z" } });
    expect(state.addPageBookmark).toHaveBeenCalledWith(42, "publication", 5, 12);
  });

  it("should remove the caller's bookmark and answer 204", async () => {
    const res = await testRequest("/api/reader/transcript/9/bookmarks/12", {
      method: "DELETE",
      headers: await tokenFor(42),
    });

    expect(res.status).toBe(204);
    expect(state.removePageBookmark).toHaveBeenCalledWith(42, "transcript", 9, 12);
  });

  it.each([["PUT"], ["DELETE"]])("should answer 404 to %s on a document the caller cannot open", async (method) => {
    mockCanOpen.mockResolvedValueOnce(false);

    const res = await testRequest("/api/reader/publication/5/bookmarks/12", {
      method,
      headers: await tokenFor(42),
    });

    expect(res.status).toBe(404);
    expect(state.addPageBookmark).not.toHaveBeenCalled();
    expect(state.removePageBookmark).not.toHaveBeenCalled();
  });

  it.each([["0"], ["abc"], ["2.5"], ["100001"]])("should answer 400 for page %s", async (page) => {
    const res = await testRequest(`/api/reader/publication/5/bookmarks/${page}`, {
      method: "PUT",
      headers: await tokenFor(42),
    });

    expect(res.status).toBe(400);
    expect(state.addPageBookmark).not.toHaveBeenCalled();
  });
});

describe("GET /api/reader/bookmarks", () => {
  it("should list the caller's bookmarks in documents they can open, with each document", async () => {
    state.listUserPageBookmarks.mockResolvedValueOnce([
      { documentType: "transcript", documentId: 9, page: 20, createdAt: new Date("2026-11-19T10:00:00.000Z") },
      { documentType: "publication", documentId: 5, page: 3, createdAt: new Date("2026-11-18T10:00:00.000Z") },
      { documentType: "publication", documentId: 6, page: 1, createdAt: new Date("2026-11-17T10:00:00.000Z") },
    ]);
    const transcript = { type: "transcript", id: 9, language: "pt", event: { id: 3, titleEn: "Retreat", titlePt: "Retiro" } };
    const publication = { type: "publication", id: 5, title: "O Tesouro de Bênçãos" };
    mockOpenable.mockResolvedValueOnce(
      new Map<string, unknown>([
        ["transcript:9", transcript],
        ["publication:5", publication],
      ]),
    );

    const { status, body } = await testJson("/api/reader/bookmarks", { headers: await tokenFor(42) });

    expect(status).toBe(200);
    expect(body.bookmarks).toEqual([
      { documentType: "transcript", documentId: 9, page: 20, createdAt: "2026-11-19T10:00:00.000Z", document: transcript },
      { documentType: "publication", documentId: 5, page: 3, createdAt: "2026-11-18T10:00:00.000Z", document: publication },
    ]);
    expect(state.listUserPageBookmarks).toHaveBeenCalledWith(42);
    expect(mockOpenable).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }), [
      { type: "transcript", id: 9 },
      { type: "publication", id: 5 },
      { type: "publication", id: 6 },
    ]);
  });
});
