import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { testJson } from "../../helpers.ts";

// The admin sets a publication's status (draft / forthcoming / published) and
// filters the list by it. Writes are recorded; reads answer with `existing`.

const { mockDb, written, listWheres, existing } = vi.hoisted(() => {
  const written: { inserted: Record<string, unknown>[]; updated: Record<string, unknown>[] } = {
    inserted: [],
    updated: [],
  };
  const listWheres: unknown[] = [];
  const existing = { id: 5, title: "T", pdfS3Key: "k.pdf", audienceId: 7, coverImageS3Key: null, status: "draft" };

  // A list query: select().from().where(w).orderBy().limit().offset(), or the count.
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    c.where = (w: unknown) => {
      listWheres.push(w);
      return c;
    };
    c.orderBy = () => c;
    c.limit = () => c;
    c.offset = () => Promise.resolve(rows);
    c.then = (ok: (v: unknown) => unknown) => Promise.resolve([{ count: rows.length }]).then(ok);
    return c;
  };

  const mockDb = {
    query: { publications: { findFirst: vi.fn(() => Promise.resolve(existing)) } },
    select: vi.fn(() => ({ from: () => chain([existing]) })),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        written.inserted.push(values);
        return { returning: () => Promise.resolve([{ ...existing, ...values }]) };
      },
    })),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        written.updated.push(values);
        return { where: () => ({ returning: () => Promise.resolve([{ ...existing, ...values }]) }) };
      },
    })),
    delete: vi.fn(() => ({ where: () => Promise.resolve([]) })),
  };
  return { mockDb, written, listWheres, existing };
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
import { bumpVersion } from "../../../src/services/sync-versions.ts";

const dialect = new PgDialect();
const params = (where: unknown) => (where ? dialect.sqlToQuery(where as SQL).params : []);

const send = async (method: string, path: string, body?: unknown) =>
  testJson(path, {
    method,
    headers: {
      Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role: "admin" })}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

describe("admin publications: status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // PDF metadata extraction fails offline and is logged; the routes carry on.
    vi.spyOn(console, "error").mockImplementation(() => {});
    written.inserted.length = 0;
    written.updated.length = 0;
    listWheres.length = 0;
    existing.status = "draft";
  });

  it("should create a publication with the status chosen", async () => {
    const { status } = await send("POST", "/api/admin/publications", {
      title: "T",
      pdfS3Key: "k.pdf",
      audienceId: 7,
      status: "forthcoming",
    });

    expect(status).toBe(201);
    expect(written.inserted[0]).toMatchObject({ status: "forthcoming" });
  });

  it("should refuse a status that is not draft, forthcoming or published", async () => {
    const { status } = await send("POST", "/api/admin/publications", {
      title: "T",
      pdfS3Key: "k.pdf",
      audienceId: 7,
      status: "archived",
    });

    expect(status).toBe(400);
    expect(written.inserted).toHaveLength(0);
  });

  it("should save a new status and refresh the events the app caches", async () => {
    const { status } = await send("PUT", "/api/admin/publications/5", { status: "published" });

    expect(status).toBe(200);
    expect(written.updated[0]).toMatchObject({ status: "published" });
    // Event pages list related publications: a status change changes them.
    expect(bumpVersion).toHaveBeenCalledWith("events");
  });

  it("should leave the status alone when an edit does not send it", async () => {
    await send("PUT", "/api/admin/publications/5", { title: "Renamed" });

    expect(written.updated[0]).not.toHaveProperty("status");
    expect(bumpVersion).not.toHaveBeenCalledWith("events");
  });

  it("should list every status when no filter is given", async () => {
    await send("GET", "/api/admin/publications");

    expect(listWheres.flatMap(params)).not.toContain("draft");
  });

  it("should filter the list by status", async () => {
    await send("GET", "/api/admin/publications?status=draft");

    expect(listWheres.flatMap(params)).toContain("draft");
  });
});
