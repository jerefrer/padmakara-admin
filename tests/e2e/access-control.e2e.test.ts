/**
 * E2E access-control matrix test.
 *
 * Verifies that each audience type (free-anyone, free-subscribers,
 * retreat-group-members, event-participants, available-on-request-only,
 * received-initiation) is correctly gated for every test user persona.
 *
 * The seed dataset (tests/e2e/support/seed.ts + global-setup.ts) inserts all
 * rows before this file runs. This file only reads the DB to resolve IDs —
 * it does NOT re-seed.
 *
 * Verified access matrix (source of truth: src/services/access.ts):
 *
 *   User        | anyone | subscribers | groupMembers | participants | onRequest | initiation
 *   ------------|--------|-------------|--------------|--------------|-----------|----------
 *   nosub       |  ✓     |             |              |              |           |
 *   subscriber  |  ✓     |  ✓          |              |              |           |
 *   groupMember |  ✓     |  ✓          |  ✓           |              |           |
 *   participant |  ✓     |  ✓          |              |  ✓           |           |
 *   granted     |  ✓     |             |              |              |  ✓        |  ✓
 *   admin       |  ✓     |  ✓          |  ✓           |  ✓           |  ✓        |  ✓
 *
 * Denial status for GET /api/events/:id: 403 (AppError.forbidden)
 * Denial status for GET /api/events/public/:id: 403 (AppError.forbidden)
 */

import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../../src/db/index.ts";
import { users } from "../../src/db/schema/users.ts";
import { events } from "../../src/db/schema/retreats.ts";
import { testJson } from "../helpers.ts";
import { tokenForUser, authHeader } from "./support/auth.ts";
import { EVENT_CODES, TEST_USERS } from "./support/fixtures.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ResolvedUser {
  id: number;
  email: string;
  role: string;
}

interface ResolvedEvent {
  id: number;
  eventCode: string;
}

type UserKey  = keyof typeof TEST_USERS;
type EventKey = keyof typeof EVENT_CODES;

// ─── Shared state (resolved in beforeAll) ─────────────────────────────────────

let resolvedUsers: Record<UserKey, ResolvedUser>;
let resolvedEvents: Record<EventKey, ResolvedEvent>;

// ─── Expected access matrix ───────────────────────────────────────────────────

/**
 * For each user persona, the set of EVENT_CODES keys they are allowed to see.
 * Derived from access.ts rules and the seeded subscription / group / attendance data.
 */
const ALLOWED: Record<UserKey, ReadonlySet<EventKey>> = {
  nosub:       new Set<EventKey>(["anyone"]),
  subscriber:  new Set<EventKey>(["anyone", "subscribers"]),
  groupMember: new Set<EventKey>(["anyone", "subscribers", "groupMembers"]),
  participant: new Set<EventKey>(["anyone", "subscribers", "participants"]),
  granted:     new Set<EventKey>(["anyone", "onRequest", "initiation"]),
  admin:       new Set<EventKey>(["anyone", "subscribers", "groupMembers", "participants", "onRequest", "initiation"]),
};

// ─── Setup: resolve DB rows ───────────────────────────────────────────────────

beforeAll(async () => {
  // Resolve users — SELECT by email (inserted by seed.ts)
  const userEntries = await Promise.all(
    (Object.keys(TEST_USERS) as UserKey[]).map(async (key) => {
      const def = TEST_USERS[key];
      const [row] = await db
        .select({ id: users.id, email: users.email, role: users.role })
        .from(users)
        .where(eq(users.email, def.email));
      if (!row) {
        throw new Error(`access-control: user "${def.email}" not found in DB — was seed.ts run?`);
      }
      return [key, row] as const;
    }),
  );
  resolvedUsers = Object.fromEntries(userEntries) as Record<UserKey, ResolvedUser>;

  // Resolve events — SELECT by eventCode (inserted by seed.ts)
  const eventEntries = await Promise.all(
    (Object.keys(EVENT_CODES) as EventKey[]).map(async (key) => {
      const code = EVENT_CODES[key];
      const [row] = await db
        .select({ id: events.id, eventCode: events.eventCode })
        .from(events)
        .where(eq(events.eventCode, code));
      if (!row) {
        throw new Error(`access-control: event "${code}" not found in DB — was seed.ts run?`);
      }
      return [key, row] as const;
    }),
  );
  resolvedEvents = Object.fromEntries(eventEntries) as Record<EventKey, ResolvedEvent>;
});

// ─── Helper ───────────────────────────────────────────────────────────────────

/** Returns the set of eventCode keys present in a GET /api/events response. */
async function getVisibleEventKeys(token: string): Promise<Set<EventKey>> {
  const { status, body } = await testJson<Array<{ eventCode: string }>>("/api/events", {
    headers: authHeader(token),
  });
  expect(status).toBe(200);
  const allCodes = new Set(Object.values(EVENT_CODES));
  const visible = new Set<EventKey>();
  for (const ev of body) {
    if (!allCodes.has(ev.eventCode as (typeof EVENT_CODES)[EventKey])) continue;
    const key = (Object.keys(EVENT_CODES) as EventKey[]).find(
      (k) => EVENT_CODES[k] === ev.eventCode,
    );
    if (key) visible.add(key);
  }
  return visible;
}

// ─── Authenticated list endpoint ──────────────────────────────────────────────

