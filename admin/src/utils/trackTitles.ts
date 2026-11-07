interface TitledTrack {
  isTranslation?: boolean | null;
  languages?: readonly string[] | null;
}

/**
 * A Portuguese translation track carries only a Portuguese title: its English
 * title belongs to the original track (André, 2026-11-06). The row shows a
 * single title for it, so the translate bar must not count or fill one either.
 */
export function needsTitle(track: TitledTrack, field: "titleEn" | "titlePt"): boolean {
  if (field === "titlePt") return true;
  const languages = track.languages ?? [];
  return !(track.isTranslation && languages.includes("pt") && !languages.includes("en"));
}
