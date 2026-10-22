import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const { mockDb, chainCalls, rowsRef } = vi.hoisted(() => {
  const chainCalls: { method: string; args: unknown[] }[] = [];
  const rowsRef: { rows: unknown[] } = { rows: [] };
  // db.select(...).from(...).innerJoin(...).where(...).orderBy(...) → rows
  const makeChain = () => {
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    for (const method of ["from", "innerJoin", "where"]) {
      chain[method] = (...args: unknown[]) => {
        chainCalls.push({ method, args });
        return chain;
      };
    }
    chain.orderBy = (...args: unknown[]) => {
      chainCalls.push({ method: "orderBy", args });
      return Promise.resolve(rowsRef.rows);
    };
    return chain;
  };
  const mockDb = { select: vi.fn(() => makeChain()) };
  return { mockDb, chainCalls, rowsRef };
});

vi.mock("../../../src/db/index.ts", () => ({ db: mockDb }));

import { createAccessToken } from "../../../src/services/auth.ts";

const auth = async (role: "admin" | "user" = "admin") => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role })}`,
});

describe("GET /api/admin/events/:id/missing-audio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chainCalls.length = 0;
    rowsRef.rows = [];
  });

  it("should list the event's tracks that have no audio", async () => {
    // Arrange
    rowsRef.rows = [
      { id: 11, sessionId: 3, sessionNumber: 1, trackNumber: 2, title: "B", originalFilename: "002 B.mp3" },
      { id: 14, sessionId: 4, sessionNumber: 2, trackNumber: 1, title: "C", originalFilename: "001 C.mp3" },
    ];

    // Act
    const { status, body } = await testJson("/api/admin/events/7/missing-audio", {
      headers: await auth(),
    });

    // Assert
    expect(status).toBe(200);
    expect(body).toEqual({ tracks: rowsRef.rows });
  });

  it("should return an empty list when every track has audio", async () => {
    const { status, body } = await testJson("/api/admin/events/7/missing-audio", {
      headers: await auth(),
    });

    expect(status).toBe(200);
    expect(body).toEqual({ tracks: [] });
  });

  it("should scope the query to one event and order it by session then track", async () => {
    await testJson("/api/admin/events/7/missing-audio", { headers: await auth() });

    expect(chainCalls.map((c) => c.method)).toEqual(["from", "innerJoin", "where", "orderBy"]);
    expect(chainCalls.find((c) => c.method === "orderBy")!.args).toHaveLength(2);
  });

  it("should return 400 when the id is not a positive integer", async () => {
    const { status } = await testJson("/api/admin/events/abc/missing-audio", {
      headers: await auth(),
    });

    expect(status).toBe(400);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("should return 401 without a token", async () => {
    const { status } = await testJson("/api/admin/events/7/missing-audio");

    expect(status).toBe(401);
  });

  it("should return 403 for a non-admin user", async () => {
    const { status } = await testJson("/api/admin/events/7/missing-audio", {
      headers: await auth("user"),
    });

    expect(status).toBe(403);
  });
});
