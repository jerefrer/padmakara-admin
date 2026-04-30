#!/usr/bin/env bun
/**
 * Restructure "Teaching - Jewel Circle" events 632, 663, 664.
 *
 * Each of these events currently has a single all-tracks-in-one session
 * that obscures the day/teacher structure. We split them into 2 sessions
 * per retreat day:
 *
 *   - Morning  → "Day N — Teaching" (KPSR + any translations)
 *   - Afternoon → "Day N — Review"  (John Canti, or Wulstan Fletcher for 632 day 1)
 *
 * Tracks are also renamed to a consistent convention (no dates, since the
 * date is shown by the session row):
 *   - KPS English   → "KPSR — Gyu Lama" (or "KPSR — Gyu Lama — Part N")
 *   - KPS Translations (FR for 632, PT for 664) → same title, with
 *       original_language and is_translation set, original_track_id
 *       pointing at the matching KPS English track.
 *   - JC            → "John Canti — Gyu Lama"
 *   - WF (632 D1)   → "Wulstan Fletcher — Gyu Lama"
 *
 * Idempotent-ish: the script identifies the old "single session" by being
 * the only session with its event_id whose tracks count > 5, and refuses
 * to run if the event has already been split. Use --apply to commit.
 */

import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { events } from "../db/schema/retreats.ts";
import { sessions } from "../db/schema/sessions.ts";
import { tracks } from "../db/schema/tracks.ts";

interface TrackPlan {
  trackId: number;
  trackNumber: number;
  title: string;
  speaker: string | null;
  originalLanguage: string;
  isTranslation: boolean;
  originalTrackRef?: number; // links a translation to its source track id (final after the move)
}

interface SessionPlan {
  sessionDate: string;       // YYYY-MM-DD
  sessionNumber: number;
  timePeriod: "morning" | "afternoon";
  titleEn: string;
  titlePt: string;
  tracks: TrackPlan[];
}

interface EventPlan {
  eventId: number;
  description: string;
  sessions: SessionPlan[];
}

// ─── Plans ───────────────────────────────────────────────────────────────

