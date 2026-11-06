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
      // The transaction runs on the same mock, which each test configures.
      transaction: vi.fn((fn: (tx: unknown) => unknown) => fn({ update: mockUpdate })),
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

vi.mock("../../../src/services/user-access.ts", () => ({
  listUserEventGrants: vi.fn(() => Promise.resolve([])),
  listUserPublications: vi.fn(() => Promise.resolve([])),
  replaceUserGroups: vi.fn(() => Promise.resolve()),
  replaceUserAttendance: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpUserAccessVersion: vi.fn(() => Promise.resolve()),
  getAllVersions: vi.fn(() => Promise.resolve({})),
  getUserVersion: vi.fn(() => Promise.resolve(0)),
  bumpVersion: vi.fn(() => Promise.resolve()),
  bumpVersions: vi.fn(() => Promise.resolve()),
}));

import { bumpUserAccessVersion } from "../../../src/services/sync-versions.ts";
import { replaceUserAttendance, replaceUserGroups } from "../../../src/services/user-access.ts";
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

describe("GET /admin/users — search", () => {
  beforeEach(() => vi.clearAllMocks());

  const list = async (query: string) => {
    const res = await buildApp().request(`/admin/users${query}`, {
      headers: { Authorization: `Bearer ${await adminToken()}` },
    });
    return res.status;
  };

  it("should filter by name or email when q is given", async () => {
    expect(await list("?q=ana")).toBe(200);

    const options = (db.query.users.findMany as any).mock.calls[0][0];
    expect(options.where).toBeDefined();
  });

  it("should not filter when q is absent", async () => {
    expect(await list("")).toBe(200);

    const options = (db.query.users.findMany as any).mock.calls[0][0];
    expect(options.where).toBeUndefined();
  });
});

describe("isReviewAccount flag", () => {
  beforeEach(() => vi.clearAllMocks());
  const headers = async () => ({ Authorization: `Bearer ${await adminToken()}` });

  it("should flag only the review account in the list", async () => {
    (db.query.users.findMany as any).mockResolvedValueOnce([
      { id: 1, email: "review@padmakara.pt" },
      { id: 2, email: "someone@test.com" },
    ]);

    const res = await buildApp().request("/admin/users", { headers: await headers() });
    const body = (await res.json()) as any[];

    expect(body.map((u) => u.isReviewAccount)).toEqual([true, false]);
  });

  it("should flag the review account on the detail endpoint", async () => {
    (db.query.users.findFirst as any).mockResolvedValueOnce({
      id: 1,
      email: "Review@padmakara.pt",
      groupMemberships: [],
      eventAttendance: [],
    });

    const res = await buildApp().request("/admin/users/1", { headers: await headers() });

    expect(((await res.json()) as any).isReviewAccount).toBe(true);
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

  const saveUser = async (body: unknown, returned: unknown[] = [{ id: 5, email: "user@test.com" }]) => {
    const mockWhere = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve(returned)) }));
    (db.update as any).mockReturnValue({ set: vi.fn(() => ({ where: mockWhere })) });
    return buildApp().request("/admin/users/5", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await adminToken()}` },
      body: JSON.stringify(body),
    });
  };

  it("should replace groups and attended events when they are sent", async () => {
    const res = await saveUser({ retreatGroupIds: [1, 2], attendedEventIds: [] });

    expect(res.status).toBe(200);
    expect(replaceUserGroups).toHaveBeenCalledWith(expect.anything(), 5, [1, 2]);
    expect(replaceUserAttendance).toHaveBeenCalledWith(expect.anything(), 5, []);
    expect(await res.json()).toMatchObject({ retreatGroupIds: [1, 2], attendedEventIds: [] });
  });

  it("should leave groups and attended events alone when they are not sent", async () => {
    await saveUser({ firstName: "Ana" });

    expect(replaceUserGroups).not.toHaveBeenCalled();
    expect(replaceUserAttendance).not.toHaveBeenCalled();
  });

  it("should change nothing when the user does not exist", async () => {
    const res = await saveUser({ retreatGroupIds: [1] }, []);

    expect(res.status).not.toBe(200);
    expect(replaceUserGroups).not.toHaveBeenCalled();
    expect(bumpUserAccessVersion).not.toHaveBeenCalled();
  });

  it("should reject a list that is not made of ids", async () => {
    const res = await saveUser({ retreatGroupIds: ["all"] });

    expect(res.status).not.toBe(200);
    expect(replaceUserGroups).not.toHaveBeenCalled();
  });
});
