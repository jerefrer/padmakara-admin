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
vi.mock("../../../src/services/s3.ts", () => ({ deleteObject: vi.fn(() => Promise.resolve()) }));
vi.mock("../../../src/services/sync-versions.ts", () => ({ bumpVersion: vi.fn(() => Promise.resolve()) }));

import { db } from "../../../src/db/index.ts";
import { deleteObject } from "../../../src/services/s3.ts";
import { createAccessToken } from "../../../src/services/auth.ts";

const mockReturning = (db as any)._returning as ReturnType<typeof vi.fn>;
const mockValues = (db as any)._values as ReturnType<typeof vi.fn>;
const mockDeleteObject = deleteObject as ReturnType<typeof vi.fn>;
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