const PLAN_632: EventPlan = {
  eventId: 632,
  description: "Aug-Sep 2023 Covão (KPSR + JC + WF + FR translations on D6/D7)",
  sessions: [
    // Day 1 — 2023-08-31 — KPSR morning, WF afternoon (no JC that day)
    {
      sessionDate: "2023-08-31", sessionNumber: 1, timePeriod: "morning",
      titleEn: "Day 1 — Teaching", titlePt: "Dia 1 — Ensinamento",
      tracks: [
        { trackId: 51624, trackNumber: 1, title: "KPSR — Gyu Lama", speaker: "KPS", originalLanguage: "en", isTranslation: false },
      ],
    },
    {
      sessionDate: "2023-08-31", sessionNumber: 2, timePeriod: "afternoon",
      titleEn: "Day 1 — Review", titlePt: "Dia 1 — Revisão",
      tracks: [
        { trackId: 51634, trackNumber: 1, title: "Wulstan Fletcher — Gyu Lama", speaker: "WF", originalLanguage: "en", isTranslation: false },
      ],
    },
    // Day 2 — 2023-09-01
    {
      sessionDate: "2023-09-01", sessionNumber: 3, timePeriod: "morning",
      titleEn: "Day 2 — Teaching", titlePt: "Dia 2 — Ensinamento",
      tracks: [
        { trackId: 51626, trackNumber: 1, title: "KPSR — Gyu Lama", speaker: "KPS", originalLanguage: "en", isTranslation: false },
      ],
    },
    {
      sessionDate: "2023-09-01", sessionNumber: 4, timePeriod: "afternoon",
      titleEn: "Day 2 — Review", titlePt: "Dia 2 — Revisão",
      tracks: [
        { trackId: 51637, trackNumber: 1, title: "John Canti — Gyu Lama", speaker: "JC", originalLanguage: "en", isTranslation: false },
      ],
    },
    // Day 3 — 2023-09-02
    {
      sessionDate: "2023-09-02", sessionNumber: 5, timePeriod: "morning",
      titleEn: "Day 3 — Teaching", titlePt: "Dia 3 — Ensinamento",
      tracks: [
        { trackId: 51630, trackNumber: 1, title: "KPSR — Gyu Lama", speaker: "KPS", originalLanguage: "en", isTranslation: false },
      ],
    },
    {
      sessionDate: "2023-09-02", sessionNumber: 6, timePeriod: "afternoon",
      titleEn: "Day 3 — Review", titlePt: "Dia 3 — Revisão",
      tracks: [
        { trackId: 51638, trackNumber: 1, title: "John Canti — Gyu Lama", speaker: "JC", originalLanguage: "en", isTranslation: false },
      ],
    },
    // Day 4 — 2023-09-03
    {
      sessionDate: "2023-09-03", sessionNumber: 7, timePeriod: "morning",
      titleEn: "Day 4 — Teaching", titlePt: "Dia 4 — Ensinamento",
      tracks: [
        { trackId: 51628, trackNumber: 1, title: "KPSR — Gyu Lama", speaker: "KPS", originalLanguage: "en", isTranslation: false },
      ],
    },
    {
      sessionDate: "2023-09-03", sessionNumber: 8, timePeriod: "afternoon",
      titleEn: "Day 4 — Review", titlePt: "Dia 4 — Revisão",
      tracks: [
        { trackId: 51635, trackNumber: 1, title: "John Canti — Gyu Lama", speaker: "JC", originalLanguage: "en", isTranslation: false },
      ],
    },
    // Day 5 — 2023-09-04
    {
      sessionDate: "2023-09-04", sessionNumber: 9, timePeriod: "morning",
      titleEn: "Day 5 — Teaching", titlePt: "Dia 5 — Ensinamento",
      tracks: [
        { trackId: 51625, trackNumber: 1, title: "KPSR — Gyu Lama", speaker: "KPS", originalLanguage: "en", isTranslation: false },
      ],
    },
    {
      sessionDate: "2023-09-04", sessionNumber: 10, timePeriod: "afternoon",
      titleEn: "Day 5 — Review", titlePt: "Dia 5 — Revisão",
      tracks: [
        { trackId: 51633, trackNumber: 1, title: "John Canti — Gyu Lama", speaker: "JC", originalLanguage: "en", isTranslation: false },
      ],
    },
    // Day 6 — 2023-09-05 — KPSR morning has FR translation
    {
      sessionDate: "2023-09-05", sessionNumber: 11, timePeriod: "morning",
      titleEn: "Day 6 — Teaching", titlePt: "Dia 6 — Ensinamento",
      tracks: [
        { trackId: 51629, trackNumber: 1, title: "KPSR — Gyu Lama", speaker: "KPS", originalLanguage: "en", isTranslation: false },
        { trackId: 51632, trackNumber: 2, title: "KPSR — Gyu Lama", speaker: "KPS", originalLanguage: "fr", isTranslation: true, originalTrackRef: 51629 },
      ],
    },
    {
      sessionDate: "2023-09-05", sessionNumber: 12, timePeriod: "afternoon",
      titleEn: "Day 6 — Review", titlePt: "Dia 6 — Revisão",
      tracks: [
        { trackId: 51639, trackNumber: 1, title: "John Canti — Gyu Lama", speaker: "JC", originalLanguage: "en", isTranslation: false },
      ],
    },
    // Day 7 — 2023-09-06 — KPSR morning has FR translation
    {
      sessionDate: "2023-09-06", sessionNumber: 13, timePeriod: "morning",
      titleEn: "Day 7 — Teaching", titlePt: "Dia 7 — Ensinamento",
      tracks: [
        { trackId: 51627, trackNumber: 1, title: "KPSR — Gyu Lama", speaker: "KPS", originalLanguage: "en", isTranslation: false },
        { trackId: 51631, trackNumber: 2, title: "KPSR — Gyu Lama", speaker: "KPS", originalLanguage: "fr", isTranslation: true, originalTrackRef: 51627 },
      ],
    },
    {
      sessionDate: "2023-09-06", sessionNumber: 14, timePeriod: "afternoon",
      titleEn: "Day 7 — Review", titlePt: "Dia 7 — Revisão",
      tracks: [
        { trackId: 51636, trackNumber: 1, title: "John Canti — Gyu Lama", speaker: "JC", originalLanguage: "en", isTranslation: false },
      ],
    },
  ],
};

