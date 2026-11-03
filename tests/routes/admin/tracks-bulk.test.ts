import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

vi.mock("../../../src/db/index.ts", () => {
  const mockReturning = vi.fn();
  const mockWhere = vi.fn(() => ({ returning: mockReturning }));
  const mockSet = vi.fn(() => ({ where: mockWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockSet }));
  const mockSelectWhere = vi.fn();
  const mockSelect = vi.fn(() => ({ from: () => ({ where: mockSelectWhere }) }));
  return {
    db: {
      update: mockUpdate,
      select: mockSelect,
      _update: mockUpdate,
      _set: mockSet,
      _returning: mockReturning,
      _selectWhere: mockSelectWhere,
    },
  };
});

vi.mock("../../../src/services/s3.ts", () => ({
  deleteObject: vi.fn(() => Promise.resolve()),
  generatePresignedAttachmentUrl: vi.fn(() => Promise.resolve("https://signed/")),
}));

vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpVersion: vi.fn(() => Promise.resolve()),
}));

import { db } from "../../../src/db/index.ts";
import { bumpVersion } from "../../../src/services/sync-versions.ts";
import { createAccessToken } from "../../../src/services/auth.ts";

const mockReturning = (db as any)._returning as ReturnType<typeof vi.fn>;
const mockSet = (db as any)._set as ReturnType<typeof vi.fn>;
const mockSelectWhere = (db as any)._selectWhere as ReturnType<typeof vi.fn>;
const mockUpdate = (db as any)._update as ReturnType<typeof vi.fn>;
const mockBump = bumpVersion as ReturnType<typeof vi.fn>;

const adminToken = () => createAccessToken({ sub: 1, email: "a@test.com", role: "admin" });

async function bulk(body: unknown, token?: string) {
  return testJson("/api/admin/tracks/bulk", {
    method: "PATCH",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/admin/tracks/bulk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should update every id, derive originalLanguage and bump the sync version when the patch is valid", async () => {
    mockReturning.mockResolvedValueOnce([
      { id: 1, sessionId: 10 },
      { id: 2, sessionId: 11 },
    ]);
    mockSelectWhere.mockResolvedValueOnce([{ eventId: 5 }, { eventId: 5 }]);

    const { status, body } = await bulk(
      { ids: [1, 2, 2], patch: { speaker: "JK", languages: ["pt", "tib"], isTranslation: true } },
      await adminToken(),
    );

    expect(status).toBe(200);
    expect(body).toEqual({ updated: 2, ids: [1, 2] });
    expect(mockSet.mock.calls[0]![0]).toMatchObject({
      speaker: "JK",
      languages: ["pt", "tib"],
      originalLanguage: "pt",
      isTranslation: true,
    });
    // tracks update + owning events touched
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockBump).toHaveBeenCalledWith("events");
  });

  it("should only set the fields present in the patch", async () => {
    mockReturning.mockResolvedValueOnce([{ id: 1, sessionId: 10 }]);
    mockSelectWhere.mockResolvedValueOnce([{ eventId: 5 }]);

    await bulk({ ids: [1], patch: { isTranslation: false } }, await adminToken());

    const set = mockSet.mock.calls[0]![0];
    expect(set.isTranslation).toBe(false);
    expect(set).not.toHaveProperty("speaker");
    expect(set).not.toHaveProperty("languages");
    expect(set).not.toHaveProperty("originalLanguage");
  });

  it("should allow clearing the speaker with null", async () => {
    mockReturning.mockResolvedValueOnce([{ id: 1, sessionId: 10 }]);
    mockSelectWhere.mockResolvedValueOnce([{ eventId: 5 }]);

    const { status } = await bulk({ ids: [1], patch: { speaker: null } }, await adminToken());

    expect(status).toBe(200);
    expect(mockSet.mock.calls[0]![0].speaker).toBeNull();
  });

  it("should return 400 when ids is empty", async () => {
    const { status } = await bulk({ ids: [], patch: { isTranslation: true } }, await adminToken());
    expect(status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("should return 400 when the patch is empty", async () => {
    const { status } = await bulk({ ids: [1], patch: {} }, await adminToken());
    expect(status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("should return 400 when more than 500 ids are sent", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1);
    const { status } = await bulk({ ids, patch: { isTranslation: true } }, await adminToken());
    expect(status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("should return 401 without a token", async () => {
    const { status } = await bulk({ ids: [1], patch: { isTranslation: true } });
    expect(status).toBe(401);
  });

  it("should return 403 for non-admin users", async () => {
    const token = await createAccessToken({ sub: 2, email: "u@test.com", role: "user" });
    const { status } = await bulk({ ids: [1], patch: { isTranslation: true } }, token);
    expect(status).toBe(403);
  });
});
