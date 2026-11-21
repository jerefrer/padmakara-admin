import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindFirst } = vi.hoisted(() => ({ mockFindFirst: vi.fn() }));

vi.mock("../../src/db/index.ts", () => ({
  db: { query: { events: { findFirst: mockFindFirst } } },
}));

import { resolveStoragePrefix } from "../../src/lib/storage-prefix.ts";

describe("resolveStoragePrefix", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return the stored folder when the event exists and its code has changed since", async () => {
    mockFindFirst.mockResolvedValue({ storagePrefix: "20081201-JKR-PP1" });
    await expect(resolveStoragePrefix("20081201-JKR-RP1-GCP")).resolves.toBe("20081201-JKR-PP1");
  });

  it("should return the code itself when no event has it yet", async () => {
    mockFindFirst.mockResolvedValue(undefined);
    await expect(resolveStoragePrefix("NEW-EVENT")).resolves.toBe("NEW-EVENT");
  });
});
