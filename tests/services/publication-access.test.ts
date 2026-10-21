import { describe, it, expect, vi, beforeEach } from "vitest";

// The real checkEventAccess runs here, on a small fake database: a publication
// must follow exactly the rules events follow, so the event logic is not mocked.

const AUDIENCES = [
  { id: 7, slug: "free-anyone" },
  { id: 8, slug: "free-subscribers" },
  { id: 9, slug: "event-participants" },
  { id: 10, slug: "retreat-group-members" },
  { id: 11, slug: "received-initiation" },
  { id: 12, slug: "available-on-request-only" },
];

const state = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  links: [] as { publicationId: number; eventId: number }[],
  attendedEventIds: new Set<number>(),
  eventGroups: new Map<number, number[]>(),
  userGroupIds: new Set<number>(),
}));

/** Numbers bound into a drizzle where-clause, to tell which event it asks about. */
function paramsOf(node: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(node)) node.forEach((n) => paramsOf(n, found));
  else if (node && typeof node === "object") {
    const obj = node as { queryChunks?: unknown[]; value?: unknown };
    if (obj.queryChunks) paramsOf(obj.queryChunks, found);
    else if (typeof obj.value === "number") found.push(obj.value);
  }
  return found;
}

vi.mock("../../src/db/index.ts", () => {
  // audiences is awaited straight after from(); event groups after where().
  const from = (table: { [k: symbol]: unknown }) => {
    const isAudiences = Object.values(table).some((c) => (c as { name?: string })?.name === "name_en");
    if (isAudiences) {
      return { then: (ok: (v: unknown) => unknown) => Promise.resolve(AUDIENCES).then(ok) };
    }
    return {
      where: (cond: unknown) => {
        const eventId = paramsOf(cond)[0] as number;
        return Promise.resolve(
          (state.eventGroups.get(eventId) ?? []).map((retreatGroupId) => ({ retreatGroupId })),
        );
      },
    };
  };
  return {
    db: {
      select: () => ({ from }),
      query: {
        users: { findFirst: () => Promise.resolve(state.user) },
        eventPublications: { findMany: () => Promise.resolve(state.links) },
        userEventAttendance: {
          findFirst: ({ where }: { where: unknown }) =>
            Promise.resolve(
              paramsOf(where).some((v) => state.attendedEventIds.has(v as number)) ? { id: 1 } : undefined,
            ),
        },
        userGroupMemberships: {
          findFirst: ({ where }: { where: unknown }) =>
            Promise.resolve(
              paramsOf(where).some((v) => state.userGroupIds.has(v as number)) ? { id: 1 } : undefined,
            ),
        },
      },
    },
  };
});

import { openablePublications } from "../../src/services/publication-access.ts";

const AUD = {
  public: 7,
  members: 8,
  participants: 9,
  groups: 10,
  initiation: 11,
  onRequest: 12,
};
const member = { id: 7, role: "user" };
const memberRow = { id: 7, role: "user", subscriptionStatus: "active", subscriptionExpiresAt: null };
const nonMemberRow = { ...memberRow, subscriptionStatus: "none" };

async function opens(
  who: { id: number; role: string } | null,
  audienceId: number | null,
  eventIds: number[] = [],
) {
  state.links = eventIds.map((eventId) => ({ publicationId: 1, eventId }));
  const opened = await openablePublications(who, [{ id: 1, audienceId }]);
  return opened.has(1);
}

