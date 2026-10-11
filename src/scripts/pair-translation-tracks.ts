/**
 * Give each translation track its original's track number, and record the
 * `original_track_id` link.
 *
 * The app welds a pair into one row by comparing track numbers, but the
 * archive numbers files sequentially (`286 [TIB]`, `287 [ENG]`), so every
 * pair currently renders as two unrelated rows. The rule lives in
 * `services/track-pairing.ts` and is tested there; this script only reads the
 * database, reports what the rule decided, and writes when told to.
 *
 *   bun src/scripts/pair-translation-tracks.ts                 # dry run
 *   bun src/scripts/pair-translation-tracks.ts --event=920     # one event
 *   bun src/scripts/pair-translation-tracks.ts --execute       # apply
 */
import { db } from "../db/index.ts";
import { tracks as tracksTable } from "../db/schema/tracks.ts";
import { eq } from "drizzle-orm";
import {
  planSessionPairing,
  findPlanCollisions,
  type PairableTrack,
  type UnpairedReason,
} from "../services/track-pairing.ts";

const EXECUTE = process.argv.includes("--execute");
const eventArg = process.argv.find((a) => a.startsWith("--event="));
const ONLY_EVENT = eventArg ? Number(eventArg.split("=")[1]) : null;

/**
 * Moved rows are parked above every real track number first, so no
 * intermediate state can collide with the (session, number, language) unique
 * constraint while the updates are applied one by one.
 */
const TEMP_OFFSET = 100_000;

if (!EXECUTE) console.log("=== DRY RUN (pass --execute to apply) ===\n");
if (ONLY_EVENT !== null) console.log(`Restricted to event ${ONLY_EVENT}.\n`);

const allSessions = await db.query.sessions.findMany({
  with: { tracks: true },
});

interface PlannedSession {
  sessionId: number;
  eventId: number;
  pairs: ReturnType<typeof planSessionPairing>["pairs"];
  moved: ReturnType<typeof planSessionPairing>["pairs"];
}

const planned: PlannedSession[] = [];
const declines = new Map<UnpairedReason, number>();
const declineExamples = new Map<UnpairedReason, string>();
const collisions: string[] = [];

for (const session of allSessions) {
  if (ONLY_EVENT !== null && session.eventId !== ONLY_EVENT) continue;
  if (session.tracks.length === 0) continue;

  const pairable: PairableTrack[] = session.tracks.map((t) => ({
    id: t.id,
    trackNumber: t.trackNumber,
    title: t.title,
    isTranslation: t.isTranslation,
    originalLanguage: t.originalLanguage,
  }));

  const plan = planSessionPairing(pairable);

  for (const d of plan.unpaired) {
    declines.set(d.reason, (declines.get(d.reason) ?? 0) + 1);
    if (!declineExamples.has(d.reason)) {
      declineExamples.set(d.reason, `session ${session.id}, #${d.trackNumber} "${d.title}"`);
    }
  }

  for (const c of findPlanCollisions(pairable, plan)) {
    collisions.push(`session ${session.id}: ${c}`);
  }

  const moved = plan.pairs.filter((p) => p.fromTrackNumber !== p.toTrackNumber);
  if (plan.pairs.length > 0) {
    planned.push({ sessionId: session.id, eventId: session.eventId, pairs: plan.pairs, moved });
  }
}

for (const s of planned) {
  const sample = s.moved
    .slice(0, 4)
    .map((p) => `${p.fromTrackNumber}→${p.toTrackNumber}`)
    .join(", ");
  console.log(
    `Event ${s.eventId} / session ${s.sessionId}: ${s.pairs.length} pairs, ` +
      `${s.moved.length} renumbered${sample ? ` (${sample}${s.moved.length > 4 ? ", …" : ""})` : ""}`,
  );
}

const totalPairs = planned.reduce((n, s) => n + s.pairs.length, 0);
const totalMoved = planned.reduce((n, s) => n + s.moved.length, 0);

console.log(`\nSummary:`);
console.log(`  Sessions with pairs: ${planned.length}`);
console.log(`  Pairs linked:        ${totalPairs}`);
console.log(`  Tracks renumbered:   ${totalMoved}`);

if (declines.size > 0) {
  console.log(`\n  Translations left alone:`);
  for (const [reason, count] of [...declines].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${count.toString().padStart(4)}  ${reason}  —  e.g. ${declineExamples.get(reason)}`);
  }
}

if (collisions.length > 0) {
  console.error(`\nABORTING — the plan would break the unique constraint:`);
  for (const c of collisions.slice(0, 10)) console.error(`  ${c}`);
  process.exit(1);
}

if (!EXECUTE) {
  console.log("\n=== DRY RUN — no changes made ===");
  process.exit(0);
}

await db.transaction(async (tx) => {
  for (const s of planned) {
    for (const p of s.moved) {
      await tx
        .update(tracksTable)
        .set({ trackNumber: p.fromTrackNumber + TEMP_OFFSET })
        .where(eq(tracksTable.id, p.translationId));
    }
    for (const p of s.pairs) {
      await tx
        .update(tracksTable)
        .set({ trackNumber: p.toTrackNumber, originalTrackId: p.originalId })
        .where(eq(tracksTable.id, p.translationId));
    }
  }
});

console.log(`\nApplied: ${totalPairs} pairs linked, ${totalMoved} tracks renumbered.`);
process.exit(0);
