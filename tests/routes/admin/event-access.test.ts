import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson, testRequest } from "../../helpers.ts";

const h = vi.hoisted(() => ({
  selectQueue: [] as any[][],
  deleteRows: [] as any[],
  eventFound: true as boolean,
  existingSaleMode: "none",
  updateSet: undefined as any,
  insertValues: undefined as any,
}));

vi.mock("../../../src/db/index.ts", () => {
  const thenable = (rows: any[]) => {
    const chain: any = {};
    for (const m of ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit", "groupBy"]) {
      chain[m] = () => chain;
    }
    chain.then = (res: any, rej: any) => Promise.resolve(rows).then(res, rej);
    return chain;
  };
  const eventRow = () => ({
    id: 5,
    saleMode: h.existingSaleMode,
    priceCents: null,
    includedInMembership: false,
    eventTeachers: [],
    eventRetreatGroups: [],
    eventPlaces: [],
    eventOrganizers: [],
    eventPublications: [],
  });
  return {
    db: {
      select: vi.fn(() => thenable(h.selectQueue.shift() ?? [])),
      delete: vi.fn(() => ({
        where: () => ({ returning: () => Promise.resolve(h.deleteRows) }),
      })),
      insert: vi.fn(() => ({
        values: (v: any) => {
          h.insertValues = v;
          return { returning: () => Promise.resolve([{ id: 5, ...v }]) };
        },
      })),
      update: vi.fn(() => ({
        set: (v: any) => {
          h.updateSet = v;
          return { where: () => ({ returning: () => Promise.resolve([{ id: 5 }]) }) };
        },
      })),
      query: {
        events: {
          findFirst: vi.fn(() => Promise.resolve(h.eventFound ? eventRow() : undefined)),
        },
      },
    },
  };
});

vi.mock("../../../src/services/users-lookup.ts", () => ({
  findOrCreateUserByEmail: vi.fn(),
}));
vi.mock("../../../src/services/event-access.ts", () => ({
  grantEventAccess: vi.fn(),
}));
vi.mock("../../../src/services/teaching-orders.ts", () => ({
  sendTeachingAvailableEmail: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpUserAccessVersion: vi.fn(() => Promise.resolve()),
  bumpVersion: vi.fn(() => Promise.resolve()),
  bumpVersions: vi.fn(() => Promise.resolve()),
  getAllVersions: vi.fn(() => Promise.resolve({})),
  getUserVersion: vi.fn(() => Promise.resolve(0)),
}));

import { createAccessToken } from "../../../src/services/auth.ts";
import { findOrCreateUserByEmail } from "../../../src/services/users-lookup.ts";
import { grantEventAccess } from "../../../src/services/event-access.ts";
import { sendTeachingAvailableEmail } from "../../../src/services/teaching-orders.ts";
import { bumpUserAccessVersion } from "../../../src/services/sync-versions.ts";

const adminAuth = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role: "admin" })}`,
});
const userAuth = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 2, email: "u@test.com", role: "user" })}`,
});
const json = (body: unknown) => JSON.stringify(body);

beforeEach(() => {
  vi.clearAllMocks();
  h.selectQueue = [];
  h.deleteRows = [];
  h.eventFound = true;
  h.existingSaleMode = "none";
  h.updateSet = undefined;
  h.insertValues = undefined;
  let nextId = 100;
  vi.mocked(findOrCreateUserByEmail).mockImplementation(async ({ email }: any) => ({
    user: { id: nextId++, email, preferredLanguage: "pt" },
    created: true,
  }));
  vi.mocked(grantEventAccess).mockResolvedValue({ created: true });
});

describe("admin event access: auth", () => {
  it("should return 401 when no token is sent", async () => {
    const res = await testRequest("/api/admin/events/5/access");
    expect(res.status).toBe(401);
  });

  it("should return 403 when the user is not an admin", async () => {
    const { status } = await testJson("/api/admin/events/5/access", { headers: await userAuth() });
    expect(status).toBe(403);
  });

  it("should return 403 on POST and DELETE for a non-admin", async () => {
    const headers = await userAuth();
    const post = await testJson("/api/admin/events/5/access", {
      method: "POST",
      headers,
      body: json({ emails: ["a@b.co"], notify: false }),
    });
    const del = await testJson("/api/admin/events/5/access/9", { method: "DELETE", headers });
    expect([post.status, del.status]).toEqual([403, 403]);
  });
});

