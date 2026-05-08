import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelectFromOrderBy = vi.fn();
const mockSelectFromWhereLimitFn = vi.fn();

// The `select()` builder is used for two different call patterns:
//   1. getAllVersions: select().from().orderBy()
//   2. getUserVersion: select().from().where().limit()
// We distinguish by checking which terminal method is called.
const mockSelectFromWhere = vi.fn(() => ({ limit: mockSelectFromWhereLimitFn }));
const mockSelectFrom = vi.fn(() => ({
  orderBy: mockSelectFromOrderBy,
  where: mockSelectFromWhere,
}));

vi.mock("../../src/db/index.ts", () => ({
  db: {
    select: vi.fn(() => ({ from: mockSelectFrom })),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

import {
  getAllVersions,
  bumpVersion,
  getUserVersion,
  bumpUserAccessVersion,
} from "../../src/services/sync-versions.ts";

describe("getAllVersions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a record mapping namespace -> version", async () => {
    mockSelectFromOrderBy.mockResolvedValue([
      { namespace: "events", version: 42 },
      { namespace: "groups", version: 7 },
      { namespace: "publications", version: 23 },
      { namespace: "teachers", version: 17 },
    ]);

    const result = await getAllVersions();

    expect(result).toEqual({
      events: 42,
      groups: 7,
      publications: 23,
      teachers: 17,
    });
  });

  it("returns empty object when table has no rows", async () => {
    mockSelectFromOrderBy.mockResolvedValue([]);

    const result = await getAllVersions();

    expect(result).toEqual({});
  });
});

describe("bumpVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("increments the version counter for a namespace", async () => {
    const { db } = await import("../../src/db/index.ts");
    const mockWhere = vi.fn().mockResolvedValue(undefined);
    const mockSet = vi.fn(() => ({ where: mockWhere }));
    (db.update as any).mockReturnValue({ set: mockSet });

    await bumpVersion("events");

    expect(db.update).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      version: expect.anything(),
      updatedAt: expect.any(Date),
    }));
    expect(mockWhere).toHaveBeenCalled();
  });

  it("rejects unknown namespaces", async () => {
    await expect(bumpVersion("not-a-real-namespace" as any)).rejects.toThrow(
      /unknown namespace/i,
    );
  });
});

describe("getUserVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 when no row exists for the user", async () => {
    mockSelectFromWhereLimitFn.mockResolvedValue([]);

    const result = await getUserVersion(42);

    expect(result).toBe(0);
  });

  it("returns the stored version when a row exists", async () => {
    mockSelectFromWhereLimitFn.mockResolvedValue([{ version: 7 }]);

    const result = await getUserVersion(42);

    expect(result).toBe(7);
  });
});

describe("bumpUserAccessVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts a row with version=1 when none exists (on conflict increments)", async () => {
    const { db } = await import("../../src/db/index.ts");
    const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const mockValues = vi.fn(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
    (db.insert as any).mockReturnValue({ values: mockValues });

    await bumpUserAccessVersion(5);

    expect(db.insert).toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ userId: 5, version: 1 }));
    expect(mockOnConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          updatedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("can be called with any userId without throwing", async () => {
    const { db } = await import("../../src/db/index.ts");
    const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const mockValues = vi.fn(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
    (db.insert as any).mockReturnValue({ values: mockValues });

    await expect(bumpUserAccessVersion(99)).resolves.toBeUndefined();
  });
});
