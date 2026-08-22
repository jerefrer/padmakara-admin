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

  it("persists a transcript row with default status=published", async () => {
    mockReturning.mockResolvedValueOnce([{ id: 11, eventId: 3, language: "en" }]);
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/transcripts", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: 3, language: "en", s3Key: "events/E/transcripts/t.pdf" }),
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({ id: 11, eventId: 3 });
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ status: "published" }));
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
