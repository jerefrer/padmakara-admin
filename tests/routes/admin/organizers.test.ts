import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const { mockDb, insertValues } = vi.hoisted(() => {
  const insertValues = vi.fn((_data: unknown) => ({
    returning: vi.fn(() => Promise.resolve([{ id: 3, name: "Stupa", abbreviation: null }])),
  }));
  const mockDb = {
    query: { organizers: { findFirst: vi.fn() } },
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) })) })),
    })),
    delete: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) })) })),
  };
  return { mockDb, insertValues };
});

vi.mock("../../../src/db/index.ts", () => ({ db: mockDb }));

import { createAccessToken } from "../../../src/services/auth.ts";

const auth = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role: "admin" })}`,
});

describe("admin organizers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should create an organizer from a name and abbreviation", async () => {
    const { status } = await testJson("/api/admin/organizers", {
      method: "POST",
      headers: await auth(),
      body: JSON.stringify({ name: "Stupa", abbreviation: "ST" }),
    });
    expect(status).toBe(201);
    expect(insertValues).toHaveBeenCalledWith({ name: "Stupa", abbreviation: "ST" });
  });

  it("should reject an organizer without a name", async () => {
    const { status } = await testJson("/api/admin/organizers", {
      method: "POST",
      headers: await auth(),
      body: JSON.stringify({ abbreviation: "ST" }),
    });
    expect(status).toBe(400);
  });

  it("should return 404 for an unknown organizer", async () => {
    mockDb.query.organizers.findFirst.mockResolvedValueOnce(undefined);
    const { status } = await testJson("/api/admin/organizers/99", { headers: await auth() });
    expect(status).toBe(404);
  });

  it("should return 404 when updating or deleting an unknown organizer", async () => {
    const put = await testJson("/api/admin/organizers/99", {
      method: "PUT", headers: await auth(), body: JSON.stringify({ name: "X" }),
    });
    const del = await testJson("/api/admin/organizers/99", { method: "DELETE", headers: await auth() });
    expect([put.status, del.status]).toEqual([404, 404]);
  });
});
