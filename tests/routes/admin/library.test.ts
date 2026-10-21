import { describe, it, expect, vi, beforeEach } from "vitest";
import { testRequest, testJson } from "../../helpers.ts";

// Every `db.select(...).from(...)[.where(...)]` resolves to the next queued
// result, in call order; the chain is also directly awaitable.
vi.mock("../../../src/db/index.ts", () => {
  const selectResults: any[] = [];
  const chain = (): any => {
    const c: any = {
      from: vi.fn(() => c),
      where: vi.fn(() => c),
      then: (resolve: any, reject: any) =>
        Promise.resolve(selectResults.shift() ?? []).then(resolve, reject),
    };
    return c;
  };
  const insertValues = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 99 }])) }));
  const tx = {
    select: vi.fn(() => chain()),
    delete: vi.fn(() => Promise.resolve()),
    insert: vi.fn(() => ({ values: insertValues })),
  };
  return {
    db: {
      select: vi.fn(() => chain()),
      insert: vi.fn(() => ({ values: insertValues })),
      transaction: vi.fn(async (fn: any) => fn(tx)),
      query: {
        events: { findFirst: vi.fn() },
        libraryRecords: { findFirst: vi.fn() },
      },
      _results: selectResults,
      _tx: tx,
      _insertValues: insertValues,
    },
  };
});

import { db } from "../../../src/db/index.ts";
import { createAccessToken } from "../../../src/services/auth.ts";

const d = db as any;
const adminToken = () => createAccessToken({ sub: 1, email: "a@test.com", role: "admin" });
const auth = async () => ({ Authorization: `Bearer ${await adminToken()}` });

const HEADER = "ID,eventCode,eventTitle,teacherName,placeTeaching,dateStart-dateEnd,currentDesignation";
const CSV = `${HEADER}\nw1,CODE-1,Title One,Teacher A,"Place, City",2020-01-01 a 2020-01-03,Ensinamento\nw2,CODE-2,Title Two,Teacher B,,2021-05-05,Conferência`;

function record(overrides: Record<string, any> = {}) {
  return {
    wixId: "w1", eventCode: "CODE-1", title: "Title One", teacherNames: "Teacher A", guestName: "",
    organization: "", place: "Place, City", designation: "Ensinamento", dateRange: "2020-01-01 a 2020-01-03",
    startDate: "2020-01-01", endDate: "2020-01-03", themes: "", ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  d._results.length = 0;
});

