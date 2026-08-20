/**
 * Integrity check: list tracks that have a DB row but no audio object
 * (s3_key IS NULL). Such tracks render in the app/admin but 404 on
 * playback (see the event-921 incident: 15 of 42 tracks were created by
 * the two-phase bulk upload but their audio never landed).
 *
 *   bun run src/scripts/find-keyless-tracks.ts
 *
 * Exits 0 when clean, 1 when any keyless track exists — so it can gate a
 * cron job or CI check.
 */
import { eq, isNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { sessions } from "../db/schema/sessions.ts";
import { events } from "../db/schema/retreats.ts";

const rows = await db
  .select({
    eventId: events.id,
    eventCode: events.eventCode,
    trackId: tracks.id,
    trackNumber: tracks.trackNumber,
    title: tracks.title,
  })
  .from(tracks)
  .innerJoin(sessions, eq(tracks.sessionId, sessions.id))
  .innerJoin(events, eq(sessions.eventId, events.id))
  .where(isNull(tracks.s3Key))
  .orderBy(events.id, tracks.trackNumber);

if (rows.length === 0) {
  console.log("✓ No keyless tracks — every track has an s3_key.");
  process.exit(0);
}

const byEvent = new Map<number, typeof rows>();
for (const r of rows) {
  const list = byEvent.get(r.eventId) ?? [];
  list.push(r);
  byEvent.set(r.eventId, list);
}

console.log(`✗ Found ${rows.length} keyless track(s) across ${byEvent.size} event(s):\n`);
for (const [, list] of byEvent) {
  console.log(`Event ${list[0]!.eventId} (${list[0]!.eventCode}) — ${list.length} keyless:`);
  for (const r of list) {
    console.log(`  track #${r.trackNumber} (id ${r.trackId}) "${r.title}"`);
  }
  console.log("");
}
process.exit(1);
