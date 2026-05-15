/**
 * E2E seed dataset.
 *
 * Inserts a deterministic, fully cross-linked dataset into the test database
 * and returns the resolved DB ids so test files can reference exact rows.
 *
 * Call this from a `beforeAll` in each test file (or from the global setup)
 * after `resetTestDatabase()` has run.
 *
 * Dataset overview
 * ─────────────────
 *   • 6 audiences (one per access level)
 *   • 1 retreat group  (E2E-GROUP-ALPHA)
 *   • 6 events (one per EVENT_CODE / audience)
 *       → E2E-GROUP event is linked to the test group via eventRetreatGroups
 *   • Per event: 1 session, 2 tracks, 1 transcript
 *   • 6 users covering every access scenario
 *       → groupMember has a userGroupMemberships row
 *       → participant has a userEventAttendance row for E2E-PART
 *       → granted has userEventAttendance rows for E2E-REQ and E2E-INIT
 */

import { eq } from "drizzle-orm";
import { db } from "../../../src/db/index.ts";
import { audiences } from "../../../src/db/schema/audiences.ts";
import { retreatGroups } from "../../../src/db/schema/retreat-groups.ts";
import {
  events,
  eventRetreatGroups,
} from "../../../src/db/schema/retreats.ts";
import { sessions } from "../../../src/db/schema/sessions.ts";
import { tracks } from "../../../src/db/schema/tracks.ts";
import { transcripts } from "../../../src/db/schema/transcripts.ts";
import {
  users,
  userGroupMemberships,
  userEventAttendance,
} from "../../../src/db/schema/users.ts";
import {
  AUDIENCE_SLUGS,
  EVENT_CODES,
  TEST_USERS,
  TEST_GROUP_SLUG,
} from "./fixtures.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Resolved id + key columns for a single seeded user. */
export interface SeededUser {
  id: number;
  email: string;
  role: string;
}

/** Resolved id + eventCode for a single seeded event. */
export interface SeededEvent {
  id: number;
  eventCode: string;
}

/** Resolved id + sessionId for a single seeded track. */
export interface SeededTrack {
  id: number;
  sessionId: number;
}

/** Resolved data per event's child content. */
export interface SeededEventContent {
  sessionId: number;
  trackIds: [number, number];
  transcriptId: number;
}

