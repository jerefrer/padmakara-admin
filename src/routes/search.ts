import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { events } from "../db/schema/retreats.ts";
import { users } from "../db/schema/users.ts";
import { optionalAuthMiddleware, getOptionalUser } from "../middleware/auth.ts";
import { AppError } from "../lib/errors.ts";
import { filterAccessibleEvents, AUDIENCE_SLUGS } from "../services/access.ts";

const searchRoutes = new Hono();

// ─── Text normalization ──────────────────────────────────────────────────

/** Lowercase and strip diacritics for accent-insensitive matching. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Split query into individual words (normalized, 2+ chars each). */
function splitQueryWords(normalizedQuery: string): string[] {
  return normalizedQuery
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

/**
 * Count how many query words appear in a text field.
 * Returns { matched: number, total: number } so callers can compute partial scores.
 */
function countWordMatches(
  haystack: string | null | undefined,
  queryWords: string[],
): number {
  if (!haystack || queryWords.length === 0) return 0;
  const normalizedHaystack = normalize(haystack);
  return queryWords.filter((w) => normalizedHaystack.includes(w)).length;
}

/**
 * Extract a short snippet (~150 chars) from text centered on the best cluster of query words.
 * For multi-word queries, tries to find a window that contains the most matched words.
 * Returns null if no match.
 */
function extractSnippet(
  text: string | null | undefined,
  queryWords: string[],
): string | null {
  if (!text || queryWords.length === 0) return null;

  // For short text, return it entirely
  if (text.length <= 160) return text;

  const normalizedText = normalize(text);
  const SNIPPET_HALF = 80;

  // Find all match positions for each query word
  const matchPositions: number[] = [];
  for (const word of queryWords) {
    const pos = normalizedText.indexOf(word);
    if (pos !== -1) matchPositions.push(pos);
  }
  if (matchPositions.length === 0) return null;

  // For single match, just center on it
  // For multiple matches, center between the first and last match
  matchPositions.sort((a, b) => a - b);
  const center = Math.floor(
    (matchPositions[0] + matchPositions[matchPositions.length - 1]) / 2,
  );

  const start = Math.max(0, center - SNIPPET_HALF);
  const end = Math.min(text.length, center + SNIPPET_HALF);
  let snippet = text.slice(start, end).trim();

  // Clean up: don't start/end mid-word
  if (start > 0) {
    const spaceIdx = snippet.indexOf(" ");
    if (spaceIdx > 0 && spaceIdx < 20) snippet = snippet.slice(spaceIdx + 1);
    snippet = "..." + snippet;
  }
  if (end < text.length) {
    const spaceIdx = snippet.lastIndexOf(" ");
    if (spaceIdx > snippet.length - 20) snippet = snippet.slice(0, spaceIdx);
    snippet = snippet + "...";
  }

  return snippet;
}

// ─── Scoring weights ─────────────────────────────────────────────────────

const WEIGHT_SESSION_THEMES = 10;
const WEIGHT_MAIN_THEMES = 6;
const WEIGHT_TITLE = 3;
const WEIGHT_TEACHER = 2;
const WEIGHT_TRACK = 1;

// ─── Relations for search query ──────────────────────────────────────────

const searchEventWith = {
  audience: true,
  eventTeachers: { with: { teacher: true } },
  eventRetreatGroups: { with: { retreatGroup: true } },
  sessions: {
    orderBy: (s: any, { asc }: any) => [asc(s.sessionNumber)],
    with: {
      tracks: {
        orderBy: (t: any, { asc }: any) => [asc(t.trackNumber)],
      },
    },
  },
} as const;

// ─── Search endpoint ─────────────────────────────────────────────────────

searchRoutes.use("/*", optionalAuthMiddleware);

/**
 * GET /api/search?q=bodhicitta&lang=pt
 *
 * Full-text search across events, sessions, tracks, and teachers.
 * Works for both authenticated and unauthenticated users.
 * Unauthenticated users only see public events (audience = "free-anyone").
 */
searchRoutes.get("/", async (c) => {
  const q = c.req.query("q")?.trim();
  const lang = c.req.query("lang") === "pt" ? "pt" : "en";

  // Validate query
  if (!q || q.length < 2) {
    throw AppError.badRequest(
      "Search query must be at least 2 characters",
      "QUERY_TOO_SHORT",
    );
  }

  const normalizedQuery = normalize(q);
  const queryWords = splitQueryWords(normalizedQuery);

  // Fallback: if splitting produces nothing useful, use original query as single term
  if (queryWords.length === 0) {
    queryWords.push(normalizedQuery);
  }

  const totalWords = queryWords.length;

  // Fetch all published events with relations
  const allEvents = await db.query.events.findMany({
    where: eq(events.status, "published"),
    with: searchEventWith,
  });

  // Apply access control
  const authUser = getOptionalUser(c);
  let accessibleEvents: typeof allEvents;

  if (authUser && (authUser.role === "admin" || authUser.role === "superadmin")) {
    accessibleEvents = allEvents;
  } else if (authUser) {
    const fullUser = await db.query.users.findFirst({
      where: eq(users.id, authUser.id),
    });
    if (fullUser) {
      accessibleEvents = await filterAccessibleEvents(
        {
          id: fullUser.id,
          role: fullUser.role,
          subscriptionStatus: fullUser.subscriptionStatus,
          subscriptionExpiresAt: fullUser.subscriptionExpiresAt,
        },
        allEvents,
      );
    } else {
      // User record not found — treat as unauthenticated
      accessibleEvents = allEvents.filter(
        (e) => e.audience?.slug === AUDIENCE_SLUGS.PUBLIC,
      );
    }
  } else {
    // Unauthenticated — public events only
    accessibleEvents = allEvents.filter(
      (e) => e.audience?.slug === AUDIENCE_SLUGS.PUBLIC,
    );
  }

  // Score and build results
  interface Snippet {
    field: string;
    text: string;
  }

  const results: Array<{
    event: {
      id: number;
      titleEn: string;
      titlePt: string | null;
      startDate: string | null;
      endDate: string | null;
      teachers: string[];
    };
    sessions: Array<{
      id: number;
      titleEn: string | null;
      titlePt: string | null;
      sessionDate: string | null;
      timePeriod: string | null;
      sessionNumber: number;
      score: number;
      matchedFields: string[];
      matchedTracks: Array<{ id: number; title: string }>;
    }>;
    snippets: Snippet[];
    totalScore: number;
  }> = [];

  for (const event of accessibleEvents) {
    // Compute event-level scores using word-based matching
    let eventFieldScore = 0;
    const eventMatchedFields: string[] = [];
    const snippets: Snippet[] = [];
    // Track which query words have been found across ALL fields (AND logic)
    const foundWords = new Set<string>();

    // Helper: score a pair of EN/PT fields, return partial score and extract snippet
    const scoreField = (
      fieldName: string,
      weight: number,
      textEn: string | null | undefined,
      textPt: string | null | undefined,
    ) => {
      const matchesEn = countWordMatches(textEn, queryWords);
      const matchesPt = countWordMatches(textPt, queryWords);
      const bestCount = Math.max(matchesEn, matchesPt);
      if (bestCount === 0) return;

      // Track which words matched (use whichever language matched most for scoring)
      const scoreHaystack = matchesEn >= matchesPt ? textEn : textPt;
      if (scoreHaystack) {
        const normalizedHaystack = normalize(scoreHaystack);
        for (const w of queryWords) {
          if (normalizedHaystack.includes(w)) foundWords.add(w);
        }
      }

      // Partial score: weight * (words matched / total words)
      const fieldScore = weight * (bestCount / totalWords);
      eventFieldScore += fieldScore;
      eventMatchedFields.push(fieldName);

      // Skip title snippets — title is already displayed as the card header
      if (fieldName !== "title") {
        // Only show snippet in the user's preferred language — never mix languages.
        // Also skip if En === Pt (untranslated — would show wrong language).
        const preferredText = lang === "pt" ? textPt : textEn;
        const preferredMatches = lang === "pt" ? matchesPt : matchesEn;
        const isUntranslated = textEn != null && textPt != null && textEn === textPt;

        if (preferredMatches > 0 && !isUntranslated) {
          const snippet = extractSnippet(preferredText, queryWords);
          if (snippet) {
            snippets.push({ field: fieldName, text: snippet });
          }
        }
      }
    };

    // Session themes (weight 10)
    scoreField("sessionThemes", WEIGHT_SESSION_THEMES, event.sessionThemesEn, event.sessionThemesPt);

    // Main themes (weight 6)
    scoreField("mainThemes", WEIGHT_MAIN_THEMES, event.mainThemesEn, event.mainThemesPt);

    // Title (weight 3)
    scoreField("title", WEIGHT_TITLE, event.titleEn, event.titlePt);

    // Teacher names (weight 2)
    const teacherNames = (event.eventTeachers ?? []).map(
      (et: any) => et.teacher?.name ?? "",
    );
    const teacherText = teacherNames.join(" ");
    const teacherMatches = countWordMatches(teacherText, queryWords);
    if (teacherMatches > 0) {
      // Track matched words from teacher field
      const normalizedTeacherText = normalize(teacherText);
      for (const w of queryWords) {
        if (normalizedTeacherText.includes(w)) foundWords.add(w);
      }
      eventFieldScore += WEIGHT_TEACHER * (teacherMatches / totalWords);
      eventMatchedFields.push("teacher");
      const matchedTeacher = teacherNames.find(
        (name: string) => countWordMatches(name, queryWords) > 0,
      );
      if (matchedTeacher) {
        snippets.push({ field: "teacher", text: matchedTeacher });
      }
    }

    // Build session results with per-session track scoring
    const sessionResults: typeof results[number]["sessions"] = [];
    let totalAllTrackMatches = 0;

    for (const session of event.sessions ?? []) {
      const matchedTracks: Array<{ id: number; title: string }> = [];
      let allTrackMatchCount = 0;

      for (const track of session.tracks ?? []) {
        const trackMatches = countWordMatches(track.title, queryWords);
        if (trackMatches > 0) {
          allTrackMatchCount++;
          // Track matched words from ALL tracks (for AND logic)
          const normalizedTrackTitle = normalize(track.title);
          for (const w of queryWords) {
            if (normalizedTrackTitle.includes(w)) foundWords.add(w);
          }
          // Only show tracks in the user's preferred language
          const trackLang = (track as any).originalLanguage || "en";
          if (trackLang === lang || !(track as any).isTranslation) {
            matchedTracks.push({ id: track.id, title: track.title });
          }
        }
      }

      totalAllTrackMatches += allTrackMatchCount;
      const trackScore = allTrackMatchCount * WEIGHT_TRACK;
      const sessionScore = eventFieldScore + trackScore;

      const sessionMatchedFields = [...eventMatchedFields];
      if (allTrackMatchCount > 0) {
        sessionMatchedFields.push("trackTitle");
      }

      sessionResults.push({
        id: session.id,
        titleEn: session.titleEn,
        titlePt: session.titlePt,
        sessionDate: session.sessionDate,
        timePeriod: session.timePeriod,
        sessionNumber: session.sessionNumber,
        score: sessionScore,
        matchedFields: sessionMatchedFields,
        matchedTracks,
      });
    }

    // AND logic: ALL query words must appear somewhere across the event's fields
    if (foundWords.size < queryWords.length) continue;

    // Total score: event fields + all track matches (both languages count for scoring)
    const totalScore = eventFieldScore + totalAllTrackMatches * WEIGHT_TRACK;

    // Only include events with a positive score
    if (totalScore > 0) {
      results.push({
        event: {
          id: event.id,
          titleEn: event.titleEn,
          titlePt: event.titlePt,
          startDate: event.startDate,
          endDate: event.endDate,
          teachers: teacherNames.filter(Boolean),
        },
        sessions: sessionResults,
        snippets,
        totalScore,
      });
    }
  }

  // Sort by total score descending
  results.sort((a, b) => b.totalScore - a.totalScore);

  return c.json({
    results,
    totalResults: results.length,
    query: q,
  });
});

export { searchRoutes };
