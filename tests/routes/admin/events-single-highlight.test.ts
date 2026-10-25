import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const { mockDb, mockTx, txSets, dbSets, bumpVersion } = vi.hoisted(() => {
  const txSets: Record<string, unknown>[] = [];
  const dbSets: Record<string, unknown>[] = [];
  const bumpVersion = vi.fn(() => Promise.resolve());
  const mockTx = {
    update: vi.fn(() => ({
      set: vi.fn((data: Record<string, unknown>) => {
        txSets.push(data);
        return { where: vi.fn(() => Promise.resolve([])) };
      }),
    })),
  };
  const mockDb = {
    query: { events: { findFirst: vi.fn() } },
    transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
    update: vi.fn(() => ({
      set: vi.fn((data: Record<string, unknown>) => {
        dbSets.push(data);
        return { where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 5 }])) })) };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 5 }])) })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 5 }])) })),
    })),
  };
  return { mockDb, mockTx, txSets, dbSets, bumpVersion };
});

vi.mock("../../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../../src/services/sync-versions.ts", () => ({ bumpVersion }));

import { createAccessToken } from "../../../src/services/auth.ts";

const auth = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role: "admin" })}`,
});

const fullEvent = {
  id: 5,
  eventCode: "E5",
  status: "published",
  featuredAt: null,
  eventTeachers: [],
  eventRetreatGroups: [],
  eventPlaces: [],
  eventPublications: [],
  eventOrganizers: [],
};

describe("admin events: single highlight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txSets.length = 0;
    dbSets.length = 0;
    mockDb.query.events.findFirst.mockResolvedValue(structuredClone(fullEvent));
  });

  describe("POST /:id/feature", () => {
    it("should clear every other highlight and set the target in one transaction", async () => {
      const { status, body } = await testJson("/api/admin/events/5/feature", {
        method: "POST",
        headers: await auth(),
      });
      expect(status).toBe(200);
      expect(body.id).toBe(5);
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(txSets).toHaveLength(2);
      expect(txSets[0]).toMatchObject({ featuredAt: null });
      expect(txSets[1]!.featuredAt).toBeInstanceOf(Date);
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(bumpVersion).toHaveBeenCalledWith("events");
    });

    it("should return 404 when the event does not exist", async () => {
      mockDb.query.events.findFirst.mockResolvedValue(undefined);
      const { status } = await testJson("/api/admin/events/99/feature", {
        method: "POST",
        headers: await auth(),
      });
      expect(status).toBe(404);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("should return 409 EVENT_NOT_PUBLISHED when the event is a draft", async () => {
      mockDb.query.events.findFirst.mockResolvedValue({ ...fullEvent, status: "draft" });
      const { status, body } = await testJson("/api/admin/events/5/feature", {
        method: "POST",
        headers: await auth(),
      });
      expect(status).toBe(409);
      expect(body.code ?? body.error?.code).toBe("EVENT_NOT_PUBLISHED");
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
  });

  describe("PUT /:id", () => {
    it("should ignore featuredAt sent in the body", async () => {
      const { status } = await testJson("/api/admin/events/5", {
        method: "PUT",
        headers: await auth(),
        body: JSON.stringify({ titleEn: "Renamed", featuredAt: "2026-01-01T00:00:00.000Z" }),
      });
      expect(status).toBe(200);
      expect(dbSets[0]).not.toHaveProperty("featuredAt");
    });

    it("should return 409 FEATURED_EVENT_LOCKED when unpublishing the featured event", async () => {
      mockDb.query.events.findFirst.mockResolvedValue({
        ...fullEvent,
        featuredAt: new Date(),
      });
      const { status, body } = await testJson("/api/admin/events/5", {
        method: "PUT",
        headers: await auth(),
        body: JSON.stringify({ status: "draft" }),
      });
      expect(status).toBe(409);
      expect(body.code ?? body.error?.code).toBe("FEATURED_EVENT_LOCKED");
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("should unpublish an event that is not featured", async () => {
      const { status } = await testJson("/api/admin/events/5", {
        method: "PUT",
        headers: await auth(),
        body: JSON.stringify({ status: "archived" }),
      });
      expect(status).toBe(200);
      expect(dbSets[0]).toMatchObject({ status: "archived" });
    });

    it("should allow saving the featured event while it stays published", async () => {
      mockDb.query.events.findFirst.mockResolvedValue({ ...fullEvent, featuredAt: new Date() });
      const { status } = await testJson("/api/admin/events/5", {
        method: "PUT",
        headers: await auth(),
        body: JSON.stringify({ status: "published", titleEn: "X" }),
      });
      expect(status).toBe(200);
    });
  });

  describe("POST /", () => {
    it("should never feature a new event even if featuredAt is sent", async () => {
      const values = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 5 }])) }));
      mockDb.insert.mockReturnValueOnce({ values } as never);
      const { status } = await testJson("/api/admin/events", {
        method: "POST",
        headers: await auth(),
        body: JSON.stringify({
          eventCode: "E5", titleEn: "T", startDate: "2026-01-01", endDate: "2026-01-02",
          featuredAt: "2026-01-01T00:00:00.000Z",
        }),
      });
      expect(status).toBe(201);
      const inserted = (values.mock.calls[0] as unknown as Record<string, unknown>[])[0]!;
      expect(inserted.featuredAt ?? null).toBeNull();
    });
  });

  describe("DELETE /:id", () => {
    it("should return 409 FEATURED_EVENT_LOCKED when deleting the featured event", async () => {
      mockDb.query.events.findFirst.mockResolvedValue({ ...fullEvent, featuredAt: new Date() });
      const { status, body } = await testJson("/api/admin/events/5", {
        method: "DELETE",
        headers: await auth(),
      });
      expect(status).toBe(409);
      expect(body.code ?? body.error?.code).toBe("FEATURED_EVENT_LOCKED");
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("should delete an event that is not featured", async () => {
      const { status } = await testJson("/api/admin/events/5", {
        method: "DELETE",
        headers: await auth(),
      });
      expect(status).toBe(200);
      expect(mockDb.delete).toHaveBeenCalled();
    });
  });
});