/** Everything tests need from a `seedTestData()` call. */
export interface SeededData {
  /** Resolved DB ids for each audience slug key. */
  audienceIds: Record<keyof typeof AUDIENCE_SLUGS, number>;
  /** The DB id of the single test retreat group. */
  groupId: number;
  /** Resolved id + eventCode for each EVENT_CODES key. */
  events: Record<keyof typeof EVENT_CODES, SeededEvent>;
  /** Session/track/transcript ids keyed by EVENT_CODES key. */
  content: Record<keyof typeof EVENT_CODES, SeededEventContent>;
  /** Resolved id + email + role for each TEST_USERS key. */
  users: Record<keyof typeof TEST_USERS, SeededUser>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** One year ahead of a fixed reference date (deterministic across runs). */
const SUBSCRIPTION_EXPIRES_AT = new Date("2027-01-01T00:00:00Z");

/** Fixed start/end dates for all test events. */
const EVENT_START = "2024-01-15";
const EVENT_END   = "2024-01-17";

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Seed the test database with a deterministic dataset and return all resolved ids.
 *
 * The function is idempotent within a single run because `resetTestDatabase()`
 * wipes the DB before any test file calls this. However it does NOT guard
 * against being called twice in the same process — call it once per suite run.
 */
export async function seedTestData(): Promise<SeededData> {
  // ── 1. Audiences ────────────────────────────────────────────────────────────
  // Migrations do NOT pre-populate audiences, but we use INSERT … ON CONFLICT
  // DO NOTHING so the seed stays safe if that ever changes.
  const audienceIds = await seedAudiences();

  // ── 2. Retreat group ────────────────────────────────────────────────────────
  const groupId = await seedGroup();

  // ── 3. Events ───────────────────────────────────────────────────────────────
  const seededEvents = await seedEvents(audienceIds);

  // ── 4. Link E2E-GROUP event to the test group ───────────────────────────────
  await db.insert(eventRetreatGroups).values({
    eventId: seededEvents.groupMembers.id,
    retreatGroupId: groupId,
  });

  // ── 5. Sessions, tracks, transcripts ────────────────────────────────────────
  const content = await seedContent(seededEvents);

  // ── 6. Users ─────────────────────────────────────────────────────────────────
  const seededUsers = await seedUsers();

  // ── 7. Group membership ──────────────────────────────────────────────────────
  await db.insert(userGroupMemberships).values({
    userId: seededUsers.groupMember.id,
    retreatGroupId: groupId,
    status: "confirmed",
  });

  // ── 8. Event attendance ──────────────────────────────────────────────────────
  // participant → E2E-PART
  await db.insert(userEventAttendance).values({
    userId: seededUsers.participant.id,
    eventId: seededEvents.participants.id,
    status: "registered",
  });

  // granted → E2E-REQ and E2E-INIT (no subscription, granted via attendance)
  await db.insert(userEventAttendance).values([
    {
      userId: seededUsers.granted.id,
      eventId: seededEvents.onRequest.id,
      status: "registered",
    },
    {
      userId: seededUsers.granted.id,
      eventId: seededEvents.initiation.id,
      status: "registered",
    },
  ]);

  return {
    audienceIds,
    groupId,
    events: seededEvents,
    content,
    users: seededUsers,
  };
}

// ─── Section helpers ──────────────────────────────────────────────────────────

/**
 * Insert all 6 audiences (or select if already present) and return
 * a map of AUDIENCE_SLUGS keys → DB id.
 */
async function seedAudiences(): Promise<Record<keyof typeof AUDIENCE_SLUGS, number>> {
  // Audience definitions: nameEn (NOT-NULL) + slug (NOT-NULL, unique)
  const audienceDefs: Array<{
    key: keyof typeof AUDIENCE_SLUGS;
    nameEn: string;
    namePt: string;
    slug: string;
    displayOrder: number;
  }> = [
    {
      key: "freeAnyone",
      nameEn: "Free – anyone",
      namePt: "Livre – qualquer pessoa",
      slug: AUDIENCE_SLUGS.freeAnyone,
      displayOrder: 1,
    },
    {
      key: "freeSubscribers",
      nameEn: "Free – subscribers",
      namePt: "Livre – subscritores",
      slug: AUDIENCE_SLUGS.freeSubscribers,
      displayOrder: 2,
    },
    {
      key: "retreatGroupMembers",
      nameEn: "Retreat group members",
      namePt: "Membros do grupo de retiro",
      slug: AUDIENCE_SLUGS.retreatGroupMembers,
      displayOrder: 3,
    },
    {
      key: "eventParticipants",
      nameEn: "Event participants",
      namePt: "Participantes do evento",
      slug: AUDIENCE_SLUGS.eventParticipants,
      displayOrder: 4,
    },
    {
      key: "availableOnRequest",
      nameEn: "Available on request only",
      namePt: "Disponível apenas a pedido",
      slug: AUDIENCE_SLUGS.availableOnRequest,
      displayOrder: 5,
    },
    {
      key: "receivedInitiation",
      nameEn: "Received initiation",
      namePt: "Recebeu iniciação",
      slug: AUDIENCE_SLUGS.receivedInitiation,
      displayOrder: 6,
    },
  ];

  const result: Partial<Record<keyof typeof AUDIENCE_SLUGS, number>> = {};

  for (const def of audienceDefs) {
    // Try to insert; if the slug already exists, fall through to SELECT.
    const inserted = await db
      .insert(audiences)
      .values({
        nameEn: def.nameEn,
        namePt: def.namePt,
        slug: def.slug,
        displayOrder: def.displayOrder,
      })
      .onConflictDoNothing()
      .returning({ id: audiences.id });

    if (inserted.length > 0 && inserted[0]) {
      result[def.key] = inserted[0].id;
    } else {
      // Row already existed — fetch its id.
      const existing = await db
        .select({ id: audiences.id })
        .from(audiences)
        .where(eq(audiences.slug, def.slug));
      if (!existing[0]) {
        throw new Error(`seedAudiences: could not resolve id for slug "${def.slug}"`);
      }
      result[def.key] = existing[0].id;
    }
  }

  return result as Record<keyof typeof AUDIENCE_SLUGS, number>;
}

/**
 * Insert the test retreat group and return its DB id.
 *
 * Required NOT-NULL columns: nameEn, slug.
 * Columns with NOT-NULL + default: heroFocalX (50), heroFocalY (50),
 * heroScale (100), displayOrder (0), createdAt, updatedAt.
 */
async function seedGroup(): Promise<number> {
  const [inserted] = await db
    .insert(retreatGroups)
    .values({
      nameEn: "E2E Test Group Alpha",
      namePt: "Grupo de Teste E2E Alpha",
      abbreviation: "E2E",
      slug: TEST_GROUP_SLUG,
      description: "Synthetic group created by the e2e seed dataset.",
      displayOrder: 99,
    })
    .returning({ id: retreatGroups.id });

  if (!inserted) {
    throw new Error("seedGroup: no row returned after insert");
  }
  return inserted.id;
}

/**
 * Insert the 6 test events and return a map of EVENT_CODES keys → SeededEvent.
 *
 * Required NOT-NULL columns: eventCode, titleEn, status.
 */
async function seedEvents(
  audienceIds: Record<keyof typeof AUDIENCE_SLUGS, number>,
): Promise<Record<keyof typeof EVENT_CODES, SeededEvent>> {
  const eventDefs: Array<{
    key: keyof typeof EVENT_CODES;
    eventCode: string;
    titleEn: string;
    audienceKey: keyof typeof AUDIENCE_SLUGS;
  }> = [
    {
      key: "anyone",
      eventCode: EVENT_CODES.anyone,
      titleEn: "E2E Event – Free Anyone",
      audienceKey: "freeAnyone",
    },
    {
      key: "subscribers",
      eventCode: EVENT_CODES.subscribers,
      titleEn: "E2E Event – Free Subscribers",
      audienceKey: "freeSubscribers",
    },
    {
      key: "groupMembers",
      eventCode: EVENT_CODES.groupMembers,
      titleEn: "E2E Event – Retreat Group Members",
      audienceKey: "retreatGroupMembers",
    },
    {
      key: "participants",
      eventCode: EVENT_CODES.participants,
      titleEn: "E2E Event – Event Participants",
      audienceKey: "eventParticipants",
    },
    {
      key: "onRequest",
      eventCode: EVENT_CODES.onRequest,
      titleEn: "E2E Event – Available on Request",
      audienceKey: "availableOnRequest",
    },
    {
      key: "initiation",
      eventCode: EVENT_CODES.initiation,
      titleEn: "E2E Event – Received Initiation",
      audienceKey: "receivedInitiation",
    },
  ];

  const result: Partial<Record<keyof typeof EVENT_CODES, SeededEvent>> = {};

  for (const def of eventDefs) {
    const [inserted] = await db
      .insert(events)
      .values({
        eventCode: def.eventCode,
        titleEn: def.titleEn,
        titlePt: `${def.titleEn} (PT)`,
        startDate: EVENT_START,
        endDate: EVENT_END,
        audienceId: audienceIds[def.audienceKey],
        status: "published",
      })
      .returning({ id: events.id });

    if (!inserted) {
      throw new Error(`seedEvents: no row returned for eventCode "${def.eventCode}"`);
    }

    result[def.key] = { id: inserted.id, eventCode: def.eventCode };
  }

  return result as Record<keyof typeof EVENT_CODES, SeededEvent>;
}

/**
 * For each event insert: 1 session, 2 tracks, 1 transcript.
 *
 * sessions NOT-NULL: eventId (retreat_id), sessionNumber.
 * tracks NOT-NULL:   sessionId, title, trackNumber, languages (default ["en"]),
 *                    originalLanguage (default "en"), isTranslation (default false),
 *                    isPractice (default false), durationSeconds (default 0).
 * transcripts NOT-NULL: eventId (retreat_id), language, status (default "draft").
 */
async function seedContent(
  seededEvents: Record<keyof typeof EVENT_CODES, SeededEvent>,
): Promise<Record<keyof typeof EVENT_CODES, SeededEventContent>> {
  const result: Partial<Record<keyof typeof EVENT_CODES, SeededEventContent>> = {};

  const keys = Object.keys(seededEvents) as Array<keyof typeof EVENT_CODES>;

  for (const key of keys) {
    const event = seededEvents[key];
    const code = event.eventCode;

    // ── Session ──────────────────────────────────────────────────────────────
    const [session] = await db
      .insert(sessions)
      .values({
        eventId: event.id,
        titleEn: `${code} – Session 1`,
        titlePt: `${code} – Sessão 1`,
        sessionDate: EVENT_START,
        timePeriod: "morning",
        sessionNumber: 1,
      })
      .returning({ id: sessions.id });

    if (!session) {
      throw new Error(`seedContent: session insert failed for event "${code}"`);
    }

    // ── Track 1 ──────────────────────────────────────────────────────────────
    const [track1] = await db
      .insert(tracks)
      .values({
        sessionId: session.id,
        title: `${code} – Track 1`,
        trackNumber: 1,
        languages: ["en"],
        originalLanguage: "en",
        isTranslation: false,
        isPractice: false,
        s3Key: `events/${code}/track-1.mp3`,
        durationSeconds: 600,
        originalFilename: "track-1.mp3",
      })
      .returning({ id: tracks.id });

    if (!track1) {
      throw new Error(`seedContent: track 1 insert failed for event "${code}"`);
    }

    // ── Track 2 ──────────────────────────────────────────────────────────────
    const [track2] = await db
      .insert(tracks)
      .values({
        sessionId: session.id,
        title: `${code} – Track 2`,
        trackNumber: 2,
        languages: ["en"],
        originalLanguage: "en",
        isTranslation: false,
        isPractice: false,
        s3Key: `events/${code}/track-2.mp3`,
        durationSeconds: 480,
        originalFilename: "track-2.mp3",
      })
      .returning({ id: tracks.id });

    if (!track2) {
      throw new Error(`seedContent: track 2 insert failed for event "${code}"`);
    }

    // ── Transcript ────────────────────────────────────────────────────────────
    const [transcript] = await db
      .insert(transcripts)
      .values({
        eventId: event.id,
        language: "en",
        s3Key: `events/${code}/transcripts/transcript.pdf`,
        status: "published",
        originalFilename: "transcript.pdf",
      })
      .returning({ id: transcripts.id });

    if (!transcript) {
      throw new Error(`seedContent: transcript insert failed for event "${code}"`);
    }

    result[key] = {
      sessionId: session.id,
      trackIds: [track1.id, track2.id],
      transcriptId: transcript.id,
    };
  }

  return result as Record<keyof typeof EVENT_CODES, SeededEventContent>;
}

/**
 * Insert the 6 test users and return a map of TEST_USERS keys → SeededUser.
 *
 * users NOT-NULL: email, preferredLanguage (default "en"), role (default "user"),
 *                isActive (default true), isVerified (default false),
 *                subscriptionStatus (default "none"), createdAt, updatedAt.
 *
 * passwordHash is nullable — test users authenticate via the `/api/test/token`
 * helper endpoint, not via password, so we omit it.
 *
 * Subscription assignment:
 *   nosub       → subscriptionStatus: "none"
 *   subscriber  → subscriptionStatus: "active", expires 2027-01-01
 *   groupMember → subscriptionStatus: "active", expires 2027-01-01
 *   participant → subscriptionStatus: "active", expires 2027-01-01
 *   granted     → subscriptionStatus: "none" (access via attendance only)
 *   admin       → subscriptionStatus: "none" (admin role bypasses restrictions)
 */
async function seedUsers(): Promise<Record<keyof typeof TEST_USERS, SeededUser>> {
  type UserKey = keyof typeof TEST_USERS;

  const userDefs: Array<{
    key: UserKey;
    email: string;
    role: string;
    subscriptionStatus: string;
    subscriptionExpiresAt?: Date;
  }> = [
    {
      key: "nosub",
      email: TEST_USERS.nosub.email,
      role: TEST_USERS.nosub.role,
      subscriptionStatus: "none",
    },
    {
      key: "subscriber",
      email: TEST_USERS.subscriber.email,
      role: TEST_USERS.subscriber.role,
      subscriptionStatus: "active",
      subscriptionExpiresAt: SUBSCRIPTION_EXPIRES_AT,
    },
    {
      key: "groupMember",
      email: TEST_USERS.groupMember.email,
      role: TEST_USERS.groupMember.role,
      subscriptionStatus: "active",
      subscriptionExpiresAt: SUBSCRIPTION_EXPIRES_AT,
    },
    {
      key: "participant",
      email: TEST_USERS.participant.email,
      role: TEST_USERS.participant.role,
      subscriptionStatus: "active",
      subscriptionExpiresAt: SUBSCRIPTION_EXPIRES_AT,
    },
    {
      key: "granted",
      email: TEST_USERS.granted.email,
      role: TEST_USERS.granted.role,
      subscriptionStatus: "none",
    },
    {
      key: "admin",
      email: TEST_USERS.admin.email,
      role: TEST_USERS.admin.role,
      subscriptionStatus: "none",
    },
  ];

  const result: Partial<Record<UserKey, SeededUser>> = {};

  for (const def of userDefs) {
    const [inserted] = await db
      .insert(users)
      .values({
        email: def.email,
        role: def.role,
        isActive: true,
        isVerified: true,
        subscriptionStatus: def.subscriptionStatus,
        ...(def.subscriptionExpiresAt !== undefined
          ? { subscriptionExpiresAt: def.subscriptionExpiresAt }
          : {}),
      })
      .returning({ id: users.id, email: users.email, role: users.role });

    if (!inserted) {
      throw new Error(`seedUsers: no row returned for email "${def.email}"`);
    }

    result[def.key] = {
      id: inserted.id,
      email: inserted.email,
      role: inserted.role,
    };
  }

  return result as Record<UserKey, SeededUser>;
}
