import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

// The admin publication routes keep three links next to the row: the linked
// events (legacy), the retreat groups and the access list. The database is a
// recorder: inserts and deletes are noted per table, reads come from `rows`.

const { mockDb, inserted, deleted, rows } = vi.hoisted(() => {
  const nameOf = (table: Record<symbol, unknown>) => table[Symbol.for("drizzle:Name")] as string;
  const inserted: Record<string, unknown[]> = {};
  const deleted: string[] = [];
  const rows: Record<string, unknown[]> = {};
  const publication = { id: 5, title: "T", pdfS3Key: "k.pdf", audienceId: 13, coverImageS3Key: null };

  const mockDb = {
    query: { publications: { findFirst: vi.fn(() => Promise.resolve(publication)) } },
    select: vi.fn(() => ({
      from: (table: Record<symbol, unknown>) => {
        const result = () => Promise.resolve(rows[nameOf(table)] ?? []);
        return {
          where: result,
          then: (ok: (v: unknown) => unknown) => result().then(ok),
        };
      },
    })),
    insert: vi.fn((table: Record<symbol, unknown>) => ({
      values: (values: unknown) => {
        const list = Array.isArray(values) ? values : [values];
        inserted[nameOf(table)] = [...(inserted[nameOf(table)] ?? []), ...list];
        return { returning: () => Promise.resolve([{ ...publication, ...(list[0] as object) }]) };
      },
    })),
    update: vi.fn(() => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([publication]) }) }),
    })),
    delete: vi.fn((table: Record<symbol, unknown>) => ({
      where: () => {
        deleted.push(nameOf(table));
        return Promise.resolve([]);
      },
    })),
  };
  return { mockDb, inserted, deleted, rows };
});

vi.mock("../../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() => Promise.resolve("https://s3.example.com/x")),
  generatePresignedUploadUrl: vi.fn(),
  putObject: vi.fn(),
}));
vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpVersion: vi.fn(() => Promise.resolve()),
}));

import { createAccessToken } from "../../../src/services/auth.ts";

const auth = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role: "admin" })}`,
});

const send = async (method: string, path: string, body?: unknown) =>
  testJson(path, { method, headers: await auth(), body: body ? JSON.stringify(body) : undefined });

describe("admin publications: retreat groups and access list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // PDF metadata extraction fails offline and is logged; the routes carry on.
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const key of Object.keys(inserted)) delete inserted[key];
    for (const key of Object.keys(rows)) delete rows[key];
    deleted.length = 0;
  });

  describe("POST /api/admin/publications", () => {
    it("should store the ticked retreat groups and the access list", async () => {
      const { status, body } = await send("POST", "/api/admin/publications", {
        title: "T",
        pdfS3Key: "k.pdf",
        audienceId: 13,
        retreatGroupIds: [2, 3, 3],
        accessUserIds: [10, 11],
      });

      expect(status).toBe(201);
      expect(inserted["publication_retreat_groups"]).toEqual([
        { publicationId: 5, retreatGroupId: 2 },
        { publicationId: 5, retreatGroupId: 3 },
      ]);
      expect(inserted["publication_access_users"]).toEqual([
        { publicationId: 5, userId: 10 },
        { publicationId: 5, userId: 11 },
      ]);
      expect(body.retreatGroupIds).toEqual([2, 3]);
      expect(body.accessUserIds).toEqual([10, 11]);
    });

    it("should store no group and no user when none is sent", async () => {
      const { status } = await send("POST", "/api/admin/publications", {
        title: "T",
        pdfS3Key: "k.pdf",
        audienceId: 7,
      });

      expect(status).toBe(201);
      expect(inserted["publication_retreat_groups"]).toBeUndefined();
      expect(inserted["publication_access_users"]).toBeUndefined();
    });

    it("should reject a group id that is not a number", async () => {
      const { status } = await send("POST", "/api/admin/publications", {
        title: "T",
        pdfS3Key: "k.pdf",
        audienceId: 10,
        retreatGroupIds: ["x"],
      });
      expect(status).toBe(400);
    });
  });

  describe("PUT /api/admin/publications/:id", () => {
    it("should replace the groups and the access list when they are sent", async () => {
      const { status } = await send("PUT", "/api/admin/publications/5", {
        retreatGroupIds: [4],
        accessUserIds: [12],
      });

      expect(status).toBe(200);
      expect(deleted).toEqual(expect.arrayContaining(["publication_retreat_groups", "publication_access_users"]));
      expect(inserted["publication_retreat_groups"]).toEqual([{ publicationId: 5, retreatGroupId: 4 }]);
      expect(inserted["publication_access_users"]).toEqual([{ publicationId: 5, userId: 12 }]);
    });

    it("should clear the groups when an empty list is sent", async () => {
      await send("PUT", "/api/admin/publications/5", { retreatGroupIds: [] });

      expect(deleted).toContain("publication_retreat_groups");
      expect(inserted["publication_retreat_groups"]).toBeUndefined();
    });

    it("should leave the groups, the access list and the linked events alone when they are not sent", async () => {
      await send("PUT", "/api/admin/publications/5", { title: "New title" });

      expect(deleted).toEqual([]);
      expect(inserted).toEqual({});
    });
  });

  describe("GET /api/admin/publications/:id", () => {
    it("should return the group ids, the access list ids and who they are", async () => {
      rows["publication_retreat_groups"] = [{ retreatGroupId: 2 }, { retreatGroupId: 3 }];
      rows["publication_access_users"] = [{ userId: 10 }];
      rows["event_publications"] = [{ eventId: 900 }];
      rows["users"] = [{ id: 10, email: "a@b.pt", firstName: "Ana", lastName: "Silva" }];

      const { status, body } = await send("GET", "/api/admin/publications/5");

      expect(status).toBe(200);
      expect(body.retreatGroupIds).toEqual([2, 3]);
      expect(body.accessUserIds).toEqual([10]);
      expect(body.accessUsers).toEqual([{ id: 10, email: "a@b.pt", firstName: "Ana", lastName: "Silva" }]);
      expect(body.eventIds).toEqual([900]);
    });
  });
});
