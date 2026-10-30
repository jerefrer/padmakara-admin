/**
 * Extract the EN<->PT headword pairs from Padmakara's converted multilingual
 * glossary (tibetan-translator/build/dictionaries/69-PadmakaraGlossary) into
 * src/data/padmakara-glossary-en-pt.json, which the translation prompts read.
 *
 * Usage: bun src/scripts/import-padmakara-glossary.ts [path-to-glossary]
 *
 * Source format, one entry per line:
 *   wylie|LANG text\nLANG text...
 * where `\n` is a literal backslash-n and each language text is
 * `headword(s)` optionally followed by ` — definition`.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface GlossaryEntry {
  wylie: string;
  en: string[];
  pt: string[];
}

const DEFAULT_SOURCE =
  "/Users/jeremy/Documents/Programming/tibetan-translator/build/dictionaries/69-PadmakaraGlossary";
const OUTPUT = fileURLToPath(new URL("../data/padmakara-glossary-en-pt.json", import.meta.url));

const LANG_SPLIT = /\\n(?=(?:EN|FR|PT|Skt|ZH|ES|IT|DE|PL) )/;
const MIN_VARIANT_LENGTH = 3;

/** Split on commas/semicolons that are not inside parentheses. */
function splitVariants(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if ((ch === "," || ch === ";") && depth === 0) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

/** Headword variants of one language text: drops the definition, refs and `*`. */
export function parseHeadwords(text: string): string[] {
  const head = (text.split(" — ")[0] ?? "")
    .replace(/\s*\[[^\]]*\]/g, "")
    .replace(/\*/g, "")
    .replace(/­/g, ""); // soft hyphens inside transliterated names
  const seen = new Set<string>();
  const variants: string[] = [];
  for (const raw of splitVariants(head)) {
    const v = raw.replace(/\s+/g, " ").trim();
    if (v.length < MIN_VARIANT_LENGTH || seen.has(v)) continue;
    seen.add(v);
    variants.push(v);
  }
  return variants;
}

function stripMarks(s: string): string {
  return s
    .replace(/\([^)]*\)/g, " ")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse one glossary line; null when it has no usable EN<->PT pair. */
export function parseLine(line: string): GlossaryEntry | null {
  const bar = line.indexOf("|");
  if (bar < 0) return null;
  const wylie = line.slice(0, bar).trim();
  let en: string[] = [];
  let pt: string[] = [];
  for (const part of line.slice(bar + 1).split(LANG_SPLIT)) {
    if (part.startsWith("EN ") && en.length === 0) en = parseHeadwords(part.slice(3));
    else if (part.startsWith("PT ") && pt.length === 0) pt = parseHeadwords(part.slice(3));
  }
  if (en.length === 0 || pt.length === 0) return null;
  // Identical on both sides is only worth keeping for proper names (spelling
  // matters there); lowercase terms that do not change add nothing.
  const same = stripMarks(en.join("|")) === stripMarks(pt.join("|"));
  if (same && !en.some((v) => /^\p{Lu}/u.test(v))) return null;
  return { wylie, en, pt };
}

export function parseGlossary(content: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    const entry = parseLine(line);
    if (!entry) continue;
    const key = `${entry.en.join("|")}=>${entry.pt.join("|")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

if (import.meta.main) {
  const source = process.argv[2] ?? DEFAULT_SOURCE;
  const entries = parseGlossary(readFileSync(source, "utf8"));
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(entries, null, 1) + "\n");
  console.log(`Wrote ${entries.length} EN<->PT entries to ${OUTPUT}`);
}
