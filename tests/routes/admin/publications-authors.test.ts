import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const { from } = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("../../../src/db/index.ts", () => ({
  db: { select: vi.fn(() => ({ from })), query: { publications: { findFirst: vi.fn() } } },
}));
vi.mock("../../../src/services/s3.ts", () => ({
  generatePresignedPdfUrl: vi.fn(),
  generatePresignedDownloadUrl: vi.fn(),
  generatePresignedUploadUrl: vi.fn(),
  putObject: vi.fn(),
}));
vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpVersion: vi.fn(() => Promise.resolve()),
}));

import { createAccessToken } from "../../../src/services/auth.ts";

const get = async (path: string, role: "admin" | "user" = "admin") =>
  testJson(path, {
    headers: { Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role })}` },
  });

describe("GET /api/admin/publications/authors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    from.mockResolvedValue([{ authors: ["Buda Śākyamuni (BS)", "Mañjuśrī"] }, { authors: ["Mañjuśrī"] }]);
  });

  it("should list the distinct author names used across publications with their counts", async () => {
    const { status, body } = await get("/api/admin/publications/authors");

    expect(status).toBe(200);
    expect(body).toEqual([
      { name: "Buda Śākyamuni (BS)", count: 1 },
      { name: "Mañjuśrī", count: 2 },
    ]);
  });

  it("should refuse a non-admin", async () => {
    const { status } = await get("/api/admin/publications/authors", "user");

    expect(status).toBe(403);
  });
});