describe("GET /api/events — authenticated event list", () => {
  it("nosub sees only the free-anyone event", async () => {
    const user = resolvedUsers.nosub;
    const token = await tokenForUser(user);
    const visible = await getVisibleEventKeys(token);
    expect(visible).toEqual(ALLOWED.nosub);
  });

  it("subscriber sees anyone + subscribers", async () => {
    const user = resolvedUsers.subscriber;
    const token = await tokenForUser(user);
    const visible = await getVisibleEventKeys(token);
    expect(visible).toEqual(ALLOWED.subscriber);
  });

  it("groupMember sees anyone + subscribers + groupMembers", async () => {
    const user = resolvedUsers.groupMember;
    const token = await tokenForUser(user);
    const visible = await getVisibleEventKeys(token);
    expect(visible).toEqual(ALLOWED.groupMember);
  });

  it("participant sees anyone + subscribers + participants", async () => {
    const user = resolvedUsers.participant;
    const token = await tokenForUser(user);
    const visible = await getVisibleEventKeys(token);
    expect(visible).toEqual(ALLOWED.participant);
  });

  it("granted sees anyone + onRequest + initiation (no subscription required)", async () => {
    const user = resolvedUsers.granted;
    const token = await tokenForUser(user);
    const visible = await getVisibleEventKeys(token);
    expect(visible).toEqual(ALLOWED.granted);
  });

  it("admin sees all 6 events", async () => {
    const user = resolvedUsers.admin;
    const token = await tokenForUser(user);
    const visible = await getVisibleEventKeys(token);
    expect(visible).toEqual(ALLOWED.admin);
  });
});

// ─── Authenticated detail endpoint ────────────────────────────────────────────

describe("GET /api/events/:id — per-event access control", () => {
  const ALL_KEYS: readonly EventKey[] = [
    "anyone", "subscribers", "groupMembers", "participants", "onRequest", "initiation",
  ];

  for (const userKey of Object.keys(TEST_USERS) as UserKey[]) {
    describe(`user: ${userKey}`, () => {
      let token: string;

      beforeAll(async () => {
        token = await tokenForUser(resolvedUsers[userKey]);
      });

      for (const eventKey of ALL_KEYS) {
        const shouldAllow = ALLOWED[userKey].has(eventKey);

        if (shouldAllow) {
          it(`can access ${EVENT_CODES[eventKey]} (200)`, async () => {
            const eventId = resolvedEvents[eventKey].id;
            const { status } = await testJson(`/api/events/${eventId}`, {
              headers: authHeader(token),
            });
            expect(status).toBe(200);
          });
        } else {
          it(`is denied ${EVENT_CODES[eventKey]} (403)`, async () => {
            const eventId = resolvedEvents[eventKey].id;
            const { status } = await testJson(`/api/events/${eventId}`, {
              headers: authHeader(token),
            });
            expect(status).toBe(403);
          });
        }
      }
    });
  }
});

// ─── Anonymous / public endpoint ──────────────────────────────────────────────

describe("GET /api/events/public — anonymous access", () => {
  it("returns only the free-anyone event (E2E-ANYONE)", async () => {
    const { status, body } = await testJson<Array<{ eventCode: string }>>("/api/events/public");
    expect(status).toBe(200);
    const e2eCodes = body
      .map((ev) => ev.eventCode)
      .filter((code) => Object.values(EVENT_CODES).includes(code as (typeof EVENT_CODES)[EventKey]));
    expect(e2eCodes).toContain(EVENT_CODES.anyone);
    // None of the other 5 e2e events should appear
    const nonPublicCodes = (Object.keys(EVENT_CODES) as EventKey[])
      .filter((k) => k !== "anyone")
      .map((k) => EVENT_CODES[k]);
    for (const code of nonPublicCodes) {
      expect(e2eCodes).not.toContain(code);
    }
  });

  it("GET /api/events/public/:id for the anyone event returns 200", async () => {
    const eventId = resolvedEvents.anyone.id;
    const { status } = await testJson(`/api/events/public/${eventId}`);
    expect(status).toBe(200);
  });

  it("GET /api/events/public/:id for a subscribers event returns 403", async () => {
    const eventId = resolvedEvents.subscribers.id;
    const { status } = await testJson(`/api/events/public/${eventId}`);
    expect(status).toBe(403);
  });

  it("GET /api/events/public/:id for a groupMembers event returns 403", async () => {
    const eventId = resolvedEvents.groupMembers.id;
    const { status } = await testJson(`/api/events/public/${eventId}`);
    expect(status).toBe(403);
  });

  it("GET /api/events/public/:id for a participants event returns 403", async () => {
    const eventId = resolvedEvents.participants.id;
    const { status } = await testJson(`/api/events/public/${eventId}`);
    expect(status).toBe(403);
  });

  it("GET /api/events/public/:id for an onRequest event returns 403", async () => {
    const eventId = resolvedEvents.onRequest.id;
    const { status } = await testJson(`/api/events/public/${eventId}`);
    expect(status).toBe(403);
  });

  it("GET /api/events/public/:id for an initiation event returns 403", async () => {
    const eventId = resolvedEvents.initiation.id;
    const { status } = await testJson(`/api/events/public/${eventId}`);
    expect(status).toBe(403);
  });
});
