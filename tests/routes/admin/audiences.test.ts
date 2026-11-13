/**
 * Access rules are keyed on audience slugs (src/services/access.ts). On
 * 2026-11-04 an admin renamed "free-anyone" and "free-subscribers" from the
 * audience form, and every public event went behind a login. Built-in slugs
 * are now locked; names stay editable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const { mockDb, updateSet } = vi.hoisted(() => {
  const updateSet = vi.fn((_data: unknown) => ({
    where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 7, slug: "free-anyone" }])) })),
  }));
  const mockDb = {
    query: { audiences: { findFirst: vi.fn() } },
    update: vi.fn(() => ({ set: updateSet })),
    delete: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 14 }])) })) })),
  };
  return { mockDb, updateSet };
});

vi.mock("../../../src/db/index.ts", () => ({ db: mockDb }));

import { createAccessToken } from "../../../src/services/auth.ts";

const auth = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role: "admin" })}`,
});

const put = async (body: unknown) =>
  testJson("/api/admin/audiences/7", { method: "PUT", headers: await auth(), body: JSON.stringify(body) });

describe("admin audiences", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should refuse to change the slug of a built-in audience", async () => {
    mockDb.query.audiences.findFirst.mockResolvedValueOnce({ id: 7, slug: "free-anyone" });
    const { status } = await put({ nameEn: "Everyone Free Tier", slug: "everyone-free" });
    expect(status).toBe(409);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("should refuse to change the slug of a membership-optional audience", async () => {
    mockDb.query.audiences.findFirst.mockResolvedValueOnce({ id: 21, slug: "account-holders" });
    const { status } = await put({ nameEn: "Anyone", slug: "anyone" });
    expect(status).toBe(409);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("should still rename a built-in audience when its slug is unchanged", async () => {
    mockDb.query.audiences.findFirst.mockResolvedValueOnce({ id: 7, slug: "free-anyone" });
    const { status } = await put({ nameEn: "Everyone Free Tier", slug: "free-anyone" });
    expect(status).toBe(200);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ nameEn: "Everyone Free Tier" }));
  });

  it("should let an admin change the slug of an audience they created", async () => {
    mockDb.query.audiences.findFirst.mockResolvedValueOnce({ id: 14, slug: "custom-tier" });
    const { status } = await put({ nameEn: "Custom", slug: "custom" });
    expect(status).toBe(200);
  });

  it("should refuse to delete a built-in audience", async () => {
    mockDb.query.audiences.findFirst.mockResolvedValueOnce({ id: 7, slug: "free-anyone" });
    const { status } = await testJson("/api/admin/audiences/7", { method: "DELETE", headers: await auth() });
    expect(status).toBe(409);
    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});
