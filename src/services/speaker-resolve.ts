/**
 * Shared speaker-resolution logic for the AI track-rename endpoints.
 *
 * Both `POST /api/admin/events/:id/rename-tracks` (src/routes/admin/events.ts)
 * and `POST /api/admin/upload/rename-tracks` (src/routes/admin/upload.ts,
 * the endpoint the admin create-form UI actually calls) ask an LLM to
 * suggest track speakers from a natural-language instruction. The LLM's raw
 * guess needs to be resolved against the known teacher roster so downstream
 * consumers get a stable abbreviation, not free text.
 */

export interface RosterTeacher {
  abbreviation: string;
  name: string;
}

/**
 * Resolve a speaker string returned by the AI to an existing teacher's
 * abbreviation. Tries, in order: exact abbreviation match, exact name match,
 * fuzzy name-based contains match. Falls back to the raw string (flagged
 * unmatched) when nothing plausible is found.
 *
 * An empty/whitespace-only string is treated as an intentional "no speaker"
 * value, not a match attempt — matching it against every teacher (via
 * `name.includes("")`) would silently resolve it to the first roster entry.
 *
 * The fuzzy pass never treats the teacher's abbreviation as a substring to
 * search for: real abbreviations are 2 letters (RR, CK, ST, ...), so
 * `query.includes(abbreviation)` over-matches almost any short phrase that
 * happens to contain those two letters together.
 */
export function resolveSpeaker(
  raw: string,
  roster: RosterTeacher[],
): { speaker: string; unmatched?: true } {
  const q = raw.trim().toLowerCase();
  if (!q) return { speaker: raw }; // empty = intentional "no speaker", not a match attempt
  // exact abbreviation
  let m = roster.find((t) => t.abbreviation.toLowerCase() === q);
  if (m) return { speaker: m.abbreviation };
  // exact full name
  m = roster.find((t) => t.name.toLowerCase() === q);
  if (m) return { speaker: m.abbreviation };
  // fuzzy: name-based only (NEVER the short abbreviation as a substring), and only
  // for queries long enough to be meaningful, to avoid short-substring false matches.
  if (q.length >= 3) {
    m = roster.find(
      (t) => t.name.toLowerCase().includes(q) || q.includes(t.name.toLowerCase()),
    );
    if (m) return { speaker: m.abbreviation };
  }
  return { speaker: raw, unmatched: true };
}

/**
 * Render the known-teacher roster block appended to an AI rename-tracks
 * system prompt, so the model maps a spoken/typed name to an existing
 * teacher abbreviation instead of inventing one.
 */
export function rosterPromptBlock(roster: RosterTeacher[]): string {
  const rosterList = roster.map((t) => `${t.abbreviation} — ${t.name}`).join("\n");
  return `\n\nKnown teachers (abbreviation — name):\n${rosterList}\n\nThe "speaker" field must be an existing teacher's abbreviation from this roster. If the instruction names a teacher by code or by full/partial name, map it to the matching abbreviation. Only if there is no plausible match, return the raw string.`;
}
