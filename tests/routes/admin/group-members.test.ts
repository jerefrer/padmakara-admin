import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson, testRequest } from "../../helpers.ts";

const h = vi.hoisted(() => ({
  selectRows: [] as any[],
  insertReturning: [] as any[][],
  deleteRows: [] as any[],
  found: true as boolean,
}));

vi.mock("../../../src/db/index.ts", () => {
  const thenable = (rows: any[]) => {
    const chain: any = {};
    for (const m of ["from", "innerJoin", "where", "orderBy"]) chain[m] = () => chain;
    chain.then = (res: any, rej: any) => Promise.resolve(rows).then(res, rej);
    return chain;
  };
  return {
    db: {
      select: vi.fn(() => thenable(h.selectRows)),
      insert: vi.fn(() => ({
        values: () => ({ onConflictDoNothing: () => ({ returning: () => Promise.resolve(h.insertReturning.shift() ?? []) }) }),
      })),
      delete: vi.fn(() => ({ where: () => ({ returning: () => Promise.resolve(h.deleteRows) }) })),
      query: { retreatGroups: { findFirst: vi.fn(() => Promise.resolve(h.found ? { id: 5 } : undefined)) } },
    },
  };
});
vi.mock("../../../src/services/users-lookup.ts", () => ({ findOrCreateUserByEmail: vi.fn() }));
vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpUserAccessVersion: vi.fn(() => Promise.resolve()),
  bumpVersion: vi.fn(() => Promise.resolve()),
  bumpVersions: vi.fn(() => Promise.resolve()),
  getAllVersions: vi.fn(() => Promise.resolve({})),
  getUserVersion: vi.fn(() => Promise.resolve(0)),
}));

import { createAccessToken } from "../../../src/services/auth.ts";
import { findOrCreateUserByEmail } from "../../../src/services/users-lookup.ts";
import { bumpUserAccessVersion } from "../../../src/services/sync-versions.ts";

const adminAuth = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role: "admin" })}`,
});
const userAuth = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 2, email: "u@test.com", role: "user" })}`,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.selectRows = [];
  h.insertReturning = [];
  h.deleteRows = [];
  h.found = true;
  let nextId = 100;
  vi.mocked(findOrCreateUserByEmail).mockImplementation(async ({ email }: any) => ({
    user: { id: nextId++, email, preferredLanguage: "pt" },
    created: false,
  }));
});

describe("admin group members: auth", () => {
  it("should return 401 without a token", async () => {
    const res = await testRequest("/api/admin/groups/5/members");
    expect(res.status).toBe(401);
  });

  it("should return 403 for a non-admin on GET, POST and DELETE", async () => {
    const headers = await userAuth();
    const get = await testJson("/api/admin/groups/5/members", { headers });
    const post = await testJson("/api/admin/groups/5/members", {
      method: "POST",
      headers,
      body: JSON.stringify({ emails: ["a@b.co"] }),
    });
    const del = await testJson("/api/admin/groups/5/members/9", { method: "DELETE", headers });
    expect([get.status, post.status, del.status]).toEqual([403, 403, 403]);
  });
});

describe("GET /api/admin/groups/:id/members", () => {
  it("should list members sorted by name then email", async () => {
    const at = new Date("2026-11-01T10:00:00Z");
    h.selectRows = [
      { id: 3, email: "z@x.com", firstName: "Rui", lastName: "Pinto", joinedAt: at },
      { id: 1, email: "b@x.com", firstName: "Ana", lastName: "Silva", joinedAt: at },
      { id: 2, email: "a@x.com", firstName: null, lastName: null, joinedAt: at },
      { id: 4, email: "a2@x.com", firstName: "Ana", lastName: "Silva", joinedAt: at },
    ];
    const { status, body } = await testJson("/api/admin/groups/5/members", { headers: await adminAuth() });
    expect(status).toBe(200);
    expect(body.map((p: any) => p.email)).toEqual(["a@x.com", "a2@x.com", "b@x.com", "z@x.com"]);
    expect(body[1]).toEqual({ id: 4, email: "a2@x.com", name: "Ana Silva", registeredAt: at.toISOString() });
  });

  it("should return 404 when the group does not exist", async () => {
    h.found = false;
    const { status } = await testJson("/api/admin/groups/5/members", { headers: await adminAuth() });
    expect(status).toBe(404);
  });
});

describe("POST /api/admin/groups/:id/members", () => {
  const post = async (body: unknown) =>
    testJson("/api/admin/groups/5/members", {
      method: "POST",
      headers: await adminAuth(),
      body: JSON.stringify(body),
    });

  it("should split added, alreadyHad, created and invalid, deduping addresses", async () => {
    vi.mocked(findOrCreateUserByEmail).mockImplementation(async ({ email }: any) => ({
      user: { id: email.startsWith("new") ? 101 : 102, email, preferredLanguage: "pt" },
      created: email.startsWith("new"),
    }));
    // new@x.com inserted; had@x.com conflicts; known@x.com inserted without a new account
    h.insertReturning = [[{ userId: 101 }], [], [{ userId: 102 }]];

    const { status, body } = await post({
      emails: ["New@X.com", " had@x.com ", "known@x.com", "not-an-email", "new@x.com", "not-an-email"],
    });

    expect(status).toBe(200);
    expect(body).toEqual({
      added: ["new@x.com", "known@x.com"],
      alreadyHad: ["had@x.com"],
      created: ["new@x.com"],
      invalid: ["not-an-email"],
    });
    expect(findOrCreateUserByEmail).toHaveBeenCalledTimes(3);
  });

  it("should bump the access version only for people actually added", async () => {
    h.insertReturning = [[{ userId: 100 }], []];
    await post({ emails: ["a@x.com", "b@x.com"] });
    expect(bumpUserAccessVersion).toHaveBeenCalledTimes(1);
    expect(bumpUserAccessVersion).toHaveBeenCalledWith(100);
  });

  it("should pass the chosen language when creating accounts", async () => {
    await post({ emails: ["a@x.com"], language: "en" });
    expect(findOrCreateUserByEmail).toHaveBeenCalledWith({ email: "a@x.com", language: "en" });
  });

  it("should accept exactly 1000 emails and refuse 1001 with TOO_MANY_EMAILS", async () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => `p${i}@x.com`);
    expect((await post({ emails: make(1000) })).status).toBe(200);
    const over = await post({ emails: make(1001) });
    expect(over.status).toBe(400);
    expect(over.body.code ?? over.body.error?.code).toBe("TOO_MANY_EMAILS");
  });

  it("should refuse an empty list", async () => {
    expect((await post({ emails: [] })).status).toBe(400);
  });

  it("should return 404 when the group does not exist", async () => {
    h.found = false;
    expect((await post({ emails: ["a@x.com"] })).status).toBe(404);
  });
});

describe("DELETE /api/admin/groups/:id/members/:userId", () => {
  const del = async () =>
    testRequest("/api/admin/groups/5/members/9", { method: "DELETE", headers: await adminAuth() });

  it("should answer 204 and bump the access version", async () => {
    h.deleteRows = [{ userId: 9 }];
    const res = await del();
    expect(res.status).toBe(204);
    expect(bumpUserAccessVersion).toHaveBeenCalledWith(9);
  });

  it("should answer 404 when the person is not a member", async () => {
    const res = await del();
    expect(res.status).toBe(404);
    expect(bumpUserAccessVersion).not.toHaveBeenCalled();
  });
});
