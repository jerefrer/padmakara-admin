/** One author name as used across publications, with how many carry it. */
export interface AuthorName {
  name: string;
  count: number;
}

/**
 * The distinct author names used across publications, for the admin to pick
 * from instead of retyping (and misspelling) a name. Each array element is one
 * author; names are trimmed, blanks dropped, and a name counted once per
 * publication. Spelling variants are kept apart on purpose: the list is where
 * an admin spots them.
 */
export function distinctAuthorNames(rows: { authors: string[] | null }[]): AuthorName[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const names = new Set((row.authors ?? []).map((a) => a.trim()).filter(Boolean));
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
