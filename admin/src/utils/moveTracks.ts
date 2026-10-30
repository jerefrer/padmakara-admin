import type { InferredSession, ParsedTrack } from "./trackParser";

/** Session number for a session added to an event: one past the highest in use
 *  (the same rule the "add tracks to an existing event" flow follows). */
export function nextSessionNumber(sessions: ReadonlyArray<{ sessionNumber: number }>): number {
  return sessions.reduce((max, s) => Math.max(max, s.sessionNumber), 0) + 1;
}

/**
 * Local-state counterpart of moving tracks between sessions: every track whose
 * id is in `trackIds` leaves its session and joins the session with
 * `targetSessionId`. The target keeps its tracks ordered the way the edit page
 * loads them (track number, originals before translations). Moved tracks take
 * on the target's date and period. Sessions are left in place even when they
 * end up empty.
 */
export function moveTracksToSession(
  sessions: InferredSession[],
  trackIds: ReadonlySet<number>,
  targetSessionId: number,
): InferredSession[] {
  const target = sessions.find((s) => s.id === targetSessionId);
  if (!target) return sessions;

  const moved: ParsedTrack[] = [];
  for (const s of sessions) {
    if (s.id === targetSessionId) continue;
    for (const t of s.tracks) {
      if (t.id !== undefined && trackIds.has(t.id)) {
        moved.push({ ...t, date: target.date, timePeriod: target.timePeriod });
      }
    }
  }
  if (moved.length === 0) return sessions;

  return sessions.map((s) => {
    if (s.id === targetSessionId) {
      const tracks = [...s.tracks, ...moved].sort(
        (a, b) =>
          a.trackNumber - b.trackNumber ||
          (a.isTranslation ? 1 : 0) - (b.isTranslation ? 1 : 0),
      );
      return { ...s, tracks };
    }
    return { ...s, tracks: s.tracks.filter((t) => !(t.id !== undefined && trackIds.has(t.id))) };
  });
}
