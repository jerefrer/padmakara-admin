import { describe, it, expect, vi, beforeEach } from "vitest";
import { testRequest } from "../helpers.ts";

const m = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      tracks: { findFirst: (...a: any[]) => m.track(...a) },
      users: { findFirst: vi.fn(() => Promise.resolve({ id: 1, role: "user", firstName: "A", lastName: "B" })) },
    },
  },
}));

import { createAccessToken } from "../../src/services/auth.ts";
import { countReadAlongOpen } from "../../src/services/usage.ts";

const auth = async (role = "user") => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "u@test.com", role })}`,
});

const track = (status = "published") => ({ id: 10, session: { event: { id: 3, status } } });
const open = async (id = "10", headers?: Record<string, string>) =>
  testRequest(`/api/content/read-along/${id}/open`, { method: "POST", headers: headers ?? (await auth()) });

beforeEach(() => {
  vi.clearAllMocks();
  m.track.mockResolvedValue(track());
});

describe("POST /api/content/read-along/:trackId/open", () => {
  it("should return 204 and count against the track's event", async () => {
    const res = await open();
    expect(res.status).toBe(204);
    expect(countReadAlongOpen).toHaveBeenCalledTimes(1);
    expect(countReadAlongOpen).toHaveBeenCalledWith(1, 10, 3);
  });

  it("should return 401 without a token", async () => {
    const res = await open("10", {});
    expect(res.status).toBe(401);
    expect(countReadAlongOpen).not.toHaveBeenCalled();
  });

  it("should return 404 when the track does not exist", async () => {
    m.track.mockResolvedValue(null);
    const res = await open();
    expect(res.status).toBe(404);
    expect(countReadAlongOpen).not.toHaveBeenCalled();
  });

  it("should return 404 for a non-numeric track id", async () => {
    const res = await open("abc");
    expect(res.status).toBe(404);
    expect(countReadAlongOpen).not.toHaveBeenCalled();
  });

  it("should return 404 for a draft event when the caller is a regular user", async () => {
    m.track.mockResolvedValue(track("draft"));
    const res = await open();
    expect(res.status).toBe(404);
    expect(countReadAlongOpen).not.toHaveBeenCalled();
  });
});
