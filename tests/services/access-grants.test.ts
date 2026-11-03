import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      eventAccessGrants: { findFirst: vi.fn() },
      userEventAttendance: { findFirst: vi.fn() },
      userGroupMemberships: { findFirst: vi.fn() },
    },
    select: vi.fn(),
  },
}));

import { db } from "../../src/db/index.ts";
import {
  checkEventAccess,
  filterAccessibleEvents,
  hasEventGrant,
  checkEventAccessAudienceOnly,
  AUDIENCE_SLUGS,
} from "../../src/services/access.ts";

const mockDb = db as any;

const noSubscription = {
  id: 7,
  role: "user",
  subscriptionStatus: "none",
  subscriptionExpiresAt: null,
};

function makeEvent(slug: string | null, id = 1, status = "published", included = false) {
  return {
    id,
    status,
    audience: slug ? { slug } : null,
    audienceId: slug ? 1 : null,
    includedInMembership: included,
  };
}

const activeMember = {
  id: 7,
  role: "user",
  subscriptionStatus: "active",
  subscriptionExpiresAt: new Date(Date.now() + 30 * 86_400_000),
};

const expiredMember = {
  id: 7,
  role: "user",
  subscriptionStatus: "active",
  subscriptionExpiresAt: new Date(Date.now() - 90 * 86_400_000),
};

function grantExists(exists: boolean) {
  mockDb.query.eventAccessGrants.findFirst.mockResolvedValue(
    exists ? { userId: 7, eventId: 1 } : undefined,
  );
}

function grantedEventIds(ids: number[]) {
  const where = vi.fn().mockResolvedValue(ids.map((eventId) => ({ eventId })));
  mockDb.select.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });
  return where;
}

