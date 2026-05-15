import { Hono } from "hono";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { createAccessToken } from "../services/auth.ts";
import { AppError } from "../lib/errors.ts";
import { db } from "../db/index.ts";
import { users } from "../db/schema/users.ts";
import { events } from "../db/schema/retreats.ts";
import { sessions } from "../db/schema/sessions.ts";
import { tracks } from "../db/schema/tracks.ts";
import { transcripts } from "../db/schema/transcripts.ts";
import { retreatGroups } from "../db/schema/retreat-groups.ts";

/**
 * Test-only routes. Mounted by routes/index.ts ONLY when NODE_ENV !== "production".
 * Never available in production.
 */
const testRoutes = new Hono();

const tokenSchema = z.object({
  userId: z.number().int().positive(),
  email: z.string().email(),
  role: z.enum(["user", "admin", "superadmin"]).default("user"),
});

testRoutes.post("/token", async (c) => {
  const parsed = tokenSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw AppError.badRequest("Invalid test-token request", "VALIDATION_ERROR");
  }
  const { userId, email, role } = parsed.data;
  const token = await createAccessToken({ sub: userId, email, role });
  return c.json({ token });
});

/**
 * GET /api/test/user-by-email?email=...
 *
 * Resolve a seeded user's DB id + role from their email so the Playwright
 * auth helper can mint a token without hard-coding seed-order ids. Test-only.
 */
testRoutes.get("/user-by-email", async (c) => {
  const email = c.req.query("email")?.trim();
  if (!email) {
    throw AppError.badRequest("Missing email query param", "VALIDATION_ERROR");
  }
  const row = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { id: true, email: true, role: true },
  });
  if (!row) {
    throw AppError.notFound(`No user with email "${email}"`);
  }
  return c.json({ id: row.id, email: row.email, role: row.role });
});

/**
 * GET /api/test/dataset
 *
 * Return the resolved DB ids for the deterministic e2e seed dataset, keyed by
 * event code. The Playwright suite uses this as its single source of truth so
 * specs never hard-code seed-order ids. Test-only.
 *
 * Shape:
 *   {
 *     groups: [{ id, slug, abbreviation, nameEn }],
 *     events: {
 *       "E2E-GROUP": {
 *         eventId, sessionIds: [..], trackIds: [..], transcriptIds: [..]
 *       },
 *       ...
 *     }
 *   }
 */
testRoutes.get("/dataset", async (c) => {
  const allEvents = await db
    .select({
      id: events.id,
      eventCode: events.eventCode,
      titleEn: events.titleEn,
    })
    .from(events);

  const e2eEvents = allEvents.filter((e) => e.eventCode?.startsWith("E2E-"));
  const eventIds = e2eEvents.map((e) => e.id);

  const allSessions = eventIds.length
    ? await db
        .select({ id: sessions.id, eventId: sessions.eventId })
        .from(sessions)
        .where(inArray(sessions.eventId, eventIds))
    : [];

  const sessionIds = allSessions.map((s) => s.id);
  const allTracks = sessionIds.length
    ? await db
        .select({ id: tracks.id, sessionId: tracks.sessionId })
        .from(tracks)
        .where(inArray(tracks.sessionId, sessionIds))
    : [];

  const allTranscripts = eventIds.length
    ? await db
        .select({ id: transcripts.id, eventId: transcripts.eventId })
        .from(transcripts)
        .where(inArray(transcripts.eventId, eventIds))
    : [];

  const groups = await db
    .select({
      id: retreatGroups.id,
      slug: retreatGroups.slug,
      abbreviation: retreatGroups.abbreviation,
      nameEn: retreatGroups.nameEn,
    })
    .from(retreatGroups);

  const eventMap: Record<
    string,
    {
      eventId: number;
      titleEn: string | null;
      sessionIds: number[];
      trackIds: number[];
      transcriptIds: number[];
    }
  > = {};

  for (const ev of e2eEvents) {
    const evSessions = allSessions.filter((s) => s.eventId === ev.id);
    const evSessionIds = evSessions.map((s) => s.id);
    const evTrackIds = allTracks
      .filter((t) => evSessionIds.includes(t.sessionId))
      .map((t) => t.id);
    const evTranscriptIds = allTranscripts
      .filter((t) => t.eventId === ev.id)
      .map((t) => t.id);
    eventMap[ev.eventCode] = {
      eventId: ev.id,
      titleEn: ev.titleEn,
      sessionIds: evSessionIds,
      trackIds: evTrackIds,
      transcriptIds: evTranscriptIds,
    };
  }

  return c.json({
    groups: groups.filter((g) => g.slug?.startsWith("e2e-")),
    events: eventMap,
  });
});

export { testRoutes };
