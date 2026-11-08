/**
 * Collapsed-row title display shared by the track table and the event video
 * list: the English title on the first line, the Portuguese one underneath as
 * a smaller grey line. A title that an AI wrote and nobody has confirmed gets
 * the AI-review chip next to its line; clicking the chip marks it reviewed
 * without opening the row's editor.
 */

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { TypographyProps } from "@mui/material/Typography";
import { useTranslate } from "react-admin";
import { AiReviewChip } from "./TranslatableField";

export type TitleLang = "en" | "pt";

/** Extra info passed with an approval of a collapsed (single-line) title. */
export interface MarkReviewedOptions {
  /**
   * The English field only holds the unaccented twin of the Portuguese title
   * (the filename-derived value the AI then corrected). Approving must also
   * empty it, so the base title the app serves becomes the Portuguese one.
   */
  clearEn?: boolean;
}

/** Lower-case and strip diacritics, to compare titles that differ only by accents. */
export const foldTitle = (s: string): string =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

/**
 * Whether a track's English field holds nothing of its own: the track is in
 * Portuguese only and the field is empty, the sole title, or the same text as
 * the Portuguese one (filenames fill both). A real translation does not qualify,
 * except on a translation track: its English title belongs to the original track.
 */
export const englishTitleIsCopy = (
  languages: readonly string[],
  titleEn: string | null | undefined,
  titlePt: string | null | undefined,
  isTranslation = false,
): boolean => {
  if (!languages.includes("pt") || languages.includes("en")) return false;
  if (isTranslation) return true;
  const en = titleEn?.trim() || "";
  const pt = titlePt?.trim() || "";
  return !en || !pt || foldTitle(en) === foldTitle(pt);
};

interface TitlePairProps {
  titleEn: string | null | undefined;
  titlePt: string | null | undefined;
  /** A Portuguese-only track: its one title is not missing a Portuguese version. */
  portugueseOnly?: boolean;
  /** A Portuguese translation track: only its Portuguese title is shown. */
  portugueseTranslation?: boolean;
  /** Shown as the first line when both titles are empty. */
  fallback: string;
  /** Missing flags count as reviewed (rows that predate the flags). */
  titleEnReviewed?: boolean;
  titlePtReviewed?: boolean;
  onMarkReviewed: (lang: TitleLang, options?: MarkReviewedOptions) => void;
  /** Props for the first-line Typography (weight, click-to-edit handlers). */
  primaryProps?: TypographyProps;
  /** Props for the Portuguese second line (click-to-edit straight into that title). */
  secondaryProps?: TypographyProps;
}

export const TitlePair = ({
  titleEn,
  titlePt,
  portugueseOnly = false,
  portugueseTranslation = false,
  fallback,
  titleEnReviewed = true,
  titlePtReviewed = true,
  onMarkReviewed,
  primaryProps,
  secondaryProps,
}: TitlePairProps) => {
  const translate = useTranslate();
  const en = titleEn?.trim() || "";
  const pt = titlePt?.trim() || "";
  // With no English title (or the same text in both) the Portuguese one is
  // already the first line, so it is not repeated underneath.
  // A Portuguese title that differs from the English field only by accents is
  // the same title twice (the filename's unaccented text plus the AI's
  // corrected version): show the Portuguese one, which is the AI's.
  const accentTwin = !!en && !!pt && en !== pt && (portugueseTranslation || foldTitle(en) === foldTitle(pt));
  const ptIsPrimary = !!pt && (!en || en === pt || accentTwin);
  const primaryText = accentTwin ? pt : en || pt || fallback;
  const primaryChipLang: TitleLang | null = accentTwin
    ? !titlePtReviewed
      ? "pt"
      : null
    : en && !titleEnReviewed
      ? "en"
      : ptIsPrimary && !titlePtReviewed
        ? "pt"
        : null;

  const markReviewed = (lang: TitleLang) => (e: React.MouseEvent) => {
    // The chip sits inside a click-to-edit row.
    e.stopPropagation();
    if (accentTwin && lang === "pt") onMarkReviewed(lang, { clearEn: true });
    else onMarkReviewed(lang);
  };

  return (
    <>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
        <Typography variant="body2" noWrap {...primaryProps} sx={{ minWidth: 0, ...primaryProps?.sx }}>
          {primaryText}
        </Typography>
        {primaryChipLang && (
          <Box sx={{ display: "flex", flexShrink: 0 }} onClick={markReviewed(primaryChipLang)}>
            <AiReviewChip onClick={() => undefined} />
          </Box>
        )}
      </Box>
      {!ptIsPrimary && !(portugueseOnly && !pt) && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
          <Typography
            variant="caption"
            noWrap
            data-testid="pt-title-line"
            {...secondaryProps}
            sx={{
              ...secondaryProps?.sx,
              minWidth: 0,
              color: pt ? "text.secondary" : "text.disabled",
              fontStyle: pt ? "normal" : "italic",
              fontSize: "0.72rem",
              lineHeight: 1.3,
            }}
          >
            {pt || translate("padmakara.events.noPtTitle")}
          </Typography>
          {pt && !titlePtReviewed && (
            <Box sx={{ display: "flex", flexShrink: 0 }} onClick={markReviewed("pt")}>
              <AiReviewChip onClick={() => undefined} />
            </Box>
          )}
        </Box>
      )}
    </>
  );
};
