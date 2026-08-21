import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted — factory must not reference outer variables
vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      userEventAttendance: {
        findFirst: vi.fn(),
      },
      userGroupMemberships: {
        findFirst: vi.fn(),
      },
    },
    select: vi.fn(),
  },
}));

// Import after mock setup
import { db } from "../../src/db/index.ts";
const mockDb = db as any;

import {
  checkEventAccess,
  filterAccessibleEvents,
  eventStatusVisibleTo,
  denialToHttpError,
  hasActiveSubscription,
  AUDIENCE_SLUGS,
  type AccessDeniedReason,
} from "../../src/services/access.ts";
import { config } from "../../src/config.ts";
import { AppError } from "../../src/lib/errors.ts";

// Helpers
function makeUser(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    role: "user",
    subscriptionStatus: "active",
    subscriptionExpiresAt: new Date("2099-12-31"),
    ...overrides,
  };
}

function makeEvent(audienceSlug: string | null, id = 1, status = "published") {
  return {
    id,
    status,
    audience: audienceSlug ? { slug: audienceSlug } : null,
    audienceId: audienceSlug ? 1 : null,
  };
}

// Chainable select mock helper
function mockSelectChain(results: any[]) {
  mockDb.select.mockReturnValueOnce({
    from: vi.fn().mockReturnValueOnce({
      where: vi.fn().mockResolvedValueOnce(results),
    }),
  });
}

