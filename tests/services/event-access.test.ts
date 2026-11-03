import { describe, it, expect, vi, beforeEach } from "vitest";

const returning = vi.fn();
const values = vi.fn();
vi.mock("../../src/db/index.ts", () => ({
  db: {
    insert: vi.fn(() => ({
      values: (...a: unknown[]) => {
        values(...a);
        return { onConflictDoNothing: () => ({ returning }) };
      },
    })),
  },
}));
const bump = vi.fn();
vi.mock("../../src/services/sync-versions.ts", () => ({
  bumpUserAccessVersion: (...a: unknown[]) => bump(...a),
}));

import { grantEventAccess } from "../../src/services/event-access.ts";

beforeEach(() => { vi.clearAllMocks(); bump.mockResolvedValue(undefined); });

describe("grantEventAccess", () => {
  it("should create the grant and bump the user's access version", async () => {
    returning.mockResolvedValueOnce([{ userId: 3 }]);
    const r = await grantEventAccess({ userId: 3, eventId: 8, source: "purchase", orderId: 5 });
    expect(r).toEqual({ created: true });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ userId: 3, eventId: 8, source: "purchase", orderId: 5 }));
    expect(bump).toHaveBeenCalledWith(3);
  });

  it("should do nothing and not bump when the grant already exists", async () => {
    returning.mockResolvedValueOnce([]);
    const r = await grantEventAccess({ userId: 3, eventId: 8, source: "manual", grantedBy: 1 });
    expect(r).toEqual({ created: false });
    expect(bump).not.toHaveBeenCalled();
  });
});