const PLAN_663: EventPlan = {
  eventId: 663,
  description: "Aug 2025 Covão (KPS multi-part + John Canti)",
  sessions: [
    // Day 1 — 2025-08-19
    {
      sessionDate: "2025-08-19", sessionNumber: 1, timePeriod: "morning",
      titleEn: "Day 1 — Teaching", titlePt: "Dia 1 — Ensinamento",
      tracks: [
        { trackId: 54217, trackNumber: 1, title: "KPSR — Gyu Lama", speaker: "KPS", originalLanguage: "en", isTranslation: false },
      ],
    },
    {
      sessionDate: "2025-08-19", sessionNumber: 2, timePeriod: "afternoon",
      titleEn: "Day 1 — Review", titlePt: "Dia 1 — Revisão",
      tracks: [
        { trackId: 54230, trackNumber: 1, title: "John Canti — Gyu Lama", speaker: "JC", originalLanguage: "en", isTranslation: false },
      ],
    },
    // Day 2 — 2025-08-20 — KPS Part 1 (0931) + Part 2 (1146)
    {
      sessionDate: "2025-08-20", sessionNumber: 3, timePeriod: "morning",
      titleEn: "Day 2 — Teaching", titlePt: "Dia 2 — Ensinamento",
      tracks: [
        { trackId: 54222, trackNumber: 1, title: "KPSR — Gyu Lama — Part 1", speaker: "KPS", originalLanguage: "en", isTranslation: false },
        { trackId: 54225, trackNumber: 2, title: "KPSR — Gyu Lama — Part 2", speaker: "KPS", originalLanguage: "en", isTranslation: false },
      ],
    },
    {
      sessionDate: "2025-08-20", sessionNumber: 4, timePeriod: "afternoon",
      titleEn: "Day 2 — Review", titlePt: "Dia 2 — Revisão",
      tracks: [
        { trackId: 54226, trackNumber: 1, title: "John Canti — Gyu Lama", speaker: "JC", originalLanguage: "en", isTranslation: false },
      ],
    },
    // Day 3 — 2025-08-21 — KPS Part 1 (0930) + Part 2 (1145)
    {
      sessionDate: "2025-08-21", sessionNumber: 5, timePeriod: "morning",
      titleEn: "Day 3 — Teaching", titlePt: "Dia 3 — Ensinamento",
      tracks: [
        { trackId: 54223, trackNumber: 1, title: "KPSR — Gyu Lama — Part 1", speaker: "KPS", originalLanguage: "en", isTranslation: false },
        { trackId: 54224, trackNumber: 2, title: "KPSR — Gyu Lama — Part 2", speaker: "KPS", originalLanguage: "en", isTranslation: false },
      ],
    },
    {
      sessionDate: "2025-08-21", sessionNumber: 6, timePeriod: "afternoon",
      titleEn: "Day 3 — Review", titlePt: "Dia 3 — Revisão",
      tracks: [
        { trackId: 54227, trackNumber: 1, title: "John Canti — Gyu Lama", speaker: "JC", originalLanguage: "en", isTranslation: false },
      ],
    },
    // Day 4 — 2025-08-22 — KPS Part 1 (0927) + Part 2 (1142)
    {
      sessionDate: "2025-08-22", sessionNumber: 7, timePeriod: "morning",
      titleEn: "Day 4 — Teaching", titlePt: "Dia 4 — Ensinamento",
      tracks: [
        { trackId: 54219, trackNumber: 1, title: "KPSR — Gyu Lama — Part 1", speaker: "KPS", originalLanguage: "en", isTranslation: false },
        { trackId: 54218, trackNumber: 2, title: "KPSR — Gyu Lama — Part 2", speaker: "KPS", originalLanguage: "en", isTranslation: false },
      ],
    },
    {
      sessionDate: "2025-08-22", sessionNumber: 8, timePeriod: "afternoon",
      titleEn: "Day 4 — Review", titlePt: "Dia 4 — Revisão",
      tracks: [
        { trackId: 54231, trackNumber: 1, title: "John Canti — Gyu Lama", speaker: "JC", originalLanguage: "en", isTranslation: false },
      ],
    },
    // Day 5 — 2025-08-23 — KPS Part 1 (0928) + Part 2 (1144)
    {
      sessionDate: "2025-08-23", sessionNumber: 9, timePeriod: "morning",
      titleEn: "Day 5 — Teaching", titlePt: "Dia 5 — Ensinamento",
      tracks: [
        { trackId: 54221, trackNumber: 1, title: "KPSR — Gyu Lama — Part 1", speaker: "KPS", originalLanguage: "en", isTranslation: false },
        { trackId: 54220, trackNumber: 2, title: "KPSR — Gyu Lama — Part 2", speaker: "KPS", originalLanguage: "en", isTranslation: false },
      ],
    },
    {
      sessionDate: "2025-08-23", sessionNumber: 10, timePeriod: "afternoon",
      titleEn: "Day 5 — Review", titlePt: "Dia 5 — Revisão",
      tracks: [
        { trackId: 54229, trackNumber: 1, title: "John Canti — Gyu Lama", speaker: "JC", originalLanguage: "en", isTranslation: false },
      ],
    },
    // Day 6 — 2025-08-24 — KPS Part 1 + Part 2 (explicit in filenames)
    {
      sessionDate: "2025-08-24", sessionNumber: 11, timePeriod: "morning",
      titleEn: "Day 6 — Teaching", titlePt: "Dia 6 — Ensinamento",
      tracks: [
        { trackId: 54216, trackNumber: 1, title: "KPSR — Gyu Lama — Part 1", speaker: "KPS", originalLanguage: "en", isTranslation: false },
        { trackId: 54215, trackNumber: 2, title: "KPSR — Gyu Lama — Part 2", speaker: "KPS", originalLanguage: "en", isTranslation: false },
      ],
    },
    {
      sessionDate: "2025-08-24", sessionNumber: 12, timePeriod: "afternoon",
      titleEn: "Day 6 — Review", titlePt: "Dia 6 — Revisão",
      tracks: [
        { trackId: 54228, trackNumber: 1, title: "John Canti — Gyu Lama", speaker: "JC", originalLanguage: "en", isTranslation: false },
      ],
    },
  ],
};

