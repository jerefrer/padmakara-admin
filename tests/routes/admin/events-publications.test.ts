import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const { mockDb, mockViaGroups, queue } = vi.hoisted(() => {
  const queue: unknown[][] = [];
  // Every select chain resolves to the next queued row set, whichever method ends it.
  const makeChain = () => {
    const rows = queue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "where", "orderBy"]) chain[m] = () => chain;
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
    return chain;
  };
  return {
    mockDb: { select: vi.fn(() => makeChain()) },
    mockViaGroups: vi.fn((_ids: number[]) => Promise.resolve([] as unknown[])),
    queue,
  };
});

vi.mock("../../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../../src/services/event-publications.ts", () => ({
  publicationsViaGroups: mockViaGroups,
}));

import { createAccessToken } from "../../../src/services/auth.ts";

const auth = async (role: "admin" | "user" = "admin") => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role })}`,
});

const pub = (id: number) => ({
  id,
  title: `Pub ${id}`,
  language: "pt",
  version: "2",
  pdfS3Key: "secret",
});

describe("GET /api/admin/events/:id/publications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queue.length = 0;
  });

  it("should list group-linked publications with title, language and version only", async () => {
    queue.push([{ retreatGroupId: 3 }], []);
    mockViaGroups.mockResolvedValueOnce([pub(5)]);

    const { status, body } = await testJson("/api/admin/events/7/publications", { headers: await auth() });

    expect(status).toBe(200);
    expect(mockViaGroups).toHaveBeenCalledWith([3]);
    expect(body).toEqual({
      viaGroups: [{ id: 5, title: "Pub 5", language: "pt", version: "2" }],
      direct: [],
    });
  });

  it("should list a direct link separately and drop it when it also comes through a group", async () => {
    queue.push([{ retreatGroupId: 3 }], [{ publication: pub(5) }, { publication: pub(9) }]);
    mockViaGroups.mockResolvedValueOnce([pub(5)]);

    const { body } = await testJson("/api/admin/events/7/publications", { headers: await auth() });

    expect((body as { direct: { id: number }[] }).direct.map((p) => p.id)).toEqual([9]);
  });

  it("should return empty lists for an event without groups or links", async () => {
    const { body } = await testJson("/api/admin/events/7/publications", { headers: await auth() });

    expect(body).toEqual({ viaGroups: [], direct: [] });
  });

  it("should return 400 when the id is not a positive integer", async () => {
    const { status } = await testJson("/api/admin/events/abc/publications", { headers: await auth() });

    expect(status).toBe(400);
  });

  it("should return 401 without a token and 403 for a non-admin", async () => {
    expect((await testJson("/api/admin/events/7/publications")).status).toBe(401);
    expect(
      (await testJson("/api/admin/events/7/publications", { headers: await auth("user") })).status,
    ).toBe(403);
  });
});
