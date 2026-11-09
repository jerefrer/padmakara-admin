import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const trackFindFirst = vi.fn();
const set = vi.fn((_values: Record<string, unknown>) => ({
  where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 5, sessionId: 2, s3Key: null }])) })),
}));

vi.mock("../../../src/db/index.ts", () => ({
  db: {
    query: {
      tracks: { findFirst: (...a: unknown[]) => trackFindFirst(...a) },
      sessions: { findFirst: vi.fn(() => Promise.resolve(null)) },
    },
    update: vi.fn(() => ({ set })),
  },
}));

vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpVersion: vi.fn(() => Promise.resolve()),
}));

import { createAccessToken } from "../../../src/services/auth.ts";

async function putTrack(body: unknown) {
  const token = await createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
  return testJson("/api/admin/tracks/5", {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT /api/admin/tracks/:id position", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should clear the hand-set position when the track moves to another session", async () => {
    trackFindFirst.mockResolvedValueOnce({ sessionId: 1 });

    const { status } = await putTrack({ sessionId: 2 });

    expect(status).toBe(200);
    expect(set.mock.calls[0]?.[0]).toMatchObject({ sessionId: 2, position: null });
  });

  it("should keep the position when the track stays in its session", async () => {
    trackFindFirst.mockResolvedValueOnce({ sessionId: 2 });

    await putTrack({ sessionId: 2, title: "Renamed" });

    expect(set.mock.calls[0]?.[0]).not.toHaveProperty("position");
  });
});
