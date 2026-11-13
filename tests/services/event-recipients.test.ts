import { describe, it, expect, vi, beforeEach } from "vitest";

// An in-memory database: the recipients service reads it through db.select().from(table),
// and access.ts (used by the consistency test) through db.query.*.findFirst.
const h = vi.hoisted(() => ({
  event: undefined as any,
  users: [] as any[],
  grants: [] as number[],
  attendees: [] as number[],
  eventGroups: [] as number[],
  memberships: [] as { userId: number; groupId: number }[],
}));

vi.mock("../../src/db/index.ts", async () => {
  const { users, userEventAttendance, userGroupMemberships } = await import("../../src/db/schema/users.ts");
  const { eventAccessGrants } = await import("../../src/db/schema/event-access.ts");
  const { eventRetreatGroups } = await import("../../src/db/schema/retreats.ts");
  const rowsFor = (table: unknown): unknown[] => {
    if (table === users) return h.users;
    if (table === eventAccessGrants) return h.grants.map((userId) => ({ userId }));
    if (table === userEventAttendance) return h.attendees.map((userId) => ({ userId }));
    if (table === eventRetreatGroups) return h.eventGroups.map((retreatGroupId) => ({ retreatGroupId }));
    if (table === userGroupMemberships) {
      return h.memberships.filter((m) => h.eventGroups.includes(m.groupId)).map((m) => ({ userId: m.userId }));
    }
    return [];
  };
  return {
    db: {
      select: () => ({ from: (table: unknown) => ({ where: () => Promise.resolve(rowsFor(table)) }) }),
      query: {
        events: { findFirst: () => Promise.resolve(h.event) },
        eventAccessGrants: { findFirst: vi.fn() },
        userEventAttendance: { findFirst: vi.fn() },
        userGroupMemberships: { findFirst: vi.fn() },
      },
    },
  };
});

import { db } from "../../src/db/index.ts";
import { listEventRecipients } from "../../src/services/event-recipients.ts";
import { checkEventAccess } from "../../src/services/access.ts";
import { config } from "../../src/config.ts";

const mockDb = db as any;

const FUTURE = new Date("2099-01-01");

function user(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    email: `u${id}@test.com`,
    firstName: `U${id}`,
    preferredLanguage: "pt",
    isActive: true,
    role: "user",
    subscriptionStatus: "none",
    subscriptionExpiresAt: null,
    ...overrides,
  };
}
const member = (id: number, overrides: Record<string, unknown> = {}) =>
  user(id, { subscriptionStatus: "active", subscriptionExpiresAt: FUTURE, ...overrides });

function setEvent(slug: string | null, overrides: Record<string, unknown> = {}) {
  h.event = { id: 1, status: "published", audience: slug ? { slug } : null, includedInMembership: false, ...overrides };
}

const ids = async () => (await listEventRecipients(1)).map((r) => r.id).sort((a, b) => a - b);

beforeEach(() => {
  h.users = [];
  h.grants = [];
  h.attendees = [];
  h.eventGroups = [];
  h.memberships = [];
  setEvent(null);
});

