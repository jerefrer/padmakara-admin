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
      insert: mockInsert,
      update: mockUpdate,
      delete: mockDelete,
      query: { eventFiles: { findFirst: vi.fn(() => Promise.resolve(null)) } },
      _returning: mockReturning,
    },
  };
});

vi.mock("../../../src/services/s3.ts", () => ({
  deleteObject: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpVersion: vi.fn(() => Promise.resolve()),
}));

import { db } from "../../../src/db/index.ts";
import { deleteObject } from "../../../src/services/s3.ts";
import { createAccessToken } from "../../../src/services/auth.ts";

const mockReturning = (db as any)._returning as ReturnType<typeof vi.fn>;
const mockDeleteObject = deleteObject as ReturnType<typeof vi.fn>;
const adminToken = () => createAccessToken({ sub: 1, email: "a@test.com", role: "admin" });

describe("event-files admin resource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a row (201)", async () => {
    mockReturning.mockResolvedValueOnce([{ id: 7, eventId: 3, originalFilename: "n.pdf" }]);
    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/event-files", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: 3, originalFilename: "n.pdf", s3Key: "events/E/document/n.pdf",
        fileType: "document", extension: "pdf",
      }),
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({ id: 7, eventId: 3 });
  });

  it("deletes the row and the S3 object", async () => {
    mockReturning.mockResolvedValueOnce([{ id: 7, eventId: 3, s3Key: "events/E/document/n.pdf" }]);
    const token = await adminToken();
    const { status } = await testJson("/api/admin/event-files/7", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
    expect(mockDeleteObject).toHaveBeenCalledWith("events/E/document/n.pdf");
  });

  it("returns 404 deleting a missing row", async () => {
    mockReturning.mockResolvedValueOnce([]);
    const token = await adminToken();
    const { status } = await testJson("/api/admin/event-files/999", {
      method: "DELETE", headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(404);
  });

  it("rejects non-admins (403)", async () => {
    const token = await createAccessToken({ sub: 2, email: "u@test.com", role: "user" });
    const { status } = await testJson("/api/admin/event-files", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: 3, originalFilename: "n.pdf", s3Key: "x", fileType: "document", extension: "pdf" }),
    });
    expect(status).toBe(403);
  });
});