describe("openablePublications", () => {
  beforeEach(() => {
    state.user = memberRow;
    state.links = [];
    state.attendedEventIds = new Set();
    state.eventGroups = new Map();
    state.userGroupIds = new Set();
  });

  describe("public", () => {
    it("should open to a signed-out visitor", async () => {
      expect(await opens(null, AUD.public)).toBe(true);
    });
  });

  describe("members", () => {
    it("should open to a member and refuse a visitor or a non-member", async () => {
      expect(await opens(member, AUD.members)).toBe(true);
      expect(await opens(null, AUD.members)).toBe(false);
      state.user = nonMemberRow;
      expect(await opens(member, AUD.members)).toBe(false);
    });

    it("should refuse a member whose paid-through date is past the grace period", async () => {
      state.user = { ...memberRow, subscriptionExpiresAt: new Date("2020-01-01") };
      expect(await opens(member, AUD.members)).toBe(false);
    });

    it("should open to an admin who is not a member", async () => {
      state.user = { ...nonMemberRow, role: "admin" };
      expect(await opens({ id: 7, role: "admin" }, AUD.members)).toBe(true);
    });
  });

  describe("event participants", () => {
    it("should open to a member who attended one of the linked events", async () => {
      state.attendedEventIds = new Set([101]);
      expect(await opens(member, AUD.participants, [100, 101])).toBe(true);
    });

    it("should refuse a member who attended none of the linked events", async () => {
      state.attendedEventIds = new Set([999]);
      expect(await opens(member, AUD.participants, [100, 101])).toBe(false);
    });

    it("should refuse an attendee who is not a member, as for the event itself", async () => {
      state.user = nonMemberRow;
      state.attendedEventIds = new Set([100]);
      expect(await opens(member, AUD.participants, [100])).toBe(false);
    });

    it("should refuse a signed-out visitor", async () => {
      expect(await opens(null, AUD.participants, [100])).toBe(false);
    });
  });

  describe("retreat group members", () => {
    it("should open to a member of a group of one of the linked events", async () => {
      state.eventGroups = new Map([[100, [1]], [101, [2]]]);
      state.userGroupIds = new Set([2]);
      expect(await opens(member, AUD.groups, [100, 101])).toBe(true);
    });

    it("should open to a member who attended a linked event without being in its group", async () => {
      state.eventGroups = new Map([[100, [1]]]);
      state.attendedEventIds = new Set([100]);
      expect(await opens(member, AUD.groups, [100])).toBe(true);
    });

    it("should refuse a member of none of the groups", async () => {
      state.eventGroups = new Map([[100, [1]]]);
      state.userGroupIds = new Set([5]);
      expect(await opens(member, AUD.groups, [100])).toBe(false);
    });

    it("should refuse a non-member even inside the group", async () => {
      state.user = nonMemberRow;
      state.eventGroups = new Map([[100, [1]]]);
      state.userGroupIds = new Set([1]);
      expect(await opens(member, AUD.groups, [100])).toBe(false);
    });
  });

  describe.each([
    ["received initiation", AUD.initiation],
    ["available on request only", AUD.onRequest],
  ])("%s", (_name, audienceId) => {
    it("should open to a user an admin granted one of the linked events, member or not", async () => {
      state.user = nonMemberRow;
      state.attendedEventIds = new Set([101]);
      expect(await opens(member, audienceId, [100, 101])).toBe(true);
    });

    it("should refuse a user granted none of the linked events", async () => {
      expect(await opens(member, audienceId, [100, 101])).toBe(false);
    });
  });

  describe("event-based audiences without linked events", () => {
    it.each([AUD.participants, AUD.groups, AUD.initiation, AUD.onRequest])(
      "should refuse a member for audience %i but open it to an admin",
      async (audienceId) => {
        expect(await opens(member, audienceId, [])).toBe(false);
        state.user = { ...memberRow, role: "admin" };
        expect(await opens({ id: 7, role: "admin" }, audienceId, [])).toBe(true);
      },
    );
  });

  describe("unknown audience", () => {
    it("should refuse a missing or unrecognised audience, even to an admin", async () => {
      state.user = { ...memberRow, role: "admin" };
      expect(await opens({ id: 7, role: "admin" }, null)).toBe(false);
      expect(await opens({ id: 7, role: "admin" }, 4242)).toBe(false);
    });
  });

  it("should decide each publication on its own audience", async () => {
    state.attendedEventIds = new Set([100]);
    state.links = [{ publicationId: 2, eventId: 100 }];
    const opened = await openablePublications(member, [
      { id: 1, audienceId: AUD.public },
      { id: 2, audienceId: AUD.participants },
      { id: 3, audienceId: AUD.participants },
    ]);
    expect([...opened].sort()).toEqual([1, 2]);
  });

  it("should not touch the database when there is nothing to decide", async () => {
    expect((await openablePublications(member, [])).size).toBe(0);
  });
});
