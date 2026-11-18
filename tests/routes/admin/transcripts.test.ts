import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

vi.mock("../../../src/db/index.ts", () => {
  const mockReturning = vi.fn();
  const mockWhere = vi.fn(() => ({ returning: mockReturning }));
  const mockValues = vi.fn(() => ({ returning: mockReturning }));
  const mockInsert = vi.fn(() => ({ values: mockValues }));
  const mockSet = vi.fn(() => ({ where: mockWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockSet }));
  const mockDelete = vi.fn(() => ({ where: mockWhere }));
  return {
    db: {
      insert: mockInsert, update: mockUpdate, delete: mockDelete,
      query: { transcripts: { findFirst: vi.fn(() => Promise.resolve(null)) } },
      _returning: mockReturning, _values: mockValues,
    },
  };
});
vi.mock("../../../src/services/s3.ts", () => ({
  deleteObject: vi.fn(() => Promise.resolve()),
  generatePresignedAttachmentUrl: vi.fn(() => Promise.resolve("https://signed.example/t.pdf")),
}));
// The protected-PDF check reads S3; its own behaviour is in tests/services/pdf-protection.test.ts.
const PDF_BYTES = new Uint8Array([37, 80, 68, 70]);
const mockRejectProtectedPdf = vi.fn((_key: string) => Promise.resolve(PDF_BYTES));
vi.mock("../../../src/services/pdf-protection.ts", () => ({
  rejectProtectedPdf: (key: string) => mockRejectProtectedPdf(key),
}));
// pdfinfo is a system binary; the route only has to store what it counts.
const mockPageCount = vi.fn((_bytes: Uint8Array) => Promise.resolve(42));
vi.mock("../../../src/services/pdf-page-count.ts", () => ({
  getPdfPageCount: (bytes: Uint8Array) => mockPageCount(bytes),
}));
vi.mock("../../../src/services/sync-versions.ts", () => ({ bumpVersion: vi.fn(() => Promise.resolve()) }));

import { db } from "../../../src/db/index.ts";
import { deleteObject, generatePresignedAttachmentUrl } from "../../../src/services/s3.ts";
import { createAccessToken } from "../../../src/services/auth.ts";

const mockReturning = (db as any)._returning as ReturnType<typeof vi.fn>;
const mockValues = (db as any)._values as ReturnType<typeof vi.fn>;
const mockDeleteObject = deleteObject as ReturnType<typeof vi.fn>;
const mockAttachmentUrl = generatePresignedAttachmentUrl as ReturnType<typeof vi.fn>;
const mockFindFirst = (db as any).query.transcripts.findFirst as ReturnType<typeof vi.fn>;
const adminToken = () => createAccessToken({ sub: 1, email: "a@test.com", role: "admin" });

