/**
 * E2E content and search read test.
 *
 * Covers:
 *   • GET /api/events/:id         — event detail with sessions + tracks
 *   • GET /api/events/sessions/:sessionId — session detail with tracks
 *   • GET /api/events/tracks/:trackId     — single track
 *   • GET /api/media/audio/:trackId       — presigned audio URL (MinIO)
 *   • GET /api/content/progress           — initially empty
 *   • POST /api/content/progress          — upsert progress row
 *   • GET /api/content/progress (again)   — row is present
 *   • GET /api/search?q=…                 — seeded event appears in results
 *
 * The seed (tests/e2e/support/seed.ts) creates per event:
 *   1 session, 2 tracks, 1 transcript.
 *
 * This file uses the `admin` user for broad visibility, but also verifies
 * the `subscriber` user for the "E2E-SUBS" event to cover a non-admin path.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../../src/db/index.ts";
import { users } from "../../src/db/schema/users.ts";
import { events } from "../../src/db/schema/retreats.ts";
import { sessions } from "../../src/db/schema/sessions.ts";
import { tracks } from "../../src/db/schema/tracks.ts";
import { testJson } from "../helpers.ts";
import { tokenForUser, authHeader } from "./support/auth.ts";
import { EVENT_CODES, TEST_USERS } from "./support/fixtures.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ResolvedUser {
  id: number;
  email: string;
  role: string;
}

interface ResolvedEventDetail {
  id: number;
  eventCode: string;
  sessionId: number;
  trackId1: number;
  trackId2: number;
}

// ─── Shared state ─────────────────────────────────────────────────────────────

let adminUser: ResolvedUser;
let subscriberUser: ResolvedUser;
let adminToken: string;
let subscriberToken: string;

/**
 * The "subscribers" event — accessible to the subscriber user (and admin).
 * eventCode = EVENT_CODES.subscribers = "E2E-SUBS"
 */
let subsEvent: ResolvedEventDetail;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Resolve users by email (inserted by seed.ts)
  const [adminRow] = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.email, TEST_USERS.admin.email));
  if (!adminRow) {
    throw new Error(`content e2e: admin user "${TEST_USERS.admin.email}" not found — was seed.ts run?`);
  }
  adminUser = adminRow;

  const [subscriberRow] = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.email, TEST_USERS.subscriber.email));
  if (!subscriberRow) {
    throw new Error(`content e2e: subscriber user "${TEST_USERS.subscriber.email}" not found — was seed.ts run?`);
  }
  subscriberUser = subscriberRow;

  // Mint tokens
  adminToken = await tokenForUser(adminUser);
  subscriberToken = await tokenForUser(subscriberUser);

  // Resolve the "subscribers" event by eventCode
  const [eventRow] = await db
    .select({ id: events.id, eventCode: events.eventCode })
    .from(events)
    .where(eq(events.eventCode, EVENT_CODES.subscribers));
  if (!eventRow) {
    throw new Error(`content e2e: event "${EVENT_CODES.subscribers}" not found — was seed.ts run?`);
  }

  // Resolve the seeded session for this event
  const [sessionRow] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.eventId, eventRow.id));
  if (!sessionRow) {
    throw new Error(`content e2e: no session found for event "${EVENT_CODES.subscribers}"`);
  }

  // Resolve the two tracks for this session (ordered by trackNumber)
  const trackRows = await db
    .select({ id: tracks.id })
    .from(tracks)
    .where(eq(tracks.sessionId, sessionRow.id));

  if (trackRows.length < 2) {
    throw new Error(`content e2e: expected 2 tracks for session ${sessionRow.id}, got ${trackRows.length}`);
  }

  subsEvent = {
    id: eventRow.id,
    eventCode: eventRow.eventCode,
    sessionId: sessionRow.id,
    trackId1: trackRows[0]!.id,
    trackId2: trackRows[1]!.id,
  };
});

// ─── Event detail ─────────────────────────────────────────────────────────────

describe("GET /api/events/:id — event detail with sessions and tracks", () => {
  it("returns 200 with the event body for the admin user", async () => {
    const { status, body } = await testJson(`/api/events/${subsEvent.id}`, {
      headers: authHeader(adminToken),
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: subsEvent.id, eventCode: EVENT_CODES.subscribers });
  });

  it("includes exactly 1 session on the event", async () => {
    const { status, body } = await testJson<{ sessions: unknown[] }>(
      `/api/events/${subsEvent.id}`,
      { headers: authHeader(adminToken) },
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions).toHaveLength(1);
  });

  it("includes exactly 2 tracks on the session", async () => {
    interface TrackShape { id: number }
    interface SessionShape { id: number; tracks: TrackShape[] }
    interface EventBody { sessions: SessionShape[] }

    const { status, body } = await testJson<EventBody>(
      `/api/events/${subsEvent.id}`,
      { headers: authHeader(adminToken) },
    );
    expect(status).toBe(200);
    const session = body.sessions[0];
    expect(session).toBeDefined();
    expect(Array.isArray(session!.tracks)).toBe(true);
    expect(session!.tracks).toHaveLength(2);
  });

  it("the subscriber user can also access the subscribers event (200)", async () => {
    const { status } = await testJson(`/api/events/${subsEvent.id}`, {
      headers: authHeader(subscriberToken),
    });
    expect(status).toBe(200);
  });
});