describe("event access grants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.userEventAttendance.findFirst.mockResolvedValue(undefined);
    mockDb.query.userGroupMemberships.findFirst.mockResolvedValue(undefined);
  });

  describe("hasEventGrant", () => {
    it("should return true when a grant row exists", async () => {
      grantExists(true);
      expect(await hasEventGrant(7, 1)).toBe(true);
    });

    it("should return false when no grant row exists", async () => {
      grantExists(false);
      expect(await hasEventGrant(7, 1)).toBe(false);
    });
  });

  describe("checkEventAccess", () => {
    const audiences = [
      AUDIENCE_SLUGS.SUBSCRIBERS,
      AUDIENCE_SLUGS.GROUP_MEMBERS,
      AUDIENCE_SLUGS.EVENT_PARTICIPANTS,
      AUDIENCE_SLUGS.ON_REQUEST,
      AUDIENCE_SLUGS.INITIATION,
      AUDIENCE_SLUGS.RESTRICTED,
    ];

    it.each(audiences)(
      "should allow a user without subscription when they hold a grant on a %s event",
      async (slug) => {
        grantExists(true);
        const result = await checkEventAccess(noSubscription, makeEvent(slug));
        expect(result).toEqual({ allowed: true });
      },
    );

    it("should allow a grant on an event with no audience", async () => {
      grantExists(true);
      const result = await checkEventAccess(noSubscription, makeEvent(null));
      expect(result).toEqual({ allowed: true });
    });

    it("should hide a draft event from a grant holder (status gate first)", async () => {
      grantExists(true);
      const result = await checkEventAccess(
        noSubscription,
        makeEvent(AUDIENCE_SLUGS.SUBSCRIBERS, 1, "draft"),
      );
      expect(result).toEqual({ allowed: false, reason: "STATUS_HIDDEN" });
      expect(mockDb.query.eventAccessGrants.findFirst).not.toHaveBeenCalled();
    });

    it("should hide an archived event from a grant holder", async () => {
      grantExists(true);
      const result = await checkEventAccess(
        noSubscription,
        makeEvent(AUDIENCE_SLUGS.SUBSCRIBERS, 1, "archived"),
      );
      expect(result).toEqual({ allowed: false, reason: "STATUS_HIDDEN" });
    });

    it("should keep the old behaviour when there is no grant", async () => {
      grantExists(false);
      const subscribers = await checkEventAccess(
        noSubscription,
        makeEvent(AUDIENCE_SLUGS.SUBSCRIBERS),
      );
      expect(subscribers).toEqual({ allowed: false, reason: "SUBSCRIPTION_REQUIRED" });

      const onRequest = await checkEventAccess(
        noSubscription,
        makeEvent(AUDIENCE_SLUGS.ON_REQUEST),
      );
      expect(onRequest).toEqual({ allowed: false, reason: "ACCESS_DENIED" });
    });

    it("should still require authentication when the caller is anonymous", async () => {
      const result = await checkEventAccess(null, makeEvent(AUDIENCE_SLUGS.SUBSCRIBERS));
      expect(result).toEqual({ allowed: false, reason: "AUTH_REQUIRED" });
      expect(mockDb.query.eventAccessGrants.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("membership inclusion", () => {
    const nonPublic = [
      AUDIENCE_SLUGS.SUBSCRIBERS,
      AUDIENCE_SLUGS.GROUP_MEMBERS,
      AUDIENCE_SLUGS.EVENT_PARTICIPANTS,
      AUDIENCE_SLUGS.ON_REQUEST,
      AUDIENCE_SLUGS.INITIATION,
      AUDIENCE_SLUGS.RESTRICTED,
    ];

    it.each(nonPublic)(
      "should allow an active member with no grant on an included %s event",
      async (slug) => {
        grantExists(false);
        const result = await checkEventAccess(activeMember, makeEvent(slug, 1, "published", true));
        expect(result).toEqual({ allowed: true });
      },
    );

    it("should allow an active member on an included event with no audience", async () => {
      grantExists(false);
      const result = await checkEventAccess(activeMember, makeEvent(null, 1, "published", true));
      expect(result).toEqual({ allowed: true });
    });

    it.each([
      ["no subscription", noSubscription],
      ["an expired subscription", expiredMember],
    ])("should deny a user with %s on an included event", async (_label, user) => {
      grantExists(false);
      const result = await checkEventAccess(
        user,
        makeEvent(AUDIENCE_SLUGS.RESTRICTED, 1, "published", true),
      );
      expect(result).toEqual({ allowed: false, reason: "ACCESS_DENIED" });
    });

    it("should deny an active member on a restricted event that is not included", async () => {
      grantExists(false);
      const result = await checkEventAccess(
        activeMember,
        makeEvent(AUDIENCE_SLUGS.RESTRICTED, 1, "published", false),
      );
      expect(result).toEqual({ allowed: false, reason: "ACCESS_DENIED" });
    });

    it("should hide an included draft event from an active member", async () => {
      grantExists(false);
      const result = await checkEventAccess(
        activeMember,
        makeEvent(AUDIENCE_SLUGS.RESTRICTED, 1, "draft", true),
      );
      expect(result).toEqual({ allowed: false, reason: "STATUS_HIDDEN" });
    });

    it("should still require authentication on an included event", async () => {
      const result = await checkEventAccess(
        null,
        makeEvent(AUDIENCE_SLUGS.RESTRICTED, 1, "published", true),
      );
      expect(result).toEqual({ allowed: false, reason: "AUTH_REQUIRED" });
    });

    it("should include such events in filterAccessibleEvents without an extra query per event", async () => {
      grantedEventIds([]);
      const result = await filterAccessibleEvents(activeMember, [
        makeEvent(AUDIENCE_SLUGS.RESTRICTED, 1, "published", true),
        makeEvent(AUDIENCE_SLUGS.RESTRICTED, 2, "published", false),
        makeEvent(AUDIENCE_SLUGS.EVENT_PARTICIPANTS, 3, "published", true),
        makeEvent(AUDIENCE_SLUGS.RESTRICTED, 4, "draft", true),
      ]);
      expect(result.map((e) => e.id)).toEqual([1, 3]);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      expect(mockDb.query.eventAccessGrants.findFirst).not.toHaveBeenCalled();
    });

    it("should leave a non-member's filtered list unchanged", async () => {
      grantedEventIds([]);
      const result = await filterAccessibleEvents(noSubscription, [
        makeEvent(AUDIENCE_SLUGS.RESTRICTED, 1, "published", true),
      ]);
      expect(result).toEqual([]);
    });
  });

  describe("filterAccessibleEvents", () => {
    it("should load the user's grants once for the whole list", async () => {
      const where = grantedEventIds([2, 4]);
      const events = [
        makeEvent(AUDIENCE_SLUGS.SUBSCRIBERS, 1),
        makeEvent(AUDIENCE_SLUGS.RESTRICTED, 2),
        makeEvent(AUDIENCE_SLUGS.ON_REQUEST, 3),
        makeEvent(AUDIENCE_SLUGS.EVENT_PARTICIPANTS, 4),
        makeEvent(AUDIENCE_SLUGS.GROUP_MEMBERS, 5),
      ];

      const result = await filterAccessibleEvents(noSubscription, events);

      expect(result.map((e) => e.id)).toEqual([2, 4]);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      expect(where).toHaveBeenCalledTimes(1);
      expect(mockDb.query.eventAccessGrants.findFirst).not.toHaveBeenCalled();
    });

    it("should not return a granted draft event", async () => {
      grantedEventIds([1]);
      const result = await filterAccessibleEvents(noSubscription, [
        makeEvent(AUDIENCE_SLUGS.SUBSCRIBERS, 1, "draft"),
      ]);
      expect(result).toEqual([]);
    });

    it("should not query grants for anonymous callers", async () => {
      const result = await filterAccessibleEvents(null, [
        makeEvent(AUDIENCE_SLUGS.PUBLIC, 1),
        makeEvent(AUDIENCE_SLUGS.SUBSCRIBERS, 2),
      ]);
      expect(result.map((e) => e.id)).toEqual([1]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });
});

describe("checkEventAccessAudienceOnly", () => {
  it("should ignore a grant that checkEventAccess honours", async () => {
    grantExists(true);
    mockDb.query.userEventAttendance.findFirst.mockResolvedValue(undefined);
    const ev = makeEvent("restricted");
    expect((await checkEventAccess(noSubscription, ev)).allowed).toBe(true);
    expect((await checkEventAccessAudienceOnly(noSubscription, ev)).allowed).toBe(false);
  });

  it("should ignore membership inclusion", async () => {
    grantExists(false);
    const member = { ...noSubscription, subscriptionStatus: "active" };
    const ev = { ...makeEvent("restricted"), includedInMembership: true };
    expect((await checkEventAccess(member, ev)).allowed).toBe(true);
    expect((await checkEventAccessAudienceOnly(member, ev)).allowed).toBe(false);
  });

  it("should still follow the audience rule", async () => {
    expect((await checkEventAccessAudienceOnly(null, makeEvent("free-anyone"))).allowed).toBe(true);
  });
});
