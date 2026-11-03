import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { sessions } from "../db/schema/sessions.ts";

/** Order of the day's periods. An unknown period sorts with the afternoon. */
const PERIOD_RANK: Record<string, number> = { morning: 0, afternoon: 1, evening: 2 };

export interface SessionOrderInput {
  id: number;
  sessionNumber: number;
  sessionDate: string | null;
  timePeriod: string | null;
}

/**
 * Session numbers in chronological order: by date, then morning / afternoon /
 * evening, then the current number as a tie-break. Undated sessions follow the
 * dated ones in their current order. Returns only the sessions whose number
 * changes (id → new number).
 */
export function chronologicalRenumbering(list: SessionOrderInput[]): Map<number, number> {
  const sorted = [...list].sort((a, b) => {
    if (a.sessionDate && b.sessionDate && a.sessionDate !== b.sessionDate) {
      return a.sessionDate < b.sessionDate ? -1 : 1;
    }
    if (!a.sessionDate !== !b.sessionDate) return a.sessionDate ? -1 : 1;
    if (a.sessionDate && b.sessionDate) {
      const pa = PERIOD_RANK[a.timePeriod ?? "morning"] ?? 1;
      const pb = PERIOD_RANK[b.timePeriod ?? "morning"] ?? 1;
      if (pa !== pb) return pa - pb;
    }
    return a.sessionNumber - b.sessionNumber;
  });
  const changes = new Map<number, number>();
  sorted.forEach((s, i) => {
    if (s.sessionNumber !== i + 1) changes.set(s.id, i + 1);
  });
  return changes;
}

/**
 * Renumber an event's sessions chronologically. Admins add sessions after the
 * fact (e.g. "Move to session… → New session"), which used to append them at
 * the end whatever their date. (event, session_number) is unique, so numbers
 * go through negative placeholders inside one transaction.
 */
export async function renumberEventSessions(eventId: number): Promise<boolean> {
  const rows = await db
    .select({
      id: sessions.id,
      sessionNumber: sessions.sessionNumber,
      sessionDate: sessions.sessionDate,
      timePeriod: sessions.timePeriod,
    })
    .from(sessions)
    .where(eq(sessions.eventId, eventId));
  const changes = chronologicalRenumbering(rows);
  if (changes.size === 0) return false;

  await db.transaction(async (tx) => {
    for (const id of changes.keys()) {
      await tx.update(sessions).set({ sessionNumber: -id }).where(eq(sessions.id, id));
    }
    for (const [id, sessionNumber] of changes) {
      await tx.update(sessions).set({ sessionNumber, updatedAt: new Date() }).where(eq(sessions.id, id));
    }
  });
  return true;
}
