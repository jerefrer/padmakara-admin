import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindLinks, mockCheckEventAccess, mockFindUser } = vi.hoisted(() => ({
  mockFindLinks: vi.fn(),
  mockCheckEventAccess: vi.fn(),
  mockFindUser: vi.fn(),
}));

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      eventPublications: { findMany: mockFindLinks },
      users: { findFirst: mockFindUser },
    },
  },
}));

vi.mock("../../src/services/access.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/access.ts")>();
  return { ...actual, checkEventAccess: mockCheckEventAccess };
});

import {
  canOpenPublication,
  publicationsOpenedByLinkedEvents,
} from "../../src/services/publication-access.ts";

describe("canOpenPublication", () => {
  const nobody = { isAdmin: false, canSeeSubscriber: false, openedByLinkedEvent: false };

  it("should open a public publication to anyone", () => {
    expect(canOpenPublication("public", nobody)).toBe(true);
  });

  it("should open a members publication only to members", () => {
    expect(canOpenPublication("subscribers", nobody)).toBe(false);
    expect(canOpenPublication("subscribers", { ...nobody, canSeeSubscriber: true })).toBe(true);
  });

  it("should open an events publication to whoever can open one of its events", () => {
    // A member who did not attend the retreats must not read its texts.
    expect(canOpenPublication("events", { ...nobody, canSeeSubscriber: true })).toBe(false);
    expect(canOpenPublication("events", { ...nobody, openedByLinkedEvent: true })).toBe(true);
  });

  it("should open an events publication to admins", () => {
    expect(canOpenPublication("events", { ...nobody, isAdmin: true })).toBe(true);
  });

  it("should refuse an access level it does not know", () => {
    // The PDF route used to open anything that was not "subscribers".
    expect(canOpenPublication("retreat-only", { ...nobody, canSeeSubscriber: true })).toBe(false);
  });
});

describe("publicationsOpenedByLinkedEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUser.mockResolvedValue({
      id: 7,
      role: "user",
      subscriptionStatus: "active",
      subscriptionExpiresAt: null,
    });
  });

  it("should open a publication through any one of its events the user can open", async () => {
    // Arrange: publication 5 is linked to two retreats; the user attended one.
    mockFindLinks.mockResolvedValue([
      { publicationId: 5, event: { id: 100, status: "published", audience: { slug: "event-participants" } } },
      { publicationId: 5, event: { id: 101, status: "published", audience: { slug: "event-participants" } } },
      { publicationId: 6, event: { id: 102, status: "published", audience: { slug: "event-participants" } } },
    ]);
    mockCheckEventAccess.mockImplementation(async (_user: unknown, event: { id: number }) =>
      event.id === 101 ? { allowed: true } : { allowed: false, reason: "EVENT_ATTENDANCE_REQUIRED" },
    );

    // Act
    const opened = await publicationsOpenedByLinkedEvents({ id: 7, role: "user" }, [5, 6]);

    // Assert
    expect([...opened]).toEqual([5]);
  });

  it("should open nothing through events to a signed-out visitor unless an event is public", async () => {
    mockFindLinks.mockResolvedValue([
      { publicationId: 5, event: { id: 100, status: "published", audience: { slug: "event-participants" } } },
    ]);
    mockCheckEventAccess.mockResolvedValue({ allowed: false, reason: "AUTH_REQUIRED" });

    const opened = await publicationsOpenedByLinkedEvents(null, [5]);

    expect(opened.size).toBe(0);
    expect(mockCheckEventAccess).toHaveBeenCalledWith(null, expect.objectContaining({ id: 100 }));
  });

  it("should not query anything when no publication asks for it", async () => {
    const opened = await publicationsOpenedByLinkedEvents({ id: 7, role: "user" }, []);

    expect(opened.size).toBe(0);
    expect(mockFindLinks).not.toHaveBeenCalled();
  });
});