describe("GET /api/admin/events/:id/access", () => {
  it("should list grants with order and admin info, pending orders and stats", async () => {
    const created = new Date("2026-11-01T10:00:00Z");
    h.selectQueue = [
      [
        {
          userId: 10, email: "buyer@x.com", firstName: "Ana", lastName: "Silva", source: "purchase",
          orderId: 3, method: "mbw", amountCents: 1500, createdAt: created,
          grantedById: null, grantedByEmail: null, grantedByFirstName: null, grantedByLastName: null,
        },
        {
          userId: 11, email: "gift@x.com", firstName: null, lastName: null, source: "manual",
          orderId: null, method: null, amountCents: null, createdAt: created,
          grantedById: 1, grantedByEmail: "a@test.com", grantedByFirstName: "Andre", grantedByLastName: "Z",
        },
      ],
      [{ id: 4, email: "wait@x.com", firstName: "Rui", lastName: "P", amountCents: 1500, createdAt: created }],
      [{ paidCount: 1, collectedCents: 1500, pendingCount: 1 }],
    ];

    const { status, body } = await testJson("/api/admin/events/5/access", { headers: await adminAuth() });

    expect(status).toBe(200);
    expect(body.grants[0]).toMatchObject({
      userId: 10, email: "buyer@x.com", name: "Ana Silva", source: "purchase",
      orderId: 3, amountCents: 1500, grantedBy: null,
    });
    expect(body.grants[1]).toMatchObject({
      source: "manual", name: "", grantedBy: { id: 1, email: "a@test.com", name: "Andre Z" },
    });
    expect(body.pendingOrders).toEqual([
      { id: 4, email: "wait@x.com", name: "Rui P", amountCents: 1500, createdAt: created.toISOString() },
    ]);
    expect(body.stats).toEqual({ paidCount: 1, collectedCents: 1500, pendingCount: 1 });
  });

  it("should return zero stats when the event has no orders", async () => {
    h.selectQueue = [[], [], [{ paidCount: 0, collectedCents: 0, pendingCount: 0 }]];
    const { body } = await testJson("/api/admin/events/5/access", { headers: await adminAuth() });
    expect(body).toMatchObject({ grants: [], pendingOrders: [], stats: { paidCount: 0, collectedCents: 0, pendingCount: 0 } });
  });

  it("should return 404 when the event does not exist", async () => {
    h.eventFound = false;
    const { status } = await testJson("/api/admin/events/5/access", { headers: await adminAuth() });
    expect(status).toBe(404);
  });
});

describe("POST /api/admin/events/:id/access", () => {
  const post = async (body: unknown) =>
    testJson("/api/admin/events/5/access", { method: "POST", headers: await adminAuth(), body: json(body) });

  it("should grant manually with the admin as grantedBy and report added, alreadyHad and invalid", async () => {
    vi.mocked(grantEventAccess).mockImplementation(async ({ userId }: any) => ({ created: userId !== 101 }));

    const { status, body } = await post({
      emails: ["New@X.com", " had@x.com ", "not-an-email", "new@x.com"],
      notify: false,
    });

    expect(status).toBe(200);
    expect(body).toEqual({ added: ["new@x.com"], alreadyHad: ["had@x.com"], invalid: ["not-an-email"] });
    expect(findOrCreateUserByEmail).toHaveBeenCalledTimes(2);
    expect(grantEventAccess).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 5, source: "manual", grantedBy: 1 }),
    );
    expect(sendTeachingAvailableEmail).not.toHaveBeenCalled();
  });

  it("should report a repeated invalid address once", async () => {
    const { body } = await post({ emails: ["bad", "bad", "ok@x.com"], notify: false });
    expect(body.invalid).toEqual(["bad"]);
  });

  it("should email only newly added people when notify is true, in the chosen language", async () => {
    vi.mocked(grantEventAccess).mockImplementation(async ({ userId }: any) => ({ created: userId !== 101 }));

    await post({ emails: ["a@x.com", "b@x.com"], notify: true, language: "en" });

    expect(sendTeachingAvailableEmail).toHaveBeenCalledTimes(1);
    expect(sendTeachingAvailableEmail).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 5, email: "a@x.com", language: "en" }),
    );
  });

  it("should accept exactly 200 emails", async () => {
    const emails = Array.from({ length: 200 }, (_, i) => `p${i}@x.com`);
    const { status, body } = await post({ emails, notify: false });
    expect(status).toBe(200);
    expect(body.added).toHaveLength(200);
  });

  it("should reject more than 200 emails", async () => {
    const emails = Array.from({ length: 201 }, (_, i) => `p${i}@x.com`);
    const { status, body } = await post({ emails, notify: false });
    expect(status).toBe(400);
    expect(body.code ?? body.error?.code).toBe("TOO_MANY_EMAILS");
    expect(grantEventAccess).not.toHaveBeenCalled();
  });

  it("should reject a body without emails or notify", async () => {
    expect((await post({ notify: false })).status).toBe(400);
    expect((await post({ emails: ["a@x.com"] })).status).toBe(400);
    expect((await post({ emails: [], notify: false })).status).toBe(400);
  });

  it("should return 404 when the event does not exist", async () => {
    h.eventFound = false;
    expect((await post({ emails: ["a@x.com"], notify: false })).status).toBe(404);
  });
});