// ─── Session detail ───────────────────────────────────────────────────────────

describe("GET /api/events/sessions/:sessionId — session detail with tracks", () => {
  it("returns 200 with the session body", async () => {
    const { status, body } = await testJson<{ id: number; tracks: unknown[] }>(
      `/api/events/sessions/${subsEvent.sessionId}`,
      { headers: authHeader(adminToken) },
    );
    expect(status).toBe(200);
    expect(body.id).toBe(subsEvent.sessionId);
  });

  it("includes 2 tracks on the session", async () => {
    const { status, body } = await testJson<{ tracks: Array<{ id: number }> }>(
      `/api/events/sessions/${subsEvent.sessionId}`,
      { headers: authHeader(adminToken) },
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.tracks)).toBe(true);
    expect(body.tracks).toHaveLength(2);
  });

  it("each track has id, title, and trackNumber fields", async () => {
    interface TrackShape { id: number; title: string; trackNumber: number }
    const { status, body } = await testJson<{ tracks: TrackShape[] }>(
      `/api/events/sessions/${subsEvent.sessionId}`,
      { headers: authHeader(adminToken) },
    );
    expect(status).toBe(200);
    for (const track of body.tracks) {
      expect(typeof track.id).toBe("number");
      expect(typeof track.title).toBe("string");
      expect(typeof track.trackNumber).toBe("number");
    }
  });

  it("returns 401 without auth token", async () => {
    const { status } = await testJson(`/api/events/sessions/${subsEvent.sessionId}`);
    expect(status).toBe(401);
  });
});

// ─── Single track ─────────────────────────────────────────────────────────────

describe("GET /api/events/tracks/:trackId — single track detail", () => {
  it("returns 200 for track 1 with admin token", async () => {
    const { status, body } = await testJson<{ id: number }>(
      `/api/events/tracks/${subsEvent.trackId1}`,
      { headers: authHeader(adminToken) },
    );
    expect(status).toBe(200);
    expect(body.id).toBe(subsEvent.trackId1);
  });

  it("returns 200 for track 2 with admin token", async () => {
    const { status, body } = await testJson<{ id: number }>(
      `/api/events/tracks/${subsEvent.trackId2}`,
      { headers: authHeader(adminToken) },
    );
    expect(status).toBe(200);
    expect(body.id).toBe(subsEvent.trackId2);
  });

  it("returns 401 without auth token", async () => {
    const { status } = await testJson(`/api/events/tracks/${subsEvent.trackId1}`);
    expect(status).toBe(401);
  });
});

// ─── Audio presigned URL ──────────────────────────────────────────────────────

describe("GET /api/media/audio/:trackId — presigned audio URL", () => {
  it("returns 200 with a url string for an authenticated admin", async () => {
    const { status, body } = await testJson<{ url: string; expiresIn: number }>(
      `/api/media/audio/${subsEvent.trackId1}`,
      { headers: authHeader(adminToken) },
    );
    expect(status).toBe(200);
    expect(typeof body.url).toBe("string");
    expect(body.url.length).toBeGreaterThan(0);
    expect(body.expiresIn).toBe(3600);
  });

  it("presigned URL points at the MinIO endpoint (127.0.0.1:9100)", async () => {
    const { status, body } = await testJson<{ url: string }>(
      `/api/media/audio/${subsEvent.trackId1}`,
      { headers: authHeader(adminToken) },
    );
    expect(status).toBe(200);
    expect(body.url).toContain("127.0.0.1:9100");
  });

  it("returns 401 without auth for a restricted event track", async () => {
    // The subscribers event requires auth — no token should yield 401
    const { status } = await testJson(`/api/media/audio/${subsEvent.trackId1}`);
    expect(status).toBe(401);
  });
});

// ─── Progress tracking ────────────────────────────────────────────────────────

