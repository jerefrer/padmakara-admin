import { z } from "zod";

const emailSchema = z.string().email().max(254);

/**
 * Clean a pasted list of emails: trim, lowercase, drop blanks and repeats.
 * Entries that are not valid addresses come back in `invalid` (trimmed, once each).
 */
export function parseEmailList(raw: string[]): { valid: string[]; invalid: string[] } {
  const invalid: string[] = [];
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const entry of raw) {
    const email = entry.trim().toLowerCase();
    if (!email) continue;
    if (!emailSchema.safeParse(email).success) {
      if (!invalid.includes(entry.trim())) invalid.push(entry.trim());
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    valid.push(email);
  }
  return { valid, invalid };
}