const PLAN_664: EventPlan = {
  eventId: 664,
  description: "Aug 2025 Lisboa (KPS + PT translations + John Canti review)",
  sessions: [
    // Day 1 — 2025-08-19
    {
      sessionDate: "2025-08-19", sessionNumber: 1, timePeriod: "morning",
      titleEn: "Day 1 — Teaching", titlePt: "Dia 1 — Ensinamento",
      tracks: [
        { trackId: 54238, trackNumber: 1, title: "KPSR — Gyu Lama", speaker: "KPS", originalLanguage: "en", isTranslation: false },
        { trackId: 54248, trackNumber: 2, title: "KPSR — Gyu Lama", speaker: "KPS", originalLanguage: "pt", isTranslation: true, originalTrackRef: 54238 },
      ],
    },
    {
      sessionDate: "2025-08-19", sessionNumber: 2, timePeriod: "afternoon",
      titleEn: "Day 1 — Review", titlePt: "Dia 1 — Revisão",
      tracks: [
        { trackId: 54232, trackNumber: 1, title: "John Canti — Gyu Lama", speaker: "JC", originalLanguage: "en", isTranslation: false },
      ],
    },
    // Day 2 — 2025-08-20
    {
      sessionDate: "2025-08-20", sessionNumber: 3, timePeriod: "morning",
      titleEn: "Day 2 — Teaching", titlePt: "Dia 2 — Ensinamento",
      tracks: [
        { trackId: 54239, trackNumber: 1, title: "KPSR — Gyu Lama", speaker: "KPS", originalLanguage: "en", isTranslation: false },
        { trackId: 54249, trackNumber: 2, title: "KPSR — Gyu Lama", speaker: "KPS", originalLanguage: "pt", isTranslation: true, originalTrackRef: 54239 },
      ],
    },
    {
      sessionDate: "2025-08-20", sessionNumber: 4, timePeriod: "afternoon",
      titleEn: "Day 2 — Review", titlePt: "Dia 2 — Revisão",
      tracks: [
        { trackId: 54233, trackNumber: 1, title: "John Canti — Gyu Lama", speaker: "JC", originalLanguage: "en", isTranslation: false },
      ],
    },
    // Day 3 — 2025-08-21 — KPS Part 1 + Part 2, with PT translations
    {
      sessionDate: "2025-08-21", sessionNumber: 5, timePeriod: "morning",
      titleEn: "Day 3 — Teaching", titlePt: "Dia 3 — Ensinamento",
      tracks: [
        { trackId: 54240, trackNumber: 1, title: "KPSR — Gyu Lama — Part 1", speaker: "KPS", originalLanguage: "en", isTranslation: false },
        { trackId: 54241, trackNumber: 2, title: "KPSR — Gyu Lama — Part 2", speaker: "KPS", originalLanguage: "en", isTranslation: false },
        { trackId: 54250, trackNumber: 3, title: "KPSR — Gyu Lama — Part 1", speaker: "KPS", originalLanguage: "pt", isTranslation: true, originalTrackRef: 54240 },
        { trackId: 54251, trackNumber: 4, title: "KPSR — Gyu Lama — Part 2", speaker: "KPS", originalLanguage: "pt", isTranslation: true, originalTrackRef: 54241 },
      ],
    },
    {
      sessionDate: "2025-08-21", sessionNumber: 6, timePeriod: "afternoon",
      titleEn: "Day 3 — Review", titlePt: "Dia 3 — Revisão",
      tracks: [
        { trackId: 54234, trackNumber: 1, title: "John Canti — Gyu Lama", speaker: "JC", originalLanguage: "en", isTranslation: false },
      ],
    },
    // Day 4 — 2025-08-22
    {
      sessionDate: "2025-08-22", sessionNumber: 7, timePeriod: "morning",
      titleEn: "Day 4 — Teaching", titlePt: "Dia 4 — Ensinamento",
      tracks: [
        { trackId: 54242, trackNumber: 1, title: "KPSR — Gyu Lama — Part 1", speaker: "KPS", originalLanguage: "en", isTranslation: false },
        { trackId: 54243, trackNumber: 2, title: "KPSR — Gyu Lama — Part 2", speaker: "KPS", originalLanguage: "en", isTranslation: false },
        { trackId: 54252, trackNumber: 3, title: "KPSR — Gyu Lama — Part 1", speaker: "KPS", originalLanguage: "pt", isTranslation: true, originalTrackRef: 54242 },
        { trackId: 54253, trackNumber: 4, title: "KPSR — Gyu Lama — Part 2", speaker: "KPS", originalLanguage: "pt", isTranslation: true, originalTrackRef: 54243 },
      ],
    },
    {
      sessionDate: "2025-08-22", sessionNumber: 8, timePeriod: "afternoon",
      titleEn: "Day 4 — Review", titlePt: "Dia 4 — Revisão",
      tracks: [
        { trackId: 54235, trackNumber: 1, title: "John Canti — Gyu Lama", speaker: "JC", originalLanguage: "en", isTranslation: false },
      ],
    },
    // Day 5 — 2025-08-23 — no TRAD this day
    {
      sessionDate: "2025-08-23", sessionNumber: 9, timePeriod: "morning",
      titleEn: "Day 5 — Teaching", titlePt: "Dia 5 — Ensinamento",
      tracks: [
        { trackId: 54244, trackNumber: 1, title: "KPSR — Gyu Lama — Part 1", speaker: "KPS", originalLanguage: "en", isTranslation: false },
        { trackId: 54245, trackNumber: 2, title: "KPSR — Gyu Lama — Part 2", speaker: "KPS", originalLanguage: "en", isTranslation: false },
      ],
    },
    {
      sessionDate: "2025-08-23", sessionNumber: 10, timePeriod: "afternoon",
      titleEn: "Day 5 — Review", titlePt: "Dia 5 — Revisão",
      tracks: [
        { trackId: 54236, trackNumber: 1, title: "John Canti — Gyu Lama", speaker: "JC", originalLanguage: "en", isTranslation: false },
      ],
    },
    // Day 6 — 2025-08-24
    {
      sessionDate: "2025-08-24", sessionNumber: 11, timePeriod: "morning",
      titleEn: "Day 6 — Teaching", titlePt: "Dia 6 — Ensinamento",
      tracks: [
        { trackId: 54246, trackNumber: 1, title: "KPSR — Gyu Lama — Part 1", speaker: "KPS", originalLanguage: "en", isTranslation: false },
        { trackId: 54247, trackNumber: 2, title: "KPSR — Gyu Lama — Part 2", speaker: "KPS", originalLanguage: "en", isTranslation: false },
        { trackId: 54254, trackNumber: 3, title: "KPSR — Gyu Lama — Part 1", speaker: "KPS", originalLanguage: "pt", isTranslation: true, originalTrackRef: 54246 },
        { trackId: 54255, trackNumber: 4, title: "KPSR — Gyu Lama — Part 2", speaker: "KPS", originalLanguage: "pt", isTranslation: true, originalTrackRef: 54247 },
      ],
    },
    {
      sessionDate: "2025-08-24", sessionNumber: 12, timePeriod: "afternoon",
      titleEn: "Day 6 — Review", titlePt: "Dia 6 — Revisão",
      tracks: [
        { trackId: 54237, trackNumber: 1, title: "John Canti — Gyu Lama", speaker: "JC", originalLanguage: "en", isTranslation: false },
      ],
    },
  ],
};

