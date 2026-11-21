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
 *
 * Counts every row, published or not, whatever its status: an unpublished
 * draft still guides transcription well, and readers never see it here.
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

interface TranscriptFileRow {
  id: number;
  language: string;
  s3Key: string | null;
  isExcerpt: boolean;
}

/**
 * The one transcript file a Batch job aligns against: a row with an uploaded file,
 * in the job's language when there is one (else any language, as the job always took
 * whatever PDF the folder held), the full text before an excerpt, the oldest first so
 * the pick does not change between runs. Returns its exact S3 key, or null.
 */
export function pickTranscriptKey(
  rows: TranscriptFileRow[],
  language: string,
): string | null {
  const withFile = rows.filter((t) => t.s3Key != null);
  const ranked = (list: TranscriptFileRow[]) =>
    [...list].sort((a, b) => Number(a.isExcerpt) - Number(b.isExcerpt) || a.id - b.id);
  const sameLanguage = withFile.filter((t) => t.language === language);
  return ranked(sameLanguage.length > 0 ? sameLanguage : withFile)[0]?.s3Key ?? null;
}
