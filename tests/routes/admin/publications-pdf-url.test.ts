import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const { findFirst, pdfUrl } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  pdfUrl: vi.fn(() => Promise.resolve("https://s3.example.com/signed")),
}));

vi.mock("../../../src/db/index.ts", () => ({ db: { query: { publications: { findFirst } } } }));
vi.mock("../../../src/services/s3.ts", () => ({
  generatePresignedPdfUrl: pdfUrl,
  generatePresignedDownloadUrl: vi.fn(),
  generatePresignedUploadUrl: vi.fn(),
  putObject: vi.fn(),
}));
vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpVersion: vi.fn(() => Promise.resolve()),
}));

import { createAccessToken } from "../../../src/services/auth.ts";

const get = async (path: string, role: "admin" | "user" = "admin", authed = true) =>
  testJson(path, {
    headers: authed
      ? { Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role })}` }
      : {},
  });

describe("GET /api/admin/publications/:id/pdf-url", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findFirst.mockResolvedValue({ id: 5, title: 'Heart "Sutra"/Notes', pdfS3Key: "publications/pdfs/1.pdf" });
  });

  it("should sign an inline URL when no disposition is given", async () => {
    const { status, body } = await get("/api/admin/publications/5/pdf-url");

    expect(status).toBe(200);
    expect(body.url).toBe("https://s3.example.com/signed");
    expect(pdfUrl).toHaveBeenCalledWith("publications/pdfs/1.pdf", "inline", expect.any(String));
  });

  it("should sign an attachment URL with a sanitized title filename when asked to download", async () => {
    const { status } = await get("/api/admin/publications/5/pdf-url?disposition=attachment");

    expect(status).toBe(200);
    expect(pdfUrl).toHaveBeenCalledWith("publications/pdfs/1.pdf", "attachment", "Heart Sutra Notes.pdf");
  });

  it("should return 404 when the publication does not exist", async () => {
    findFirst.mockResolvedValue(undefined);

    const { status } = await get("/api/admin/publications/99/pdf-url");

    expect(status).toBe(404);
  });

  it("should return 404 when the publication has no PDF key", async () => {
    findFirst.mockResolvedValue({ id: 5, title: "T", pdfS3Key: "" });

    const { status } = await get("/api/admin/publications/5/pdf-url");

    expect(status).toBe(404);
    expect(pdfUrl).not.toHaveBeenCalled();
  });

  it("should return 401 without a token", async () => {
    const { status } = await get("/api/admin/publications/5/pdf-url", "admin", false);

    expect(status).toBe(401);
  });

  it("should return 403 for a non-admin user", async () => {
    const { status } = await get("/api/admin/publications/5/pdf-url", "user");

    expect(status).toBe(403);
  });
});