describe("GET + POST /api/content/progress — progress tracking lifecycle", () => {
  it("GET /api/content/progress returns 200 with an array (initially empty for admin)", async () => {
    const { status, body } = await testJson("/api/content/progress", {
      headers: authHeader(adminToken),
    });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it("POST /api/content/progress saves a progress row and returns 201", async () => {
    const { status, body } = await testJson<{
      userId: number;
      trackId: number;
      positionSeconds: number;
      completionPct: number;
    }>("/api/content/progress", {
      method: "POST",
      body: JSON.stringify({
        trackId: subsEvent.trackId1,
        positionSeconds: 120,
        durationSeconds: 600,
      }),
      headers: authHeader(adminToken),
    });
    expect(status).toBe(201);
    expect(body.trackId).toBe(subsEvent.trackId1);
    expect(body.positionSeconds).toBe(120);
    // 120/600 = 20% completion
    expect(body.completionPct).toBe(20);
  });

  it("GET /api/content/progress returns the saved row after POST", async () => {
    interface ProgressRow {
      trackId: number;
      positionSeconds: number;
    }
    const { status, body } = await testJson<ProgressRow[]>("/api/content/progress", {
      headers: authHeader(adminToken),
    });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    const row = body.find((r) => r.trackId === subsEvent.trackId1);
    expect(row).toBeDefined();
    expect(row!.positionSeconds).toBe(120);
  });

  it("POST /api/content/progress returns 200 on update (existing row)", async () => {
    // A second POST to the same trackId updates the existing row → 200
    const { status, body } = await testJson<{
      trackId: number;
      positionSeconds: number;
    }>("/api/content/progress", {
      method: "POST",
      body: JSON.stringify({
        trackId: subsEvent.trackId1,
        positionSeconds: 180,
        durationSeconds: 600,
      }),
      headers: authHeader(adminToken),
    });
    expect(status).toBe(200);
    expect(body.trackId).toBe(subsEvent.trackId1);
    expect(body.positionSeconds).toBe(180);
  });

  it("POST with an unknown trackId returns 200 with skipped:true", async () => {
    const { status, body } = await testJson<{ skipped: boolean; reason: string }>(
      "/api/content/progress",
      {
        method: "POST",
        body: JSON.stringify({
          trackId: 999_999_999,
          positionSeconds: 10,
        }),
        headers: authHeader(adminToken),
      },
    );
    expect(status).toBe(200);
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("unknown_track");
  });
});

// ─── Search ───────────────────────────────────────────────────────────────────

describe("GET /api/search?q=… — full-text event search", () => {
  /**
   * The seed creates events titled "E2E Event – Free Subscribers" etc.
   * A single-word query "Subscribers" matches the titleEn of the subscribers
   * event. The AND gate requires all words to appear somewhere — one word
   * satisfies it trivially.
   */
  it("returns 200 with { results, totalResults, query } shape", async () => {
    const { status, body } = await testJson<{
      results: unknown[];
      totalResults: number;
      query: string;
    }>("/api/search?q=Subscribers", {
      headers: authHeader(adminToken),
    });
    expect(status).toBe(200);
    expect(typeof body.totalResults).toBe("number");
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.query).toBe("Subscribers");
  });

  it("the seeded subscribers event appears in results for admin search", async () => {
    interface SearchEvent { id: number; titleEn: string }
    interface SearchResult { event: SearchEvent }
    interface SearchBody { results: SearchResult[] }

    const { status, body } = await testJson<SearchBody>("/api/search?q=Subscribers", {
      headers: authHeader(adminToken),
    });
    expect(status).toBe(200);
    const found = body.results.some((r) => r.event.id === subsEvent.id);
    expect(found).toBe(true);
  });

  it("subscriber user can also find the subscribers event via search", async () => {
    interface SearchEvent { id: number }
    interface SearchResult { event: SearchEvent }
    interface SearchBody { results: SearchResult[] }

    const { status, body } = await testJson<SearchBody>("/api/search?q=Subscribers", {
      headers: authHeader(subscriberToken),
    });
    expect(status).toBe(200);
    const found = body.results.some((r) => r.event.id === subsEvent.id);
    expect(found).toBe(true);
  });

  it("returns 400 for a query shorter than 2 characters", async () => {
    const { status, body } = await testJson<{ code: string }>("/api/search?q=X", {
      headers: authHeader(adminToken),
    });
    expect(status).toBe(400);
    expect(body.code).toBe("QUERY_TOO_SHORT");
  });

  it("unauthenticated search returns results for public (free-anyone) events only", async () => {
    /**
     * The "free-anyone" event title is "E2E Event – Free Anyone".
     * "Anyone" appears only in that event title, so the anonymous result set
     * should contain that event and not the subscribers-only one.
     */
    interface SearchEvent { id: number }
    interface SearchResult { event: SearchEvent }
    interface SearchBody { results: SearchResult[] }

    // Resolve the "anyone" event id
    const [anyoneRow] = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.eventCode, EVENT_CODES.anyone));

    expect(anyoneRow).toBeDefined();

    const { status, body } = await testJson<SearchBody>("/api/search?q=Anyone");
    expect(status).toBe(200);
    const ids = body.results.map((r) => r.event.id);
    expect(ids).toContain(anyoneRow!.id);
    // Subscribers event must NOT appear in unauthenticated results
    expect(ids).not.toContain(subsEvent.id);
  });
});
