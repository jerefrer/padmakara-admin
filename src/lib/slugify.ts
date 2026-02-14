/**
 * Transliterate and slugify a string, handling Sanskrit/Tibetan diacritics.
 *
 * Examples:
 *   "Śamatha" → "shamatha"
 *   "Práticas Preliminares - Nível 1" → "praticas-preliminares-nivel-1"
 *   "Buddha Śākyamuni Practice" → "buddha-shakyamuni-practice"
 */

const TRANSLITERATIONS: Record<string, string> = {
  Ś: "Sh",
  ś: "sh",
  Ṣ: "Sh",
  ṣ: "sh",
  Ā: "A",
  ā: "a",
  Ī: "I",
  ī: "i",
  Ū: "U",
  ū: "u",
  Ṛ: "R",
  ṛ: "r",
  Ṇ: "N",
  ṇ: "n",
  Ṭ: "T",
  ṭ: "t",
  Ḍ: "D",
  ḍ: "d",
  Ṃ: "M",
  ṃ: "m",
  Ḥ: "H",
  ḥ: "h",
};

function transliterate(str: string): string {
  let result = "";
  for (const ch of str) {
    result += TRANSLITERATIONS[ch] ?? ch;
  }
  return result;
}

export function slugify(str: string): string {
  return transliterate(str)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