describe("Access Control Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("hasActiveSubscription", () => {
    const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000);

    it("is false when the status is not active", () => {
      expect(
        hasActiveSubscription({
          subscriptionStatus: "expired",
          subscriptionExpiresAt: daysFromNow(30),
        }),
      ).toBe(false);
      expect(
        hasActiveSubscription({
          subscriptionStatus: "none",
          subscriptionExpiresAt: null,
        }),
      ).toBe(false);
    });

    it("is true with no expiry date (admin-granted, open-ended)", () => {
      expect(
        hasActiveSubscription({ subscriptionStatus: "active", subscriptionExpiresAt: null }),
      ).toBe(true);
    });

    it("is true before the paid-through date", () => {
      expect(
        hasActiveSubscription({
          subscriptionStatus: "active",
          subscriptionExpiresAt: daysFromNow(1),
        }),
      ).toBe(true);
    });

    it("stays true inside the grace window after expiry", () => {
      // A renewal notification can arrive late or never — Easypay does not guarantee
      // delivery. A member who has been charged must not lose access while we wait.
      expect(
        hasActiveSubscription({
          subscriptionStatus: "active",
          subscriptionExpiresAt: daysFromNow(-(config.subscription.graceDays - 1)),
        }),
      ).toBe(true);
    });

    it("is false once the grace window has passed", () => {
      expect(
        hasActiveSubscription({
          subscriptionStatus: "active",
          subscriptionExpiresAt: daysFromNow(-(config.subscription.graceDays + 1)),
        }),
      ).toBe(false);
    });
  });

  describe("AUDIENCE_SLUGS", () => {
    it("has all expected audience types", () => {
      expect(AUDIENCE_SLUGS.PUBLIC).toBe("free-anyone");
      expect(AUDIENCE_SLUGS.SUBSCRIBERS).toBe("free-subscribers");
      expect(AUDIENCE_SLUGS.GROUP_MEMBERS).toBe("retreat-group-members");
      expect(AUDIENCE_SLUGS.EVENT_PARTICIPANTS).toBe("event-participants");
      expect(AUDIENCE_SLUGS.ON_REQUEST).toBe("available-on-request-only");
      expect(AUDIENCE_SLUGS.INITIATION).toBe("received-initiation");
    });
  });

  describe("checkEventAccess", () => {
    describe("public events", () => {
      it("allows anyone to access public events (no auth needed)", async () => {
        const event = makeEvent(AUDIENCE_SLUGS.PUBLIC);
        const result = await checkEventAccess(null, event);
        expect(result).toEqual({ allowed: true });
      });

      it("allows authenticated users to access public events", async () => {
        const user = makeUser();
        const event = makeEvent(AUDIENCE_SLUGS.PUBLIC);
        const result = await checkEventAccess(user, event);
        expect(result).toEqual({ allowed: true });
      });
    });

    describe("auth required for non-public events", () => {
      it("denies unauthenticated access to subscriber events", async () => {
        const event = makeEvent(AUDIENCE_SLUGS.SUBSCRIBERS);
        const result = await checkEventAccess(null, event);
        expect(result).toEqual({ allowed: false, reason: "AUTH_REQUIRED" });
      });

      it("denies unauthenticated access to group member events", async () => {
        const event = makeEvent(AUDIENCE_SLUGS.GROUP_MEMBERS);
        const result = await checkEventAccess(null, event);
        expect(result).toEqual({ allowed: false, reason: "AUTH_REQUIRED" });
      });

      it("denies unauthenticated access to on-request events", async () => {
        const event = makeEvent(AUDIENCE_SLUGS.ON_REQUEST);
        const result = await checkEventAccess(null, event);
        expect(result).toEqual({ allowed: false, reason: "AUTH_REQUIRED" });
      });
    });

    describe("admin bypass", () => {
      it("allows admin to access any event type", async () => {
        const admin = makeUser({ role: "admin", subscriptionStatus: "none" });
        for (const slug of Object.values(AUDIENCE_SLUGS)) {
          const result = await checkEventAccess(admin, makeEvent(slug));
          expect(result).toEqual({ allowed: true });
        }
      });

      it("allows superadmin to access any event type", async () => {
        const superadmin = makeUser({ role: "superadmin", subscriptionStatus: "none" });
        for (const slug of Object.values(AUDIENCE_SLUGS)) {
          const result = await checkEventAccess(superadmin, makeEvent(slug));
          expect(result).toEqual({ allowed: true });
        }
      });
    });

    describe("on_request / initiation (admin-granted)", () => {
      it("allows access when user has attendance record", async () => {
        const user = makeUser({ subscriptionStatus: "none" });
        const event = makeEvent(AUDIENCE_SLUGS.ON_REQUEST);

        mockDb.query.userEventAttendance.findFirst.mockResolvedValueOnce({
          userId: 1,
          eventId: 1,
        });

        const result = await checkEventAccess(user, event);
        expect(result).toEqual({ allowed: true });
      });

      it("denies access without attendance record", async () => {
        const user = makeUser({ subscriptionStatus: "none" });
        const event = makeEvent(AUDIENCE_SLUGS.ON_REQUEST);

        mockDb.query.userEventAttendance.findFirst.mockResolvedValueOnce(null);

        const result = await checkEventAccess(user, event);
        expect(result).toEqual({ allowed: false, reason: "ACCESS_DENIED" });
      });

      it("does not require subscription for admin-granted events", async () => {
        const user = makeUser({ subscriptionStatus: "none" });
        const event = makeEvent(AUDIENCE_SLUGS.INITIATION);

        mockDb.query.userEventAttendance.findFirst.mockResolvedValueOnce({
          userId: 1,
          eventId: 1,
        });

        const result = await checkEventAccess(user, event);
        expect(result).toEqual({ allowed: true });
      });
    });

    describe("subscriber events", () => {
      it("allows access with active subscription", async () => {
        const user = makeUser();
        const event = makeEvent(AUDIENCE_SLUGS.SUBSCRIBERS);
        const result = await checkEventAccess(user, event);
        expect(result).toEqual({ allowed: true });
      });

      it("denies access without subscription", async () => {
        const user = makeUser({ subscriptionStatus: "none" });
        const event = makeEvent(AUDIENCE_SLUGS.SUBSCRIBERS);
        const result = await checkEventAccess(user, event);
        expect(result).toEqual({ allowed: false, reason: "SUBSCRIPTION_REQUIRED" });
      });

      it("denies access with expired subscription", async () => {
        const user = makeUser({ subscriptionStatus: "expired" });
        const event = makeEvent(AUDIENCE_SLUGS.SUBSCRIBERS);
        const result = await checkEventAccess(user, event);
        expect(result).toEqual({ allowed: false, reason: "SUBSCRIPTION_REQUIRED" });
      });

      it("denies access when subscription date has passed", async () => {
        const user = makeUser({
          subscriptionStatus: "active",
          subscriptionExpiresAt: new Date("2020-01-01"),
        });
        const event = makeEvent(AUDIENCE_SLUGS.SUBSCRIBERS);
        const result = await checkEventAccess(user, event);
        expect(result).toEqual({ allowed: false, reason: "SUBSCRIPTION_REQUIRED" });
      });

      it("allows access when subscription has no expiry (lifetime)", async () => {
        const user = makeUser({ subscriptionExpiresAt: null });
        const event = makeEvent(AUDIENCE_SLUGS.SUBSCRIBERS);
        const result = await checkEventAccess(user, event);
        expect(result).toEqual({ allowed: true });
      });
    });

    describe("group member events", () => {
      it("allows access with subscription + group membership", async () => {
        const user = makeUser();
        const event = makeEvent(AUDIENCE_SLUGS.GROUP_MEMBERS);

        // Mock: event is linked to group 5
        mockSelectChain([{ retreatGroupId: 5 }]);
        // Mock: user is in group 5
        mockDb.query.userGroupMemberships.findFirst.mockResolvedValueOnce({
          userId: 1,
          retreatGroupId: 5,
        });

        const result = await checkEventAccess(user, event);
        expect(result).toEqual({ allowed: true });
      });

      it("denies access without group membership", async () => {
        const user = makeUser();
        const event = makeEvent(AUDIENCE_SLUGS.GROUP_MEMBERS);

        mockSelectChain([{ retreatGroupId: 5 }]);
        mockDb.query.userGroupMemberships.findFirst.mockResolvedValueOnce(null);

        const result = await checkEventAccess(user, event);
        expect(result).toEqual({ allowed: false, reason: "GROUP_MEMBERSHIP_REQUIRED" });
      });

      it("denies access without subscription even if in group", async () => {
        const user = makeUser({ subscriptionStatus: "none" });
        const event = makeEvent(AUDIENCE_SLUGS.GROUP_MEMBERS);

        const result = await checkEventAccess(user, event);
        expect(result).toEqual({ allowed: false, reason: "SUBSCRIPTION_REQUIRED" });
      });

      it("allows subscribers when event has no linked groups", async () => {
        const user = makeUser();
        const event = makeEvent(AUDIENCE_SLUGS.GROUP_MEMBERS);

        mockSelectChain([]); // No groups linked

        const result = await checkEventAccess(user, event);
        expect(result).toEqual({ allowed: true });
      });
    });

    describe("event participant events", () => {
      it("allows access with subscription + attendance", async () => {
        const user = makeUser();
        const event = makeEvent(AUDIENCE_SLUGS.EVENT_PARTICIPANTS);

        mockDb.query.userEventAttendance.findFirst.mockResolvedValueOnce({
          userId: 1,
          eventId: 1,
        });

        const result = await checkEventAccess(user, event);
        expect(result).toEqual({ allowed: true });
      });

      it("denies access without attendance", async () => {
        const user = makeUser();
        const event = makeEvent(AUDIENCE_SLUGS.EVENT_PARTICIPANTS);

        mockDb.query.userEventAttendance.findFirst.mockResolvedValueOnce(null);

        const result = await checkEventAccess(user, event);
        expect(result).toEqual({ allowed: false, reason: "EVENT_ATTENDANCE_REQUIRED" });
      });

      it("denies access without subscription even if attended", async () => {
        const user = makeUser({ subscriptionStatus: "none" });
        const event = makeEvent(AUDIENCE_SLUGS.EVENT_PARTICIPANTS);

        const result = await checkEventAccess(user, event);
        expect(result).toEqual({ allowed: false, reason: "SUBSCRIPTION_REQUIRED" });
      });
    });

    describe("edge cases", () => {
      it("denies access for unknown audience type", async () => {
        const user = makeUser();
        const event = makeEvent("unknown-slug");
        const result = await checkEventAccess(user, event);
        expect(result).toEqual({ allowed: false, reason: "ACCESS_DENIED" });
      });

      it("denies access when no audience is set", async () => {
        const user = makeUser();
        const event = makeEvent(null);
        const result = await checkEventAccess(user, event);
        expect(result).toEqual({ allowed: false, reason: "ACCESS_DENIED" });
      });
    });
  });

  describe("filterAccessibleEvents", () => {
    it("returns only accessible events", async () => {
      const user = makeUser();
      const events = [
        makeEvent(AUDIENCE_SLUGS.PUBLIC, 1),
        makeEvent(AUDIENCE_SLUGS.SUBSCRIBERS, 2),
        makeEvent("unknown-slug", 3),
      ];

      const result = await filterAccessibleEvents(user, events);

      expect(result).toHaveLength(2);
      expect(result.map((e) => e.id)).toEqual([1, 2]);
    });

    it("returns all public events for unauthenticated users", async () => {
      const events = [
        makeEvent(AUDIENCE_SLUGS.PUBLIC, 1),
        makeEvent(AUDIENCE_SLUGS.PUBLIC, 2),
        makeEvent(AUDIENCE_SLUGS.SUBSCRIBERS, 3),
      ];

      const result = await filterAccessibleEvents(null, events);

      expect(result).toHaveLength(2);
      expect(result.map((e) => e.id)).toEqual([1, 2]);
    });

    it("returns empty array for empty event list", async () => {
      const result = await filterAccessibleEvents(makeUser(), []);
      expect(result).toEqual([]);
    });
  });
});

