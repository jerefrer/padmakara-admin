import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { testJson } from "../../helpers.ts";

const eventsFindMany = vi.fn((_args: any) => Promise.resolve([] as any[]));

vi.mock("../../../src/db/index.ts", () => {
  const makeChain = (rows: any[]) => {
    const chain: any = {};
    chain.from = () => chain;
    chain.innerJoin = () => chain;
    chain.where = () => chain;
    chain.groupBy = () => Promise.resolve(rows);
    return chain;
  };
  return {
    db: {
      query: { events: { findMany: (args: any) => eventsFindMany(args) } },
      select: vi.fn(() => makeChain([])),
    },
  };
});

import { createAccessToken } from "../../../src/services/auth.ts";
import { buildOrderBy } from "../../../src/routes/admin/helpers.ts";
import { eventSortColumns } from "../../../src/routes/admin/events-sort.ts";
import { events } from "../../../src/db/schema/retreats.ts";

const dialect = new PgDialect();
const render = (q: SQL | undefined) => dialect.sqlToQuery(q!).sql.replace(/\s+/g, " ");
const adminToken = () => createAccessToken({ sub: 1, email: "a@test.com", role: "admin" });

describe("buildOrderBy", () => {
  it("should sort a column ascending with nulls last", () => {
    expect(render(buildOrderBy("titleEn", "ASC", { titleEn: events.titleEn }))).toBe(
      '"retreats"."title_en" asc nulls last',
    );
  });

  it("should sort descending with nulls still last", () => {
    expect(render(buildOrderBy("titleEn", "DESC", { titleEn: events.titleEn }))).toBe(
      '"retreats"."title_en" desc nulls last',
    );
  });

  it("should accept a SQL expression as a sort target", () => {
    const out = render(buildOrderBy("x", "ASC", { x: sql`(select 1)` }));
    expect(out).toBe("(select 1) asc nulls last");
  });

  it("should return undefined when the sort key is not whitelisted", () => {
    expect(buildOrderBy("title_en; drop table users", "ASC", { titleEn: events.titleEn })).toBeUndefined();
  });

  it("should ignore keys that only exist on the object prototype", () => {
    expect(buildOrderBy("constructor", "ASC", { titleEn: events.titleEn })).toBeUndefined();
    expect(buildOrderBy("__proto__", "ASC", { titleEn: events.titleEn })).toBeUndefined();
  });
});

describe("eventSortColumns", () => {
  it("should expose a sort key for every visible column of the events list", () => {
    for (const key of [
      "titleEn", "titlePt", "eventTypeName", "eventTypeNamePt", "groups", "teachers",
      "audienceName", "audienceNamePt", "startDate", "content", "status", "featuredAt",
    ]) {
      expect(eventSortColumns).toHaveProperty(key);
    }
  });

  it("should sort groups by the alphabetically first related abbreviation", () => {
    const out = render(buildOrderBy("groups", "ASC", eventSortColumns));
    expect(out).toContain("min(coalesce(rg.abbreviation, rg.name_en))");
    expect(out).toContain("retreat_group_retreats");
    expect(out.endsWith("asc nulls last")).toBe(true);
  });

  it("should sort teachers by the alphabetically first related abbreviation", () => {
    const out = render(buildOrderBy("teachers", "DESC", eventSortColumns));
    expect(out).toContain("min(t.abbreviation)");
    expect(out.endsWith("desc nulls last")).toBe(true);
  });

  it("should sort the event type by name rather than by id", () => {
    expect(render(buildOrderBy("eventTypeName", "ASC", eventSortColumns))).toContain("et.name_en");
    expect(render(buildOrderBy("eventTypeNamePt", "ASC", eventSortColumns))).toContain("coalesce(et.name_pt, et.name_en)");
  });
});

describe("GET /api/admin/events sorting", () => {
  beforeEach(() => eventsFindMany.mockClear());

  const requestSorted = async (sort: string, order = "ASC") => {
    const token = await adminToken();
    const res = await testJson(`/api/admin/events?_sort=${encodeURIComponent(sort)}&_order=${order}&_start=0&_end=10`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return eventsFindMany.mock.calls[0]![0].orderBy as SQL[] | undefined;
  };

  it.each([
    ["titleEn", '"title_en"'],
    ["titlePt", "coalesce("],
    ["eventTypeName", "et.name_en"],
    ["eventTypeNamePt", "et.name_pt"],
    ["groups", "retreat_group_retreats"],
    ["teachers", "retreat_teachers"],
    ["audienceName", "a.name_en"],
    ["audienceNamePt", "a.name_pt"],
    ["startDate", '"start_date"'],
    ["content", "event_videos"],
    ["status", '"status"'],
    ["featuredAt", '"featured_at"'],
  ])("should order by %s when requested", async (key, fragment) => {
    const orderBy = await requestSorted(key, "DESC");
    expect(orderBy).toHaveLength(1);
    const out = render(orderBy![0]);
    expect(out).toContain(fragment);
    expect(out.endsWith("desc nulls last")).toBe(true);
  });

  it("should not order when the sort key is unknown", async () => {
    expect(await requestSorted("nope; drop table")).toBeUndefined();
  });
});
