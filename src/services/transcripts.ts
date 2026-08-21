import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { transcripts } from "../db/schema/transcripts.ts";

/**
 * Whether an event has a transcript in the given language with an actual
 * file uploaded — a placeholder row with a null s3Key does not count.
 *
 * Used to gate subtitle generation: Whisper is guided by the event's
 * transcript, and running it without one produces materially worse output
 * on names and Buddhist terminology.
 */
export async function hasTranscriptForLanguage(
  eventId: number,
  language: string,
): Promise<boolean> {
  const rows = await db.query.transcripts.findMany({
    where: eq(transcripts.eventId, eventId),
  });
  return rows.some((t) => t.language === language && t.s3Key != null);
}
