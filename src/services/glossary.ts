import padmakaraGlossaryData from "../data/padmakara-glossary-en-pt.json";

// Buddhist / Tibetan / Sanskrit terms whose spelling and (non-)translation must
// stay consistent across an event. Keep terms in their canonical English/source
// form; instruct the model NOT to translate or re-spell them.
export const GLOSSARY: string[] = [
  "bodhicitta", "dharmakaya", "sambhogakaya", "nirmanakaya", "tonglen",
  "dzogchen", "mahamudra", "samsara", "nirvana", "sangha", "dharma",
  "rinpoche", "lama", "tulku", "bardo", "mandala", "mantra", "ngöndro",
  "shamatha", "vipashyana", "tathagatagarbha", "rigpa", "prajna", "skandha",
];

export type GlossaryDirection = "en-to-pt" | "pt-to-en";

/** One established translation, ready to print as `source → target`. */
export interface GlossaryMatch {
  source: string;
  target: string;
}

/** Cap on matched entries per request, to keep the prompt small. */
export const MAX_GLOSSARY_MATCHES = 80;

interface RawEntry {
  wylie: string;
  en: string[];
  pt: string[];
}

interface Candidate {
  /** Source variant as displayed (parenthetical notes removed). */
  source: string;
  /** Target variants joined for display. */
  target: string;
  /** Number of words in the matched variant, for longest-first ordering. */
  words: number;
  length: number;
}

/** Lowercase, drop diacritics and keep only letter/digit runs as words. */
function words(text: string): string[] {
  return (
    text
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      // Sanskrit ś/ṣ are commonly typed "sh" (Shantideva for Śāntideva); fold
      // both spellings together on both sides of the comparison.
      .replace(/sh/g, "s")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** Remove parenthetical notes such as "refuge (to take)" -> "refuge". */
function stripNotes(variant: string): string {
  return variant.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

interface Index {
  byPhrase: Map<string, Candidate[]>;
  maxWords: number;
}

/** Abbreviations that comma splitting turned into "variants". */
const NOT_A_TERM = new Set(["etc", "etc.", "e.g.", "i.e.", "lit."]);

/**
 * An enumeration such as "King, subjects and companions" was split at its
 * commas into variants; it is one term and must stay whole.
 */
function isEnumeration(variants: string[]): boolean {
  return variants.length > 1 && /(^|\s)(and|e)\s/.test(variants[variants.length - 1]);
}

/** The variants an entry is matched on: every headword except stray abbreviations. */
function matchableVariants(variants: string[]): string[] {
  const kept = variants.filter((v) => !NOT_A_TERM.has(v.trim().toLowerCase()));
  return isEnumeration(kept) ? [kept.join(", ")] : kept;
}

function buildIndex(direction: GlossaryDirection): Index {
  const byPhrase = new Map<string, Candidate[]>();
  let maxWords = 1;
  for (const entry of padmakaraGlossaryData as RawEntry[]) {
    const sources = direction === "en-to-pt" ? entry.en : entry.pt;
    const rawTargets = direction === "en-to-pt" ? entry.pt : entry.en;
    const targets = isEnumeration(rawTargets) ? [rawTargets.join(", ")] : rawTargets;
    const target = [...new Set(targets.map(stripNotes).filter(Boolean))].join(" / ");
    if (!target) continue;
    for (const variant of matchableVariants(sources)) {
      const display = stripNotes(variant);
      const key = words(display).join(" ");
      if (!key) continue;
      const n = key.split(" ").length;
      maxWords = Math.max(maxWords, n);
      const list = byPhrase.get(key) ?? [];
      // Skip pairs already registered for this phrase (duplicate entries).
      if (!list.some((c) => c.target === target)) {
        list.push({ source: display, target, words: n, length: key.length });
      }
      byPhrase.set(key, list);
    }
  }
  return { byPhrase, maxWords };
}

// Built once at module load.
const INDEXES: Record<GlossaryDirection, Index> = {
  "en-to-pt": buildIndex("en-to-pt"),
  "pt-to-en": buildIndex("pt-to-en"),
};

/**
 * Glossary entries whose source-language headword occurs in `texts`. Matching
 * is whole-word/phrase, case- and diacritic-insensitive; plural or inflected
 * forms ("meritorious" for "merit") do not match. Longest phrases first, capped.
 */
export function matchGlossary(
  texts: string[],
  direction: GlossaryDirection,
  limit: number = MAX_GLOSSARY_MATCHES,
): GlossaryMatch[] {
  const { byPhrase, maxWords } = INDEXES[direction];
  const found = new Map<string, Candidate>();
  for (const text of texts) {
    const tokens = words(text);
    for (let i = 0; i < tokens.length; i++) {
      const top = Math.min(maxWords, tokens.length - i);
      for (let n = 1; n <= top; n++) {
        const candidates = byPhrase.get(tokens.slice(i, i + n).join(" "));
        if (!candidates) continue;
        for (const c of candidates) found.set(`${c.source}\u0000${c.target}`, c);
      }
    }
  }
  return [...found.values()]
    .sort((a, b) => b.words - a.words || b.length - a.length || a.source.localeCompare(b.source))
    .slice(0, limit)
    .map(({ source, target }) => ({ source, target }));
}

/** The "Padmakara glossary" prompt section, or "" when nothing matches. */
export function padmakaraGlossaryBlock(
  texts: string[],
  direction: GlossaryDirection,
): string {
  const matches = matchGlossary(texts, direction);
  if (matches.length === 0) return "";
  return [
    // Common words ("light", "now") are glossary headwords too, often for a
    // narrow Dharma sense, so the model must only apply an entry in that sense.
    "Padmakara glossary — Padmakara's established translations of Buddhist terms. " +
      "Use them where the term is used in its Dharma sense; ordinary uses of common words translate normally:",
    ...matches.map((m) => `${m.source} → ${m.target}`),
  ].join("\n");
}

/**
 * The static "do not translate" block. When `texts` and `direction` are given,
 * the matched Padmakara glossary lines are appended; callers that pass nothing
 * get the unchanged static block (safe to keep in a cached prompt prefix).
 */
export function glossaryBlock(texts?: string[], direction?: GlossaryDirection): string {
  const base = [
    "GLOSSARY — keep these terms exactly as written; do not translate or re-spell them:",
    GLOSSARY.join(", "),
  ].join("\n");
  if (!texts || !direction) return base;
  const dynamic = padmakaraGlossaryBlock(texts, direction);
  return dynamic ? `${base}\n\n${dynamic}` : base;
}