describe("listEventRecipients", () => {
  it("should return nobody when the event does not exist", async () => {
    h.event = undefined;
    h.users = [user(1)];
    expect(await ids()).toEqual([]);
  });

  it("should return every active account for the free-anyone audience", async () => {
    setEvent("free-anyone");
    h.users = [user(1), member(2), user(3, { isActive: false })];
    expect(await ids()).toEqual([1, 2]);
  });

  it("should return every active account for account-holders", async () => {
    setEvent("account-holders");
    h.users = [user(1), member(2)];
    expect(await ids()).toEqual([1, 2]);
  });

  it("should return active members only for free-subscribers", async () => {
    setEvent("free-subscribers");
    h.users = [user(1), member(2), member(3, { subscriptionExpiresAt: new Date("2000-01-01") })];
    expect(await ids()).toEqual([2]);
  });

  it("should return members of the event's groups and attendees for retreat-group-members", async () => {
    setEvent("retreat-group-members");
    h.eventGroups = [10];
    h.memberships = [{ userId: 2, groupId: 10 }, { userId: 3, groupId: 99 }];
    h.attendees = [4];
    h.users = [member(1), member(2), member(3), member(4), user(5), user(6)];
    h.memberships.push({ userId: 5, groupId: 10 });
    // 1: member, no group; 2: in group; 3: other group; 4: attended; 5: in group but no membership
    expect(await ids()).toEqual([2, 4]);
  });

  it("should return every active member when no group is linked", async () => {
    setEvent("retreat-group-members");
    h.users = [member(1), user(2)];
    expect(await ids()).toEqual([1]);
  });

  it("should not require a membership for retreat-group-members-no-membership", async () => {
    setEvent("retreat-group-members-no-membership");
    h.eventGroups = [10];
    h.memberships = [{ userId: 2, groupId: 10 }];
    h.attendees = [3];
    h.users = [user(1), user(2), user(3)];
    expect(await ids()).toEqual([2, 3]);
  });

  it("should return attending members for event-participants", async () => {
    setEvent("event-participants");
    h.attendees = [1, 2];
    h.users = [member(1), user(2), member(3)];
    expect(await ids()).toEqual([1]);
  });

  it("should return attendees without membership for event-participants-no-membership", async () => {
    setEvent("event-participants-no-membership");
    h.attendees = [1, 2];
    h.users = [member(1), user(2), member(3)];
    expect(await ids()).toEqual([1, 2]);
  });

  it.each(["available-on-request-only", "received-initiation", "restricted"])(
    "should return admin-granted attendees only for %s",
    async (slug) => {
      setEvent(slug);
      h.attendees = [2];
      h.users = [member(1), user(2)];
      expect(await ids()).toEqual([2]);
    },
  );

  it.each(["everyone-paid", "member-extra-subscription", "some-custom-audience", null])(
    "should return only grant holders for the audience %s",
    async (slug) => {
      setEvent(slug);
      h.grants = [2];
      h.users = [member(1), user(2)];
      expect(await ids()).toEqual([2]);
    },
  );

  it("should add grant holders to any audience, deduplicated", async () => {
    setEvent("free-subscribers");
    h.grants = [1, 2];
    h.users = [member(1), user(2)];
    const result = await listEventRecipients(1);
    expect(result.map((r) => r.id).sort()).toEqual([1, 2]);
  });

  it("should add active members when the event is included in the membership", async () => {
    setEvent("received-initiation", { includedInMembership: true });
    h.users = [member(1), user(2)];
    expect(await ids()).toEqual([1]);
  });

  it("should not add members by membership inclusion on a paid audience", async () => {
    setEvent("everyone-paid", { includedInMembership: true });
    h.users = [member(1)];
    expect(await ids()).toEqual([]);
  });

  it("should leave out inactive accounts even with a grant", async () => {
    setEvent("everyone-paid");
    h.grants = [1];
    h.users = [user(1, { isActive: false })];
    expect(await ids()).toEqual([]);
  });

  it("should leave out the store-review account", async () => {
    setEvent("free-anyone");
    h.users = [user(1, { email: config.review.email.toUpperCase() }), user(2)];
    expect(await ids()).toEqual([2]);
  });

  it("should expose id, email, first name and language only", async () => {
    setEvent("free-anyone");
    h.users = [user(1)];
    expect(await listEventRecipients(1)).toEqual([
      { id: 1, email: "u1@test.com", firstName: "U1", preferredLanguage: "pt" },
    ]);
  });
});

describe("recipients and checkEventAccess agree", () => {
  const audiences = [
    "free-anyone",
    "account-holders",
    "free-subscribers",
    "retreat-group-members",
    "retreat-group-members-no-membership",
    "event-participants",
    "event-participants-no-membership",
    "available-on-request-only",
    "received-initiation",
    "restricted",
    "everyone-paid",
    "member-extra-subscription",
    "custom",
  ];

  it.each(audiences)("should only list users who can open the published event: %s", async (slug) => {
    setEvent(slug, { includedInMembership: slug === "custom" });
    h.eventGroups = [10];
    h.memberships = [{ userId: 3, groupId: 10 }, { userId: 4, groupId: 10 }];
    h.attendees = [5, 6];
    h.grants = [7];
    h.users = [user(1), member(2), user(3), member(4), user(5), member(6), user(7), member(8)];

    mockDb.query.eventAccessGrants.findFirst.mockImplementation(async () => undefined);
    const forUser = (id: number) => {
      mockDb.query.eventAccessGrants.findFirst.mockImplementation(async () => (h.grants.includes(id) ? { id } : undefined));
      mockDb.query.userEventAttendance.findFirst.mockImplementation(async () => (h.attendees.includes(id) ? { id } : undefined));
      mockDb.query.userGroupMemberships.findFirst.mockImplementation(async () =>
        h.memberships.some((m) => m.userId === id && h.eventGroups.includes(m.groupId)) ? { id } : undefined,
      );
    };

    for (const r of await listEventRecipients(1)) {
      forUser(r.id);
      const u = h.users.find((x) => x.id === r.id)!;
      const access = await checkEventAccess(
        { id: u.id, role: u.role, subscriptionStatus: u.subscriptionStatus, subscriptionExpiresAt: u.subscriptionExpiresAt },
        h.event,
      );
      expect(access.allowed, `user ${r.id} on ${slug}`).toBe(true);
    }
  });

  it("should list every user who can open it, not only a subset", async () => {
    setEvent("retreat-group-members");
    h.eventGroups = [10];
    h.memberships = [{ userId: 3, groupId: 10 }];
    h.users = [member(3), member(4)];
    h.eventGroups = [10];
    expect(await ids()).toEqual([3]);
  });
});
