import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const sessionFindFirst = vi.fn();
const tracksFindMany = vi.fn();
const txSet = vi.fn((_values: unknown) => ({ where: vi.fn(() => Promise.resolve()) }));
const eventUpdateWhere = vi.fn(() => Promise.resolve());

vi.mock("../../../src/db/index.ts", () => ({
  db: {
    query: {
      sessions: { findFirst: (...a: unknown[]) => sessionFindFirst(...a) },
      tracks: { findMany: (...a: unknown[]) => tracksFindMany(...a) },
    },
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: eventUpdateWhere })) })),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) =>
      fn({ update: vi.fn(() => ({ set: txSet })) }),
    ),
  },
}));

vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpVersion: vi.fn(() => Promise.resolve()),
}));

import { createAccessToken } from "../../../src/services/auth.ts";

async function put(sessionId: number, body: unknown) {
  const token = await createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
  return testJson(`/api/admin/sessions/${sessionId}/track-order`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT /api/admin/sessions/:id/track-order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionFindFirst.mockResolvedValue({ id: 7, eventId: 920 });
    tracksFindMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("should save positions 1, 2, 3 in the order given", async () => {
    const { status, body } = await put(7, { trackIds: [3, 1, 2] });

    expect(status).toBe(200);
    expect(body).toEqual({ sessionId: 7, trackIds: [3, 1, 2] });
    expect(txSet.mock.calls.map(([values]) => values)).toEqual([
      { position: 1 },
      { position: 2 },
      { position: 3 },
    ]);
  });

  it("should refuse an order that leaves a track of the session out", async () => {
    const { status, body } = await put(7, { trackIds: [3, 1] });

    expect(status).toBe(400);
    expect((body as { code?: string }).code ?? JSON.stringify(body)).toContain("TRACK_ORDER_MISMATCH");
    expect(txSet).not.toHaveBeenCalled();
  });

  it("should 404 an unknown session", async () => {
    sessionFindFirst.mockResolvedValueOnce(undefined);

    const { status } = await put(99, { trackIds: [1] });

    expect(status).toBe(404);
  });

  it("should refuse a body without track ids", async () => {
    const { status } = await put(7, { trackIds: [] });

    expect(status).toBe(400);
  });
});