const PLANS = [PLAN_632, PLAN_663, PLAN_664];

// ─── Logic ───────────────────────────────────────────────────────────────

async function applyPlan(plan: EventPlan, apply: boolean): Promise<void> {
  console.log(`\n=== Event ${plan.eventId} — ${plan.description} ===`);

  // Sanity check: event exists.
  const ev = await db.query.events.findFirst({ where: eq(events.id, plan.eventId) });
  if (!ev) throw new Error(`Event ${plan.eventId} not found`);
  console.log(`  Event: ${ev.eventCode} "${ev.titleEn}"`);

  // Find all current sessions for this event. We expect exactly one with all
  // the tracks; abort if the event already has multiple sessions (already
  // restructured).
  const currentSessions = await db.query.sessions.findMany({
    where: eq(sessions.eventId, plan.eventId),
    with: { tracks: true },
  });
  if (currentSessions.length === 0) {
    throw new Error(`Event ${plan.eventId} has no sessions`);
  }
  if (currentSessions.length > 1) {
    console.log(`  ABORT: event ${plan.eventId} already has ${currentSessions.length} sessions — already restructured?`);
    return;
  }
  const oldSession = currentSessions[0]!;
  const oldSessionId = oldSession.id;
  const expectedTrackIds = new Set(plan.sessions.flatMap((s) => s.tracks.map((t) => t.trackId)));
  const actualTrackIds = new Set(oldSession.tracks.map((t) => t.id));
  const missing = [...expectedTrackIds].filter((id) => !actualTrackIds.has(id));
  const extra = [...actualTrackIds].filter((id) => !expectedTrackIds.has(id));
  if (missing.length || extra.length) {
    console.log(`  ABORT: track set mismatch.`);
    console.log(`    Expected but not in DB: ${missing.join(",") || "(none)"}`);
    console.log(`    In DB but not in plan:  ${extra.join(",") || "(none)"}`);
    return;
  }
  console.log(`  Old session id: ${oldSessionId} (${oldSession.tracks.length} tracks)`);
  console.log(`  Plan: ${plan.sessions.length} new sessions, ${[...expectedTrackIds].length} tracks total`);

  if (!apply) {
    for (const ses of plan.sessions) {
      console.log(`    [dry-run] #${ses.sessionNumber} ${ses.timePeriod.padEnd(9)} ${ses.sessionDate} "${ses.titleEn}" (${ses.tracks.length} tracks)`);
      for (const tr of ses.tracks) {
        const langTag = tr.originalLanguage !== "en" ? ` (${tr.originalLanguage})` : "";
        const transTag = tr.isTranslation ? " [translation]" : "";
        console.log(`      track ${tr.trackId} #${tr.trackNumber} "${tr.title}"${langTag}${transTag}`);
      }
    }
    return;
  }

  // Live mutation. Wrap in a transaction.
  await db.transaction(async (tx) => {
    // 1. Move the old session to a non-conflicting session_number to free up
    //    1..N for the new sessions.
    await tx
      .update(sessions)
      .set({ sessionNumber: 9999, updatedAt: new Date() })
      .where(eq(sessions.id, oldSessionId));

    // 2. Insert all new sessions and capture their ids.
    const newSessionIds: number[] = [];
    for (const ses of plan.sessions) {
      const [inserted] = await tx
        .insert(sessions)
        .values({
          eventId: plan.eventId,
          sessionNumber: ses.sessionNumber,
          sessionDate: ses.sessionDate,
          titleEn: ses.titleEn,
          titlePt: ses.titlePt,
          timePeriod: ses.timePeriod,
        })
        .returning({ id: sessions.id });
      if (!inserted) throw new Error(`Failed to insert session ${ses.sessionNumber}`);
      newSessionIds.push(inserted.id);
    }

    // 3. Update tracks with their new session, track_number, title, speaker,
    //    language flags. We do this BEFORE setting originalTrackId so the
    //    referenced rows already point at their final session.
    for (let i = 0; i < plan.sessions.length; i++) {
      const ses = plan.sessions[i]!;
      const newSid = newSessionIds[i]!;
      for (const tr of ses.tracks) {
        await tx
          .update(tracks)
          .set({
            sessionId: newSid,
            trackNumber: tr.trackNumber,
            title: tr.title,
            speaker: tr.speaker,
            originalLanguage: tr.originalLanguage,
            isTranslation: tr.isTranslation,
            languages: [tr.originalLanguage],
            updatedAt: new Date(),
          })
          .where(eq(tracks.id, tr.trackId));
      }
    }

    // 4. Set originalTrackId on translation tracks now that all rows are at
    //    their final session. The reference is the same track id, so no
    //    indirection needed.
    for (const ses of plan.sessions) {
      for (const tr of ses.tracks) {
        if (tr.originalTrackRef !== undefined) {
          await tx
            .update(tracks)
            .set({ originalTrackId: tr.originalTrackRef, updatedAt: new Date() })
            .where(eq(tracks.id, tr.trackId));
        }
      }
    }

    // 5. Delete the now-empty old session.
    await tx.delete(sessions).where(eq(sessions.id, oldSessionId));
  });

  console.log(`  Applied: ${plan.sessions.length} new sessions created, old session ${oldSessionId} deleted.`);
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  if (!apply) {
    console.log("DRY RUN — pass --apply to actually do the work.");
  }
  for (const plan of PLANS) {
    await applyPlan(plan, apply);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
