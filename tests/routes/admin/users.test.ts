import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks (must come before route imports) ──────────────────────────────
// NOTE: vi.mock factories are hoisted to the top of the file, so they cannot
// reference variables declared outside the factory. All mock setup must be
// done inline or via vi.fn() returned from the factory.

vi.mock("../../../src/db/index.ts", () => {
  const mockInsertValues = vi.fn(() => Promise.resolve([]));
  const mockInsert = vi.fn(() => ({ values: mockInsertValues }));
  const mockDeleteWhere = vi.fn(() => Promise.resolve([]));
  const mockDelete = vi.fn(() => ({ where: mockDeleteWhere }));
  const mockUpdateWhere = vi.fn(() => ({
    returning: vi.fn(() => Promise.resolve([])),
  }));
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));

  return {
    db: {
      insert: mockInsert,
      delete: mockDelete,
      update: mockUpdate,
      query: {
        users: {
          findFirst: vi.fn(() => Promise.resolve(null)),
          findMany: vi.fn(() => Promise.resolve([])),
        },
      },
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([{ count: 0 }])),
          orderBy: vi.fn(() => Promise.resolve([])),
        })),
      })),
    },
  };
});

vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpUserAccessVersion: vi.fn(() => Promise.resolve()),
  getAllVersions: vi.fn(() => Promise.resolve({})),
  getUserVersion: vi.fn(() => Promise.resolve(0)),
  bumpVersion: vi.fn(() => Promise.resolve()),
  bumpVersions: vi.fn(() => Promise.resolve()),
}));

import { bumpUserAccessVersion } from "../../../src/services/sync-versions.ts";
import { db } from "../../../src/db/index.ts";
import { createAccessToken } from "../../../src/services/auth.ts";
import { Hono } from "hono";
import { userRoutes } from "../../../src/routes/admin/users.ts";

async function adminToken() {
  return createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
}

function buildApp() {
  const app = new Hono();
  app.route("/admin/users", userRoutes);
  return app;
}

describe("POST /admin/users/:id/events — bumpUserAccessVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-setup insert mock to succeed
    (db.insert as any).mockReturnValue({
      values: vi.fn(() => Promise.resolve([])),
    });
  });

  it("calls bumpUserAccessVersion with the correct userId after adding an event", async () => {
    const app = buildApp();
    const token = await adminToken();

    const res = await app.request(
      "/admin/users/42/events",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ eventId: 99 }),
      },
    );

    expect(res.status).toBe(201);
    // Give the fire-and-forget microtask a tick to resolve
    await Promise.resolve();
    expect(bumpUserAccessVersion).toHaveBeenCalledWith(42);
  });
});

describe("DELETE /admin/users/:id/events/:eventId — bumpUserAccessVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.delete as any).mockReturnValue({
      where: vi.fn(() => Promise.resolve([])),
    });
  });

  it("calls bumpUserAccessVersion with the correct userId after removing an event", async () => {
    const app = buildApp();
    const token = await adminToken();

    const res = await app.request(
      "/admin/users/42/events/99",
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    expect(res.status).toBe(200);
    await Promise.resolve();
    expect(bumpUserAccessVersion).toHaveBeenCalledWith(42);
  });
});

describe("POST /admin/users/:id/groups — bumpUserAccessVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.insert as any).mockReturnValue({
      values: vi.fn(() => Promise.resolve([])),
    });
  });

  it("calls bumpUserAccessVersion with the correct userId after adding a group", async () => {
    const app = buildApp();
    const token = await adminToken();

    const res = await app.request(
      "/admin/users/7/groups",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ retreatGroupId: 3 }),
      },
    );

    expect(res.status).toBe(201);
    await Promise.resolve();
    expect(bumpUserAccessVersion).toHaveBeenCalledWith(7);
  });
});

describe("DELETE /admin/users/:id/groups/:groupId — bumpUserAccessVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.delete as any).mockReturnValue({
      where: vi.fn(() => Promise.resolve([])),
    });
  });

  it("calls bumpUserAccessVersion with the correct userId after removing a group", async () => {
    const app = buildApp();
    const token = await adminToken();

    const res = await app.request(
      "/admin/users/7/groups/3",
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    expect(res.status).toBe(200);
    await Promise.resolve();
    expect(bumpUserAccessVersion).toHaveBeenCalledWith(7);
  });
});

describe("PUT /admin/users/:id — bumpUserAccessVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls bumpUserAccessVersion after a successful user update", async () => {
    const mockReturning = vi.fn(() =>
      Promise.resolve([
        {
          id: 5,
          email: "user@test.com",
          firstName: "Test",
          lastName: "User",
          dharmaName: null,
          preferredLanguage: "en",
          role: "user",
          isActive: true,
          isVerified: true,
          subscriptionStatus: "active",
          subscriptionSource: null,
          subscriptionExpiresAt: null,
          subscriptionNotes: null,
          lastActivity: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
    );
    const mockWhere = vi.fn(() => ({ returning: mockReturning }));
    const mockSet = vi.fn(() => ({ where: mockWhere }));
    (db.update as any).mockReturnValue({ set: mockSet });

    const app = buildApp();
    const token = await adminToken();

    const res = await app.request(
      "/admin/users/5",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ role: "admin" }),
      },
    );

    expect(res.status).toBe(200);
    await Promise.resolve();
    expect(bumpUserAccessVersion).toHaveBeenCalledWith(5);
  });
});
