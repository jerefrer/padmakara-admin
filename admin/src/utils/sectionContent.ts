import type { SectionVisibilityKey } from "./mediaVisibility";

/** How much each "show in app" section holds (tracks, videos, PDFs...); 0 = empty. */
export type SectionContent = Record<SectionVisibilityKey, number>;
export type SectionFlags = Record<SectionVisibilityKey, boolean>;

const KEYS: SectionVisibilityKey[] = [
  "audioPublished", "videoPublished", "transcriptsPublished", "textsPublished", "topicsPublished",
];

/**
 * The boxes the publish dialog starts with: every section that has something
 * to show, plus any already ticked. An empty section stays unticked, so
 * content added later is not shown before someone decides to.
 */
export function sectionsToShowOnPublish(flags: SectionFlags, content: SectionContent): SectionFlags {
  // fromEntries types its keys as string; KEYS lists every SectionVisibilityKey.
  return Object.fromEntries(KEYS.map((k) => [k, flags[k] || content[k] > 0])) as SectionFlags;
}

/** A published section that holds content nobody in the app can see. */
export function isHiddenWithContent(flags: SectionFlags, content: SectionContent, key: SectionVisibilityKey): boolean {
  return !flags[key] && content[key] > 0;
}

/** The Topics & bibliography section's content: its filled fields. */
export function topicLineCount(form: {
  mainThemesEn: string; mainThemesPt: string;
  sessionThemesEn: string; sessionThemesPt: string;
  bibliography: string; bibliographyPt: string;
}): number {
  return [form.mainThemesEn, form.mainThemesPt, form.sessionThemesEn, form.sessionThemesPt, form.bibliography, form.bibliographyPt]
    .filter((v) => (v ?? "").trim() !== "").length;
}