describe("eventStatusVisibleTo", () => {
  it("returns published + draft for an admin", () => {
    expect([...eventStatusVisibleTo("admin")].sort()).toEqual(["draft", "published"]);
  });
  it("returns published + draft for a superadmin", () => {
    expect([...eventStatusVisibleTo("superadmin")].sort()).toEqual(["draft", "published"]);
  });
  it("returns published only for a regular user", () => {
    expect(eventStatusVisibleTo("user")).toEqual(["published"]);
  });
  it("returns published only for an unauthenticated caller", () => {
    expect(eventStatusVisibleTo(null)).toEqual(["published"]);
    expect(eventStatusVisibleTo(undefined)).toEqual(["published"]);
  });
});

describe("checkEventAccess — status gate", () => {
  const publicEvent = (status: string) => ({
    id: 1,
    status,
    audienceId: 1,
    audience: { slug: "free-anyone" },
  });
  const admin = { id: 1, role: "admin", subscriptionStatus: "none", subscriptionExpiresAt: null };
  const regular = { id: 2, role: "user", subscriptionStatus: "none", subscriptionExpiresAt: null };

  it("allows an admin to access a draft event", async () => {
    const r = await checkEventAccess(admin, publicEvent("draft"));
    expect(r.allowed).toBe(true);
  });
  it("hides a draft event from a regular user", async () => {
    const r = await checkEventAccess(regular, publicEvent("draft"));
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("STATUS_HIDDEN");
  });
  it("hides a draft event from an unauthenticated caller", async () => {
    const r = await checkEventAccess(null, publicEvent("draft"));
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("STATUS_HIDDEN");
  });
  it("hides an archived event even from an admin", async () => {
    const r = await checkEventAccess(admin, publicEvent("archived"));
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe("STATUS_HIDDEN");
  });
  it("still allows a regular user to access a published public event", async () => {
    const r = await checkEventAccess(regular, publicEvent("published"));
    expect(r.allowed).toBe(true);
  });
});

describe("denialToHttpError", () => {
  const cases: { reason: AccessDeniedReason; status: number }[] = [
    { reason: "STATUS_HIDDEN", status: 404 },
    { reason: "AUTH_REQUIRED", status: 401 },
    { reason: "SUBSCRIPTION_REQUIRED", status: 403 },
    { reason: "GROUP_MEMBERSHIP_REQUIRED", status: 403 },
    { reason: "EVENT_ATTENDANCE_REQUIRED", status: 403 },
    { reason: "ACCESS_DENIED", status: 403 },
  ];

  for (const { reason, status } of cases) {
    it(`throws an AppError with HTTP ${status} for ${reason}`, () => {
      let thrown: unknown;
      try {
        denialToHttpError(reason);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AppError);
      // instanceof check above narrows; also fails the test if it is not an AppError
      if (thrown instanceof AppError) {
        expect(thrown.statusCode).toBe(status);
      }
    });
  }
});