describe("transcripts admin resource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should persist a new upload as a final, full, unpublished file", async () => {
    mockReturning.mockResolvedValueOnce([{ id: 11, eventId: 3, language: "en" }]);
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/transcripts", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: 3, language: "en", s3Key: "events/E/transcripts/t.pdf" }),
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({ id: 11, eventId: 3 });
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({ status: "final", isExcerpt: false, published: false }),
    );
  });

  it("should store the page count read from the uploaded PDF", async () => {
    mockReturning.mockResolvedValueOnce([{ id: 11, eventId: 3, language: "en" }]);
    const token = await adminToken();
    await testJson("/api/admin/transcripts", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: 3, language: "en", s3Key: "events/E/transcripts/t.pdf", pageCount: 7 }),
    });
    expect(mockPageCount).toHaveBeenCalledWith(PDF_BYTES);
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ pageCount: 42 }));
  });

  it("should still save the row when the pages cannot be counted", async () => {
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    mockPageCount.mockRejectedValueOnce(new Error("pdfinfo failed"));
    mockReturning.mockResolvedValueOnce([{ id: 11, eventId: 3, language: "en" }]);
    const token = await adminToken();
    const { status } = await testJson("/api/admin/transcripts", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: 3, language: "en", s3Key: "events/E/transcripts/t.pdf" }),
    });
    expect(status).toBe(201);
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ pageCount: null }));
  });

  it("should refuse a language outside en, pt, fr and tib", async () => {
    const token = await adminToken();
    const { status } = await testJson("/api/admin/transcripts", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: 3, language: "es", s3Key: "events/E/transcripts/t.pdf" }),
    });
    expect(status).toBe(400);
    expect(mockValues).not.toHaveBeenCalled();
  });

  describe("PATCH /api/admin/transcripts/:id", () => {
    async function patch(body: unknown) {
      return testJson("/api/admin/transcripts/11", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${await adminToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    const mockSet = () => ((db as any).update.mock.results[0].value.set as ReturnType<typeof vi.fn>);

    it("should write only the field the body sends", async () => {
      mockReturning.mockResolvedValueOnce([{ id: 11, eventId: 3, published: true }]);

      const { status } = await patch({ published: true });

      expect(status).toBe(200);
      const written = mockSet().mock.calls[0]![0] as Record<string, unknown>;
      expect(Object.keys(written).sort()).toEqual(["published", "updatedAt"]);
    });

    it("should accept language, status and isExcerpt", async () => {
      mockReturning.mockResolvedValueOnce([{ id: 11, eventId: 3 }]);

      const { status } = await patch({ language: "fr", status: "provisional", isExcerpt: true });

      expect(status).toBe(200);
      expect(mockSet().mock.calls[0]![0]).toMatchObject({ language: "fr", status: "provisional", isExcerpt: true });
    });

    it("should refuse an unknown status", async () => {
      const { status } = await patch({ status: "published" });

      expect(status).toBe(400);
    });

    it("should answer 404 for an unknown transcript", async () => {
      mockReturning.mockResolvedValueOnce([]);

      const { status } = await patch({ published: false });

      expect(status).toBe(404);
    });
  });

  it("should refuse a password-protected PDF without saving a row", async () => {
    const { AppError } = await import("../../../src/lib/errors.ts");
    mockRejectProtectedPdf.mockRejectedValueOnce(AppError.badRequest("This PDF is password-protected.", "PDF_PROTECTED"));
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/transcripts", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: 3, language: "en", s3Key: "events/E/transcripts/t.pdf" }),
    });
    expect(status).toBe(400);
    expect(body.code).toBe("PDF_PROTECTED");
    expect(mockRejectProtectedPdf).toHaveBeenCalledWith("events/E/transcripts/t.pdf");
    expect(mockValues).not.toHaveBeenCalled();
  });

  it("deletes the row and S3 object", async () => {
    mockReturning.mockResolvedValueOnce([{ id: 11, eventId: 3, s3Key: "events/E/transcripts/t.pdf" }]);
    const token = await adminToken();
    const { status } = await testJson("/api/admin/transcripts/11", {
      method: "DELETE", headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
    expect(mockDeleteObject).toHaveBeenCalledWith("events/E/transcripts/t.pdf");
  });

  it("returns a presigned attachment URL using the original filename", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 11,
      eventId: 3,
      s3Key: "events/E/transcripts/abc.pdf",
      originalFilename: "Chapter-Part_3_of_3.pdf",
    });
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/transcripts/11/download-url", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      url: "https://signed.example/t.pdf",
      filename: "Chapter-Part_3_of_3.pdf",
    });
    expect(mockAttachmentUrl).toHaveBeenCalledWith(
      "events/E/transcripts/abc.pdf",
      "Chapter-Part_3_of_3.pdf",
      600,
    );
  });

  it("falls back to the S3 key basename when no original filename was recorded", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 12,
      eventId: 3,
      s3Key: "events/E/transcripts/abc.pdf",
      originalFilename: null,
    });
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/transcripts/12/download-url", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
    expect(body.filename).toBe("abc.pdf");
  });

  it("returns 400 when the transcript row has no file", async () => {
    mockFindFirst.mockResolvedValueOnce({ id: 13, eventId: 3, s3Key: null });
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/transcripts/13/download-url", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("NO_S3_KEY");
    expect(mockAttachmentUrl).not.toHaveBeenCalled();
  });

  it("returns 404 when the transcript does not exist", async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    const token = await adminToken();
    const { status } = await testJson("/api/admin/transcripts/999/download-url", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(404);
  });

  it("rejects non-admins on the download URL", async () => {
    const token = await createAccessToken({ sub: 2, email: "u@test.com", role: "user" });
    const { status } = await testJson("/api/admin/transcripts/11/download-url", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(403);
    expect(mockAttachmentUrl).not.toHaveBeenCalled();
  });

  it("rejects non-admins", async () => {
    const token = await createAccessToken({ sub: 2, email: "u@test.com", role: "user" });
    const { status } = await testJson("/api/admin/transcripts", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: 3, language: "en", s3Key: "x" }),
    });
    expect(status).toBe(403);
  });
});