describe("library admin routes: authorization", () => {
  const routes: [string, string][] = [
    ["GET", "/api/admin/library/status"],
    ["POST", "/api/admin/library/upload"],
    ["GET", "/api/admin/library/records?q=x"],
    ["GET", "/api/admin/library/suggest?eventId=1"],
    ["POST", "/api/admin/library/suggest"],
    ["GET", "/api/admin/library/records/w1/mapping"],
    ["POST", "/api/admin/library/entities"],
  ];

  it.each(routes)("should return 401 for %s %s without a token", async (method, path) => {
    const res = await testRequest(path, { method });
    expect(res.status).toBe(401);
  });

  it.each(routes)("should return 403 for %s %s as a regular user", async (method, path) => {
    const token = await createAccessToken({ sub: 2, email: "u@test.com", role: "user" });
    const res = await testRequest(path, { method, headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/admin/library/upload", () => {
  it("should replace every record with the uploaded rows and report the counts", async () => {
    d._results.push([{ count: 5 }]); // rows before, inside the transaction
    d._results.push([{ count: 1 }]); // events whose record is gone
    const { status, body } = await testJson("/api/admin/library/upload", {
      method: "POST",
      headers: { ...(await auth()), "Content-Type": "text/csv" },
      body: CSV,
    });
    expect(status).toBe(200);
    expect(body).toEqual({ imported: 2, previous: 5, withDates: 2, linkedEventsWithoutRecord: 1 });
    expect(d._tx.delete).toHaveBeenCalledTimes(1);
    const inserted = d._insertValues.mock.calls[0][0];
    expect(inserted.map((r: any) => r.wixId)).toEqual(["w1", "w2"]);
  });

  it("should accept a multipart file upload", async () => {
    d._results.push([{ count: 0 }], [{ count: 0 }]);
    const form = new FormData();
    form.set("file", new File([CSV], "libraryEvent.csv", { type: "text/csv" }));
    const res = await testRequest("/api/admin/library/upload", {
      method: "POST", headers: await auth(), body: form,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).imported).toBe(2);
  });

  it("should reject a CSV that is not a library export without touching the table", async () => {
    const { status, body } = await testJson("/api/admin/library/upload", {
      method: "POST",
      headers: { ...(await auth()), "Content-Type": "text/csv" },
      body: "a,b\n1,2",
    });
    expect(status).toBe(400);
    expect(body.code ?? body.error?.code).toBeDefined();
    expect(d.transaction).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/library/records", () => {
  it("should rank the matching record first and drop the others", async () => {
    d._results.push([record(), record({ wixId: "w2", title: "Other", teacherNames: "Teacher B", place: "", eventCode: "CODE-2" })]);
    const { status, body } = await testJson("/api/admin/library/records?q=teacher%20a%202020", {
      headers: await auth(),
    });
    expect(status).toBe(200);
    expect(body.records.map((r: any) => r.wixId)).toEqual(["w1"]);
    expect(body.total).toBe(2);
  });
});

describe("suggest", () => {
  it("should suggest from a saved event's own data", async () => {
    d.query.events.findFirst.mockResolvedValueOnce({
      id: 7, eventCode: "CODE-9", titlePt: null, titleEn: "Title One", wixId: null,
      startDate: "2020-01-02", endDate: "2020-01-02",
      eventTeachers: [{ teacher: { name: "Teacher A" } }],
      eventPlaces: [{ place: { name: "Place" } }],
    });
    d._results.push([record(), record({ wixId: "w2", startDate: "2021-05-05", endDate: "2021-05-05", teacherNames: "Teacher B", title: "Zzz" })]);
    const { status, body } = await testJson("/api/admin/library/suggest?eventId=7", { headers: await auth() });
    expect(status).toBe(200);
    expect(body.suggestions[0]).toMatchObject({ wixId: "w1" });
    expect(body.suggestions[0].score).toBeGreaterThanOrEqual(70);
    expect(body.suggestions[0].reasons.map((r: any) => r.kind)).toEqual(
      expect.arrayContaining(["date", "teacher", "place", "title"]),
    );
  });

  it("should suggest from draft form values without an event id", async () => {
    d._results.push([record()]);
    const { body } = await testJson("/api/admin/library/suggest", {
      method: "POST", headers: await auth(),
      body: JSON.stringify({ eventCode: "code 1" }),
    });
    expect(body.suggestions[0]).toMatchObject({ wixId: "w1", score: 100 });
  });

  it("should return 404 for an unknown event id", async () => {
    d.query.events.findFirst.mockResolvedValueOnce(undefined);
    const { status } = await testJson("/api/admin/library/suggest?eventId=1", { headers: await auth() });
    expect(status).toBe(404);
  });
});

describe("GET /api/admin/library/records/:wixId/mapping", () => {
  it("should preview the mapped event values from the stored raw row", async () => {
    d.query.libraryRecords.findFirst.mockResolvedValueOnce({
      ...record(),
      raw: {
        ID: "w1", eventCode: "CODE-1", eventTitle: "Title One", teacherName: "Teacher A",
        placeTeaching: "Place, City", "dateStart-dateEnd": "2020-01-01 a 2020-01-03",
        currentDesignation: "Ensinamento", mainThemes: "Themes",
      },
    });
    d._results.push(
      [{ id: 1, name: "Teacher A", abbreviation: "TA", aliases: [] }],
      [],
      [{ id: 2, nameEn: "Teaching", namePt: "Ensinamento" }],
      [], [],
    );
    const { status, body } = await testJson("/api/admin/library/records/w1/mapping", { headers: await auth() });
    expect(status).toBe(200);
    expect(body.mapping.fields).toMatchObject({
      titlePt: "Title One", eventTypeId: 2, mainThemesPt: "Themes", wixId: "w1",
      teacherIds: [{ id: 1, role: "teacher" }],
    });
    expect(body.mapping.unresolved.places).toEqual(["Place, City"]);
  });

  it("should return 404 for an unknown record", async () => {
    d.query.libraryRecords.findFirst.mockResolvedValueOnce(undefined);
    const { status } = await testJson("/api/admin/library/records/nope/mapping", { headers: await auth() });
    expect(status).toBe(404);
  });
});

describe("POST /api/admin/library/entities", () => {
  it("should reuse existing teachers and places and create the missing ones", async () => {
    d._results.push(
      [{ id: 1, name: "Teacher A", abbreviation: "TA", aliases: [] }],
      [{ id: 5, name: "UBP", abbreviation: "UBP", location: "UBP, Lisboa" }],
    );
    const { status, body } = await testJson("/api/admin/library/entities", {
      method: "POST", headers: await auth(),
      body: JSON.stringify({ teachers: ["teacher a", "Wulstan Fletcher"], places: ["UBP, Lisboa", "Hotel do Sado, Setúbal"] }),
    });
    expect(status).toBe(200);
    expect(body.teachers).toEqual([{ name: "teacher a", id: 1 }, { name: "Wulstan Fletcher", id: 99 }]);
    expect(body.places).toEqual([
      { location: "UBP, Lisboa", id: 5, name: "UBP" },
      { location: "Hotel do Sado, Setúbal", id: 99, name: "Hotel do Sado" },
    ]);
    const created = d._insertValues.mock.calls.map((c: any) => c[0]);
    expect(created).toEqual([
      { name: "Wulstan Fletcher", abbreviation: "WF", aliases: [] },
      { name: "Hotel do Sado", location: "Hotel do Sado, Setúbal" },
    ]);
  });
});