describe("DELETE /api/admin/events/:id/access/:userId", () => {
  it("should remove the grant and bump the user's sync version", async () => {
    h.deleteRows = [{ userId: 9 }];
    const { status } = await testJson("/api/admin/events/5/access/9", {
      method: "DELETE",
      headers: await adminAuth(),
    });
    expect(status).toBe(200);
    expect(bumpUserAccessVersion).toHaveBeenCalledWith(9);
  });

  it("should return 404 and not bump when there is no such grant", async () => {
    const { status } = await testJson("/api/admin/events/5/access/9", {
      method: "DELETE",
      headers: await adminAuth(),
    });
    expect(status).toBe(404);
    expect(bumpUserAccessVersion).not.toHaveBeenCalled();
  });
});

describe("admin event PUT: sale settings", () => {
  const put = async (body: unknown) =>
    testJson("/api/admin/events/5", { method: "PUT", headers: await adminAuth(), body: json(body) });

  it("should store a paid event with its price and membership flag", async () => {
    const { status } = await put({ saleMode: "paid", priceCents: 1500, includedInMembership: true });
    expect(status).toBe(200);
    expect(h.updateSet).toMatchObject({ saleMode: "paid", priceCents: 1500, includedInMembership: true });
  });

  it("should reject paid without a price", async () => {
    const { status } = await put({ saleMode: "paid" });
    expect(status).toBe(400);
    expect(h.updateSet).toBeUndefined();
  });

  it("should reject paid with a price below 100 cents", async () => {
    expect((await put({ saleMode: "paid", priceCents: 99 })).status).toBe(400);
  });

  it("should clear the price when the mode is not paid", async () => {
    await put({ saleMode: "free", priceCents: 1500 });
    expect(h.updateSet).toMatchObject({ saleMode: "free", priceCents: null });
  });

  it("should validate a price-only update against the stored paid mode", async () => {
    h.existingSaleMode = "paid";
    expect((await put({ priceCents: 50 })).status).toBe(400);
    expect((await put({ priceCents: 2000 })).status).toBe(200);
    expect(h.updateSet).toMatchObject({ priceCents: 2000 });
  });

  it("should not touch sale columns when none are sent", async () => {
    await put({ titleEn: "x" });
    expect(h.updateSet).not.toHaveProperty("saleMode");
    expect(h.updateSet).not.toHaveProperty("priceCents");
    expect(h.updateSet).not.toHaveProperty("includedInMembership");
  });

  it("should accept includedInMembership alone", async () => {
    const { status } = await put({ includedInMembership: true });
    expect(status).toBe(200);
    expect(h.updateSet).toMatchObject({ includedInMembership: true });
  });

  it("should reject a non-boolean includedInMembership", async () => {
    expect((await put({ includedInMembership: "yes" })).status).toBe(400);
  });
});

describe("admin event GET and POST: sale settings", () => {
  it("should return saleMode, priceCents and includedInMembership", async () => {
    h.existingSaleMode = "free";
    const { status, body } = await testJson("/api/admin/events/5", { headers: await adminAuth() });
    expect(status).toBe(200);
    expect(body).toMatchObject({ saleMode: "free", priceCents: null, includedInMembership: false });
  });

  it("should reject creating a paid event without a valid price", async () => {
    const { status } = await testJson("/api/admin/events", {
      method: "POST",
      headers: await adminAuth(),
      body: json({
        eventCode: "E", titleEn: "T", startDate: "2026-01-01", endDate: "2026-01-02", saleMode: "paid",
      }),
    });
    expect(status).toBe(400);
    expect(h.insertValues).toBeUndefined();
  });
});
